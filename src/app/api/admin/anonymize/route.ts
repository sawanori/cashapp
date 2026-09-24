/**
 * `POST /api/admin/anonymize`（§9 / §8-1 O-13 / §7-5 / task_021 scope）。
 *
 * 削除請求への擬似匿名化。対象は §7-5 が定める保持対象の 2 列だけである:
 *   - `target: "organizer"` — `event.organizer_label`（`NOT NULL` のため固定のプレースホルダ
 *     `(削除済み)` に置き換える。cron の保持期間処理（task_020）が 90 日後に行う NULL 化を、
 *     削除請求時点で前倒しする操作に相当する）
 *   - `target: "participant"` — `participant.display_label`（`NULL` 可のため `NULL` にする）
 *
 * 物理削除ではない（規約に明記。`src/content/terms.md`）。二人承認は要求しない（scope の
 * 二人承認対象は `POST /api/admin/flags` と `POST /api/admin/suspend` のみ）。単独の管理者操作
 * として `audit_log` に 1 行残す。`detail` に自由記述は含めない（P-07。件数のみ記録する）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { type AdminEnv, verifyAdmin } from "@/lib/admin-auth";
import { appendAuditLog } from "@/lib/audit";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, badRequest, newRequestId, toErrorResponse } from "@/lib/errors";
import { computeRequestHash, requireIdempotencyKey, runIdempotent } from "@/lib/idempotency";
import { logEvent } from "@/lib/logger";

type RouteEnv = AdminEnv & DbEnv;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §7-5 の「終了 + 90 日で NULL 化」対象と同じ文言（保持できない= 空文字ではなく明示のプレースホルダ）。 */
export const ANONYMIZED_ORGANIZER_LABEL = "(削除済み)";

async function adminUserRef(adminId: string): Promise<Buffer> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adminId));
  return Buffer.from(digest).subarray(0, 16);
}

interface AnonymizeBody {
  readonly target: "organizer" | "participant";
  readonly targetId: string;
}

function parseBody(body: unknown): AnonymizeBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const target = record["target"];
  if (target !== "organizer" && target !== "participant") {
    throw badRequest("target must be 'organizer' or 'participant'");
  }
  const targetId = record["targetId"];
  if (typeof targetId !== "string" || !UUID_RE.test(targetId)) {
    throw badRequest("targetId must be a UUID");
  }
  return { target, targetId };
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

    const outcome = await dbHandle.sql.begin(async (tx) =>
      runIdempotent(
        {
          sql: tx,
          userRef,
          endpoint: "POST /api/admin/anonymize",
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          let affected: number;
          if (input.target === "organizer") {
            const rows = await tx<{ id: string }[]>`
              UPDATE event
              SET organizer_label = ${ANONYMIZED_ORGANIZER_LABEL}
              WHERE organizer_user_id = ${input.targetId}
                AND organizer_label <> ${ANONYMIZED_ORGANIZER_LABEL}
              RETURNING id
            `;
            affected = rows.length;
          } else {
            const rows = await tx<{ id: string }[]>`
              UPDATE participant
              SET display_label = NULL
              WHERE id = ${input.targetId} AND display_label IS NOT NULL
              RETURNING id
            `;
            affected = rows.length;
          }

          await appendAuditLog(tx, {
            actorType: "admin",
            actorRef: Buffer.from(admin.adminId, "utf8"),
            action: "admin.anonymize",
            targetType: input.target === "organizer" ? "app_user" : "participant",
            targetId: input.targetId,
            requestId,
            detail: { target: input.target, affected },
          });

          return { statusCode: 200, cacheableBody: { target: input.target, targetId: input.targetId, affected } };
        },
      ),
    );

    logEvent("info", "admin.anonymize", { requestId, adminId: admin.adminId });
    return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
  } catch (error) {
    logEvent("info", "admin.anonymize.failed", {
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
