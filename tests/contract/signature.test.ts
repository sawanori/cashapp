/**
 * 契約テスト C3 — Webhook の署名不一致（check_019 / 制約 P2・W6・W12）。
 *
 *   - 本文を 1 バイト改竄すると 400 `SIGNATURE_INVALID`
 *   - `webhook_delivery` に `sig_ok=false` の行が残る（届いた事実は消さない）
 *   - `payment_event` / `ledger_entry` は 1 行も増えない
 *   - **旧シークレットで署名された本文は通る**（ローテーション中の併存。W12）
 *
 * 署名は**生本文**に対して計算されている。ルートは `request.text()` の生文字列を
 * そのままアダプタへ渡し、検証を通るまで本文を構造化しない（P2）。
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
  CONTRACT_SECRET_PREVIOUS,
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

describe("C3 Webhook 署名不一致", () => {
  it("本文を 1 バイト改竄すると 400 SIGNATURE_INVALID・sig_ok=false・行は増えない", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "sig1");
      const ctx = await makeContractContext(tx);

      const raw = loadFixtureBody("tampered", { externalRef: scenario.externalRef });
      // 署名は改竄前の本文に対して計算し、送る本文だけを 1 バイト書き換える。
      const tampered = `${raw.slice(0, raw.length - 2)}X}`;
      expect(tampered.length).toBe(raw.length);
      expect(tampered).not.toBe(raw);

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(raw, {
          bindingRef: scenario.bindingId,
          bodyOverride: tampered,
        }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-sig1",
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string; requestId: string };
      expect(body.code).toBe("SIGNATURE_INVALID");
      expect(body.requestId).toBe("req-sig1");

      const delivery = await tx<{ sig_ok: boolean; http_status: number; ip_allowed: boolean }[]>`
        SELECT sig_ok, http_status, ip_allowed FROM webhook_delivery
        WHERE provider_key = ${FIXTURE_PROVIDER_KEY} AND NOT sig_ok
      `;
      expect(delivery.length).toBeGreaterThanOrEqual(1);
      expect(delivery[0]?.http_status).toBe(400);
      expect(delivery[0]?.ip_allowed).toBe(true);

      const events = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM payment_event
        WHERE external_ref = ${scenario.externalRef}
      `;
      expect(events[0]?.count).toBe("0");

      const ledger = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe("0");

      const invoice = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("unpaid");
    });
  });

  it("旧シークレットで署名された本文も通る（W12: ローテーション中の併存）", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "sig2");
      const ctx = await makeContractContext(tx);

      const raw = loadFixtureBody("succeeded", { externalRef: scenario.externalRef });
      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(raw, {
          bindingRef: scenario.bindingId,
          secret: CONTRACT_SECRET_PREVIOUS,
        }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-sig2",
      );

      expect(response.status).toBe(200);
      const invoice = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("paid");
    });
  });

  it("どのシークレットとも一致しない署名は 400（シークレット 0 本でも同じ）", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "sig3");
      const ctx = await makeContractContext(tx, { secrets: [] });

      const raw = loadFixtureBody("succeeded", { externalRef: scenario.externalRef });
      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(raw, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-sig3",
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("SIGNATURE_INVALID");
    });
  });
});
