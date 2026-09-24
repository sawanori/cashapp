/**
 * `/api/cron/apply-pending` の統合テスト（check_104 / R-PAY-11）。
 *
 *   - 保存だけされて未適用（`apply_result IS NULL AND processed_at IS NULL`）の
 *     `payment_event` を拾い、台帳へ適用する
 *   - **ゲートが閉じたままの行は適用しない**（キルスイッチが効いている間に cron が
 *     こっそり台帳へ流し込まない）
 *   - 2 回走らせても台帳は 1 回しか動かない
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

const { runApplyPending } = await import("@/app/api/cron/apply-pending/route");
const { insertFixtureScenario, FIXTURE_PROVIDER_KEY } = await import(
  "../contract/helpers/fixture-provider"
);

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

/** ゲート未通過で保留された受信イベントを 1 件作る（Webhook ルートが残す形と同じ）。 */
async function insertHeldEvent(
  tx: postgres.TransactionSql,
  externalRef: string,
  amountMinor: number,
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO payment_event (provider_key, provider_event_id, event_type, kind, external_ref,
                               business_idem_key, amount_minor, currency, occurred_at,
                               ingestion_source, trust, raw_redacted)
    VALUES (${FIXTURE_PROVIDER_KEY}, ${`held:${externalRef}`}, 'payment.succeeded', 'succeeded',
            ${externalRef}, ${`${externalRef}:succeeded`}, ${amountMinor}, 'JPY', now(),
            'webhook', 'verified', '{}'::jsonb)
    RETURNING id
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("payment_event insert returned no row");
  return row.id;
}

async function pendingCount(tx: postgres.TransactionSql, id: string): Promise<number> {
  const rows = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM payment_event
    WHERE id = ${id}::bigint AND apply_result IS NULL AND processed_at IS NULL
  `;
  return rows[0]?.count ?? 0;
}

describe("保留分の再適用（check_104）", () => {
  it("ゲートが開いていれば未適用の受信を台帳へ適用する", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "ap-open");
      const eventId = await insertHeldEvent(tx, scenario.externalRef, 3000);

      const result = await runApplyPending(tx, {
        appEnv: "production",
        requestId: "req-ap-open",
        applyGate: () => Promise.resolve(null),
      });

      expect(result.applied).toBeGreaterThanOrEqual(1);
      expect(await pendingCount(tx, eventId)).toBe(0);

      const [invoice] = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice?.settlement_status).toBe("paid");

      const ledger = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe(1);
    });
  });

  it("ゲートが閉じたままなら適用せず、保留のまま残す", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "ap-held");
      const eventId = await insertHeldEvent(tx, scenario.externalRef, 3000);

      const result = await runApplyPending(tx, {
        appEnv: "production",
        requestId: "req-ap-held",
        applyGate: () => Promise.resolve("PAYMENTS_ENABLED"),
      });

      expect(result.stillHeld).toBeGreaterThanOrEqual(1);
      expect(result.applied).toBe(0);
      expect(await pendingCount(tx, eventId)).toBe(1);

      const [invoice] = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice?.settlement_status).toBe("unpaid");
    });
  });

  it("2 回走らせても台帳は 1 回しか動かない", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "ap-twice");
      await insertHeldEvent(tx, scenario.externalRef, 3000);

      const options = {
        appEnv: "production",
        requestId: "req-ap-twice",
        applyGate: () => Promise.resolve(null),
      };
      await runApplyPending(tx, options);
      const second = await runApplyPending(tx, options);

      expect(second.picked).toBe(0);
      const ledger = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe(1);
    });
  });
});
