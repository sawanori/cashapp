/**
 * 決済状態の単調ランク（`docs/implementation-plan.md` §10-1 / 制約 W3）。
 *
 * ★ `settlement_rank` の正本は **DB の生成列**（`supabase/migrations/0001_init.sql` の
 *   `invoice.settlement_rank`）である。このファイルはその写しであり、値が食い違えば
 *   `tests/unit/ledger/rank.test.ts` が落ちる（写しを手で書き換えても検査される）。
 *
 * ★ 状態は**前進のみ**。`applyToLedger` の UPDATE は必ず `settlement_rank < $new` を伴う。
 *   ここに「例外規則」は無い（W3）。後退させたい事象（取消）は `lifecycle_state` という
 *   別の軸で表す。
 *
 * ★ `targetStatusFor()` は `PaymentEventKind` の **11 値すべて**を網羅する。
 *   新しい種別を `src/lib/payments/types.ts` に足した瞬間、`never` 代入が型エラーになる
 *   （分岐の書き忘れをコンパイルで止める）。
 *
 * ★ `docs/constraints.json` W3 の grep は本ファイルを exclude_globs に持つ。
 *   ランクの定義そのものを書く唯一の場所だからであり、他所で状態文字列を直接代入して
 *   よいという意味ではない。
 */

import type { PaymentEventKind } from "@/lib/payments/types";

/** `invoice.settlement_status` の CHECK と同じ集合。 */
export type SettlementStatus =
  | "unpaid"
  | "authorized"
  | "paid"
  | "refund_pending"
  | "refunded"
  | "charged_back";

/** `invoice.settlement_rank`（生成列）と同じ対応表。 */
export const SETTLEMENT_RANK: Readonly<Record<SettlementStatus, number>> = {
  unpaid: 0,
  authorized: 10,
  paid: 40,
  refund_pending: 60,
  refunded: 70,
  charged_back: 80,
};

/** 状態 → ランク。 */
export function rankOf(status: SettlementStatus): number {
  return SETTLEMENT_RANK[status];
}

/** `settlement_status` の全値（到達性テストが使う）。 */
export const SETTLEMENT_STATUSES: readonly SettlementStatus[] = [
  "unpaid",
  "authorized",
  "paid",
  "refund_pending",
  "refunded",
  "charged_back",
];

/**
 * イベント種別 → 到達させたい状態。`null` は「請求の状態を動かさない」という意味で、
 * `failed` / `canceled` / `expired`（試行にだけ記録する）と、状態を後退させかねない
 * `refund_failed` / `dispute_resolved` / `unknown` が該当する。
 *
 * `dispute_resolved` を `null` にしているのは、紛争が幹事有利で解決しても
 * `charged_back`（80）から戻す手段が無い（前進のみ）ためである。事実は台帳に
 * `chargeback_reversal` として残し、請求の見え方は要対応フラグで扱う。
 */
export function targetStatusFor(kind: PaymentEventKind): SettlementStatus | null {
  switch (kind) {
    case "authorized":
      return "authorized";
    case "succeeded":
      return "paid";
    case "refund_pending":
      return "refund_pending";
    case "refunded":
      return "refunded";
    case "disputed":
      return "charged_back";
    case "failed":
    case "canceled":
    case "expired":
    case "refund_failed":
    case "dispute_resolved":
    case "unknown":
      return null;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled payment event kind: ${String(exhaustive)}`);
    }
  }
}

/** 試行（`payment_attempt.status`）にだけ記録して請求を動かさない種別か。 */
export function isAttemptOnlyKind(kind: PaymentEventKind): boolean {
  return kind === "failed" || kind === "canceled" || kind === "expired";
}

/** `from` から `to` へ前進できるか（同値・後退は false）。 */
export function canAdvance(fromRank: number, to: SettlementStatus): boolean {
  return fromRank < rankOf(to);
}
