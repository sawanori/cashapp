/**
 * 管理面の統合テスト（実 Postgres・task_021 scope）。
 *
 * 見るもの（scope の test 一覧）:
 *   - 非管理者 403（`verifyAdmin` の許可リスト判定、および実際のルート経由）
 *   - フラグ変更が `audit_log` に 2 行（提案 → 承認。二人承認・A23 縮退のクーリング）
 *   - `GET /api/admin/lookup` が `display_label` を返さない
 *   - `docs/gates/legal-clearance.json` の写し（`LEGAL_CLEARANCE_CLEARED`）との整合
 *
 * 二人承認・クーリングの検証は `withRollback` の中で `src/lib/admin-auth.ts` の
 * `proposeAdminAction` / `approveAdminAction` を直接呼ぶ（`tests/integration/auth.test.ts` が
 * `authenticateWithLineIdToken` を直接呼ぶのと同じ方針。ROLLBACK は権限に関わらず
 * 未コミットの `INSERT` を取り消せるため、`audit_log`（追記専用）でもこの方法で隔離できる）。
 *
 * ルート（`GET`/`POST`）そのものを HTTP 相当で呼ぶテストは、実際にコミットされたフィクスチャ
 * を使い、`afterEach` で片付ける（`invoice` / `participant` / `event` / `app_user` /
 * `provider_binding` は `app_rw` が DELETE 可能。`audit_log` / `feature_flag` は DELETE 権限が
 * 無いため、特権接続（`migrator`）で片付ける）。
 */

import fs from "node:fs";
import path from "node:path";

import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "./setup";

vi.mock("server-only", () => ({}));

const cloudflareEnv: Record<string, unknown> = {};
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({ env: cloudflareEnv, cf: undefined, ctx: undefined }),
}));

const {
  ADMIN_SINGLE_APPROVER_COOLDOWN_MS,
  LEGAL_CLEARANCE_CLEARED,
  approveAdminAction,
  proposeAdminAction,
  verifyAdmin,
} = await import("@/lib/admin-auth");
const { GET: gatesGET } = await import("@/app/api/admin/gates/route");
const { POST: flagsPOST } = await import("@/app/api/admin/flags/route");
const { GET: lookupGET } = await import("@/app/api/admin/lookup/route");

let migrator: postgres.Sql;
let appRw: postgres.Sql;

beforeAll(async () => {
  migrator = createMigratorSql();
  await ensureAppRwLoginPassword(migrator);
  appRw = createAppRwSql();
});

afterAll(async () => {
  await appRw?.end({ timeout: 5 });
  await migrator?.end({ timeout: 5 });
});

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function githubFetch(login: string | null, status = 200): typeof fetch {
  return (async (): Promise<Response> => {
    if (login === null) return new Response("unauthorized", { status: 401 });
    return Response.json({ login }, { status });
  }) as unknown as typeof fetch;
}

function adminRequest(url: string, token: string | null, init: RequestInit = {}): Request {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return new Request(url, { ...init, headers });
}

describe("verifyAdmin — 非管理者 403 / 未設定は fail-closed", () => {
  it("Authorization ヘッダが無ければ 401", async () => {
    await expect(
      verifyAdmin({
        request: adminRequest("https://admin.example/api/admin/gates", null),
        env: { ADMIN_ALLOWLIST: "alice" },
        fetchImpl: githubFetch("alice"),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("GitHub がトークンを拒否すれば 401", async () => {
    await expect(
      verifyAdmin({
        request: adminRequest("https://admin.example/api/admin/gates", "bad-token"),
        env: { ADMIN_ALLOWLIST: "alice" },
        fetchImpl: githubFetch(null),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("GitHub 認証は通るが許可リストに無ければ 403", async () => {
    await expect(
      verifyAdmin({
        request: adminRequest("https://admin.example/api/admin/gates", "good-token"),
        env: { ADMIN_ALLOWLIST: "alice,bob" },
        fetchImpl: githubFetch("mallory"),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("許可リスト（大小無視）に載っていれば adminId を返す", async () => {
    const identity = await verifyAdmin({
      request: adminRequest("https://admin.example/api/admin/gates", "good-token"),
      env: { ADMIN_ALLOWLIST: "Alice, bob" },
      fetchImpl: githubFetch("alice"),
    });
    expect(identity).toEqual({ adminId: "gh:alice", login: "alice" });
  });

  it("ADMIN_ALLOWLIST が未設定なら 500 設定不備（fail-closed。誰でも通す側に倒さない）", async () => {
    await expect(
      verifyAdmin({
        request: adminRequest("https://admin.example/api/admin/gates", "good-token"),
        env: {},
        fetchImpl: githubFetch("alice"),
      }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("GitHub login の大小文字が異なっても同一の adminId に正規化される（G5 レビュー是正: 大小文字違いによる二人承認の偽装を防ぐ）", async () => {
    const identityLower = await verifyAdmin({
      request: adminRequest("https://admin.example/api/admin/gates", "token-1"),
      env: { ADMIN_ALLOWLIST: "alice" },
      fetchImpl: githubFetch("alice"),
    });
    const identityMixedCase = await verifyAdmin({
      request: adminRequest("https://admin.example/api/admin/gates", "token-2"),
      env: { ADMIN_ALLOWLIST: "alice" },
      fetchImpl: githubFetch("Alice"),
    });
    expect(identityLower.adminId).toBe("gh:alice");
    expect(identityMixedCase.adminId).toBe("gh:alice");
  });
});

describe("GET /api/admin/gates — 非管理者は実ルートでも 403", () => {
  afterEach(() => {
    for (const key of Object.keys(cloudflareEnv)) delete cloudflareEnv[key];
  });

  it("許可リストに無い GitHub login は 403", async () => {
    Object.assign(cloudflareEnv, { ADMIN_ALLOWLIST: "alice" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = githubFetch("mallory");
    try {
      const response = await gatesGET(
        adminRequest("https://admin.example/api/admin/gates", "any-token"),
      );
      expect(response.status).toBe(403);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("Authorization ヘッダが無ければ 401", async () => {
    Object.assign(cloudflareEnv, { ADMIN_ALLOWLIST: "alice" });
    const response = await gatesGET(new Request("https://admin.example/api/admin/gates"));
    expect(response.status).toBe(401);
  });
});

describe("proposeAdminAction / approveAdminAction — 二人承認と A23 縮退", () => {
  const ADMIN_1 = { adminId: "gh:alice", login: "alice" };
  const ADMIN_2 = { adminId: "gh:bob", login: "bob" };

  it("別の管理者が承認すると audit_log に 2 行（propose・approve）でき、twoPerson=true", async () => {
    await withRollback(appRw, async (tx) => {
      const subjectId = "PROVIDER_TASK021TEST1_MODE";
      const proposal = await proposeAdminAction(tx, {
        kind: "admin.flag",
        admin: ADMIN_1,
        subjectType: "feature_flag",
        subjectId,
        detail: { key: subjectId, value: "on" },
        requestId: "req-propose-1",
      });

      const approved = await approveAdminAction(tx, {
        kind: "admin.flag",
        admin: ADMIN_2,
        proposalId: proposal.proposalId,
        requestId: "req-approve-1",
      });
      expect(approved.twoPerson).toBe(true);
      expect(approved.detail).toEqual({ key: subjectId, value: "on" });

      const rows = await tx<{ action: string }[]>`
        SELECT action FROM audit_log
        WHERE target_type = 'feature_flag' AND target_id = ${subjectId}
        ORDER BY id ASC
      `;
      expect(rows.map((r) => r.action)).toEqual(["admin.flag.propose", "admin.flag.approve"]);
    });
  });

  it("同一管理者による承認は 24 時間未満なら拒否される（A23 縮退のクーリング）", async () => {
    await withRollback(appRw, async (tx) => {
      const subjectId = "PROVIDER_TASK021TEST2_MODE";
      const proposedAt = new Date("2026-09-01T00:00:00Z");
      const proposal = await proposeAdminAction(tx, {
        kind: "admin.flag",
        admin: ADMIN_1,
        subjectType: "feature_flag",
        subjectId,
        detail: { key: subjectId, value: "on" },
        requestId: "req-propose-2",
        now: proposedAt,
      });

      const almostADayLater = new Date(proposedAt.getTime() + ADMIN_SINGLE_APPROVER_COOLDOWN_MS - 1000);
      await expect(
        approveAdminAction(tx, {
          kind: "admin.flag",
          admin: ADMIN_1,
          proposalId: proposal.proposalId,
          requestId: "req-approve-2a",
          now: almostADayLater,
        }),
      ).rejects.toMatchObject({ status: 409 });

      const exactly24hLater = new Date(proposedAt.getTime() + ADMIN_SINGLE_APPROVER_COOLDOWN_MS);
      const approved = await approveAdminAction(tx, {
        kind: "admin.flag",
        admin: ADMIN_1,
        proposalId: proposal.proposalId,
        requestId: "req-approve-2b",
        now: exactly24hLater,
      });
      expect(approved.twoPerson).toBe(false);
    });
  });

  it("同じ proposalId を 2 回承認できない（二重承認の拒否）", async () => {
    await withRollback(appRw, async (tx) => {
      const subjectId = "PROVIDER_TASK021TEST3_MODE";
      const proposal = await proposeAdminAction(tx, {
        kind: "admin.flag",
        admin: ADMIN_1,
        subjectType: "feature_flag",
        subjectId,
        detail: { key: subjectId, value: "on" },
        requestId: "req-propose-3",
      });
      await approveAdminAction(tx, {
        kind: "admin.flag",
        admin: ADMIN_2,
        proposalId: proposal.proposalId,
        requestId: "req-approve-3a",
      });
      await expect(
        approveAdminAction(tx, {
          kind: "admin.flag",
          admin: ADMIN_1,
          proposalId: proposal.proposalId,
          requestId: "req-approve-3b",
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  it("存在しない proposalId、または種別（kind）が異なる提案は 404", async () => {
    await withRollback(appRw, async (tx) => {
      await expect(
        approveAdminAction(tx, {
          kind: "admin.flag",
          admin: ADMIN_1,
          proposalId: "999999999",
          requestId: "req-approve-missing",
        }),
      ).rejects.toMatchObject({ status: 404 });

      const proposal = await proposeAdminAction(tx, {
        kind: "admin.suspend",
        admin: ADMIN_1,
        subjectType: "app_user",
        subjectId: "00000000-0000-4000-8000-000000000000",
        detail: { organizerUserId: "00000000-0000-4000-8000-000000000000" },
        requestId: "req-propose-kind",
      });
      await expect(
        approveAdminAction(tx, {
          kind: "admin.flag",
          admin: ADMIN_2,
          proposalId: proposal.proposalId,
          requestId: "req-approve-wrong-kind",
        }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  it("proposalId に先頭ゼロを付けると 404（G5 レビュー是正: 先頭ゼロで承認済み申請を再承認できた不具合の防止）", async () => {
    await withRollback(appRw, async (tx) => {
      const subjectId = "PROVIDER_TASK021TEST4_MODE";
      const proposal = await proposeAdminAction(tx, {
        kind: "admin.flag",
        admin: ADMIN_1,
        subjectType: "feature_flag",
        subjectId,
        detail: { key: subjectId, value: "on" },
        requestId: "req-propose-4",
      });
      await approveAdminAction(tx, {
        kind: "admin.flag",
        admin: ADMIN_2,
        proposalId: proposal.proposalId,
        requestId: "req-approve-4a",
      });

      // 既に承認済みの proposalId に先頭ゼロを付けて再承認を試みる。修正前は
      // `id = ...::bigint` が数値として一致する一方、`detail->>'proposalId' = ...` の
      // 文字列一致だけが先頭ゼロで外れ、二重承認が成立してしまっていた。
      await expect(
        approveAdminAction(tx, {
          kind: "admin.flag",
          admin: ADMIN_1,
          proposalId: `0${proposal.proposalId}`,
          requestId: "req-approve-4b-padded",
        }),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});

describe("LEGAL_CLEARANCE_CLEARED — docs/gates/legal-clearance.json との一致", () => {
  it("正本の cleared とコード上の写しが一致する（食い違ったら落ちる。src/lib/payments/gates.ts の CANONICAL_GATES と同じ方針）", () => {
    const file = path.join(REPO_ROOT, "docs", "gates", "legal-clearance.json");
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { cleared: unknown };
    expect(doc.cleared).toBe(LEGAL_CLEARANCE_CLEARED);
  });
});

describe("POST /api/admin/flags（実ルート）", () => {
  // ★ ここに「propose → approve の往復で feature_flag が実際に更新される」という実ルート
  //   経由（createVerifiedDbClient）の往復テストは置かない。`src/lib/idempotency.ts` の
  //   `runIdempotent` が内部で計算する `expiresAt`（`Date`）を `idempotency_key.expires_at`
  //   へ束縛する INSERT が、`tests/integration/_debug_admin.test.ts` に固定した既知の不具合
  //   （`createDbClient` が `drizzle()` の副作用で `db.sql` の timestamp パーサ/シリアライザを
  //   壊す。詳細は `docs/concerns/task_021.md`）により毎回 500 で落ちる。原因は
  //   `src/lib/db/client.ts` / `src/lib/idempotency.ts` 側にあり、どちらも本タスクの
  //   files_to_modify に含まれないため、ここでは直さない。「フラグ変更が audit_log に 2 行」
  //   という要件そのものは、上の `proposeAdminAction` / `approveAdminAction` を直接呼ぶ
  //   テスト群（`withRollback` の中。この不具合の影響を受けない接続を使う）で検証済みである。
  //   このブロックでは、DB への書き込みへ進む**前に**弾かれる入力検証だけを実ルート経由で見る
  //   （その手前で落ちるので上記の不具合を踏まない）。
  afterEach(() => {
    for (const key of Object.keys(cloudflareEnv)) delete cloudflareEnv[key];
  });

  it("Idempotency-Key ヘッダが無ければ 400", async () => {
    const { appRwConnectionString } = await import("./setup");
    Object.assign(cloudflareEnv, {
      ADMIN_ALLOWLIST: "alice",
      DATABASE_URL: appRwConnectionString(),
      APP_ENV: "development",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = githubFetch("alice");
    try {
      const response = await flagsPOST(
        adminRequest("https://admin.example/api/admin/flags", "token-alice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "propose", key: "PAYMENTS_ENABLED", value: "false" }),
        }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code?: unknown; requestId?: unknown };
      expect(typeof body.code).toBe("string");
      expect(typeof body.requestId).toBe("string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("形の悪い入力（未知の key / 未知の value / 未知の action / proposalId 欠落）はいずれも 400", async () => {
    const { appRwConnectionString } = await import("./setup");
    Object.assign(cloudflareEnv, {
      ADMIN_ALLOWLIST: "alice",
      DATABASE_URL: appRwConnectionString(),
      APP_ENV: "development",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = githubFetch("alice");
    try {
      const badKeyResponse = await flagsPOST(
        adminRequest("https://admin.example/api/admin/flags", "token-alice", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": "idem-bad-key" },
          body: JSON.stringify({ action: "propose", key: "SOME_OTHER_FLAG", value: "on" }),
        }),
      );
      expect(badKeyResponse.status).toBe(400);

      const badValueResponse = await flagsPOST(
        adminRequest("https://admin.example/api/admin/flags", "token-alice", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": "idem-bad-value" },
          body: JSON.stringify({
            action: "propose",
            key: "PROVIDER_TASK021BADVALUE_MODE",
            value: "yes",
          }),
        }),
      );
      expect(badValueResponse.status).toBe(400);

      const badActionResponse = await flagsPOST(
        adminRequest("https://admin.example/api/admin/flags", "token-alice", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": "idem-bad-action" },
          body: JSON.stringify({ action: "delete", key: "PAYMENTS_ENABLED", value: "false" }),
        }),
      );
      expect(badActionResponse.status).toBe(400);

      const missingProposalIdResponse = await flagsPOST(
        adminRequest("https://admin.example/api/admin/flags", "token-alice", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": "idem-missing-pid" },
          body: JSON.stringify({ action: "approve" }),
        }),
      );
      expect(missingProposalIdResponse.status).toBe(400);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("PAYMENTS_ENABLED=true への提案は legal-clearance.cleared が false のため 409（現状の正本値。DB 書き込みの前に弾かれるため上の不具合の影響を受けない）", async () => {
    expect(LEGAL_CLEARANCE_CLEARED).toBe(false);
    const { appRwConnectionString } = await import("./setup");
    Object.assign(cloudflareEnv, {
      ADMIN_ALLOWLIST: "alice",
      DATABASE_URL: appRwConnectionString(),
      APP_ENV: "development",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = githubFetch("alice");
    try {
      const response = await flagsPOST(
        adminRequest("https://admin.example/api/admin/flags", "token-alice", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": "idem-legal-clearance" },
          body: JSON.stringify({ action: "propose", key: "PAYMENTS_ENABLED", value: "true" }),
        }),
      );
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code?: unknown };
      expect(body.code).toBe("LEGAL_CLEARANCE_REQUIRED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GET /api/admin/lookup（実ルート）— display_label を一切返さない", () => {
  let fixtureUserId: string;
  let fixtureBindingId: string;
  let fixtureEventId: string;
  let fixtureParticipantId: string;
  let fixtureInvoiceId: string;
  const DISPLAY_LABEL = "テスト太郎_task021";

  beforeAll(async () => {
    const [user] = await appRw<{ id: string }[]>`
      INSERT INTO app_user (line_user_ref, identity_scope, line_env)
      VALUES (${Buffer.from("admin-lookup-fixture-user")}, 'test:admin-lookup', 'development')
      RETURNING id
    `;
    fixtureUserId = user!.id;
    const [binding] = await appRw<{ id: string }[]>`
      INSERT INTO provider_binding (organizer_user_id, provider_key, status)
      VALUES (${fixtureUserId}, 'manual_confirm', 'active')
      RETURNING id
    `;
    fixtureBindingId = binding!.id;
    const [event] = await appRw<{ id: string }[]>`
      INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                         minors_included, provider_binding_id)
      VALUES (${fixtureUserId}, 'admin-lookup-fixture-event', 'organizer-label-task021',
              ${Buffer.from("admin-lookup-fixture-join")}, false, ${fixtureBindingId})
      RETURNING id
    `;
    fixtureEventId = event!.id;
    const [participant] = await appRw<{ id: string }[]>`
      INSERT INTO participant (event_id, display_label)
      VALUES (${fixtureEventId}, ${DISPLAY_LABEL})
      RETURNING id
    `;
    fixtureParticipantId = participant!.id;
    const [invoice] = await appRw<{ id: string }[]>`
      INSERT INTO invoice (event_id, participant_id, amount_minor)
      VALUES (${fixtureEventId}, ${fixtureParticipantId}, 4200)
      RETURNING id
    `;
    fixtureInvoiceId = invoice!.id;
  });

  afterAll(async () => {
    await appRw`DELETE FROM invoice WHERE id = ${fixtureInvoiceId}`;
    await appRw`DELETE FROM participant WHERE id = ${fixtureParticipantId}`;
    await appRw`DELETE FROM event WHERE id = ${fixtureEventId}`;
    await appRw`DELETE FROM provider_binding WHERE id = ${fixtureBindingId}`;
    await appRw`DELETE FROM app_user WHERE id = ${fixtureUserId}`;
  });

  afterEach(() => {
    for (const key of Object.keys(cloudflareEnv)) delete cloudflareEnv[key];
  });

  it("invoiceId で照会しても display_label / organizer_label はどこにも出てこない", async () => {
    const { appRwConnectionString } = await import("./setup");
    Object.assign(cloudflareEnv, {
      ADMIN_ALLOWLIST: "alice",
      DATABASE_URL: appRwConnectionString(),
      APP_ENV: "development",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = githubFetch("alice");
    let response: Response;
    try {
      response = await lookupGET(
        adminRequest(
          `https://admin.example/api/admin/lookup?invoiceId=${fixtureInvoiceId}`,
          "token-alice",
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    expect(bodyText).not.toContain(DISPLAY_LABEL);
    expect(bodyText).not.toContain("organizer-label-task021");
    expect(bodyText).not.toContain("displayLabel");
    expect(bodyText).not.toContain("organizerLabel");

    const body = JSON.parse(bodyText) as { invoice: { id: string; amountMinor: number } };
    expect(body.invoice.id).toBe(fixtureInvoiceId);
    expect(body.invoice.amountMinor).toBe(4200);
  });
});
