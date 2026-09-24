/**
 * `participant` のリポジトリ層（§9 / §10 / task_014 scope）。
 *
 * ★ 所有者判定は必ず `assertEventOwnedByOrganizer`（`./events`）を経由する。
 *   `organizerUserId` を必須引数に持たない関数をここに増やさないこと（制約 I3・check_006）。
 *
 * ★ 状態（`RosterStatus`）は O-4 の 7 状態のうち、本タスクの時点で判定可能なものだけを
 *   算出する（`申告済み・幹事確認待ち` は `payment_self_report` を使う task_015 の scope）。
 *   `InvoiceRow` / `SummaryBar` はこの値をそのまま props として受け取る（DB を直接見ない）。
 */

import "server-only";

import type postgres from "postgres";

import { AppError, badRequest, type ErrorCode } from "@/lib/errors";

import { assertEventOwnedByOrganizer, MAX_PARTICIPANTS_PER_EVENT } from "./events";

// ============================================================================
// エラー
// ============================================================================

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;
const CODE_HAS_OPEN_ATTEMPT = "HAS_OPEN_ATTEMPT" as ErrorCode;
const CODE_LIMIT_EXCEEDED = "LIMIT_EXCEEDED" as ErrorCode;

export function participantNotFound(detail?: string): AppError {
  return new AppError(
    CODE_NOT_FOUND,
    404,
    "参加者が見つかりません。",
    detail === undefined ? {} : { detail },
  );
}

/** 409。生きた（未決着の）決済試行がある参加者を削除しようとした。 */
export function participantHasOpenAttempt(detail?: string): AppError {
  return new AppError(
    CODE_HAS_OPEN_ATTEMPT,
    409,
    "決済手続き中の参加者は削除できません。手続きの完了・失効をお待ちください。",
    detail === undefined ? {} : { detail },
  );
}

export function participantLimitExceeded(detail?: string): AppError {
  return new AppError(
    CODE_LIMIT_EXCEEDED,
    429,
    `名簿の上限（${MAX_PARTICIPANTS_PER_EVENT} 名）に達しています。`,
    detail === undefined ? {} : { detail },
  );
}

// ============================================================================
// トークン発行（作成時のみ。src/lib/db/repositories/events.ts と同じ暫定方針）
// ============================================================================

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

// ============================================================================
// 作成（一括登録）
// ============================================================================

const LABEL_MAX = 40;
const MAX_ITEMS_PER_REQUEST = MAX_PARTICIPANTS_PER_EVENT;

export interface CreateParticipantItemInput {
  readonly displayLabel: string;
}

export interface CreateParticipantsBody {
  readonly participants: readonly CreateParticipantItemInput[];
}

/** `POST /api/events/:id/participants` のボディ検証。純粋関数。 */
export function parseCreateParticipantsBody(body: unknown): CreateParticipantsBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const r = body as Record<string, unknown>;
  const list = r["participants"];
  if (!Array.isArray(list) || list.length === 0) {
    throw badRequest("participants must be a non-empty array");
  }
  if (list.length > MAX_ITEMS_PER_REQUEST) {
    throw badRequest(`participants must not exceed ${MAX_ITEMS_PER_REQUEST} items per request`);
  }

  const parsed: CreateParticipantItemInput[] = list.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw badRequest(`participants[${index}] must be an object`);
    }
    const displayLabel = (item as Record<string, unknown>)["displayLabel"];
    if (typeof displayLabel !== "string" || displayLabel.trim().length === 0 || displayLabel.length > LABEL_MAX) {
      throw badRequest(`participants[${index}].displayLabel is required (1-${LABEL_MAX} chars)`);
    }
    return { displayLabel: displayLabel.trim() };
  });

  return { participants: parsed };
}

export interface CreatedParticipant {
  readonly id: string;
  readonly displayLabel: string | null;
  /** 生の claim トークン。**この呼び出しでのみ**返る（DB にはハッシュのみ残る）。 */
  readonly claimToken: string;
}

interface ParticipantInsertRow {
  readonly id: string;
  readonly display_label: string | null;
}

export async function createParticipants(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  eventId: string,
  items: readonly CreateParticipantItemInput[],
): Promise<CreatedParticipant[]> {
  await assertEventOwnedByOrganizer(tx as unknown as postgres.Sql, organizerUserId, eventId);

  const existingCountRows = await tx<{ n: string }[]>`
    SELECT count(*)::text AS n FROM participant WHERE event_id = ${eventId} AND status = 'active'
  `;
  const existing = Number(existingCountRows[0]?.n ?? "0");
  if (existing + items.length > MAX_PARTICIPANTS_PER_EVENT) {
    throw participantLimitExceeded(
      `adding ${items.length} to existing ${existing} would exceed ${MAX_PARTICIPANTS_PER_EVENT}`,
    );
  }

  const created: CreatedParticipant[] = [];
  for (const item of items) {
    const token = randomToken128();
    const hash = await sha256(token);
    const rows = await tx<ParticipantInsertRow[]>`
      INSERT INTO participant (event_id, display_label, claim_token_hash)
      VALUES (${eventId}, ${item.displayLabel}, ${hash})
      RETURNING id, display_label
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error("participant insert returned no row");
    }
    created.push({ id: row.id, displayLabel: row.display_label, claimToken: token });
  }
  return created;
}

// ============================================================================
// 一覧（O-4。カーソルページング・フィルタ・検索）
// ============================================================================

export type ParticipantFilter = "all" | "unpaid";
export type ParticipantSort = "created_asc" | "created_desc" | "label_asc";

export interface ListParticipantsQuery {
  readonly filter: ParticipantFilter;
  readonly q: string | null;
  readonly cursor: string | null;
  readonly limit: number;
  readonly sort: ParticipantSort;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** クエリ文字列の検証。純粋関数。 */
export function parseListParticipantsQuery(searchParams: URLSearchParams): ListParticipantsQuery {
  const filterRaw = searchParams.get("filter") ?? "unpaid";
  if (filterRaw !== "all" && filterRaw !== "unpaid") {
    throw badRequest("filter must be 'all' or 'unpaid'");
  }

  const sortRaw = searchParams.get("sort") ?? "created_asc";
  if (sortRaw !== "created_asc" && sortRaw !== "created_desc" && sortRaw !== "label_asc") {
    throw badRequest("sort must be 'created_asc', 'created_desc', or 'label_asc'");
  }

  const limitRaw = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsedLimit = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIMIT) {
      throw badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    limit = parsedLimit;
  }

  const q = searchParams.get("q");
  const cursor = searchParams.get("cursor");

  return {
    filter: filterRaw,
    q: q === null || q.trim().length === 0 ? null : q.trim(),
    cursor: cursor === null || cursor.trim().length === 0 ? null : cursor.trim(),
    limit,
    sort: sortRaw,
  };
}

interface DecodedCursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * `createdAt` は Postgres の `timestamptz` を**テキストのまま**（`p.created_at::text`）で
 * 受け取ったものを渡すこと。JS の `Date` はミリ秒精度までしか保持できないため、
 * `Date#toISOString()` を経由するとマイクロ秒が切り捨てられる。`created_at DEFAULT now()` は
 * ほぼ必ずミリ秒未満の端数を持つため、切り捨てた値をカーソルに使うと「ページ境界の行が
 * 次ページにも再出現する」という実害のある重複が起きる（100 名超のページングで実測。
 * `tests/integration/events.test.ts` の「limit=30 で全 100 名を重複・欠落なく巡回できる」）。
 *
 * ★ カーソルを WHERE 句に戻すときは、SQL 側で `${cursor.createdAt}::text::timestamptz`
 *   と**二重にキャストする**こと（`::timestamptz` を直接は書かない）。`postgres`（npm）は
 *   `prepare: false` 下で「まず OID 未指定でパラメータを送る → サーバーの ParameterDescription
 *   で推論された型を読む → その型の組み込みシリアライザで再エンコードする」という経路を取り、
 *   推論結果が `timestamptz`（OID 1184）だと組み込み `date` シリアライザ
 *   （`node_modules/postgres/src/types.js` の `serialize: x => (x instanceof Date ? x :
 *   new Date(x)).toISOString()`）が使われる。渡しているのは既に文字列の `createdAt` なので
 *   `new Date(x)` を経由し、**ここでも同じミリ秒精度への切り捨てが起きる**
 *   （実測: `SELECT (${c}::timestamptz)::text` は `.929460` を `.929` に切り詰める）。
 *   切り詰められたカーソル値は実際の行の `created_at` より必ず**わずかに小さくなる**ため、
 *   `(created_at, id) > (cursor.createdAt, cursor.id)` の行タプル比較が `created_at` 側だけで
 *   常に真になり、`id` に関わらず全行が再び返る（カーソルが実質無効化される）。
 *   `${c}::text::timestamptz` と書くと、パラメータの推論型が `text`（OID 25。組み込み
 *   `string` シリアライザは恒等関数）になり、`::timestamptz` はサーバー側で文字列からそのまま
 *   マイクロ秒精度で変換される。`id`（uuid）側は組み込み型に `date` のような特別なシリアライザが
 *   無いため、この問題は起きない。
 */
function encodeCursor(createdAtText: string, id: string): string {
  const payload = JSON.stringify({ createdAt: createdAtText, id });
  return Buffer.from(payload, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): DecodedCursor {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badRequest("cursor is not valid");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>)["createdAt"] !== "string" ||
    typeof (payload as Record<string, unknown>)["id"] !== "string"
  ) {
    throw badRequest("cursor is not valid");
  }
  const record = payload as { createdAt: string; id: string };
  return { createdAt: record.createdAt, id: record.id };
}

export type RosterStatus = "unpaid" | "pending_checkout" | "paid" | "canceled";

export interface ParticipantRow {
  readonly id: string;
  readonly displayLabel: string | null;
  readonly rosterStatus: RosterStatus;
  readonly amountMinor: number | null;
  readonly autoDetected: boolean;
  readonly confirmationMethod: "automatic" | "manual_by_organizer" | null;
  readonly needsAttention: boolean;
}

export interface ListParticipantsResult {
  readonly items: ParticipantRow[];
  readonly nextCursor: string | null;
}

interface ParticipantListRow {
  readonly id: string;
  readonly display_label: string | null;
  /** カーソル生成専用。マイクロ秒精度を失わないよう `::text` で取得する（上の `encodeCursor` 参照）。 */
  readonly created_at_text: string;
  readonly amount_minor: number | null;
  readonly settlement_rank: number | null;
  readonly lifecycle_state: string | null;
  readonly auto_detected: boolean | null;
  readonly confirmation_method: string | null;
  readonly needs_attention: boolean | null;
  readonly has_open_attempt: boolean;
}

function deriveRosterStatus(row: ParticipantListRow): RosterStatus {
  if (row.lifecycle_state === "void") return "canceled";
  if (row.settlement_rank !== null && row.settlement_rank >= 40) return "paid";
  if (row.has_open_attempt) return "pending_checkout";
  return "unpaid";
}

export async function listParticipants(
  sql: postgres.Sql,
  organizerUserId: string,
  eventId: string,
  query: ListParticipantsQuery,
): Promise<ListParticipantsResult> {
  await assertEventOwnedByOrganizer(sql, organizerUserId, eventId);

  const cursor = query.cursor === null ? null : decodeCursor(query.cursor);
  const qLike = query.q === null ? null : `${query.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const whereParts: postgres.PendingQuery<postgres.Row[]>[] = [
    sql`p.event_id = ${eventId}`,
    sql`p.status = 'active'`,
  ];
  if (query.filter === "unpaid") {
    whereParts.push(sql`(i.id IS NULL OR i.settlement_rank < 40)`);
  }
  if (qLike !== null) {
    whereParts.push(sql`p.display_label ILIKE ${qLike} ESCAPE '\\'`);
  }
  if (cursor !== null) {
    // `::text::timestamptz`（二重キャスト）が必須。理由は encodeCursor 直前の docstring。
    if (query.sort === "created_desc") {
      whereParts.push(sql`(p.created_at, p.id) < (${cursor.createdAt}::text::timestamptz, ${cursor.id}::uuid)`);
    } else {
      whereParts.push(sql`(p.created_at, p.id) > (${cursor.createdAt}::text::timestamptz, ${cursor.id}::uuid)`);
    }
  }
  const whereClause = whereParts.reduce((acc, part) => sql`${acc} AND ${part}`);

  const orderClause =
    query.sort === "created_desc"
      ? sql`p.created_at DESC, p.id DESC`
      : query.sort === "label_asc"
        ? sql`p.display_label ASC NULLS LAST, p.created_at ASC, p.id ASC`
        : sql`p.created_at ASC, p.id ASC`;

  const rows = await sql<ParticipantListRow[]>`
    SELECT
      p.id, p.display_label, p.created_at::text AS created_at_text,
      i.amount_minor, i.settlement_rank, i.lifecycle_state, i.auto_detected, i.confirmation_method,
      i.needs_attention,
      (pa.id IS NOT NULL) AS has_open_attempt
    FROM participant p
    LEFT JOIN invoice i ON i.participant_id = p.id
    LEFT JOIN payment_attempt pa ON pa.invoice_id = i.id AND pa.is_open
    WHERE ${whereClause}
    ORDER BY ${orderClause}
    LIMIT ${query.limit + 1}
  `;

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeCursor(last.created_at_text, last.id) : null;

  return {
    items: page.map((row) => ({
      id: row.id,
      displayLabel: row.display_label,
      rosterStatus: deriveRosterStatus(row),
      amountMinor: row.amount_minor,
      autoDetected: row.auto_detected === true,
      confirmationMethod:
        row.confirmation_method === "automatic" || row.confirmation_method === "manual_by_organizer"
          ? row.confirmation_method
          : null,
      needsAttention: row.needs_attention === true,
    })),
    nextCursor,
  };
}

// ============================================================================
// 論理削除（DELETE .../participants/:pid）
// ============================================================================

export interface RemovedParticipant {
  readonly id: string;
  /** 既に removed だった場合は true（冪等な no-op）。 */
  readonly alreadyRemoved: boolean;
}

export async function removeParticipant(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  eventId: string,
  participantId: string,
): Promise<RemovedParticipant> {
  await assertEventOwnedByOrganizer(tx as unknown as postgres.Sql, organizerUserId, eventId);

  const rows = await tx<{ id: string; status: string }[]>`
    SELECT id, status FROM participant WHERE id = ${participantId} AND event_id = ${eventId} FOR UPDATE
  `;
  const participant = rows[0];
  if (participant === undefined) throw participantNotFound();

  const openAttemptRows = await tx<{ id: string }[]>`
    SELECT pa.id
    FROM payment_attempt pa
    JOIN invoice i ON i.id = pa.invoice_id
    WHERE i.participant_id = ${participantId} AND pa.is_open
    LIMIT 1
  `;
  if (openAttemptRows.length > 0) {
    throw participantHasOpenAttempt();
  }

  if (participant.status === "removed") {
    return { id: participant.id, alreadyRemoved: true };
  }

  await tx`UPDATE participant SET status = 'removed' WHERE id = ${participantId}`;
  return { id: participant.id, alreadyRemoved: false };
}
