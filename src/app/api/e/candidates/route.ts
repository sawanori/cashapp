/**
 * GET /api/e/candidates — 名簿の候補（§9 / P-2 / check_002・check_086）。
 *
 * ★ セッション**と**同意が必要。`X-Join-Token` はイベントを特定するためだけに使い、
 *   それだけでは何の権限にもならない（§9 認可の原則）。
 * ★ 返すのは `id` と表示名だけ。金額・支払状況は 1 つも含めない。
 * ★ 幹事が氏名の共有を許可した行（`name_visibility='participants'`）に限る（R-LAW-06）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { assertParticipantConsent, listCandidates } from "@/lib/db/repositories/claims";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse } from "@/lib/errors";
import { readJoinTokenHeader, resolveEventByJoinToken } from "@/lib/join-token";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    const joinToken = readJoinTokenHeader(request);

    db = await createVerifiedDbClient(routeEnv);
    const session = await requireSession(config, db.sql, request);
    await assertParticipantConsent(db.sql, session.userId);

    const event = await resolveEventByJoinToken(db.sql, joinToken);
    const candidates = await listCandidates(db.sql, event.id);

    logEvent("info", "e.candidates", {
      requestId,
      userId: session.userId,
      count: candidates.length,
    });

    return Response.json(
      {
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          displayLabel: candidate.displayLabel,
        })),
        requestId,
      },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "e.candidates.failed", {
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
