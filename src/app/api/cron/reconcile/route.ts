/**
 * `GET|POST /api/cron/reconcile`（§7-7 / §9 / W9 / W11 / R-OPS-08）。
 *
 * cron Worker（`workers/cron/`）が 5 分ごとに `X-Cron-Secret` 付きで呼ぶ。
 * 実体は `src/lib/reconcile.ts`。このファイルは認可と DB 接続だけを持つ。
 *
 * ★ `APP_ENV !== 'production'` は**無条件 404**（§7-7）。DB にも触れない。
 * ★ ロックが取れなければ 200 で `ran: false`（no-op）。cron が重なっても壊れない。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { CRON_PRODUCTION_APP_ENV, checkCronRequest, parseCronSecrets } from "@/lib/cron-auth";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse, type ErrorCode } from "@/lib/errors";
import { logEvent } from "@/lib/logger";
import { resolveProviderWithoutGate } from "@/lib/payments/registry";
import type { PaymentProvider } from "@/lib/payments/types";
import { runReconcile, type StatusQuerier } from "@/lib/reconcile";

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;

interface CronRouteEnv extends DbEnv {
  readonly APP_ENV?: string | undefined;
  readonly CRON_SECRETS?: string | undefined;
}

/**
 * 実行時の照会口。`capabilities.statusQuery === false` のアダプタ（Phase 1 の
 * `manual_confirm`）は `null` を返して走査対象から外す（照会できない事業者を
 * 何度も叩かない）。
 */
export function runtimeStatusQuerier(): StatusQuerier {
  return {
    query(binding, externalRef) {
      let provider: PaymentProvider;
      try {
        provider = resolveProviderWithoutGate(binding.providerKey);
      } catch {
        return null;
      }
      if (!provider.capabilities.statusQuery) return null;
      return provider.getPaymentStatus(binding, externalRef);
    },
  };
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
    const result = await runReconcile(db.sql, {
      querier: runtimeStatusQuerier(),
      requestId,
    });
    logEvent("info", "cron.reconcile", {
      requestId,
      ran: result.ran,
      scanned: result.scanned,
      advanced: result.advanced,
      mismatches: result.mismatches,
      truncated: result.truncated,
    });
    return Response.json({ ...result, requestId }, { status: 200 });
  } catch (error) {
    logEvent("info", "cron.reconcile.failed", {
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
