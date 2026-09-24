/**
 * 契約テスト C2 — Webhook の順序逆転（check_018 / 制約 W3・W4）。
 *
 * 事業者はイベントを生成順に配達することを保証しない。`succeeded` のあとに
 * `expired` が届いても:
 *   - `invoice` は `paid` のまま（ランクは前進のみ。`WHERE settlement_rank < $new`）
 *   - `payment_attempt` は `expired` にならない（`succeeded` で `is_open` が閉じるため）
 * を固定する。順序の判定に `occurred_at` を使わない（W4）ことも、逆順でも結果が
 * 変わらないという形で押さえている。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createAppRwSql,
  createMigratorSql,
  ensureAppRwLoginPassword,
  withRollback,
} from "../integration/setup";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("not available in contract tests");
  },
}));

const { handleWebhookRequest } = await import(
  "@/app/api/webhooks/[providerKey]/[bindingRef]/route"
);
const {
  buildSignedRequest,
  insertFixtureScenario,
  loadFixtureBody,
  makeContractContext,
  FIXTURE_PROVIDER_KEY,
} = await import("./helpers/fixture-provider");

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

describe("C2 Webhook 順序逆転", () => {
  it("succeeded → expired の順で届いても invoice は paid、attempt は expired にならない", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "reorder1");
      const ctx = await makeContractContext(tx);

      const succeeded = loadFixtureBody("succeeded", { externalRef: scenario.externalRef });
      const first = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(succeeded, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-reorder1-a",
      );
      expect(first.status).toBe(200);

      const expired = loadFixtureBody("expired", { externalRef: scenario.externalRef });
      const second = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(expired, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-reorder1-b",
      );
      expect(second.status).toBe(200);

      const invoice = await tx<
        { settlement_status: string; settlement_rank: number; paid_at: Date | null }[]
      >`
        SELECT settlement_status, settlement_rank, paid_at FROM invoice
        WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("paid");
      expect(invoice[0]?.settlement_rank).toBe(40);
      expect(invoice[0]?.paid_at).not.toBeNull();

      const attempt = await tx<{ status: string; is_open: boolean }[]>`
        SELECT status, is_open FROM payment_attempt WHERE id = ${scenario.attemptId}
      `;
      expect(attempt[0]?.status).toBe("succeeded");
      expect(attempt[0]?.is_open).toBe(false);

      // 後発の expired は「試行にだけ記録」する種別なので台帳を増やさない。
      const ledger = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe("1");
    });
  });

  it("expired → succeeded の順（正順）でも最終状態は同じ paid になる", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "reorder2");
      const ctx = await makeContractContext(tx);

      const expired = loadFixtureBody("expired", { externalRef: scenario.externalRef });
      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(expired, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-reorder2-a",
      );

      const afterExpired = await tx<{ settlement_status: string; status: string }[]>`
        SELECT i.settlement_status, a.status
        FROM invoice i JOIN payment_attempt a ON a.invoice_id = i.id
        WHERE i.id = ${scenario.invoiceId}
      `;
      // expired は請求のランクを下げない（unpaid のまま）。試行だけが閉じる。
      expect(afterExpired[0]?.settlement_status).toBe("unpaid");
      expect(afterExpired[0]?.status).toBe("expired");

      const succeeded = loadFixtureBody("succeeded", { externalRef: scenario.externalRef });
      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(succeeded, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-reorder2-b",
      );
      expect(response.status).toBe(200);

      const invoice = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("paid");
    });
  });
});
