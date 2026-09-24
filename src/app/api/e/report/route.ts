/**
 * `POST /api/e/report`（§9 / task_021 scope）。
 *
 * 参加者からの通報を `abuse_report` に記録する。claim 前でも呼べる（セッション＋同意があれば
 * 足りる。`src/lib/db/repositories/claims.ts` の `assertParticipantConsent`）。
 *
 * ★ レート制限（scope「幹事あたり上限（サーバー強制）」の一部・「上限超過 429」）。
 *   `src/lib/auth/rate-limit.ts` の `resolveRateLimiter` をそのまま使う（バインディングは
 *   `AUTH_RATE_LIMITER` を共有し、キーの接頭辞でエンドポイントを分ける）。バインディングが
 *   無い環境では fail-closed（503 `RATE_LIMIT_UNAVAILABLE`）。
 *
 * ★ `reason` は自由記述だが、`abuse_report.reason` は保持期間対象外（premortem P-07 の既知の
 *   限界。DB の `CHECK` で 1〜1000 文字に絞るのみ）。`audit_log.detail` にはコピーしない
 *   （`event_id` のみを記録する）。
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
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { assertParticipantConsent, loadUserRef } from "@/lib/db/repositories/claims";
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
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv & RateLimitEnv;

const REASON_MIN = 1;
const REASON_MAX = 1000;
/** バインディングを `/api/auth/line` と共有するための接頭辞。ウィンドウはバインディング側の設定。 */
const RATE_LIMIT_KEY_PREFIX = "e-report";

function parseReason(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const reason = (body as Record<string, unknown>)["reason"];
  if (typeof reason !== "string") throw badRequest("reason is required");
  const trimmed = reason.trim();
  if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
    throw badRequest(`reason must be between ${REASON_MIN} and ${REASON_MAX} chars`);
  }
  return trimmed;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    const joinToken = readJoinTokenHeader(request);

    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
    const reason = parseReason(bodyJson);

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
    await assertParticipantConsent(db.sql, session.userId);

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
    const decision = await rateLimiter.check(`${RATE_LIMIT_KEY_PREFIX}:${event.id}:${session.userId}`);
    if (!decision.allowed) {
      throw rateLimited("abuse report rate limit exceeded");
    }

    const userRef = await loadUserRef(db.sql, session.userId);
    const dbHandle = db;

    const reportId = await dbHandle.sql.begin(async (tx) => {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO abuse_report (event_id, reporter_user_ref, reason)
        VALUES (${event.id}, ${userRef.lineUserRef}, ${reason})
        RETURNING id
      `;
      const row = inserted[0];
      if (row === undefined) throw new Error("abuse_report insert returned no row");

      await appendAuditLog(tx, {
        actorType: "participant",
        actorRef: userRef.lineUserRef,
        action: "event.abuse_report",
        targetType: "event",
        targetId: event.id,
        requestId,
        detail: {},
      });

      return row.id;
    });

    logEvent("info", "e.report", { requestId, userId: session.userId, outcome: "reported" });

    return Response.json({ reported: true, reportId, requestId }, { status: 201 });
  } catch (error) {
    logEvent("info", "e.report.failed", {
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
