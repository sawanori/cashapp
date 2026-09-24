/**
 * `/api/health` の依存先込み degraded 判定（task_023 / §7-7 / check_114）。
 *
 * task_012 までの `/api/health` は環境設定（fingerprint）だけを見ていた。ここで足すのは
 * **DB 側の 4 条件**である。§17-6 の閾値をそのまま使う:
 *
 *   1. DB 疎通失敗
 *   2. `reconciliation_run` の最新 `started_at` が 900 秒超（`reconcile_staleness_seconds`）
 *   3. `outbox` の未処理最古行の経過が 24 時間超（`outbox_oldest_pending_age_seconds`）
 *   4. 開いている `payment_attempt` があるのに直近 1 時間 `webhook_delivery` が 0 件
 *      （`webhook_received_1h` かつ open attempt あり）
 *
 * ★ 依存タスク（task_018 / task_020）が未着手でも着手できる理由（docs/concerns/task_023.md §1
 *   のレビュー指摘）: 4 条件が読む 4 テーブル（`reconciliation_run` / `outbox` / `payment_attempt` /
 *   `webhook_delivery`）はいずれも既存マイグレーション（supabase/migrations/0001_init.sql）に
 *   存在し、ここは**読み取り専用**。書き込み側（reconcile バッチ・outbox 投入・Webhook 受信）が
 *   まだ無くても、テーブルが空のままなら該当条件は「シグナル無し＝degraded ではない」として扱う
 *   （2 と 3 は「行が 1 つも無い」を「無限に stale」とは判定しない。producer が存在しない今の
 *   環境で `/api/health` が恒久的に degraded を返し続けることを避けるため）。
 *
 * ★ `src/lib/outbox.ts`（task_018 が同一ワークツリーで並行ドラフト中・未コミット）を import
 *   しない。`OUTBOX_TRANSPORT` の抽象度（`organizer_notify` / `ops_alert`）と衝突するため
 *   （docs/concerns/task_023.md §2）。ここでは `outbox` テーブルを SQL で直接読むだけで、
 *   `kind` や transport の意味には一切踏み込まない。
 *
 * ★ 個々の DB エラーの内容（メッセージ・スタック）は呼び出し側（route.ts）のボディに出さない。
 *   `assessDbHealth()` は例外を丸めて `reasons: ["db_unreachable"]` に潰す。
 */

import type postgres from "postgres";

/** degraded の内部理由。route.ts はこれを HTTP レスポンスボディには出さない（詳細非公開）。 */
export type HealthDegradedReason =
  | "db_unreachable"
  | "reconcile_stale"
  | "outbox_stale"
  | "webhook_silent";

export interface DbHealthAssessment {
  readonly degraded: boolean;
  readonly reasons: readonly HealthDegradedReason[];
}

/** §17-6: `reconcile_staleness_seconds`（900 秒超）。 */
export const RECONCILE_STALE_THRESHOLD_SECONDS = 900;
/** §17-6: `outbox_oldest_pending_age_seconds`（24 時間超）。 */
export const OUTBOX_OLDEST_PENDING_THRESHOLD_SECONDS = 24 * 60 * 60;
/** §7-7 / check_114: 「open attempt があるのに Webhook 1h 0 件」の窓。 */
export const WEBHOOK_SILENT_WINDOW_SECONDS = 60 * 60;

/**
 * health.ts が必要とする DB 読み取りだけを切り出したインターフェース。
 * ユニットテストは実 DB の代わりにこれを合成行つきのモックで差し替える。
 */
export interface HealthDbReader {
  /** 最新の `reconciliation_run.started_at`。1 行も無ければ `null`。 */
  latestReconciliationRunStartedAt(): Promise<Date | null>;
  /** 未処理（`done_at IS NULL AND dead_lettered_at IS NULL`）の最古 `outbox.created_at`。無ければ `null`。 */
  oldestPendingOutboxCreatedAt(): Promise<Date | null>;
  /** `payment_attempt.is_open` な行が 1 件でもあるか。 */
  hasOpenPaymentAttempt(): Promise<boolean>;
  /** `webhook_delivery.received_at` が `since` より新しい行が 1 件でもあるか。 */
  hasWebhookDeliverySince(since: Date): Promise<boolean>;
}

/** `HealthDbReader` の実装。実 DB（`postgres.Sql` / トランザクション）に対して読む。 */
export function createSqlHealthReader(sql: postgres.ISql): HealthDbReader {
  return {
    async latestReconciliationRunStartedAt(): Promise<Date | null> {
      const rows = await sql<{ started_at: Date }[]>`
        SELECT started_at FROM reconciliation_run
        ORDER BY started_at DESC
        LIMIT 1
      `;
      return rows[0]?.started_at ?? null;
    },
    async oldestPendingOutboxCreatedAt(): Promise<Date | null> {
      const rows = await sql<{ created_at: Date }[]>`
        SELECT created_at FROM outbox
        WHERE done_at IS NULL AND dead_lettered_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `;
      return rows[0]?.created_at ?? null;
    },
    async hasOpenPaymentAttempt(): Promise<boolean> {
      const rows = await sql<{ found: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM payment_attempt WHERE is_open) AS found
      `;
      return rows[0]?.found === true;
    },
    async hasWebhookDeliverySince(since: Date): Promise<boolean> {
      const rows = await sql<{ found: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM webhook_delivery WHERE received_at > ${since}
        ) AS found
      `;
      return rows[0]?.found === true;
    },
  };
}

/**
 * DB 側の 4 条件を評価する。`reader` の呼び出しのどれか 1 つでも失敗したら、
 * それ以上は評価せず `db_unreachable` 単独の結果にする（DB そのものに届いていない疑いがある
 * 状態で他の条件の判定を続けても意味が無く、個々の例外内容も外へ漏らさないため）。
 */
export async function assessDbHealth(
  reader: HealthDbReader,
  now: Date = new Date(),
): Promise<DbHealthAssessment> {
  const reasons: HealthDegradedReason[] = [];

  try {
    const latestReconcile = await reader.latestReconciliationRunStartedAt();
    if (latestReconcile !== null) {
      const staleSeconds = (now.getTime() - latestReconcile.getTime()) / 1000;
      if (staleSeconds > RECONCILE_STALE_THRESHOLD_SECONDS) {
        reasons.push("reconcile_stale");
      }
    }

    const oldestOutbox = await reader.oldestPendingOutboxCreatedAt();
    if (oldestOutbox !== null) {
      const ageSeconds = (now.getTime() - oldestOutbox.getTime()) / 1000;
      if (ageSeconds > OUTBOX_OLDEST_PENDING_THRESHOLD_SECONDS) {
        reasons.push("outbox_stale");
      }
    }

    const hasOpenAttempt = await reader.hasOpenPaymentAttempt();
    if (hasOpenAttempt) {
      const since = new Date(now.getTime() - WEBHOOK_SILENT_WINDOW_SECONDS * 1000);
      const hasRecentWebhook = await reader.hasWebhookDeliverySince(since);
      if (!hasRecentWebhook) {
        reasons.push("webhook_silent");
      }
    }
  } catch {
    return { degraded: true, reasons: ["db_unreachable"] };
  }

  return { degraded: reasons.length > 0, reasons };
}
