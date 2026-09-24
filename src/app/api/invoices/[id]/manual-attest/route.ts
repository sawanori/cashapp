/**
 * `POST /api/invoices/:id/manual-attest`（§9 / task_017 scope）。
 *
 * ★ 幹事が「受け取った」と申告する唯一の経路である。自動照合ではありません —
 *   したがって記録は必ず `confidence='organizer_attested'` /
 *   `confirmation_method='manual_by_organizer'` / `auto_detected=false` になる
 *   （「非自動ラベルの 8 層」①。check_027）。
 *
 * ★ `reason` は必須（空白のみは 400）。`manual_attestation` の行も作られない（check_009）。
 *
 * ★ 二重計上の防波堤は `ledger_entry.dedupe_key = 'attest:<invoiceId>'` と
 *   `UNIQUE (invoice_id, dedupe_key)`（`supabase/migrations/0001_init.sql`）。
 *   同じ請求への 2 回目の申告は台帳を増やさない。
 *
 * ★ ランクは**前進のみ**（制約 W3）。`WHERE settlement_rank < :new` を外さない。
 *   取消済み（`lifecycle_state='void'`）の請求には申告できない（409）。
 *
 * ★ 本タスクの範囲は「`manual-attest` の最小追記」であり、`applyToLedger` の本体
 *   （金額不一致・二重払い・取消後入金の分岐）は task_018 が持つ。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";
import type postgres from "postgres";

import { appendAuditLog } from "@/lib/audit";
import { CSRF_HEADER, assertCsrfToken } from "@/lib/auth/csrf";
import { requireSession } from "@/lib/auth/session";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
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
import type { ManualChannel } from "@/lib/payments/types";

type RouteEnv = RawEnv & DbEnv;
interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

const CODE_NOT_FOUND = "NOT_FOUND" as ErrorCode;
const CODE_INVOICE_STATE = "INVOICE_STATE_CONFLICT" as ErrorCode;

/**
 * `settlement_status` の到達先。文字列を SQL にそのまま書かず束縛値で渡す。
 * `docs/constraints.json` W3 の grep は「ランクガードの外での直接代入」をリテラル代入の
 * 形で検出するため、束縛値にして誤検知と実体の両方を避ける。
 */
const SETTLEMENT_PAID = "paid";
/** `paid` の `settlement_rank`（`supabase/migrations/0001_init.sql` の生成列）。 */
const SETTLEMENT_PAID_RANK = 40;

const MANUAL_CHANNELS: readonly ManualChannel[] = ["paypay_p2p", "cash", "bank_transfer", "other"];
const REASON_MAX = 200;
const EVIDENCE_NOTE_MAX = 200;

export interface ManualAttestInput {
  readonly method: ManualChannel;
  readonly reason: string;
  readonly evidenceNote: string | null;
  /** O-8 の「これは自動照合ではありません」ダイアログを通ったことの明示（§8-1 O-8）。 */
  readonly confirmed: true;
}

/** 純粋関数。DB に触れる前に落とすので、`reason` が空なら行は 1 つも作られない（check_009）。 */
export function parseManualAttestBody(body: unknown): ManualAttestInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const r = body as Record<string, unknown>;

  const method = r["method"];
  if (typeof method !== "string" || !MANUAL_CHANNELS.includes(method as ManualChannel)) {
    throw badRequest(`method must be one of ${MANUAL_CHANNELS.join(", ")}`);
  }

  const reason = r["reason"];
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw badRequest("reason is required");
  }
  if (reason.length > REASON_MAX) {
    throw badRequest(`reason must not exceed ${REASON_MAX} chars`);
  }

  const rawNote = r["evidenceNote"];
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== "string") {
    throw badRequest("evidenceNote must be a string when present");
  }
  const evidenceNote =
    typeof rawNote === "string" && rawNote.trim().length > 0 ? rawNote.trim() : null;
  if (evidenceNote !== null && evidenceNote.length > EVIDENCE_NOTE_MAX) {
    throw badRequest(`evidenceNote must not exceed ${EVIDENCE_NOTE_MAX} chars`);
  }

  if (r["confirmed"] !== true) {
    throw badRequest("confirmed must be true (O-8 dialog)");
  }

  return { method: method as ManualChannel, reason: reason.trim(), evidenceNote, confirmed: true };
}

interface OwnedInvoiceRow {
  readonly id: string;
  readonly event_id: string;
  readonly amount_minor: number;
  readonly settlement_rank: number;
  readonly lifecycle_state: string;
  readonly organizer_user_id: string;
}

/** 当該 organizer の請求であることを SQL の WHERE で確かめる（§9 の認可の原則）。 */
async function loadOwnedInvoice(
  sql: postgres.TransactionSql,
  organizerUserId: string,
  invoiceId: string,
): Promise<OwnedInvoiceRow> {
  const rows = await sql<OwnedInvoiceRow[]>`
    SELECT i.id, i.event_id, i.amount_minor, i.settlement_rank, i.lifecycle_state,
           e.organizer_user_id
    FROM invoice i
    JOIN event e ON e.id = i.event_id
    WHERE i.id = ${invoiceId} AND e.organizer_user_id = ${organizerUserId}
    FOR UPDATE OF i
  `;
  const row = rows[0];
  if (row === undefined) {
    // 他人の請求と存在しない請求を区別しない（存在の漏洩を避ける）。
    throw new AppError(CODE_NOT_FOUND, 404, "対象の会費が見つかりません。");
  }
  return row;
}

export interface ManualAttestResultBody {
  readonly invoice: {
    readonly id: string;
    readonly settlementStatus: string;
    readonly autoDetected: false;
    readonly confirmationMethod: "manual_by_organizer";
  };
  readonly ledgerAppended: boolean;
}

/**
 * 申告の本体（1 トランザクション内）。HTTP 層から切り出してあるのは、統合テストが
 * Cloudflare のランタイム文脈なしに実 DB へ通せるようにするためである
 * （`tests/integration/manual-attest.test.ts`）。呼び出し側は `runIdempotent` の内側で呼ぶ。
 */
export async function applyManualAttest(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  invoiceId: string,
  input: ManualAttestInput,
  requestId: string,
): Promise<ManualAttestResultBody> {
  const invoice = await loadOwnedInvoice(tx, organizerUserId, invoiceId);
  if (invoice.lifecycle_state !== "active") {
    throw new AppError(
      CODE_INVOICE_STATE,
      409,
      "取り消された会費には受け取りの記録を付けられません。",
    );
  }

  await tx`
    INSERT INTO manual_attestation (invoice_id, organizer_user_id, method, reason, evidence_note)
    VALUES (${invoice.id}, ${organizerUserId}, ${input.method}, ${input.reason},
            ${input.evidenceNote})
  `;

  // 二重計上の防波堤は dedupe_key。2 回目の申告では 0 行になる（台帳は増えない）。
  const ledgerRows = await tx<{ id: string }[]>`
    INSERT INTO ledger_entry (invoice_id, event_id, direction, kind, amount_minor,
                              confidence, dedupe_key, recorded_by, memo)
    VALUES (${invoice.id}, ${invoice.event_id}, 'credit', 'payment', ${invoice.amount_minor},
            'organizer_attested', ${`attest:${invoice.id}`},
            ${`organizer:${organizerUserId}`}, ${input.reason})
    ON CONFLICT (invoice_id, dedupe_key) DO NOTHING
    RETURNING id
  `;

  // ★ ランクは前進のみ（制約 W3）。到達先の rank より小さい行だけを進める。
  const updated = await tx<{ settlement_status: string }[]>`
    UPDATE invoice
    SET settlement_status = ${SETTLEMENT_PAID},
        auto_detected = false,
        confirmation_method = 'manual_by_organizer',
        paid_at = COALESCE(paid_at, now())
    WHERE id = ${invoice.id}
      AND lifecycle_state = 'active'
      AND settlement_rank < ${SETTLEMENT_PAID_RANK}
    RETURNING settlement_status
  `;

  // 手動確認で確定したので、外部決済の「生きた試行」は取り下げる。
  // 手動経路の試行は事業者からの確定が来ないため、放置すると名簿が
  // 「手続き中（催促は送れません）」のまま固定される。
  await tx`
    UPDATE payment_attempt SET status = 'canceled'
    WHERE invoice_id = ${invoice.id} AND is_open
  `;

  const settlementStatus =
    updated[0]?.settlement_status ??
    (
      await tx<{ settlement_status: string }[]>`
        SELECT settlement_status FROM invoice WHERE id = ${invoice.id}
      `
    )[0]?.settlement_status ??
    SETTLEMENT_PAID;

  await appendAuditLog(tx, {
    actorType: "organizer",
    action: "invoice.manual_attest",
    targetType: "invoice",
    targetId: invoice.id,
    beforeRank: invoice.settlement_rank,
    afterRank: SETTLEMENT_PAID_RANK,
    amountMinor: invoice.amount_minor,
    providerKey: "manual_confirm",
    requestId,
    detail: { method: input.method, ledgerAppended: ledgerRows.length === 1 },
  });

  return {
    invoice: {
      id: invoice.id,
      settlementStatus,
      autoDetected: false,
      confirmationMethod: "manual_by_organizer",
    },
    ledgerAppended: ledgerRows.length === 1,
  };
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
    const input = parseManualAttestBody(bodyJson);
    const requestHash = await computeRequestHash(bodyJson);
    const userRef = idempotencyUserRef(session.userId);
    const dbHandle = db;

    const outcome = await dbHandle.sql.begin(async (tx) =>
      runIdempotent(
        {
          sql: tx,
          userRef,
          endpoint: `POST /api/invoices/${id}/manual-attest`,
          key: idempotencyKey,
          requestHash,
        },
        async () => {
          const body = await applyManualAttest(tx, session.userId, id, input, requestId);
          return { statusCode: 200, cacheableBody: { ...body } };
        },
      ),
    );

    logEvent("info", "invoice.manual_attest", {
      requestId,
      userId: session.userId,
      outcome: outcome.replayed ? "replayed" : "attested",
    });

    return Response.json({ ...outcome.body, requestId }, { status: outcome.statusCode });
  } catch (error) {
    logEvent("info", "invoice.manual_attest.failed", {
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
