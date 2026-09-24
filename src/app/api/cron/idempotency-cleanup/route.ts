/**
 * `GET|POST /api/cron/idempotency-cleanup`（§7-7 / check_072 / check_104）。
 *
 * 期限切れの `idempotency_key`（TTL 24 時間）と `used_id_token`（TTL = ID トークンの `exp`）を
 * 消す。**`expires_at` を過ぎた行だけ**が対象で、未経過の行は残る（単回使用の保証を壊さない）。
 * 実体は `src/lib/retention.ts` の `runIdempotencyCleanup`。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { CRON_PRODUCTION_APP_ENV, checkCronRequest, parseCronSecrets } from "@/lib/cron-auth";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse, type ErrorCode } from "@/lib/errors";
import { logEvent } from "@/lib/logger";
import { runIdempotencyCleanup } from "@/lib/retention";

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
    const result = await runIdempotencyCleanup(db.sql);
    logEvent("info", "cron.idempotency_cleanup", { requestId, ...result });
    return Response.json({ ...result, requestId }, { status: 200 });
  } catch (error) {
    logEvent("info", "cron.idempotency_cleanup.failed", {
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
