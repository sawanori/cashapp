/**
 * DELETE /api/events/:id/participants/:pid（§9 / task_014）。
 *
 * 論理削除（`status='removed'`）。生きた決済試行があれば 409 `HAS_OPEN_ATTEMPT`。
 * 台帳（`ledger_entry`）を持つ請求の参加者は削除できる（check_081。物理的な請求・台帳データは
 * 一切変更しない。名簿からの表示のみが変わる）。
 *
 * `Idempotency-Key` は要求しない: 論理削除は既に removed の行に対して再実行しても同じ結果
 * （冪等な no-op）を返す設計であり、HTTP DELETE 自体が本質的に冪等であるため。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { removeParticipant } from "@/lib/db/repositories/participants";
import { AppError, ERROR_CODES, csrfInvalid, newRequestId, toErrorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;
interface RouteParams {
  readonly params: Promise<{ readonly id: string; readonly pid: string }>;
}

export async function DELETE(request: Request, { params }: RouteParams): Promise<Response> {
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
      await assertCsrfToken(config, request.headers.get(CSRF_HEADER), session.claims.jti, session.claims.kid);
    } catch {
      throw csrfInvalid("X-CSRF-Token missing or mismatched");
    }

    const dbHandle = db;
    const result = await dbHandle.sql.begin(async (tx) => {
      const removed = await removeParticipant(tx, session.userId, eventId, participantId);

      if (!removed.alreadyRemoved) {
        await appendAuditLog(tx, {
          actorType: "organizer",
          action: "participant.remove",
          targetType: "participant",
          targetId: removed.id,
          requestId,
        });
      }

      return removed;
    });

    logEvent("info", "participants.remove", {
      requestId,
      userId: session.userId,
      outcome: result.alreadyRemoved ? "already_removed" : "removed",
    });

    return Response.json({ id: result.id, status: "removed", requestId }, { status: 200 });
  } catch (error) {
    logEvent("info", "participants.remove.failed", {
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
