/**
 * `invoice` のリポジトリ層（§9 / O-6・O-6.5 / task_015 scope）。
 *
 * ★ 所有者判定は `assertEventOwnedByOrganizer`（`./events`）を必ず経由する。
 *   `organizerUserId` を必須引数に持たない関数をここに増やさない（制約 I3 / check_006）。
 *
 * ★ **状態ランクを前進させる処理はここに置かない**（W3 / task_018 の `applyToLedger` の担当）。
 *   本モジュールが `invoice` に書くのは「発行（INSERT）」「金額の訂正」「取消（lifecycle_state）」
 *   「要対応フラグ」だけで、`settlement_status` には触れない。
 *
 * ★ 発行は `(event_id, participant_id)` の UNIQUE（`invoice_event_participant_uk`）に
 *   `ON CONFLICT DO NOTHING` を重ねる。既発行はスキップし（O-6「既発行スキップ」）、
 *   二重発行は DB 側で構造的に起きない。
 */

import "server-only";

import type postgres from "postgres";

import { AppError, badRequest, type ErrorCode } from "@/lib/errors";

import { assertEventOwnedByOrganizer } from "./events";

// ============================================================================
// エラー
// ============================================================================

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;
const CODE_INVOICE_NOT_EDITABLE = "INVOICE_NOT_EDITABLE" as ErrorCode;
const CODE_VOID_NOT_ALLOWED = "VOID_NOT_ALLOWED" as ErrorCode;
const CODE_AMOUNT_NOT_SET = "AMOUNT_NOT_SET" as ErrorCode;

export function invoiceNotFound(detail?: string): AppError {
  return new AppError(
    CODE_NOT_FOUND,
    404,
    "請求が見つかりません。",
    detail === undefined ? {} : { detail },
  );
}

/** 409。手続きが始まっている・入金が付いている請求の金額は変えられない。 */
export function invoiceNotEditable(detail?: string): AppError {
  return new AppError(
    CODE_INVOICE_NOT_EDITABLE,
    409,
    "この請求の金額は変更できません。",
    detail === undefined ? {} : { detail },
  );
}

/** 409。支払済み（rank >= 40）または既に取消済みの請求は取り消せない。 */
export function voidNotAllowed(detail?: string): AppError {
  return new AppError(
    CODE_VOID_NOT_ALLOWED,
    409,
    "この請求は取り消せません。",
    detail === undefined ? {} : { detail },
  );
}

/** 400。既定金額が未設定のイベントでは請求を発行できない。 */
export function amountNotSet(detail?: string): AppError {
  return new AppError(
    CODE_AMOUNT_NOT_SET,
    400,
    "金額が設定されていません。イベントの既定金額を入力してください。",
    detail === undefined ? {} : { detail },
  );
}

// ============================================================================
// 金額の範囲（`supabase/migrations/0001_init.sql` の CHECK と同じ）
// ============================================================================

export const AMOUNT_MIN_MINOR = 1;
export const AMOUNT_MAX_MINOR = 1_000_000;

/**
 * 「幹事が名簿に載せた参加者」を表す述語の説明。
 *
 * 参加者からの追加リクエスト（`POST /api/e/request-add`）で作られた行は、幹事が承認するまで
 * 名簿の一員ではない。幹事が登録した行は必ず `claim_token_hash`（個別リンク）を持つのに対し、
 * 追加リクエストの行は持たない（`src/lib/db/repositories/claims.ts` の `requestAdd`）。
 * したがって「承認済み」は `claim_token_hash IS NOT NULL OR confirmed_by_organizer_at IS NOT NULL`
 * で判定できる。両リポジトリでこの条件を使う（文言はそれぞれの SQL 内に直接書く）。
 */
export const ROSTER_APPROVED_NOTE =
  "claim_token_hash IS NOT NULL OR confirmed_by_organizer_at IS NOT NULL";

// ============================================================================
// 発行（POST /api/events/:id/invoices）
// ============================================================================

export interface IssueInvoicesInput {
  /** O-6.5 の 2 段階確認を通ったことを示すフラグ。`true` でなければ発行しない。 */
  readonly confirmed: true;
}

/** `POST /api/events/:id/invoices` のボディ検証。純粋関数。 */
export function parseIssueInvoicesBody(body: unknown): IssueInvoicesInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const confirmed = (body as Record<string, unknown>)["confirmed"];
  if (confirmed !== true) {
    throw badRequest("confirmed must be true (O-6.5 two-step confirmation)");
  }
  return { confirmed: true };
}

export interface IssueInvoicesResult {
  readonly eventId: string;
  readonly amountMinor: number;
  /** 今回新しく作られた請求の件数。 */
  readonly created: number;
  /** 既に請求があったためスキップした件数。 */
  readonly skipped: number;
}

/**
 * 名簿の参加者に一括で請求を発行する。金額はイベントの既定金額。
 *
 * - 対象は `status='active'` かつ承認済み（上の `ROSTER_APPROVED_NOTE`）の参加者。
 * - 既に請求がある参加者は `ON CONFLICT DO NOTHING` でスキップする（O-6）。
 * - 取消済み（`lifecycle_state='void'`）の請求は復活させない。UNIQUE があるため
 *   再発行もされない（取り消した請求を作り直す導線は Phase 1 では持たない）。
 */
export async function issueInvoices(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  eventId: string,
): Promise<IssueInvoicesResult> {
  const owned = await assertEventOwnedByOrganizer(tx as unknown as postgres.Sql, organizerUserId, eventId);
  const amountMinor = owned.defaultAmountMinor;
  if (amountMinor === null) {
    throw amountNotSet("event has no default amount");
  }
  if (
    !Number.isInteger(amountMinor) ||
    amountMinor < AMOUNT_MIN_MINOR ||
    amountMinor > AMOUNT_MAX_MINOR
  ) {
    throw amountNotSet("event default amount is out of range");
  }

  const targetRows = await tx<{ n: string }[]>`
    SELECT count(*)::text AS n
    FROM participant p
    WHERE p.event_id = ${eventId}
      AND p.status = 'active'
      AND (p.claim_token_hash IS NOT NULL OR p.confirmed_by_organizer_at IS NOT NULL)
  `;
  const targets = Number(targetRows[0]?.n ?? "0");

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO invoice (event_id, participant_id, amount_minor)
    SELECT p.event_id, p.id, ${amountMinor}
    FROM participant p
    WHERE p.event_id = ${eventId}
      AND p.status = 'active'
      AND (p.claim_token_hash IS NOT NULL OR p.confirmed_by_organizer_at IS NOT NULL)
    ON CONFLICT (event_id, participant_id) DO NOTHING
    RETURNING id
  `;

  return {
    eventId,
    amountMinor,
    created: inserted.length,
    skipped: targets - inserted.length,
  };
}

// ============================================================================
// 金額の訂正（PATCH /api/invoices/:id）
// ============================================================================

export interface UpdateInvoiceInput {
  readonly amountMinor: number;
}

export function parseUpdateInvoiceBody(body: unknown): UpdateInvoiceInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const amountMinor = (body as Record<string, unknown>)["amountMinor"];
  if (
    typeof amountMinor !== "number" ||
    !Number.isInteger(amountMinor) ||
    amountMinor < AMOUNT_MIN_MINOR ||
    amountMinor > AMOUNT_MAX_MINOR
  ) {
    throw badRequest(
      `amountMinor must be an integer between ${AMOUNT_MIN_MINOR} and ${AMOUNT_MAX_MINOR}`,
    );
  }
  return { amountMinor };
}

export interface InvoiceRef {
  readonly id: string;
  readonly eventId: string;
  readonly participantId: string;
  readonly amountMinor: number;
  readonly settlementRank: number;
  readonly lifecycleState: string;
  readonly needsAttention: boolean;
}

interface InvoiceOwnedRow {
  readonly id: string;
  readonly event_id: string;
  readonly participant_id: string;
  readonly amount_minor: number;
  readonly settlement_rank: number;
  readonly lifecycle_state: string;
  readonly needs_attention: boolean;
  readonly organizer_user_id: string;
}

/**
 * 請求を 1 件、幹事の所有確認つきで取り出して行ロックを掛ける。
 * 存在しない／他人の請求はどちらも 404（存在を教えない）。
 */
async function lockOwnedInvoice(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  invoiceId: string,
): Promise<InvoiceRef> {
  const rows = await tx<InvoiceOwnedRow[]>`
    SELECT i.id, i.event_id, i.participant_id, i.amount_minor, i.settlement_rank,
           i.lifecycle_state, i.needs_attention, e.organizer_user_id
    FROM invoice i
    JOIN event e ON e.id = i.event_id
    WHERE i.id = ${invoiceId} AND e.organizer_user_id = ${organizerUserId}
    FOR UPDATE OF i
  `;
  const row = rows[0];
  if (row === undefined) throw invoiceNotFound();
  return {
    id: row.id,
    eventId: row.event_id,
    participantId: row.participant_id,
    amountMinor: row.amount_minor,
    settlementRank: row.settlement_rank,
    lifecycleState: row.lifecycle_state,
    needsAttention: row.needs_attention,
  };
}

async function hasOpenAttempt(tx: postgres.TransactionSql, invoiceId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM payment_attempt WHERE invoice_id = ${invoiceId} AND is_open LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * 金額を訂正する。`settlement_rank = 0`（未払い）かつ生きた決済試行が無いときだけ（§9）。
 * それ以外は 409 `INVOICE_NOT_EDITABLE`。
 */
export async function updateInvoiceAmount(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  invoiceId: string,
  input: UpdateInvoiceInput,
): Promise<InvoiceRef> {
  const invoice = await lockOwnedInvoice(tx, organizerUserId, invoiceId);
  if (invoice.lifecycleState !== "active") {
    throw invoiceNotEditable("invoice is voided");
  }
  if (invoice.settlementRank !== 0) {
    throw invoiceNotEditable("invoice has advanced beyond unpaid");
  }
  if (await hasOpenAttempt(tx, invoiceId)) {
    throw invoiceNotEditable("invoice has an open payment attempt");
  }

  const rows = await tx<{ amount_minor: number }[]>`
    UPDATE invoice SET amount_minor = ${input.amountMinor}
    WHERE id = ${invoiceId} AND settlement_rank = 0 AND lifecycle_state = 'active'
    RETURNING amount_minor
  `;
  const row = rows[0];
  if (row === undefined) throw invoiceNotEditable("invoice changed concurrently");
  return { ...invoice, amountMinor: row.amount_minor };
}

// ============================================================================
// 取消（POST /api/invoices/:id/void）
// ============================================================================

/**
 * 請求を取り消す。`settlement_rank < 40` かつ `lifecycle_state='active'` のときだけ（§9）。
 *
 * ★ Webhook 経路からは呼ばない（check_008）。呼び出し元は幹事のセッションを持つ
 *   Route Handler だけで、`src/app/api/webhooks/**` からの import は存在しない。
 */
export async function voidInvoice(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  invoiceId: string,
  now: Date = new Date(),
): Promise<InvoiceRef> {
  const invoice = await lockOwnedInvoice(tx, organizerUserId, invoiceId);
  if (invoice.lifecycleState !== "active") {
    throw voidNotAllowed("invoice is already voided");
  }
  if (invoice.settlementRank >= 40) {
    throw voidNotAllowed("invoice has been settled");
  }

  const rows = await tx<{ id: string; lifecycle_state: string }[]>`
    UPDATE invoice
    SET lifecycle_state = 'void', voided_at = ${now}
    WHERE id = ${invoiceId} AND lifecycle_state = 'active' AND settlement_rank < 40
    RETURNING id, lifecycle_state
  `;
  const row = rows[0];
  if (row === undefined) throw voidNotAllowed("invoice changed concurrently");
  return { ...invoice, lifecycleState: row.lifecycle_state };
}

// ============================================================================
// 要対応フラグ（unclaim / cannot-pay から使う）
// ============================================================================

/** `needs_attention` を立てる。ランクには触れない（W3）。 */
export async function flagNeedsAttention(
  tx: postgres.TransactionSql,
  invoiceId: string,
): Promise<void> {
  await tx`UPDATE invoice SET needs_attention = true WHERE id = ${invoiceId}`;
}
