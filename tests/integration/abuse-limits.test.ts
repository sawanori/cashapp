/**
 * `POST /api/e/report` のレート制限（scope: 「幹事あたり上限（サーバー強制）」の一部・
 * 「上限超過 429」）の統合テスト（実 Postgres・task_021 scope）。
 *
 * ★ ルート（`POST` 関数）そのものを `createVerifiedDbClient` 経由の実 HTTP 呼び出しで
 *   検証していない。`src/lib/join-token.ts` の `resolveEventByJoinToken` は
 *   `row.join_token_expires_at.getTime()` を呼ぶが、`createVerifiedDbClient`（および
 *   `createDbClient`）が返す `db.sql` は drizzle-orm の副作用で timestamptz 列を `Date`
 *   ではなく**生の文字列**で返すため（`tests/integration/_debug_admin.test.ts` に repro を
 *   固定した既知の不具合）、実ルート経由では参加者向けエンドポイントの入口
 *   （`resolveEventByJoinToken` を呼ぶすべてのルート）が `TypeError: ...getTime is not a
 *   function` で 500 になる。原因は `src/lib/db/client.ts` にあり、本タスクの
 *   files_to_modify に含まれないため、ここでは直さない。
 *
 *   本ファイルは、`tests/integration/claims.test.ts` と同じ確立された方式（`withRollback`
 *   の `tx`。drizzle を介さない安全な接続なのでこの不具合を踏まない）で、
 *   ① `src/lib/auth/rate-limit.ts` の実際のレート制限コード（`resolveRateLimiter`）と、
 *   ② `POST /api/e/report`（`src/app/api/e/report/route.ts`）が DB に書き込む内容と同じ
 *      手順（`abuse_report` への INSERT ＋ `appendAuditLog`）
 *   を組み合わせて、「レート制限に掛かった要求は DB に何も残さず 429 相当になる」ことを検証する。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "./setup";

vi.mock("server-only", () => ({}));

const { createEvent } = await import("@/lib/db/repositories/events");
const { assertParticipantConsent, loadUserRef, recordParticipantConsent } = await import(
  "@/lib/db/repositories/claims"
);
const { resolveEventByJoinToken } = await import("@/lib/join-token");
const { appendAuditLog } = await import("@/lib/audit");
const { RateLimiterUnavailableError, resolveRateLimiter } = await import("@/lib/auth/rate-limit");
const { AppError, rateLimited } = await import("@/lib/errors");

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

function uniq(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const BASE_EVENT_INPUT = {
  title: "テストイベント",
  organizerLabel: "幹事",
  eventAt: null,
  venue: null,
  offering: null,
  defaultAmountMinor: 1000,
  collectByAt: null,
  minorsIncluded: false,
  allowCash: false,
  feeDisclosureAccepted: true,
} as const;

/**
 * `createEvent`（`src/lib/db/repositories/events.ts`）は `join_token_expires_at` を設定しない
 * （`POST /api/events` の Route Handler が同一トランザクション内で別途 `UPDATE` する。
 * `src/app/api/events/route.ts` 参照）。ここではリポジトリ関数だけを直接呼ぶため、同じ
 * 後続 `UPDATE` をテスト側で再現する。
 */
async function setJoinTokenExpiry(tx: postgres.TransactionSql, eventId: string): Promise<void> {
  await tx`UPDATE event SET join_token_expires_at = now() + interval '90 days' WHERE id = ${eventId}`;
}

async function insertUser(tx: postgres.TransactionSql, suffix: string): Promise<{ id: string }> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`user-${suffix}`)}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("failed to insert test user");
  return { id: row.id };
}

/**
 * `AUTH_RATE_LIMITER` バインディング相当のモック。`allowedCount` 回まで許可し、以降は拒否する。
 * `src/lib/auth/rate-limit.ts` の `bindingLimiter` がこの `.limit()` を呼ぶ。
 */
function countingBinding(allowedCount: number): {
  readonly limit: (options: { readonly key: string }) => Promise<{ success: boolean }>;
  readonly callCount: () => number;
} {
  let calls = 0;
  return {
    limit: async () => {
      calls += 1;
      return { success: calls <= allowedCount };
    },
    callCount: () => calls,
  };
}

/**
 * `POST /api/e/report`（`src/app/api/e/report/route.ts`）が成功時に行う DB 操作と同じもの。
 * ルートの本体そのものはこのファイル冒頭の理由により直接呼べないため、同じ手順をここに
 * 複製する（`abuse_report` への INSERT と `event.abuse_report` の監査ログ 1 行）。
 */
async function reportAbuse(
  tx: postgres.TransactionSql,
  input: {
    readonly eventId: string;
    readonly reporterUserRef: Buffer;
    readonly reason: string;
    readonly requestId: string;
  },
): Promise<string> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO abuse_report (event_id, reporter_user_ref, reason)
    VALUES (${input.eventId}, ${input.reporterUserRef}, ${input.reason})
    RETURNING id
  `;
  const row = inserted[0];
  if (row === undefined) throw new Error("abuse_report insert returned no row");
  await appendAuditLog(tx, {
    actorType: "participant",
    actorRef: input.reporterUserRef,
    action: "event.abuse_report",
    targetType: "event",
    targetId: input.eventId,
    requestId: input.requestId,
    detail: {},
  });
  return row.id;
}

describe("POST /api/e/report のレート制限", () => {
  it("上限を超えた要求はレート制限で拒否され（429 相当）、DB に何も残さない", async () => {
    await withRollback(appRw, async (tx) => {
      const organizer = await insertUser(tx, uniq());
      const { event } = await createEvent(tx, organizer.id, { ...BASE_EVENT_INPUT });
      await setJoinTokenExpiry(tx, event.id);

      const reporter = await insertUser(tx, uniq());
      await recordParticipantConsent(tx, reporter.id);
      // 同意済みであることの確認（例外を投げなければ良い）。
      await assertParticipantConsent(tx as unknown as postgres.Sql, reporter.id);
      const userRef = await loadUserRef(tx as unknown as postgres.Sql, reporter.id);

      const binding = countingBinding(2);
      const limiter = resolveRateLimiter({ AUTH_RATE_LIMITER: binding });

      let reportedCount = 0;
      let rateLimitedCount = 0;
      for (let i = 0; i < 3; i += 1) {
        const decision = await limiter.check(`e-report:${event.id}:${reporter.id}`);
        if (!decision.allowed) {
          rateLimitedCount += 1;
          continue;
        }
        await reportAbuse(tx, {
          eventId: event.id,
          reporterUserRef: userRef.lineUserRef,
          reason: `abuse reason ${i}`,
          requestId: `req-abuse-${i}`,
        });
        reportedCount += 1;
      }

      expect(reportedCount).toBe(2);
      expect(rateLimitedCount).toBe(1);
      expect(binding.callCount()).toBe(3);

      const rows = await tx<{ id: string }[]>`
        SELECT id FROM abuse_report WHERE event_id = ${event.id}
      `;
      expect(rows).toHaveLength(2);
    });
  });

  it("レート制限バインディングが無い環境では fail-closed（RateLimiterUnavailableError）", () => {
    expect(() => resolveRateLimiter({ APP_ENV: "production" })).toThrow(RateLimiterUnavailableError);
  });

  it("rateLimited() は 429 の AppError を作る（ルートが返すエラー形と一致）", () => {
    const error = rateLimited("test");
    expect(error).toBeInstanceOf(AppError);
    expect(error.status).toBe(429);
  });

  it("resolveEventByJoinToken は安全な接続（drizzle を介さない tx）では Date を正しく扱える（対照）", async () => {
    await withRollback(appRw, async (tx) => {
      const organizer = await insertUser(tx, uniq());
      const { event, joinToken } = await createEvent(tx, organizer.id, {
        ...BASE_EVENT_INPUT,
        title: "対照テストイベント",
      });
      await setJoinTokenExpiry(tx, event.id);
      const resolved = await resolveEventByJoinToken(tx as unknown as postgres.Sql, joinToken);
      expect(resolved.id).toBe(event.id);
    });
  });
});
