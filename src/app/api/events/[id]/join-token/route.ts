/**
 * GET /api/events/:id/join-token — 招待トークンの状態（§9 / O-7 / task_015）。
 *
 * ★ **生のトークンは返らない。** DB にはハッシュしか無いので、発行時の 1 回を逃すと
 *   サーバーにも復元できない（これは設計であって不足ではない。`src/lib/join-token.ts`）。
 *   配布用リンクを取り直したいときは `POST /api/events/:id/rotate-join-token` を使う
 *   （旧リンクは無効になる）。応答の `tokenRetrievable` が常に `false` なのはそのためで、
 *   task_014 の残課題 C-014-6（冪等再送で joinToken を失う）の回答でもある。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { getJoinTokenStatus } from "@/lib/join-token";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;
interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;
  const { id: eventId } = await params;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    db = await createVerifiedDbClient(routeEnv);
    const session = await requireSession(config, db.sql, request);

    const status = await getJoinTokenStatus(db.sql, session.userId, eventId);

    return Response.json(
      {
        joinTokenExpiresAt: status.expiresAt === null ? null : status.expiresAt.toISOString(),
        joinTokenVersion: status.version,
        expired: status.expired,
        tokenRetrievable: status.tokenRetrievable,
        requestId,
      },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "events.join_token_status.failed", {
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
