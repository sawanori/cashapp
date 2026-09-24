/**
 * `POST /api/admin/suspend`（§9 / §8-1 O-13 / task_021 scope）。
 *
 * 幹事の `app_user.status` を `suspended` にする。二人承認（A23 縮退つき。
 * `src/lib/admin-auth.ts`）。停止と同時に `session_epoch` を進め、発行済みのセッションを
 * 即座に失効させる（`src/lib/auth/session.ts` の epoch 機構をそのまま使う）。
 *
 * ★ `detail` に理由等の自由記述を含めない（premortem P-07。`src/lib/admin-auth.ts` の
 *   モジュール docstring）。停止理由の運用上の記録は本アプリの外（人間どうしの連絡）で行う。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { type AdminEnv, approveAdminAction, proposeAdminAction, verifyAdmin } from "@/lib/admin-auth";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, badRequest, newRequestId, toErrorResponse, type ErrorCode } from "@/lib/errors";
import { computeRequestHash, requireIdempotencyKey, runIdempotent } from "@/lib/idempotency";
import { logEvent } from "@/lib/logger";

type RouteEnv = AdminEnv & DbEnv;

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function adminUserRef(adminId: string): Promise<Buffer> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adminId));
  return Buffer.from(digest).subarray(0, 16);
}

interface ProposeBody {
  readonly action: "propose";
  readonly organizerUserId: string;
}

interface ApproveBody {
  readonly action: "approve";
  readonly proposalId: string;
}

function parseBody(body: unknown): ProposeBody | ApproveBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const action = record["action"];

  if (action === "propose") {
    const organizerUserId = record["organizerUserId"];
    if (typeof organizerUserId !== "string" || !UUID_RE.test(organizerUserId)) {
      throw badRequest("organizerUserId must be a UUID");
    }
    return { action: "propose", organizerUserId };
  }
  if (action === "approve") {
    const proposalId = record["proposalId"];
    if (typeof proposalId !== "string" || proposalId.length === 0) {
      throw badRequest("proposalId is required");
    }
    return { action: "approve", proposalId };
  }
  throw badRequest("action must be 'propose' or 'approve'");
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const admin = await verifyAdmin({ request, env: routeEnv });
    const idempotencyKey = requireIdempotencyKey(request);

    let bodyJson: unknown;
    try {
      bodyJson = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
    const input = parseBody(bodyJson);
    const requestHash = await computeRequestHash(bodyJson);

    db = await createVerifiedDbClient(routeEnv);
    const dbHandle = db;
    const userRef = await adminUserRef(admin.adminId);

    if (input.action === "propose") {
      const exists = await dbHandle.sql<{ id: string }[]>`
        SELECT id FROM app_user WHERE id = ${input.organizerUserId}
      `;
      if (exists.length === 0) {
        throw new AppError(CODE_NOT_FOUND, 404, "対象の利用者が見つかりません。");
      }

      const outcome = await dbHandle.sql.begin(async (tx) =>
        runIdempotent(
          {
            sql: tx,
            userRef,
            endpoint: "POST /api/admin/suspend:propose",
            key: idempotencyKey,
            requestHash,
          },
          async () => {
            const proposal = await proposeAdminAction(tx, {
              kind: "admin.suspend",
              admin,
              subjectType: "app_user",
              subjectId: input.organizerUserId,
              detail: { organizerUserId: input.organizerUserId },
              requestId,
            });
            return {
              statusCode: 200,
              cacheableBody: {
                proposalId: proposal.proposalId,
                organizerUserId: input.organizerUserId,
                requiresApproval: true,
              },
            };
          },
        ),
      );

      logEvent("info", "admin.suspend.propose", { requestId, adminId: admin.adminId });
      return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
    }

    // approve
    const outcome = await dbHandle.sql.begin(async (tx) =>
      runIdempotent(
        {
          sql: tx,
          userRef,
          endpoint: "POST /api/admin/suspend:approve",
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          const approved = await approveAdminAction(tx, {
            kind: "admin.suspend",
            admin,
            proposalId: input.proposalId,
            requestId,
          });

          const organizerUserId = approved.detail["organizerUserId"];
          if (typeof organizerUserId !== "string" || !UUID_RE.test(organizerUserId)) {
            throw badRequest("proposal detail is not a valid suspend target");
          }

          const updated = await tx<{ id: string; status: string }[]>`
            UPDATE app_user
            SET status = 'suspended', suspended_at = now(), session_epoch = session_epoch + 1
            WHERE id = ${organizerUserId} AND status <> 'suspended'
            RETURNING id, status
          `;
          const alreadySuspended = updated.length === 0;

          return {
            statusCode: 200,
            cacheableBody: { organizerUserId, alreadySuspended, twoPerson: approved.twoPerson },
          };
        },
      ),
    );

    logEvent("info", "admin.suspend.approve", { requestId, adminId: admin.adminId });
    return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
  } catch (error) {
    logEvent("info", "admin.suspend.failed", {
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
