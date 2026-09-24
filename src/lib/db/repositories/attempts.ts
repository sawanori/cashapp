/**
 * `payment_attempt` の読み書き（§9「`applyToLedger` の不変条件」/ §10-2）。
 *
 * ★ **突合の基準額は `payment_attempt.amount_minor`**（参加者に実際に提示した金額）であり、
 *   `invoice.amount_minor` ではない（premortem §2-3）。請求額を後から変えても、
 *   すでに提示済みの試行の基準はずれない。
 *
 * ★ 試行の状態も**前進のみ**にする。`succeeded` を受けた試行が、あとから届いた
 *   `expired` で巻き戻ってはいけない（check_018）。`is_open` は生成列なので、
 *   「まだ開いている試行にだけ終端状態を書く」条件で守れる。
 */

import "server-only";

import type postgres from "postgres";

type SqlLike = postgres.ISql;

/** `payment_attempt.status` の CHECK と同じ集合。 */
export type PaymentAttemptStatus =
  | "created"
  | "redirected"
  | "authorized"
  | "succeeded"
  | "failed"
  | "canceled"
  | "expired"
  | "refunded";

export interface PaymentAttemptRow {
  readonly id: string;
  readonly invoiceId: string;
  readonly providerKey: string;
  readonly providerBindingId: string;
  readonly externalRef: string;
  /** 突合の基準額。 */
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: PaymentAttemptStatus;
  readonly isOpen: boolean;
}

interface AttemptDbRow {
  readonly id: string;
  readonly invoice_id: string;
  readonly provider_key: string;
  readonly provider_binding_id: string;
  readonly external_ref: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly status: string;
  readonly is_open: boolean;
}

function toRow(row: AttemptDbRow): PaymentAttemptRow {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    providerKey: row.provider_key,
    providerBindingId: row.provider_binding_id,
    externalRef: row.external_ref,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status as PaymentAttemptStatus,
    isOpen: row.is_open,
  };
}

/**
 * `(provider_key, external_ref)` で試行を引き、**行ロックを取る**（§3-4）。
 * 見つからなければ `null`（呼び出し側が `orphan` として扱う）。
 *
 * ロックを取るのは、同じ試行に対する 2 本の Webhook が同時に届いたときに
 * 「両方が `settlement_rank` を読んでから両方が書く」競合を潰すためである。
 */
export async function lockAttemptByProviderRef(
  tx: postgres.TransactionSql,
  providerKey: string,
  externalRef: string,
): Promise<PaymentAttemptRow | null> {
  const rows = await tx<AttemptDbRow[]>`
    SELECT id, invoice_id, provider_key, provider_binding_id, external_ref,
           amount_minor, currency, status, is_open
    FROM payment_attempt
    WHERE provider_key = ${providerKey} AND external_ref = ${externalRef}
    FOR UPDATE
  `;
  const row = rows[0];
  return row === undefined ? null : toRow(row);
}

/**
 * 試行の状態を進める。**まだ開いている試行にだけ**書く（前進のみ）。
 * `succeeded` / `failed` / `canceled` / `expired` / `refunded` は生成列 `is_open` を
 * false にするので、以後どの遷移も掛からなくなる（check_018 の「順序逆転で戻らない」）。
 * 戻り値は実際に書き換えたかどうか。
 */
export async function advanceOpenAttempt(
  sql: SqlLike,
  attemptId: string,
  status: PaymentAttemptStatus,
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE payment_attempt
    SET status = ${status}
    WHERE id = ${attemptId} AND is_open
    RETURNING id
  `;
  return rows.length === 1;
}
