/**
 * `GET /api/admin/gates`（§9 / §8-1 O-13 / task_021 scope）。
 *
 * 読み取り専用。正本は `docs/gates/compliance-gates.json`（Git 管理）であり、ここが返すのは
 * DB 射影（`compliance_gate`）と `feature_flag` の現在値だけである（`docs/gates/README.md`）。
 * 管理者はこの応答を見て `POST /api/admin/flags` の提案・承認を判断する。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { type AdminEnv, verifyAdmin } from "@/lib/admin-auth";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/logger";

type RouteEnv = AdminEnv & DbEnv;

interface ComplianceGateDbRow {
  readonly gate_key: string;
  readonly description: string;
  readonly required_for: readonly string[];
  readonly status: string;
  readonly valid_until: Date | null;
  readonly evidence_uri: string | null;
  readonly approved_by: string | null;
}

interface FeatureFlagDbRow {
  readonly key: string;
  readonly value: string;
  readonly updated_at: Date;
  readonly updated_by: string;
}

/**
 * `Date | string` を ISO 文字列にする。
 *
 * ★ `src/lib/db/client.ts` の `createDbClient` は `drizzle(client, {schema})` を呼ぶ際、
 *   drizzle-orm の postgres-js ドライバ（`node_modules/drizzle-orm/postgres-js/driver.cjs`
 *   の `construct()`）が **`client.options.parsers` / `serializers` を timestamp 系 OID
 *   （1184 等）についてその場で透過（no-op）に書き換える**ため、`db.sql`（drizzle を介さない
 *   生のタグ付きテンプレート）で timestamptz 列を読んでも、postgres.js の既定パーサ
 *   （`Date` へ変換）が働かず**生の文字列**のまま返る [実測: `SELECT now()` が
 *   `createDbClient` 経由では string、`tests/integration/setup.ts` の
 *   `createAppRwSql()`（drizzle を介さない別接続）経由では `Date` になることを直接比較して
 *   確認した]。`db/client.ts` はこのタスクの files_to_modify に含まれないため、ここでは
 *   `Date` と `string` のどちらが来ても正しく ISO 文字列化できるようにするだけに留める
 *   （根本原因の記録は `docs/concerns/task_021.md`）。
 */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const admin = await verifyAdmin({ request, env: routeEnv });

    db = await createVerifiedDbClient(routeEnv);

    const gateRows = await db.sql<ComplianceGateDbRow[]>`
      SELECT gate_key, description, required_for, status, valid_until, evidence_uri, approved_by
      FROM compliance_gate
      ORDER BY gate_key ASC
    `;
    const flagRows = await db.sql<FeatureFlagDbRow[]>`
      SELECT key, value, updated_at, updated_by
      FROM feature_flag
      ORDER BY key ASC
    `;

    logEvent("info", "admin.gates.read", { requestId, adminId: admin.adminId });

    return Response.json(
      {
        gates: gateRows.map((row) => ({
          gateKey: row.gate_key,
          description: row.description,
          requiredFor: row.required_for,
          status: row.status,
          validUntil: row.valid_until === null ? null : toIso(row.valid_until),
          evidenceUri: row.evidence_uri,
          approvedBy: row.approved_by,
        })),
        flags: flagRows.map((row) => ({
          key: row.key,
          value: row.value,
          updatedAt: toIso(row.updated_at),
          updatedBy: row.updated_by,
        })),
        requestId,
      },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "admin.gates.read.failed", {
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
