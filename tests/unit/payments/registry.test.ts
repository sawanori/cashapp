/**
 * `src/lib/payments/registry.ts` — 実行時キルスイッチの 9 パターン（check_090 / check_022 /
 * check_092 / §7-6）。
 *
 * ★ ゲート・フラグの**射影の値**をここでは `GateEnvironment` のフェイクで与える。
 *   実 DB（`compliance_gate` / `feature_flag` / `app_user`）に対する同じ 9 パターンは
 *   `tests/integration/checkout.test.ts` が `dbGateEnvironment()` 経由で走らせる
 *   （`npm run test:unit` は DB を持たない環境でも走る必要があるため 2 段構えにする）。
 *
 * ★ 正本（`docs/gates/compliance-gates.json`）と `CANONICAL_GATES` の一致もここで検査する。
 *   写しを手で書き換えたら落ちる。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// `src/lib/db/repositories/gates.ts` が `import "server-only"` を持つため（GC-SERVER-ONLY）。
vi.mock("server-only", () => ({}));

import { CANONICAL_GATES, findBlockingGate, requiredGateKeysFor } from "@/lib/payments/gates";
import {
  GATE_REASON,
  PRODUCTION_APP_ENV,
  REGISTRY,
  assertProviderBindingAllowed,
  resolveProvider,
  resolveProviderWithoutGate,
  type GateEnvironment,
  type RegistryEntry,
  type ResolveProviderContext,
} from "@/lib/payments/registry";
import type { ComplianceGateRow } from "@/lib/db/repositories/gates";
import {
  MANUAL_CONFIRM_PROVIDER_KEY,
  NotSupportedError,
  ProviderNotEnabledError,
  type PaymentProvider,
  type ProviderBinding,
} from "@/lib/payments/types";

const AUTO_KEY = "fixture_provider";
const ORGANIZER_ID = "22222222-2222-4222-8222-222222222222";

/** すべての必須ゲート（phase1 ＋ phase2）が通過している射影。 */
function allGatesPassed(): readonly ComplianceGateRow[] {
  return CANONICAL_GATES.map((gate) => ({
    gateKey: gate.gateKey,
    status: "passed" as const,
    validUntil: null,
  }));
}

interface FakeEnvOptions {
  readonly appEnv?: string | undefined;
  readonly paymentsEnabled?: boolean;
  readonly mode?: string | null;
  readonly gates?: readonly ComplianceGateRow[];
  readonly organizerSuspended?: boolean;
}

function fakeEnv(options: FakeEnvOptions = {}): GateEnvironment {
  return {
    appEnv: options.appEnv ?? PRODUCTION_APP_ENV,
    isPaymentsEnabled: () => Promise.resolve(options.paymentsEnabled ?? true),
    // `mode: null`（フラグの行が無い）を「未指定」と区別する。`??` だと null が既定値に
    // 吸われてしまい、F-2 の回帰テストが空振りする。
    providerMode: () => Promise.resolve("mode" in options ? (options.mode ?? null) : "on"),
    complianceGates: () => Promise.resolve(options.gates ?? allGatesPassed()),
    isOrganizerSuspended: () => Promise.resolve(options.organizerSuspended ?? false),
  };
}

function activeBinding(providerKey: string, overrides: Partial<ProviderBinding> = {}): ProviderBinding {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organizerUserId: ORGANIZER_ID,
    providerKey,
    status: "active",
    credentialRef: null,
    credentialFp: null,
    receivingIdentifier: null,
    receivingIdentifierKind: null,
    ...overrides,
  };
}

/**
 * 自動検知を名乗るテスト用アダプタ。Phase 1 のレジストリには自動アダプタが 1 つも無いので、
 * ガードそのものを検査するにはこれを差し込む（`ResolveProviderContext.registry`）。
 */
function autoProvider(): PaymentProvider {
  return {
    key: AUTO_KEY,
    capabilities: {
      autoDetect: true,
      webhook: true,
      webhookSignature: "none",
      statusQuery: true,
      refund: "full_once",
      refundWindowDays: 180,
      dispute: "none",
      disputeResponseWindowDays: null,
      checkoutIdempotent: true,
      credentialCustody: "server",
      settlementQuery: true,
      feeModel: { kind: "undetermined", note: "手数料は未定です。", rateBp: null, fixedMinor: null, undetermined: true },
      settlementSchedule: "未定",
      payerIdentity: false,
      settlementLagHint: "未定",
    },
    createCheckout: () => Promise.reject(new NotSupportedError("test double")),
    parseWebhook: () => Promise.resolve([]),
    getPaymentStatus: () => Promise.reject(new NotSupportedError("test double")),
    refund: () => Promise.reject(new NotSupportedError("test double")),
    cancelCheckout: () => Promise.resolve(),
  };
}

function registryWithAuto(fixtureProvenance: RegistryEntry["fixtureProvenance"] = "captured"): Readonly<
  Record<string, RegistryEntry>
> {
  return { ...REGISTRY, [AUTO_KEY]: { provider: autoProvider(), fixtureProvenance } };
}

function ctx(overrides: Partial<ResolveProviderContext> = {}): ResolveProviderContext {
  return {
    env: fakeEnv(),
    organizerUserId: ORGANIZER_ID,
    binding: activeBinding(AUTO_KEY),
    minorsIncluded: false,
    registry: registryWithAuto(),
    ...overrides,
  };
}

async function expectBlockedBy(
  promise: Promise<unknown>,
  gateKey: string,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ProviderNotEnabledError);
  try {
    await promise;
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderNotEnabledError);
    expect((error as ProviderNotEnabledError).gateKey).toBe(gateKey);
  }
}

// ============================================================================
// 正本との一致
// ============================================================================

describe("CANONICAL_GATES は docs/gates/compliance-gates.json の写しである", () => {
  it("gate_key と required_for が正本と一致する", () => {
    const canonPath = path.resolve(process.cwd(), "docs/gates/compliance-gates.json");
    const canon = JSON.parse(readFileSync(canonPath, "utf8")) as {
      gates: { gate_key: string; required_for: string[] }[];
    };
    const expected = canon.gates.map((gate) => ({
      gateKey: gate.gate_key,
      requiredFor: gate.required_for,
    }));
    const actual = CANONICAL_GATES.map((gate) => ({
      gateKey: gate.gateKey,
      requiredFor: [...gate.requiredFor],
    }));
    expect(actual).toEqual(expected);
  });

  it("phase1 の必須ゲートが 1 件以上ある（空振りゲートの禁止。R-TH-01）", () => {
    expect(requiredGateKeysFor("phase1").length).toBeGreaterThan(0);
    expect(requiredGateKeysFor("phase2").length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 9 パターン（check_090）
// ============================================================================

describe("resolveProvider の 9 パターン（check_090）", () => {
  it("1. manual_confirm は全ガードをスキップする（非 production・フラグ OFF・ゲート未通過・未成年でも通る）", async () => {
    const provider = await resolveProvider(MANUAL_CONFIRM_PROVIDER_KEY, {
      env: fakeEnv({
        appEnv: "development",
        paymentsEnabled: false,
        mode: "off",
        gates: [],
        organizerSuspended: true,
      }),
      organizerUserId: ORGANIZER_ID,
      binding: null,
      minorsIncluded: true,
    });
    expect(provider.key).toBe(MANUAL_CONFIRM_PROVIDER_KEY);
    expect(provider.capabilities.autoDetect).toBe(false);
  });

  it("2. 非 production では自動アダプタを一切有効にしない", async () => {
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ env: fakeEnv({ appEnv: "staging" }) })),
      GATE_REASON.APP_ENV,
    );
  });

  it("3. PAYMENTS_ENABLED が false なら止まる", async () => {
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ env: fakeEnv({ paymentsEnabled: false }) })),
      GATE_REASON.PAYMENTS_ENABLED,
    );
  });

  it("4. 必須ゲートが unknown なら、そのゲートキーで止まる", async () => {
    const gates = allGatesPassed().map((row) =>
      row.gateKey === "GATE-LEGAL-FUNDS" ? { ...row, status: "unknown" as const } : row,
    );
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ env: fakeEnv({ gates }) })),
      "GATE-LEGAL-FUNDS",
    );
  });

  it("5. valid_until を過ぎたゲートは passed でも止まる（R-LAW-14）", async () => {
    const expired = new Date(Date.now() - 1000);
    const gates = allGatesPassed().map((row) =>
      row.gateKey === "G0-USER" ? { ...row, validUntil: expired } : row,
    );
    await expectBlockedBy(resolveProvider(AUTO_KEY, ctx({ env: fakeEnv({ gates }) })), "G0-USER");
  });

  it("6. PROVIDER_<KEY>_MODE が off なら、そのアダプタだけ止まる", async () => {
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ env: fakeEnv({ mode: "off" }) })),
      `PROVIDER_${AUTO_KEY.toUpperCase()}_MODE`,
    );
  });

  it("6b. PROVIDER_<KEY>_MODE が未設定・不正値でも止まる（G5 round1 GPT F-2）", async () => {
    // 修正前は `'off'` のときだけ拒否していたため、行が無い（null）・値が壊れている場合に
    // 素通りしていた。`gates.ts` の「読めなければ無効に倒す」と同じ側へそろえる。
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ env: fakeEnv({ mode: null }) })),
      `PROVIDER_${AUTO_KEY.toUpperCase()}_MODE`,
    );
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ env: fakeEnv({ mode: "enabled" }) })),
      `PROVIDER_${AUTO_KEY.toUpperCase()}_MODE`,
    );
  });

  it("7. binding が active でなければ止まる（未作成・pending・suspended・別事業者）", async () => {
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ binding: null })),
      GATE_REASON.BINDING_STATUS,
    );
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ binding: activeBinding(AUTO_KEY, { status: "pending" }) })),
      GATE_REASON.BINDING_STATUS,
    );
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ binding: activeBinding("other_provider") })),
      GATE_REASON.BINDING_STATUS,
    );
  });

  it("8. 幹事が suspended なら止まる", async () => {
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ env: fakeEnv({ organizerSuspended: true }) })),
      GATE_REASON.ORGANIZER_SUSPENDED,
    );
  });

  it("9. minors_included=true のイベントでは自動決済を提示しない（check_092）", async () => {
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ minorsIncluded: true })),
      GATE_REASON.MINORS_INCLUDED,
    );
  });

  it("追加: fixture が synthesized のみのアダプタに autoDetect を名乗らせない", async () => {
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ registry: registryWithAuto("synthesized") })),
      GATE_REASON.FIXTURE_PROVENANCE,
    );
    await expectBlockedBy(
      resolveProvider(AUTO_KEY, ctx({ registry: registryWithAuto("none") })),
      GATE_REASON.FIXTURE_PROVENANCE,
    );
  });

  it("すべて通れば自動アダプタが返る（ガードが常に落とすだけの空振りでないことの確認）", async () => {
    const provider = await resolveProvider(AUTO_KEY, ctx());
    expect(provider.key).toBe(AUTO_KEY);
  });

  it("未登録のキーは PROVIDER_UNKNOWN", async () => {
    await expectBlockedBy(
      resolveProvider("no_such_provider", ctx()),
      GATE_REASON.UNKNOWN_PROVIDER,
    );
  });
});

// ============================================================================
// 止める範囲（check_022 / §7-6）
// ============================================================================

describe("止めるのは createCheckout と binding 作成だけ", () => {
  it("ゲートが閉じていても Webhook 受信・getPaymentStatus・refund 用の解決は通る", () => {
    const provider = resolveProviderWithoutGate(MANUAL_CONFIRM_PROVIDER_KEY);
    expect(provider.key).toBe(MANUAL_CONFIRM_PROVIDER_KEY);
  });

  it("binding 作成のガードは、binding がまだ無いことを理由に落とさない", async () => {
    await expect(
      assertProviderBindingAllowed(AUTO_KEY, ctx({ binding: null })),
    ).resolves.toBeUndefined();
  });

  it("binding 作成でもゲート未通過なら止まる", async () => {
    const gates = allGatesPassed().map((row) =>
      row.gateKey === "GATE-CRED-CUSTODY" ? { ...row, status: "failed" as const } : row,
    );
    await expectBlockedBy(
      assertProviderBindingAllowed(AUTO_KEY, ctx({ binding: null, env: fakeEnv({ gates }) })),
      "GATE-CRED-CUSTODY",
    );
  });
});

// ============================================================================
// ゲート判定の細部
// ============================================================================

describe("findBlockingGate", () => {
  const now = new Date("2026-09-25T00:00:00Z");

  it("射影に行が無いゲートは missing として止める", () => {
    const blocking = findBlockingGate(["G0-USER"], [], now);
    expect(blocking).toEqual({ gateKey: "G0-USER", reason: "missing" });
  });

  it("n/a は通過扱い", () => {
    const blocking = findBlockingGate(
      ["G0-USER"],
      [{ gateKey: "G0-USER", status: "n/a", validUntil: null }],
      now,
    );
    expect(blocking).toBeNull();
  });

  it("valid_until 切れは expired", () => {
    const blocking = findBlockingGate(
      ["G0-USER"],
      [{ gateKey: "G0-USER", status: "passed", validUntil: new Date("2026-09-24T00:00:00Z") }],
      now,
    );
    expect(blocking).toEqual({ gateKey: "G0-USER", reason: "expired" });
  });

  it("判定順は正本の並び順に固定される", () => {
    const rows = allGatesPassed().map((row) => ({ ...row, status: "unknown" as const }));
    const blocking = findBlockingGate(
      requiredGateKeysFor("phase1"),
      rows,
      now,
    );
    expect(blocking?.gateKey).toBe(requiredGateKeysFor("phase1")[0]);
  });
});

describe("Phase 1 のレジストリ", () => {
  it("出荷アダプタは manual_confirm だけ", () => {
    expect(Object.keys(REGISTRY)).toEqual([MANUAL_CONFIRM_PROVIDER_KEY]);
  });
});
