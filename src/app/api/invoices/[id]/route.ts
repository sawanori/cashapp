/**
 * PATCH /api/invoices/:id — 請求金額の訂正（§9 / task_015）。
 *
 * `settlement_rank = 0`（未払い）かつ生きた決済試行が無いときだけ通す。それ以外は
 * 409 `INVOICE_NOT_EDITABLE`。金額は絶対値で受け取るため、同じ本文の再送は同じ結果になる
 * （`Idempotency-Key` は要求しない）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { parseUpdateInvoiceBody, updateInvoiceAmount } from "@/lib/db/repositories/invoices";
import {
  AppError,
  ERROR_CODES,
  badRequest,
  csrfInvalid,
  newRequestId,
  toErrorResponse,
} from "@/lib/errors";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;
interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export async function PATCH(request: Request, { params }: RouteParams): Promise<Response> {
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

    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
    const input = parseUpdateInvoiceBody(bodyJson);

    const dbHandle = db;
    const updated = await dbHandle.sql.begin(async (tx) => {
      const result = await updateInvoiceAmount(tx, session.userId, invoiceId, input);
      await appendAuditLog(tx, {
        actorType: "organizer",
        action: "invoice.amount_update",
        targetType: "invoice",
        targetId: result.id,
        amountMinor: result.amountMinor,
        requestId,
      });
      return result;
    });

    logEvent("info", "invoices.amount_update", {
      requestId,
      userId: session.userId,
      outcome: "updated",
    });

    return Response.json(
      { id: updated.id, amountMinor: updated.amountMinor, requestId },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "invoices.amount_update.failed", {
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
