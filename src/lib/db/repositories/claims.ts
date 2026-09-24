/**
 * 参加者側の claim・自己申告・追加リクエスト（§9 / P-1〜P-3 / task_015 scope）。
 *
 * ★ **イベント単位トークン（`joinToken`）は「候補一覧の表示まで」の権限**である（§9 認可の原則）。
 *   請求の閲覧・支払いには参加者単位の claim（`participant_claim` の未解放行）が要る。
 *   したがってこのモジュールの読み取り関数は、preview を除いてすべて
 *   `lineUserRef`（セッション由来）を必須引数に取り、SQL の `WHERE` で突き合わせる。
 *
 * ★ **同意の前に個人情報を出さない**（L6 / R-LAW-06 / check_086）。`buildEventPreview` は
 *   氏名も個別金額も返さない。`listCandidates` / `claimParticipant` は
 *   `assertParticipantConsent` を通った後でしか呼べない。
 *
 * ★ **自己申告は台帳に書かない**（R-UX-02 / check_087）。`selfReport` が触るのは
 *   `payment_self_report` だけで、`ledger_entry` にも `invoice.settlement_status` にも触れない。
 *
 * ★ **自由記述の受け皿を増やさない**（premortem P-07）。unclaim の理由も自己申告の方法も
 *   固定の enum で受け、text 列にも `audit_log.detail` にも人の自由入力を流し込まない。
 *   参加者が入力できる自由文字列は `participant.display_label`（既に保持期間の対象）だけ。
 */

import "server-only";

import type postgres from "postgres";

import { AppError, badRequest, type ErrorCode } from "@/lib/errors";
import { hashToken, isTokenShapeValid } from "@/lib/join-token";

import { MAX_PARTICIPANTS_PER_EVENT, assertEventOwnedByOrganizer } from "./events";
import { flagNeedsAttention } from "./invoices";
import { participantNotFound } from "./participants";

// ============================================================================
// エラー
// ============================================================================

const CODE_ALREADY_CLAIMED = "ALREADY_CLAIMED" as ErrorCode;
const CODE_NOT_CLAIMED = "NOT_CLAIMED" as ErrorCode;
const CODE_CONSENT_REQUIRED = "CONSENT_REQUIRED" as ErrorCode;
const CODE_CONFIRMATION_REQUIRED = "CONFIRMATION_REQUIRED" as ErrorCode;
const CODE_AWAITING_APPROVAL = "AWAITING_APPROVAL" as ErrorCode;
const CODE_LIMIT_EXCEEDED = "LIMIT_EXCEEDED" as ErrorCode;
const CODE_INVOICE_NOT_ISSUED = "INVOICE_NOT_ISSUED" as ErrorCode;

/** 409。その参加者は既に誰かに紐づいている／自分が既に別の参加者に紐づいている。 */
export function alreadyClaimed(detail?: string): AppError {
  return new AppError(
    CODE_ALREADY_CLAIMED,
    409,
    "この参加者はすでに受け取られています。幹事に連絡してください。",
    detail === undefined ? {} : { detail },
  );
}

/** 403。自分の請求がまだ紐づいていない。 */
export function notClaimed(detail?: string): AppError {
  return new AppError(
    CODE_NOT_CLAIMED,
    403,
    "まだあなたの請求が選ばれていません。招待リンクから選び直してください。",
    detail === undefined ? {} : { detail },
  );
}

/** 403。参加者側の同意（支払状況の開示）が未取得。 */
export function consentRequired(detail?: string): AppError {
  return new AppError(
    CODE_CONSENT_REQUIRED,
    403,
    "先に内容へのご同意が必要です。",
    detail === undefined ? {} : { detail },
  );
}

/** 400。名簿から選ぶ経路では確認ダイアログの通過が必須（P-2）。 */
export function confirmationRequired(detail?: string): AppError {
  return new AppError(
    CODE_CONFIRMATION_REQUIRED,
    400,
    "お名前の確認が必要です。",
    detail === undefined ? {} : { detail },
  );
}

/** 409。追加リクエストが幹事に承認されるまで claim できない。 */
export function awaitingApproval(detail?: string): AppError {
  return new AppError(
    CODE_AWAITING_APPROVAL,
    409,
    "幹事の確認をお待ちください。",
    detail === undefined ? {} : { detail },
  );
}

/** 429。名簿の上限。 */
export function rosterLimitExceeded(detail?: string): AppError {
  return new AppError(
    CODE_LIMIT_EXCEEDED,
    429,
    "この名簿はこれ以上増やせません。幹事に連絡してください。",
    detail === undefined ? {} : { detail },
  );
}

/** 409。請求がまだ発行されていない。 */
export function invoiceNotIssued(detail?: string): AppError {
  return new AppError(
    CODE_INVOICE_NOT_ISSUED,
    409,
    "まだ請求が発行されていません。幹事の発行をお待ちください。",
    detail === undefined ? {} : { detail },
  );
}

// ============================================================================
// 同意（L6 / check_086）
// ============================================================================

/** 参加者側で必須の同意。`consent_log.consent_kind` の CHECK に合わせる。 */
export const PARTICIPANT_CONSENT_KIND = "organizer_disclosure";

/** 同意した文言のバージョン。文言そのものは画面（P-1）が持つ。 */
export const PARTICIPANT_CONSENT_TEXT_VERSION = "participant-disclosure:v1";

/** 同意を追記する（同じ人が 2 回同意しても履歴として 2 行残る。撤回・上書きはしない）。 */
export async function recordParticipantConsent(
  tx: postgres.TransactionSql,
  userId: string,
): Promise<void> {
  await tx`
    INSERT INTO consent_log (user_id, consent_kind, text_version)
    VALUES (${userId}, ${PARTICIPANT_CONSENT_KIND}, ${PARTICIPANT_CONSENT_TEXT_VERSION})
  `;
}

/** 同意済みでなければ 403。候補一覧・claim の前段で必ず呼ぶ。 */
export async function assertParticipantConsent(
  sql: postgres.Sql,
  userId: string,
): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM consent_log
    WHERE user_id = ${userId} AND consent_kind = ${PARTICIPANT_CONSENT_KIND}
    LIMIT 1
  `;
  if (rows.length === 0) throw consentRequired("participant disclosure consent is missing");
}

// ============================================================================
// セッション → line_user_ref
// ============================================================================

export interface UserRef {
  readonly lineUserRef: Buffer;
  readonly pepperVersion: number;
}

/**
 * `app_user.id`（セッションの subject）から `line_user_ref` を引く。
 * `participant_claim` はこの擬似化済み参照値で人を表す（生の LINE userId は保存しない。§7-5）。
 */
export async function loadUserRef(sql: postgres.Sql, userId: string): Promise<UserRef> {
  const rows = await sql<{ line_user_ref: Buffer; pepper_version: number }[]>`
    SELECT line_user_ref, pepper_version FROM app_user WHERE id = ${userId}
  `;
  const row = rows[0];
  if (row === undefined) throw notClaimed("session subject does not exist");
  return { lineUserRef: row.line_user_ref, pepperVersion: row.pepper_version };
}

// ============================================================================
// preview（GET /api/e/preview。セッション不要・同意前）
// ============================================================================

/**
 * 同意前に見せてよい最小情報（§8-2 P-1 / check_086）。
 *
 * ★ この型に `amount` / `status` というキーを作らない。氏名・個別金額・支払状況は
 *   1 つも含めない（`tests/integration/idor.test.ts` が型と実データの両方で検査する）。
 */
export interface EventPreview {
  readonly title: string;
  readonly organizerLabel: string;
  /** ISO 文字列。締切。 */
  readonly collectByAt: string | null;
  /** 名簿の人数（誰が居るかは出さない）。 */
  readonly participantCount: number;
  /** 金額のレンジ。個別の金額ではない。請求が 1 件も無ければイベントの既定金額から作る。 */
  readonly amountRangeMinor: { readonly min: number; readonly max: number } | null;
  /** 現金受付の可否（イベントの設定であり、個人の情報ではない）。 */
  readonly allowCash: boolean;
}

export interface PreviewSourceEvent {
  readonly id: string;
  readonly title: string;
  readonly organizerLabel: string;
  readonly collectByAt: Date | null;
  readonly defaultAmountMinor: number | null;
  readonly allowCash: boolean;
}

/** preview の本体。`resolveEventByJoinToken` が返したイベントをそのまま渡す。 */
export async function buildEventPreview(
  sql: postgres.Sql,
  event: PreviewSourceEvent,
): Promise<EventPreview> {
  const rows = await sql<
    { participant_count: string; min_amount: number | null; max_amount: number | null }[]
  >`
    SELECT
      count(p.id)::text AS participant_count,
      min(i.amount_minor) AS min_amount,
      max(i.amount_minor) AS max_amount
    FROM participant p
    LEFT JOIN invoice i ON i.participant_id = p.id AND i.lifecycle_state = 'active'
    WHERE p.event_id = ${event.id}
      AND p.status = 'active'
      AND (p.claim_token_hash IS NOT NULL OR p.confirmed_by_organizer_at IS NOT NULL)
  `;
  const row = rows[0];
  const min = row?.min_amount ?? null;
  const max = row?.max_amount ?? null;

  const range =
    min !== null && max !== null
      ? { min, max }
      : event.defaultAmountMinor === null
        ? null
        : { min: event.defaultAmountMinor, max: event.defaultAmountMinor };

  return {
    title: event.title,
    organizerLabel: event.organizerLabel,
    collectByAt: event.collectByAt === null ? null : event.collectByAt.toISOString(),
    participantCount: Number(row?.participant_count ?? "0"),
    amountRangeMinor: range,
    allowCash: event.allowCash,
  };
}

// ============================================================================
// 候補一覧（GET /api/e/candidates。同意後）
// ============================================================================

export interface CandidateRow {
  readonly id: string;
  readonly displayLabel: string | null;
}

/**
 * まだ誰にも claim されていない参加者のうち、幹事が氏名の共有を許可した行だけを返す。
 *
 * ★ 返すのは `id` と `displayLabel` だけ。金額・支払状況は含めない（check_002）。
 * ★ `name_visibility='organizer_only'`（既定）の行は返さない（R-LAW-06）。
 * ★ 追加リクエスト由来の未承認の行も返さない。
 */
export async function listCandidates(
  sql: postgres.Sql,
  eventId: string,
  limit = 100,
): Promise<CandidateRow[]> {
  const rows = await sql<{ id: string; display_label: string | null }[]>`
    SELECT p.id, p.display_label
    FROM participant p
    WHERE p.event_id = ${eventId}
      AND p.status = 'active'
      AND p.name_visibility = 'participants'
      AND (p.claim_token_hash IS NOT NULL OR p.confirmed_by_organizer_at IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM participant_claim c
        WHERE c.participant_id = p.id AND c.released_at IS NULL
      )
    ORDER BY p.display_label ASC, p.created_at ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({ id: row.id, displayLabel: row.display_label }));
}

// ============================================================================
// claim（POST /api/e/claim）
// ============================================================================

export interface ClaimInput {
  /** 名簿から選ぶ経路。確認ダイアログ（`confirmed`）が必須。 */
  readonly participantId?: string;
  /** 個別リンクの経路。自動確定（確認ダイアログ不要）。 */
  readonly claimToken?: string;
  /** P-2 の確認ダイアログを通ったか。`participantId` 経路では `true` 必須。 */
  readonly confirmed?: boolean;
}

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** `POST /api/e/claim` のボディ検証。純粋関数。 */
export function parseClaimBody(body: unknown): ClaimInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const participantId = record["participantId"];
  const claimToken = record["claimToken"];
  const confirmed = record["confirmed"];

  const hasParticipantId = participantId !== undefined && participantId !== null;
  const hasClaimToken = claimToken !== undefined && claimToken !== null;
  if (hasParticipantId === hasClaimToken) {
    throw badRequest("exactly one of participantId / claimToken is required");
  }
  if (confirmed !== undefined && typeof confirmed !== "boolean") {
    throw badRequest("confirmed must be a boolean");
  }

  if (hasParticipantId) {
    if (typeof participantId !== "string" || !UUID_SHAPE.test(participantId)) {
      throw badRequest("participantId must be a uuid");
    }
    if (confirmed !== true) {
      throw confirmationRequired("confirmed must be true when claiming by participantId");
    }
    return { participantId, confirmed: true };
  }

  if (typeof claimToken !== "string" || !isTokenShapeValid(claimToken)) {
    throw badRequest("claimToken has an unexpected shape");
  }
  return { claimToken, confirmed: confirmed === true };
}

export interface ClaimResult {
  readonly participantId: string;
  readonly displayLabel: string | null;
  /** 個別リンク経由なら `claim_token`、名簿選択なら `roster`。 */
  readonly via: "claim_token" | "roster";
}

interface ClaimTargetRow {
  readonly id: string;
  readonly event_id: string;
  readonly display_label: string | null;
  readonly status: string;
  readonly claim_token_hash: Buffer | null;
  readonly confirmed_by_organizer_at: Date | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * 参加者を自分に紐づける。
 *
 * ★ **別イベントの participant / claimToken には到達できない。** どちらの経路も
 *   `event_id = ${eventId}` を SQL の `WHERE` に持ち、`eventId` は `X-Join-Token` から
 *   解決したイベントしか渡らない（Route Handler）。
 * ★ 二重 claim は `participant_claim` の部分一意インデックス 2 本で DB が止める。
 *   アプリ側の事前チェックはユーザー向けの応答を良くするためだけに置き、最終的な判定は
 *   UNIQUE 違反（23505）→ 409 `ALREADY_CLAIMED` で行う（競合しても壊れない）。
 */
export async function claimParticipant(
  tx: postgres.TransactionSql,
  params: {
    readonly eventId: string;
    readonly lineUserRef: Buffer;
    readonly pepperVersion: number;
    readonly input: ClaimInput;
  },
): Promise<ClaimResult> {
  const { eventId, lineUserRef, pepperVersion, input } = params;

  let target: ClaimTargetRow | undefined;
  let via: "claim_token" | "roster";

  if (input.claimToken !== undefined) {
    const hash = await hashToken(input.claimToken);
    const rows = await tx<ClaimTargetRow[]>`
      SELECT id, event_id, display_label, status, claim_token_hash, confirmed_by_organizer_at
      FROM participant
      WHERE claim_token_hash = ${hash} AND event_id = ${eventId}
      FOR UPDATE
    `;
    target = rows[0];
    via = "claim_token";
  } else {
    if (input.confirmed !== true) {
      throw confirmationRequired("confirmed must be true when claiming by participantId");
    }
    const rows = await tx<ClaimTargetRow[]>`
      SELECT id, event_id, display_label, status, claim_token_hash, confirmed_by_organizer_at
      FROM participant
      WHERE id = ${input.participantId ?? null} AND event_id = ${eventId}
      FOR UPDATE
    `;
    target = rows[0];
    via = "roster";
  }

  if (target === undefined) throw participantNotFound();
  if (target.status !== "active") throw participantNotFound("participant is removed");
  if (target.claim_token_hash === null && target.confirmed_by_organizer_at === null) {
    // 追加リクエストの行。幹事が承認するまで claim できない（check_088）。
    throw awaitingApproval("participant is a pending add request");
  }

  // 同じ人が同じ参加者をもう一度 claim した場合は成功として扱う（応答を取りこぼした後の
  // 再送で 409 を返さないため）。他人の claim・別の参加者への claim は下の UNIQUE で落ちる。
  const mine = await tx<{ participant_id: string }[]>`
    SELECT participant_id FROM participant_claim
    WHERE event_id = ${eventId} AND line_user_ref = ${lineUserRef} AND released_at IS NULL
    LIMIT 1
  `;
  const existing = mine[0];
  if (existing !== undefined) {
    if (existing.participant_id === target.id) {
      return { participantId: target.id, displayLabel: target.display_label, via };
    }
    throw alreadyClaimed("this user already claimed another participant in this event");
  }

  try {
    await tx`
      INSERT INTO participant_claim (event_id, participant_id, line_user_ref, pepper_version)
      VALUES (${eventId}, ${target.id}, ${lineUserRef}, ${pepperVersion})
    `;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw alreadyClaimed("participant or user already has an active claim in this event");
    }
    throw error;
  }

  return { participantId: target.id, displayLabel: target.display_label, via };
}

// ============================================================================
// 追加リクエスト（POST /api/e/request-add）と承認（POST .../approve-add）
// ============================================================================

const LABEL_MAX = 40;

export interface RequestAddInput {
  readonly displayLabel: string;
}

export function parseRequestAddBody(body: unknown): RequestAddInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const displayLabel = (body as Record<string, unknown>)["displayLabel"];
  if (
    typeof displayLabel !== "string" ||
    displayLabel.trim().length === 0 ||
    displayLabel.length > LABEL_MAX
  ) {
    throw badRequest(`displayLabel is required (1-${LABEL_MAX} chars)`);
  }
  return { displayLabel: displayLabel.trim() };
}

export interface RequestAddResult {
  readonly participantId: string;
  readonly displayLabel: string | null;
  /** 幹事の承認待ち。承認されるまで claim も請求発行の対象にもならない。 */
  readonly awaitingApproval: true;
}

/**
 * 名簿への追加をリクエストする（幹事承認制。P-2「候補 0 件」）。
 *
 * ★ 作る行は `claim_token_hash IS NULL` かつ `confirmed_by_organizer_at IS NULL`。
 *   幹事が登録した参加者は必ず `claim_token_hash` を持つ（task_014 の `createParticipants`）ので、
 *   この 2 つが同時に NULL であることが「未承認の追加リクエスト」の印になる。
 */
export async function requestAdd(
  tx: postgres.TransactionSql,
  eventId: string,
  input: RequestAddInput,
): Promise<RequestAddResult> {
  const countRows = await tx<{ n: string }[]>`
    SELECT count(*)::text AS n FROM participant WHERE event_id = ${eventId} AND status = 'active'
  `;
  if (Number(countRows[0]?.n ?? "0") >= MAX_PARTICIPANTS_PER_EVENT) {
    throw rosterLimitExceeded(`roster already has ${MAX_PARTICIPANTS_PER_EVENT} participants`);
  }

  const rows = await tx<{ id: string; display_label: string | null }[]>`
    INSERT INTO participant (event_id, display_label)
    VALUES (${eventId}, ${input.displayLabel})
    RETURNING id, display_label
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("participant insert returned no row");
  return { participantId: row.id, displayLabel: row.display_label, awaitingApproval: true };
}

export interface ApprovedParticipant {
  readonly participantId: string;
  readonly displayLabel: string | null;
  readonly confirmedAt: Date;
}

/** 幹事が追加リクエストを承認する。承認後は名簿の一員になり、claim も請求発行もできる。 */
export async function approveAdd(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  eventId: string,
  participantId: string,
  now: Date = new Date(),
): Promise<ApprovedParticipant> {
  await assertEventOwnedByOrganizer(tx as unknown as postgres.Sql, organizerUserId, eventId);

  const rows = await tx<
    { id: string; display_label: string | null; confirmed_by_organizer_at: Date | null }[]
  >`
    UPDATE participant
    SET confirmed_by_organizer_at = COALESCE(confirmed_by_organizer_at, ${now})
    WHERE id = ${participantId} AND event_id = ${eventId} AND status = 'active'
    RETURNING id, display_label, confirmed_by_organizer_at
  `;
  const row = rows[0];
  if (row === undefined || row.confirmed_by_organizer_at === null) throw participantNotFound();
  return {
    participantId: row.id,
    displayLabel: row.display_label,
    confirmedAt: row.confirmed_by_organizer_at,
  };
}

// ============================================================================
// unclaim（POST /api/events/:id/participants/:pid/unclaim）
// ============================================================================

/**
 * 幹事が unclaim する理由。**自由記述にしない**（premortem P-07。人の氏名が
 * 保持期間の対象外の text 列へ流れ込むのを構造的に防ぐ）。
 */
export const UNCLAIM_REASONS = ["wrong_person", "duplicate", "left_event", "other"] as const;
export type UnclaimReason = (typeof UNCLAIM_REASONS)[number];

export interface UnclaimInput {
  readonly reason: UnclaimReason;
}

export function parseUnclaimBody(body: unknown): UnclaimInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const reason = (body as Record<string, unknown>)["reason"];
  if (typeof reason !== "string" || !UNCLAIM_REASONS.includes(reason as UnclaimReason)) {
    throw badRequest(`reason must be one of ${UNCLAIM_REASONS.join(" / ")}`);
  }
  return { reason: reason as UnclaimReason };
}

export interface UnclaimResult {
  readonly participantId: string;
  /** 解放した claim があったか（無ければ冪等な no-op）。 */
  readonly released: boolean;
  /** 支払済みの請求を持つ参加者を解放したので要対応を立てた（check_085）。 */
  readonly needsAttention: boolean;
}

/**
 * 幹事が参加者の claim を解除する。解除後は本人が claim し直せる（部分一意が空くため）。
 *
 * ★ 支払済み（`settlement_rank >= 40`）の請求を持つ参加者を解除した場合は
 *   `invoice.needs_attention` を立てる（O-9 に上がる。check_085）。ランクは動かさない（W3）。
 */
export async function unclaimParticipant(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  eventId: string,
  participantId: string,
  now: Date = new Date(),
): Promise<UnclaimResult> {
  await assertEventOwnedByOrganizer(tx as unknown as postgres.Sql, organizerUserId, eventId);

  const participantRows = await tx<{ id: string }[]>`
    SELECT id FROM participant WHERE id = ${participantId} AND event_id = ${eventId} FOR UPDATE
  `;
  if (participantRows[0] === undefined) throw participantNotFound();

  const released = await tx<{ id: string }[]>`
    UPDATE participant_claim
    SET released_at = ${now}, released_reason = 'organizer_unclaim'
    WHERE participant_id = ${participantId} AND event_id = ${eventId} AND released_at IS NULL
    RETURNING id
  `;

  const settledRows = await tx<{ id: string }[]>`
    SELECT id FROM invoice
    WHERE participant_id = ${participantId} AND event_id = ${eventId} AND settlement_rank >= 40
  `;
  for (const invoice of settledRows) {
    await flagNeedsAttention(tx, invoice.id);
  }

  return {
    participantId,
    released: released.length > 0,
    needsAttention: settledRows.length > 0,
  };
}

// ============================================================================
// 自分の請求（GET /api/e/me）
// ============================================================================

/** P-3 の状態。**申告済みを支払済みと同じ扱いにしない**（R-UX-02 / check_087）。 */
export const PARTICIPANT_INVOICE_STATES = [
  "awaiting_approval",
  "not_issued",
  "unpaid",
  "pending_checkout",
  "self_reported",
  "paid",
  "expired",
  "voided",
] as const;
export type ParticipantInvoiceState = (typeof PARTICIPANT_INVOICE_STATES)[number];

export interface MyInvoiceView {
  readonly eventId: string;
  readonly eventTitle: string;
  readonly organizerLabel: string;
  readonly collectByAt: Date | null;
  readonly participantId: string;
  readonly displayLabel: string | null;
  readonly invoiceId: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly state: ParticipantInvoiceState;
  readonly autoDetected: boolean;
  readonly confirmationMethod: "automatic" | "manual_by_organizer" | "mixed" | null;
  readonly selfReportedAt: Date | null;
}

interface MyInvoiceRow {
  readonly event_id: string;
  readonly event_title: string;
  readonly organizer_label: string;
  readonly collect_by_at: Date | null;
  readonly participant_id: string;
  readonly display_label: string | null;
  readonly participant_claim_token_hash: Buffer | null;
  readonly confirmed_by_organizer_at: Date | null;
  readonly invoice_id: string | null;
  readonly amount_minor: number | null;
  readonly currency: string | null;
  readonly settlement_rank: number | null;
  readonly lifecycle_state: string | null;
  readonly auto_detected: boolean | null;
  readonly confirmation_method: string | null;
  readonly has_open_attempt: boolean;
  readonly self_reported_at: Date | null;
}

/** 状態の導出。順番に意味がある（取消 > 支払済み > 手続き中 > 申告済み > 期限切れ > 未払い）。 */
export function deriveParticipantInvoiceState(
  row: {
    readonly claimTokenHash: Buffer | null;
    readonly confirmedByOrganizerAt: Date | null;
    readonly invoiceId: string | null;
    readonly settlementRank: number | null;
    readonly lifecycleState: string | null;
    readonly hasOpenAttempt: boolean;
    readonly selfReportedAt: Date | null;
    readonly collectByAt: Date | null;
  },
  now: Date = new Date(),
): ParticipantInvoiceState {
  if (row.claimTokenHash === null && row.confirmedByOrganizerAt === null) {
    return "awaiting_approval";
  }
  if (row.invoiceId === null) return "not_issued";
  if (row.lifecycleState === "void") return "voided";
  if (row.settlementRank !== null && row.settlementRank >= 40) return "paid";
  if (row.hasOpenAttempt) return "pending_checkout";
  if (row.selfReportedAt !== null) return "self_reported";
  if (row.collectByAt !== null && row.collectByAt.getTime() <= now.getTime()) return "expired";
  return "unpaid";
}

/**
 * 自分（`lineUserRef`）が claim した参加者の請求だけを返す（check_002）。
 *
 * 他人の行は SQL の時点で到達しない: `participant_claim.line_user_ref = ${lineUserRef}`
 * かつ `released_at IS NULL` の行からしか participant へ辿らない。
 */
export async function getMyInvoice(
  sql: postgres.Sql,
  eventId: string,
  lineUserRef: Buffer,
  now: Date = new Date(),
): Promise<MyInvoiceView> {
  const rows = await sql<MyInvoiceRow[]>`
    SELECT
      e.id AS event_id, e.title AS event_title, e.organizer_label, e.collect_by_at,
      p.id AS participant_id, p.display_label,
      p.claim_token_hash AS participant_claim_token_hash, p.confirmed_by_organizer_at,
      i.id AS invoice_id, i.amount_minor, i.currency, i.settlement_rank, i.lifecycle_state,
      i.auto_detected, i.confirmation_method,
      EXISTS (SELECT 1 FROM payment_attempt pa WHERE pa.invoice_id = i.id AND pa.is_open)
        AS has_open_attempt,
      (SELECT max(r.reported_at) FROM payment_self_report r WHERE r.invoice_id = i.id)
        AS self_reported_at
    FROM participant_claim c
    JOIN participant p ON p.id = c.participant_id
    JOIN event e ON e.id = c.event_id
    LEFT JOIN invoice i ON i.participant_id = p.id AND i.event_id = e.id
    WHERE c.event_id = ${eventId}
      AND c.line_user_ref = ${lineUserRef}
      AND c.released_at IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) throw notClaimed("no active claim for this user in this event");

  const state = deriveParticipantInvoiceState(
    {
      claimTokenHash: row.participant_claim_token_hash,
      confirmedByOrganizerAt: row.confirmed_by_organizer_at,
      invoiceId: row.invoice_id,
      settlementRank: row.settlement_rank,
      lifecycleState: row.lifecycle_state,
      hasOpenAttempt: row.has_open_attempt,
      selfReportedAt: row.self_reported_at,
      collectByAt: row.collect_by_at,
    },
    now,
  );

  return {
    eventId: row.event_id,
    eventTitle: row.event_title,
    organizerLabel: row.organizer_label,
    collectByAt: row.collect_by_at,
    participantId: row.participant_id,
    displayLabel: row.display_label,
    invoiceId: row.invoice_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    state,
    autoDetected: row.auto_detected === true,
    confirmationMethod:
      row.confirmation_method === "automatic" ||
      row.confirmation_method === "manual_by_organizer" ||
      row.confirmation_method === "mixed"
        ? row.confirmation_method
        : null,
    selfReportedAt: row.self_reported_at,
  };
}

// ============================================================================
// 自己申告（POST /api/e/self-report）
// ============================================================================

/** `payment_self_report.method` の CHECK と同じ集合。 */
export const SELF_REPORT_METHODS = ["paypay_p2p", "cash", "bank_transfer", "other"] as const;
export type SelfReportMethod = (typeof SELF_REPORT_METHODS)[number];

export interface SelfReportInput {
  readonly method: SelfReportMethod;
}

/**
 * `POST /api/e/self-report` のボディ検証。
 *
 * ★ `note`（自由記述）を**受け取らない**。premortem P-07 の対応案どおり、保持期間・
 *   擬似匿名化の対象外になる自由記述の受け皿を Phase 1 では増やさない。
 */
export function parseSelfReportBody(body: unknown): SelfReportInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "method") throw badRequest("request body has unexpected fields");
  }
  const method = record["method"];
  if (typeof method !== "string" || !SELF_REPORT_METHODS.includes(method as SelfReportMethod)) {
    throw badRequest(`method must be one of ${SELF_REPORT_METHODS.join(" / ")}`);
  }
  return { method: method as SelfReportMethod };
}

export interface SelfReportResult {
  readonly invoiceId: string;
  readonly reportedAt: Date;
}

/**
 * 参加者の自己申告を記録する。
 *
 * ★ **`ledger_entry` には 1 行も書かない。`invoice` のランクも動かさない**
 *   （R-UX-02 / check_087 / W3）。触るのは `payment_self_report` だけである。
 */
export async function selfReport(
  tx: postgres.TransactionSql,
  params: {
    readonly eventId: string;
    readonly lineUserRef: Buffer;
    readonly input: SelfReportInput;
  },
): Promise<SelfReportResult> {
  const invoiceId = await findClaimedInvoiceId(tx, params.eventId, params.lineUserRef);

  const rows = await tx<{ id: string; reported_at: Date }[]>`
    INSERT INTO payment_self_report (invoice_id, reported_by_user_ref, method)
    VALUES (${invoiceId}, ${params.lineUserRef}, ${params.input.method})
    RETURNING id, reported_at
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("payment_self_report insert returned no row");
  return { invoiceId, reportedAt: row.reported_at };
}

// ============================================================================
// 支払手段なし（POST /api/e/cannot-pay）
// ============================================================================

export interface CannotPayResult {
  readonly invoiceId: string;
}

/**
 * 「この方法では払えない」を要対応として上げる（P-4 / check_088）。
 *
 * O-9（要対応インボックス）の表示は task_021 の担当。ここでは `invoice.needs_attention` を
 * 立てるところまでを行う。ランクは動かさない（W3）。理由の分類は呼び出し側が
 * `audit_log.action` に固定文字列で残す（自由記述にしない。premortem P-07）。
 */
export async function reportCannotPay(
  tx: postgres.TransactionSql,
  params: { readonly eventId: string; readonly lineUserRef: Buffer },
): Promise<CannotPayResult> {
  const invoiceId = await findClaimedInvoiceId(tx, params.eventId, params.lineUserRef);
  await flagNeedsAttention(tx, invoiceId);
  return { invoiceId };
}

/** claim 済みの自分の請求 ID を引く。claim が無ければ 403、請求が未発行なら 409。 */
async function findClaimedInvoiceId(
  tx: postgres.TransactionSql,
  eventId: string,
  lineUserRef: Buffer,
): Promise<string> {
  const rows = await tx<{ invoice_id: string | null }[]>`
    SELECT i.id AS invoice_id
    FROM participant_claim c
    JOIN participant p ON p.id = c.participant_id
    LEFT JOIN invoice i ON i.participant_id = p.id AND i.event_id = c.event_id
    WHERE c.event_id = ${eventId}
      AND c.line_user_ref = ${lineUserRef}
      AND c.released_at IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) throw notClaimed("no active claim for this user in this event");
  if (row.invoice_id === null) throw invoiceNotIssued();
  return row.invoice_id;
}
