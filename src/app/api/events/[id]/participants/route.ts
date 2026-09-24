/**
 * POST/GET /api/events/:id/participants（§9 / O-4・O-5 / task_014）。
 *
 * POST: 参加者を一括登録し、参加者ごとに `claim_token` を発行する（応答でのみ返る）。
 * GET : 名簿をカーソルページングで返す（既定フィルタ `unpaid`、検索、並べ替え）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { createParticipants, listParticipants, parseCreateParticipantsBody, parseListParticipantsQuery } from "@/lib/db/repositories/participants";
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
    const input = parseCreateParticipantsBody(bodyJson);
    const requestHash = await computeRequestHash(bodyJson);
    const userRef = idempotencyUserRef(session.userId);
    const dbHandle = db;

    // 予約（idempotency_key）・業務書き込み・done 更新を 1 トランザクションにまとめる
    // （P-01 是正。`src/lib/idempotency.ts` の docstring）。
    const outcome = await dbHandle.sql.begin(async (tx) =>
      runIdempotent(
        {
          sql: tx,
          userRef,
          endpoint: `POST /api/events/${eventId}/participants`,
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          const created = await createParticipants(tx, session.userId, eventId, input.participants);

          await appendAuditLog(tx, {
            actorType: "organizer",
            action: "participant.create_batch",
            targetType: "event",
            targetId: eventId,
            requestId,
            detail: { count: created.length },
          });

          return {
            statusCode: 201,
            cacheableBody: {
              participants: created.map((participant) => ({
                id: participant.id,
                displayLabel: participant.displayLabel,
              })),
            },
            // claimToken は保存しない・再送では返さない（joinToken と同じ方針）。
            extra: {
              participants: created.map((participant) => ({
                id: participant.id,
                displayLabel: participant.displayLabel,
                claimToken: participant.claimToken,
              })),
            },
          };
        },
      ),
    );

    logEvent("info", "participants.create", {
      requestId,
      userId: session.userId,
      outcome: outcome.replayed ? "replayed" : "created",
    });

    return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
  } catch (error) {
    logEvent("info", "participants.create.failed", {
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

    const url = new URL(request.url);
    const query = parseListParticipantsQuery(url.searchParams);
    const result = await listParticipants(db.sql, session.userId, eventId, query);

    return Response.json(
      {
        participants: result.items.map((item) => ({
          id: item.id,
          displayLabel: item.displayLabel,
          status: item.rosterStatus,
          amountMinor: item.amountMinor,
          autoDetected: item.autoDetected,
          confirmationMethod: item.confirmationMethod,
          needsAttention: item.needsAttention,
        })),
        nextCursor: result.nextCursor,
        requestId,
      },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "participants.list.failed", {
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
