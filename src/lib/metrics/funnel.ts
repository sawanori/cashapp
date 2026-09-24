/**
 * ファネル計測（着地 → 同意 → claim → checkout → paid）。
 *
 * docs/implementation-plan.md §17-6「検知シグナル」と §11-1（`docs/metrics/weekly-*.json`）に
 * 対応する task_022 の scope。
 *
 * ★ 記録先は新しいテーブルを作らず `audit_log`（追記専用・既存）を使う。理由は 2 つ:
 *     1. マイグレーションファイルは task_022 の files_to_create に無い。
 *     2. ファネルは「どのイベントがどの段階に到達したか」の事実列であり、監査ログと
 *        同じ性質（追記・不変・時系列）を持つ。`action` を `funnel.<stage>` の形に固定し、
 *        `target_type='event'` / `target_id=<eventId>` で 1 イベント 1 段階 1 行を記録する。
 *        同じ段階に複数回到達しても行が増えるのは許容する（集計側で `count(DISTINCT
 *        target_id)` を使い、イベント単位の重複を吸収する）。
 *
 * ★ **実際の集金導線（preview / consent / claim / checkout / manual-attest）への計測呼び出し
 *   の組み込みは、この機構だけでは完結しない。** 呼び出し元となる各ルート
 *   （`src/app/api/e/preview/route.ts` 等）は task_022 の files_to_modify に無いため、
 *   本タスクではここに配線しない（`docs/concerns/task_022.md` に deferred として記録）。
 *   本モジュールは「記録・集計・週次出力」の実装であり、`recordFunnelStage` を呼ぶ配線は
 *   後続タスクの仕事になる。
 *
 * ★ `recordFunnelStage` は呼び出し側が開いたトランザクション（`tx`）を要求する
 *   （`appendAuditLog` と同じ理由: 業務書き込みと同一トランザクションで記録するため）。
 */

import "server-only";

import type postgres from "postgres";

import { appendAuditLog } from "@/lib/audit";

export const FUNNEL_STAGES = ["landing", "consent", "claim", "checkout", "paid"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

const FUNNEL_ACTION_PREFIX = "funnel.";

export function funnelAction(stage: FunnelStage): string {
  return `${FUNNEL_ACTION_PREFIX}${stage}`;
}

export interface RecordFunnelStageInput {
  readonly eventId: string;
  readonly stage: FunnelStage;
  /** `line_user_ref` かユーザーの参照値。個人を特定しない範囲でだけ入れる（任意）。 */
  readonly actorRef?: Buffer | null;
  readonly requestId: string;
  readonly now?: Date;
}

/** 1 イベントが 1 段階に到達したことを記録する（`audit_log` への追記）。 */
export async function recordFunnelStage(
  tx: postgres.TransactionSql,
  input: RecordFunnelStageInput,
): Promise<void> {
  await appendAuditLog(tx, {
    actorType: "system",
    actorRef: input.actorRef ?? null,
    action: funnelAction(input.stage),
    targetType: "event",
    targetId: input.eventId,
    requestId: input.requestId,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export interface WeeklyFunnelCounts extends Record<FunnelStage, number> {}

export interface WeeklyFunnelResult {
  /** ISO 8601 の日付（UTC 週の開始、月曜日 00:00:00Z）。 */
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly generatedAt: string;
  /** 段階ごとの到達イベント数（重複到達はイベント単位で 1 件に畳む）。 */
  readonly stages: WeeklyFunnelCounts;
}

/** `weekStart` を含む週（UTC・月曜始まり）の開始時刻へ丸める。 */
export function startOfIsoWeekUtc(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diffToMonday);
  return d;
}

/**
 * 指定した週（`weekStart` を含む週。UTC・月曜始まり）のファネル段階別到達イベント数を集計する。
 * `sql` は生のコネクション（`postgres.Sql` / `postgres.TransactionSql`）ならどちらでもよい。
 */
export async function computeWeeklyFunnel(
  sql: postgres.Sql,
  referenceDate: Date = new Date(),
): Promise<WeeklyFunnelResult> {
  const weekStart = startOfIsoWeekUtc(referenceDate);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  const stages: Record<FunnelStage, number> = {
    landing: 0,
    consent: 0,
    claim: 0,
    checkout: 0,
    paid: 0,
  };

  const rows = await sql<{ action: string; n: string }[]>`
    SELECT action, count(DISTINCT target_id)::text AS n
    FROM audit_log
    WHERE target_type = 'event'
      AND action = ANY(${sql.array(FUNNEL_STAGES.map((s) => funnelAction(s)))})
      AND occurred_at >= ${weekStart.toISOString()}::timestamptz
      AND occurred_at < ${weekEnd.toISOString()}::timestamptz
    GROUP BY action
  `;
  for (const row of rows) {
    const stage = FUNNEL_STAGES.find((s) => funnelAction(s) === row.action);
    if (stage !== undefined) stages[stage] = Number(row.n);
  }

  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    generatedAt: new Date().toISOString(),
    stages,
  };
}

/** `docs/metrics/weekly-<weekStart 日付>.json` の中身（ファネルだけを持つ最小構成）。 */
export interface WeeklyMetricsFile {
  readonly funnel: WeeklyFunnelResult;
}

export function weeklyMetricsFileName(weekStartIso: string): string {
  const date = weekStartIso.slice(0, 10); // YYYY-MM-DD
  return `weekly-${date}.json`;
}

export function buildWeeklyMetricsFile(funnel: WeeklyFunnelResult): WeeklyMetricsFile {
  return { funnel };
}
