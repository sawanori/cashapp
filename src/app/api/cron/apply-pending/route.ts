/**
 * `GET|POST /api/cron/apply-pending`（§9 Webhook 処理手順 ⑥ / R-PAY-11 / check_104）。
 *
 * 保存されたのに台帳へ適用されていない `payment_event`（`apply_result IS NULL AND
 * processed_at IS NULL`）を拾って適用し直す。生まれ方は 2 つ:
 *   - 受信は成功したが、ゲート未通過で**適用だけ保留**した行（§7-6）
 *   - 受信トランザクションと適用トランザクションを分けざるを得なかった行（§9）
 *
 * ★ **ゲートはここで取り直す。** 保留の理由がまだ生きているなら適用しない
 *   （`PAYMENTS_ENABLED` が false のままの行を cron が黙って台帳へ流し込んだら、
 *   キルスイッチが効いていないのと同じである）。
 *
 * ★ 取り出しは `FOR UPDATE SKIP LOCKED`。cron が重なっても同じ行を 2 回適用しない。
 *   仮に 2 回適用されても `ledger_entry (invoice_id, dedupe_key)` の一意制約で止まる（W2）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type postgres from "postgres";

import { defaultApplyGate } from "@/app/api/webhooks/[providerKey]/[bindingRef]/route";
import { CRON_PRODUCTION_APP_ENV, checkCronRequest, parseCronSecrets } from "@/lib/cron-auth";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse, type ErrorCode } from "@/lib/errors";
import { applyToLedger } from "@/lib/ledger/apply";
import { ledgerDedupeKey } from "@/lib/ledger/dedupe";
import { logEvent } from "@/lib/logger";
import { yen } from "@/lib/payments/money";
import type { NormalizedEvent, PaymentEventKind, ProviderBinding } from "@/lib/payments/types";

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;

/** 1 回で**適用する**上限。 */
export const APPLY_PENDING_LIMIT = 100;

/**
 * 1 回で**読み飛ばせる**上限（GPT 敵対レビュー F-5）。
 *
 * ゲートが閉じている事業者の保留が先頭に 100 件たまると、`id` 昇順の 1 ページ目がそれで
 * 埋まり、後続の「適用できる」イベントへ永久に到達しない（先頭詰まり）。見送った行は
 * 状態が変わらないので、次回も同じ 1 ページ目が返ってくる。ページを進めて読み飛ばす。
 */
export const APPLY_PENDING_MAX_SCAN = 1_000;

interface CronRouteEnv extends DbEnv {
  readonly APP_ENV?: string | undefined;
  readonly CRON_SECRETS?: string | undefined;
}

interface PendingRow {
  readonly id: string;
  readonly provider_key: string;
  readonly provider_event_id: string;
  readonly event_type: string;
  readonly kind: string;
  readonly external_ref: string;
  readonly business_idem_key: string;
  readonly amount_minor: number | null;
  readonly currency: string | null;
  readonly occurred_at: Date | null;
  readonly trust: string;
}

interface AttemptBindingRow {
  readonly id: string;
  readonly organizer_user_id: string;
  readonly provider_key: string;
  readonly status: string;
  readonly credential_ref: string | null;
  readonly credential_fp: string | null;
  readonly receiving_identifier: string | null;
  readonly receiving_identifier_kind: string | null;
}

export interface ApplyPendingResult {
  readonly picked: number;
  readonly applied: number;
  readonly duplicates: number;
  /** ゲートがまだ閉じているため見送った件数。 */
  readonly stillHeld: number;
  readonly other: number;
}

export interface ApplyPendingOptions {
  readonly appEnv: string | undefined;
  readonly requestId: string;
  readonly now?: Date;
  readonly limit?: number;
  /** 見送った行を読み飛ばす上限。既定は `APPLY_PENDING_MAX_SCAN`。 */
  readonly maxScan?: number;
  /** 既定は `defaultApplyGate`。テストは開/閉を直接渡す。 */
  readonly applyGate?: (binding: ProviderBinding) => Promise<string | null>;
}

function toEvent(row: PendingRow): NormalizedEvent {
  const kind = row.kind as PaymentEventKind;
  return {
    providerKey: row.provider_key,
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    kind,
    externalRef: row.external_ref,
    businessIdemKey: row.business_idem_key,
    // `payment_event` は dedupe_key を保存しないため、既定の組み立て規則で復元する
    // （アダプタが独自の宣言を持つ場合の差は docs/concerns/task_020.md に記録）。
    ledgerDedupeKey: ledgerDedupeKey({
      providerKey: row.provider_key,
      kind,
      providerEventId: row.provider_event_id,
    }),
    money:
      row.amount_minor !== null && row.amount_minor > 0 && row.currency === "JPY"
        ? yen(row.amount_minor)
        : null,
    occurredAt: row.occurred_at,
    trust: row.trust as NormalizedEvent["trust"],
    raw: null,
  };
}

/** 保留分を 1 バッチ適用する。呼び出し側がトランザクションを開く。 */
export async function runApplyPending(
  tx: postgres.TransactionSql,
  options: ApplyPendingOptions,
): Promise<ApplyPendingResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? APPLY_PENDING_LIMIT;
  const maxScan = Math.max(limit, options.maxScan ?? APPLY_PENDING_MAX_SCAN);

  let applied = 0;
  let duplicates = 0;
  let stillHeld = 0;
  let other = 0;
  let picked = 0;
  // `id` は identity（1 から）なので 0 から始めれば 1 ページ目も同じ形で書ける。
  let cursor = "0";

  // ★ 見送った行で 1 ページ目が埋まっても、ページを進めて後続へ到達する（F-5）。
  //   進むのは**この実行の中だけ**で、次回の実行は必ず先頭から読み直す（時刻カーソルを
  //   持たない再照合と同じ考え方。飛んでも次回で拾える）。
  while (picked < maxScan && applied + duplicates + other < limit) {
    const pageSize = Math.min(limit, maxScan - picked);
    const rows = await tx<PendingRow[]>`
      SELECT id, provider_key, provider_event_id, event_type, kind, external_ref,
             business_idem_key, amount_minor, currency, occurred_at, trust
      FROM payment_event
      WHERE apply_result IS NULL AND processed_at IS NULL
        AND id > ${cursor}::bigint
      ORDER BY id ASC
      LIMIT ${pageSize}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) break;
    picked += rows.length;
    cursor = rows[rows.length - 1]?.id ?? cursor;

    for (const row of rows) {
      const bindings = await tx<AttemptBindingRow[]>`
        SELECT b.id, b.organizer_user_id, b.provider_key, b.status, b.credential_ref,
               b.credential_fp, b.receiving_identifier, b.receiving_identifier_kind
        FROM payment_attempt a
        JOIN provider_binding b ON b.id = a.provider_binding_id
        WHERE a.provider_key = ${row.provider_key} AND a.external_ref = ${row.external_ref}
      `;
      const bindingRow = bindings[0];
      if (bindingRow !== undefined) {
        const binding: ProviderBinding = {
          id: bindingRow.id,
          organizerUserId: bindingRow.organizer_user_id,
          providerKey: bindingRow.provider_key,
          status: bindingRow.status as ProviderBinding["status"],
          credentialRef: bindingRow.credential_ref,
          credentialFp: bindingRow.credential_fp,
          receivingIdentifier: bindingRow.receiving_identifier,
          receivingIdentifierKind:
            bindingRow.receiving_identifier_kind as ProviderBinding["receivingIdentifierKind"],
        };
        const gate =
          options.applyGate ??
          ((b: ProviderBinding) => defaultApplyGate(tx, options.appEnv, b, now));
        const holdReason = await gate(binding);
        if (holdReason !== null) {
          stillHeld += 1;
          continue;
        }
      }

      const outcome = await applyToLedger(tx, {
        event: toEvent(row),
        paymentEventId: row.id,
        ingestionSource: "webhook",
        requestId: options.requestId,
        recordedBy: `cron:apply-pending:${row.provider_key}`,
        now,
      });
      if (outcome.result === "applied") applied += 1;
      else if (outcome.result === "duplicate") duplicates += 1;
      else other += 1;
    }

    if (rows.length < pageSize) break;
  }

  return { picked, applied, duplicates, stillHeld, other };
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
    const dbHandle = db;
    const result = (await dbHandle.sql.begin((tx) =>
      runApplyPending(tx, { appEnv: routeEnv.APP_ENV, requestId }),
    )) as unknown as ApplyPendingResult;
    logEvent("info", "cron.apply_pending", { requestId, ...result });
    return Response.json({ ...result, requestId }, { status: 200 });
  } catch (error) {
    logEvent("info", "cron.apply_pending.failed", {
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
