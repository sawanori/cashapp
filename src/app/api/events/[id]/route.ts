/**
 * GET/PATCH /api/events/:id（§9 / task_014）。
 *
 * GET  : サマリ専用（内訳・要対応件数・手数料見込み）。当該 organizer のみ（403 / 404）。
 * PATCH: title / collectByAt / status を更新する。`Idempotency-Key` 必須。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { getEventSummary, parseUpdateEventBody, updateEvent } from "@/lib/db/repositories/events";
import { AppError, ERROR_CODES, badRequest, csrfInvalid, newRequestId, toErrorResponse } from "@/lib/errors";
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

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;
  const { id } = await params;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    db = await createVerifiedDbClient(routeEnv);
    const session = await requireSession(config, db.sql, request);

    const summary = await getEventSummary(db.sql, session.userId, id);

    return Response.json(
      {
        event: {
          id: summary.id,
          title: summary.title,
          organizerLabel: summary.organizerLabel,
          status: summary.status,
          eventAt: summary.eventAt === null ? null : summary.eventAt.toISOString(),
          venue: summary.venue,
          offering: summary.offering,
          defaultAmountMinor: summary.defaultAmountMinor,
          collectByAt: summary.collectByAt === null ? null : summary.collectByAt.toISOString(),
          allowCash: summary.allowCash,
          minorsIncluded: summary.minorsIncluded,
          providerKey: summary.providerKey,
          createdAt: summary.createdAt.toISOString(),
        },
        participantCount: summary.participantCount,
        breakdown: summary.breakdown,
        feeEstimate: summary.feeEstimate,
        requestId,
      },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "events.summary.failed", {
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

export async function PATCH(request: Request, { params }: RouteParams): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;
  const { id } = await params;

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

    const idempotencyKey = requireIdempotencyKey(request);

    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
    const input = parseUpdateEventBody(bodyJson);
    const requestHash = await computeRequestHash(bodyJson);
    const userRef = idempotencyUserRef(session.userId);
    const dbHandle = db;

    // 予約（idempotency_key）・業務書き込み・done 更新を 1 トランザクションにまとめる
    // （P-01 是正。`src/lib/idempotency.ts` の docstring）。
    const outcome = await dbHandle.sql.begin(async (tx) =>
      runIdempotent(
        { sql: tx, userRef, endpoint: `PATCH /api/events/${id}`, key: idempotencyKey, requestHash },
        async () => {
          const result = await updateEvent(tx, session.userId, id, input);

          await appendAuditLog(tx, {
            actorType: "organizer",
            action: "event.update",
            targetType: "event",
            targetId: result.id,
            requestId,
            detail: { fields: Object.keys(input).sort() },
          });

          return {
            statusCode: 200,
            cacheableBody: {
              event: {
                id: result.id,
                title: result.title,
                status: result.status,
                collectByAt: result.collectByAt === null ? null : result.collectByAt.toISOString(),
              },
            },
          };
        },
      ),
    );

    logEvent("info", "events.update", {
      requestId,
      userId: session.userId,
      outcome: outcome.replayed ? "replayed" : "updated",
    });

    return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
  } catch (error) {
    logEvent("info", "events.update.failed", {
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
