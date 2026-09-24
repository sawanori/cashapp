/**
 * `GET|POST /api/cron/outbox`（§7-7 / §10-2 / R-OPS-01 / check_104）。
 *
 * ★ 取り出しは `FOR UPDATE SKIP LOCKED`。cron が重なっても同じ行を 2 回配らない。
 * ★ 配達先は `src/lib/outbox.ts` の `OUTBOX_TRANSPORT`（kind → transport の対応表）。
 *   表に無い `kind` は配達しない（DB へ直接 INSERT された行だけが到達しうる）。
 * ★ 失敗は**指数バックオフ**で `run_after` を先送りし、`attempts` が `max_attempts` に
 *   達したら `dead_lettered_at` を立てて取り出し対象から外す（詰まりを作らない）。
 *
 * ★ Phase 1 の配達は**ログのみ**である。幹事への push（Messaging API）は ADR-007 と
 *   task_023 の担当で、生 userId の保持可否が未決のため、この cron からは送らない。
 *   幹事が見る要対応は O-9（DB を直接読む画面）であり outbox ではない。
 *   ペイロードはログに出さない（ID・enum・金額しか入っていないが、出す必要も無い）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type postgres from "postgres";

import { CRON_PRODUCTION_APP_ENV, checkCronRequest, parseCronSecrets } from "@/lib/cron-auth";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse, type ErrorCode } from "@/lib/errors";
import { logEvent } from "@/lib/logger";
import {
  UnknownOutboxKindError,
  recordOutboxFailure,
  transportFor,
  type OutboxTransport,
} from "@/lib/outbox";

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;

/** 1 回で配る上限。 */
export const OUTBOX_BATCH_LIMIT = 50;

/** バックオフの基準秒。`base * 2^(attempts-1)` を上限で頭打ちにする。 */
export const OUTBOX_BACKOFF_BASE_SEC = 30;

/** バックオフの上限秒（1 時間）。 */
export const OUTBOX_BACKOFF_CAP_SEC = 3_600;

/** 取り出した行を他プロセスから隠す時間。 */
export const OUTBOX_LOCK_SEC = 60;

interface CronRouteEnv extends DbEnv {
  readonly APP_ENV?: string | undefined;
  readonly CRON_SECRETS?: string | undefined;
}

export interface OutboxJob {
  readonly id: string;
  readonly kind: string;
  readonly transport: OutboxTransport;
  readonly attempts: number;
}

/** 配達口。テストはここに失敗する実装を差し込む。 */
export type OutboxDeliver = (job: OutboxJob) => Promise<void>;

export interface OutboxRunResult {
  readonly picked: number;
  readonly delivered: number;
  readonly failed: number;
  readonly deadLettered: number;
  /** 対応表に無い `kind` を持つ行の数（正常系では 0）。 */
  readonly unknownKinds: number;
}

/** `attempts` 回目の失敗に対する次回実行までの秒数。 */
export function backoffSeconds(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  const raw = OUTBOX_BACKOFF_BASE_SEC * 2 ** Math.min(exponent, 20);
  return Math.min(raw, OUTBOX_BACKOFF_CAP_SEC);
}

/** Phase 1 の既定配達（ログのみ。上の docstring を参照）。 */
export const logOnlyDeliver: OutboxDeliver = (job) => {
  logEvent("info", "outbox.delivered", {
    outboxId: job.id,
    kind: job.kind,
    transport: job.transport,
    attempts: job.attempts,
  });
  return Promise.resolve();
};

interface OutboxRow {
  readonly id: string;
  readonly kind: string;
  readonly attempts: number;
}

export interface OutboxRunOptions {
  readonly deliver?: OutboxDeliver;
  readonly now?: Date;
  readonly limit?: number;
}

/** 1 バッチ配る。呼び出し側がトランザクションを開く（`FOR UPDATE SKIP LOCKED` のため）。 */
export async function runOutboxBatch(
  tx: postgres.TransactionSql,
  options: OutboxRunOptions = {},
): Promise<OutboxRunResult> {
  const now = options.now ?? new Date();
  const deliver = options.deliver ?? logOnlyDeliver;
  const limit = options.limit ?? OUTBOX_BATCH_LIMIT;

  const rows = await tx<OutboxRow[]>`
    SELECT id, kind, attempts
    FROM outbox
    WHERE done_at IS NULL
      AND dead_lettered_at IS NULL
      AND run_after <= ${now}
      AND (locked_until IS NULL OR locked_until < ${now})
    ORDER BY run_after ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `;

  let delivered = 0;
  let failed = 0;
  let deadLettered = 0;
  let unknownKinds = 0;

  for (const row of rows) {
    let transport: OutboxTransport;
    try {
      transport = transportFor(row.kind);
    } catch (error) {
      if (!(error instanceof UnknownOutboxKindError)) throw error;
      unknownKinds += 1;
      const dead = await failJob(tx, row.id, "unknown_kind", row.attempts, now);
      failed += 1;
      if (dead) deadLettered += 1;
      continue;
    }

    try {
      await deliver({ id: row.id, kind: row.kind, transport, attempts: row.attempts });
      await tx`
        UPDATE outbox SET done_at = ${now}, locked_until = NULL WHERE id = ${row.id}
      `;
      delivered += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.name : "delivery_failed";
      const dead = await failJob(tx, row.id, reason, row.attempts, now);
      failed += 1;
      if (dead) deadLettered += 1;
    }
  }

  return { picked: rows.length, delivered, failed, deadLettered, unknownKinds };
}

/** 失敗を記録し、dead letter でなければ次回実行を指数バックオフで先送りする。 */
async function failJob(
  tx: postgres.TransactionSql,
  outboxId: string,
  reason: string,
  attemptsBefore: number,
  now: Date,
): Promise<boolean> {
  const dead = await recordOutboxFailure(tx, outboxId, reason, now);
  if (dead) return true;
  const nextRunAt = new Date(now.getTime() + backoffSeconds(attemptsBefore + 1) * 1000);
  await tx`
    UPDATE outbox
    SET run_after = ${nextRunAt}, locked_until = ${new Date(now.getTime() + OUTBOX_LOCK_SEC * 1000)}
    WHERE id = ${outboxId}
  `;
  return false;
}

async function handle(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as CronRouteEnv;

  if (routeEnv.APP_ENV !== CRON_PRODUCTION_APP_ENV) {
    return toErrorResponse(new AppError(CODE_NOT_FOUND, 404, "not found"), requestId);
  }
  const denied = checkCronRequest(request, routeEnv.APP_ENV, parseCronSecrets(routeEnv.CRON_SECRETS));
  if (denied !== null) return toErrorResponse(denied, requestId);

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    db = await createVerifiedDbClient(routeEnv);
    const dbHandle = db;
    const result = (await dbHandle.sql.begin((tx) =>
      runOutboxBatch(tx),
    )) as unknown as OutboxRunResult;
    logEvent("info", "cron.outbox", { requestId, ...result });
    return Response.json({ ...result, requestId }, { status: 200 });
  } catch (error) {
    logEvent("info", "cron.outbox.failed", {
      requestId,
      code: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL,
    });
    return toErrorResponse(error, requestId);
  } finally {
    if (db !== undefined) await db.close().catch(() => undefined);
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
