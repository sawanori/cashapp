/**
 * `GET|POST /api/cron/retention`（§7-7 / R-DATA-01 / check_043）。
 *
 * 実体は `src/lib/retention.ts`。日次で
 *   - 終了済みイベントの保持期限（終了 +90 日）を 1 度だけ書き
 *   - 期限を過ぎたイベントの `participant.display_label` を NULL 化し
 *     `event.organizer_label` を固定文字列へ置換し
 *   - 14 日を過ぎた `webhook_delivery.raw_body` を NULL 化する（`body_sha256` は残す）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { CRON_PRODUCTION_APP_ENV, checkCronRequest, parseCronSecrets } from "@/lib/cron-auth";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse, type ErrorCode } from "@/lib/errors";
import { logEvent } from "@/lib/logger";
import { runRetention } from "@/lib/retention";

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;

interface CronRouteEnv extends DbEnv {
  readonly APP_ENV?: string | undefined;
  readonly CRON_SECRETS?: string | undefined;
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
    const result = await runRetention(db.sql);
    logEvent("info", "cron.retention", { requestId, ...result });
    return Response.json({ ...result, requestId }, { status: 200 });
  } catch (error) {
    logEvent("info", "cron.retention.failed", {
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
