/**
 * 再照合ジョブの統合テスト（実 Postgres・ロール `app_rw`）。
 *
 * check_042（多重起動防止）:
 *   - 1 本目がロックを持っている間、2 本目は即 `ran: false` の no-op
 *   - 接続を強制切断（kill）しても advisory lock が残らない（xact スコープ）
 *
 * check_103（猶予と再照会）:
 *   - 期限切れから 4 日以内の試行は走査対象に残り、最終照会が行われる
 *   - 5 日経過した試行は対象外
 *   - `paid` から 30 日以内の請求は日次 1 回再照会され、事業者側の返金が反映される
 *     （`reconciliation_run.paid_rescanned` / `post_paid_changes`）
 *
 * 隔離: すべて `withRollback` の中（`ledger_entry` / `audit_log` は DELETE できないため）。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("not available in integration tests");
  },
}));

const { runReconcileInTransaction } = await import("@/lib/reconcile");
const { tryAdvisoryXactLock } = await import("@/lib/db/client");
const { yen } = await import("@/lib/payments/money");
const { insertFixtureScenario, FIXTURE_PROVIDER_KEY } = await import(
  "../contract/helpers/fixture-provider"
);

/**
 * このファイル専用のロックキー。**本番のキー（`RECONCILE_LOCK_KEY`）を全テストで使うと、
 * 並列に走る別のテストファイル（reconcile-load）と取り合って `ran: false` になる**
 * （＝実装が正しいがゆえの偽陽性）。既定キーを使う経路は最初のテストだけで確かめる。
 */
const FILE_LOCK_KEY = 8_314_920n;

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

interface SnapshotSpec {
  readonly kind: "succeeded" | "refunded" | "expired";
  readonly amountMinor: number | null;
}

/** 事業者照会の差し込み。呼ばれた `externalRef` を記録する。 */
function snapshotQuerier(specs: ReadonlyMap<string, SnapshotSpec>, calls: string[]) {
  return {
    query(_binding: { readonly providerKey: string }, externalRef: string) {
      calls.push(externalRef);
      const spec = specs.get(externalRef);
      if (spec === undefined) return null;
      return Promise.resolve({
        providerKey: FIXTURE_PROVIDER_KEY,
        externalRef,
        kind: spec.kind,
        money: spec.amountMinor === null ? null : yen(spec.amountMinor),
        fetchedAt: new Date(),
        payerIdentity: null,
        raw: null,
      });
    },
  };
}

async function invoiceStatus(tx: postgres.TransactionSql, invoiceId: string): Promise<string> {
  const rows = await tx<{ settlement_status: string }[]>`
    SELECT settlement_status FROM invoice WHERE id = ${invoiceId}
  `;
  return rows[0]?.settlement_status ?? "";
}

describe("再照合ジョブ（走査 1）", () => {
  it("生きた試行を照会して paid まで前進させ、reconciliation_run に記録する", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "rc-open");
      const calls: string[] = [];
      const specs = new Map<string, SnapshotSpec>([
        [scenario.externalRef, { kind: "succeeded", amountMinor: 3000 }],
      ]);

      const result = await runReconcileInTransaction(tx, {
        querier: snapshotQuerier(specs, calls),
        requestId: "req-rc-open",
        forcePaidRescan: false,
      });

      expect(result.ran).toBe(true);
      expect(calls).toContain(scenario.externalRef);
      expect(result.advanced).toBeGreaterThanOrEqual(1);
      expect(await invoiceStatus(tx, scenario.invoiceId)).toBe("paid");

      const runs = await tx<{ scanned: number; truncated: boolean }[]>`
        SELECT scanned, truncated FROM reconciliation_run WHERE id = ${result.runId ?? ""}
      `;
      expect(runs[0]?.scanned).toBeGreaterThanOrEqual(1);
      expect(runs[0]?.truncated).toBe(false);
    });
  });

  it("同じ状態を 2 回照会しても台帳は 1 回しか動かない（W1 / W2）", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "rc-twice");
      const calls: string[] = [];
      const specs = new Map<string, SnapshotSpec>([
        [scenario.externalRef, { kind: "succeeded", amountMinor: 3000 }],
      ]);
      const deps = {
        querier: snapshotQuerier(specs, calls),
        requestId: "req-rc-twice",
        lockKey: FILE_LOCK_KEY,
        forcePaidRescan: false,
      };

      await runReconcileInTransaction(tx, deps);
      await runReconcileInTransaction(tx, deps);

      const ledger = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(Number(ledger[0]?.count ?? "0")).toBe(1);
    });
  });
});

describe("期限切れの猶予（check_103 / W10）", () => {
  /** 期限切れ試行を `updated_at` 指定で作る（トリガは UPDATE のみに掛かるので INSERT では効かない）。 */
  async function insertExpiredAttempt(
    tx: postgres.TransactionSql,
    scenario: { readonly invoiceId: string; readonly bindingId: string },
    daysAgo: number,
  ): Promise<string> {
    const externalRef = `iv_${scenario.invoiceId.replace(/-/g, "")}_${daysAgo}`;
    const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    await tx`
      INSERT INTO payment_attempt (invoice_id, provider_key, provider_binding_id, external_ref,
                                   amount_minor, status, created_at, updated_at)
      VALUES (${scenario.invoiceId}, ${FIXTURE_PROVIDER_KEY}, ${scenario.bindingId},
              ${externalRef}, 3000, 'expired', ${at}, ${at})
    `;
    return externalRef;
  }

  it("期限切れから 4 日以内は最終照会される。5 日経過は対象外", async () => {
    await withRollback(appRw, async (tx) => {
      const inGrace = await insertFixtureScenario(tx, "rc-grace", { withoutAttempt: true });
      const outOfGrace = await insertFixtureScenario(tx, "rc-stale", { withoutAttempt: true });
      const refInGrace = await insertExpiredAttempt(tx, inGrace, 3);
      const refOutOfGrace = await insertExpiredAttempt(tx, outOfGrace, 5);

      const calls: string[] = [];
      const specs = new Map<string, SnapshotSpec>([
        [refInGrace, { kind: "succeeded", amountMinor: 3000 }],
      ]);

      await runReconcileInTransaction(tx, {
        querier: snapshotQuerier(specs, calls),
        requestId: "req-rc-grace",
        lockKey: FILE_LOCK_KEY,
        forcePaidRescan: false,
      });

      expect(calls).toContain(refInGrace);
      expect(calls).not.toContain(refOutOfGrace);
      // 最終照会で入金が確認できたので、期限切れのまま捨てずに前進させる。
      expect(await invoiceStatus(tx, inGrace.invoiceId)).toBe("paid");
      expect(await invoiceStatus(tx, outOfGrace.invoiceId)).toBe("unpaid");
    });
  });
});

describe("支払済みの再照会（走査 2 / check_103 / R-PAY-07）", () => {
  async function insertPaidScenario(tx: postgres.TransactionSql, suffix: string) {
    const scenario = await insertFixtureScenario(tx, suffix);
    await tx`
      UPDATE payment_attempt SET status = 'succeeded' WHERE id = ${scenario.attemptId}
    `;
    await tx`
      UPDATE invoice SET settlement_status = 'paid', paid_at = now(), auto_detected = true
      WHERE id = ${scenario.invoiceId}
    `;
    return scenario;
  }

  it("paid から 30 日以内の請求を再照会し、事業者側の返金を反映する", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertPaidScenario(tx, "rc-paid");
      const calls: string[] = [];
      const specs = new Map<string, SnapshotSpec>([
        [scenario.externalRef, { kind: "refunded", amountMinor: 3000 }],
      ]);

      const result = await runReconcileInTransaction(tx, {
        querier: snapshotQuerier(specs, calls),
        requestId: "req-rc-paid",
        lockKey: FILE_LOCK_KEY,
        forcePaidRescan: true,
      });

      expect(calls).toContain(scenario.externalRef);
      expect(result.paidRescanned).toBeGreaterThanOrEqual(1);
      expect(result.postPaidChanges).toBeGreaterThanOrEqual(1);
      expect(await invoiceStatus(tx, scenario.invoiceId)).toBe("refunded");
    });
  });

  it("再照会で succeeded が返っても、支払済みの請求に二重の入金を作らない（F-1）", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertPaidScenario(tx, "rc-nodup");
      const calls: string[] = [];
      // Webhook で計上済みの入金と同じ事実が、poll の別 dedupe 鍵で返ってくる筋書き。
      const specs = new Map<string, SnapshotSpec>([
        [scenario.externalRef, { kind: "succeeded", amountMinor: 3000 }],
      ]);

      const result = await runReconcileInTransaction(tx, {
        querier: snapshotQuerier(specs, calls),
        requestId: "req-rc-nodup",
        lockKey: FILE_LOCK_KEY,
        forcePaidRescan: true,
      });

      expect(calls).toContain(scenario.externalRef);
      expect(result.postPaidChanges).toBe(0);
      const ledger = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe(0);
      const polled = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM payment_event
        WHERE external_ref = ${scenario.externalRef} AND ingestion_source = 'poll'
      `;
      expect(polled[0]?.count).toBe(0);
      expect(await invoiceStatus(tx, scenario.invoiceId)).toBe("paid");
    });
  });

  it("直近 24 時間に再照会があれば走査 2 は回さない（日次 1 回）", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertPaidScenario(tx, "rc-daily");
      await tx`
        INSERT INTO reconciliation_run (started_at, finished_at, paid_rescanned)
        VALUES (now(), now(), 1)
      `;
      const calls: string[] = [];
      const specs = new Map<string, SnapshotSpec>([
        [scenario.externalRef, { kind: "refunded", amountMinor: 3000 }],
      ]);

      const result = await runReconcileInTransaction(tx, {
        querier: snapshotQuerier(specs, calls),
        requestId: "req-rc-daily",
        lockKey: FILE_LOCK_KEY,
      });

      expect(result.paidRescanned).toBe(0);
      expect(calls).not.toContain(scenario.externalRef);
      expect(await invoiceStatus(tx, scenario.invoiceId)).toBe("paid");
    });
  });
});

describe("多重起動防止（check_042 / W11 / R-OPS-08）", () => {
  it("1 本目がロックを持つ間、2 本目は即 no-op で reconciliation_run を増やさない", async () => {
    const second = createAppRwSql();
    try {
      await withRollback(appRw, async (tx) => {
        const scenario = await insertFixtureScenario(tx, "rc-lock");
        const calls: string[] = [];
        const specs = new Map<string, SnapshotSpec>([
          [scenario.externalRef, { kind: "succeeded", amountMinor: 3000 }],
        ]);

        // 1 本目: このトランザクションの中でロックを取り、以後 tx が閉じるまで保持する。
        const first = await runReconcileInTransaction(tx, {
          querier: snapshotQuerier(specs, calls),
          requestId: "req-rc-lock-1",
          lockKey: FILE_LOCK_KEY,
          forcePaidRescan: false,
        });
        expect(first.ran).toBe(true);
        expect(first.runId).not.toBeNull();

        // 2 本目: 別接続・別トランザクション。ロックが取れないので即 no-op。
        const secondCalls: string[] = [];
        const result = (await second.begin(async (tx2) =>
          runReconcileInTransaction(tx2, {
            querier: snapshotQuerier(new Map(), secondCalls),
            requestId: "req-rc-lock-2",
            lockKey: FILE_LOCK_KEY,
            forcePaidRescan: false,
          }),
        )) as unknown as { ran: boolean; runId: string | null; scanned: number };

        expect(result.ran).toBe(false);
        expect(result.runId).toBeNull();
        expect(result.scanned).toBe(0);
        expect(secondCalls).toEqual([]);
      });
    } finally {
      await second.end({ timeout: 5 });
    }
  });

  it("ロックを持ったまま接続を強制切断しても pg_locks に残らない（xact スコープ）", async () => {
    const victim = createAppRwSql();
    let pid = 0;
    const held = victim
      .begin(async (tx) => {
        const rows = await tx<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
        pid = rows[0]?.pid ?? 0;
        const locked = await tryAdvisoryXactLock(tx, FILE_LOCK_KEY);
        expect(locked).toBe(true);
        // kill されるまで待つ（到達したら自然に終わる）。
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      })
      .catch(() => undefined);

    for (let i = 0; i < 100 && pid === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pid).toBeGreaterThan(0);

    const before = await lockCount(migrator);
    expect(before).toBeGreaterThanOrEqual(1);

    await migrator`SELECT pg_terminate_backend(${pid})`;
    await held;
    await victim.end({ timeout: 5 }).catch(() => undefined);

    let after = -1;
    for (let i = 0; i < 40; i += 1) {
      after = await lockCount(migrator);
      if (after === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(after).toBe(0);
  });
});

/** 再照合ロックを掴んでいるセッション数。 */
async function lockCount(sql: postgres.Sql): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND ((classid::bigint << 32) | objid::bigint) = ${FILE_LOCK_KEY.toString()}::bigint
  `;
  return rows[0]?.count ?? 0;
}
