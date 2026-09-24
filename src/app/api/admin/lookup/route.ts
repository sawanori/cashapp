/**
 * `GET /api/admin/lookup`（§9 / §8-1 O-13 / task_021 scope）。
 *
 * 読み取り専用の調査経路。`invoiceId` / `externalRef` / `requestId` のいずれか 1 つで照会する
 * （両方指定された場合は `invoiceId` > `externalRef` > `requestId` の優先順）。
 *
 * ★ **`display_label`（参加者の表示名）と `organizer_label`（幹事の表示名）を一切返さない**
 *   （scope: 「lookup に display_label を返さない」／§7-5 の最小 PII 方針を運営者調査にも適用）。
 *   返すのは ID・enum・金額・タイムスタンプだけである。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { type AdminEnv, verifyAdmin } from "@/lib/admin-auth";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, badRequest, newRequestId, toErrorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/logger";

type RouteEnv = AdminEnv & DbEnv;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTERNAL_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID_RE = /^[0-9a-f]{1,64}$/i;

interface InvoiceLookupRow {
  readonly id: string;
  readonly event_id: string;
  readonly participant_id: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly settlement_status: string;
  readonly settlement_rank: number;
  readonly lifecycle_state: string;
  readonly needs_attention: boolean;
  readonly auto_detected: boolean;
  readonly confirmation_method: string;
  readonly paid_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * `Date | string` を ISO 文字列にする。`src/app/api/admin/gates/route.ts` の `toIso` と
 * 同じ理由（drizzle-orm の postgres-js ドライバが `db.sql` の timestamp パーサを透過にする）
 * による防御。詳細はそちらの docstring と `docs/concerns/task_021.md` を参照。
 */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toInvoiceView(row: InvoiceLookupRow) {
  return {
    id: row.id,
    eventId: row.event_id,
    participantId: row.participant_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    settlementStatus: row.settlement_status,
    settlementRank: row.settlement_rank,
    lifecycleState: row.lifecycle_state,
    needsAttention: row.needs_attention,
    autoDetected: row.auto_detected,
    confirmationMethod: row.confirmation_method,
    paidAt: row.paid_at === null ? null : toIso(row.paid_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

interface AttemptRow {
  readonly id: string;
  readonly invoice_id: string;
  readonly provider_key: string;
  readonly external_ref: string;
  readonly status: string;
  readonly amount_minor: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toAttemptView(row: AttemptRow) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    providerKey: row.provider_key,
    externalRef: row.external_ref,
    status: row.status,
    amountMinor: row.amount_minor,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

interface LedgerRow {
  readonly id: string;
  readonly direction: string;
  readonly kind: string;
  readonly amount_minor: number;
  readonly confidence: string;
  readonly created_at: Date;
}

interface AuditRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly actor_type: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly before_rank: number | null;
  readonly after_rank: number | null;
  readonly amount_minor: number | null;
  readonly provider_key: string | null;
  readonly external_ref: string | null;
  readonly detail: Record<string, unknown>;
}

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const admin = await verifyAdmin({ request, env: routeEnv });

    const url = new URL(request.url);
    const invoiceId = url.searchParams.get("invoiceId");
    const externalRef = url.searchParams.get("externalRef");
    const lookupRequestId = url.searchParams.get("requestId");

    db = await createVerifiedDbClient(routeEnv);

    if (invoiceId !== null) {
      if (!UUID_RE.test(invoiceId)) throw badRequest("invoiceId must be a UUID");
      const invoiceRows = await db.sql<InvoiceLookupRow[]>`
        SELECT id, event_id, participant_id, amount_minor, currency, settlement_status,
               settlement_rank, lifecycle_state, needs_attention, auto_detected,
               confirmation_method, paid_at, created_at, updated_at
        FROM invoice WHERE id = ${invoiceId}
      `;
      const invoice = invoiceRows[0];
      if (invoice === undefined) {
        logEvent("info", "admin.lookup", { requestId, adminId: admin.adminId, found: false });
        return Response.json({ invoice: null, attempts: [], ledgerEntries: [], requestId }, { status: 200 });
      }
      const attempts = await db.sql<AttemptRow[]>`
        SELECT id, invoice_id, provider_key, external_ref, status, amount_minor, created_at, updated_at
        FROM payment_attempt WHERE invoice_id = ${invoiceId} ORDER BY created_at ASC
      `;
      const ledgerEntries = await db.sql<LedgerRow[]>`
        SELECT id, direction, kind, amount_minor, confidence, created_at
        FROM ledger_entry WHERE invoice_id = ${invoiceId} ORDER BY created_at ASC
      `;
      logEvent("info", "admin.lookup", { requestId, adminId: admin.adminId, found: true });
      return Response.json(
        {
          invoice: toInvoiceView(invoice),
          attempts: attempts.map(toAttemptView),
          ledgerEntries: ledgerEntries.map((row) => ({
            id: row.id,
            direction: row.direction,
            kind: row.kind,
            amountMinor: row.amount_minor,
            confidence: row.confidence,
            createdAt: toIso(row.created_at),
          })),
          requestId,
        },
        { status: 200 },
      );
    }

    if (externalRef !== null) {
      if (!EXTERNAL_REF_RE.test(externalRef)) throw badRequest("externalRef has an invalid shape");
      const attemptRows = await db.sql<AttemptRow[]>`
        SELECT id, invoice_id, provider_key, external_ref, status, amount_minor, created_at, updated_at
        FROM payment_attempt WHERE external_ref = ${externalRef}
      `;
      const attempt = attemptRows[0];
      if (attempt === undefined) {
        logEvent("info", "admin.lookup", { requestId, adminId: admin.adminId, found: false });
        return Response.json({ invoice: null, attempts: [], ledgerEntries: [], requestId }, { status: 200 });
      }
      const invoiceRows = await db.sql<InvoiceLookupRow[]>`
        SELECT id, event_id, participant_id, amount_minor, currency, settlement_status,
               settlement_rank, lifecycle_state, needs_attention, auto_detected,
               confirmation_method, paid_at, created_at, updated_at
        FROM invoice WHERE id = ${attempt.invoice_id}
      `;
      logEvent("info", "admin.lookup", { requestId, adminId: admin.adminId, found: true });
      return Response.json(
        {
          invoice: invoiceRows[0] === undefined ? null : toInvoiceView(invoiceRows[0]),
          attempts: [toAttemptView(attempt)],
          ledgerEntries: [],
          requestId,
        },
        { status: 200 },
      );
    }

    if (lookupRequestId !== null) {
      if (!REQUEST_ID_RE.test(lookupRequestId)) throw badRequest("requestId has an invalid shape");
      const auditRows = await db.sql<AuditRow[]>`
        SELECT id, occurred_at, actor_type, action, target_type, target_id,
               before_rank, after_rank, amount_minor, provider_key, external_ref, detail
        FROM audit_log WHERE request_id = ${lookupRequestId}
        ORDER BY id ASC
        LIMIT 200
      `;
      logEvent("info", "admin.lookup", { requestId, adminId: admin.adminId, found: auditRows.length > 0 });
      return Response.json(
        {
          auditEntries: auditRows.map((row) => ({
            id: row.id,
            occurredAt: toIso(row.occurred_at),
            actorType: row.actor_type,
            action: row.action,
            targetType: row.target_type,
            targetId: row.target_id,
            beforeRank: row.before_rank,
            afterRank: row.after_rank,
            amountMinor: row.amount_minor,
            providerKey: row.provider_key,
            externalRef: row.external_ref,
            detail: row.detail,
          })),
          requestId,
        },
        { status: 200 },
      );
    }

    throw badRequest("one of invoiceId / externalRef / requestId is required");
  } catch (error) {
    logEvent("info", "admin.lookup.failed", {
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
