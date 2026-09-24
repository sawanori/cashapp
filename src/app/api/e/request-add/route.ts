/**
 * POST /api/e/request-add — 名簿への追加リクエスト（§9 / P-2 候補 0 件 / check_088）。
 *
 * 幹事承認制。ここで作られる行は `claim_token_hash` も `confirmed_by_organizer_at` も持たず、
 * 幹事が `POST /api/events/:id/participants/:pid/approve-add` を通すまで
 * claim も請求発行もされない。
 *
 * ★ セッション ＋ 同意 ＋ `X-Join-Token`。加えて IP 単位のレート制限（§9: 429）。
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
import {
  assertParticipantConsent,
  loadUserRef,
  parseRequestAddBody,
  requestAdd,
} from "@/lib/db/repositories/claims";
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
    const decision = await rateLimiter.check(`e-request-add:${ipRef}`);
    if (!decision.allowed) {
      throw rateLimited("request-add rate limit exceeded");
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

    await assertParticipantConsent(db.sql, session.userId);

    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
    const input = parseRequestAddBody(bodyJson);

    const event = await resolveEventByJoinToken(db.sql, joinToken);
    const userRef = await loadUserRef(db.sql, session.userId);
    const dbHandle = db;

    const created = await dbHandle.sql.begin(async (tx) => {
      const result = await requestAdd(tx, event.id, {
        lineUserRef: userRef.lineUserRef,
        pepperVersion: userRef.pepperVersion,
        input,
      });
      await appendAuditLog(tx, {
        actorType: "participant",
        actorRef: userRef.lineUserRef,
        action: "participant.request_add",
        targetType: "participant",
        targetId: result.participantId,
        requestId,
      });
      return result;
    });

    logEvent("info", "e.request_add", {
      requestId,
      userId: session.userId,
      outcome: "awaiting_approval",
    });

    return Response.json(
      {
        participantId: created.participantId,
        awaitingApproval: created.awaitingApproval,
        requestId,
      },
      { status: 201 },
    );
  } catch (error) {
    logEvent("info", "e.request_add.failed", {
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
