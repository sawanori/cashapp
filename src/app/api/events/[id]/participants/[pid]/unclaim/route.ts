/**
 * POST /api/events/:id/participants/:pid/unclaim — 幹事による claim の解除（§9 / check_085）。
 *
 * 解除すると `participant_claim` の未解放行が閉じ、本人（または別の人）が claim し直せる。
 * 支払済みの請求を持つ参加者を解除した場合は `invoice.needs_attention` を立てる
 * （O-9 に上がる）。ランクは動かさない（W3）。
 *
 * 理由は**固定の分類**で必須（自由記述を受け取らない。premortem P-07）。
 * 2 回目の呼び出しは解除対象が無い no-op になるため `Idempotency-Key` は要求しない。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { parseUnclaimBody, unclaimParticipant } from "@/lib/db/repositories/claims";
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

    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
    const input = parseUnclaimBody(bodyJson);

    const dbHandle = db;
    const result = await dbHandle.sql.begin(async (tx) => {
      const unclaimed = await unclaimParticipant(tx, session.userId, eventId, participantId);
      if (unclaimed.released) {
        await appendAuditLog(tx, {
          actorType: "organizer",
          action: "participant.unclaim",
          targetType: "participant",
          targetId: participantId,
          requestId,
          // 固定の分類のみ。自由記述は入れない（premortem P-07）。
          detail: { reason: input.reason, needsAttention: unclaimed.needsAttention },
        });
      }
      return unclaimed;
    });

    logEvent("info", "participants.unclaim", {
      requestId,
      userId: session.userId,
      outcome: result.released ? "released" : "no_active_claim",
      reason: input.reason,
    });

    return Response.json(
      {
        participantId: result.participantId,
        released: result.released,
        needsAttention: result.needsAttention,
        requestId,
      },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "participants.unclaim.failed", {
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
