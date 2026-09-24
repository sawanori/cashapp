/**
 * 台帳残高と `confirmation_method` の導出（§9「`applyToLedger` の不変条件」/ check_094）。
 *
 * ★ 二重払いの検知は **attempt の件数ではなく「台帳残高 > 請求額」**で行う（§9）。
 *   試行は正当な理由で何本でも増える（決済画面を閉じて開き直す等）ため、件数は根拠にならない。
 *
 * ★ `confirmation_method` は `ledger_entry.confidence` の**集合**から導出する。
 *   自動（`provider_verified` / `provider_polled` / `bank_matched`）と手動
 *   （`organizer_attested`）が混ざったら `mixed` である。
 *
 * ★ **`mixed` は DB に保存できない**。`invoice.confirmation_method` の CHECK は
 *   `('automatic','manual_by_organizer')` の 2 値だけ（`supabase/migrations/0001_init.sql`）。
 *   そこで保存値は `persistedConfirmationMethod()` が決め、`mixed` のときは
 *   **`manual_by_organizer` を保存する**（非自動バッジを消さない側に倒す。check_094 の
 *   「手動＋自動でバッジが消えない」）。API / UI に出す 3 値は
 *   `deriveConfirmationMethod()` が台帳から毎回導出する。
 */

import type { ConfirmationMethod } from "@/lib/payments/types";

/** `ledger_entry.confidence` の CHECK と同じ集合。 */
export type LedgerConfidence =
  | "provider_verified"
  | "provider_polled"
  | "bank_matched"
  | "organizer_attested";

/** `ledger_entry.direction`。 */
export type LedgerDirection = "credit" | "debit";

/** `ledger_entry.kind` の CHECK と同じ集合。 */
export type LedgerKind =
  | "payment"
  | "refund"
  | "overpay"
  | "proxy_payment"
  | "adjustment"
  | "writeoff"
  | "chargeback"
  | "chargeback_reversal"
  | "fee";

export interface LedgerLine {
  readonly direction: LedgerDirection;
  readonly kind: LedgerKind;
  readonly amountMinor: number;
  readonly confidence: LedgerConfidence;
}

/** 自動検知由来と見なす `confidence`。`organizer_attested` だけが手動である。 */
const AUTOMATIC_CONFIDENCES: readonly LedgerConfidence[] = [
  "provider_verified",
  "provider_polled",
  "bank_matched",
];

export function isAutomaticConfidence(confidence: LedgerConfidence): boolean {
  return AUTOMATIC_CONFIDENCES.includes(confidence);
}

/**
 * 残高 = credit の合計 − debit の合計。
 *
 * `adjustment` は「突合できなかった受領事実」であり、請求の充足には数えない
 * （§9: 金額不一致はランクを前進させない）。残高に混ぜると、不一致の入金で
 * 二重払い判定（残高 > 請求額）が誤発火する。
 */
export function ledgerBalanceMinor(lines: readonly LedgerLine[]): number {
  let balance = 0;
  for (const line of lines) {
    if (line.kind === "adjustment") continue;
    balance += line.direction === "credit" ? line.amountMinor : -line.amountMinor;
  }
  return balance;
}

/** 台帳残高が請求額を超えているか（二重払いの検知。§9）。 */
export function isOverpaid(balanceMinor: number, invoiceAmountMinor: number): boolean {
  return balanceMinor > invoiceAmountMinor;
}

/**
 * 台帳の `confidence` 集合から表示用の 3 値を導く。
 * 台帳が空（まだ 1 円も記帳されていない）ときは、非自動側の既定に倒す。
 */
export function deriveConfirmationMethod(
  confidences: readonly LedgerConfidence[],
): ConfirmationMethod {
  let hasAutomatic = false;
  let hasManual = false;
  for (const confidence of confidences) {
    if (isAutomaticConfidence(confidence)) hasAutomatic = true;
    else hasManual = true;
  }
  if (hasAutomatic && hasManual) return "mixed";
  if (hasAutomatic) return "automatic";
  return "manual_by_organizer";
}

/** DB の 2 値へ落とす。`mixed` は非自動側（バッジを消さない側）に倒す。 */
export function persistedConfirmationMethod(
  derived: ConfirmationMethod,
): "automatic" | "manual_by_organizer" {
  return derived === "automatic" ? "automatic" : "manual_by_organizer";
}
