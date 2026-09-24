/**
 * POST /api/events/:id/rotate-join-token — 招待トークンの差し替え（§9 / task_015）。
 *
 * 旧トークンはこの瞬間から 404 になる。新しい生のトークンは**この応答でだけ**返る
 * （DB にはハッシュしか残らない）。
 *
 * ★ `Idempotency-Key` 必須。ローテーションは本質的に非冪等（呼ぶたびに旧リンクが死ぬ）で、
 *   ネットワークの再送でリンクを次々に無効化させないため。再送時は保存済み応答を返すが、
 *   **生のトークンは保存しない**ので再送の応答には含まれない（`joinTokenAvailable: false`）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { rotateJoinToken } from "@/lib/join-token";
import {
  AppError,
  ERROR_CODES,
  csrfInvalid,
  newRequestId,
  toErrorResponse,
} from "@/lib/errors";
import {
  computeRequestHash,
  idempotencyUserRef,
  requireIdempotencyKey,
  runIdempotent,
} from "@/lib/idempotency";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;
interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;
  const { id: eventId } = await params;

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

    const idempotencyKey = requireIdempotencyKey(request);
    const requestHash = await computeRequestHash({ eventId });
    const userRef = idempotencyUserRef(session.userId);
    const dbHandle = db;

    const outcome = await dbHandle.sql.begin(async (tx) =>
      runIdempotent(
        {
          sql: tx,
          userRef,
          endpoint: `POST /api/events/${eventId}/rotate-join-token`,
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          const rotated = await rotateJoinToken(tx, session.userId, eventId);

          await appendAuditLog(tx, {
            actorType: "organizer",
            action: "event.rotate_join_token",
            targetType: "event",
            targetId: eventId,
            requestId,
            detail: { version: rotated.version },
          });

          return {
            statusCode: 200,
            // 保存してよいのはメタ情報だけ。生のトークンは `extra` に載せて保存しない。
            cacheableBody: {
              joinTokenExpiresAt: rotated.expiresAt.toISOString(),
              joinTokenVersion: rotated.version,
              joinTokenAvailable: false,
            },
            extra: { joinToken: rotated.token, joinTokenAvailable: true },
          };
        },
      ),
    );

    logEvent("info", "events.rotate_join_token", {
      requestId,
      userId: session.userId,
      outcome: outcome.replayed ? "replayed" : "rotated",
    });

    return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
  } catch (error) {
    logEvent("info", "events.rotate_join_token.failed", {
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
