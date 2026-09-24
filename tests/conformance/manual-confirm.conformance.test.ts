/**
 * ProviderConformanceKit — `manual_confirm` 適合テスト（`docs/implementation-plan.md` §14-4）。
 *
 * done_definition: 「manual_confirm は該当ケース pass・他は n/a 記録」。
 *
 * task_018（台帳適用・冪等基盤・Webhook ルート・fixture_provider 契約テストヘルパー）は
 * 7833726 で完了済み。ただし `manual_confirm` は `capabilities.webhook === false`
 * （自己申告のみで Webhook を一切持たない）ため、DB / Webhook ルートを要するケース
 * （C1〜C8・C11・C13〜C22・C24〜C26・C28・C31 ほか）は task_018 の完了有無にかかわらず
 * 構造的に n/a のままである。これらは `tests/conformance/fixture-provider.conformance.test.ts`
 * （task_019 が task_018 完了後に作成）側で実行する。
 * `manual_confirm` 自身の能力宣言（`refund: 'none'` 等・§7-6 guard 0 でゲートを一切見ない）で
 * 構造的に n/a になるケースも同様に記録する。
 *
 * このファイルで実際に pass するのは:
 *   - C9（能力宣言の遵守）
 *   - C10（非自動ラベル）
 *   - C12（ゲート未通過。`manual_confirm` 自身はゲートを一切見ない設計なので、ゲート経路を
 *     汎用的に確認するための最小フェイク自動アダプタを使う。同じ設計判断は
 *     `tests/unit/payments/registry.test.ts` の `autoProvider()` にも既にある）
 *
 * さらに、キットの登録ルールそのもの（done_definition の第2項）を検査する:
 *   - `captured_from` 欠落の fixture で `registerProvider` が拒否すること
 *   - `synthesized` のみの fixture で `autoDetect: true` の登録を拒否すること
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// `src/lib/payments/registry.ts` が `src/lib/db/repositories/gates.ts`（`import "server-only"`）
// を経由するため（GC-SERVER-ONLY / tests/unit/payments/registry.test.ts と同じ理由）。
vi.mock("server-only", () => ({}));

import { CANONICAL_GATES } from "@/lib/payments/gates";
import {
  MANUAL_CONFIRM_CAPABILITIES,
  manualConfirmProvider,
  buildReceivingLink,
  type ReceivingLinkTemplate,
} from "@/lib/payments/providers/manual-confirm";
import { yen } from "@/lib/payments/money";
import {
  PRODUCTION_APP_ENV,
  REGISTRY,
  resolveProvider,
  type GateEnvironment,
  type RegistryEntry,
} from "@/lib/payments/registry";
import {
  NotSupportedError,
  ProviderNotEnabledError,
  type CreateCheckoutCommand,
  type PaymentProvider,
  type ProviderBinding,
} from "@/lib/payments/types";

import {
  buildReport,
  registerProvider,
  ConformanceRegistrationError,
  type ConformanceCaseId,
  type ConformanceCaseResult,
} from "./kit";
import { FixtureProvenanceError } from "./provenance";

// ============================================================================
// 実行済みケース id の収集（レポートの pass 主張と実行実態を一致させる）
// ============================================================================

/**
 * `describe()` の見出し（"C9: ..." 等）から、実際に走った `it()` の親ケース id を拾う。
 * `buildReport` に渡すと、`MANUAL_CONFIRM_RESULTS` が `pass` と記録したのに対応する `it()` が
 * このファイルに無いケースを検出できる（`tests/conformance/kit.ts` の `assertCatalogComplete`）。
 */
const executedCaseIds = new Set<ConformanceCaseId>();
afterEach((context) => {
  for (const m of context.task.fullName.match(/C\d+b?/g) ?? []) {
    executedCaseIds.add(m as ConformanceCaseId);
  }
});

// ============================================================================
// テスト用フィクスチャ
// ============================================================================

function binding(overrides: Partial<ProviderBinding> = {}): ProviderBinding {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organizerUserId: "22222222-2222-4222-8222-222222222222",
    providerKey: "manual_confirm",
    status: "active",
    credentialRef: null,
    credentialFp: null,
    receivingIdentifier: "organizer-handle",
    receivingIdentifierKind: "merchant_id",
    ...overrides,
  };
}

function command(overrides: Partial<CreateCheckoutCommand> = {}): CreateCheckoutCommand {
  return {
    invoiceId: "33333333-3333-4333-8333-333333333333",
    externalRef: "iv_33333333333343338333333333333333_1",
    money: yen(3000),
    description: "会費",
    returnUrl: "https://liff.line.me/1234567890-abcdefgh/e/return?invoice=x",
    expiresAt: null,
    timeoutMs: 3000,
    ...overrides,
  };
}

// ============================================================================
// 登録（fixture provenance のキット側ルール）
// ============================================================================

describe("registerProvider: fixture provenance", () => {
  it("manual_confirm を fixture 0件で登録できる（webhook を持たないアダプタなので捕獲対象が無い）", () => {
    const entry = registerProvider("manual_confirm", manualConfirmProvider, []);
    expect(entry.fixtures).toEqual([]);
  });

  it("captured_from が欠落した fixture は登録を拒否する（done_definition）", () => {
    expect(() =>
      registerProvider("manual_confirm", manualConfirmProvider, [
        { label: "missing-provenance", captured_at: "2026-09-24" },
      ]),
    ).toThrow(FixtureProvenanceError);
  });

  it("captured_from が許可値以外の fixture は登録を拒否する", () => {
    expect(() =>
      registerProvider("manual_confirm", manualConfirmProvider, [
        { label: "bad-value", captured_from: "hand_wavy_guess", captured_at: "2026-09-24" },
      ]),
    ).toThrow(FixtureProvenanceError);
  });

  it("captured_at が欠落・不正書式の fixture は登録を拒否する", () => {
    expect(() =>
      registerProvider("manual_confirm", manualConfirmProvider, [
        { label: "missing-date", captured_from: "staging" },
      ]),
    ).toThrow(FixtureProvenanceError);
    expect(() =>
      registerProvider("manual_confirm", manualConfirmProvider, [
        { label: "bad-date", captured_from: "staging", captured_at: "2026/09/24" },
      ]),
    ).toThrow(FixtureProvenanceError);
  });

  it("synthesized のみの fixture で autoDetect=true のアダプタを登録できない（scope の中核ルール）", () => {
    const autoDetectProvider: PaymentProvider = {
      ...manualConfirmProvider,
      capabilities: { ...MANUAL_CONFIRM_CAPABILITIES, autoDetect: true },
    };
    expect(() =>
      registerProvider("hypothetical_auto", autoDetectProvider, [
        { label: "synthesized-only", captured_from: "synthesized", captured_at: "2026-09-24" },
      ]),
    ).toThrow(ConformanceRegistrationError);
  });

  it("captured の fixture が1件でもあれば autoDetect=true のアダプタを登録できる", () => {
    const autoDetectProvider: PaymentProvider = {
      ...manualConfirmProvider,
      capabilities: { ...MANUAL_CONFIRM_CAPABILITIES, autoDetect: true },
    };
    const entry = registerProvider("hypothetical_auto", autoDetectProvider, [
      { label: "synthesized", captured_from: "synthesized", captured_at: "2026-09-24" },
      { label: "staging-capture", captured_from: "staging", captured_at: "2026-09-20" },
    ]);
    expect(entry.fixtures).toHaveLength(2);
  });
});

// ============================================================================
// C9: 能力宣言の遵守
// ============================================================================

describe("C9: 能力宣言の遵守（capabilities.refund='none' → NotSupportedError）", () => {
  it("refund は NotSupportedError（manual_confirm は resolve/reject と無関係に常に非対応）", async () => {
    expect(manualConfirmProvider.capabilities.refund).toBe("none");
    await expect(
      manualConfirmProvider.refund(binding(), "iv_x_1"),
    ).rejects.toBeInstanceOf(NotSupportedError);
  });
});

// ============================================================================
// C10: 非自動ラベル
// ============================================================================

describe("C10: 非自動ラベル（autoDetect=false のアダプタの案内が非自動を示す）", () => {
  it("createCheckout の ticket は kind='manual' で instruction.automatic=false", async () => {
    expect(manualConfirmProvider.capabilities.autoDetect).toBe(false);
    const ticket = await manualConfirmProvider.createCheckout(binding(), command());
    expect(ticket.kind).toBe("manual");
    if (ticket.kind !== "manual") throw new Error("unreachable");
    expect(ticket.instruction.automatic).toBe(false);
  });
});

// ============================================================================
// C12: ゲート未通過（manual_confirm 自身は対象外なので汎用フェイクで経路を確認）
// ============================================================================

/**
 * ゲート経路を汎用的に確認するための最小フェイク。`manual_confirm` はゲートを一切見ない
 * （`registry.ts` guard 0）ため、C12 をこのアダプタ自身で再現することはできない。
 * 実アダプタではなく、キットの登録・実行経路を検証するための test double である
 * （`tests/unit/payments/registry.test.ts` の `autoProvider()` と同じ設計判断）。
 */
function gateProbeProvider(): PaymentProvider {
  return {
    key: "conformance_gate_probe",
    capabilities: { ...MANUAL_CONFIRM_CAPABILITIES, autoDetect: true, webhook: true },
    createCheckout: () => Promise.reject(new NotSupportedError("gate probe: no real checkout")),
    parseWebhook: () => Promise.resolve([]),
    getPaymentStatus: () => Promise.reject(new NotSupportedError("gate probe")),
    refund: () => Promise.reject(new NotSupportedError("gate probe")),
    cancelCheckout: () => Promise.resolve(),
  };
}

describe("C12: ゲート未通過で ProviderNotEnabledError（→ 409。汎用アダプタで経路確認）", () => {
  it("必須ゲートが1件でも未通過なら resolveProvider が ProviderNotEnabledError", async () => {
    const probe = gateProbeProvider();
    // キット登録では captured fixture を要求する（autoDetect=true のため。staging capture を1件登録）。
    const entryWithCapture = registerProvider("conformance_gate_probe", probe, [
      { label: "gate-probe-capture", captured_from: "staging", captured_at: "2026-09-24" },
    ]);

    const registry: Readonly<Record<string, RegistryEntry>> = {
      ...REGISTRY,
      [entryWithCapture.key]: { provider: entryWithCapture.provider, fixtureProvenance: "captured" },
    };
    const env: GateEnvironment = {
      appEnv: PRODUCTION_APP_ENV,
      isPaymentsEnabled: () => Promise.resolve(true),
      providerMode: () => Promise.resolve("on"),
      // 全ゲートを未通過（unknown）にする。
      complianceGates: () =>
        Promise.resolve(
          CANONICAL_GATES.map((g) => ({
            gateKey: g.gateKey,
            status: "unknown" as const,
            validUntil: null,
          })),
        ),
      isOrganizerSuspended: () => Promise.resolve(false),
    };
    const probeBinding: ProviderBinding = {
      id: "44444444-4444-4444-8444-444444444444",
      organizerUserId: "22222222-2222-4222-8222-222222222222",
      providerKey: entryWithCapture.key,
      status: "active",
      credentialRef: null,
      credentialFp: null,
      receivingIdentifier: null,
      receivingIdentifierKind: null,
    };

    await expect(
      resolveProvider(entryWithCapture.key, {
        env,
        organizerUserId: probeBinding.organizerUserId,
        binding: probeBinding,
        minorsIncluded: false,
        registry,
      }),
    ).rejects.toBeInstanceOf(ProviderNotEnabledError);
  });
});

// ============================================================================
// C27: 許可外ホストの deepLink が拒否される（manual_confirm 固有の deepLink 生成を直接検査）
// ============================================================================

describe("C27: 許可外ホストの deepLink が拒否される", () => {
  it("テンプレートが ALLOWED_DEEPLINK_HOSTS 外のホストを返すと buildReceivingLink は null", () => {
    const rogue: ReceivingLinkTemplate = {
      channel: "paypay_p2p",
      host: "evil.example.com",
      identifierPattern: /^[A-Za-z0-9_-]{1,64}$/,
      build: (identifier) => `https://evil.example.com/${identifier}`,
      verified: true,
      sourceRef: "conformance test double（許可外ホストの固定値）",
    };
    expect(buildReceivingLink("paypay_p2p", "organizer-handle", [rogue])).toBeNull();
  });

  it("https 以外のスキームで組み立てるテンプレートも拒否される", () => {
    const insecure: ReceivingLinkTemplate = {
      channel: "paypay_p2p",
      host: "qr.paypay.ne.jp",
      identifierPattern: /^[A-Za-z0-9_-]{1,64}$/,
      build: (identifier) => `http://qr.paypay.ne.jp/${identifier}`,
      verified: true,
      sourceRef: "conformance test double（http 固定値）",
    };
    expect(buildReceivingLink("paypay_p2p", "organizer-handle", [insecure])).toBeNull();
  });
});

// ============================================================================
// レポート: 32 ケース全件（pass / n/a）を明示記録する
// ============================================================================

const NOT_YET_LEDGER =
  "capabilities.webhook === false（manual_confirm は自己申告のみで Webhook を一切持たない）のため" +
  "台帳適用（applyToLedger）を通す経路が無い。同じケースは fixture_provider 側で検査する" +
  "（tests/conformance/fixture-provider.conformance.test.ts。task_018 は 7833726 で完了済み）";
const NOT_YET_WEBHOOK_ROUTE =
  "capabilities.webhook === false のため Webhook ルートに届くイベントが無い（NO_WEBHOOK と同義）";
const NOT_YET_ROUTE_INFRA =
  "checkout API ルート側の attempt 一意性実装（DB 制約＋ルートハンドラ）に依存し、アダプタ単体では検証できない";
const REFUND_NOT_SUPPORTED = "capabilities.refund === 'none' のため対象外";
const DISPUTE_NOT_SUPPORTED = "capabilities.dispute === 'none' のため対象外";
const NO_WEBHOOK = "capabilities.webhook === false のため届く Webhook が無い";
const NO_EXTERNAL_API_CALL = "外部 API 呼び出しを行わないアダプタのため対象外（決済を作らない）";

const MANUAL_CONFIRM_RESULTS: readonly ConformanceCaseResult[] = [
  { id: "C1", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C2", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C3", status: "n/a", reason: NOT_YET_WEBHOOK_ROUTE },
  { id: "C4", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C4b", status: "n/a", reason: `${REFUND_NOT_SUPPORTED}／${NOT_YET_LEDGER}` },
  { id: "C5", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C6", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C7", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C8", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C9", status: "pass" },
  { id: "C10", status: "pass" },
  { id: "C11", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C12", status: "pass" },
  { id: "C13", status: "n/a", reason: NOT_YET_WEBHOOK_ROUTE },
  { id: "C14", status: "n/a", reason: NO_WEBHOOK },
  { id: "C15", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C16", status: "n/a", reason: `${DISPUTE_NOT_SUPPORTED}／${NOT_YET_LEDGER}` },
  { id: "C17", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C18", status: "n/a", reason: `${REFUND_NOT_SUPPORTED}／${NOT_YET_LEDGER}` },
  { id: "C19", status: "n/a", reason: `${REFUND_NOT_SUPPORTED}／${NOT_YET_LEDGER}` },
  { id: "C20", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C21", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C22", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C23", status: "n/a", reason: NOT_YET_ROUTE_INFRA },
  { id: "C24", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C25", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C26", status: "n/a", reason: NOT_YET_LEDGER },
  { id: "C27", status: "pass" },
  { id: "C28", status: "n/a", reason: NOT_YET_WEBHOOK_ROUTE },
  { id: "C29", status: "n/a", reason: REFUND_NOT_SUPPORTED },
  { id: "C30", status: "n/a", reason: NO_EXTERNAL_API_CALL },
  { id: "C31", status: "n/a", reason: NOT_YET_LEDGER },
];

describe("レポート: 32 ケース全件を pass / n/a で明示記録する", () => {
  it("C9・C10・C12・C27 が pass、他は capabilities / task_018 依存を理由に n/a", () => {
    const entry = registerProvider("manual_confirm", manualConfirmProvider, []);
    const report = buildReport(entry, MANUAL_CONFIRM_RESULTS, executedCaseIds);

    expect(report.providerKey).toBe("manual_confirm");
    expect(report.fixtureProvenance.total).toBe(0);

    const passed = report.results.filter((r) => r.status === "pass").map((r) => r.id);
    expect(passed.sort()).toEqual(["C10", "C12", "C27", "C9"]);

    const naWithoutReason = report.results.filter(
      (r) => r.status === "n/a" && (r.reason === undefined || r.reason.trim() === ""),
    );
    expect(naWithoutReason).toEqual([]);

    // 32 ケース全件（C1〜C31 + C4b）が記録されている。
    expect(report.results).toHaveLength(32);
  });

  it("capabilities ベースの n/a 理由は実際の capabilities と矛盾しない（追随漏れの回帰検知）", () => {
    // MANUAL_CONFIRM_CAPABILITIES を変更したのに上の理由表を更新し忘れると、ここが落ちる。
    const byId = new Map(MANUAL_CONFIRM_RESULTS.map((r) => [r.id, r]));

    for (const id of ["C4b", "C18", "C19", "C29"] as const) {
      expect(byId.get(id)?.reason).toContain(REFUND_NOT_SUPPORTED);
    }
    expect(MANUAL_CONFIRM_CAPABILITIES.refund).toBe("none");

    expect(byId.get("C16")?.reason).toContain(DISPUTE_NOT_SUPPORTED);
    expect(MANUAL_CONFIRM_CAPABILITIES.dispute).toBe("none");

    expect(byId.get("C14")?.reason).toBe(NO_WEBHOOK);
    expect(MANUAL_CONFIRM_CAPABILITIES.webhook).toBe(false);
  });
});
