/**
 * POST /api/e/cannot-pay — 「この方法では払えない」（§9 / P-4 / check_088）。
 *
 * 自分の請求に要対応（`needs_attention`）を立て、幹事の要対応インボックス（O-9）に上げる。
 * ランクは動かさない（W3）。理由は `audit_log.action` の固定文字列で残し、自由記述は取らない
 * （premortem P-07）。
 *
 * 2 回目以降は同じフラグを立て直すだけの冪等な操作なので `Idempotency-Key` は要求しない。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { loadUserRef, reportCannotPay } from "@/lib/db/repositories/claims";
import { AppError, ERROR_CODES, csrfInvalid, newRequestId, toErrorResponse } from "@/lib/errors";
import { readJoinTokenHeader, resolveEventByJoinToken } from "@/lib/join-token";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    const joinToken = readJoinTokenHeader(request);

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

    const event = await resolveEventByJoinToken(db.sql, joinToken);
    const userRef = await loadUserRef(db.sql, session.userId);
    const dbHandle = db;

    await dbHandle.sql.begin(async (tx) => {
      const result = await reportCannotPay(tx, {
        eventId: event.id,
        lineUserRef: userRef.lineUserRef,
      });
      await appendAuditLog(tx, {
        actorType: "participant",
        actorRef: userRef.lineUserRef,
        action: "invoice.no_payment_method",
        targetType: "invoice",
        targetId: result.invoiceId,
        requestId,
      });
      return result;
    });

    logEvent("info", "e.cannot_pay", {
      requestId,
      userId: session.userId,
      outcome: "needs_attention",
    });

    return Response.json({ needsAttention: true, requestId }, { status: 200 });
  } catch (error) {
    logEvent("info", "e.cannot_pay.failed", {
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
