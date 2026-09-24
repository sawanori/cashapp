/**
 * `PaymentProvider` インターフェース v2（`docs/implementation-plan.md` §7-6 / task_017 scope）。
 *
 * ★ v1（`docs/research/design-synthesis.md` §5-1）との差分は 3 点で、いずれも
 *   実装計画 §7-6 が上書きした側を採る:
 *     1. **全メソッドの第一引数が `binding`**（`createCheckout(binding, cmd)` など）。
 *        どの加盟店アカウント宛の操作かを型で必ず受け取らせる（R-PAY-01）。省略すると型エラー。
 *     2. `ProviderCapabilities` の項目を v1 の 8 個から 15 個へ拡張
 *        （`refundWindowDays` / `dispute` / `disputeResponseWindowDays` / `checkoutIdempotent` /
 *        `credentialCustody` / `settlementQuery` / `feeModel` / `settlementSchedule`）。
 *     3. `PaymentEventKind` に紛争（`disputed` / `dispute_resolved`）と返金中
 *        （`refund_pending` / `refund_failed`）を足す。DB 側 `payment_event.kind` の
 *        CHECK 制約（`supabase/migrations/0001_init.sql`）と同じ集合にする。
 *
 * ★ `Money` はブランド型。`src/lib/payments/money.ts` の `yen()` 以外では作れない
 *   （オブジェクトリテラルは `Money` に代入できない）。アダプタ境界へ数値を渡す関数は
 *   `toProviderAmount()` 1 本だけにする（§7-6）。
 *
 * ★ `payerIdentity` は `false` リテラル固定、`PaymentSnapshot.payerIdentity` は `null` 固定。
 *   「誰が払ったか」を事業者 API が返す前提をコード上で書けなくする（制約 P9）。
 *   `docs/constraints.json` P9 の grep は、支払者識別を真と宣言する形と、非自動ラベルの
 *   2 つの項目を省略可能型（`?` 付き）で宣言する形を本ディレクトリから締め出す。
 *
 * ★ このファイルは型と例外クラスだけを持つ。DB にも fetch にも触らない
 *   （`import "server-only"` を付けないのはそのため。参加者画面が型だけを import できる）。
 */

import type { FeeModelKind } from "./capabilities-static";

// ============================================================================
// 事業者キー
// ============================================================================

/**
 * 事業者キー。開いた文字列型にして、新規事業者の追加でコア側のユニオン編集を強制しない。
 * DB 側は `provider_key ~ '^[a-z0-9_]{1,32}$'`（`supabase/migrations/0001_init.sql`）。
 */
export type ProviderKey = "manual_confirm" | "paypay_online" | "payjp" | "paypal" | (string & {});

/** Phase 1 の唯一の出荷アダプタ。 */
export const MANUAL_CONFIRM_PROVIDER_KEY = "manual_confirm";

/** `provider_key` の書式（DB の CHECK と同じ）。 */
export const PROVIDER_KEY_RE = /^[a-z0-9_]{1,32}$/;

// ============================================================================
// Money（ブランド型）
// ============================================================================

/**
 * `Money` のブランド。**型だけの存在**で、実行時の値は無い（`declare` なのでコードを生成しない）。
 * これがあるため `{ amountMinor: 5000, currency: "JPY" }` は `Money` に代入できず、
 * `yen()` を通る以外に `Money` を作る方法が無い（check_093）。
 */
declare const MONEY_BRAND: unique symbol;

export interface Money {
  /** JPY はゼロデシマル通貨なので minor == major（1 円 = 1）。 */
  readonly amountMinor: number;
  /** 国内限定（制約 L12）。他通貨は型で書けない。 */
  readonly currency: "JPY";
  readonly [MONEY_BRAND]: true;
}

// ============================================================================
// 能力宣言
// ============================================================================

export type RefundCapability = "none" | "full_once" | "full" | "partial";
export type WebhookSignatureKind = "hmac" | "token" | "none";
export type DisputeCapability = "webhook" | "poll" | "none";
/** `server` = 運営者が資格情報を預かる / `organizer` = 幹事側に留め置く（GATE-CRED-CUSTODY）。 */
export type CredentialCustody = "server" | "organizer";

/**
 * 手数料モデル。率・固定額は**未確定なら `null`**（`docs/implementation-plan.md` §18-3）。
 * 表示用の定性説明 `note` は `src/lib/payments/capabilities-static.ts` の静的表から取り込む。
 */
export interface ProviderFeeModel {
  readonly kind: FeeModelKind;
  /** 利用者向けの定性説明。数字を含めない（`docs/wording-policy.md` W-FEE-FIXED）。 */
  readonly note: string;
  /** 率（ベーシスポイント）。未確定は `null`。 */
  readonly rateBp: number | null;
  /** 固定額（minor）。未確定は `null`。 */
  readonly fixedMinor: number | null;
  /** 率・固定額のいずれかが未確定なら `true`。UI は推定である旨を必ず併記する。 */
  readonly undetermined: boolean;
}

export interface ProviderCapabilities {
  /** `false` ⇒ この経路は自動検知ではない。UI・API・CSV に非自動ラベルを出す義務が生じる。 */
  readonly autoDetect: boolean;
  readonly webhook: boolean;
  /** `none` の事業者はコアが `getPaymentStatus` で必ず再照会する（制約 W7）。 */
  readonly webhookSignature: WebhookSignatureKind;
  readonly statusQuery: boolean;
  readonly refund: RefundCapability;
  /** 返金可能期間（日）。制限が無い・未確定なら `null`。 */
  readonly refundWindowDays: number | null;
  readonly dispute: DisputeCapability;
  /** 紛争への応答期限（日）。未確定なら `null`。 */
  readonly disputeResponseWindowDays: number | null;
  /** 同じ `externalRef` での `createCheckout` 再送が同じ決済を返すか。 */
  readonly checkoutIdempotent: boolean;
  readonly credentialCustody: CredentialCustody;
  readonly settlementQuery: boolean;
  readonly feeModel: ProviderFeeModel;
  /** 事業者から幹事への入金サイクルの定性説明。数字（率・金額）を含めない。 */
  readonly settlementSchedule: string;
  /**
   * ★ 全事業者 `false` 固定。事業者 API は支払者を返さない（制約 P9）。
   *   代理払いは自動検知できず、確定は幹事の `manual-attest` のみ（§7-6 末尾）。
   */
  readonly payerIdentity: false;
  /** 「決済完了」と「幹事への入金」を別に見せるための表示用注記。 */
  readonly settlementLagHint: string;
}

// ============================================================================
// binding（全メソッドの第一引数）
// ============================================================================

export type ProviderBindingStatus = "pending" | "active" | "suspended" | "revoked";

/**
 * `provider_binding` の実行時ビュー。**資格情報の値は入れない**
 * （`credentialRef` は外部シークレットストアのキー名。§7-7）。
 */
export interface ProviderBinding {
  readonly id: string;
  readonly organizerUserId: string;
  readonly providerKey: ProviderKey;
  readonly status: ProviderBindingStatus;
  /** 外部シークレットストアのキー名。値そのものではない。 */
  readonly credentialRef: string | null;
  /** 資格情報の指紋（ログに出してよい唯一の資格情報由来の値）。 */
  readonly credentialFp: string | null;
  /** 受取用の識別子。**URL を入れない**（`ManualConfirmAdapter` の項を参照）。 */
  readonly receivingIdentifier: string | null;
  readonly receivingIdentifierKind: "merchant_id" | "bank_account_ref" | "none" | null;
}

// ============================================================================
// createCheckout
// ============================================================================

export interface CreateCheckoutCommand {
  readonly invoiceId: string;
  /** 事業者側の外部参照キー。`<= 64`・`[A-Za-z0-9_-]`（DB の CHECK と同じ）。 */
  readonly externalRef: string;
  readonly money: Money;
  readonly description: string;
  /** ★ 必須。LINE ミニアプリのパーマネントリンクへ戻す（制約 P4 / N4）。 */
  readonly returnUrl: string;
  readonly expiresAt: Date | null;
  /** 事業者 API 呼び出しの打ち切り時間（ミリ秒）。§7-6 で IF v2 に追加。 */
  readonly timeoutMs: number;
}

/** 手動確認（非自動）経路の案内。UI はこれを受け取ったら必ず非自動バッジを出す。 */
export interface ManualInstruction {
  /** ★ リテラル `false` 固定。自動経路と同じ型に化けられないようにする。 */
  readonly automatic: false;
  readonly channel: ManualChannel;
  /**
   * サーバー側テンプレートから組み立てた受取リンク。幹事の入力した URL をそのまま使うことは
   * 無い。テンプレートが未検証、または識別子が無いときは `null`。
   */
  readonly deepLink: string | null;
  /** `deepLink` の遷移先ホスト名。参加者画面に必ず併記する（§7-6 / check_091）。 */
  readonly deepLinkHost: string | null;
  readonly note: string;
  /** ★ 文字列リテラル型で運ぶ。規約でもハードコードでもなく、型で固定する。 */
  readonly disclaimer: typeof MANUAL_CONFIRM_DISCLAIMER;
}

/** 手動確認の受け取り方。DB の `manual_attestation.method` / `payment_self_report.method` と同じ集合。 */
export type ManualChannel = "paypay_p2p" | "bank_transfer" | "cash" | "other";

/**
 * 手動確認経路の固定文言。`ManualInstruction.disclaimer` はこのリテラル型しか受け付けない。
 * `docs/wording-policy.md` の許可文言「幹事が手動で確認」を含む形にしてある。
 */
export const MANUAL_CONFIRM_DISCLAIMER =
  "支払いの確認は幹事が手動で確認します。アプリは入金を検知しません。" as const;

export type CheckoutTicket =
  | {
      readonly kind: "redirect";
      readonly externalRef: string;
      readonly checkoutUrl: string;
      readonly expiresAt: Date | null;
      readonly raw: unknown;
    }
  | {
      readonly kind: "manual";
      readonly externalRef: string;
      readonly instruction: ManualInstruction;
    };

// ============================================================================
// 正規化イベント・スナップショット
// ============================================================================

/**
 * `payment_event.kind` と同じ集合（`supabase/migrations/0001_init.sql`）。
 * v1 から紛争（`disputed` / `dispute_resolved`）と返金中（`refund_pending` / `refund_failed`）を追加。
 */
export type PaymentEventKind =
  | "authorized"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired"
  | "refunded"
  | "refund_pending"
  | "refund_failed"
  | "disputed"
  | "dispute_resolved"
  | "unknown";

export type EventTrust = "verified" | "reverified" | "unverified" | "attested";

export interface NormalizedEvent {
  readonly providerKey: ProviderKey;
  /** 事業者のイベント ID。持たない事業者は `'sha256:' + sha256(rawBody)` をアダプタが埋める。 */
  readonly providerEventId: string;
  readonly eventType: string;
  readonly kind: PaymentEventKind;
  readonly externalRef: string;
  /** 観測用の業務キー。★ 一意制約は張らない（部分返金が同じキーを生むため）。 */
  readonly businessIdemKey: string;
  /** 台帳の二重計上を防ぐ唯一の鍵（`ledger_entry.dedupe_key`）。 */
  readonly ledgerDedupeKey: string;
  readonly money: Money | null;
  readonly occurredAt: Date | null;
  readonly trust: EventTrust;
  readonly raw: unknown;
}

export interface PaymentSnapshot {
  readonly providerKey: ProviderKey;
  readonly externalRef: string;
  readonly kind: PaymentEventKind;
  readonly money: Money | null;
  readonly fetchedAt: Date;
  /** ★ 常に `null`。どの事業者も支払者を返さない（制約 P9）。型で固定する。 */
  readonly payerIdentity: null;
  readonly raw: unknown;
}

export interface SettlementSummary {
  readonly providerKey: ProviderKey;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly grossMinor: number;
  readonly feeMinor: number;
  readonly raw: unknown;
}

// ============================================================================
// 例外
// ============================================================================

export class SignatureError extends Error {
  public constructor(message = "signature verification failed") {
    super(message);
    this.name = "SignatureError";
  }
}

/** 能力宣言にない操作を呼ばれた。呼び出し側が 409 `NOT_SUPPORTED` に変換する（制約 P7）。 */
export class NotSupportedError extends Error {
  public readonly feature: string;

  public constructor(feature: string) {
    super(`not supported: ${feature}`);
    this.name = "NotSupportedError";
    this.feature = feature;
  }
}

/** 実行時ゲートで止められた。`gateKey` は「どのゲートで止まったか」の機械可読な理由。 */
export class ProviderNotEnabledError extends Error {
  public readonly providerKey: string;
  public readonly gateKey: string;

  public constructor(providerKey: string, gateKey: string) {
    super(`provider not enabled: ${providerKey} (gate ${gateKey})`);
    this.name = "ProviderNotEnabledError";
    this.providerKey = providerKey;
    this.gateKey = gateKey;
  }
}

/**
 * 事業者側アカウントの問題（審査落ち・停止・失効）。**こちらの実装の誤りではない**ので
 * `ProviderNotEnabledError` と区別する（O-11 の「事業者側アカウント無効」表示の根拠。§7-6）。
 */
export class ProviderAccountError extends Error {
  public readonly providerKey: string;
  public readonly reason: ProviderAccountErrorReason;

  public constructor(providerKey: string, reason: ProviderAccountErrorReason, message?: string) {
    super(message ?? `provider account unusable: ${providerKey} (${reason})`);
    this.name = "ProviderAccountError";
    this.providerKey = providerKey;
    this.reason = reason;
  }
}

export type ProviderAccountErrorReason =
  | "not_onboarded"
  | "suspended"
  | "revoked"
  | "credentials_invalid"
  | "unknown";

// ============================================================================
// アダプタ IF
// ============================================================================

/**
 * 全メソッドの**第一引数が `binding`**（§7-6）。どの加盟店アカウント宛かを型で強制する。
 * 省略した実装はコンパイルエラーになる。
 */
export interface PaymentProvider {
  readonly key: ProviderKey;
  readonly capabilities: ProviderCapabilities;

  createCheckout(binding: ProviderBinding, cmd: CreateCheckoutCommand): Promise<CheckoutTicket>;

  /**
   * `raw` は生文字列。アダプタの外で `JSON.parse` しない（制約 P2）。
   * `secrets` は複数受けてローテーションに耐える（制約 W12）。
   */
  parseWebhook(
    binding: ProviderBinding,
    raw: string,
    headers: Headers,
    secrets: readonly string[],
  ): Promise<readonly NormalizedEvent[]>;

  getPaymentStatus(binding: ProviderBinding, externalRef: string): Promise<PaymentSnapshot>;

  /** 非対応は `NotSupportedError`。呼び出し側が 409 `NOT_SUPPORTED` に変換する（制約 P7）。 */
  refund(binding: ProviderBinding, externalRef: string, money?: Money): Promise<NormalizedEvent>;

  cancelCheckout(binding: ProviderBinding, externalRef: string): Promise<void>;

  listSettlements?(
    binding: ProviderBinding,
    period: { readonly from: Date; readonly to: Date },
  ): Promise<readonly SettlementSummary[]>;
}

// ============================================================================
// 非自動ラベル（8 層の①: API 型必須）
// ============================================================================

/**
 * 請求を返すすべてのエンドポイントがこの 2 つを**必ず**含む（§7-6 の 8 層①）。
 * 省略可能（`?:`）にした瞬間、手動確認が自動検知として表示されうるため、
 * `docs/constraints.json` P9 の grep が `?:` 付きの宣言を機械的に落とす。
 */
export type ConfirmationMethod = "automatic" | "manual_by_organizer" | "mixed";

export interface NonAutoLabel {
  readonly autoDetected: boolean;
  readonly confirmationMethod: ConfirmationMethod;
}
