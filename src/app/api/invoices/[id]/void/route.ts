/**
 * POST /api/invoices/:id/void — 請求の取消（§9 / check_008 / task_015）。
 *
 * `settlement_rank < 40` かつ `lifecycle_state='active'` のときだけ通す。支払済み・取消済みは
 * 409 `VOID_NOT_ALLOWED`。
 *
 * ★ **Webhook 経路からこのルート（および `voidInvoice`）を呼ばない**（check_008）。
 *   取消は幹事のセッションを持つこの経路だけの操作であり、外部由来のイベントで請求を
 *   取り消すことはしない。
 *
 * 2 回目の呼び出しは 409 になるだけで副作用が重ならないため、`Idempotency-Key` は要求しない。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { voidInvoice } from "@/lib/db/repositories/invoices";
import {
  AppError,
  ERROR_CODES,
  csrfInvalid,
  newRequestId,
  toErrorResponse,
} from "@/lib/errors";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;
interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;
  const { id: invoiceId } = await params;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    db = await createVerifiedDbClient(routeEnv);
    const session = await requireSession(config, db.sql, request);

    try {
      await assertCsrfToken(
        config,
        request.headers.get(CSRF_HEADER),
        session.claims.jti,
        session.claims.kid,
      );
    } catch {
      throw csrfInvalid("X-CSRF-Token missing or mismatched");
    }

    const dbHandle = db;
    const voided = await dbHandle.sql.begin(async (tx) => {
      const result = await voidInvoice(tx, session.userId, invoiceId);
      await appendAuditLog(tx, {
        actorType: "organizer",
        action: "invoice.void",
        targetType: "invoice",
        targetId: result.id,
        amountMinor: result.amountMinor,
        requestId,
      });
      return result;
    });

    logEvent("info", "invoices.void", {
      requestId,
      userId: session.userId,
      outcome: "voided",
    });

    return Response.json(
      { id: voided.id, lifecycleState: voided.lifecycleState, requestId },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "invoices.void.failed", {
      requestId,
      code: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL,
    });
    return toErrorResponse(error, requestId);
  } finally {
    if (db !== undefined) {
      await db.close().catch(() => undefined);
    }
  }
}
