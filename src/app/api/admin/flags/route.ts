/**
 * `POST /api/admin/flags`（§9 / §7-6 / task_021 scope）。
 *
 * `PAYMENTS_ENABLED` と `PROVIDER_<KEY>_MODE` を書き換える唯一の経路。二人承認
 * （`src/lib/admin-auth.ts` の提案 → 承認。同一人物による承認は 24 時間クーリング。scope A23）。
 * 全操作は `audit_log` に記録される（提案行・承認行の 2 行）。
 *
 * `Authorization: Bearer <GitHub token>` を持たない Cookie ベースではないため CSRF トークンは
 * 要求しない（`src/lib/admin-auth.ts` の docstring 参照）。状態変更なので `Idempotency-Key` は
 * 要求する（§9 の一般規約。`propose` と `approve` は別エンドポイント名として冪等スコープを分ける）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
  type AdminEnv,
  LEGAL_CLEARANCE_CLEARED,
  approveAdminAction,
  proposeAdminAction,
  verifyAdmin,
} from "@/lib/admin-auth";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { FLAG_PAYMENTS_ENABLED } from "@/lib/db/repositories/gates";
import {
  AppError,
  ERROR_CODES,
  badRequest,
  newRequestId,
  toErrorResponse,
  type ErrorCode,
} from "@/lib/errors";
import {
  computeRequestHash,
  requireIdempotencyKey,
  runIdempotent,
} from "@/lib/idempotency";
import { logEvent } from "@/lib/logger";

type RouteEnv = AdminEnv & DbEnv;

const CODE_LEGAL_CLEARANCE_REQUIRED = "LEGAL_CLEARANCE_REQUIRED" as ErrorCode;

const PROVIDER_MODE_KEY_RE = /^PROVIDER_[A-Z0-9_]{1,32}_MODE$/;

function legalClearanceRequired(detail?: string): AppError {
  return new AppError(
    CODE_LEGAL_CLEARANCE_REQUIRED,
    409,
    "PAYMENTS_ENABLED を true にするには法務確認（legal-clearance）が完了している必要があります。",
    detail === undefined ? {} : { detail },
  );
}

/** `audit_log.id` は bigint だが、ここでは不透明な識別子として `idempotency_key.user_ref` を導く。 */
async function adminUserRef(adminId: string): Promise<Buffer> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adminId));
  return Buffer.from(digest).subarray(0, 16);
}

function isFlagKeyAllowed(key: string): boolean {
  return key === FLAG_PAYMENTS_ENABLED || PROVIDER_MODE_KEY_RE.test(key);
}

function isFlagValueAllowed(key: string, value: string): boolean {
  if (key === FLAG_PAYMENTS_ENABLED) return value === "true" || value === "false";
  return value === "on" || value === "off";
}

interface ProposeBody {
  readonly action: "propose";
  readonly key: string;
  readonly value: string;
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
    const key = record["key"];
    const value = record["value"];
    if (typeof key !== "string" || !isFlagKeyAllowed(key)) {
      throw badRequest(
        `key must be ${FLAG_PAYMENTS_ENABLED} or match ${PROVIDER_MODE_KEY_RE.source}`,
      );
    }
    if (typeof value !== "string" || !isFlagValueAllowed(key, value)) {
      throw badRequest("value is not a valid value for this key");
    }
    return { action: "propose", key, value };
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
      if (
        input.key === FLAG_PAYMENTS_ENABLED &&
        input.value === "true" &&
        !LEGAL_CLEARANCE_CLEARED
      ) {
        throw legalClearanceRequired("legal-clearance.json cleared is not true");
      }

      const outcome = await dbHandle.sql.begin(async (tx) =>
        runIdempotent(
          {
            sql: tx,
            userRef,
            endpoint: "POST /api/admin/flags:propose",
            key: idempotencyKey,
            requestHash,
          },
          async () => {
            const proposal = await proposeAdminAction(tx, {
              kind: "admin.flag",
              admin,
              subjectType: "feature_flag",
              subjectId: input.key,
              detail: { key: input.key, value: input.value },
              requestId,
            });
            return {
              statusCode: 200,
              cacheableBody: {
                proposalId: proposal.proposalId,
                key: input.key,
                value: input.value,
                requiresApproval: true,
              },
            };
          },
        ),
      );

      logEvent("info", "admin.flag.propose", { requestId, adminId: admin.adminId });
      return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
    }

    // approve
    const outcome = await dbHandle.sql.begin(async (tx) =>
      runIdempotent(
        {
          sql: tx,
          userRef,
          endpoint: "POST /api/admin/flags:approve",
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          const approved = await approveAdminAction(tx, {
            kind: "admin.flag",
            admin,
            proposalId: input.proposalId,
            requestId,
          });

          const key = approved.detail["key"];
          const value = approved.detail["value"];
          if (
            typeof key !== "string" ||
            typeof value !== "string" ||
            !isFlagKeyAllowed(key) ||
            !isFlagValueAllowed(key, value)
          ) {
            throw badRequest("proposal detail is not a valid flag change");
          }
          if (key === FLAG_PAYMENTS_ENABLED && value === "true" && !LEGAL_CLEARANCE_CLEARED) {
            throw legalClearanceRequired("legal-clearance.json cleared is not true");
          }

          await tx`
            INSERT INTO feature_flag (key, value, updated_by)
            VALUES (${key}, ${value}, ${admin.adminId})
            ON CONFLICT (key) DO UPDATE
              SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
          `;

          return {
            statusCode: 200,
            cacheableBody: { key, value, twoPerson: approved.twoPerson },
          };
        },
      ),
    );

    logEvent("info", "admin.flag.approve", { requestId, adminId: admin.adminId });
    return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
  } catch (error) {
    logEvent("info", "admin.flags.failed", {
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
