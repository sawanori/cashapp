/**
 * 保持期間の処理と期限切れ行の掃除（§7-7 / §10-2 / R-DATA-01 / check_043 / check_072 / check_104）。
 *
 * ★ 対象は 3 つ:
 *     1. `participant.display_label`（幹事が入力した氏名）→ **NULL 化**
 *     2. `event.organizer_label`（幹事の表示名）→ **固定文字列へ置換**
 *     3. `webhook_delivery.raw_body`（受信本文）→ 14 日で NULL 化（`body_sha256` は残す）
 *
 * ★ `event.organizer_label` は `text NOT NULL`（`supabase/migrations/0001_init.sql`）なので
 *   **NULL 化は制約違反になる**。マイグレーションはこのタスクの所有ではないため、
 *   premortem P-03 の対応案のうち「NOT NULL を維持したまま固定文字列へ置換する」方を採る。
 *   `docs/acceptance-checks.json` check_043 の期待値（`organizer_label が NULL`）とは
 *   この 1 点だけ食い違う。受入基準の書き換えはしない（P-02）。差分は
 *   `docs/concerns/task_020.md` に記録し、列を NULL 可にするかの判断を PO に残す。
 *
 * ★ 起点（P-03）: `event.retention_due_at` を書く経路がどのタスクにも無かった。
 *   ここで**終了済みイベント（`status IN ('closed','canceled')`）の期日を 1 度だけ埋める**。
 *   起点列（`closed_at`）がスキーマに無いため、`COALESCE(collect_by_at, event_at, updated_at)`
 *   を終了時刻の代理に使う。**一度書いた行は上書きしない**（`retention_due_at IS NULL` 限定）
 *   ので、`updated_at` が後から動いても期日は揺れない。
 *
 * ★ 掃除（`/api/cron/idempotency-cleanup`）も同じ「期限を過ぎた行を消す」処理なのでここに置く。
 *   `idempotency_key`（TTL 24 時間）と `used_id_token`（TTL = ID トークンの `exp`）の
 *   **`expires_at` を過ぎた行だけ**を削除する。未経過の行は残す。
 */

import "server-only";

import type postgres from "postgres";

type SqlLike = postgres.ISql;

/** 終了から擬似匿名化までの日数（§7-7 / 規約の 90 日）。 */
export const RETENTION_DAYS = 90;

/** `webhook_delivery.raw_body` の保持日数。 */
export const RAW_BODY_RETENTION_DAYS = 14;

/**
 * `event.organizer_label` の置換値。NOT NULL を保ったまま個人を指さない値にする。
 * 文言は `docs/wording-policy.md` の禁止語を含まない。
 */
export const REDACTED_ORGANIZER_LABEL = "(保持期間経過)";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionResult {
  /** 期日を新しく埋めたイベント数。 */
  readonly dueDatesBackfilled: number;
  /** 表示名を消した参加者数。 */
  readonly participantLabelsCleared: number;
  /** 表示名を置換したイベント数。 */
  readonly organizerLabelsRedacted: number;
  /** 本文を消した受信ログ数。 */
  readonly rawBodiesCleared: number;
}

/**
 * 終了済みイベントに保持期限を 1 度だけ書く（P-03）。
 * `retention_due_at` が既にある行は触らない。
 */
export async function backfillRetentionDue(sql: SqlLike, now: Date): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE event
    SET retention_due_at = COALESCE(collect_by_at, event_at, updated_at)
                           + ${`${RETENTION_DAYS} days`}::interval
    WHERE status IN ('closed', 'canceled')
      AND retention_due_at IS NULL
      AND COALESCE(collect_by_at, event_at, updated_at) <= ${now}
    RETURNING id
  `;
  return rows.length;
}

/** 保持期間処理 1 回分。 */
export async function runRetention(sql: SqlLike, now: Date = new Date()): Promise<RetentionResult> {
  const dueDatesBackfilled = await backfillRetentionDue(sql, now);

  const participants = await sql<{ id: string }[]>`
    UPDATE participant p
    SET display_label = NULL
    FROM event e
    WHERE p.event_id = e.id
      AND e.retention_due_at IS NOT NULL
      AND e.retention_due_at <= ${now}
      AND p.display_label IS NOT NULL
    RETURNING p.id
  `;

  const events = await sql<{ id: string }[]>`
    UPDATE event
    SET organizer_label = ${REDACTED_ORGANIZER_LABEL}
    WHERE retention_due_at IS NOT NULL
      AND retention_due_at <= ${now}
      AND organizer_label <> ${REDACTED_ORGANIZER_LABEL}
    RETURNING id
  `;

  const rawCutoff = new Date(now.getTime() - RAW_BODY_RETENTION_DAYS * DAY_MS);
  const deliveries = await sql<{ id: string }[]>`
    UPDATE webhook_delivery
    SET raw_body = NULL
    WHERE raw_body IS NOT NULL
      AND received_at < ${rawCutoff}
    RETURNING id
  `;

  return {
    dueDatesBackfilled,
    participantLabelsCleared: participants.length,
    organizerLabelsRedacted: events.length,
    rawBodiesCleared: deliveries.length,
  };
}

export interface CleanupResult {
  readonly idempotencyKeysDeleted: number;
  readonly usedIdTokensDeleted: number;
}

/**
 * 期限切れの冪等キーと使用済み ID トークンを消す。
 * **`expires_at` を過ぎた行だけ**が対象で、未経過の行は残る（check_072 / check_104）。
 */
export async function runIdempotencyCleanup(
  sql: SqlLike,
  now: Date = new Date(),
): Promise<CleanupResult> {
  const keys = await sql<{ key: string }[]>`
    DELETE FROM idempotency_key WHERE expires_at < ${now} RETURNING key
  `;
  const tokens = await sql<{ jti_or_hash: string }[]>`
    DELETE FROM used_id_token WHERE expires_at < ${now} RETURNING jti_or_hash
  `;
  return {
    idempotencyKeysDeleted: keys.length,
    usedIdTokensDeleted: tokens.length,
  };
}
