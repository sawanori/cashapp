/**
 * 契約テスト C1 — Webhook の重複配信（check_017 / 制約 W1・W2）。
 *
 * 「同一本文を 3 回 POST → `ledger_entry` 1 件、HTTP は 3 回とも 200」を固定する。
 * 二重計上防止は 2 段あり、両方を別々に検査する:
 *   1 段目（W1）: `payment_event (provider_key, provider_event_id)` の一意制約。
 *                 同じ本文は 2 回目以降そもそも `payment_event` の行を作らない。
 *   2 段目（W2）: `ledger_entry (invoice_id, dedupe_key)` の一意制約。
 *                 事業者が**別のイベント ID で同じ事実**を送ってきても台帳は増えず、
 *                 その行の `apply_result` が `duplicate` になる。
 *
 * 隔離: すべて `withRollback` の中。`ledger_entry` / `audit_log` は追記専用で DELETE
 * できないため、コミットさせない（ロールバックだけが唯一の後始末である）。
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

describe("C1 Webhook 重複配信", () => {
  it("同一本文を 3 回 POST しても台帳は 1 件、HTTP は 3 回とも 200", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "dup1");
      const ctx = await makeContractContext(tx);
      const raw = loadFixtureBody("succeeded", { externalRef: scenario.externalRef });

      const statuses: number[] = [];
      const bodies: { received: number; applied: number; duplicates: number }[] = [];
      for (let i = 0; i < 3; i += 1) {
        const request = await buildSignedRequest(raw, { bindingRef: scenario.bindingId });
        const response = await handleWebhookRequest(
          ctx,
          request,
          { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
          `req-dup1-${String(i)}`,
        );
        statuses.push(response.status);
        bodies.push(
          (await response.json()) as { received: number; applied: number; duplicates: number },
        );
      }

      expect(statuses).toEqual([200, 200, 200]);
      expect(bodies[0]?.applied).toBe(1);
      expect(bodies[1]?.duplicates).toBe(1);
      expect(bodies[2]?.duplicates).toBe(1);

      const ledger = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe("1");

      // W1: 2 回目以降は payment_event の行そのものが作られない。
      const events = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM payment_event
        WHERE external_ref = ${scenario.externalRef}
      `;
      expect(events[0]?.count).toBe("1");

      const invoice = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("paid");

      // 受信ログは 3 件（重複でも「届いた事実」は残す）。
      const deliveries = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM webhook_delivery
        WHERE provider_key = ${FIXTURE_PROVIDER_KEY} AND sig_ok AND http_status = 200
      `;
      expect(Number(deliveries[0]?.count ?? "0")).toBeGreaterThanOrEqual(3);
    });
  });

  it("別のイベント ID で同じ事実が届いても台帳は増えず apply_result=duplicate になる（W2）", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "dup2");
      const ctx = await makeContractContext(tx);

      // W1 をすり抜けさせるため provider_event_id だけを変え、台帳の dedupe_key は
      // 固定する（事業者が同じ事実を別イベント ID で 2 回送ってくる状況）。
      const dedupeKey = `fixture_provider:succeeded:dup2-shared`;
      const first = loadFixtureBody("succeeded", {
        externalRef: scenario.externalRef,
        eventId: "evt_dup2_a",
        ledgerDedupeKey: dedupeKey,
      });
      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(first, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-dup2-a",
      );

      const second = loadFixtureBody("succeeded", {
        externalRef: scenario.externalRef,
        eventId: "evt_dup2_b",
        ledgerDedupeKey: dedupeKey,
      });
      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(second, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-dup2-b",
      );
      expect(response.status).toBe(200);

      const ledger = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe("1");

      const results = await tx<{ provider_event_id: string; apply_result: string | null }[]>`
        SELECT provider_event_id, apply_result FROM payment_event
        WHERE external_ref = ${scenario.externalRef} ORDER BY id ASC
      `;
      expect(results.map((r) => r.apply_result)).toEqual(["applied", "duplicate"]);
    });
  });
});
