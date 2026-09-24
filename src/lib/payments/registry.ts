/**
 * アダプタのレジストリと実行時キルスイッチ（`docs/implementation-plan.md` §7-6）。
 *
 * ★ **止めるのは `createCheckout` と `provider_binding` 作成だけ**である。
 *   Webhook の受信・保存・照合、`getPaymentStatus`、`refund` は**止めない**
 *   （§7-6 / check_022 / check_090）。ゲートが閉じている間に届いた入金を取りこぼすと、
 *   台帳が事業者側の事実とずれたまま固定してしまうため。そのための入口が
 *   `resolveProviderWithoutGate()` で、名前で用途を明示する。
 *
 * ★ ガードの順序（§7-6 / check_090 の 9 パターン）:
 *     0. `key === 'manual_confirm'` → **以降のガードをすべてスキップして返す**。
 *        Phase 1 の唯一の出荷アダプタで、新規の資金移動を起こさないため。
 *     1. 環境ガード: `APP_ENV !== 'production'` なら `ProviderNotEnabledError`
 *     2. `PAYMENTS_ENABLED`
 *     3. `compliance_gate` が `passed` / `n/a` かつ `valid_until` 内
 *     4. `PROVIDER_<KEY>_MODE`
 *     5. `provider_binding.status === 'active'`
 *     6. 幹事が `suspended` でない
 *     7. `event.minors_included === false`
 *     8. fixture が synthesized のみのアダプタは `autoDetect` を拒否
 *
 * ★ 判定に使う値は**すべてサーバー側で引く**。UI のボタン非表示は補助であり、
 *   サーバー側の拒否（409 `GATE_NOT_PASSED` / `PROVIDER_NOT_ENABLED`）が正である。
 */

import type postgres from "postgres";

import {
  getComplianceGates,
  isFeatureFlagEnabled,
  providerModeFlagKey,
  FLAG_PAYMENTS_ENABLED,
  type ComplianceGateRow,
} from "@/lib/db/repositories/gates";

import { AUTOMATIC_PROVIDER_GATE_PHASES, findBlockingGate, requiredGateKeysForPhases } from "./gates";
import { manualConfirmProvider } from "./providers/manual-confirm";
import {
  MANUAL_CONFIRM_PROVIDER_KEY,
  ProviderNotEnabledError,
  type PaymentProvider,
  type ProviderBinding,
  type ProviderKey,
} from "./types";

// ============================================================================
// ゲートの読み取り口（テストで差し替えられるようにポートにする）
// ============================================================================

/**
 * ゲート・フラグ・幹事状態の読み取り口。本番は `dbGateEnvironment(sql, appEnv)`。
 * 単体テストは同じ形のフェイクを渡し、統合テストは実 DB の射影を通す。
 */
export interface GateEnvironment {
  /** `APP_ENV`。`production` 以外は自動アダプタを一切有効にしない。 */
  readonly appEnv: string | undefined;
  isPaymentsEnabled(): Promise<boolean>;
  /** `PROVIDER_<KEY>_MODE` の生値。行が無ければ `null`（= 未設定。ガードは拒否側に倒す）。 */
  providerMode(providerKey: string): Promise<string | null>;
  complianceGates(gateKeys: readonly string[]): Promise<readonly ComplianceGateRow[]>;
  isOrganizerSuspended(organizerUserId: string): Promise<boolean>;
}

/** 実 DB（`compliance_gate` / `feature_flag` / `app_user`）を読むゲート環境。 */
export function dbGateEnvironment(sql: postgres.ISql, appEnv: string | undefined): GateEnvironment {
  return {
    appEnv,
    isPaymentsEnabled: () => isFeatureFlagEnabled(sql, FLAG_PAYMENTS_ENABLED),
    providerMode: async (providerKey) => {
      const rows = await sql<{ value: string }[]>`
        SELECT value FROM feature_flag WHERE key = ${providerModeFlagKey(providerKey)}
      `;
      return rows[0]?.value ?? null;
    },
    complianceGates: (gateKeys) => getComplianceGates(sql, gateKeys),
    isOrganizerSuspended: async (organizerUserId) => {
      const rows = await sql<{ status: string }[]>`
        SELECT status FROM app_user WHERE id = ${organizerUserId}
      `;
      return rows[0]?.status !== "active";
    },
  };
}

// ============================================================================
// レジストリ
// ============================================================================

/**
 * fixture の出どころ。`synthesized`（人が手で書いた想定レスポンス）だけのアダプタは
 * **自動検知を名乗らせない**（G12 / §7-6 の最後のガード）。事業者の実レスポンスを
 * 捕獲していない以上、「自動で検知できている」という主張の裏付けが無いため。
 */
export type FixtureProvenance = "captured" | "synthesized" | "none";

export interface RegistryEntry {
  readonly provider: PaymentProvider;
  readonly fixtureProvenance: FixtureProvenance;
}

/**
 * Phase 1 の出荷アダプタは `manual_confirm` の 1 つだけ。
 * 自動アダプタ（`paypay_online` / `payjp`）は Phase 2（task_026 / task_030）で追加する。
 */
export const REGISTRY: Readonly<Record<string, RegistryEntry>> = {
  [MANUAL_CONFIRM_PROVIDER_KEY]: {
    provider: manualConfirmProvider,
    // 決済を作らないので事業者レスポンスの fixture そのものが存在しない。
    fixtureProvenance: "none",
  },
};

/** 実装済みのアダプタキー一覧（UI の選択肢生成に使う。ゲートの判定はしない）。 */
export function registeredProviderKeys(): readonly string[] {
  return Object.keys(REGISTRY);
}

// ============================================================================
// 解決
// ============================================================================

/** ガードに使う「どのゲートで止まったか」の機械可読な理由。 */
export const GATE_REASON = {
  UNKNOWN_PROVIDER: "PROVIDER_UNKNOWN",
  APP_ENV: "APP_ENV",
  PAYMENTS_ENABLED: FLAG_PAYMENTS_ENABLED,
  BINDING_STATUS: "PROVIDER_BINDING_STATUS",
  ORGANIZER_SUSPENDED: "ORGANIZER_SUSPENDED",
  MINORS_INCLUDED: "MINORS_INCLUDED",
  FIXTURE_PROVENANCE: "FIXTURE_PROVENANCE",
} as const;

/** 自動アダプタを有効にしてよい唯一の `APP_ENV`。 */
export const PRODUCTION_APP_ENV = "production";

export interface ResolveProviderContext {
  readonly env: GateEnvironment;
  /** 集金先の幹事。`suspended` 判定に使う。 */
  readonly organizerUserId: string;
  /** 対象イベントの binding。未作成なら `null`（自動アダプタでは即ブロック）。 */
  readonly binding: ProviderBinding | null;
  /** 対象イベントの `minors_included`。`true` なら自動決済を提示しない（§8-1 O-0 / check_092）。 */
  readonly minorsIncluded: boolean;
  readonly now?: Date;
  /**
   * 参照するレジストリ。既定は `REGISTRY`（Phase 1 は `manual_confirm` の 1 件だけ）。
   * Phase 2 のアダプタ（task_026 / task_030）と ProviderConformanceKit（task_019）、
   * および `tests/unit/payments/registry.test.ts` の 9 パターンが、**同じガードのコード**を
   * 別のレジストリに対して走らせるための差し替え口である。ガードそのものは分岐しない。
   */
  readonly registry?: Readonly<Record<string, RegistryEntry>>;
}

interface GuardOptions {
  /**
   * `provider_binding.status === 'active'` を要求するか。
   * `createCheckout` は要求する（既存の有効な binding 宛にしか決済を作れない）。
   * **binding の新規作成**は、その binding がまだ存在しないので要求しない
   * （それ以外のガードは同じ順序・同じ理由コードで通す）。
   */
  readonly requireActiveBinding: boolean;
}

/**
 * `createCheckout` と `provider_binding` 作成の入口で使う解決。
 * ガードに 1 つでも掛かったら `ProviderNotEnabledError` を投げる。
 */
export async function resolveProvider(
  key: ProviderKey,
  ctx: ResolveProviderContext,
): Promise<PaymentProvider> {
  return runGuards(key, ctx, { requireActiveBinding: true });
}

async function runGuards(
  key: ProviderKey,
  ctx: ResolveProviderContext,
  options: GuardOptions,
): Promise<PaymentProvider> {
  const entry = (ctx.registry ?? REGISTRY)[key];
  if (entry === undefined) {
    throw new ProviderNotEnabledError(key, GATE_REASON.UNKNOWN_PROVIDER);
  }

  // 0. manual_confirm は以降のガードをすべてスキップする（§7-6 / check_090）。
  //    新規の資金移動を起こさず、台帳への記録は幹事の manual-attest からしか発生しない。
  if (key === MANUAL_CONFIRM_PROVIDER_KEY) {
    return entry.provider;
  }

  // 1. 環境ガード。非 production では自動アダプタを一切有効にしない。
  if (ctx.env.appEnv !== PRODUCTION_APP_ENV) {
    throw new ProviderNotEnabledError(key, GATE_REASON.APP_ENV);
  }

  // 2. 決済機能そのもののキルスイッチ。
  if (!(await ctx.env.isPaymentsEnabled())) {
    throw new ProviderNotEnabledError(key, GATE_REASON.PAYMENTS_ENABLED);
  }

  // 3. compliance_gate（正本は docs/gates/compliance-gates.json、DB はその射影）。
  const now = ctx.now ?? new Date();
  const requiredKeys = requiredGateKeysForPhases(AUTOMATIC_PROVIDER_GATE_PHASES);
  const blocking = findBlockingGate(requiredKeys, await ctx.env.complianceGates(requiredKeys), now);
  if (blocking !== null) {
    throw new ProviderNotEnabledError(key, blocking.gateKey);
  }

  // 4. 事業者ごとのモード。**`'on'` のときだけ通す**（G5 round1 GPT F-2 是正）。
  //    修正前は `'off'` のときだけ止めていたため、フラグの行が無い（`null`）・値が壊れている
  //    場合に素通りしていた。`src/lib/db/repositories/gates.ts` が掲げる「読めなければ無効に倒す」
  //    と食い違っていたので、既定を拒否側に寄せる。新しい事業者は人がフラグを立てるまで開かない。
  const modeKey = providerModeFlagKey(key);
  if ((await ctx.env.providerMode(key)) !== "on") {
    throw new ProviderNotEnabledError(key, modeKey);
  }

  // 5. binding が有効であること（新規作成の入口では、まだ存在しないので検査しない）。
  if (options.requireActiveBinding) {
    if (ctx.binding === null || ctx.binding.status !== "active" || ctx.binding.providerKey !== key) {
      throw new ProviderNotEnabledError(key, GATE_REASON.BINDING_STATUS);
    }
  } else if (ctx.binding !== null && ctx.binding.providerKey !== key) {
    throw new ProviderNotEnabledError(key, GATE_REASON.BINDING_STATUS);
  }

  // 6. 幹事が停止されていないこと。
  if (await ctx.env.isOrganizerSuspended(ctx.organizerUserId)) {
    throw new ProviderNotEnabledError(key, GATE_REASON.ORGANIZER_SUSPENDED);
  }

  // 7. 未成年を含むイベントには自動決済を提示しない（§8-1 O-0 / check_092）。
  if (ctx.minorsIncluded) {
    throw new ProviderNotEnabledError(key, GATE_REASON.MINORS_INCLUDED);
  }

  // 8. 事業者の実レスポンスを捕獲していないアダプタに自動検知を名乗らせない。
  if (entry.provider.capabilities.autoDetect && entry.fixtureProvenance !== "captured") {
    throw new ProviderNotEnabledError(key, GATE_REASON.FIXTURE_PROVENANCE);
  }

  return entry.provider;
}

/**
 * **ゲートを見ない**解決。Webhook の受信・保存・照合、`getPaymentStatus`、`refund` 専用。
 *
 * ゲートが閉じている間も外部で起きた事実は届くので、受け取って保存し、照会し、返金できる
 * 必要がある（§7-6 /  check_022）。`createCheckout` と binding 作成からは呼ばないこと。
 */
export function resolveProviderWithoutGate(key: ProviderKey): PaymentProvider {
  const entry = REGISTRY[key];
  if (entry === undefined) {
    throw new ProviderNotEnabledError(key, GATE_REASON.UNKNOWN_PROVIDER);
  }
  return entry.provider;
}

/**
 * `provider_binding` の作成が許されるかを判定する（§7-6「止めるのは `createCheckout` と
 * `provider_binding` 作成のみ」）。判定は `resolveProvider` と同一の順序・同一の理由コードで行う。
 */
export async function assertProviderBindingAllowed(
  key: ProviderKey,
  ctx: ResolveProviderContext,
): Promise<void> {
  await runGuards(key, ctx, { requireActiveBinding: false });
}
