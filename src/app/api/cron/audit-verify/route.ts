/**
 * `GET|POST /api/cron/audit-verify`（§7-7 / §10-1 / R-SEC-15 / check_057）。
 *
 * `audit_log` の連鎖（`prev_hash` / `row_hash`）を検証する。日次実行。
 *
 * ★ 検証は `src/lib/audit.ts` の `verifyAuditChain`（＝ `npm run audit:verify` と同じ規則）を
 *   そのまま使う。ハッシュ計算の写しをこのファイルに作らない（写しが増えるほど、写し同士の
 *   ずれが新しい欠陥になる。premortem P-07 / 既存の `scripts/audit-verify.mjs` の注記）。
 *
 * ★ `verifyAuditChain` は **id 昇順の先頭から** `limit` 行を見る。したがって
 *   「直近 7 日だけ」を切り出す窓検証にはならない。窓検証には `audit.ts` 側に窓入口の
 *   `prev_hash` を種にする関数が要るが、`src/lib/audit.ts` は本タスクの変更対象では無い。
 *   代わりに **全行数が上限を超えていたら成功扱いにせず 500 で落とす**（検証していない
 *   範囲を「緑」と報告しない）。窓検証の実装は `docs/concerns/task_020.md` に残す。
 *
 * ★ 不一致のとき `PAYMENTS_ENABLED=false` を自動で引く経路は**作れない**。
 *   `feature_flag.updated_by` の CHECK が `system` / `agent` / `automation` を拒否しており
 *   （§10-2 / L11「人間のみ」）、自動化による書き込みは構造的に禁じられている。
 *   ここは 500 と `outbox` 由来ではないログで検知に留め、停止判断は人が行う（P-10）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { verifyAuditChain } from "@/lib/audit";
import { CRON_PRODUCTION_APP_ENV, checkCronRequest, parseCronSecrets } from "@/lib/cron-auth";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse, type ErrorCode } from "@/lib/errors";
import { logEvent } from "@/lib/logger";

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;
const CODE_INTERNAL = ERROR_CODES.INTERNAL;

/** 1 回の検証で見る上限行数。超えたら「検証できなかった」として失敗させる。 */
export const AUDIT_VERIFY_MAX_ROWS = 100_000;

/** 報告に添える窓（日）。検証範囲そのものではない（上の docstring）。 */
export const AUDIT_VERIFY_WINDOW_DAYS = 7;

interface CronRouteEnv extends DbEnv {
  readonly APP_ENV?: string | undefined;
  readonly CRON_SECRETS?: string | undefined;
}

async function handle(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as CronRouteEnv;

  if (routeEnv.APP_ENV !== CRON_PRODUCTION_APP_ENV) {
    return toErrorResponse(new AppError(CODE_NOT_FOUND, 404, "not found"), requestId);
  }
  const denied = checkCronRequest(request, routeEnv.APP_ENV, parseCronSecrets(routeEnv.CRON_SECRETS));
  if (denied !== null) return toErrorResponse(denied, requestId);

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    db = await createVerifiedDbClient(routeEnv);
    const since = new Date(Date.now() - AUDIT_VERIFY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const counts = await db.sql<{ total: number; recent: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE occurred_at > ${since})::int AS recent
      FROM audit_log
    `;
    const total = counts[0]?.total ?? 0;
    const recent = counts[0]?.recent ?? 0;

    if (total > AUDIT_VERIFY_MAX_ROWS) {
      logEvent("info", "cron.audit_verify.unverified", { requestId, total });
      throw new AppError(CODE_INTERNAL, 500, "audit chain exceeds the verifiable row limit");
    }

    const result = await verifyAuditChain(db.sql, { limit: AUDIT_VERIFY_MAX_ROWS });
    logEvent("info", "cron.audit_verify", {
      requestId,
      ok: result.ok,
      rowsChecked: result.rowsChecked,
      recentRows: recent,
    });
    if (!result.ok) {
      // 連鎖が壊れている。運用者が止める判断をするまで、この口は失敗し続ける。
      return Response.json(
        {
          code: "AUDIT_CHAIN_BROKEN",
          ok: false,
          rowsChecked: result.rowsChecked,
          brokenAtId: result.brokenAtId,
          recentRows: recent,
          requestId,
        },
        { status: 500 },
      );
    }
    return Response.json(
      { ok: true, rowsChecked: result.rowsChecked, recentRows: recent, requestId },
      { status: 200 },
    );
  } catch (error) {
    logEvent("info", "cron.audit_verify.failed", {
      requestId,
      code: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL,
    });
    return toErrorResponse(error, requestId);
  } finally {
    if (db !== undefined) await db.close().catch(() => undefined);
  }
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
