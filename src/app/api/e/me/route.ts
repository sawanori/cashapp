/**
 * GET /api/e/me — 自分の請求だけを返す（§9 / P-3 / check_002・check_004）。
 *
 * ★ **セッション必須**。有効な `X-Join-Token` を持っていても、セッションが無ければ 401。
 *   トークンはイベントを特定するだけで、請求の閲覧権限にはならない（§9 認可の原則）。
 * ★ claim していなければ 403 `NOT_CLAIMED`。
 * ★ 応答に他人の行は 1 つも含まれない（SQL が `participant_claim.line_user_ref` から辿る）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { getMyInvoice, loadUserRef } from "@/lib/db/repositories/claims";
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

    const event = await resolveEventByJoinToken(db.sql, joinToken);
    const userRef = await loadUserRef(db.sql, session.userId);
    const view = await getMyInvoice(db.sql, event.id, userRef.lineUserRef);

    logEvent("info", "e.me", { requestId, userId: session.userId, outcome: view.state });

    return Response.json(
      {
        event: {
          title: view.eventTitle,
          organizerLabel: view.organizerLabel,
          collectByAt: view.collectByAt === null ? null : view.collectByAt.toISOString(),
        },
        participant: {
          id: view.participantId,
          displayLabel: view.displayLabel,
        },
        invoice:
          view.invoiceId === null
            ? null
            : {
                id: view.invoiceId,
                amountMinor: view.amountMinor,
                currency: view.currency,
                autoDetected: view.autoDetected,
                confirmationMethod: view.confirmationMethod,
                selfReportedAt:
                  view.selfReportedAt === null ? null : view.selfReportedAt.toISOString(),
              },
        state: view.state,
        requestId,
      },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "e.me.failed", {
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
