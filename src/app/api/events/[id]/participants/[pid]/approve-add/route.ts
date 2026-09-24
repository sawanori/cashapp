/**
 * POST /api/events/:id/participants/:pid/approve-add — 追加リクエストの承認（§9 / check_088）。
 *
 * 参加者が `POST /api/e/request-add` で作った未承認の行を、幹事が名簿の一員として認める。
 * 承認すると claim できるようになり、請求発行の対象にもなる。
 *
 * `confirmed_by_organizer_at` は `COALESCE` で 1 度だけ立てるため、2 回目以降は同じ結果を返す
 * 冪等な操作である（`Idempotency-Key` は要求しない）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { approveAdd } from "@/lib/db/repositories/claims";
import { AppError, ERROR_CODES, csrfInvalid, newRequestId, toErrorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;
interface RouteParams {
  readonly params: Promise<{ readonly id: string; readonly pid: string }>;
}

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;
  const { id: eventId, pid: participantId } = await params;

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
    const approved = await dbHandle.sql.begin(async (tx) => {
      const result = await approveAdd(tx, session.userId, eventId, participantId);
      await appendAuditLog(tx, {
        actorType: "organizer",
        action: "participant.approve_add",
        targetType: "participant",
        targetId: result.participantId,
        requestId,
      });
      return result;
    });

    logEvent("info", "participants.approve_add", {
      requestId,
      userId: session.userId,
      outcome: "approved",
    });

    return Response.json(
      {
        participantId: approved.participantId,
        confirmedAt: approved.confirmedAt.toISOString(),
        requestId,
      },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "participants.approve_add.failed", {
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
