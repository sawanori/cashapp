/**
 * `POST /api/webhooks/:providerKey/:bindingRef`（§9 / §3-3 / task_018 scope）。
 *
 * ★ 手順（§9「Webhook 処理手順」）。順序そのものが防御である:
 *     ① 送信元 IP 許可リスト   … 許可外は**本文を読まず** 403。DB に 1 行も残さない（check_095）
 *     ② パス書式の検査          … `providerKey` / `bindingRef` が不正なら 400
 *     ③ binding 解決            … 見つからない・事業者キー不一致は 404
 *     ④ シークレット取得 → `parseWebhook`（複数シークレットで試行。W12）
 *     ⑤ `webhook_delivery` 記録 … 署名不一致でも残す（`sig_ok=false`。check_019）
 *     ⑥ 同一トランザクションで `payment_event` INSERT（W1）＋ `applyToLedger`
 *     ⑦ 2xx を素早く返す。重い処理は outbox（W5）
 *
 * ★ **`APP_ENV !== 'production'` は 404**（check_095）。Phase 1 の出荷アダプタは
 *   `manual_confirm` だけで外部 Webhook を持たないため、本番以外でこの口を開けておく
 *   理由が無い。開いていること自体が攻撃面になる。
 *
 * ★ 本文は `request.text()` の**生文字列**のまま `parseWebhook` へ渡す。このルートで
 *   本文を構造化しない（制約 P2。署名は生バイト列に対して計算されている）。
 *
 * ★ ゲート未通過（`PAYMENTS_ENABLED` / `compliance_gate` / `PROVIDER_<KEY>_MODE`）でも
 *   **受信して保存する**。止めるのは台帳への適用だけである（§7-6 / check_022 / check_095）。
 *   保留は `payment_event.apply_result IS NULL AND processed_at IS NULL` で表す
 *   （CHECK 制約に `held` が無いため。`/api/cron/apply-pending` がこの条件で拾う）。
 *
 * ★ CSRF 保護から除外される（W6）。セッションを持たない外部からの POST であり、
 *   `src/middleware.ts` の CSRF 判定はこのパスを対象にしない。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type postgres from "postgres";

import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import {
  insertPaymentEvent,
  recordWebhookDelivery,
  redactRawPayload,
} from "@/lib/db/repositories/events-log";
import { isFeatureFlagEnabled, providerModeFlagKey, FLAG_PAYMENTS_ENABLED } from "@/lib/db/repositories/gates";
import { AppError, ERROR_CODES, newRequestId, toErrorResponse, type ErrorCode } from "@/lib/errors";
import { applyToLedger } from "@/lib/ledger/apply";
import {
  bodySha256,
  businessIdemKey,
  isValidBindingRef,
  isValidExternalRef,
  isValidProviderKeyPath,
  providerEventIdOf,
} from "@/lib/ledger/dedupe";
import { logEvent } from "@/lib/logger";
import { AUTOMATIC_PROVIDER_GATE_PHASES, findBlockingGate, requiredGateKeysForPhases } from "@/lib/payments/gates";
import { dbGateEnvironment, resolveProviderWithoutGate } from "@/lib/payments/registry";
import {
  MANUAL_CONFIRM_PROVIDER_KEY,
  SignatureError,
  type NormalizedEvent,
  type PaymentProvider,
  type ProviderBinding,
} from "@/lib/payments/types";
import {
  hashSourceIp,
  isIpAllowed,
  parseIpAllowlist,
  sourceIpOf,
  type IpRule,
} from "@/lib/webhook/ip-allowlist";

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;
const CODE_FORBIDDEN = "FORBIDDEN" as ErrorCode;
const CODE_SIGNATURE_INVALID = "SIGNATURE_INVALID" as ErrorCode;

/** 自動アダプタを有効にしてよい唯一の `APP_ENV`（`registry.ts` と同じ値）。 */
const PRODUCTION_APP_ENV = "production";

/** `webhook_delivery.headers` に残してよいヘッダ名（秘密値・個人情報を残さない）。 */
const LOGGED_HEADER_NAMES: readonly string[] = ["content-type", "user-agent"];

/** 1 イベント分の適用結果。トランザクションの戻り値を具体型に固定するために名前を付ける。 */
export type WebhookApplyTag = "applied" | "duplicate" | "held";

/**
 * トランザクションの実行口。戻り値を `WebhookApplyTag` に固定してあるのは、
 * postgres.js の `begin<T>` が `UnwrapPromiseArray<T>` を返し、総称のままでは
 * `T` と同一だと型が示せないためである（配列でない具体型なら簡約される）。
 */
export type TransactionRunner = (
  fn: (tx: postgres.TransactionSql) => Promise<WebhookApplyTag>,
) => Promise<WebhookApplyTag>;

export interface WebhookRouteEnv extends RawEnv, DbEnv {
  /** 送信元 IP 許可リスト（カンマ区切り。IPv4 CIDR / 完全一致）。未設定は全拒否。 */
  readonly WEBHOOK_IP_ALLOWLIST?: string | undefined;
  /** 署名シークレット（カンマ区切り。ローテーション中は 2 本並べる。W12）。 */
  readonly WEBHOOK_SIGNING_SECRETS?: string | undefined;
}

/**
 * ルート本体が必要とするものすべて。HTTP 層から切り出してあるのは、統合テストと契約テストが
 * Cloudflare のランタイム文脈なしに実 DB へ通せるようにするためである
 * （`src/app/api/invoices/[id]/manual-attest/route.ts` と同じ方針）。
 */
export interface WebhookContext {
  /** 単発のクエリ（binding 参照・受信ログ・ゲート読み取り）に使う口。 */
  readonly sql: postgres.ISql;
  /**
   * 1 イベント分の「`payment_event` INSERT ＋ `applyToLedger`」を包むトランザクション。
   * 本番は `sql.begin`。テストは外側のロールバック用トランザクションの `savepoint` を渡し、
   * 台帳と監査（どちらも追記専用で DELETE できない）を実 DB に残さずに検査する。
   */
  readonly runTransaction: TransactionRunner;
  readonly appEnv: string | undefined;
  readonly ipAllowlist: readonly IpRule[];
  /** `source_ip_hash` の HMAC 鍵（現行 PEPPER）。 */
  readonly ipHashKey: string;
  readonly secrets: readonly string[];
  /** 既定は `resolveProviderWithoutGate`（ゲートを見ない解決。受信は止めない）。 */
  readonly resolveAdapter?: (providerKey: string) => PaymentProvider;
  /** 台帳適用のゲート。ブロックされている理由（文字列）か、通っていれば `null`。 */
  readonly applyGate?: (binding: ProviderBinding) => Promise<string | null>;
  readonly now?: Date;
}

interface BindingDbRow {
  readonly id: string;
  readonly organizer_user_id: string;
  readonly provider_key: string;
  readonly status: string;
  readonly credential_ref: string | null;
  readonly credential_fp: string | null;
  readonly receiving_identifier: string | null;
  readonly receiving_identifier_kind: string | null;
}

function toBinding(row: BindingDbRow): ProviderBinding {
  return {
    id: row.id,
    organizerUserId: row.organizer_user_id,
    providerKey: row.provider_key,
    status: row.status as ProviderBinding["status"],
    credentialRef: row.credential_ref,
    credentialFp: row.credential_fp,
    receivingIdentifier: row.receiving_identifier,
    receivingIdentifierKind: row.receiving_identifier_kind as ProviderBinding["receivingIdentifierKind"],
  };
}

export interface WebhookOutcome {
  readonly received: number;
  readonly applied: number;
  readonly duplicates: number;
  readonly held: number;
  readonly holdReason: string | null;
}

/**
 * 既定の適用ゲート。`manual_confirm` は資金移動を起こさないので素通し（`registry.ts` の
 * ガード 0 と同じ扱い）。それ以外は `PAYMENTS_ENABLED` → `compliance_gate` →
 * `PROVIDER_<KEY>_MODE` の順に見て、最初にブロックしたものの名前を返す。
 */
export async function defaultApplyGate(
  sql: postgres.ISql,
  appEnv: string | undefined,
  binding: ProviderBinding,
  now: Date,
): Promise<string | null> {
  if (binding.providerKey === MANUAL_CONFIRM_PROVIDER_KEY) return null;
  const env = dbGateEnvironment(sql, appEnv);
  if (!(await isFeatureFlagEnabled(sql, FLAG_PAYMENTS_ENABLED))) return FLAG_PAYMENTS_ENABLED;
  const requiredKeys = requiredGateKeysForPhases(AUTOMATIC_PROVIDER_GATE_PHASES);
  const blocking = findBlockingGate(requiredKeys, await env.complianceGates(requiredKeys), now);
  if (blocking !== null) return blocking.gateKey;
  const modeKey = providerModeFlagKey(binding.providerKey);
  if ((await env.providerMode(binding.providerKey)) !== "on") return modeKey;
  return null;
}

/**
 * ルート本体。`Response` を返すまでに必ず `webhook_delivery` を 1 行残す
 * （許可外 IP・非 production の 404 を除く。どちらも DB に触れない）。
 */
export async function handleWebhookRequest(
  ctx: WebhookContext,
  request: Request,
  params: { readonly providerKey: string; readonly bindingRef: string },
  requestId: string,
): Promise<Response> {
  const now = ctx.now ?? new Date();

  // ── 非 production は存在しないことにする（check_095）。DB にも触れない。
  if (ctx.appEnv !== PRODUCTION_APP_ENV) {
    return toErrorResponse(new AppError(CODE_NOT_FOUND, 404, "not found"), requestId);
  }

  // ── ① 送信元 IP。許可外は本文を読まず 403（DB に 1 行も残さない）。
  const sourceIp = sourceIpOf(request.headers);
  if (!isIpAllowed(sourceIp, ctx.ipAllowlist)) {
    logEvent("info", "webhook.rejected", { requestId, reason: "ip_not_allowed" });
    return toErrorResponse(new AppError(CODE_FORBIDDEN, 403, "forbidden"), requestId);
  }
  const sourceIpHash = sourceIp === null ? null : await hashSourceIp(sourceIp, ctx.ipHashKey);

  // ── ② パス書式。
  if (!isValidProviderKeyPath(params.providerKey) || !isValidBindingRef(params.bindingRef)) {
    return toErrorResponse(
      new AppError(ERROR_CODES.BAD_REQUEST, 400, "リクエストの形式が正しくありません。"),
      requestId,
    );
  }

  const raw = await request.text();
  const digest = await bodySha256(raw);
  const headers = pickLoggedHeaders(request.headers);

  const deliver = async (sigOk: boolean, httpStatus: number): Promise<void> => {
    await recordWebhookDelivery(ctx.sql, {
      providerKey: params.providerKey,
      sigOk,
      ipAllowed: true,
      httpStatus,
      bodySha256: digest,
      rawBody: raw,
      headers,
      sourceIpHash,
    });
  };

  // ── ③ binding 解決。
  const bindingRows = await ctx.sql<BindingDbRow[]>`
    SELECT id, organizer_user_id, provider_key, status, credential_ref, credential_fp,
           receiving_identifier, receiving_identifier_kind
    FROM provider_binding WHERE id = ${params.bindingRef}
  `;
  const bindingRow = bindingRows[0];
  if (bindingRow === undefined || bindingRow.provider_key !== params.providerKey) {
    await deliver(false, 404);
    return toErrorResponse(new AppError(CODE_NOT_FOUND, 404, "not found"), requestId);
  }
  const binding = toBinding(bindingRow);

  // ── ④ 署名検証（複数シークレット。W12）。生本文をそのまま渡す（P2）。
  const resolveAdapter = ctx.resolveAdapter ?? resolveProviderWithoutGate;
  let events: readonly NormalizedEvent[];
  try {
    const adapter = resolveAdapter(params.providerKey);
    events = await adapter.parseWebhook(binding, raw, request.headers, ctx.secrets);
  } catch (error) {
    if (error instanceof SignatureError) {
      await deliver(false, 400);
      logEvent("info", "webhook.rejected", { requestId, reason: "signature_invalid" });
      return toErrorResponse(
        new AppError(CODE_SIGNATURE_INVALID, 400, "signature verification failed"),
        requestId,
      );
    }
    throw error;
  }

  // ── `external_ref` の書式（DB の CHECK と同じ）。不正は 400。
  for (const ev of events) {
    if (!isValidExternalRef(ev.externalRef)) {
      await deliver(true, 400);
      return toErrorResponse(
        new AppError(ERROR_CODES.BAD_REQUEST, 400, "リクエストの形式が正しくありません。"),
        requestId,
      );
    }
  }

  // ── 台帳適用のゲート。未通過でも受信・保存はする（適用だけ保留）。
  const gate = ctx.applyGate ?? ((b: ProviderBinding) => defaultApplyGate(ctx.sql, ctx.appEnv, b, now));
  const holdReason = await gate(binding);

  let applied = 0;
  let duplicates = 0;
  let held = 0;

  for (const ev of events) {
    const providerEventId = await providerEventIdOf(ev, raw);
    const outcome = await ctx.runTransaction(async (tx) => {
      const paymentEventId = await insertPaymentEvent(tx, {
        providerKey: ev.providerKey,
        providerEventId,
        eventType: ev.eventType,
        kind: ev.kind,
        externalRef: ev.externalRef,
        businessIdemKey: businessIdemKey({
          externalRef: ev.externalRef,
          kind: ev.kind,
          declared: ev.businessIdemKey,
        }),
        invoiceId: null,
        attemptId: null,
        amountMinor: ev.money?.amountMinor ?? null,
        currency: ev.money?.currency ?? null,
        occurredAt: ev.occurredAt,
        ingestionSource: "webhook",
        trust: ev.trust,
        rawRedacted: redactRawPayload({
          eventType: ev.eventType,
          kind: ev.kind,
          externalRef: ev.externalRef,
          providerEventId,
          amountMinor: ev.money?.amountMinor ?? null,
          currency: ev.money?.currency ?? null,
          occurredAt: ev.occurredAt,
        }),
      });
      // W1: 0 行 = 既処理。台帳にも請求にも触らない（check_017）。
      if (paymentEventId === null) return "duplicate" as const;
      // ゲート未通過: 保存だけして apply_result / processed_at を NULL のまま残す。
      if (holdReason !== null) return "held" as const;
      const result = await applyToLedger(tx, {
        event: { ...ev, providerEventId },
        paymentEventId,
        ingestionSource: "webhook",
        requestId,
        recordedBy: `webhook:${ev.providerKey}`,
        now,
      });
      return result.result === "duplicate" ? ("duplicate" as const) : ("applied" as const);
    });
    if (outcome === "duplicate") duplicates += 1;
    else if (outcome === "held") held += 1;
    else applied += 1;
  }

  await deliver(true, 200);
  logEvent("info", "webhook.received", {
    requestId,
    providerKey: params.providerKey,
    received: events.length,
    applied,
    duplicates,
    held,
  });

  const body: WebhookOutcome = {
    received: events.length,
    applied,
    duplicates,
    held,
    holdReason,
  };
  return Response.json({ ...body, requestId }, { status: 200 });
}

function pickLoggedHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of LOGGED_HEADER_NAMES) {
    const value = headers.get(name);
    if (value !== null) out[name] = value.slice(0, 200);
  }
  return out;
}

interface RouteParams {
  readonly params: Promise<{ readonly providerKey: string; readonly bindingRef: string }>;
}

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as WebhookRouteEnv;
  const { providerKey, bindingRef } = await params;

  // 非 production はここで打ち切る。設定の読み込みも DB 接続もしない。
  if (routeEnv.APP_ENV !== PRODUCTION_APP_ENV) {
    return toErrorResponse(new AppError(CODE_NOT_FOUND, 404, "not found"), requestId);
  }

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);
    const pepper = config.peppers[0];
    if (pepper === undefined) {
      throw new AppError(ERROR_CODES.CONFIG_INVALID, 500, "設定が不正です。");
    }
    db = await createVerifiedDbClient(routeEnv);
    const dbHandle = db;
    return await handleWebhookRequest(
      {
        sql: dbHandle.sql,
        runTransaction: (fn) => dbHandle.sql.begin(fn),
        appEnv: config.appEnv,
        ipAllowlist: parseIpAllowlist(routeEnv.WEBHOOK_IP_ALLOWLIST),
        ipHashKey: pepper.value,
        secrets: splitSecrets(routeEnv.WEBHOOK_SIGNING_SECRETS),
      },
      request,
      { providerKey, bindingRef },
      requestId,
    );
  } catch (error) {
    logEvent("info", "webhook.failed", {
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

function splitSecrets(spec: string | undefined): readonly string[] {
  if (typeof spec !== "string") return [];
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
