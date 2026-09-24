/**
 * `Idempotency-Key` の基盤（§9 / task_014 scope）。
 *
 * ★ 主キーは `(user_ref, endpoint, key)`。`in_flight` を**先に**予約してから本処理を
 *   実行し、完了したら `done` へ遷移させる（`docs/implementation-plan.md` §9 冒頭）。
 *   予約は `INSERT ... ON CONFLICT DO NOTHING RETURNING` の 1 文で原子的に決着させる
 *   （`src/lib/auth/used-token.ts` の単回使用と同じ形。SELECT してから INSERT すると
 *   同時リクエストが両方「未予約」と判定しうる）。
 *
 * ★ **予約（`in_flight`）・`handler` の業務書き込み・`done` への遷移は、呼び出し側が
 *   開いた 1 つの Postgres トランザクションの中で行う**（`docs/research/premortem-phase1b-
 *   2026-09-24.md` P-01 の是正）。`runIdempotent` は**渡された `sql` に対して独自に
 *   `sql.begin()` を張らない** — 呼び出し側が `sql.begin(async (tx) => runIdempotent({ sql: tx,
 *   ... }, handler))` の形で `tx` を渡すこと。これにより:
 *     - `handler` が業務データを書き込んだ後に例外を投げても、そのトランザクション全体
 *       （予約の INSERT を含む）が自動的に ROLLBACK される。業務が中途半端にコミットされ、
 *       予約だけが手動 DELETE で消える — という P-01 の「業務 tx コミット後に例外 → 再送が
 *       同じ処理をもう一度実行する」経路が構造的に無くなる。
 *     - `handler` が成功すれば、業務書き込みと `state='done'` への更新が**同一トランザクション
 *       で一緒にコミットされる**。「業務は成立したのに予約だけ `in_flight` のまま 24h 残る」
 *       という P-01 のもう一方の経路（Worker が両者の間で落ちる）も無くなる — 落ちれば
 *       トランザクション自体が未コミットのまま終わり、何も残らないため再送は最初からやり直せる。
 *     - 副作用として、同一キーへの真の同時リクエストは 409 で即座に弾かれるのではなく、
 *       先行リクエストの行ロック解放（COMMIT/ROLLBACK）まで DB 側で待たされる場合がある
 *       （通常は同一キーでの connection-level な二重送信のみで起き、単発 API では稀）。
 *       `state='in_flight'` の読み取り分岐は、移行前のデータや将来の非トランザクション経路への
 *       備えとして残す（到達すれば同じ 409 を返す）。
 *
 * ★ `request_hash` が一致しない 2 回目のリクエストは 409 `IDEMPOTENCY_CONFLICT`。
 *   一致していて `state='done'` なら、**保存してある応答をそのまま返す**（再実行しない）。
 *
 * ★ `response_body` は**許可フィールドのみ**を保存する（`docs/implementation-plan.md` §9）。
 *   このモジュールは呼び出し側が渡した `cacheableBody` だけを保存し、`extra`
 *   （例: `POST /api/events` の `joinToken`）は初回応答にだけ載せて**保存しない**。
 *   再送（`replayed: true`）の応答には `extra` が含まれない
 *   （task_014 scope: 「冪等キー再送同一応答...response_body に joinToken 無し」）。
 *
 * ★ `errors.ts` の `ERROR_CODES` は task_014 の `files_to_modify` に含まれないため直接
 *   編集しない。`AppError` の `code` へ型アサーションで新規コードを渡す（実行時の挙動は
 *   `ERROR_CODES` の値と変わらない。将来の統合はそれを所有するタスクの仕事とする）。
 */

import "server-only";

import type postgres from "postgres";

import { AppError, badRequest, type ErrorCode } from "@/lib/errors";

/** クライアントが送るヘッダ名。 */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/** `idempotency_key.expires_at` の TTL（§9）。 */
export const IDEMPOTENCY_TTL_HOURS = 24;

const CODE_KEY_REQUIRED = "IDEMPOTENCY_KEY_REQUIRED" as ErrorCode;
const CODE_CONFLICT = "IDEMPOTENCY_CONFLICT" as ErrorCode;
const CODE_IN_PROGRESS = "IDEMPOTENCY_IN_PROGRESS" as ErrorCode;

/** 400。ヘッダが無い、または空文字。 */
export function idempotencyKeyRequired(detail?: string): AppError {
  return new AppError(
    CODE_KEY_REQUIRED,
    400,
    `${IDEMPOTENCY_HEADER} ヘッダが必要です。`,
    detail === undefined ? {} : { detail },
  );
}

/** 409。同じキーで内容の異なるリクエストが送られた。 */
export function idempotencyConflict(detail?: string): AppError {
  return new AppError(
    CODE_CONFLICT,
    409,
    "同じ操作キーで、内容の異なるリクエストが送られました。もう一度最初からやり直してください。",
    detail === undefined ? {} : { detail },
  );
}

/** 409。同じキーの処理が別のリクエストで進行中。 */
export function idempotencyInProgress(detail?: string): AppError {
  return new AppError(
    CODE_IN_PROGRESS,
    409,
    "直前の操作を処理しています。しばらくしてからもう一度お試しください。",
    detail === undefined ? {} : { detail },
  );
}

/**
 * `Idempotency-Key` ヘッダを読み、無ければ例外を投げる。
 * 長さの上限は DB 側の実用的な範囲（`text` 列だが、乱用防止のため 200 文字に絞る）。
 */
export function requireIdempotencyKey(request: Request): string {
  const raw = request.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) throw idempotencyKeyRequired("header is missing");
  const key = raw.trim();
  if (key.length === 0) throw idempotencyKeyRequired("header is empty");
  if (key.length > 200) throw idempotencyKeyRequired("header exceeds 200 chars");
  return key;
}

/**
 * `app_user.id`（UUID）から `idempotency_key.user_ref`（bytea）を導出する。
 *
 * `line_user_ref` のような HMAC は行わない。`app_user.id` は既に DB が発行した
 * 不可逆な内部識別子（UUID v4）であり、LINE の生 `sub` のような narrow-entropy な
 * 値ではないため、追加のペッパー処理は不要である。UUID の 16 バイト表現をそのまま使う。
 */
export function idempotencyUserRef(appUserId: string): Buffer {
  const hex = appUserId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw badRequest("invalid user id for idempotency scoping");
  }
  return Buffer.from(hex, "hex");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(record).sort()) {
      sorted[k] = sortKeysDeep(record[k]);
    }
    return sorted;
  }
  return value;
}

/** リクエストボディの正準ハッシュ（SHA-256 hex）。キー順に依存しないよう正規化する。 */
export async function computeRequestHash(body: unknown): Promise<string> {
  const canonical = JSON.stringify(sortKeysDeep(body ?? null));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RunIdempotentOptions {
  /**
   * 呼び出し側が既に開いているトランザクション。予約・`handler`・`done` 更新を同一トランザクション
   * で行うため（上の docstring）、プールの `postgres.Sql`（`.begin()` を持つ側）ではなく、
   * `sql.begin(async (tx) => ...)` の `tx` を渡すこと。
   */
  readonly sql: postgres.TransactionSql;
  readonly userRef: Buffer;
  readonly endpoint: string;
  readonly key: string;
  readonly requestHash: string;
  readonly now?: Date;
}

export interface IdempotentOutcome {
  readonly statusCode: number;
  /** DB に保存し、再送時にそのまま返してよいフィールドだけ。 */
  readonly cacheableBody: Record<string, unknown>;
  /** 初回応答にだけ載せる（保存しない・再送では返さない）フィールド。 */
  readonly extra?: Record<string, unknown>;
}

export interface IdempotencyResult {
  readonly replayed: boolean;
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

interface StoredIdempotencyRow {
  readonly state: string;
  readonly request_hash: string;
  readonly response_body: Record<string, unknown> | null;
  readonly status_code: number | null;
}

/**
 * `handler` を冪等キーで包んで実行する。
 *
 * `handler` は**このリクエストが予約を取れたときだけ**呼ばれる。呼び出し側は必ず
 * `options.sql`（`postgres.TransactionSql`）を既に開いたトランザクションの `tx` として渡し、
 * `handler` の内部の DB 書き込みも同じ `tx` を使うこと（P-01 是正。上の docstring）。
 * `handler` が例外を投げた場合、ここでは何も打ち消さない — 呼び出し側のトランザクションが
 * 丸ごと ROLLBACK されることで、予約の INSERT を含めて何も残らない状態に戻る。
 */
export async function runIdempotent(
  options: RunIdempotentOptions,
  handler: () => Promise<IdempotentOutcome>,
): Promise<IdempotencyResult> {
  const { sql, userRef, endpoint, key, requestHash } = options;
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000);

  const reserved = await sql<{ user_ref: Buffer }[]>`
    INSERT INTO idempotency_key (user_ref, endpoint, key, state, request_hash, expires_at)
    VALUES (${userRef}, ${endpoint}, ${key}, 'in_flight', ${requestHash}, ${expiresAt})
    ON CONFLICT (user_ref, endpoint, key) DO NOTHING
    RETURNING user_ref
  `;

  if (reserved.length === 1) {
    // `handler` を try/catch で包まない: 例外はそのまま呼び出し側のトランザクションへ伝播させ、
    // 予約の INSERT ごとロールバックさせる（P-01。DELETE で個別に解放すると、`handler` が
    // 内部で業務コミットを終えたあとに例外を投げた場合に再送が二重実行してしまう）。
    const outcome = await handler();

    // `sql.json()` は postgres.js の `JSONValue` 型（`Record<string, unknown>` は非適合）を
    // 要求するため、一度 JSON を介して素の JSON 互換値へ落としてから渡す。
    const jsonSafeBody = JSON.parse(JSON.stringify(outcome.cacheableBody)) as postgres.JSONValue;
    await sql`
      UPDATE idempotency_key
      SET state = 'done', response_body = ${sql.json(jsonSafeBody)}, status_code = ${outcome.statusCode}
      WHERE user_ref = ${userRef} AND endpoint = ${endpoint} AND key = ${key} AND state = 'in_flight'
    `;

    return {
      replayed: false,
      statusCode: outcome.statusCode,
      body: { ...outcome.cacheableBody, ...(outcome.extra ?? {}) },
    };
  }

  const existing = await sql<StoredIdempotencyRow[]>`
    SELECT state, request_hash, response_body, status_code
    FROM idempotency_key
    WHERE user_ref = ${userRef} AND endpoint = ${endpoint} AND key = ${key}
  `;
  const row = existing[0];
  if (row === undefined) {
    // 予約が別トランザクションで作られた直後にロールバックされた（handler 失敗）ウィンドウに
    // 割り込んだ。再試行を促す。
    throw idempotencyInProgress("reservation was released concurrently; retry");
  }
  if (row.request_hash !== requestHash) {
    throw idempotencyConflict("request body differs from the first request with this key");
  }
  if (row.state === "done") {
    return {
      replayed: true,
      statusCode: row.status_code ?? 200,
      body: row.response_body ?? {},
    };
  }
  throw idempotencyInProgress("a request with this key is still being processed");
}
