/**
 * 再照合ジョブの負荷（check_102 / W9 / W11 / R-OPS-08）。
 *
 *   - 未払い 300 件を作り、バッチ 100 で**複数回に分けて完走**することを確かめる
 *   - 上限に達した回は `truncated`（`reconciliation_run.note='truncated'`）
 *   - 1 件 3 秒 timeout: 応答しない事業者があっても実行全体が止まらない
 *   - 並列 5: 同時に走る照会が 5 を超えない
 *
 * 300 件は 1 つのトランザクション内に作り、最後にロールバックする（他タスクのデータを汚さない）。
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

const { runReconcileInTransaction, RECONCILE_BATCH_LIMIT } = await import("@/lib/reconcile");
const { yen } = await import("@/lib/payments/money");
const { FIXTURE_PROVIDER_KEY } = await import("../contract/helpers/fixture-provider");

/** 並列に走る reconcile.test.ts とロックを取り合わないための、このファイル専用のキー。 */
const FILE_LOCK_KEY = 8_314_921n;

const TOTAL = 300;

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

interface Bulk {
  readonly eventId: string;
  readonly externalRefs: readonly string[];
}

/** 1 イベントに 300 名分の請求と生きた試行を作る。 */
async function insertBulk(tx: postgres.TransactionSql, suffix: string): Promise<Bulk> {
  const [user] = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`load-${suffix}`)}, ${`load:${suffix}`}, 'development')
    RETURNING id
  `;
  const [binding] = await tx<{ id: string }[]>`
    INSERT INTO provider_binding (organizer_user_id, provider_key, status, capabilities)
    VALUES (${user!.id}, ${FIXTURE_PROVIDER_KEY}, 'active', '{}'::jsonb)
    RETURNING id
  `;
  const [event] = await tx<{ id: string }[]>`
    INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                       minors_included, provider_key, provider_binding_id)
    VALUES (${user!.id}, ${`load-${suffix}`}, 'organizer', ${Buffer.from(`jt-load-${suffix}`)},
            false, ${FIXTURE_PROVIDER_KEY}, ${binding!.id})
    RETURNING id
  `;
  const refs: string[] = [];
  for (let i = 0; i < TOTAL; i += 1) {
    const [participant] = await tx<{ id: string }[]>`
      INSERT INTO participant (event_id, display_label)
      VALUES (${event!.id}, ${`p-${i}`})
      RETURNING id
    `;
    const [invoice] = await tx<{ id: string }[]>`
      INSERT INTO invoice (event_id, participant_id, amount_minor)
      VALUES (${event!.id}, ${participant!.id}, 3000)
      RETURNING id
    `;
    const externalRef = `iv_${invoice!.id.replace(/-/g, "")}_1`;
    await tx`
      INSERT INTO payment_attempt (invoice_id, provider_key, provider_binding_id, external_ref,
                                   amount_minor, status)
      VALUES (${invoice!.id}, ${FIXTURE_PROVIDER_KEY}, ${binding!.id}, ${externalRef},
              3000, 'redirected')
    `;
    refs.push(externalRef);
  }
  return { eventId: event!.id, externalRefs: refs };
}

async function unpaidCount(tx: postgres.TransactionSql, eventId: string): Promise<number> {
  const rows = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM invoice
    WHERE event_id = ${eventId} AND settlement_rank < 40
  `;
  return rows[0]?.count ?? 0;
}

describe("照合ジョブのバッチ（check_102）", () => {
  it(
    "300 件をバッチ 100 で複数回に分けて完走し、上限到達回は truncated を残す",
    async () => {
      await withRollback(appRw, async (tx) => {
        const bulk = await insertBulk(tx, `b-${crypto.randomUUID().slice(0, 8)}`);

        let inFlight = 0;
        let maxInFlight = 0;
        const querier = {
          query(_binding: { readonly providerKey: string }, externalRef: string) {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return new Promise<{
              providerKey: string;
              externalRef: string;
              kind: "succeeded";
              money: ReturnType<typeof yen>;
              fetchedAt: Date;
              payerIdentity: null;
              raw: null;
            }>((resolve) => {
              setTimeout(() => {
                inFlight -= 1;
                resolve({
                  providerKey: FIXTURE_PROVIDER_KEY,
                  externalRef,
                  kind: "succeeded",
                  money: yen(3000),
                  fetchedAt: new Date(),
                  payerIdentity: null,
                  raw: null,
                });
              }, 1);
            });
          },
        };

        const notes: (string | null)[] = [];
        let runs = 0;
        for (let i = 0; i < 6 && (await unpaidCount(tx, bulk.eventId)) > 0; i += 1) {
          const result = await runReconcileInTransaction(tx, {
            querier,
            requestId: `req-load-${i}`,
            lockKey: FILE_LOCK_KEY,
            forcePaidRescan: false,
          });
          runs += 1;
          const row = await tx<{ note: string | null }[]>`
            SELECT note FROM reconciliation_run WHERE id = ${result.runId ?? ""}
          `;
          notes.push(row[0]?.note ?? null);
          expect(result.scanned).toBeLessThanOrEqual(RECONCILE_BATCH_LIMIT);
        }

        expect(await unpaidCount(tx, bulk.eventId)).toBe(0);
        expect(runs).toBe(TOTAL / RECONCILE_BATCH_LIMIT);
        // 上限ちょうどで拾った回は truncated（続きは次回）。
        expect(notes.filter((note) => note === "truncated").length).toBeGreaterThanOrEqual(1);
        // 並列 5 を超えない。
        expect(maxInFlight).toBeLessThanOrEqual(5);
        expect(maxInFlight).toBeGreaterThan(1);
      });
    },
    120_000,
  );

  it("応答しない事業者は 3 秒で打ち切り、他の件の処理を止めない", async () => {
    await withRollback(appRw, async (tx) => {
      const bulk = await insertBulk2(tx);
      const hanging = bulk.externalRefs[0] ?? "";
      const healthy = bulk.externalRefs[1] ?? "";

      const querier = {
        query(_binding: { readonly providerKey: string }, externalRef: string) {
          if (externalRef === hanging) {
            // 永久に解決しない = 事業者が応答しない。
            return new Promise<never>(() => undefined);
          }
          return Promise.resolve({
            providerKey: FIXTURE_PROVIDER_KEY,
            externalRef,
            kind: "succeeded" as const,
            money: yen(3000),
            fetchedAt: new Date(),
            payerIdentity: null,
            raw: null,
          });
        },
      };

      const startedAt = Date.now();
      const result = await runReconcileInTransaction(tx, {
        querier,
        requestId: "req-load-timeout",
        lockKey: FILE_LOCK_KEY,
        forcePaidRescan: false,
        timeoutMs: 300,
      });
      const elapsed = Date.now() - startedAt;

      expect(result.ran).toBe(true);
      // 打ち切りが効いていれば、ぶら下がり 1 件があっても実行は短時間で戻る。
      expect(elapsed).toBeLessThan(10_000);
      expect(result.advanced).toBeGreaterThanOrEqual(1);

      const hangingStatus = await tx<{ settlement_status: string }[]>`
        SELECT i.settlement_status FROM invoice i
        JOIN payment_attempt a ON a.invoice_id = i.id
        WHERE a.external_ref = ${hanging}
      `;
      // 確定しなかった件は unpaid のまま（次回の走査が同じ行を拾う。W9）。
      expect(hangingStatus[0]?.settlement_status).toBe("unpaid");

      const healthyStatus = await tx<{ settlement_status: string }[]>`
        SELECT i.settlement_status FROM invoice i
        JOIN payment_attempt a ON a.invoice_id = i.id
        WHERE a.external_ref = ${healthy}
      `;
      expect(healthyStatus[0]?.settlement_status).toBe("paid");
    });
  });
});

/** timeout の検査には 300 件も要らないので、小さい束を作る。 */
async function insertBulk2(tx: postgres.TransactionSql): Promise<Bulk> {
  const suffix = `t-${crypto.randomUUID().slice(0, 8)}`;
  const [user] = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`load-${suffix}`)}, ${`load:${suffix}`}, 'development')
    RETURNING id
  `;
  const [binding] = await tx<{ id: string }[]>`
    INSERT INTO provider_binding (organizer_user_id, provider_key, status, capabilities)
    VALUES (${user!.id}, ${FIXTURE_PROVIDER_KEY}, 'active', '{}'::jsonb)
    RETURNING id
  `;
  const [event] = await tx<{ id: string }[]>`
    INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                       minors_included, provider_key, provider_binding_id)
    VALUES (${user!.id}, ${`load-${suffix}`}, 'organizer', ${Buffer.from(`jt-load-${suffix}`)},
            false, ${FIXTURE_PROVIDER_KEY}, ${binding!.id})
    RETURNING id
  `;
  const refs: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const [participant] = await tx<{ id: string }[]>`
      INSERT INTO participant (event_id, display_label) VALUES (${event!.id}, ${`p-${i}`})
      RETURNING id
    `;
    const [invoice] = await tx<{ id: string }[]>`
      INSERT INTO invoice (event_id, participant_id, amount_minor)
      VALUES (${event!.id}, ${participant!.id}, 3000)
      RETURNING id
    `;
    const externalRef = `iv_${invoice!.id.replace(/-/g, "")}_1`;
    await tx`
      INSERT INTO payment_attempt (invoice_id, provider_key, provider_binding_id, external_ref,
                                   amount_minor, status)
      VALUES (${invoice!.id}, ${FIXTURE_PROVIDER_KEY}, ${binding!.id}, ${externalRef},
              3000, 'redirected')
    `;
    refs.push(externalRef);
  }
  return { eventId: event!.id, externalRefs: refs };
}
