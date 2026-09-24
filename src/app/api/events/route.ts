/**
 * POST/GET /api/events（§9 / O-2・O-3 / task_014）。
 *
 * POST: イベントを作成する。`Idempotency-Key` 必須。`joinToken` は**この応答でのみ**返る。
 * GET : 自分（セッションの持ち主）が幹事のイベント一覧（O-2 の要対応バッジ用の内訳つき）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createEvent, listOrganizerEvents, parseCreateEventBody } from "@/lib/db/repositories/events";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, badRequest, csrfInvalid, newRequestId, toErrorResponse } from "@/lib/errors";
import {
  IDEMPOTENCY_HEADER,
  computeRequestHash,
  idempotencyUserRef,
  requireIdempotencyKey,
  runIdempotent,
} from "@/lib/idempotency";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv;

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

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
    const input = parseCreateEventBody(bodyJson);
    const requestHash = await computeRequestHash(bodyJson);
    const userRef = idempotencyUserRef(session.userId);
    const dbHandle = db;

    // 予約（idempotency_key）・業務書き込み・done 更新を 1 トランザクションにまとめる
    // （P-01 是正。`src/lib/idempotency.ts` の docstring）。
    const outcome = await dbHandle.sql.begin(async (tx) =>
      runIdempotent(
        { sql: tx, userRef, endpoint: "POST /api/events", key: idempotencyKey, requestHash },
        async () => {
          const result = await createEvent(tx, session.userId, input);

          await appendAuditLog(tx, {
            actorType: "organizer",
            action: "event.create",
            targetType: "event",
            targetId: result.event.id,
            requestId,
          });

          // O-3 の手数料提示への同意（consent_log。L6 / R-LAW-09）。
          await tx`
            INSERT INTO consent_log (user_id, consent_kind, text_version)
            VALUES (${session.userId}, 'fee_display', 'event-creation:v1')
          `;

          return {
            statusCode: 201,
            cacheableBody: {
              event: {
                id: result.event.id,
                title: result.event.title,
                organizerLabel: result.event.organizerLabel,
                status: result.event.status,
                eventAt: result.event.eventAt === null ? null : result.event.eventAt.toISOString(),
                collectByAt: result.event.collectByAt === null ? null : result.event.collectByAt.toISOString(),
                createdAt: result.event.createdAt.toISOString(),
              },
              // 保存される側。再送ではこちらだけが返るため false になる。
              joinTokenAvailable: false,
            },
            // joinToken は保存しない・再送では返さない（task_014 scope）。
            //
            // ★ task_015 の設計判断（C-014-6）: 生のトークンは DB にハッシュしか残さないため、
            //   この初回応答を取りこぼすと**サーバーにも復元できない**。冪等再送では
            //   `joinTokenAvailable: false`（保存側の既定値）が返るので、クライアントは
            //   「リンクを作り直す」導線（POST /api/events/:id/rotate-join-token）へ案内できる。
            extra: { joinToken: result.joinToken, joinTokenAvailable: true },
          };
        },
      ),
    );

    logEvent("info", "events.create", {
      requestId,
      userId: session.userId,
      outcome: outcome.replayed ? "replayed" : "created",
    });

    return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
  } catch (error) {
    logEvent("info", "events.create.failed", {
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

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    db = await createVerifiedDbClient(routeEnv);
    const session = await requireSession(config, db.sql, request);

    const events = await listOrganizerEvents(db.sql, session.userId);

    return Response.json(
      {
        events: events.map((event) => ({
          id: event.id,
          title: event.title,
          organizerLabel: event.organizerLabel,
          status: event.status,
          eventAt: event.eventAt === null ? null : event.eventAt.toISOString(),
          collectByAt: event.collectByAt === null ? null : event.collectByAt.toISOString(),
          participantCount: event.participantCount,
          unpaidCount: event.unpaidCount,
          needsAttentionCount: event.needsAttentionCount,
        })),
        requestId,
      },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "events.list.failed", {
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
