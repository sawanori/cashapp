/**
 * 非同期タスクの outbox（制約 W5 / R-OPS-01 / §10-2 `outbox`）。
 *
 * ★ Webhook のハンドラは**受信・検証・記帳までを同期で済ませて 2xx を素早く返す**（W5）。
 *   幹事への通知・運用アラートといった重い処理はここに積むだけにし、実行は
 *   `/api/cron/outbox`（task_020）が行う。この モジュールは「積む」側だけを持つ。
 *
 * ★ `kind` は自由文字列にしない。**配達先（transport）の対応表を持つ**ことで、
 *   配達先の決まっていない種別を積めなくする（積んだが誰も配らない、を構造的に防ぐ）。
 *
 * ★ `max_attempts` を超えた行は `dead_lettered_at` を立てて**取り出し対象から外す**。
 *   無限リトライで outbox が詰まると、後続の通知がすべて遅延する（R-OPS-01）。
 *
 * ★ payload に入れてよいのは ID・enum・金額・時刻だけ。生の userId・IP・joinToken・
 *   自由記述を入れない（§7-5 / docs/concerns の P-07）。
 */

import "server-only";

import type postgres from "postgres";

type SqlLike = postgres.ISql;

/** 配達先。`kind` は必ずこのいずれかに割り当てる。 */
export type OutboxTransport =
  /** 幹事本人への通知（Phase 3 の Messaging API / Phase 1 は画面内の要対応）。 */
  | "organizer_notify"
  /** 運用者への警報（決済・台帳の整合が疑わしいとき）。 */
  | "ops_alert";

/**
 * `outbox.kind` の全集合と配達先。DB 側の CHECK は書式（`^[a-z0-9_]{1,48}$`）しか見ないので、
 * 「どの種別が存在してよいか」はこの表が正本になる。
 */
export const OUTBOX_TRANSPORT: Readonly<Record<string, OutboxTransport>> = {
  /** 試行に紐づかない入金イベントが届いた（§3-3 の orphan）。 */
  orphan_alert: "ops_alert",
  /** 金額・通貨・受取先が請求と一致しない（W8）。 */
  mismatch_alert: "ops_alert",
  /** 台帳残高が請求額を超えた（二重払い）。 */
  overpay_alert: "ops_alert",
  /** 取消済みの請求に入金が届いた（§9）。 */
  paid_after_void: "ops_alert",
  /** 紛争（事業者側での支払い取消請求）が発生した。 */
  dispute_alert: "ops_alert",
  /** 入金を検知したので幹事に知らせる。 */
  payment_detected: "organizer_notify",
};

export type OutboxKind = keyof typeof OUTBOX_TRANSPORT;

/** `outbox.max_attempts` の既定（DB の DEFAULT と同じ）。 */
export const DEFAULT_MAX_ATTEMPTS = 8;

export class UnknownOutboxKindError extends Error {
  public readonly kind: string;

  public constructor(kind: string) {
    super(`unknown outbox kind: ${kind}`);
    this.name = "UnknownOutboxKindError";
    this.kind = kind;
  }
}

/** 種別 → 配達先。表に無い種別は例外（積ませない）。 */
export function transportFor(kind: string): OutboxTransport {
  const transport = OUTBOX_TRANSPORT[kind];
  if (transport === undefined) throw new UnknownOutboxKindError(kind);
  return transport;
}

/** payload に入れてよい値（ID・enum・金額・真偽・時刻の ISO 文字列）。 */
export type OutboxPayloadValue = string | number | boolean | null;

export interface EnqueueOutboxInput {
  readonly kind: string;
  readonly payload: Readonly<Record<string, OutboxPayloadValue>>;
  readonly runAfter?: Date;
  readonly maxAttempts?: number;
}

/**
 * 1 件積む。呼び出し側は**業務上の変更と同一トランザクション**で呼ぶこと
 * （通知だけがコミットされて事実が無い、の逆も起きないようにする）。
 */
export async function enqueueOutbox(sql: SqlLike, input: EnqueueOutboxInput): Promise<string> {
  transportFor(input.kind);
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`outbox max_attempts must be a positive integer: ${String(maxAttempts)}`);
  }
  const payload = JSON.parse(JSON.stringify(input.payload)) as postgres.JSONValue;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO outbox (kind, payload, run_after, max_attempts)
    VALUES (${input.kind}, ${sql.json(payload)},
            ${input.runAfter ?? new Date()}, ${maxAttempts})
    RETURNING id
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("outbox insert returned no row");
  return row.id;
}

/**
 * 配達失敗を記録する。試行回数が `max_attempts` に達したら `dead_lettered_at` を立て、
 * 以後の取り出し対象から外す（R-OPS-01）。戻り値は dead letter にしたかどうか。
 *
 * `last_error` には呼び出し側が**秘密値を含まない短い理由**だけを渡すこと。
 */
export async function recordOutboxFailure(
  sql: SqlLike,
  outboxId: string,
  reason: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await sql<{ dead_lettered_at: Date | null }[]>`
    UPDATE outbox
    SET attempts = attempts + 1,
        last_error = ${reason.slice(0, 200)},
        dead_lettered_at = CASE WHEN attempts + 1 >= max_attempts THEN ${now} ELSE dead_lettered_at END
    WHERE id = ${outboxId}
    RETURNING dead_lettered_at
  `;
  return rows[0]?.dead_lettered_at !== null && rows[0]?.dead_lettered_at !== undefined;
}
