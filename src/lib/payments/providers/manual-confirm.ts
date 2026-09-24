/**
 * `ManualConfirmAdapter` — Phase 1 の唯一の出荷アダプタ（`docs/implementation-plan.md` §7-6）。
 *
 * ★ `autoDetect: false` が全ての起点である。これを受け取った UI・API・CSV には
 *   非自動ラベルを出す義務が生じる（「非自動ラベルの 8 層」）。
 *
 * ★ **幹事から任意 URL を受け取らない**。受け取るのは `provider_binding.receiving_identifier`
 *   （DB の CHECK で `^[A-Za-z0-9_-]{1,64}$`。`:` も `/` も入らない）だけで、リンクは
 *   このファイルの**サーバー側テンプレート**から組み立てる。組み立てた URL は
 *   `ALLOWED_DEEPLINK_HOSTS` の完全一致検査を通り、`https` でなければ捨てる。
 *   参加者画面には遷移先ホスト名（`deepLinkHost`）を必ず併記する（check_091）。
 *
 * ★ **一次資料で URL 形式を確認できていないテンプレートは使わない**。
 *   `verified: false` のテンプレートは `activeReceivingLinkTemplates()` から外れ、
 *   `deepLink` は `null` になる（推測した URL を参加者に踏ませない）。Phase 1 の既定は
 *   この状態であり、案内文は「幹事から受け取り方を聞いてください」に倒れる。
 *   一次資料を `docs/vendor-docs/<vendor>/<topic>.md` に退避してから `verified: true` にする。
 *
 * ★ 決済を作らないので `parseWebhook` は常に空、`getPaymentStatus` / `refund` は
 *   `NotSupportedError`（制約 P7 / check_011 / check_026）。照合ジョブは
 *   `capabilities.statusQuery === false` で走査対象から外す。
 *
 * ★ 台帳への記録は `POST /api/invoices/:id/manual-attest` からのみ発生し、
 *   `ingestion_source='manual'` / `trust='attested'` / `confidence='organizer_attested'` /
 *   `auto_detected=false` / `confirmation_method='manual_by_organizer'` になる。
 */

import { requireStaticProviderCapabilities } from "../capabilities-static";
import { MAX_AMOUNT_MINOR, MIN_AMOUNT_MINOR } from "../money";
import {
  MANUAL_CONFIRM_DISCLAIMER,
  MANUAL_CONFIRM_PROVIDER_KEY,
  NotSupportedError,
  type CheckoutTicket,
  type CreateCheckoutCommand,
  type ManualChannel,
  type ManualInstruction,
  type NormalizedEvent,
  type PaymentProvider,
  type PaymentSnapshot,
  type ProviderBinding,
  type ProviderCapabilities,
} from "../types";

// ============================================================================
// 受取リンクのテンプレート（サーバー側固定・許可ホスト限定）
// ============================================================================

/**
 * 組み立てた URL が名乗ってよいホスト名の**完全一致**リスト。
 * テンプレートの `build` が別のホストを返した場合でも、ここで落とす（二重の関所）。
 */
export const ALLOWED_DEEPLINK_HOSTS: readonly string[] = ["qr.paypay.ne.jp"];

export interface ReceivingLinkTemplate {
  readonly channel: ManualChannel;
  /** 期待する遷移先ホスト。`ALLOWED_DEEPLINK_HOSTS` に含まれない値は使えない。 */
  readonly host: string;
  /** 受取識別子の書式。DB の CHECK よりさらに狭めてよい。 */
  readonly identifierPattern: RegExp;
  /** 識別子からリンクを組み立てる。識別子は呼び出し側で検証済み。 */
  readonly build: (identifier: string) => string;
  /**
   * URL 形式を一次資料で確認できているか。`false` の間はリンクを出さない
   * （推測した URL を参加者に踏ませないため）。
   */
  readonly verified: boolean;
  /** 一次資料の退避先。`verified: true` にするときは必ず実在する資料を指すこと。 */
  readonly sourceRef: string;
}

/**
 * テンプレート表。**Phase 1 は `verified: true` のエントリが 1 件も無い**のが正しい状態である
 * （PayPay の個人間受取リンクの URL 形式を一次資料で取得できていない。
 * `docs/vendor-docs/paypay/receiving-link.md` 参照）。
 */
export const RECEIVING_LINK_TEMPLATES: readonly ReceivingLinkTemplate[] = [
  {
    channel: "paypay_p2p",
    host: "qr.paypay.ne.jp",
    identifierPattern: /^[A-Za-z0-9_-]{1,64}$/,
    build: (identifier) => `https://qr.paypay.ne.jp/${identifier}`,
    verified: false,
    sourceRef: "docs/vendor-docs/paypay/receiving-link.md（一次資料未取得のため未検証）",
  },
];

/** 実際に使ってよいテンプレート（一次資料で確認済み、かつ許可ホストのもの）。 */
export function activeReceivingLinkTemplates(
  templates: readonly ReceivingLinkTemplate[] = RECEIVING_LINK_TEMPLATES,
): readonly ReceivingLinkTemplate[] {
  return templates.filter(
    (template) => template.verified && ALLOWED_DEEPLINK_HOSTS.includes(template.host),
  );
}

export interface BuiltReceivingLink {
  readonly url: string;
  readonly host: string;
}

/**
 * 受取リンクを組み立てる。組み立てられない場合は `null`（例外にしない — 支払い導線そのものは
 * リンクが無くても成立する。案内文が「幹事に受け取り方を聞く」に倒れるだけである）。
 *
 * 拒否する条件:
 *   - 当該 `channel` に使えるテンプレートが無い（未検証・許可ホスト外を含む）
 *   - 識別子がテンプレートの書式に合わない（URL・スラッシュ・コロンはここで落ちる）
 *   - 組み立て結果が `https` でない、またはホストが `ALLOWED_DEEPLINK_HOSTS` に無い
 *   - 組み立て結果に識別子由来のパス以外（クエリ・フラグメント・ユーザ情報）が混ざっている
 */
export function buildReceivingLink(
  channel: ManualChannel,
  identifier: string | null,
  templates: readonly ReceivingLinkTemplate[] = RECEIVING_LINK_TEMPLATES,
): BuiltReceivingLink | null {
  if (identifier === null || identifier.length === 0) return null;
  const template = activeReceivingLinkTemplates(templates).find(
    (candidate) => candidate.channel === channel,
  );
  if (template === undefined) return null;
  if (!template.identifierPattern.test(identifier)) return null;

  let url: URL;
  try {
    url = new URL(template.build(identifier));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!ALLOWED_DEEPLINK_HOSTS.includes(url.hostname)) return null;
  if (url.hostname !== template.host) return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.search.length > 0 || url.hash.length > 0) return null;
  return { url: url.toString(), host: url.hostname };
}

// ============================================================================
// 能力宣言
// ============================================================================

const staticCapabilities = requireStaticProviderCapabilities(MANUAL_CONFIRM_PROVIDER_KEY);

/**
 * `autoDetect: false` が起点。手数料・入金時期の文言は
 * `src/lib/payments/capabilities-static.ts` の静的表から取り込む（§7-6 / task_014 との接続）。
 */
export const MANUAL_CONFIRM_CAPABILITIES: ProviderCapabilities = {
  autoDetect: false,
  webhook: false,
  webhookSignature: "none",
  statusQuery: false,
  refund: "none",
  refundWindowDays: null,
  dispute: "none",
  disputeResponseWindowDays: null,
  // 決済を作らないので、同じ externalRef で何度呼んでも同じ案内が返る。
  checkoutIdempotent: true,
  // 外部の資格情報を一切預からない。
  credentialCustody: "organizer",
  settlementQuery: false,
  feeModel: {
    kind: staticCapabilities.feeModel.kind,
    note: staticCapabilities.feeModel.note,
    rateBp: null,
    fixedMinor: null,
    undetermined: staticCapabilities.feeModel.kind !== "none",
  },
  settlementSchedule: staticCapabilities.settlementEta,
  payerIdentity: false,
  settlementLagHint:
    "幹事が直接受け取ります。アプリは受け取りを検知しないため、幹事の確認までは記録に反映されません。",
};

// ============================================================================
// アダプタ
// ============================================================================

const EXTERNAL_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 受け取り方ごとの案内文。数字を「手数料」と同一文に並べない（W-FEE-FIXED）。 */
const CHANNEL_NOTES: Readonly<Record<ManualChannel, string>> = {
  paypay_p2p: "幹事の PayPay へ直接お送りください。",
  bank_transfer: "幹事の指定口座へお振り込みください。振込先は幹事にご確認ください。",
  cash: "当日、幹事に直接お渡しください。",
  other: "受け取り方は幹事にご確認ください。",
};

function buildInstruction(
  channel: ManualChannel,
  binding: ProviderBinding,
  templates: readonly ReceivingLinkTemplate[],
): ManualInstruction {
  const link = buildReceivingLink(channel, binding.receivingIdentifier, templates);
  const note =
    link === null
      ? `${CHANNEL_NOTES[channel]}お支払い先は幹事にご確認ください。`
      : `${CHANNEL_NOTES[channel]}遷移先は ${link.host} です。`;
  return {
    automatic: false,
    channel,
    deepLink: link?.url ?? null,
    deepLinkHost: link?.host ?? null,
    note,
    disclaimer: MANUAL_CONFIRM_DISCLAIMER,
  };
}

export interface ManualConfirmAdapterOptions {
  /** 既定の受け取り方。イベント側の設定が無いときに使う。 */
  readonly defaultChannel?: ManualChannel;
  /** テンプレート表の差し替え（テスト用）。本番は既定値をそのまま使う。 */
  readonly templates?: readonly ReceivingLinkTemplate[];
}

export function createManualConfirmProvider(
  options: ManualConfirmAdapterOptions = {},
): PaymentProvider {
  const defaultChannel: ManualChannel = options.defaultChannel ?? "paypay_p2p";
  const templates = options.templates ?? RECEIVING_LINK_TEMPLATES;

  return {
    key: MANUAL_CONFIRM_PROVIDER_KEY,
    capabilities: MANUAL_CONFIRM_CAPABILITIES,

    createCheckout(binding: ProviderBinding, cmd: CreateCheckoutCommand): Promise<CheckoutTicket> {
      if (binding.providerKey !== MANUAL_CONFIRM_PROVIDER_KEY) {
        return Promise.reject(
          new NotSupportedError(`binding provider mismatch: ${binding.providerKey}`),
        );
      }
      if (!EXTERNAL_REF_RE.test(cmd.externalRef)) {
        return Promise.reject(new NotSupportedError(`invalid externalRef format`));
      }
      if (
        cmd.money.amountMinor < MIN_AMOUNT_MINOR ||
        cmd.money.amountMinor > MAX_AMOUNT_MINOR ||
        cmd.money.currency !== "JPY"
      ) {
        return Promise.reject(new NotSupportedError(`unsupported amount for manual confirm`));
      }
      // 決済を作らない。外部 API も呼ばないので timeoutMs / returnUrl は使わない
      // （型としては必須のままにして、自動アダプタと同じ呼び出し側コードが通るようにする）。
      return Promise.resolve({
        kind: "manual",
        externalRef: cmd.externalRef,
        instruction: buildInstruction(defaultChannel, binding, templates),
      });
    },

    /** Webhook を受けない。署名も無い。常に空配列（制約 P2 の「外で JSON.parse しない」も自明に満たす）。 */
    parseWebhook(): Promise<readonly NormalizedEvent[]> {
      return Promise.resolve([]);
    },

    getPaymentStatus(): Promise<PaymentSnapshot> {
      return Promise.reject(new NotSupportedError("getPaymentStatus(manual_confirm)"));
    },

    refund(): Promise<NormalizedEvent> {
      return Promise.reject(new NotSupportedError("refund(manual_confirm)"));
    },

    /**
     * 外部に作った決済が無いので取り消す対象も無い。例外にせず何もしない
     * （イベント中止時の「生きた attempt を `cancelCheckout`」の一括処理を止めないため）。
     */
    cancelCheckout(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** レジストリに載せる既定インスタンス。 */
export const manualConfirmProvider: PaymentProvider = createManualConfirmProvider();

/** 参加者画面に出す案内（P-4 / P-5）。ゲートを通らないので画面から直接呼んでよい。 */
export function manualInstructionFor(
  channel: ManualChannel,
  binding: ProviderBinding,
  templates: readonly ReceivingLinkTemplate[] = RECEIVING_LINK_TEMPLATES,
): ManualInstruction {
  return buildInstruction(channel, binding, templates);
}
