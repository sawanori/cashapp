/**
 * ProviderConformanceKit — `fixture_provider` 適合テスト（`docs/implementation-plan.md` §14-4）。
 *
 * task_018（台帳適用・冪等基盤・Webhook ルート・fixture_provider 契約テストヘルパー）が
 * 7833726 で完了したのを受け、task_019 が「BLOCKED」から再着手して作成した。
 * `docs/concerns/task_019.md` §1（G5 round1）で「task_018 完了後に作成する」と約束していた
 * 2 本のうちの 1 本（もう 1 本は 4 fixture JSON）。
 *
 * `fixture_provider` は `tests/contract/helpers/fixture-provider.ts`（task_018 所有・
 * **変更しない**）が定義する**テスト専用**アダプタで、`src/lib/payments/registry.ts` の
 * `REGISTRY` には登録されない。`capabilities.autoDetect === true` を名乗るが、fixture は
 * すべて `captured_from: "synthesized"`（実在事業者の応答を1件も捕獲していない）ため、
 * `registerProvider()` に**そのまま**渡すと G12（`tests/conformance/provenance.ts`）が
 * 正しく登録を拒否する（下の「登録」節で検査する）。レポート作成のためだけに
 * `ConformanceEntry` を手組みし、実際の Webhook ルート経由の DB 検査は各ケースの `describe`
 * ブロックで行う。
 *
 * pass / n/a の内訳は最終節の `FIXTURE_PROVIDER_RESULTS` を参照。n/a はすべて
 * `fixture_provider` の能力宣言（`createCheckout` / `refund` / `statusQuery` 非対応）か、
 * Phase 1 の設計上の制約（W3 のランク前進のみ）、または `src/lib/ledger/apply.ts`
 * （task_018 所有・**変更しない**）に無い分岐（参加者削除・イベント中止の特別扱い）を理由とし、
 * `docs/concerns/task_019.md` に対応予定込みで記録する。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("not available in conformance tests");
  },
}));

const { handleWebhookRequest } = await import(
  "@/app/api/webhooks/[providerKey]/[bindingRef]/route"
);
const {
  buildSignedRequest,
  insertFixtureScenario,
  loadFixtureBody: loadFixtureBodyTyped,
  makeContractContext,
  fixtureProvider,
  FIXTURE_PROVIDER_KEY,
  CONTRACT_BLOCKED_IP,
} = await import("../contract/helpers/fixture-provider");
const { applyToLedger } = await import("@/lib/ledger/apply");
const { insertPaymentEvent, redactRawPayload } = await import("@/lib/db/repositories/events-log");
const { businessIdemKey } = await import("@/lib/ledger/dedupe");
const { SETTLEMENT_STATUSES } = await import("@/lib/ledger/rank");
const { NotSupportedError } = await import("@/lib/payments/types");
const { yen } = await import("@/lib/payments/money");
const { runApplyPending } = await import("@/app/api/cron/apply-pending/route");

/**
 * `tests/contract/helpers/fixture-provider.ts`（task_018 所有・変更しない）の `FixtureName` は
 * `succeeded` / `expired` / `tampered` / `amount-mismatch` / `disputed` の 5 値しか許さない。
 * task_019 が追加した 4 本（`orphan` / `underpaid` / `refund-partial-1` / `refund-partial-2`）は
 * 実行時には同じ `loadFixtureBody` でそのまま読める（ファイル名で読むだけの実装のため）ので、
 * 呼び出し側の型だけをここで緩める。
 */
type FixtureOverrides = Parameters<typeof loadFixtureBodyTyped>[1];
function loadFixtureBody(name: string, overrides: FixtureOverrides = {}): string {
  return (loadFixtureBodyTyped as unknown as (n: string, o?: FixtureOverrides) => string)(
    name,
    overrides,
  );
}

import {
  createAppRwSql,
  createMigratorSql,
  ensureAppRwLoginPassword,
  withRollback,
} from "../integration/setup";

import {
  buildReport,
  ConformanceRegistrationError,
  registerProvider,
  type ConformanceCaseId,
  type ConformanceCaseResult,
  type ConformanceEntry,
} from "./kit";
import {
  assertFixtureProvenance,
  FixtureProvenanceError,
  type FixtureProvenanceMeta,
} from "./provenance";

import type { ProviderBinding } from "@/lib/payments/types";

// ============================================================================
// 実行済みケース id の収集（レポートの pass 主張と実行実態を一致させる。
// tests/conformance/manual-confirm.conformance.test.ts と同じ仕組み）
// ============================================================================

const executedCaseIds = new Set<ConformanceCaseId>();
afterEach((context) => {
  for (const m of context.task.fullName.match(/C\d+b?/g) ?? []) {
    executedCaseIds.add(m as ConformanceCaseId);
  }
});

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

// ============================================================================
// fixture の provenance（登録可否と、レポートに載せる出自メタ）
// ============================================================================

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  FIXTURE_PROVIDER_KEY,
);

/** `fixture_provider` が持つ全 fixture（task_018 の 5 本 + task_019 の 4 本）。 */
const ALL_FIXTURE_LABELS = [
  "succeeded",
  "expired",
  "tampered",
  "amount-mismatch",
  "disputed",
  "orphan",
  "underpaid",
  "refund-partial-1",
  "refund-partial-2",
] as const;

/**
 * task_018 が作った 5 本は `captured_from: "synthesized"` は書いてあるが `captured_at` を
 * 持たない（`provenance.ts` は task_019 の G5 round1 — task_018 のコミットより後 — で導入した
 * ため、task_018 はこのスキーマを知らずに書いた）。task_019 の 4 本は両方を書く。
 * 他タスクの fixture JSON は変更しないので、ここでは実際に通る／通らないをそのまま検査する
 * （`docs/concerns/task_019.md` に記録）。
 */
const TASK_018_FIXTURE_LABELS = [
  "succeeded",
  "expired",
  "tampered",
  "amount-mismatch",
  "disputed",
] as const;
const TASK_019_FIXTURE_LABELS = [
  "orphan",
  "underpaid",
  "refund-partial-1",
  "refund-partial-2",
] as const;

function readRawFixtureFile(label: string): Record<string, unknown> {
  const raw = readFileSync(path.join(FIXTURE_DIR, `${label}.json`), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function rawConformanceFixtureOf(label: string): {
  readonly label: string;
  readonly captured_from?: unknown;
  readonly captured_at?: unknown;
  readonly source_ref?: unknown;
} {
  const parsed = readRawFixtureFile(label);
  return {
    label,
    captured_from: parsed["captured_from"],
    captured_at: parsed["captured_at"],
  };
}

describe("登録: fixture_provider は autoDetect=true だが全 fixture が synthesized のため G12 が拒否する", () => {
  it("registerProvider(fixture_provider, ...) は task_019 の4本だけでも ConformanceRegistrationError を投げる", () => {
    expect(fixtureProvider.capabilities.autoDetect).toBe(true);
    const rawFixtures = TASK_019_FIXTURE_LABELS.map((label) => rawConformanceFixtureOf(label));
    expect(rawFixtures.every((f) => f.captured_from === "synthesized")).toBe(true);
    expect(() => registerProvider(FIXTURE_PROVIDER_KEY, fixtureProvider, rawFixtures)).toThrow(
      ConformanceRegistrationError,
    );
  });

  it("task_019 が追加した4本は captured_from / captured_at の provenance 検査を通る", () => {
    for (const label of TASK_019_FIXTURE_LABELS) {
      const meta = assertFixtureProvenance(rawConformanceFixtureOf(label), label);
      expect(meta.capturedFrom).toBe("synthesized");
      expect(meta.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("既知のギャップ: task_018 が作った5本は captured_at を持たず provenance 検査を通らない", () => {
    // task_018 のコミット（7833726）は task_019 の provenance.ts（9421d14 で captured_at を
    // 必須化）より後だが、task_018 は「captured_from: synthesized」しか書いていない。
    // 変更は task_018 の files_to_create に属するため行わない（docs/concerns/task_019.md）。
    for (const label of TASK_018_FIXTURE_LABELS) {
      const raw = rawConformanceFixtureOf(label);
      expect(raw.captured_from).toBe("synthesized");
      expect(raw.captured_at).toBeUndefined();
      expect(() => assertFixtureProvenance(raw, label)).toThrow(FixtureProvenanceError);
    }
  });
});

/**
 * レポート専用のエントリ。`registerProvider()` は（正しく）拒否するので、
 * `buildReport()` に渡す `ConformanceEntry` はここで手組みする
 * （`fixture_provider` を `REGISTRY` に登録するわけではないので G12 の対象外）。
 * `fixtures` には provenance 検査を実際に通る task_019 の 4 本だけを積む
 * （task_018 の 5 本は上のテストが示すとおり `captured_at` を欠くため積めない）。
 */
const FIXTURE_PROVENANCE: readonly FixtureProvenanceMeta[] = TASK_019_FIXTURE_LABELS.map((label) =>
  assertFixtureProvenance(rawConformanceFixtureOf(label), label),
);
const FIXTURE_ENTRY: ConformanceEntry = {
  key: FIXTURE_PROVIDER_KEY,
  provider: fixtureProvider,
  fixtures: FIXTURE_PROVENANCE,
};

// ============================================================================
// テスト用ヘルパ
// ============================================================================

function fixtureBinding(overrides: Partial<ProviderBinding> = {}): ProviderBinding {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    organizerUserId: "66666666-6666-4666-8666-666666666666",
    providerKey: FIXTURE_PROVIDER_KEY,
    status: "active",
    credentialRef: null,
    credentialFp: null,
    receivingIdentifier: "organizer-handle",
    receivingIdentifierKind: "merchant_id",
    ...overrides,
  };
}

/**
 * fixture ファイルを介さず、その場で組み立てた本文を送る（`loadFixtureBody` の
 * `FixtureOverrides` は `kind` / `type` を差し替えられないため、C17 の到達性検査に必要な
 * `authorized` / `refund_pending` を送るにはこの経路が要る）。
 */
function inlineEventBody(input: {
  readonly eventId: string;
  readonly type: string;
  readonly kind: string;
  readonly externalRef: string;
  readonly amountMinor: number | null;
}): string {
  return JSON.stringify({
    event_id: `${input.eventId}:${input.externalRef}`,
    type: input.type,
    kind: input.kind,
    external_ref: input.externalRef,
    amount_minor: input.amountMinor,
    currency: "JPY",
    occurred_at: "2026-09-25T00:00:00.000Z",
  });
}

// ============================================================================
// C1 重複配信
// ============================================================================

describe("C1: 重複配信3回で台帳が1件だけ", () => {
  it("同一本文を3回 POST しても ledger_entry は1件、HTTP は3回とも200", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c1");
      const ctx = await makeContractContext(tx);
      const raw = loadFixtureBody("succeeded", { externalRef: scenario.externalRef });

      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const response = await handleWebhookRequest(
          ctx,
          await buildSignedRequest(raw, { bindingRef: scenario.bindingId }),
          { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
          `req-c1-${String(i)}`,
        );
        statuses.push(response.status);
      }
      expect(statuses).toEqual([200, 200, 200]);

      const ledger = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe("1");
    });
  });
});

// ============================================================================
// C2 順序逆転
// ============================================================================

describe("C2: 順序逆転（succeeded→expired）でも paid が維持される", () => {
  it("succeeded のあとに expired が届いても invoice は paid のまま", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c2");
      const ctx = await makeContractContext(tx);

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c2-a",
      );
      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("expired", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c2-b",
      );

      const invoice = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("paid");
    });
  });
});

// ============================================================================
// C3 署名不一致
// ============================================================================

describe("C3: 署名不一致で400・sig_ok=false", () => {
  it("本文を1バイト改竄すると400、payment_eventは0件", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c3");
      const ctx = await makeContractContext(tx);
      const raw = loadFixtureBody("tampered", { externalRef: scenario.externalRef });
      const tampered = `${raw.slice(0, raw.length - 2)}X}`;

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(raw, { bindingRef: scenario.bindingId, bodyOverride: tampered }),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c3",
      );
      expect(response.status).toBe(400);

      const delivery = await tx<{ sig_ok: boolean }[]>`
        SELECT sig_ok FROM webhook_delivery WHERE provider_key = ${FIXTURE_PROVIDER_KEY}
      `;
      expect(delivery[0]?.sig_ok).toBe(false);

      const events = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM payment_event WHERE external_ref = ${scenario.externalRef}
      `;
      expect(events[0]?.count).toBe("0");
    });
  });
});

// ============================================================================
// C4 別 providerEventId の重複
// ============================================================================

describe("C4: 別 providerEventId の重複でも台帳1件（ledgerDedupeKey 一致）", () => {
  it("イベントIDが違っても ledgerDedupeKey が同じなら台帳は増えない", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c4");
      const ctx = await makeContractContext(tx);
      const dedupeKey = "fixture_provider:succeeded:c4-shared";

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", {
            externalRef: scenario.externalRef,
            eventId: "evt_c4_a",
            ledgerDedupeKey: dedupeKey,
          }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c4-a",
      );
      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", {
            externalRef: scenario.externalRef,
            eventId: "evt_c4_b",
            ledgerDedupeKey: dedupeKey,
          }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c4-b",
      );

      const ledger = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe("1");
    });
  });
});

// ============================================================================
// C4b 正当な2回目の部分返金
// ============================================================================

describe("C4b: 正当な2回目の部分返金が2件目として台帳に載る", () => {
  it("refund-partial-1 に続く refund-partial-2 が落とされず ledger_entry に残る", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c4b");
      const ctx = await makeContractContext(tx);

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c4b-pay",
      );
      const r1 = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("refund-partial-1", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c4b-r1",
      );
      const r2 = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("refund-partial-2", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c4b-r2",
      );
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // 部分返金（金額 > 0・attempt の全額未満）は正当な返金として kind='refund' の debit で
      // 台帳へ計上される（apply.ts の isPartialRefund 分岐）。2 回とも別 dedupe_key なので
      // どちらも捨てられず、payment 1 件 + refund 2 件 = 3 件になる。
      const ledger = await tx<{ kind: string; amount_minor: number }[]>`
        SELECT kind, amount_minor FROM ledger_entry
        WHERE invoice_id = ${scenario.invoiceId} ORDER BY created_at ASC
      `;
      expect(ledger).toHaveLength(3);
      expect(ledger.map((r) => r.kind)).toEqual(["payment", "refund", "refund"]);
      expect(ledger.slice(1).map((r) => r.amount_minor)).toEqual([1000, 500]);
    });
  });
});

// ============================================================================
// C5 金額不一致
// ============================================================================

describe("C5: 金額不一致で adjustment 1件・rank不変・needs_attention", () => {
  it("amount-mismatch は adjustment 1件を残し rank を動かさない", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c5");
      const ctx = await makeContractContext(tx);

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("amount-mismatch", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c5",
      );

      const ledger = await tx<{ kind: string }[]>`
        SELECT kind FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.kind).toBe("adjustment");

      const invoice = await tx<{ settlement_status: string; needs_attention: boolean }[]>`
        SELECT settlement_status, needs_attention FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("unpaid");
      expect(invoice[0]?.needs_attention).toBe(true);

      const outbox = await tx<{ kind: string }[]>`
        SELECT kind FROM outbox WHERE payload->>'invoiceId' = ${scenario.invoiceId}
      `;
      expect(outbox.map((r) => r.kind)).toContain("mismatch_alert");
    });
  });
});

// ============================================================================
// C6 孤児イベント
// ============================================================================

describe("C6: 未知のexternalRef（孤児イベント）で200を返しつつ台帳を汚さない", () => {
  it("試行が無い external_ref への succeeded は orphan として記録され台帳は0件", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c6", { withoutAttempt: true });
      const ctx = await makeContractContext(tx);

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("orphan", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c6",
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

// ============================================================================
// C9 能力宣言の遵守
// ============================================================================

describe("C9: capabilities.refund='none' の遵守（返金は常に NotSupportedError）", () => {
  it("refund は常に NotSupportedError（C9: 能力宣言の遵守）", async () => {
    expect(fixtureProvider.capabilities.refund).toBe("none");
    await expect(
      fixtureProvider.refund(fixtureBinding(), "iv_x_1"),
    ).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("capabilities.refundWindowDays も null（期限という概念自体が無い。C29 が n/a である根拠）", async () => {
    // C29「返金可能期間を過ぎた返金が NotSupportedError になる」は期限内外の分岐を要求するが、
    // fixture_provider の refund は capabilities.refund='none' で常に無条件拒否のため、
    // 「期限を過ぎた」を模した呼び出し（invoiceId を変えるだけ）をしても同じ例外にしかならず、
    // 期限判定そのものを検査したことにはならない（レビュー指摘: 以前はこれを C29 の pass 証跡と
    // 誤って記録していた）。期限という概念自体が存在しないことを capabilities で固定し、
    // C29 は n/a として記録する（FIXTURE_PROVIDER_RESULTS 参照）。
    expect(fixtureProvider.capabilities.refundWindowDays).toBeNull();
    await expect(
      fixtureProvider.refund(fixtureBinding(), "iv_x_1_very_old_charge"),
    ).rejects.toBeInstanceOf(NotSupportedError);
  });
});

// ============================================================================
// C11 取消後入金
// ============================================================================

describe("C11: 取消（void）後の入金でpaidへ前進・void維持・needs_attention", () => {
  it("void済み請求への succeeded は paid へ前進しつつ void を維持する", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c11", { voidInvoice: true });
      const ctx = await makeContractContext(tx);

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c11",
      );

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
});

// ============================================================================
// C13 2 binding 同時決済
// ============================================================================

describe("C13: 2 binding 同時決済でそれぞれ正しい binding に適用される", () => {
  it("2 つの binding への succeeded がそれぞれ自分の invoice にだけ、自分の credential_fp で適用される", async () => {
    // fixture_provider の parseWebhook は binding を読まない（テスト専用アダプタのため）ので、
    // ここで検査できるのは (1) binding 解決が取り違えられないこと（ルーティングの正しさ）と
    // (2) 各 binding に紐づく credential_fp が別のリクエストの試行に紛れ込まないこと、の 2 点。
    // credential_fp を実際に読んで事業者 API 呼び出しに使う経路（本番アダプタ）そのものは
    // binding.credentialFp の型（必須フィールド。R-PAY-01・npm run typecheck）で担保する。
    await withRollback(appRw, async (tx) => {
      const a = await insertFixtureScenario(tx, "c13a");
      const b = await insertFixtureScenario(tx, "c13b");
      // insertFixtureScenario（task_018 所有）は credential_fp を書かないため、
      // binding ごとに異なる値をここで明示的に与える（check_097「credential_fp が
      // リクエストごとに異なる」）。DB の CHECK 制約（16 桁 16 進）に合わせる。
      const fpA = "a".repeat(16);
      const fpB = "b".repeat(16);
      await tx`UPDATE provider_binding SET credential_fp = ${fpA} WHERE id = ${a.bindingId}`;
      await tx`UPDATE provider_binding SET credential_fp = ${fpB} WHERE id = ${b.bindingId}`;
      const ctx = await makeContractContext(tx);

      const [ra, rb] = await Promise.all([
        handleWebhookRequest(
          ctx,
          await buildSignedRequest(loadFixtureBody("succeeded", { externalRef: a.externalRef }), {
            bindingRef: a.bindingId,
          }),
          { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: a.bindingId },
          "req-c13-a",
        ),
        handleWebhookRequest(
          ctx,
          await buildSignedRequest(loadFixtureBody("succeeded", { externalRef: b.externalRef }), {
            bindingRef: b.bindingId,
          }),
          { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: b.bindingId },
          "req-c13-b",
        ),
      ]);
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);

      const invoices = await tx<{ id: string; settlement_status: string }[]>`
        SELECT id, settlement_status FROM invoice WHERE id IN (${a.invoiceId}, ${b.invoiceId})
      `;
      expect(invoices.every((r) => r.settlement_status === "paid")).toBe(true);

      const ledgerA = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${a.invoiceId}
      `;
      const ledgerB = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${b.invoiceId}
      `;
      expect(ledgerA[0]?.count).toBe("1");
      expect(ledgerB[0]?.count).toBe("1");

      // 各請求の試行が自分の binding（＝自分の credential_fp）に紐づいたまま
      // 入れ替わっていないこと。
      const attempts = await tx<{ invoice_id: string; provider_binding_id: string }[]>`
        SELECT invoice_id, provider_binding_id FROM payment_attempt
        WHERE invoice_id IN (${a.invoiceId}, ${b.invoiceId})
      `;
      const bindingOf = new Map(attempts.map((r) => [r.invoice_id, r.provider_binding_id]));
      expect(bindingOf.get(a.invoiceId)).toBe(a.bindingId);
      expect(bindingOf.get(b.invoiceId)).toBe(b.bindingId);

      const bindings = await tx<{ id: string; credential_fp: string | null }[]>`
        SELECT id, credential_fp FROM provider_binding WHERE id IN (${a.bindingId}, ${b.bindingId})
      `;
      const fpOf = new Map(bindings.map((r) => [r.id, r.credential_fp]));
      expect(fpOf.get(a.bindingId)).toBe(fpA);
      expect(fpOf.get(b.bindingId)).toBe(fpB);
      expect(fpOf.get(a.bindingId)).not.toBe(fpOf.get(b.bindingId));
    });
  });
});

// ============================================================================
// C14 ゲート off でも既存 external_ref の succeeded が保存される
// ============================================================================

describe("C14: ゲートoffでも既存external_refのsucceededが保存される", () => {
  it("holdReason があるとき保存だけされ適用は保留、ゲート復帰後は apply-pending で台帳へ載る", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c14");
      const ctx = await makeContractContext(tx, { holdReason: "PAYMENTS_ENABLED" });

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c14",
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { held: number };
      expect(body.held).toBe(1);

      const held = await tx<{ apply_result: string | null; processed_at: Date | null }[]>`
        SELECT apply_result, processed_at FROM payment_event WHERE external_ref = ${scenario.externalRef}
      `;
      expect(held[0]?.apply_result).toBeNull();
      expect(held[0]?.processed_at).toBeNull();

      // MODE=off → MODE=live: ゲートが開いた後の `/api/cron/apply-pending` 相当
      // （`runApplyPending`。task_020 所有・変更しない）を呼び直すと保留分が台帳へ載る
      // （done_definition「off 中に保存され、復帰後に台帳へ載る」）。
      const resumeResult = await runApplyPending(tx, {
        appEnv: "production",
        requestId: "req-c14-resume",
        applyGate: () => Promise.resolve(null), // ゲートが開いた状態を模す
      });
      expect(resumeResult.applied).toBeGreaterThanOrEqual(1);

      const resumed = await tx<{ apply_result: string | null }[]>`
        SELECT apply_result FROM payment_event WHERE external_ref = ${scenario.externalRef}
      `;
      expect(resumed[0]?.apply_result).toBe("applied");

      const invoice = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("paid");
      const ledger = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe("1");
    });
  });
});

// ============================================================================
// C15 expired 確定後に届いた succeeded
// ============================================================================

describe("C15: expired確定後に届いたsucceededが台帳に載る", () => {
  it("expired → succeeded の順（正順）でも最終的に paid になり台帳1件", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c15");
      const ctx = await makeContractContext(tx);

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("expired", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c15-a",
      );
      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c15-b",
      );

      const invoice = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("paid");
      const ledger = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledger[0]?.count).toBe("1");
    });
  });
});

// ============================================================================
// C16/C17 紛争到達性 / 全 settlement_status 到達性
// ============================================================================

describe("C16: 紛争fixtureでsettlement_statusがcharged_backへ前進する", () => {
  it("succeeded のあとの disputed で charged_back に前進し chargeback の debit が積まれる", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c16");
      const ctx = await makeContractContext(tx);

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c16-a",
      );
      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("disputed", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c16-b",
      );

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
    });
  });
});

describe("C17: 全settlement_status値が少なくとも1つのイベント種別から到達可能", () => {
  it("unpaid→authorized→paid→refund_pending→refundedの経路で全ランクへ前進する", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c17");
      const ctx = await makeContractContext(tx);
      const reached: string[] = [];

      const statusOf = async (): Promise<string> => {
        const rows = await tx<{ settlement_status: string }[]>`
          SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
        `;
        const status = rows[0]?.settlement_status;
        if (status === undefined) throw new Error("invoice not found");
        return status;
      };
      reached.push(await statusOf()); // unpaid（初期値）

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          inlineEventBody({
            eventId: "evt_c17_authorized",
            type: "payment.authorized",
            kind: "authorized",
            externalRef: scenario.externalRef,
            amountMinor: null,
          }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c17-authorized",
      );
      reached.push(await statusOf());

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c17-succeeded",
      );
      reached.push(await statusOf());

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          inlineEventBody({
            eventId: "evt_c17_refund_pending",
            type: "payment.refund_pending",
            kind: "refund_pending",
            externalRef: scenario.externalRef,
            amountMinor: null,
          }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c17-refund-pending",
      );
      reached.push(await statusOf());

      // 全額一致の返金（attempt の amount_minor と同額）は amountMatches を通り、
      // 本来の refund 経路（ledgerKind='refund'）で refunded（rank 70）へ前進する。
      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          inlineEventBody({
            eventId: "evt_c17_refunded_full",
            type: "payment.refunded",
            kind: "refunded",
            externalRef: scenario.externalRef,
            amountMinor: 3000,
          }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c17-refunded",
      );
      reached.push(await statusOf());

      expect(reached).toEqual(["unpaid", "authorized", "paid", "refund_pending", "refunded"]);

      // charged_back は C16 で別途 succeeded→disputed の経路により到達済み。
      const allReached = new Set([...reached, "charged_back"]);
      expect([...allReached].sort()).toEqual([...SETTLEMENT_STATUSES].sort());
    });
  });
});

// ============================================================================
// C18 部分返金後の残高
// ============================================================================

describe("C18: 部分返金後に残高が正しくsettlement_statusがrefundedにならない", () => {
  it("部分返金（1000円、全額3000円未満）を受けても settlement_status は paid のまま、残高は正しく減る", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c18");
      const ctx = await makeContractContext(tx);

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c18-pay",
      );
      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("refund-partial-1", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c18-refund",
      );

      const invoice = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      // 部分返金は残高を 0 まで減らしきらない限り settlement_status を前進させない
      // （apply.ts: `if (kind === 'refunded' && balanceAfter > 0) target = null`）。
      expect(invoice[0]?.settlement_status).toBe("paid");

      // 台帳の残高は正しく減る: 支払 3000（credit）− 部分返金 1000（debit・kind='refund'）。
      // `adjustment` を除外しても refund は残るので、残高は 3000 のまま固定されはしない。
      const balance = await tx<{ credit: string; debit: string }[]>`
        SELECT
          coalesce(sum(amount_minor) FILTER (WHERE direction = 'credit' AND kind <> 'adjustment'), 0)::text AS credit,
          coalesce(sum(amount_minor) FILTER (WHERE direction = 'debit' AND kind <> 'adjustment'), 0)::text AS debit
        FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(Number(balance[0]?.credit)).toBe(3000);
      expect(Number(balance[0]?.debit)).toBe(1000);
    });
  });
});

// ============================================================================
// C20 少額支払い
// ============================================================================

describe("C20: 提示額より少額の支払いでpaidにならない", () => {
  it("underpaid（100円）は adjustment 扱いで rank・statusが動かない", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c20");
      const ctx = await makeContractContext(tx);

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("underpaid", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c20",
      );

      const invoice = await tx<{ settlement_status: string; settlement_rank: number }[]>`
        SELECT settlement_status, settlement_rank FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("unpaid");
      expect(invoice[0]?.settlement_rank).toBe(0);
    });
  });
});

// ============================================================================
// C24 手動確認済み請求への自動入金（過払い検知）
// ============================================================================

describe("C24: 手動確認済み請求に自動入金が届いても手動確認バッジが消えない（過払い検知）", () => {
  it("organizer_attested の手動記録があるとき自動 succeeded は overpay になり confirmation_method は自動へ切り替わらない", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c24");
      const ctx = await makeContractContext(tx);

      // 幹事が既に手動確認済み、という前提を直接作る（manual_confirm の実フローは
      // task_015/017 の担当で、ここでは applyToLedger が読む状態だけを用意する）。
      await tx`
        INSERT INTO ledger_entry (invoice_id, event_id, direction, kind, amount_minor,
                                  confidence, dedupe_key, recorded_by)
        VALUES (${scenario.invoiceId}, ${scenario.eventId}, 'credit', 'payment', 3000,
                'organizer_attested', ${`manual-attest:${scenario.invoiceId}`},
                'organizer:conformance-test')
      `;
      await tx`
        UPDATE invoice
        SET settlement_status = 'paid', confirmation_method = 'manual_by_organizer', paid_at = now()
        WHERE id = ${scenario.invoiceId}
      `;

      await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c24",
      );

      const invoice = await tx<
        { confirmation_method: string; needs_attention: boolean }[]
      >`
        SELECT confirmation_method, needs_attention FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.confirmation_method).toBe("manual_by_organizer");
      expect(invoice[0]?.needs_attention).toBe(true);

      const ledger = await tx<{ kind: string }[]>`
        SELECT kind FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId} ORDER BY created_at ASC
      `;
      expect(ledger.map((r) => r.kind)).toEqual(["payment", "overpay"]);

      const outbox = await tx<{ kind: string }[]>`
        SELECT kind FROM outbox WHERE payload->>'invoiceId' = ${scenario.invoiceId}
      `;
      expect(outbox.map((r) => r.kind)).toContain("overpay_alert");
    });
  });
});

// ============================================================================
// C26 保存後・適用前のクラッシュからの回収
// ============================================================================

describe("C26: 保存後・適用前にクラッシュしても再送/cronで最終的に台帳へ載る", () => {
  it("insertPaymentEvent だけ行い applyToLedger を呼ばずに終える（クラッシュを模す）→ 後から同じ event id で applyToLedger を呼ぶと台帳に載る", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c26");

      const providerEventId = "evt_c26_crash_sim";
      const externalRef = scenario.externalRef;
      const amountMinor = 3000;
      const rawEvent = {
        providerKey: FIXTURE_PROVIDER_KEY,
        providerEventId,
        eventType: "payment.succeeded",
        kind: "succeeded" as const,
        externalRef,
        businessIdemKey: businessIdemKey({ externalRef, kind: "succeeded" }),
        ledgerDedupeKey: `${FIXTURE_PROVIDER_KEY}:succeeded:${providerEventId}`,
        money: yen(amountMinor),
        occurredAt: new Date("2026-09-25T04:00:00.000Z"),
        trust: "verified" as const,
        raw: null,
      };

      // 「保存はしたが適用前にクラッシュした」状態を直接作る（webhook ルートが
      // 1 トランザクションで両方やるので、ルート経由ではこの中間状態を作れない）。
      const paymentEventId = await insertPaymentEvent(tx, {
        providerKey: rawEvent.providerKey,
        providerEventId,
        eventType: rawEvent.eventType,
        kind: rawEvent.kind,
        externalRef,
        businessIdemKey: rawEvent.businessIdemKey,
        invoiceId: null,
        attemptId: null,
        amountMinor,
        currency: "JPY",
        occurredAt: rawEvent.occurredAt,
        ingestionSource: "webhook",
        trust: rawEvent.trust,
        rawRedacted: redactRawPayload({
          eventType: rawEvent.eventType,
          kind: rawEvent.kind,
          externalRef,
          providerEventId,
          amountMinor,
          currency: "JPY",
          occurredAt: rawEvent.occurredAt,
        }),
      });
      expect(paymentEventId).not.toBeNull();
      if (paymentEventId === null) throw new Error("unreachable");

      const beforeRecovery = await tx<{ apply_result: string | null }[]>`
        SELECT apply_result FROM payment_event WHERE id = ${paymentEventId}::bigint
      `;
      expect(beforeRecovery[0]?.apply_result).toBeNull();
      const ledgerBefore = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledgerBefore[0]?.count).toBe("0");

      // 再送/cron 相当: 同じ payment_event.id で applyToLedger を呼び直す
      // （`/api/cron/apply-pending` が持つべき核となる処理そのもの。専用エンドポイントは
      // task_020 の担当で未実装のため、その中核関数を直接呼んで「最終的に載る」を検査する）。
      const outcome = await applyToLedger(tx, {
        event: rawEvent,
        paymentEventId,
        ingestionSource: "webhook",
        requestId: "req-c26-recovery",
        recordedBy: `webhook:${FIXTURE_PROVIDER_KEY}`,
      });
      expect(outcome.result).toBe("applied");

      const invoice = await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${scenario.invoiceId}
      `;
      expect(invoice[0]?.settlement_status).toBe("paid");
      const ledgerAfter = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ledger_entry WHERE invoice_id = ${scenario.invoiceId}
      `;
      expect(ledgerAfter[0]?.count).toBe("1");
    });
  });
});

// ============================================================================
// C28 許可外 IP
// ============================================================================

describe("C28: 許可外IPからのWebhookがDBに1行も残さず403", () => {
  it("許可外 IP は 403 で webhook_delivery / payment_event が 0 件", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c28");
      const ctx = await makeContractContext(tx);

      const response = await handleWebhookRequest(
        ctx,
        await buildSignedRequest(
          loadFixtureBody("succeeded", { externalRef: scenario.externalRef }),
          { bindingRef: scenario.bindingId, ip: CONTRACT_BLOCKED_IP },
        ),
        { providerKey: FIXTURE_PROVIDER_KEY, bindingRef: scenario.bindingId },
        "req-c28",
      );
      expect(response.status).toBe(403);

      const deliveries = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM webhook_delivery WHERE provider_key = ${FIXTURE_PROVIDER_KEY}
      `;
      expect(deliveries[0]?.count).toBe("0");
      const events = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM payment_event WHERE external_ref = ${scenario.externalRef}
      `;
      expect(events[0]?.count).toBe("0");
    });
  });
});

// ============================================================================
// C31 未知の settlement_status
// ============================================================================

describe("C31: 未知のsettlement_statusを投入するとDBが拒否する", () => {
  it("CHECK 制約外の文字列への UPDATE は例外になる", async () => {
    await withRollback(appRw, async (tx) => {
      const scenario = await insertFixtureScenario(tx, "c31");
      await expect(
        tx`UPDATE invoice SET settlement_status = 'bogus_status' WHERE id = ${scenario.invoiceId}`,
      ).rejects.toThrow();
    });
  });
});

// ============================================================================
// レポート: 32 ケース全件（pass / n/a）を明示記録する
// ============================================================================

const NO_STATUS_QUERY =
  "capabilities.statusQuery === false（getPaymentStatus は NotSupportedError）のため再照会経路が無い";
const NO_AUTO_LABEL_TARGET =
  "capabilities.autoDetect === true のため非自動ラベルの検査対象外（manual_confirm 側で pass 済み）";
const NOT_IN_REGISTRY =
  "fixture_provider は REGISTRY に登録しない（テスト専用アダプタ）ため resolveProvider の経路に" +
  "乗らない。ゲート未通過そのものの検査（resolveProvider が ProviderNotEnabledError を投げる）は" +
  "tests/conformance/manual-confirm.conformance.test.ts の C12（同ファイル内で実行・pass 記録）で" +
  "実施済み。本ファイルの C14 が検査する『ゲート off 中でも Webhook 受信・保存は動く』側の半分は" +
  "fixture_provider 自身で pass している";
const NO_CHECKOUT =
  "fixture_provider は createCheckout 未対応（webhook のみを検査するテスト専用アダプタ。呼ぶと" +
  "常に NotSupportedError）のため、createCheckout を要する契約（金額の同値確認・タイムアウト" +
  "処理・同時要求の一意性）はこのアダプタでは検証できない";
const CONCURRENT_CHECKOUT_COVERED_ELSEWHERE =
  `${NO_CHECKOUT}。同時 checkout で生きた試行が 1 つになること自体（DB の ` +
  "UNIQUE (invoice_id) WHERE is_open 制約 ＋ FOR UPDATE 行ロック）は " +
  "tests/integration/checkout.test.ts の『同一請求へ同時 2 回 checkout（check_093）』で" +
  "実コミットを使って検証済み（task_017 所有ファイル。ConformanceKit の case id とは未結線）";
const CHECKOUT_TIMEOUT_OVERLAPS_C15 =
  `${NO_CHECKOUT}。createCheckout がタイムアウトした後に succeeded が届く、という契機の違いは` +
  "台帳適用の観点では『expired 状態の attempt に succeeded が届く』C15 と区別できない" +
  "（fixture_provider は expired を明示 Webhook でしか作れず、checkout 呼び出し自体のタイムアウトを" +
  "模せない）。C15 が同じ webhook-side の帰結（orphan にならず paid になる）を実際に検査している";
const NO_REAL_ADAPTER_CALLS_EXTERNAL_API =
  "Phase 1 に外部決済 API を実際に呼び出すアダプタが存在しない（manual_confirm は API 呼び出し" +
  "を一切行わず、fixture_provider も createCheckout 未対応の webhook 専用テストダブル）ため、" +
  "『createCheckout の入力金額と事業者 API への送信金額が同値』という契約そのものが Phase 1 では" +
  "検証対象を持たない。実アダプタが載る Phase 2 まで構造的に n/a";
const RANK_FORWARD_ONLY =
  "settlement_rank は前進のみ（W3）。返金（rank 70）後の再入金（succeeded は rank 40）は rank を" +
  "後退させられないため、台帳には反映されても表示（settlement_status）まではPhase 1の設計では" +
  "反映できない。docs/concerns/task_019.md に記録";
const NO_PARTICIPANT_LIFECYCLE_BRANCH =
  "src/lib/ledger/apply.ts（task_018 所有）は participant.status を読まず、削除済み参加者への" +
  "入金を他の succeeded と区別しない。webhook 受信自体は他の succeeded と同様に届き台帳へ" +
  "適用されてしまう（拒否や保留はされない）ため n/a ではなく blocked: apply.ts に" +
  "participant.status を読む分岐を追加する担当タスクが未定（docs/concerns/task_019.md §4）";
const NO_EVENT_LIFECYCLE_BRANCH =
  "src/lib/ledger/apply.ts（task_018 所有）は event.status を読まず、イベント中止後の入金を" +
  "他の succeeded と区別しない。返金タスクの outbox 積み込みも無い（拒否や保留はされない）ため" +
  "n/a ではなく blocked: apply.ts に event.status を読む分岐を追加する担当タスクが未定" +
  "（docs/concerns/task_019.md §4）";

const FIXTURE_PROVIDER_RESULTS: readonly ConformanceCaseResult[] = [
  { id: "C1", status: "pass" },
  { id: "C2", status: "pass" },
  { id: "C3", status: "pass" },
  { id: "C4", status: "pass" },
  { id: "C4b", status: "pass" },
  { id: "C5", status: "pass" },
  { id: "C6", status: "pass" },
  { id: "C7", status: "n/a", reason: NO_STATUS_QUERY },
  { id: "C8", status: "n/a", reason: NO_STATUS_QUERY },
  { id: "C9", status: "pass" },
  { id: "C10", status: "n/a", reason: NO_AUTO_LABEL_TARGET },
  { id: "C11", status: "pass" },
  { id: "C12", status: "n/a", reason: NOT_IN_REGISTRY },
  { id: "C13", status: "pass" },
  { id: "C14", status: "pass" },
  { id: "C15", status: "pass" },
  { id: "C16", status: "pass" },
  { id: "C17", status: "pass" },
  { id: "C18", status: "pass" },
  { id: "C19", status: "n/a", reason: RANK_FORWARD_ONLY },
  { id: "C20", status: "pass" },
  { id: "C21", status: "blocked", reason: NO_PARTICIPANT_LIFECYCLE_BRANCH },
  { id: "C22", status: "blocked", reason: NO_EVENT_LIFECYCLE_BRANCH },
  { id: "C23", status: "n/a", reason: CONCURRENT_CHECKOUT_COVERED_ELSEWHERE },
  { id: "C24", status: "pass" },
  { id: "C25", status: "n/a", reason: CHECKOUT_TIMEOUT_OVERLAPS_C15 },
  { id: "C26", status: "pass" },
  { id: "C27", status: "n/a", reason: NO_CHECKOUT },
  { id: "C28", status: "pass" },
  { id: "C29", status: "n/a", reason: "capabilities.refund === 'none' のため対象外（期限という概念自体が無い。C9 のテストで固定）" },
  { id: "C30", status: "n/a", reason: NO_REAL_ADAPTER_CALLS_EXTERNAL_API },
  { id: "C31", status: "pass" },
];

describe("レポート: fixture_provider の32ケース全件をpass/n/a/blockedで明示記録する", () => {
  it("20 ケースが pass、10 ケースが能力宣言/設計上の理由で n/a、2 ケースが実装ギャップで blocked", () => {
    const report = buildReport(FIXTURE_ENTRY, FIXTURE_PROVIDER_RESULTS, executedCaseIds);

    expect(report.providerKey).toBe(FIXTURE_PROVIDER_KEY);
    expect(report.fixtureProvenance.total).toBe(4);
    expect(report.fixtureProvenance.byCapturedFrom.synthesized).toBe(4);

    const passed = report.results.filter((r) => r.status === "pass").map((r) => r.id);
    expect(passed).toHaveLength(20);

    const naResults = report.results.filter((r) => r.status === "n/a");
    expect(naResults).toHaveLength(10);
    const naWithoutReason = naResults.filter(
      (r) => r.reason === undefined || r.reason.trim() === "",
    );
    expect(naWithoutReason).toEqual([]);

    const blockedResults = report.results.filter((r) => r.status === "blocked");
    expect(blockedResults.map((r) => r.id).sort()).toEqual(["C21", "C22"]);
    const blockedWithoutReason = blockedResults.filter(
      (r) => r.reason === undefined || r.reason.trim() === "",
    );
    expect(blockedWithoutReason).toEqual([]);

    expect(report.results).toHaveLength(32);
  });
});
