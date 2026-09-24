/**
 * `POST /api/e/checkout`（§9 / task_017 scope）。
 *
 * ★ **金額を取らない**。請求済みの `invoice.amount_minor` をサーバーが読む。クライアントが
 *   金額を名乗れる設計は、突合基準（`payment_attempt.amount_minor`）そのものを壊す。
 *
 * ★ **write-ahead**。`payment_attempt` を先に書いてから事業者を呼ぶ。`externalRef` が先に
 *   決まるので、事業者へ渡す参照キーと DB の行が食い違わない。
 *
 *   ただし **書き込みと呼び出しは同じトランザクションの中にある**（冪等予約・業務書き込み・
 *   `done` 更新を 1 トランザクションにまとめる P-01 の是正がそれを要求する）。したがって
 *   「事業者を呼んだ後にコミット前で落ちたら試行記録だけは残る」という保証は**無い** —
 *   その場合は予約ごとロールバックされ、再送が最初からやり直す（G5 round1 GPT F-1）。
 *   Phase 1 の `manual_confirm` は外部呼び出しを一切しないので実害は無いが、
 *   **自動アダプタを足すときは「試行を別トランザクションで先にコミットしてから呼ぶ」形へ
 *   作り替える必要がある**（`docs/concerns/task_017.md` C-017-11。task_018 / task_026）。
 *
 * ★ **生きた試行の再利用**。同一請求に生きた試行があれば同じ案内（`checkoutUrl`）を返す。
 *   DB 側に `UNIQUE (invoice_id) WHERE is_open` があり、さらに請求行を `FOR UPDATE` で
 *   掴んでから判定するので、同時 2 本でも試行は 1 つだけになる（check_093）。
 *
 * ★ **ゲートの拒否はサーバーが正**。UI のボタン非表示は補助であり、ここで
 *   409 `GATE_NOT_PASSED` / `PROVIDER_NOT_ENABLED` を返す（check_010 / check_022）。
 *   ゲートで止まったときは `payment_attempt` を 1 行も作らない（解決をすべての書き込みより前に置く）。
 *
 * ★ 使える決済手段が無ければ 409 `NO_PAYMENT_METHOD`（§9）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type postgres from "postgres";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import {
  ensureManualConfirmBinding,
  getProviderBindingForEvent,
  noPaymentMethod,
} from "@/lib/db/repositories/bindings";
import {
  AppError,
  ERROR_CODES,
  badRequest,
  csrfInvalid,
  newRequestId,
  toErrorResponse,
  type ErrorCode,
} from "@/lib/errors";
import {
  computeRequestHash,
  idempotencyUserRef,
  requireIdempotencyKey,
  runIdempotent,
} from "@/lib/idempotency";
import { logEvent } from "@/lib/logger";
import { yen } from "@/lib/payments/money";
import { dbGateEnvironment, resolveProvider } from "@/lib/payments/registry";
import {
  MANUAL_CONFIRM_PROVIDER_KEY,
  ProviderNotEnabledError,
  type CheckoutTicket,
  type ProviderBinding,
} from "@/lib/payments/types";

type RouteEnv = RawEnv & DbEnv;

const CODE_NOT_CLAIMED = "NOT_CLAIMED" as ErrorCode;
const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;
const CODE_INVOICE_STATE = "INVOICE_STATE_CONFLICT" as ErrorCode;
const CODE_GATE_NOT_PASSED = "GATE_NOT_PASSED" as ErrorCode;
const CODE_PROVIDER_NOT_ENABLED = "PROVIDER_NOT_ENABLED" as ErrorCode;

/** 手動確認の試行の有効期間。事業者からの確定が来ない経路なので、放置されないよう期限を持たせる。 */
const MANUAL_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;
/** 事業者 API の打ち切り時間（IF v2 の `CreateCheckoutCommand.timeoutMs`）。 */
const PROVIDER_CALL_TIMEOUT_MS = 3000;
/** `settlement_rank >= 40`（= `paid` 以上）には新しい試行を作らない。 */
const SETTLEMENT_PAID_RANK = 40;

export interface CheckoutBodyInput {
  readonly invoiceId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 純粋関数。**金額を受け取らない**ことをここで固定する。 */
export function parseCheckoutBody(body: unknown): CheckoutBodyInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const r = body as Record<string, unknown>;
  const invoiceId = r["invoiceId"];
  if (typeof invoiceId !== "string" || !UUID_RE.test(invoiceId)) {
    throw badRequest("invoiceId is required");
  }
  for (const forbidden of ["amount", "amountMinor", "money", "currency"]) {
    if (r[forbidden] !== undefined) {
      throw badRequest(`${forbidden} must not be supplied by the client`);
    }
  }
  return { invoiceId };
}

interface ClaimedInvoiceRow {
  readonly invoice_id: string;
  readonly event_id: string;
  readonly participant_id: string;
  readonly amount_minor: number;
  readonly settlement_rank: number;
  readonly lifecycle_state: string;
  readonly organizer_user_id: string;
  readonly provider_key: string;
  readonly minors_included: boolean;
  readonly event_status: string;
}

/**
 * 「この請求が、いまのセッションの利用者が claim 済みの請求であること」を SQL の WHERE で確かめる。
 * `participant_claim` は `line_user_ref`（ペッパー付き HMAC）で参加者を指すため、
 * `app_user` を経由して突き合わせる。解放済み（`released_at IS NOT NULL`）の claim は数えない。
 */
async function loadClaimedInvoice(
  sql: postgres.TransactionSql,
  appUserId: string,
  invoiceId: string,
): Promise<ClaimedInvoiceRow> {
  const rows = await sql<ClaimedInvoiceRow[]>`
    SELECT i.id AS invoice_id, i.event_id, i.participant_id, i.amount_minor,
           i.settlement_rank, i.lifecycle_state,
           e.organizer_user_id, e.provider_key, e.minors_included, e.status AS event_status
    FROM invoice i
    JOIN event e ON e.id = i.event_id
    JOIN participant_claim pc
      ON pc.participant_id = i.participant_id AND pc.released_at IS NULL
    JOIN app_user u
      ON u.line_user_ref = pc.line_user_ref AND u.pepper_version = pc.pepper_version
    WHERE i.id = ${invoiceId} AND u.id = ${appUserId}
    FOR UPDATE OF i
  `;
  const row = rows[0];
  if (row === undefined) {
    // claim していない請求と存在しない請求を区別しない（他人の請求の存在を漏らさない）。
    throw new AppError(CODE_NOT_CLAIMED, 403, "この会費のお支払いはご利用いただけません。");
  }
  return row;
}

interface OpenAttemptRow {
  readonly id: string;
  readonly external_ref: string;
  readonly checkout_url: string | null;
  readonly expires_at: Date | null;
}

/** `'iv_' + invoiceId(hex) + '_' + seq`。64 文字・`[A-Za-z0-9_-]` に収まる（§7-6）。 */
export function buildExternalRef(invoiceId: string, attemptSeq: number): string {
  return `iv_${invoiceId.replace(/-/g, "")}_${String(attemptSeq)}`;
}

/** `ProviderNotEnabledError` の理由を API のエラーコードへ落とす。 */
function toGateError(error: ProviderNotEnabledError): AppError {
  const isComplianceGate = error.gateKey.startsWith("GATE-") || error.gateKey === "G0-USER";
  return new AppError(
    isComplianceGate ? CODE_GATE_NOT_PASSED : CODE_PROVIDER_NOT_ENABLED,
    409,
    "いまこの方法ではお支払いいただけません。幹事にご連絡ください。",
    { detail: `blocked by ${error.gateKey}` },
  );
}

/** LINE ミニアプリのパーマネントリンクへ戻す（制約 P4 / N4）。 */
export function buildReturnUrl(liffId: string, invoiceId: string): string {
  const base = `https://liff.line.me/${encodeURIComponent(liffId)}`;
  return `${base}/e/return?invoice=${encodeURIComponent(invoiceId)}`;
}

export interface CreateCheckoutParams {
  /** セッションの `app_user.id`。claim の確認に使う。 */
  readonly appUserId: string;
  readonly invoiceId: string;
  /** `APP_ENV`。自動アダプタの環境ガードに使う。 */
  readonly appEnv: string | undefined;
  readonly liffId: string;
  readonly requestId: string;
}

export interface CreateCheckoutOutcome {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

/**
 * checkout の本体（1 トランザクション内）。HTTP 層から切り出してあるのは、統合テストが
 * Cloudflare のランタイム文脈なしに実 DB へ通せるようにするためである
 * （`tests/integration/checkout.test.ts`）。呼び出し側は `runIdempotent` の内側で呼ぶ。
 */
export async function createCheckoutForClaim(
  tx: postgres.TransactionSql,
  params: CreateCheckoutParams,
): Promise<CreateCheckoutOutcome> {
  const invoice = await loadClaimedInvoice(tx, params.appUserId, params.invoiceId);
  if (invoice.lifecycle_state !== "active") {
    throw new AppError(CODE_INVOICE_STATE, 409, "この会費は取り消されています。");
  }
  if (invoice.settlement_rank >= SETTLEMENT_PAID_RANK) {
    throw new AppError(CODE_INVOICE_STATE, 409, "この会費はお支払い済みです。");
  }
  if (invoice.event_status === "canceled") {
    throw new AppError(CODE_INVOICE_STATE, 409, "このイベントは中止されています。");
  }

  const providerKey = invoice.provider_key;

  // ---- binding の解決（手動確認は幹事ごとに 1 つを get-or-create する） ----
  let binding: ProviderBinding | null;
  if (providerKey === MANUAL_CONFIRM_PROVIDER_KEY) {
    binding = await ensureManualConfirmBinding(tx, invoice.organizer_user_id);
  } else {
    binding = await getProviderBindingForEvent(tx, invoice.event_id);
  }

  // ---- ゲート（この解決より前に payment_attempt を書かない。check_010） ----
  let provider;
  try {
    provider = await resolveProvider(providerKey, {
      env: dbGateEnvironment(tx, params.appEnv),
      organizerUserId: invoice.organizer_user_id,
      binding,
      minorsIncluded: invoice.minors_included,
    });
  } catch (error) {
    if (error instanceof ProviderNotEnabledError) throw toGateError(error);
    throw error;
  }
  if (binding === null) {
    throw noPaymentMethod(`no binding for provider ${providerKey}`);
  }

  const returnUrl = buildReturnUrl(params.liffId, invoice.invoice_id);

  // ---- 生きた試行があれば同じ案内を返す（新しい試行を作らない） ----
  const openRows = await tx<OpenAttemptRow[]>`
    SELECT id, external_ref, checkout_url, expires_at
    FROM payment_attempt
    WHERE invoice_id = ${invoice.invoice_id} AND is_open
  `;
  const open = openRows[0];
  if (open !== undefined) {
    const ticket = await provider.createCheckout(binding, {
      invoiceId: invoice.invoice_id,
      externalRef: open.external_ref,
      money: yen(invoice.amount_minor),
      description: "会費",
      returnUrl,
      expiresAt: open.expires_at,
      timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
    });
    return {
      statusCode: 200,
      body: {
        ...buildResponseBody(
          open.id,
          open.external_ref,
          open.checkout_url,
          ticket,
          provider.capabilities.autoDetect,
        ),
        reused: true,
      },
    };
  }

  // ---- write-ahead: 先に試行を書いてから事業者を呼ぶ ----
  const seqRows = await tx<{ n: string }[]>`
    SELECT count(*)::text AS n FROM payment_attempt WHERE invoice_id = ${invoice.invoice_id}
  `;
  const attemptSeq = Number(seqRows[0]?.n ?? "0") + 1;
  const externalRef = buildExternalRef(invoice.invoice_id, attemptSeq);
  const expiresAt = new Date(Date.now() + MANUAL_ATTEMPT_TTL_MS);

  const insertedRows = await tx<{ id: string }[]>`
    INSERT INTO payment_attempt (invoice_id, provider_key, provider_binding_id, external_ref,
                                 amount_minor, expires_at)
    VALUES (${invoice.invoice_id}, ${providerKey}, ${binding.id}, ${externalRef},
            ${invoice.amount_minor}, ${expiresAt})
    RETURNING id
  `;
  const attemptId = insertedRows[0]?.id;
  if (attemptId === undefined) throw new Error("payment_attempt insert returned no row");

  const ticket = await provider.createCheckout(binding, {
    invoiceId: invoice.invoice_id,
    externalRef,
    money: yen(invoice.amount_minor),
    description: "会費",
    returnUrl,
    expiresAt,
    timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
  });

  const checkoutUrl = ticket.kind === "redirect" ? ticket.checkoutUrl : null;
  if (checkoutUrl !== null) {
    await tx`
      UPDATE payment_attempt SET checkout_url = ${checkoutUrl}, status = 'redirected'
      WHERE id = ${attemptId}
    `;
  }

  await appendAuditLog(tx, {
    actorType: "participant",
    action: "checkout.create",
    targetType: "payment_attempt",
    targetId: attemptId,
    amountMinor: invoice.amount_minor,
    providerKey,
    externalRef,
    requestId: params.requestId,
    detail: { kind: ticket.kind, autoDetect: provider.capabilities.autoDetect },
  });

  return {
    statusCode: 201,
    body: {
      ...buildResponseBody(
        attemptId,
        externalRef,
        checkoutUrl,
        ticket,
        provider.capabilities.autoDetect,
      ),
      reused: false,
    },
  };
}

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
    const input = parseCheckoutBody(bodyJson);
    const requestHash = await computeRequestHash(bodyJson);
    const userRef = idempotencyUserRef(session.userId);
    const dbHandle = db;
    const appEnv = routeEnv.APP_ENV;

    const outcome = await dbHandle.sql.begin(async (tx) =>
      runIdempotent(
        {
          sql: tx,
          userRef,
          endpoint: "POST /api/e/checkout",
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          const result = await createCheckoutForClaim(tx, {
            appUserId: session.userId,
            invoiceId: input.invoiceId,
            appEnv,
            liffId: config.line.liffId,
            requestId,
          });
          return { statusCode: result.statusCode, cacheableBody: { ...result.body } };
        },
      ),
    );

    logEvent("info", "checkout.create", {
      requestId,
      userId: session.userId,
      outcome: outcome.replayed ? "replayed" : "created",
    });

    return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
  } catch (error) {
    logEvent("info", "checkout.create.failed", {
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

/**
 * 応答ボディ。**非自動ラベルの 8 層①**（API 型必須）に従い、`autoDetected` と
 * `confirmationMethod` を必ず載せる。手動確認では案内（`instruction`）と
 * 遷移先ホスト名（`deepLinkHost`）も併せて返す（P-4 / P-5）。
 */
function buildResponseBody(
  attemptId: string,
  externalRef: string,
  checkoutUrl: string | null,
  ticket: CheckoutTicket,
  autoDetect: boolean,
): Record<string, unknown> {
  return {
    attempt: { id: attemptId, externalRef, checkoutUrl },
    ticket:
      ticket.kind === "manual"
        ? {
            kind: "manual",
            instruction: {
              automatic: false,
              channel: ticket.instruction.channel,
              deepLink: ticket.instruction.deepLink,
              deepLinkHost: ticket.instruction.deepLinkHost,
              note: ticket.instruction.note,
              disclaimer: ticket.instruction.disclaimer,
            },
          }
        : { kind: "redirect", checkoutUrl: ticket.checkoutUrl },
    autoDetected: autoDetect,
    confirmationMethod: autoDetect ? "automatic" : "manual_by_organizer",
  };
}
