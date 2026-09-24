/**
 * 外部由来イベントの受信ログ（`payment_event` / `webhook_delivery`）。
 *
 * ★ W1 の一段目: `payment_event (provider_key, provider_event_id)` の一意制約に対して
 *   `INSERT ... ON CONFLICT DO NOTHING RETURNING id` を撃つ。**0 行なら既処理**であり、
 *   そこで打ち切る（台帳にも請求にも触らない）。
 *
 * ★ R-DATA-01: `raw_redacted` には**許可キーだけ**を残す。事業者の生本文をそのまま
 *   保存しない（氏名・メール・電話が混ざる）。生本文は `webhook_delivery.raw_body` に
 *   14 日だけ置き、保持期間 cron（task_024）が NULL 化する。
 *
 * ★ 「適用保留」は `apply_result IS NULL AND processed_at IS NULL` で表す。
 *   `apply_result` の CHECK は `('applied','duplicate','ignored','mismatch','orphan',
 *   'signature_failed','error')` の 7 値で `held` を持たないため、保留に専用の値を
 *   割り当てられない。未処理＝保留と読む（`/api/cron/apply-pending` の走査条件になる）。
 */

import "server-only";

import type postgres from "postgres";

type SqlLike = postgres.ISql;

/** `payment_event.apply_result` の CHECK と同じ集合。 */
export type ApplyResult =
  | "applied"
  | "duplicate"
  | "ignored"
  | "mismatch"
  | "orphan"
  | "signature_failed"
  | "error";

/** `payment_event.ingestion_source` の CHECK と同じ集合。 */
export type IngestionSource = "webhook" | "poll" | "manual" | "bank";

/**
 * `raw_redacted` に残してよいキー（R-DATA-01）。
 * ID・enum・金額・時刻だけ。自由記述と個人情報は 1 つも入れない。
 */
export const RAW_REDACTED_ALLOWED_KEYS: readonly string[] = [
  "eventType",
  "kind",
  "externalRef",
  "providerEventId",
  "amountMinor",
  "currency",
  "occurredAt",
  "status",
];

/** 許可キー以外を落とし、値もスカラーだけに限る。 */
export function redactRawPayload(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  for (const key of RAW_REDACTED_ALLOWED_KEYS) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (value instanceof Date) {
      out[key] = value.toISOString();
    }
  }
  return out;
}

export interface InsertPaymentEventInput {
  readonly providerKey: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly kind: string;
  readonly externalRef: string;
  readonly businessIdemKey: string;
  readonly invoiceId: string | null;
  readonly attemptId: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly occurredAt: Date | null;
  readonly ingestionSource: IngestionSource;
  readonly trust: string;
  readonly rawRedacted: Readonly<Record<string, string | number | boolean>>;
}

/**
 * W1 の一段目。**0 行（`null`）なら重複**である。
 * `apply_result` はここでは書かない（未処理＝適用保留のまま返す）。
 */
export async function insertPaymentEvent(
  sql: SqlLike,
  input: InsertPaymentEventInput,
): Promise<string | null> {
  const rawRedacted = JSON.parse(JSON.stringify(input.rawRedacted)) as postgres.JSONValue;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO payment_event (
      provider_key, provider_event_id, event_type, kind, external_ref, business_idem_key,
      invoice_id, attempt_id, amount_minor, currency, occurred_at,
      ingestion_source, trust, raw_redacted
    ) VALUES (
      ${input.providerKey}, ${input.providerEventId}, ${input.eventType}, ${input.kind},
      ${input.externalRef}, ${input.businessIdemKey},
      ${input.invoiceId}, ${input.attemptId}, ${input.amountMinor}, ${input.currency},
      ${input.occurredAt}, ${input.ingestionSource}, ${input.trust}, ${sql.json(rawRedacted)}
    )
    ON CONFLICT (provider_key, provider_event_id) DO NOTHING
    RETURNING id
  `;
  return rows[0]?.id ?? null;
}

/** 適用結果を確定する。`processed_at` が入った行は「保留」ではなくなる。 */
export async function setPaymentEventResult(
  sql: SqlLike,
  paymentEventId: string,
  applyResult: ApplyResult,
  now: Date = new Date(),
): Promise<void> {
  await sql`
    UPDATE payment_event
    SET apply_result = ${applyResult}, processed_at = ${now}
    WHERE id = ${paymentEventId}::bigint
  `;
}

/** 試行が解決したあとに請求・試行への紐付けを埋める（受信時は未解決でも保存する）。 */
export async function linkPaymentEvent(
  sql: SqlLike,
  paymentEventId: string,
  invoiceId: string,
  attemptId: string,
): Promise<void> {
  await sql`
    UPDATE payment_event
    SET invoice_id = ${invoiceId}, attempt_id = ${attemptId}
    WHERE id = ${paymentEventId}::bigint
  `;
}

export interface WebhookDeliveryInput {
  readonly providerKey: string;
  readonly sigOk: boolean;
  readonly ipAllowed: boolean;
  readonly httpStatus: number;
  readonly bodySha256: string;
  readonly rawBody: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly sourceIpHash: Buffer | null;
}

/**
 * 受信ログを 1 件残す（§3-3 の ④）。署名不一致でも残す（check_019 が
 * `sig_ok=false` の行を要求する）。許可外 IP は**呼ばれない**（本文を読まず 403）。
 */
export async function recordWebhookDelivery(
  sql: SqlLike,
  input: WebhookDeliveryInput,
): Promise<string> {
  const headers = JSON.parse(JSON.stringify(input.headers)) as postgres.JSONValue;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO webhook_delivery (
      provider_key, sig_ok, ip_allowed, http_status, body_sha256, raw_body, headers, source_ip_hash
    ) VALUES (
      ${input.providerKey}, ${input.sigOk}, ${input.ipAllowed}, ${input.httpStatus},
      ${input.bodySha256}, ${input.rawBody}, ${sql.json(headers)}, ${input.sourceIpHash}
    )
    RETURNING id
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("webhook_delivery insert returned no row");
  return row.id;
}
