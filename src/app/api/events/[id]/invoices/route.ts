/**
 * POST /api/events/:id/invoices — 請求の一括発行（§9 / O-6・O-6.5 / task_015）。
 *
 * O-6.5 の 2 段階確認を通ったことを示す `{ confirmed: true }` が必須。
 * 既に請求がある参加者はスキップする（DB の UNIQUE で構造的に二重発行しない）。
 * `Idempotency-Key` 必須（新しい行を作る経路であるため）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { issueInvoices, parseIssueInvoicesBody } from "@/lib/db/repositories/invoices";
import {
  AppError,
  ERROR_CODES,
  badRequest,
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

    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
    parseIssueInvoicesBody(bodyJson);

    const requestHash = await computeRequestHash(bodyJson);
    const userRef = idempotencyUserRef(session.userId);
    const dbHandle = db;

    const outcome = await dbHandle.sql.begin(async (tx) =>
      runIdempotent(
        {
          sql: tx,
          userRef,
          endpoint: `POST /api/events/${eventId}/invoices`,
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          const result = await issueInvoices(tx, session.userId, eventId);

          await appendAuditLog(tx, {
            actorType: "organizer",
            action: "invoice.issue_batch",
            targetType: "event",
            targetId: eventId,
            amountMinor: result.amountMinor,
            requestId,
            detail: { created: result.created, skipped: result.skipped },
          });

          return {
            statusCode: 201,
            cacheableBody: {
              created: result.created,
              skipped: result.skipped,
              amountMinor: result.amountMinor,
            },
          };
        },
      ),
    );

    logEvent("info", "invoices.issue", {
      requestId,
      userId: session.userId,
      outcome: outcome.replayed ? "replayed" : "created",
    });

    return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
  } catch (error) {
    logEvent("info", "invoices.issue.failed", {
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
