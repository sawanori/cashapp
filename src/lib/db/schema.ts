/**
 * Drizzle スキーマ — **型とクエリのためだけ**に存在する。
 *
 * ★ スキーマの正本は `supabase/migrations/*.sql` である。このファイルから
 *   drizzle-kit generate / push でマイグレーションを作ってはならない
 *   （台帳の二重化を防ぐ。docs/implementation-plan.md §7-2「マイグレーション」行、R-SEC-03）。
 *   `tests/integration/schema.test.ts` が、ここで宣言した全テーブル・全列が
 *   実 DB（マイグレーション適用後）と名前・NOT NULL・データ型まで一致することを検査する。
 *   一致しなくなったら直すのはこのファイルであって、マイグレーションではない。
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * `bytea`。drizzle-orm には組み込みの bytea 型が無いので custom type にする。
 * 本アプリで bytea に入るのはすべてハッシュ（HMAC / SHA-256）であり、生の識別子・
 * 生の IP・生のトークンは入れない。
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/** `daterange`（payout.period）。クエリでは文字列として扱う。 */
const daterange = customType<{ data: string; driverData: string }>({
  dataType() {
    return "daterange";
  },
});

const tz = { withTimezone: true, mode: "date" } as const;

// ============================================================================
// 主体
// ============================================================================

export const appUser = pgTable("app_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  lineUserRef: bytea("line_user_ref").notNull(),
  pepperVersion: smallint("pepper_version").notNull().default(1),
  identityScope: text("identity_scope").notNull(),
  lineEnv: text("line_env").notNull().$type<"development" | "staging" | "production">(),
  sessionEpoch: integer("session_epoch").notNull().default(1),
  status: text("status").notNull().$type<"active" | "suspended">().default("active"),
  suspendedAt: timestamp("suspended_at", tz),
  tosAcceptedAt: timestamp("tos_accepted_at", tz),
  privacyConsentAt: timestamp("privacy_consent_at", tz),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
});

export const usedIdToken = pgTable("used_id_token", {
  jtiOrHash: text("jti_or_hash").primaryKey(),
  usedAt: timestamp("used_at", tz).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", tz).notNull(),
});

export const consentLog = pgTable("consent_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  consentKind: text("consent_kind")
    .notNull()
    .$type<"tos" | "privacy" | "organizer_disclosure" | "fee_display">(),
  textVersion: text("text_version").notNull(),
  acceptedAt: timestamp("accepted_at", tz).notNull().defaultNow(),
});

export const providerBinding = pgTable("provider_binding", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizerUserId: uuid("organizer_user_id").notNull(),
  providerKey: text("provider_key").notNull(),
  /** 外部シークレットストアのキー名。値は入れない。 */
  credentialRef: text("credential_ref"),
  credentialFp: text("credential_fp"),
  receivingIdentifier: text("receiving_identifier"),
  receivingIdentifierKind: text("receiving_identifier_kind")
    .$type<"merchant_id" | "bank_account_ref" | "none">(),
  feeRateBp: integer("fee_rate_bp"),
  capabilities: jsonb("capabilities").notNull().default({}),
  status: text("status")
    .notNull()
    .$type<"pending" | "active" | "suspended" | "revoked">()
    .default("pending"),
  verifiedAt: timestamp("verified_at", tz),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
});

// ============================================================================
// イベント・名簿
// ============================================================================

export const event = pgTable("event", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizerUserId: uuid("organizer_user_id").notNull(),
  title: text("title").notNull(),
  organizerLabel: text("organizer_label").notNull(),
  eventAt: timestamp("event_at", tz),
  venue: text("venue"),
  offering: text("offering"),
  currency: char("currency", { length: 3 }).notNull().default("JPY"),
  defaultAmountMinor: integer("default_amount_minor"),
  collectByAt: timestamp("collect_by_at", tz),
  status: text("status")
    .notNull()
    .$type<"draft" | "collecting" | "closed" | "canceled">()
    .default("draft"),
  joinTokenHash: bytea("join_token_hash").notNull(),
  joinTokenExpiresAt: timestamp("join_token_expires_at", tz),
  joinTokenVersion: integer("join_token_version").notNull().default(1),
  allowCash: boolean("allow_cash").notNull().default(false),
  minorsIncluded: boolean("minors_included").notNull(),
  providerKey: text("provider_key").notNull().default("manual_confirm"),
  providerBindingId: uuid("provider_binding_id"),
  retentionDueAt: timestamp("retention_due_at", tz),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
});

export const participant = pgTable("participant", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull(),
  displayLabel: text("display_label"),
  nameVisibility: text("name_visibility")
    .notNull()
    .$type<"organizer_only" | "participants">()
    .default("organizer_only"),
  claimTokenHash: bytea("claim_token_hash"),
  pepperVersion: smallint("pepper_version"),
  confirmedByOrganizerAt: timestamp("confirmed_by_organizer_at", tz),
  status: text("status").notNull().$type<"active" | "removed">().default("active"),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
});

export const participantClaim = pgTable("participant_claim", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull(),
  participantId: uuid("participant_id").notNull(),
  lineUserRef: bytea("line_user_ref").notNull(),
  pepperVersion: smallint("pepper_version").notNull().default(1),
  claimedAt: timestamp("claimed_at", tz).notNull().defaultNow(),
  releasedAt: timestamp("released_at", tz),
  releasedReason: text("released_reason")
    .$type<"organizer_unclaim" | "self_release" | "participant_removed" | "admin">(),
});

// ============================================================================
// 請求
// ============================================================================

/** `invoice.settlement_status` の許容値。rank は DB の生成列が導く（W3）。 */
export const SETTLEMENT_STATUSES = [
  "unpaid",
  "authorized",
  "paid",
  "refund_pending",
  "refunded",
  "charged_back",
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const invoice = pgTable("invoice", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull(),
  participantId: uuid("participant_id").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: char("currency", { length: 3 }).notNull().default("JPY"),
  settlementStatus: text("settlement_status")
    .notNull()
    .$type<SettlementStatus>()
    .default("unpaid"),
  /** ★ 生成列。アプリから書かない（書こうとすると Postgres が拒否する）。 */
  settlementRank: smallint("settlement_rank")
    .notNull()
    .generatedAlwaysAs(
      sql`CASE settlement_status WHEN 'unpaid' THEN 0 WHEN 'authorized' THEN 10 WHEN 'paid' THEN 40 WHEN 'refund_pending' THEN 60 WHEN 'refunded' THEN 70 WHEN 'charged_back' THEN 80 END`,
    ),
  lifecycleState: text("lifecycle_state").notNull().$type<"active" | "void">().default("active"),
  voidedAt: timestamp("voided_at", tz),
  needsAttention: boolean("needs_attention").notNull().default(false),
  autoDetected: boolean("auto_detected").notNull().default(false),
  confirmationMethod: text("confirmation_method")
    .notNull()
    .$type<"automatic" | "manual_by_organizer">()
    .default("manual_by_organizer"),
  paidAt: timestamp("paid_at", tz),
  settledAt: timestamp("settled_at", tz),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
});

// ============================================================================
// 決済試行
// ============================================================================

export const paymentAttempt = pgTable("payment_attempt", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull(),
  providerKey: text("provider_key").notNull(),
  providerBindingId: uuid("provider_binding_id").notNull(),
  externalRef: text("external_ref").notNull(),
  providerPaymentId: text("provider_payment_id"),
  amountMinor: integer("amount_minor").notNull(),
  currency: char("currency", { length: 3 }).notNull().default("JPY"),
  status: text("status")
    .notNull()
    .$type<
      | "created"
      | "redirected"
      | "authorized"
      | "succeeded"
      | "failed"
      | "canceled"
      | "expired"
      | "refunded"
    >()
    .default("created"),
  /** ★ 生成列。 */
  isOpen: boolean("is_open")
    .notNull()
    .generatedAlwaysAs(sql`status IN ('created', 'redirected', 'authorized')`),
  checkoutUrl: text("checkout_url"),
  expiresAt: timestamp("expires_at", tz),
  returnTokenHash: bytea("return_token_hash"),
  returnTokenExpiresAt: timestamp("return_token_expires_at", tz),
  openedByUserRef: bytea("opened_by_user_ref"),
  lastSnapshot: jsonb("last_snapshot"),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
});

// ============================================================================
// 外部由来イベント
// ============================================================================

export const paymentEvent = pgTable("payment_event", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  providerKey: text("provider_key").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  eventType: text("event_type").notNull(),
  kind: text("kind")
    .notNull()
    .$type<
      | "authorized"
      | "succeeded"
      | "failed"
      | "canceled"
      | "expired"
      | "refunded"
      | "refund_pending"
      | "refund_failed"
      | "disputed"
      | "dispute_resolved"
      | "unknown"
    >(),
  externalRef: text("external_ref").notNull(),
  /** ★ UNIQUE にしない（部分返金が同じキーを生むため。design-synthesis.md §2-2 の注）。 */
  businessIdemKey: text("business_idem_key").notNull(),
  invoiceId: uuid("invoice_id"),
  attemptId: uuid("attempt_id"),
  amountMinor: integer("amount_minor"),
  currency: char("currency", { length: 3 }),
  /** 順序判定に使わない（W4）。 */
  occurredAt: timestamp("occurred_at", tz),
  receivedAt: timestamp("received_at", tz).notNull().defaultNow(),
  ingestionSource: text("ingestion_source")
    .notNull()
    .$type<"webhook" | "poll" | "manual" | "bank">(),
  trust: text("trust").notNull().$type<"verified" | "reverified" | "unverified" | "attested">(),
  applyResult: text("apply_result")
    .$type<
      "applied" | "duplicate" | "ignored" | "mismatch" | "orphan" | "signature_failed" | "error"
    >(),
  processedAt: timestamp("processed_at", tz),
  /** 許可キーのみ。生の本文を残さない（R-DATA-01）。 */
  rawRedacted: jsonb("raw_redacted").notNull().default({}),
});

// ============================================================================
// 台帳（追記専用）
// ============================================================================

export const ledgerEntry = pgTable("ledger_entry", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull(),
  eventId: uuid("event_id").notNull(),
  direction: text("direction").notNull().$type<"credit" | "debit">(),
  kind: text("kind")
    .notNull()
    .$type<
      | "payment"
      | "refund"
      | "overpay"
      | "proxy_payment"
      | "adjustment"
      | "writeoff"
      | "chargeback"
      | "chargeback_reversal"
      | "fee"
    >(),
  amountMinor: integer("amount_minor").notNull(),
  currency: char("currency", { length: 3 }).notNull().default("JPY"),
  confidence: text("confidence")
    .notNull()
    .$type<"provider_verified" | "provider_polled" | "bank_matched" | "organizer_attested">(),
  /** ★ 二重計上の唯一の防波堤（W2）。 */
  dedupeKey: text("dedupe_key").notNull(),
  sourcePaymentEventId: bigint("source_payment_event_id", { mode: "bigint" }),
  recordedBy: text("recorded_by").notNull(),
  memo: text("memo"),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});

export const paymentSelfReport = pgTable("payment_self_report", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull(),
  reportedByUserRef: bytea("reported_by_user_ref").notNull(),
  method: text("method").notNull().$type<"paypay_p2p" | "cash" | "bank_transfer" | "other">(),
  note: text("note"),
  reportedAt: timestamp("reported_at", tz).notNull().defaultNow(),
});

export const manualAttestation = pgTable("manual_attestation", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull(),
  organizerUserId: uuid("organizer_user_id").notNull(),
  method: text("method").notNull().$type<"paypay_p2p" | "cash" | "bank_transfer" | "other">(),
  reason: text("reason").notNull(),
  evidenceNote: text("evidence_note"),
  attestedAt: timestamp("attested_at", tz).notNull().defaultNow(),
});

// ============================================================================
// 監査ログ（追記専用 ＋ ハッシュ連鎖）
// ============================================================================

export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  occurredAt: timestamp("occurred_at", tz).notNull().defaultNow(),
  actorType: text("actor_type")
    .notNull()
    .$type<"organizer" | "participant" | "system" | "webhook" | "admin">(),
  actorRef: bytea("actor_ref"),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  beforeRank: smallint("before_rank"),
  afterRank: smallint("after_rank"),
  amountMinor: integer("amount_minor"),
  providerKey: text("provider_key"),
  externalRef: text("external_ref"),
  requestId: text("request_id").notNull(),
  sourceIpHash: bytea("source_ip_hash"),
  detail: jsonb("detail").notNull().default({}),
  prevHash: bytea("prev_hash"),
  rowHash: bytea("row_hash").notNull(),
});

// ============================================================================
// ゲート・フラグ
// ============================================================================

export const complianceGate = pgTable("compliance_gate", {
  gateKey: text("gate_key").primaryKey(),
  description: text("description").notNull(),
  scope: text("scope"),
  requiredFor: text("required_for").array().notNull(),
  status: text("status")
    .notNull()
    .$type<"unknown" | "inquired" | "passed" | "failed" | "n/a">()
    .default("unknown"),
  validUntil: timestamp("valid_until", tz),
  evidenceUri: text("evidence_uri"),
  evidenceVersion: text("evidence_version"),
  sourceUrlHash: bytea("source_url_hash"),
  sourceRef: text("source_ref"),
  requestedBy: text("requested_by"),
  approvedBy: text("approved_by"),
  inquiredAt: timestamp("inquired_at", tz),
  decidedAt: timestamp("decided_at", tz),
  decidedBy: text("decided_by"),
  confidence: text("confidence").$type<"measured" | "documented" | "designed" | "unknown">(),
  note: text("note"),
  syncedAt: timestamp("synced_at", tz).notNull().defaultNow(),
});

export const featureFlag = pgTable("feature_flag", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
});

// ============================================================================
// 非同期・突合・受信ログ
// ============================================================================

export const outbox = pgTable("outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull(),
  runAfter: timestamp("run_after", tz).notNull().defaultNow(),
  attempts: smallint("attempts").notNull().default(0),
  maxAttempts: smallint("max_attempts").notNull().default(8),
  deadLetteredAt: timestamp("dead_lettered_at", tz),
  lockedUntil: timestamp("locked_until", tz),
  doneAt: timestamp("done_at", tz),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});

export const webhookDelivery = pgTable("webhook_delivery", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerKey: text("provider_key").notNull(),
  receivedAt: timestamp("received_at", tz).notNull().defaultNow(),
  sigOk: boolean("sig_ok").notNull(),
  ipAllowed: boolean("ip_allowed").notNull(),
  httpStatus: smallint("http_status").notNull(),
  bodySha256: text("body_sha256").notNull(),
  rawBody: text("raw_body"),
  headers: jsonb("headers"),
  sourceIpHash: bytea("source_ip_hash"),
});

export const reconciliationRun = pgTable("reconciliation_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", tz).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", tz),
  scanned: integer("scanned").notNull().default(0),
  advanced: integer("advanced").notNull().default(0),
  mismatches: integer("mismatches").notNull().default(0),
  paidRescanned: integer("paid_rescanned").notNull().default(0),
  postPaidChanges: integer("post_paid_changes").notNull().default(0),
  truncated: boolean("truncated").notNull().default(false),
  note: text("note"),
});

export const idempotencyKey = pgTable(
  "idempotency_key",
  {
    userRef: bytea("user_ref").notNull(),
    endpoint: text("endpoint").notNull(),
    key: text("key").notNull(),
    state: text("state").notNull().$type<"in_flight" | "done">().default("in_flight"),
    requestHash: text("request_hash").notNull(),
    responseBody: jsonb("response_body"),
    statusCode: smallint("status_code"),
    expiresAt: timestamp("expires_at", tz).notNull(),
    createdAt: timestamp("created_at", tz).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", tz).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userRef, t.endpoint, t.key] })],
);

export const abuseReport = pgTable("abuse_report", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").notNull(),
  reporterUserRef: bytea("reporter_user_ref").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});

export const reminderLog = pgTable("reminder_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull(),
  sentByOrganizer: uuid("sent_by_organizer").notNull(),
  seq: smallint("seq").notNull(),
  sentAt: timestamp("sent_at", tz).notNull().defaultNow(),
});

export const payout = pgTable("payout", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerBindingId: uuid("provider_binding_id").notNull(),
  period: daterange("period").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  feeMinor: integer("fee_minor").notNull().default(0),
  currency: char("currency", { length: 3 }).notNull().default("JPY"),
  settledAt: timestamp("settled_at", tz),
  createdAt: timestamp("created_at", tz).notNull().defaultNow(),
});
