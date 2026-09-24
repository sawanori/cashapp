/**
 * POST /api/e/self-report — 参加者の自己申告（§9 / P-3 / check_087）。
 *
 * ★ **`payment_self_report` にしか書かない。** 台帳（`ledger_entry`）にも
 *   `invoice.settlement_status` にも触れない（R-UX-02 / W3）。申告は「幹事が受け取ったと申告」
 *   された事実の記録であって、入金の確定ではない。
 * ★ 自由記述（メモ）は受け取らない（premortem P-07）。方法は固定の分類のみ。
 * ★ IP 単位のレート制限（§9: 429）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import {
  RateLimiterUnavailableError,
  resolveRateLimiter,
  type RateLimitEnv,
} from "@/lib/auth/rate-limit";
import { requireSession } from "@/lib/auth/session";
import { currentPepper, loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { loadUserRef, parseSelfReportBody, selfReport } from "@/lib/db/repositories/claims";
import {
  AppError,
  ERROR_CODES,
  badRequest,
  csrfInvalid,
  newRequestId,
  rateLimited,
  toErrorResponse,
} from "@/lib/errors";
import { readJoinTokenHeader, resolveEventByJoinToken } from "@/lib/join-token";
import { hashIp, logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv & RateLimitEnv;

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);

    let rateLimiter;
    try {
      rateLimiter = resolveRateLimiter(routeEnv);
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) {
        throw new AppError(
          ERROR_CODES.RATE_LIMIT_UNAVAILABLE,
          503,
          "ただいま受け付けできません。時間をおいてお試しください。",
          { detail: "no rate limiting backend is bound" },
        );
      }
      throw error;
    }

    const clientIp = request.headers.get("cf-connecting-ip");
    const pepper = currentPepper(config);
    const ipRef =
      clientIp === null || clientIp.length === 0 ? "unknown" : await hashIp(clientIp, pepper.value);
    const decision = await rateLimiter.check(`e-self-report:${ipRef}`);
    if (!decision.allowed) {
      throw rateLimited("self-report rate limit exceeded");
    }

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

    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
    const input = parseSelfReportBody(bodyJson);

    const event = await resolveEventByJoinToken(db.sql, joinToken);
    const userRef = await loadUserRef(db.sql, session.userId);
    const dbHandle = db;

    const reported = await dbHandle.sql.begin(async (tx) => {
      const result = await selfReport(tx, {
        eventId: event.id,
        lineUserRef: userRef.lineUserRef,
        input,
      });
      await appendAuditLog(tx, {
        actorType: "participant",
        actorRef: userRef.lineUserRef,
        action: "invoice.self_report",
        targetType: "invoice",
        targetId: result.invoiceId,
        requestId,
        detail: { method: input.method },
      });
      return result;
    });

    logEvent("info", "e.self_report", {
      requestId,
      userId: session.userId,
      outcome: "recorded",
    });

    return Response.json(
      { reportedAt: reported.reportedAt.toISOString(), state: "self_reported", requestId },
      { status: 201 },
    );
  } catch (error) {
    logEvent("info", "e.self_report.failed", {
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
