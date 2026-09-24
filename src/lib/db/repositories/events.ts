/**
 * `event` のリポジトリ層（§9 / §10 / task_014 scope）。
 *
 * ★ **所有者判定をリクエストから取らない**（§9「認可の原則」/ 制約 I3・check_006）。
 *   ここに並ぶ関数はすべて `organizerUserId` を必須引数に持ち、SQL の `WHERE` で
 *   突き合わせる。呼び出し側（Route Handler）がセッションから取った値だけを渡すこと。
 *
 * ★ `errors.ts` の `ERROR_CODES` は task_014 の `files_to_modify` に含まれないため、
 *   本ファイルで新規に必要な HTTP エラー（403 / 404 / 409 / 429）は、既存の `AppError` を
 *   `code` への型アサーションで構成する（`src/lib/idempotency.ts` と同じ方針）。
 */

import "server-only";

import type postgres from "postgres";

import { AppError, badRequest, type ErrorCode } from "@/lib/errors";
import {
  DEFAULT_PROVIDER_KEY,
  estimateFeeForEvent,
  type FeeEstimateResult,
} from "@/lib/payments/capabilities-static";

// ============================================================================
// エラー
// ============================================================================

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;
const CODE_FORBIDDEN = "FORBIDDEN" as ErrorCode;
const CODE_LIMIT_EXCEEDED = "LIMIT_EXCEEDED" as ErrorCode;
const CODE_STATUS_CONFLICT = "EVENT_STATUS_CONFLICT" as ErrorCode;

export function eventNotFound(detail?: string): AppError {
  return new AppError(
    CODE_NOT_FOUND,
    404,
    "イベントが見つかりません。",
    detail === undefined ? {} : { detail },
  );
}

export function eventForbidden(detail?: string): AppError {
  return new AppError(
    CODE_FORBIDDEN,
    403,
    "このイベントを操作する権限がありません。",
    detail === undefined ? {} : { detail },
  );
}

export function organizerLimitExceeded(detail?: string): AppError {
  return new AppError(
    CODE_LIMIT_EXCEEDED,
    429,
    "ご利用中のイベント数・金額の上限に達しています。しばらくしてからお試しください。",
    detail === undefined ? {} : { detail },
  );
}

export function eventStatusConflict(detail?: string): AppError {
  return new AppError(
    CODE_STATUS_CONFLICT,
    409,
    "この操作は現在のイベントの状態では行えません。",
    detail === undefined ? {} : { detail },
  );
}

// ============================================================================
// 幹事あたりの上限（暫定値。R-LAW-10 / R-OPS-05。恒久的な悪用対策の総合ゲートは task_021 が
// tests/integration/abuse-limits.test.ts で確定する。ここでは「作成そのものを止める」最小限の
// 歯止めとして、Phase 1 の利用規模を大きく上回らない値を置く）
// ============================================================================

/** 幹事 1 人が同時に持てる非キャンセル済みイベント数の上限。 */
export const MAX_ACTIVE_EVENTS_PER_ORGANIZER = 20;

/** イベント 1 件あたりの参加者数上限（R-UX-03「1 イベント 100 名の上限をサーバー側で明示」）。 */
export const MAX_PARTICIPANTS_PER_EVENT = 100;

/**
 * `createEvent` の COUNT → 上限判定 → INSERT を organizer 単位で直列化する
 * ブロッキング advisory lock の名前空間（敵対レビュー GPT F-1 是正）。
 *
 * 修正前は COUNT と INSERT の間に排他が無く、異なる `Idempotency-Key`（＝別の予約行）を持つ
 * 並行リクエストが同じ「残り枠」を同時に読めたため、`MAX_ACTIVE_EVENTS_PER_ORGANIZER` を
 * 超えて作成できた（`docs/review-log/task_014.json` F-1 の repro。静的追跡・未実測とされていたが
 * `tests/integration/events.test.ts` で実行して実際に再現した）。`src/lib/audit.ts` の
 * `AUDIT_CHAIN_LOCK_KEY` と同じ方針（トランザクションスコープの `pg_advisory_xact_lock`。
 * 接続プーラを挟んでも残留しない）で、organizer_user_id 単位に直列化する。第 2 引数は
 * `hashtext()`（Postgres 組み込み・int4 を返す）に `organizer_user_id::text` を渡して得る
 * ため、この定数は「イベント作成ロック」という名前空間を表す固定値でしかない
 * （`AUDIT_CHAIN_LOCK_KEY` とは異なる名前空間なので衝突しない）。
 */
const EVENT_CREATE_LOCK_NAMESPACE = 8_314_201;

// ============================================================================
// 招待トークンの発行（作成時のみ）
// ============================================================================

/**
 * イベント作成時に招待トークン（`join_token`）を発行する。
 *
 * ★ これは**発行専用**の暫定実装である。検証・定数時間比較・ローテーションを含む
 *   正式なライフサイクルは task_015 の `src/lib/join-token.ts` が提供する
 *   （`docs/task-list.json` task_015 `files_to_create`）。`event.join_token_hash` は
 *   `NOT NULL` のため、作成時点でこの最小限のミント処理が必要になる。
 */
function randomToken128(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(input: string): Promise<Buffer> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(digest);
}

async function mintJoinToken(): Promise<{ token: string; hash: Buffer }> {
  const token = randomToken128();
  const hash = await sha256(token);
  return { token, hash };
}

// ============================================================================
// 入力検証
// ============================================================================

const TITLE_MAX = 100;
const LABEL_MAX = 40;
const VENUE_MAX = 200;
const OFFERING_MAX = 400;
const AMOUNT_MIN = 1;
const AMOUNT_MAX = 1_000_000;

export interface CreateEventInput {
  readonly title: string;
  readonly organizerLabel: string;
  readonly eventAt: Date | null;
  readonly venue: string | null;
  readonly offering: string | null;
  readonly defaultAmountMinor: number | null;
  readonly collectByAt: Date | null;
  readonly minorsIncluded: boolean;
  readonly allowCash: boolean;
  /** O-3 の手数料提示への同意チェック。`true` でなければ作成できない。 */
  readonly feeDisclosureAccepted: boolean;
}

function parseOptionalDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest(`${field} must be an ISO date string`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`${field} is not a valid date`);
  return parsed;
}

function parseOptionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    throw badRequest(`${field} must be a non-empty string up to ${max} chars`);
  }
  return trimmed;
}

/** `POST /api/events` のボディ検証。純粋関数（DB に触れない）でユニットテスト可能にする。 */
export function parseCreateEventBody(body: unknown): CreateEventInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const r = body as Record<string, unknown>;

  const titleRaw = r["title"];
  if (typeof titleRaw !== "string" || titleRaw.trim().length === 0 || titleRaw.length > TITLE_MAX) {
    throw badRequest(`title is required (1-${TITLE_MAX} chars)`);
  }

  const labelRaw = r["organizerLabel"];
  if (typeof labelRaw !== "string" || labelRaw.trim().length === 0 || labelRaw.length > LABEL_MAX) {
    throw badRequest(`organizerLabel is required (1-${LABEL_MAX} chars)`);
  }

  const minorsIncluded = r["minorsIncluded"];
  if (typeof minorsIncluded !== "boolean") {
    throw badRequest("minorsIncluded must be a boolean (explicit declaration required)");
  }

  const feeDisclosureAccepted = r["feeDisclosureAccepted"];
  if (feeDisclosureAccepted !== true) {
    throw badRequest("feeDisclosureAccepted must be true before creating an event");
  }

  const allowCashRaw = r["allowCash"];
  const allowCash = allowCashRaw === undefined ? false : allowCashRaw;
  if (typeof allowCash !== "boolean") {
    throw badRequest("allowCash must be a boolean");
  }

  const eventAt = parseOptionalDate(r["eventAt"], "eventAt");
  const collectByAt = parseOptionalDate(r["collectByAt"], "collectByAt");
  const venue = parseOptionalString(r["venue"], "venue", VENUE_MAX);
  const offering = parseOptionalString(r["offering"], "offering", OFFERING_MAX);

  const amountRaw = r["defaultAmountMinor"];
  let defaultAmountMinor: number | null = null;
  if (amountRaw !== undefined && amountRaw !== null) {
    if (
      typeof amountRaw !== "number" ||
      !Number.isInteger(amountRaw) ||
      amountRaw < AMOUNT_MIN ||
      amountRaw > AMOUNT_MAX
    ) {
      throw badRequest(`defaultAmountMinor must be an integer between ${AMOUNT_MIN} and ${AMOUNT_MAX}`);
    }
    defaultAmountMinor = amountRaw;
  }

  return {
    title: titleRaw.trim(),
    organizerLabel: labelRaw.trim(),
    eventAt,
    venue,
    offering,
    defaultAmountMinor,
    collectByAt,
    minorsIncluded,
    allowCash,
    feeDisclosureAccepted,
  };
}

// ============================================================================
// 作成
// ============================================================================

export interface CreatedEvent {
  readonly id: string;
  readonly title: string;
  readonly organizerLabel: string;
  readonly status: string;
  readonly eventAt: Date | null;
  readonly collectByAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateEventResult {
  readonly event: CreatedEvent;
  /** 生のトークン。**この呼び出しでのみ**呼び出し側へ渡る（DB にはハッシュしか残らない）。 */
  readonly joinToken: string;
}

interface EventInsertRow {
  readonly id: string;
  readonly title: string;
  readonly organizer_label: string;
  readonly status: string;
  readonly event_at: Date | null;
  readonly collect_by_at: Date | null;
  readonly created_at: Date;
}

export async function createEvent(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  input: CreateEventInput,
): Promise<CreateEventResult> {
  // GPT F-1 是正: COUNT の前に organizer 単位でブロッキングロックを取り、並行リクエストが
  // 同じ残り枠を同時に読まないようにする（上のコメント参照）。
  await tx`SELECT pg_advisory_xact_lock(${EVENT_CREATE_LOCK_NAMESPACE}::int4, hashtext((${organizerUserId})::text))`;

  const activeCountRows = await tx<{ n: string }[]>`
    SELECT count(*)::text AS n FROM event
    WHERE organizer_user_id = ${organizerUserId} AND status <> 'canceled'
  `;
  if (Number(activeCountRows[0]?.n ?? "0") >= MAX_ACTIVE_EVENTS_PER_ORGANIZER) {
    throw organizerLimitExceeded(
      `max active events per organizer (${MAX_ACTIVE_EVENTS_PER_ORGANIZER}) reached`,
    );
  }

  const { token, hash } = await mintJoinToken();

  const inserted = await tx<EventInsertRow[]>`
    INSERT INTO event (
      organizer_user_id, title, organizer_label, event_at, venue, offering,
      default_amount_minor, collect_by_at, minors_included, allow_cash, join_token_hash
    ) VALUES (
      ${organizerUserId}, ${input.title}, ${input.organizerLabel}, ${input.eventAt}, ${input.venue},
      ${input.offering}, ${input.defaultAmountMinor}, ${input.collectByAt}, ${input.minorsIncluded},
      ${input.allowCash}, ${hash}
    )
    RETURNING id, title, organizer_label, status, event_at, collect_by_at, created_at
  `;
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("event insert returned no row");
  }

  return {
    event: {
      id: row.id,
      title: row.title,
      organizerLabel: row.organizer_label,
      status: row.status,
      eventAt: row.event_at,
      collectByAt: row.collect_by_at,
      createdAt: row.created_at,
    },
    joinToken: token,
  };
}

// ============================================================================
// 所有権の確認（他リポジトリからも再利用する）
// ============================================================================

export interface OwnedEventRef {
  readonly id: string;
  readonly status: string;
  readonly defaultAmountMinor: number | null;
}

/** イベントが存在し、かつ `organizerUserId` の所有であることを確認する。403 / 404 を投げる。 */
export async function assertEventOwnedByOrganizer(
  sql: postgres.Sql,
  organizerUserId: string,
  eventId: string,
): Promise<OwnedEventRef> {
  const rows = await sql<
    { id: string; organizer_user_id: string; status: string; default_amount_minor: number | null }[]
  >`
    SELECT id, organizer_user_id, status, default_amount_minor FROM event WHERE id = ${eventId}
  `;
  const row = rows[0];
  if (row === undefined) throw eventNotFound();
  if (row.organizer_user_id !== organizerUserId) throw eventForbidden();
  return { id: row.id, status: row.status, defaultAmountMinor: row.default_amount_minor };
}

// ============================================================================
// 一覧（O-2）
// ============================================================================

export interface ListedEvent {
  readonly id: string;
  readonly title: string;
  readonly organizerLabel: string;
  readonly status: string;
  readonly eventAt: Date | null;
  readonly collectByAt: Date | null;
  readonly participantCount: number;
  readonly unpaidCount: number;
  readonly needsAttentionCount: number;
}

interface ListedEventRow {
  readonly id: string;
  readonly title: string;
  readonly organizer_label: string;
  readonly status: string;
  readonly event_at: Date | null;
  readonly collect_by_at: Date | null;
  readonly participant_count: string;
  readonly unpaid_count: string;
  readonly needs_attention_count: string;
}

export async function listOrganizerEvents(
  sql: postgres.Sql,
  organizerUserId: string,
): Promise<ListedEvent[]> {
  const rows = await sql<ListedEventRow[]>`
    SELECT
      e.id, e.title, e.organizer_label, e.status, e.event_at, e.collect_by_at,
      count(p.id) FILTER (WHERE p.status = 'active')::text AS participant_count,
      count(p.id) FILTER (
        WHERE p.status = 'active' AND (i.id IS NULL OR i.settlement_rank < 40)
      )::text AS unpaid_count,
      count(i.id) FILTER (WHERE i.needs_attention)::text AS needs_attention_count
    FROM event e
    LEFT JOIN participant p ON p.event_id = e.id
    LEFT JOIN invoice i ON i.participant_id = p.id
    -- 敵対レビュー GPT F-5（round2）: 作成上限（MAX_ACTIVE_EVENTS_PER_ORGANIZER）は
    -- status <> 'canceled' の件数しか数えないため canceled イベントには上限が無く、
    -- ここで canceled も含めて created_at DESC LIMIT 100 すると、canceled を積み重ねる
    -- 通常操作だけで進行中のイベントが一覧の 100 件から押し出されて到達不能になっていた
    -- （続きを取る手段も無い）。canceled を除外すれば非 canceled は
    -- MAX_ACTIVE_EVENTS_PER_ORGANIZER（20）が上限なので LIMIT 100 に必ず収まる。
    WHERE e.organizer_user_id = ${organizerUserId} AND e.status <> 'canceled'
    GROUP BY e.id
    ORDER BY e.created_at DESC
    LIMIT 100
  `;

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    organizerLabel: row.organizer_label,
    status: row.status,
    eventAt: row.event_at,
    collectByAt: row.collect_by_at,
    participantCount: Number(row.participant_count),
    unpaidCount: Number(row.unpaid_count),
    needsAttentionCount: Number(row.needs_attention_count),
  }));
}

// ============================================================================
// サマリ（O-4 ヘッダ相当。GET /api/events/:id）
// ============================================================================

export interface EventBreakdown {
  readonly unpaid: number;
  readonly paidAutomatic: number;
  readonly paidManual: number;
  /** `confirmation_method='mixed'` の支払済み件数（敵対レビュー GPT F-6）。0 のことが多い。 */
  readonly paidMixed: number;
  readonly needsAttention: number;
}

export interface EventSummary {
  readonly id: string;
  readonly title: string;
  readonly organizerLabel: string;
  readonly status: string;
  readonly eventAt: Date | null;
  readonly venue: string | null;
  readonly offering: string | null;
  readonly defaultAmountMinor: number | null;
  readonly collectByAt: Date | null;
  readonly allowCash: boolean;
  readonly minorsIncluded: boolean;
  readonly providerKey: string;
  readonly participantCount: number;
  readonly breakdown: EventBreakdown;
  readonly feeEstimate: FeeEstimateResult;
  readonly createdAt: Date;
}

interface EventDetailRow {
  readonly id: string;
  readonly organizer_user_id: string;
  readonly title: string;
  readonly organizer_label: string;
  readonly status: string;
  readonly event_at: Date | null;
  readonly venue: string | null;
  readonly offering: string | null;
  readonly default_amount_minor: number | null;
  readonly collect_by_at: Date | null;
  readonly allow_cash: boolean;
  readonly minors_included: boolean;
  readonly provider_key: string;
  readonly created_at: Date;
}

export async function getEventSummary(
  sql: postgres.Sql,
  organizerUserId: string,
  eventId: string,
): Promise<EventSummary> {
  const rows = await sql<EventDetailRow[]>`SELECT * FROM event WHERE id = ${eventId}`;
  const event = rows[0];
  if (event === undefined) throw eventNotFound();
  if (event.organizer_user_id !== organizerUserId) throw eventForbidden();

  const breakdownRows = await sql<
    {
      participant_count: string;
      unpaid: string;
      paid_automatic: string;
      paid_manual: string;
      paid_mixed: string;
      needs_attention: string;
    }[]
  >`
    SELECT
      count(p.id)::text AS participant_count,
      count(*) FILTER (
        WHERE p.status = 'active' AND (i.id IS NULL OR i.settlement_rank < 40)
      )::text AS unpaid,
      count(*) FILTER (WHERE i.settlement_rank >= 40 AND i.confirmation_method = 'automatic')::text
        AS paid_automatic,
      count(*) FILTER (WHERE i.settlement_rank >= 40 AND i.confirmation_method = 'manual_by_organizer')::text
        AS paid_manual,
      -- 敵対レビュー GPT F-6: mixed（複数の入金経路が混在した請求）を数えないと、
      -- 「支払済み」であるにもかかわらずどちらのカウントにも入らず要対応にもならないまま消える。
      count(*) FILTER (WHERE i.settlement_rank >= 40 AND i.confirmation_method = 'mixed')::text
        AS paid_mixed,
      count(*) FILTER (WHERE i.needs_attention)::text AS needs_attention
    FROM participant p
    LEFT JOIN invoice i ON i.participant_id = p.id
    WHERE p.event_id = ${eventId} AND p.status = 'active'
  `;
  const breakdown = breakdownRows[0];
  const participantCount = Number(breakdown?.participant_count ?? "0");

  const feeEstimate = estimateFeeForEvent({
    providerKey: event.provider_key ?? DEFAULT_PROVIDER_KEY,
    defaultAmountMinor: event.default_amount_minor,
    // 敵対レビュー GPT F-5: participantCount===0 を null（＝未定）に丸めると、estimateFeeForEvent
    // が「参加者数未定なら 1 人分」で計算し、参加者ゼロのイベントに正の受取見込額が付いていた。
    // 0 は「0 人」として渡す（null は本当に未定の O-3 作成前だけに残す）。
    participantCountEstimate: participantCount,
  });

  return {
    id: event.id,
    title: event.title,
    organizerLabel: event.organizer_label,
    status: event.status,
    eventAt: event.event_at,
    venue: event.venue,
    offering: event.offering,
    defaultAmountMinor: event.default_amount_minor,
    collectByAt: event.collect_by_at,
    allowCash: event.allow_cash,
    minorsIncluded: event.minors_included,
    providerKey: event.provider_key,
    participantCount,
    breakdown: {
      unpaid: Number(breakdown?.unpaid ?? "0"),
      paidAutomatic: Number(breakdown?.paid_automatic ?? "0"),
      paidManual: Number(breakdown?.paid_manual ?? "0"),
      paidMixed: Number(breakdown?.paid_mixed ?? "0"),
      needsAttention: Number(breakdown?.needs_attention ?? "0"),
    },
    feeEstimate,
    createdAt: event.created_at,
  };
}

// ============================================================================
// 更新（title / collectByAt / status）
// ============================================================================

const EVENT_STATUSES = ["draft", "collecting", "closed", "canceled"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** 許可される状態遷移（同一状態への指定は常に許可＝no-op）。 */
const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  draft: ["collecting", "canceled"],
  collecting: ["closed", "canceled"],
  closed: [],
  canceled: [],
};

export interface UpdateEventInput {
  readonly title?: string;
  readonly collectByAt?: Date | null;
  readonly status?: EventStatus;
}

export function parseUpdateEventBody(body: unknown): UpdateEventInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const r = body as Record<string, unknown>;
  const result: { title?: string; collectByAt?: Date | null; status?: EventStatus } = {};

  if ("title" in r) {
    const title = r["title"];
    if (typeof title !== "string" || title.trim().length === 0 || title.length > TITLE_MAX) {
      throw badRequest(`title must be a non-empty string up to ${TITLE_MAX} chars`);
    }
    result.title = title.trim();
  }

  if ("collectByAt" in r) {
    result.collectByAt = parseOptionalDate(r["collectByAt"], "collectByAt");
  }

  if ("status" in r) {
    const status = r["status"];
    if (typeof status !== "string" || !EVENT_STATUSES.includes(status as EventStatus)) {
      throw badRequest(`status must be one of ${EVENT_STATUSES.join(" / ")}`);
    }
    result.status = status as EventStatus;
  }

  if (Object.keys(result).length === 0) {
    throw badRequest("at least one of title / collectByAt / status must be provided");
  }

  return result;
}

export interface UpdatedEvent {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly collectByAt: Date | null;
}

export async function updateEvent(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  eventId: string,
  input: UpdateEventInput,
): Promise<UpdatedEvent> {
  const rows = await tx<{ id: string; organizer_user_id: string; status: string }[]>`
    SELECT id, organizer_user_id, status FROM event WHERE id = ${eventId} FOR UPDATE
  `;
  const current = rows[0];
  if (current === undefined) throw eventNotFound();
  if (current.organizer_user_id !== organizerUserId) throw eventForbidden();

  if (input.status !== undefined && input.status !== current.status) {
    const allowed = ALLOWED_STATUS_TRANSITIONS[current.status as EventStatus] ?? [];
    if (!allowed.includes(input.status)) {
      throw eventStatusConflict(`cannot transition from '${current.status}' to '${input.status}'`);
    }
  }

  const updated = await tx<{ id: string; title: string; status: string; collect_by_at: Date | null }[]>`
    UPDATE event
    SET
      title = COALESCE(${input.title ?? null}, title),
      collect_by_at = CASE WHEN ${"collectByAt" in input} THEN ${input.collectByAt ?? null} ELSE collect_by_at END,
      status = COALESCE(${input.status ?? null}, status)
    WHERE id = ${eventId}
    RETURNING id, title, status, collect_by_at
  `;
  const row = updated[0];
  if (row === undefined) {
    throw new Error("event update returned no row");
  }
  return { id: row.id, title: row.title, status: row.status, collectByAt: row.collect_by_at };
}
