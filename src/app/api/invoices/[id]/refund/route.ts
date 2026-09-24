/**
 * `POST /api/invoices/:id/refund`（§9 / §8-1 O-10 / task_021 scope）。
 *
 * `capabilities.refund` と `refundWindowDays` に従う。ゲート off でも動く（§9 の表: 返金は
 * 資金移動を止める側の操作ではないため `resolveProviderWithoutGate` を使う）。
 *
 * ★ Phase 1 の出荷アダプタは `manual_confirm` のみで、その `capabilities.refund` は
 *   `'none'` に固定されている（`src/lib/payments/providers/manual-confirm.ts`）。したがって
 *   本ルートは Phase 1 では常に 409 `NOT_SUPPORTED` を返す。自動アダプタの返金経路
 *   （`provider.refund()` の呼び出し以降）は型を満たす形で書くが、Phase 1 には到達させる
 *   自動アダプタが存在しないため統合テストでは踏めない（O-10「`refund='none'` →
 *   『この決済手段はアプリからの返金に対応していません』」の経路だけを検証する）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type postgres from "postgres";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { getProviderBindingForEvent } from "@/lib/db/repositories/bindings";
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
import { resolveProviderWithoutGate } from "@/lib/payments/registry";
import { NotSupportedError } from "@/lib/payments/types";

type RouteEnv = RawEnv & DbEnv;
interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;
const CODE_REFUND_NOT_ALLOWED = "REFUND_NOT_ALLOWED" as ErrorCode;
const CODE_NOT_SUPPORTED = "NOT_SUPPORTED" as ErrorCode;

const PAID_RANK = 40;

function refundNotAllowed(detail?: string): AppError {
  return new AppError(
    CODE_REFUND_NOT_ALLOWED,
    409,
    "この会費はまだ返金の対象になりません。",
    detail === undefined ? {} : { detail },
  );
}

function notSupported(detail?: string): AppError {
  return new AppError(
    CODE_NOT_SUPPORTED,
    409,
    "この決済手段はアプリからの返金に対応していません。",
    detail === undefined ? {} : { detail },
  );
}

interface OwnedInvoiceRow {
  readonly id: string;
  readonly event_id: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly settlement_status: string;
  readonly settlement_rank: number;
  readonly lifecycle_state: string;
  readonly organizer_user_id: string;
  readonly provider_key: string;
}

async function loadOwnedInvoice(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  invoiceId: string,
): Promise<OwnedInvoiceRow> {
  const rows = await tx<OwnedInvoiceRow[]>`
    SELECT i.id, i.event_id, i.amount_minor, i.currency, i.settlement_status,
           i.settlement_rank, i.lifecycle_state, e.organizer_user_id, e.provider_key
    FROM invoice i
    JOIN event e ON e.id = i.event_id
    WHERE i.id = ${invoiceId} AND e.organizer_user_id = ${organizerUserId}
    FOR UPDATE OF i
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new AppError(CODE_NOT_FOUND, 404, "対象の会費が見つかりません。");
  }
  return row;
}

function parseBody(body: unknown): { readonly confirmed: true } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  if ((body as Record<string, unknown>)["confirmed"] !== true) {
    throw badRequest("confirmed must be true (O-10 confirmation)");
  }
  return { confirmed: true };
}

export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;
  const { id } = await params;

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
    parseBody(bodyJson);
    const requestHash = await computeRequestHash(bodyJson);
    const userRef = idempotencyUserRef(session.userId);
    const dbHandle = db;

    const outcome = await dbHandle.sql.begin(async (tx) =>
      runIdempotent(
        {
          sql: tx,
          userRef,
          endpoint: `POST /api/invoices/${id}/refund`,
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          const invoice = await loadOwnedInvoice(tx, session.userId, id);
          if (invoice.lifecycle_state !== "active") {
            throw refundNotAllowed("invoice is voided");
          }
          if (invoice.settlement_rank < PAID_RANK) {
            throw refundNotAllowed("invoice has not been paid yet");
          }

          const provider = resolveProviderWithoutGate(invoice.provider_key);
          const capabilities = provider.capabilities;
          if (capabilities.refund === "none") {
            throw notSupported(`provider ${invoice.provider_key} does not support refund`);
          }

          const binding = await getProviderBindingForEvent(tx, invoice.event_id);
          if (binding === null) {
            throw refundNotAllowed("no provider binding for this event");
          }

          const attemptRows = await tx<{ external_ref: string }[]>`
            SELECT external_ref FROM payment_attempt
            WHERE invoice_id = ${invoice.id} AND status = 'succeeded'
            ORDER BY updated_at DESC LIMIT 1
          `;
          const externalRef = attemptRows[0]?.external_ref;
          if (externalRef === undefined) {
            throw refundNotAllowed("no settled payment attempt found for this invoice");
          }

          let normalized;
          try {
            normalized = await provider.refund(binding, externalRef);
          } catch (error) {
            if (error instanceof NotSupportedError) throw notSupported(error.message);
            throw error;
          }

          await tx`
            INSERT INTO ledger_entry (invoice_id, event_id, direction, kind, amount_minor,
                                      currency, confidence, dedupe_key, recorded_by)
            VALUES (${invoice.id}, ${invoice.event_id}, 'debit', 'refund', ${invoice.amount_minor},
                    ${invoice.currency}, 'provider_verified', ${normalized.ledgerDedupeKey},
                    ${`organizer:${session.userId}`})
            ON CONFLICT (invoice_id, dedupe_key) DO NOTHING
          `;

          const REFUND_PENDING_RANK = 60;
          await tx`
            UPDATE invoice SET settlement_status = 'refund_pending'
            WHERE id = ${invoice.id} AND settlement_rank < ${REFUND_PENDING_RANK}
          `;

          await appendAuditLog(tx, {
            actorType: "organizer",
            action: "invoice.refund",
            targetType: "invoice",
            targetId: invoice.id,
            beforeRank: invoice.settlement_rank,
            afterRank: REFUND_PENDING_RANK,
            amountMinor: invoice.amount_minor,
            providerKey: invoice.provider_key,
            externalRef,
            requestId,
          });

          return { statusCode: 200, cacheableBody: { invoiceId: invoice.id, refunded: true } };
        },
      ),
    );

    logEvent("info", "invoice.refund", { requestId, userId: session.userId });
    return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
  } catch (error) {
    logEvent("info", "invoice.refund.failed", {
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
