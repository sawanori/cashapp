import { test, expect } from "@playwright/test";

import { cleanupE2eUsers, seedOrganizerSession, testSql, uniq } from "./helpers/session";

/**
 * check_001: 幹事が O-0 → O-8 を完走し、名簿に「幹事が手動で確認（自動照合ではありません）」
 * バッジと「支払済み 1/4（自動 0 / 手動 1）」サマリが出る。
 *
 * ★ ブラウザ（`page`）ではなく Playwright の API テストコンテキスト（`request`）で、実際に
 *   動いている dev サーバーへ HTTP で通す。理由: `@line/liff-mock` の既定値（`isInClient:
 *   false`）を上書きする経路が無く、`bootLiff()` が `ready` に到達しないため、この環境の
 *   ブラウザからは `POST /api/auth/line` にすら到達できない（`tests/e2e/outside-line.spec.ts`
 *   / `share.spec.ts` の docstring）。ログインの手前までは `outside-line.spec.ts` が固定して
 *   いるので、ここではログインの**先**（実際の API 契約と画面が読む JSON の形）を、
 *   `tests/e2e/helpers/session.ts` で直接発行したセッションを使って検証する。
 *
 * ★ **現状、このテストは最初の書き込み（`POST /api/events`）で失敗する。**
 *   `createVerifiedDbClient()`（すべての Route Handler の入口）が `drizzle(client, { schema })`
 *   を呼ぶ副作用で、同じ接続の `db.sql`（drizzle を介さない生タグ付きテンプレート）経由の
 *   timestamptz 列が壊れる（`docs/concerns/task_021.md` #1 が発見・本タスクが実測で確定。
 *   `docs/concerns/task_022.md` に repro を記録）。`appendAuditLog` の `occurred_at`（`Date`
 *   束縛）で必ず例外になるため、監査ログを書くほぼ全ての書き込み系ルートが実 HTTP 経由では
 *   動かない。`src/lib/db/client.ts` は本タスクの files_to_modify に無いため修正できない。
 *   このテストは**正しい仕様**を主張したまま残し（テストを弱めない）、赤を根拠として記録する。
 */

const seededUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupE2eUsers(seededUserIds);
});

test("幹事が請求発行 → 手動確認までを完走し、非自動バッジとサマリが正しい値になる", async ({
  request,
  baseURL,
}) => {
  const suffix = uniq();
  const session = await seedOrganizerSession(suffix);
  seededUserIds.push(session.userId);
  const api = baseURL ?? `http://127.0.0.1:${process.env["PLAYWRIGHT_PORT"] ?? "3100"}`;

  const authedHeaders = {
    "content-type": "application/json",
    origin: api,
    cookie: session.cookieHeader,
    "x-csrf-token": session.csrfToken,
  };

  // O-3: イベント作成。
  const createRes = await request.post(`${api}/api/events`, {
    headers: { ...authedHeaders, "idempotency-key": `organizer-flow-create-${suffix}` },
    data: {
      title: "夏合宿",
      organizerLabel: "山田太郎",
      eventAt: null,
      venue: null,
      offering: null,
      defaultAmountMinor: 3000,
      collectByAt: null,
      minorsIncluded: false,
      allowCash: false,
      feeDisclosureAccepted: true,
    },
  });
  expect(createRes.status(), await createRes.text()).toBe(201);
  const created = (await createRes.json()) as { event: { id: string }; joinToken: string };

  // O-4: 参加者 4 名を追加。
  const participantsRes = await request.post(`${api}/api/events/${created.event.id}/participants`, {
    headers: { ...authedHeaders, "idempotency-key": `organizer-flow-participants-${suffix}` },
    data: {
      participants: [
        { displayLabel: "参加者A" },
        { displayLabel: "参加者B" },
        { displayLabel: "参加者C" },
        { displayLabel: "参加者D" },
      ],
    },
  });
  expect(participantsRes.status(), await participantsRes.text()).toBe(201);

  // O-6: 請求を一括発行。
  const invoicesRes = await request.post(`${api}/api/events/${created.event.id}/invoices`, {
    headers: { ...authedHeaders, "idempotency-key": `organizer-flow-invoices-${suffix}` },
    data: { confirmed: true },
  });
  expect(invoicesRes.status(), await invoicesRes.text()).toBe(201);

  // 参加者一覧から 1 件を選び、その invoice_id を取る（一覧 API は participantId しか
  // 返さないため、manual-attest が要求する invoiceId は DB を直接読む。これは API 契約の
  // 一部ではなくテストのフィクスチャ取得であり、`tests/integration/*.test.ts` が同じ立場で
  // 行っているのと同じ理由）。
  const listRes = await request.get(`${api}/api/events/${created.event.id}/participants`, {
    headers: { cookie: session.cookieHeader },
  });
  expect(listRes.status(), await listRes.text()).toBe(200);
  const list = (await listRes.json()) as { items: readonly { id: string }[] };
  const firstParticipantId = list.items[0]!.id;

  const sql = testSql();
  const invoiceRows = await sql<{ id: string }[]>`
    SELECT id FROM invoice WHERE participant_id = ${firstParticipantId}
  `;
  const invoiceId = invoiceRows[0]!.id;

  const attestRes = await request.post(`${api}/api/invoices/${invoiceId}/manual-attest`, {
    headers: { ...authedHeaders, "idempotency-key": `organizer-flow-attest-${suffix}` },
    data: { method: "cash", reason: "当日、現金で受け取った", evidenceNote: null, confirmed: true },
  });
  expect(attestRes.status(), await attestRes.text()).toBe(201);

  // check_001 の核心: 非自動ラベルと内訳。
  const summaryRes = await request.get(`${api}/api/events/${created.event.id}`, {
    headers: { cookie: session.cookieHeader },
  });
  expect(summaryRes.status(), await summaryRes.text()).toBe(200);
  const summary = (await summaryRes.json()) as {
    breakdown: { unpaid: number; paidAutomatic: number; paidManual: number };
  };
  expect(summary.breakdown.paidManual).toBe(1);
  expect(summary.breakdown.paidAutomatic).toBe(0);
  expect(summary.breakdown.unpaid).toBe(3);
});
