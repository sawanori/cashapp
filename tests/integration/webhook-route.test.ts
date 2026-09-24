/**
 * `POST /api/webhooks/:providerKey/:bindingRef` の統合テスト（実 Postgres・ロール `app_rw`）。
 *
 * check_095（入口防御）:
 *   - `APP_ENV=staging` は 404（DB に触れない）
 *   - 許可外 IP は 403 で **DB に 1 行も残さない**
 *   - `external_ref` の書式違反は 400
 *   - ゲート未通過は受信・保存し**適用保留**（`apply_result IS NULL AND processed_at IS NULL`）
 *
 * check_023 / check_021 / check_096 の DB 側:
 *   - 金額不一致 → `ledger_entry` に `adjustment` 1 件・ランク不変・`needs_attention`・
 *     `outbox` に `mismatch_alert`
 *   - 取消済みへの入金 → `paid` へ前進しつつ `void` 維持・`needs_attention`・`paid_after_void`
 *   - 紛争 → `charged_back` へ前進し `chargeback` の debit。`raw_redacted` は許可キーのみ
 *
 * さらに `scripts/audit-verify.mjs` が `src/lib/audit.ts` の写しとしてずれていないことを、
 * 実際に書かれた `audit_log` 行のハッシュ再計算で検査する。
 *
 * 隔離: すべて `withRollback` の中。`ledger_entry` / `audit_log` は追記専用で DELETE できない。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { computeRowHash, verifyChain } from "../../scripts/audit-verify.mjs";

import {
  createAppRwSql,
  createMigratorSql,
  ensureAppRwLoginPassword,
  withRollback,
} from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("not available in integration tests");
  },
}));

const { handleWebhookRequest } = await import(
  "@/app/api/webhooks/[providerKey]/[bindingRef]/route"
);
const { appendAuditLog } = await import("@/lib/audit");
const { RAW_REDACTED_ALLOWED_KEYS } = await import("@/lib/db/repositories/events-log");
const {
  buildSignedRequest,
  insertFixtureScenario,
  loadFixtureBody,
  makeContractContext,
  CONTRACT_BLOCKED_IP,
  FIXTURE_PROVIDER_KEY,
} = await import("../contract/helpers/fixture-provider");

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

async function countWebhookDeliveries(tx: postgres.TransactionSql): Promise<number> {
  const rows = await tx<{ count: string }[]>`
    SELECT count(*)::text AS count FROM webhook_delivery WHERE provider_key = ${FIXTURE_PROVIDER_KEY}
  `;
  return Number(rows[0]?.count ?? "0");
}

describe("Webhook ルートの入口防御（check_095）", () => {
  it("非 production は 404 で、DB に 1 行も残さない", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "wh-env");
      const ctx = await makeContractContext(tx, { appEnv: "staging" });
      const raw = loadFixtureBody("succeeded", { externalRef: scenario.externalRef });

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(raw, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-wh-env",
      );

      expect(response.status).toBe(404);
      expect(await countWebhookDeliveries(tx)).toBe(0);
    });
  });

  it("許可外 IP は 403 で、DB に 1 行も残さない", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "wh-ip");
      const ctx = await makeContractContext(tx);
      const raw = loadFixtureBody("succeeded", { externalRef: scenario.externalRef });

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(raw, {
          bindingRef: scenario.bindingId,
          ip: CONTRACT_BLOCKED_IP,
        }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-wh-ip",
      );

      expect(response.status).toBe(403);
      expect(await countWebhookDeliveries(tx)).toBe(0);
      const events = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM payment_event
        WHERE external_ref = ${scenario.externalRef}
      `;
      expect(events[0]?.count).toBe("0");
    });
  });

  it("external_ref の書式違反は 400（台帳にも請求にも触れない）", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "wh-ref");
      const ctx = await makeContractContext(tx);
      const raw = loadFixtureBody("succeeded", { externalRef: "bad ref!" });

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(raw, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-wh-ref",
      );

      expect(response.status).toBe(400);
      const ledger = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe("0");
      // 受信の事実は残す（署名は通っているので sig_ok=true・http_status=400）。
      const delivery = await tx<{ sig_ok: boolean; http_status: number }[]>`
        SELECT sig_ok, http_status FROM webhook_delivery WHERE provider_key = ${FIXTURE_PROVIDER_KEY}
      `;
      expect(delivery[0]?.sig_ok).toBe(true);
      expect(delivery[0]?.http_status).toBe(400);
    });
  });

  it("ゲート未通過は受信・保存し、適用を保留する（apply_result / processed_at が NULL）", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "wh-gate");
      const ctx = await makeContractContext(tx, { holdReason: "PAYMENTS_ENABLED" });
      const raw = loadFixtureBody("succeeded", { externalRef: scenario.externalRef });

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(raw, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-wh-gate",
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { held: number; holdReason: string | null };
      expect(body.held).toBe(1);
      expect(body.holdReason).toBe("PAYMENTS_ENABLED");

      const events = await tx<{ apply_result: string | null; processed_at: Date | null }[]>`
        SELECT apply_result, processed_at FROM payment_event
        WHERE external_ref = ${scenario.externalRef}
      `;
      expect(events).toHaveLength(1);
      expect(events[0]?.apply_result).toBeNull();
      expect(events[0]?.processed_at).toBeNull();

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
});

describe("台帳適用の DB 側（check_023 / check_021 / check_096）", () => {
  it("金額不一致は adjustment 1 件・rank 不変・needs_attention・mismatch_alert", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "wh-mismatch");
      const ctx = await makeContractContext(tx);
      const raw = loadFixtureBody("amount-mismatch", { externalRef: scenario.externalRef });

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(raw, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-wh-mismatch",
      );
      expect(response.status).toBe(200);

      const ledger = await tx<{ kind: string; amount_minor: number; direction: string }[]>`
        SELECT kind, amount_minor, direction FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.kind).toBe("adjustment");
      expect(ledger[0]?.amount_minor).toBe(2500);

      const invoice = await tx<
        { settlement_status: string; settlement_rank: number; needs_attention: boolean }[]
      >`
        SELECT settlement_status, settlement_rank, needs_attention FROM invoice
        WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("unpaid");
      expect(invoice[0]?.settlement_rank).toBe(0);
      expect(invoice[0]?.needs_attention).toBe(true);

      const outbox = await tx<{ kind: string }[]>`
        SELECT kind FROM outbox WHERE payload->>'invoiceId' = ${scenario.invoiceId}
      `;
      expect(outbox.map((r) => r.kind)).toContain("mismatch_alert");

      const events = await tx<{ apply_result: string | null }[]>`
        SELECT apply_result FROM payment_event WHERE external_ref = ${scenario.externalRef}
      `;
      expect(events[0]?.apply_result).toBe("mismatch");
    });
  });

  it("取消済みへの入金は前進しつつ void 維持・needs_attention・paid_after_void", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "wh-void", { voidInvoice: true });
      const ctx = await makeContractContext(tx);
      const raw = loadFixtureBody("succeeded", { externalRef: scenario.externalRef });

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(raw, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-wh-void",
      );
      expect(response.status).toBe(200);

      const invoice = await tx<
        { settlement_status: string; lifecycle_state: string; needs_attention: boolean }[]
      >`
        SELECT settlement_status, lifecycle_state, needs_attention FROM invoice
        WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("paid");
      expect(invoice[0]?.lifecycle_state).toBe("void");
      expect(invoice[0]?.needs_attention).toBe(true);

      const outbox = await tx<{ kind: string }[]>`
        SELECT kind FROM outbox WHERE payload->>'invoiceId' = ${scenario.invoiceId}
      `;
      expect(outbox.map((r) => r.kind)).toContain("paid_after_void");
    });
  });

  it("紛争は charged_back へ前進し chargeback の debit を積む。raw_redacted は許可キーのみ", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "wh-dispute");
      const ctx = await makeContractContext(tx);

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-wh-dispute-a",
      );
      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("disputed", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-wh-dispute-b",
      );
      expect(response.status).toBe(200);

      const invoice = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("charged_back");

      const ledger = await tx<{ kind: string; direction: string }[]>`
        SELECT kind, direction FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
        ORDER BY created_at ASC
      `;
      expect(ledger.map((r) => r.kind)).toEqual(["payment", "chargeback"]);
      expect(ledger[1]?.direction).toBe("debit");

      const events = await tx<{ raw_redacted: Record<string, unknown> }[]>`
        SELECT raw_redacted FROM payment_event WHERE external_ref = ${scenario.externalRef}
      `;
      for (const row of events) {
        for (const key of Object.keys(row.raw_redacted)) {
          expect(RAW_REDACTED_ALLOWED_KEYS).toContain(key);
        }
      }
    });
  });

  it("試行に紐づかないイベントは orphan として記録され、台帳を汚さない", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "wh-orphan", { withoutAttempt: true });
      const ctx = await makeContractContext(tx);
      const raw = loadFixtureBody("succeeded", { externalRef: scenario.externalRef });

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(raw, { bindingRef: scenario.bindingId }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-wh-orphan",
      );
      expect(response.status).toBe(200);

      const events = await tx<{ apply_result: string | null }[]>`
        SELECT apply_result FROM payment_event WHERE external_ref = ${scenario.externalRef}
      `;
      expect(events[0]?.apply_result).toBe("orphan");

      const outbox = await tx<{ kind: string }[]>`
        SELECT kind FROM outbox WHERE payload->>'externalRef' = ${scenario.externalRef}
      `;
      expect(outbox.map((r) => r.kind)).toContain("orphan_alert");

      const ledger = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe("0");
    });
  });
});

describe("audit:verify の写しが src/lib/audit.ts とずれていない", () => {
  it("appendAuditLog が書いた行を scripts/audit-verify.mjs の computeRowHash で再計算すると一致する", async () => {
    await withRollback(appRw, async (tx) => {
      const requestId = "req-audit-drift";
      for (let i = 0; i < 3; i += 1) {
        await appendAuditLog(tx, {
          actorType: "webhook",
          action: "ledger.apply",
          targetType: "invoice",
          targetId: `drift-${String(i)}`,
          beforeRank: 0,
          afterRank: 40,
          amountMinor: 3000,
          providerKey: FIXTURE_PROVIDER_KEY,
          externalRef: "iv_drift_1",
          requestId,
          detail: { kind: "succeeded", applyResult: "applied", nested: { b: 1, a: 2 } },
        });
      }

      const rows = await tx<
        {
          id: string;
          occurred_at: Date;
          actor_type: string;
          actor_ref: Buffer | null;
          action: string;
          target_type: string;
          target_id: string;
          before_rank: number | null;
          after_rank: number | null;
          amount_minor: number | null;
          provider_key: string | null;
          external_ref: string | null;
          request_id: string;
          source_ip_hash: Buffer | null;
          detail: Record<string, unknown>;
          prev_hash: Buffer | null;
          row_hash: Buffer;
        }[]
      >`
        SELECT id, occurred_at, actor_type, actor_ref, action, target_type, target_id,
               before_rank, after_rank, amount_minor, provider_key, external_ref,
               request_id, source_ip_hash, detail, prev_hash, row_hash
        FROM audit_log WHERE request_id = ${requestId} ORDER BY id ASC
      `;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        const recomputed = computeRowHash({
          prevHash: row.prev_hash,
          occurredAt: row.occurred_at,
          actorType: row.actor_type,
          actorRef: row.actor_ref,
          action: row.action,
          targetType: row.target_type,
          targetId: row.target_id,
          beforeRank: row.before_rank,
          afterRank: row.after_rank,
          amountMinor: row.amount_minor,
          providerKey: row.provider_key,
          externalRef: row.external_ref,
          requestId: row.request_id,
          sourceIpHash: row.source_ip_hash,
          detail: row.detail,
        });
        expect(Buffer.from(recomputed).toString("hex")).toBe(
          Buffer.from(row.row_hash).toString("hex"),
        );
      }
    });
  });

  it("連鎖が壊れた行を verifyChain が検出する（ok:true が空振りでないことの証明）", () => {
    const base = {
      actor_type: "system",
      actor_ref: null,
      action: "test.action",
      target_type: "invoice",
      target_id: "t1",
      before_rank: null,
      after_rank: null,
      amount_minor: null,
      provider_key: null,
      external_ref: null,
      request_id: "req-chain",
      source_ip_hash: null,
      detail: {},
    };
    const occurredAt = new Date("2026-09-24T00:00:00.000Z");
    const hashOf = (prevHash: Buffer | null, targetId: string): Buffer =>
      computeRowHash({
        prevHash,
        occurredAt,
        actorType: base.actor_type,
        actorRef: null,
        action: base.action,
        targetType: base.target_type,
        targetId,
        beforeRank: null,
        afterRank: null,
        amountMinor: null,
        providerKey: null,
        externalRef: null,
        requestId: base.request_id,
        sourceIpHash: null,
        detail: {},
      });
    const row1Hash = hashOf(null, base.target_id);
    const row1 = { id: "1", occurred_at: occurredAt, ...base, prev_hash: null, row_hash: row1Hash };
    const row2Hash = hashOf(row1Hash, "t2");
    const row2 = {
      id: "2",
      occurred_at: occurredAt,
      ...base,
      target_id: "t2",
      prev_hash: row1Hash,
      row_hash: row2Hash,
    };

    expect(verifyChain([row1, row2]).ok).toBe(true);
    // 1 行の内容だけを書き換える（row_hash は据え置き）→ 再計算が食い違う。
    expect(verifyChain([row1, { ...row2, target_id: "tampered" }]).ok).toBe(false);
    // prev_hash を切る → 連鎖が途切れる。
    expect(verifyChain([row1, { ...row2, prev_hash: null }]).ok).toBe(false);

    // ★ 塊をまたぐ検証（CLI は id のカーソルで 10000 行ずつ読む）。直前の塊の
    //   row_hash を渡すので、境界にある改変も検出できる（上限で打ち切らない）。
    const first = verifyChain([row1]);
    expect(first.ok).toBe(true);
    expect(first.lastId).toBe("1");
    expect(verifyChain([row2], first.lastRowHash).ok).toBe(true);
    expect(verifyChain([{ ...row2, target_id: "tampered" }], first.lastRowHash).ok).toBe(false);
    // 前の塊を渡し忘れた形（prev=null）なら境界で必ず不一致になる。
    expect(verifyChain([row2], null).ok).toBe(false);
  });
});
