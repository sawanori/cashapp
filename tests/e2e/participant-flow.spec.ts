import { test, expect } from "@playwright/test";

import { cleanupE2eUsers, seedOrganizerSession, testSql, uniq } from "./helpers/session";

/**
 * 参加者側の主要フロー（P-1 招待リンク着地 → preview → 同意 → claim → 自分の請求）を
 * 実 HTTP で検証する。`organizer-flow.spec.ts` と同じ理由（LIFF mock の `isInClient` を
 * 上書きできない）でブラウザ操作は行わず、Playwright の API テストコンテキストで実ルートを
 * 通す。イベント・参加者・請求は `POST /api/events` 系（`docs/concerns/task_022.md` に
 * 記録した timestamptz 不具合で実 HTTP 経由では作れない）を経由せず、DB へ直接投入する
 * （`tests/integration/setup.ts` の `withRollback` 以外の統合テストが実コミットのフィクスチャ
 * で行っているのと同じ立場）。
 *
 * `GET /api/e/preview` はセッション不要（読み取り専用の公開最小情報）なので、まずここが
 * 実際に動くことを確かめてから、セッションが要る `POST /api/e/claim` 以降へ進む。
 * `claim` は `resolveEventByJoinToken()`（`.getTime()` で壊れることを task_021 が発見済み）
 * を経由するため、ここでも同じ理由で失敗することが見込まれる（赤の根拠として記録する）。
 */

const seededUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupE2eUsers(seededUserIds);
});

test("preview は認証不要で読める。claim 以降は認証済みセッションで進める", async ({ request, baseURL }) => {
  const suffix = uniq();
  const api = baseURL ?? `http://127.0.0.1:${process.env["PLAYWRIGHT_PORT"] ?? "3100"}`;
  const sql = testSql();

  const organizerRows = await sql<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`e2e-pf-org-${suffix}`)}, ${`e2e-test:${suffix}`}, 'development')
    RETURNING id
  `;
  const organizerId = organizerRows[0]!.id;

  // トークンの生成・ハッシュは `src/lib/join-token.ts`（`generateToken` / `hashToken`）と
  // 同じ形（16 バイト・base64url・SHA-256）を独自に複製する（アプリのコードは
  // `import "server-only"` を持つため Playwright のテストランナーからは読み込めない。
  // `tests/e2e/helpers/session.ts` の docstring と同じ理由）。
  const joinTokenBytes = crypto.getRandomValues(new Uint8Array(16));
  let joinTokenBinary = "";
  for (const b of joinTokenBytes) joinTokenBinary += String.fromCharCode(b);
  const joinToken = Buffer.from(joinTokenBinary, "binary")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const joinTokenHash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joinToken)),
  );

  const eventRows = await sql<{ id: string }[]>`
    INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                       join_token_expires_at, minors_included, default_amount_minor, status)
    VALUES (${organizerId}, ${"夏合宿"}, ${"山田太郎"}, ${joinTokenHash},
            now() + interval '90 days', false, 3000, 'collecting')
    RETURNING id
  `;
  const eventId = eventRows[0]!.id;

  const participantRows = await sql<{ id: string }[]>`
    INSERT INTO participant (event_id, display_label, name_visibility)
    VALUES (${eventId}, ${"参加者A"}, 'participants')
    RETURNING id
  `;
  const participantId = participantRows[0]!.id;

  await sql`
    INSERT INTO invoice (event_id, participant_id, amount_minor) VALUES (${eventId}, ${participantId}, 3000)
  `;

  // P-1: preview はセッション不要（氏名・個別金額を含まない公開最小情報）。
  const previewRes = await request.get(`${api}/api/e/preview`, {
    headers: { "x-join-token": joinToken },
  });
  expect(previewRes.status(), await previewRes.text()).toBe(200);
  const preview = (await previewRes.json()) as Record<string, unknown>;
  expect(Object.keys(preview).sort()).toEqual(
    ["allowCash", "amountRangeMinor", "collectByAt", "organizerLabel", "participantCount", "title"].sort(),
  );
  expect(preview["participantCount"]).toBe(1);

  // 参加者セッションを直接発行する（LINE ログインを経由できない事情は
  // organizer-flow.spec.ts / helpers/session.ts の docstring を参照）。
  const session = await seedOrganizerSession(`participant-${suffix}`);
  seededUserIds.push(session.userId, organizerId);

  // 同意を先に記録する（`POST /api/consent` は task_022 の scope 外なので直接 INSERT する。
  // `assertParticipantConsent` が読む行の形は `src/lib/db/repositories/claims.ts` の
  // `recordParticipantConsent` と同一）。
  await sql`
    INSERT INTO consent_log (user_id, consent_kind, text_version)
    VALUES (${session.userId}, 'participant_terms', 'v1')
  `;

  const claimRes = await request.post(`${api}/api/e/claim`, {
    headers: {
      "content-type": "application/json",
      origin: api,
      cookie: session.cookieHeader,
      "x-csrf-token": session.csrfToken,
      "x-join-token": joinToken,
    },
    data: { participantId, confirmed: true },
  });
  // check_003 が要求する契約: 参加者は自分の請求だけを claim でき、他人には見えない。
  // ここでは「実際に claim が成立する」ところまでを実測する（`docs/concerns/task_022.md`
  // に記録した timestamptz 不具合により 500 になることが見込まれる — 期待値は「正しい仕様」の
  // ままにし、テストを弱めない）。
  expect(claimRes.status(), await claimRes.text()).toBe(200);

  const meRes = await request.get(`${api}/api/e/me`, {
    headers: { cookie: session.cookieHeader, "x-join-token": joinToken },
  });
  expect(meRes.status(), await meRes.text()).toBe(200);
  const me = (await meRes.json()) as { state: string; amountMinor: number };
  expect(me.state).toBe("unpaid");
  expect(me.amountMinor).toBe(3000);
});
