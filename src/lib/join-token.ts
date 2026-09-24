/**
 * 招待トークン（イベント単位の `joinToken`）と参加者単位の `claimToken`（§7-4 / §9 / task_015）。
 *
 * ★ **長寿命の識別子を URL パスに置かない**（制約 X-ID / §7-4「識別子規約」）。
 *   `joinToken` はヘッダ `X-Join-Token` または POST ボディでのみ運ぶ。本モジュールは
 *   `readJoinTokenHeader()` しか入口を用意しない（パスから読む関数を作らない）。
 *
 * ★ **生のトークンを保存しない。** DB に入るのは SHA-256 ハッシュ（bytea）だけで、
 *   生の値は発行した 1 回の応答にしか現れない。したがって
 *   `GET /api/events/:id/join-token` は**生のトークンを返せない**（メタ情報だけを返し、
 *   配布用リンクを取り直すには `POST /api/events/:id/rotate-join-token` を使う）。
 *   これは task_014 の残課題 C-014-6（冪等再送で joinToken を失う）の設計判断でもある。
 *
 * ★ 強度は 128 ビット（`JOIN_TOKEN_BYTES = 16`）。`crypto.getRandomValues` の CSPRNG を使い、
 *   base64url で 22 文字に符号化する。`tests/unit/join-token.test.ts` がビット長を実測する。
 *
 * ★ 寿命（`event.join_token_expires_at`）とローテーション（`event.join_token_version`）を持つ。
 *   期限切れ・ローテーション後の旧トークンはどちらも **404**（存在を区別して教えない）。
 *
 * ★ 比較は定数時間で行う。ハッシュの一致は SQL の等値比較で引くが、引いた行の
 *   `join_token_hash` と提示値のハッシュを `timingSafeEqualBytes` でもう一度突き合わせる
 *   （SQL 側の比較が将来 LIKE や前方一致に書き換わっても、ここで落ちる）。
 *
 * ★ ログに生のトークンを出さない。本モジュールは `logEvent` を呼ばず、例外の `detail` にも
 *   トークンを入れない（`docs/acceptance-checks.json` check_084「ログに平文 0 件」）。
 */

import "server-only";

import type postgres from "postgres";

import { AppError, type ErrorCode } from "@/lib/errors";

// ============================================================================
// 定数
// ============================================================================

/** 乱数のバイト数。128 ビット（§9「認可の原則」）。 */
export const JOIN_TOKEN_BYTES = 16;

/** 上のバイト数をビットで表したもの。テストはこの値が 128 以上であることを確かめる。 */
export const JOIN_TOKEN_BITS = JOIN_TOKEN_BYTES * 8;

/** 参加者単位の claim トークンも同じ強度にする。 */
export const CLAIM_TOKEN_BYTES = JOIN_TOKEN_BYTES;

/** 招待トークンの既定の寿命（日）。ローテーションのたびに取り直す。 */
export const JOIN_TOKEN_TTL_DAYS = 90;

/** 参加者向けエンドポイントがトークンを受け取るヘッダ名（パスには置かない）。 */
export const JOIN_TOKEN_HEADER = "X-Join-Token";

/** 受け付けるトークンの形。base64url のみ。長さ上限はログ・DB への無駄な負荷を避けるため。 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

// ============================================================================
// エラー（`errors.ts` は本タスクの files_to_modify に無いため、既存 AppError を構成する）
// ============================================================================

const CODE_JOIN_TOKEN_INVALID = "JOIN_TOKEN_INVALID" as ErrorCode;

/**
 * 404。トークンが不正・期限切れ・ローテーション済み・イベントが無い、のいずれでも同じ応答にする。
 * どれで落ちたかを攻撃者に教えない（`idTokenInvalid` と同じ方針）。
 */
export function joinTokenInvalid(detail?: string): AppError {
  return new AppError(
    CODE_JOIN_TOKEN_INVALID,
    404,
    "この招待リンクは使えません。幹事に新しいリンクを送ってもらってください。",
    detail === undefined ? {} : { detail },
  );
}

// ============================================================================
// 生成・ハッシュ・比較
// ============================================================================

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** CSPRNG で `bytes` バイトのトークンを作り base64url で返す。 */
export function generateToken(bytes: number = JOIN_TOKEN_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < JOIN_TOKEN_BYTES) {
    throw new Error(`token must be at least ${JOIN_TOKEN_BYTES} bytes (128 bits)`);
  }
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toBase64Url(buffer);
}

/** トークンの SHA-256。DB にはこれしか入らない。 */
export async function hashToken(token: string): Promise<Buffer> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest);
}

/**
 * バイト列の定数時間比較。長さの違いも漏らさない
 * （`src/lib/auth/csrf.ts` の `timingSafeEqual` と同じ構造）。
 */
export function timingSafeEqualBytes(
  a: Uint8Array | Buffer | null | undefined,
  b: Uint8Array | Buffer | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const left = Uint8Array.from(a);
  const right = Uint8Array.from(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/** 形だけの検査。DB を引く前に明らかに不正な入力を落とす。 */
export function isTokenShapeValid(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

export interface MintedJoinToken {
  /** 生のトークン。**この戻り値でしか手に入らない**。 */
  readonly token: string;
  readonly hash: Buffer;
  readonly expiresAt: Date;
}

/** 招待トークンを 1 本作る（生成のみ。DB への書き込みは呼び出し側）。 */
export async function mintJoinToken(now: Date = new Date()): Promise<MintedJoinToken> {
  const token = generateToken(JOIN_TOKEN_BYTES);
  const hash = await hashToken(token);
  const expiresAt = new Date(now.getTime() + JOIN_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { token, hash, expiresAt };
}

export interface MintedClaimToken {
  readonly token: string;
  readonly hash: Buffer;
}

/** 参加者単位の claim トークンを 1 本作る（個別リンク用）。 */
export async function mintClaimToken(): Promise<MintedClaimToken> {
  const token = generateToken(CLAIM_TOKEN_BYTES);
  const hash = await hashToken(token);
  return { token, hash };
}

// ============================================================================
// 入口（ヘッダ）
// ============================================================================

/**
 * `X-Join-Token` を読む。無い・形が違うはすべて 404（`joinTokenInvalid`）。
 *
 * ★ パスやクエリからは読まない。参加者画面は招待リンクのクエリから 1 度だけ読み取り、
 *   以後はこのヘッダに載せて送る（`src/app/(liff)/e/page.tsx`）。
 */
export function readJoinTokenHeader(request: Request): string {
  const raw = request.headers.get(JOIN_TOKEN_HEADER);
  if (raw === null) throw joinTokenInvalid("join token header is missing");
  const token = raw.trim();
  if (!isTokenShapeValid(token)) throw joinTokenInvalid("join token has an unexpected shape");
  return token;
}

// ============================================================================
// 解決（トークン → イベント）
// ============================================================================

export interface ResolvedJoinEvent {
  readonly id: string;
  readonly title: string;
  readonly organizerLabel: string;
  readonly status: string;
  readonly collectByAt: Date | null;
  readonly defaultAmountMinor: number | null;
  readonly allowCash: boolean;
  readonly joinTokenVersion: number;
}

interface JoinTokenEventRow {
  readonly id: string;
  readonly title: string;
  readonly organizer_label: string;
  readonly status: string;
  readonly collect_by_at: Date | null;
  readonly default_amount_minor: number | null;
  readonly allow_cash: boolean;
  readonly join_token_hash: Buffer;
  readonly join_token_expires_at: Date | null;
  readonly join_token_version: number;
}

/**
 * 招待トークンからイベントを引く。無効・期限切れ・キャンセル済みはすべて 404。
 *
 * ★ `join_token_expires_at` が **NULL の行は無効**として扱う（fail-closed。敵対レビュー
 *   round1 GPT F-2）。NULL を「期限なし」とすると、期限を書き忘れた経路のトークンだけが
 *   永久に生き続ける — つまり**書き忘れが最も長寿命のトークンを作る**という逆転が起きる。
 *   トークンを発行する経路（`POST /api/events` / `POST /api/events/:id/rotate-join-token`）は
 *   必ず `join_token_expires_at` を書くこと。
 */
export async function resolveEventByJoinToken(
  sql: postgres.Sql,
  token: string,
  options: { readonly now?: Date } = {},
): Promise<ResolvedJoinEvent> {
  if (!isTokenShapeValid(token)) throw joinTokenInvalid("join token has an unexpected shape");
  const now = options.now ?? new Date();
  const hash = await hashToken(token);

  const rows = await sql<JoinTokenEventRow[]>`
    SELECT
      id, title, organizer_label, status, collect_by_at, default_amount_minor, allow_cash,
      join_token_hash, join_token_expires_at, join_token_version
    FROM event
    WHERE join_token_hash = ${hash}
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) throw joinTokenInvalid("no event matches this join token");

  // SQL の等値比較に加えて、取り出した行のハッシュを定数時間で突き合わせる（多重化）。
  if (!timingSafeEqualBytes(row.join_token_hash, hash)) {
    throw joinTokenInvalid("join token hash mismatch");
  }
  if (row.join_token_expires_at === null) {
    throw joinTokenInvalid("join token has no expiry recorded");
  }
  if (row.join_token_expires_at.getTime() <= now.getTime()) {
    throw joinTokenInvalid("join token has expired");
  }
  if (row.status === "canceled") {
    throw joinTokenInvalid("event is canceled");
  }

  return {
    id: row.id,
    title: row.title,
    organizerLabel: row.organizer_label,
    status: row.status,
    collectByAt: row.collect_by_at,
    defaultAmountMinor: row.default_amount_minor,
    allowCash: row.allow_cash,
    joinTokenVersion: row.join_token_version,
  };
}

// ============================================================================
// ローテーション・状態（幹事側）
// ============================================================================

export interface RotatedJoinToken {
  readonly eventId: string;
  /** 生のトークン。**この戻り値でしか手に入らない**。 */
  readonly token: string;
  readonly expiresAt: Date;
  readonly version: number;
}

/**
 * 招待トークンを差し替える。旧トークンはこの瞬間から 404 になる。
 *
 * 所有者判定は SQL の `WHERE organizer_user_id = ...` で行い、リクエストからは取らない
 * （§9「認可の原則」/ 制約 I3）。
 */
export async function rotateJoinToken(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  eventId: string,
  now: Date = new Date(),
): Promise<RotatedJoinToken> {
  const minted = await mintJoinToken(now);
  const rows = await tx<{ id: string; join_token_version: number; join_token_expires_at: Date }[]>`
    UPDATE event
    SET join_token_hash = ${minted.hash},
        join_token_expires_at = ${minted.expiresAt},
        join_token_version = join_token_version + 1
    WHERE id = ${eventId} AND organizer_user_id = ${organizerUserId}
    RETURNING id, join_token_version, join_token_expires_at
  `;
  const row = rows[0];
  if (row === undefined) {
    // 存在しない / 他人のイベント。どちらも同じ応答にする（存在を教えない）。
    throw joinTokenInvalid("event not found for this organizer");
  }
  return {
    eventId: row.id,
    token: minted.token,
    expiresAt: row.join_token_expires_at,
    version: row.join_token_version,
  };
}

export interface JoinTokenStatus {
  readonly eventId: string;
  readonly expiresAt: Date | null;
  readonly version: number;
  readonly expired: boolean;
  /**
   * **常に false**。生のトークンは保存していないので取り出せない
   * （再配布したいときは `rotateJoinToken` で作り直す）。型として明示しておくことで、
   * 「そのうち返せるようになる」という誤解を残さない。
   */
  readonly tokenRetrievable: false;
}

/** 配布画面（O-7）が読む、招待トークンのメタ情報。生の値は返さない。 */
export async function getJoinTokenStatus(
  sql: postgres.Sql,
  organizerUserId: string,
  eventId: string,
  now: Date = new Date(),
): Promise<JoinTokenStatus> {
  const rows = await sql<
    { id: string; join_token_expires_at: Date | null; join_token_version: number }[]
  >`
    SELECT id, join_token_expires_at, join_token_version
    FROM event
    WHERE id = ${eventId} AND organizer_user_id = ${organizerUserId}
  `;
  const row = rows[0];
  if (row === undefined) throw joinTokenInvalid("event not found for this organizer");
  return {
    eventId: row.id,
    expiresAt: row.join_token_expires_at,
    version: row.join_token_version,
    // 期限が記録されていない行は「使えない＝期限切れ」として見せる（resolve 側と同じ fail-closed）。
    expired:
      row.join_token_expires_at === null ||
      row.join_token_expires_at.getTime() <= now.getTime(),
    tokenRetrievable: false,
  };
}
