/**
 * 外部由来イベントの台帳適用（`docs/implementation-plan.md` §9「`applyToLedger` の不変条件」/
 * `docs/research/design-synthesis.md` §3-4 / check_021 / check_023 / check_094）。
 *
 * ★ 呼び出し側は**すでにトランザクションの中にいること**。台帳・請求・試行・監査・outbox は
 *   1 トランザクションで確定しなければ、片方だけがコミットされた不整合が残る。
 *
 * ★ 不変条件（すべてテストで固定してある）:
 *   1. **突合基準は `payment_attempt.amount_minor`**（参加者に提示した金額）。`invoice` ではない。
 *   2. 金額・通貨が一致しないイベントは**ランクを前進させず**、受領事実を
 *      `ledger_entry.kind='adjustment'` として記録し `needs_attention` を立てる（check_023）。
 *   3. ランクは `WHERE settlement_rank < $new` の**前進のみ**（W3）。例外規則は無い。
 *   4. `charged_back`（80）へ前進する分岐を持つ。
 *   5. 二重払いの検知は試行の件数ではなく**台帳残高 > 請求額**（`balance.ts`）。
 *   6. `confirmation_method` は `ledger_entry.confidence` の**集合から導出**する
 *      （`balance.ts`。`mixed` は DB に保存できないので非自動側へ倒す）。
 *   7. 取消済み（`lifecycle_state='void'`）の請求への入金は**前進させたうえで**
 *      `void` を維持し、`needs_attention` と outbox `paid_after_void` を立てる（check_021）。
 *
 * ★ `trust='unverified'`（署名を持たない事業者）のイベントは**ここでは適用しない**。
 *   §3-3 のとおり `getPaymentStatus` で再照会してから `reverified` として流し直す。
 *   このモジュールはアダプタを持たないので、保留（`apply_result='ignored'`）にして返す。
 *
 * ★ `ledger_entry.memo` は Phase 1 では**書かない**（常に NULL）。追記専用テーブルなので
 *   自由記述を入れると擬似匿名化の手段が無くなる（premortem phase1b P-07）。
 *
 * ★ `docs/constraints.json` W3 の grep は本ファイルを exclude_globs に持つ。状態遷移を書く
 *   唯一の場所だからであり、ランクガードを外してよいという意味ではない。
 */

import "server-only";

import type postgres from "postgres";

import { appendAuditLog } from "@/lib/audit";
import {
  advanceOpenAttempt,
  lockAttemptByProviderRef,
  type PaymentAttemptRow,
  type PaymentAttemptStatus,
} from "@/lib/db/repositories/attempts";
import {
  linkPaymentEvent,
  setPaymentEventResult,
  type ApplyResult,
  type IngestionSource,
} from "@/lib/db/repositories/events-log";
import { enqueueOutbox } from "@/lib/outbox";
import type { ConfirmationMethod, NormalizedEvent, PaymentEventKind } from "@/lib/payments/types";

import {
  deriveConfirmationMethod,
  isOverpaid,
  ledgerBalanceMinor,
  persistedConfirmationMethod,
  type LedgerConfidence,
  type LedgerDirection,
  type LedgerKind,
  type LedgerLine,
} from "./balance";
import { ledgerDedupeKey } from "./dedupe";
import { isAttemptOnlyKind, rankOf, targetStatusFor, type SettlementStatus } from "./rank";

export interface ApplyToLedgerInput {
  readonly event: NormalizedEvent;
  /** `payment_event.id`（W1 の一段目を通った行）。保留の再適用では既存行の id を渡す。 */
  readonly paymentEventId: string | null;
  readonly ingestionSource: IngestionSource;
  readonly requestId: string;
  /** `ledger_entry.recorded_by`。秘密値・生 userId を入れない。 */
  readonly recordedBy: string;
  readonly now?: Date;
}

export interface ApplyOutcome {
  readonly result: ApplyResult;
  readonly invoiceId: string | null;
  readonly attemptId: string | null;
  readonly settlementStatus: SettlementStatus | null;
  readonly rankAdvanced: boolean;
  readonly ledgerAppended: boolean;
  readonly ledgerKind: LedgerKind | null;
  readonly needsAttention: boolean;
  readonly confirmationMethod: ConfirmationMethod | null;
  readonly outboxKinds: readonly string[];
}

interface InvoiceRow {
  readonly id: string;
  readonly event_id: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly settlement_status: string;
  readonly settlement_rank: number;
  readonly lifecycle_state: string;
  readonly needs_attention: boolean;
  readonly auto_detected: boolean;
}

interface LedgerDbRow {
  readonly direction: string;
  readonly kind: string;
  readonly amount_minor: number;
  readonly confidence: string;
}

/** 台帳に金額を動かす行を作る種別と、その向き。ここに無い種別は台帳を書かない。 */
const LEDGER_SHAPE: Readonly<
  Partial<Record<PaymentEventKind, { readonly direction: LedgerDirection; readonly kind: LedgerKind }>>
> = {
  succeeded: { direction: "credit", kind: "payment" },
  refunded: { direction: "debit", kind: "refund" },
  disputed: { direction: "debit", kind: "chargeback" },
  dispute_resolved: { direction: "credit", kind: "chargeback_reversal" },
};

/** `trust` → `ledger_entry.confidence`。`unverified` は適用しないので対応を持たない。 */
function confidenceFor(trust: NormalizedEvent["trust"]): LedgerConfidence | null {
  switch (trust) {
    case "verified":
      return "provider_verified";
    case "reverified":
      return "provider_polled";
    case "attested":
      return "organizer_attested";
    case "unverified":
      return null;
    default: {
      const exhaustive: never = trust;
      throw new Error(`unhandled trust: ${String(exhaustive)}`);
    }
  }
}

function toLedgerLines(rows: readonly LedgerDbRow[]): readonly LedgerLine[] {
  return rows.map((row) => ({
    direction: row.direction as LedgerDirection,
    kind: row.kind as LedgerKind,
    amountMinor: row.amount_minor,
    confidence: row.confidence as LedgerConfidence,
  }));
}

async function readLedgerLines(
  tx: postgres.TransactionSql,
  invoiceId: string,
): Promise<readonly LedgerLine[]> {
  const rows = await tx<LedgerDbRow[]>`
    SELECT direction, kind, amount_minor, confidence
    FROM ledger_entry WHERE invoice_id = ${invoiceId}
  `;
  return toLedgerLines(rows);
}

// ============================================================================
// 判断（純関数）
// ============================================================================

/**
 * 適用の判断に必要な事実だけを集めた入力。**DB に触れない**ので、
 * 全遷移 × 全種別の網羅（check_094）を `npm run test:unit` で回せる
 * （`tests/unit/ledger/apply.test.ts`。`test:unit` は CI で Postgres 無しに走る）。
 */
export interface ApplyPlanInput {
  readonly kind: PaymentEventKind;
  readonly trust: NormalizedEvent["trust"];
  readonly ingestionSource: IngestionSource;
  /** イベントが名乗る金額。持たない種別は `null`。 */
  readonly eventAmountMinor: number | null;
  readonly eventCurrency: string | null;
  /** ★ 突合基準（`payment_attempt`）。`invoice` ではない。 */
  readonly attemptAmountMinor: number;
  readonly attemptCurrency: string;
  readonly invoiceAmountMinor: number;
  readonly invoiceRank: number;
  readonly lifecycleState: string;
  /** このイベントを適用する前の台帳残高（`adjustment` を除く。`balance.ts`）。 */
  readonly ledgerBalanceBeforeMinor: number;
}

/** 何をするかの決定。`hold` は再照会待ち（`trust='unverified'`）。 */
export type ApplyDecision = "apply" | "mismatch" | "attempt_only" | "hold";

export interface ApplyPlan {
  readonly decision: ApplyDecision;
  readonly ledgerDirection: LedgerDirection | null;
  readonly ledgerKind: LedgerKind | null;
  readonly ledgerAmountMinor: number | null;
  readonly confidence: LedgerConfidence | null;
  readonly targetStatus: SettlementStatus | null;
  /** ランクガード（`settlement_rank < $new`）を通るか。 */
  readonly rankAdvances: boolean;
  readonly attemptStatus: PaymentAttemptStatus | null;
  readonly needsAttention: boolean;
  readonly autoDetected: boolean;
  readonly outboxKinds: readonly string[];
}

/**
 * 適用の判断。**この関数が §9 の不変条件そのものである**。
 *
 * - 金額・通貨が突合基準と一致しなければ `mismatch`（ランク前進なし・`adjustment`・要対応）
 * - `failed` / `canceled` / `expired` は `attempt_only`（請求を動かさない）
 * - ランクは `invoiceRank < rankOf(target)` のときだけ前進する
 * - 取消済みへの入金は前進させたうえで要対応（`paid_after_void`）
 * - 台帳残高が請求額を超えるなら `overpay`
 */
export function planApply(input: ApplyPlanInput): ApplyPlan {
  const confidence = confidenceFor(input.trust);
  if (confidence === null) return holdPlan();

  if (isAttemptOnlyKind(input.kind)) {
    // `failed` / `canceled` / `expired` は `payment_attempt.status` の CHECK と同名の値である
    // （`supabase/migrations/0001_init.sql`）。`isAttemptOnlyKind` がこの 3 値に限っている。
    const attemptStatus: PaymentAttemptStatus =
      input.kind === "failed" ? "failed" : input.kind === "canceled" ? "canceled" : "expired";
    return {
      decision: "attempt_only",
      ledgerDirection: null,
      ledgerKind: null,
      ledgerAmountMinor: null,
      confidence: null,
      targetStatus: null,
      rankAdvances: false,
      attemptStatus,
      needsAttention: false,
      autoDetected: false,
      outboxKinds: [],
    };
  }

  const shape = LEDGER_SHAPE[input.kind];
  const amountMatches =
    input.eventAmountMinor === input.attemptAmountMinor &&
    input.eventCurrency === input.attemptCurrency;

  // 金額を伴う種別なのに突合できないものは、ランクを動かさない（W8 / check_023）。
  if (shape !== undefined && !amountMatches) {
    return {
      decision: "mismatch",
      ledgerDirection: shape.direction,
      ledgerKind: "adjustment",
      ledgerAmountMinor:
        input.eventAmountMinor !== null && input.eventAmountMinor > 0
          ? input.eventAmountMinor
          : null,
      confidence,
      targetStatus: null,
      rankAdvances: false,
      attemptStatus: null,
      needsAttention: true,
      autoDetected: false,
      outboxKinds: ["mismatch_alert"],
    };
  }

  const target = targetStatusFor(input.kind);
  const rankAdvances = target !== null && input.invoiceRank < rankOf(target);

  let ledgerKind: LedgerKind | null = shape?.kind ?? null;
  let ledgerAmount: number | null = null;
  let overpay = false;
  if (shape !== undefined && input.eventAmountMinor !== null) {
    ledgerAmount = input.eventAmountMinor;
    const delta = shape.direction === "credit" ? ledgerAmount : -ledgerAmount;
    overpay =
      shape.kind === "payment" &&
      isOverpaid(input.ledgerBalanceBeforeMinor + delta, input.invoiceAmountMinor);
    if (overpay) ledgerKind = "overpay";
  }

  const paidAfterVoid = input.lifecycleState === "void" && input.kind === "succeeded";
  const outboxKinds: string[] = [];
  if (paidAfterVoid) outboxKinds.push("paid_after_void");
  if (overpay) outboxKinds.push("overpay_alert");
  if (input.kind === "disputed") outboxKinds.push("dispute_alert");

  return {
    decision: "apply",
    ledgerDirection: shape?.direction ?? null,
    ledgerKind,
    ledgerAmountMinor: ledgerAmount,
    confidence: shape === undefined ? null : confidence,
    targetStatus: target,
    rankAdvances,
    attemptStatus: attemptStatusFor(input.kind),
    needsAttention: paidAfterVoid || overpay,
    autoDetected: input.ingestionSource !== "manual",
    outboxKinds,
  };
}

function holdPlan(): ApplyPlan {
  return {
    decision: "hold",
    ledgerDirection: null,
    ledgerKind: null,
    ledgerAmountMinor: null,
    confidence: null,
    targetStatus: null,
    rankAdvances: false,
    attemptStatus: null,
    needsAttention: false,
    autoDetected: false,
    outboxKinds: [],
  };
}

/** 成功系イベントが試行に書く状態。書かない種別は `null`。 */
function attemptStatusFor(kind: PaymentEventKind): PaymentAttemptStatus | null {
  if (kind === "succeeded") return "succeeded";
  if (kind === "refunded") return "refunded";
  if (kind === "authorized") return "authorized";
  return null;
}

// ============================================================================
// 実行（DB）
// ============================================================================

/**
 * 1 イベントを台帳へ適用する。戻り値の `result` がそのまま
 * `payment_event.apply_result` に書かれる（`paymentEventId` があるとき）。
 */
export async function applyToLedger(
  tx: postgres.TransactionSql,
  input: ApplyToLedgerInput,
): Promise<ApplyOutcome> {
  const ev = input.event;
  const now = input.now ?? new Date();
  const outboxKinds: string[] = [];

  const confidence = confidenceFor(ev.trust);
  if (confidence === null) {
    // 署名を持たない事業者。再照会（§3-3 の b）を通すまで台帳に載せない。
    await finishPaymentEvent(tx, input.paymentEventId, "ignored", now);
    return emptyOutcome("ignored");
  }

  // ------------------------------------------------------------------ 試行の解決
  const attempt = await lockAttemptByProviderRef(tx, ev.providerKey, ev.externalRef);
  if (attempt === null) {
    outboxKinds.push("orphan_alert");
    await enqueueOutbox(tx, {
      kind: "orphan_alert",
      payload: {
        providerKey: ev.providerKey,
        externalRef: ev.externalRef,
        kind: ev.kind,
        providerEventId: ev.providerEventId,
      },
      runAfter: now,
    });
    await appendAuditLog(tx, {
      actorType: actorTypeFor(input.ingestionSource),
      action: "ledger.apply.orphan",
      targetType: "payment_event",
      targetId: ev.providerEventId,
      providerKey: ev.providerKey,
      externalRef: ev.externalRef,
      requestId: input.requestId,
      detail: { kind: ev.kind, applyResult: "orphan" },
      now,
    });
    await finishPaymentEvent(tx, input.paymentEventId, "orphan", now);
    return { ...emptyOutcome("orphan"), outboxKinds };
  }

  const invoiceRows = await tx<InvoiceRow[]>`
    SELECT id, event_id, amount_minor, currency, settlement_status, settlement_rank,
           lifecycle_state, needs_attention, auto_detected
    FROM invoice WHERE id = ${attempt.invoiceId}
    FOR UPDATE
  `;
  const invoice = invoiceRows[0];
  if (invoice === undefined) {
    // FK があるので通常は起きない。起きたら事実を握り潰さず error として残す。
    await finishPaymentEvent(tx, input.paymentEventId, "error", now);
    return { ...emptyOutcome("error"), attemptId: attempt.id };
  }

  if (input.paymentEventId !== null) {
    await linkPaymentEvent(tx, input.paymentEventId, invoice.id, attempt.id);
  }

  // ------------------------------------------------------------------ 判断（純関数に集約）
  const before = await readLedgerLines(tx, invoice.id);
  const plan = planApply({
    kind: ev.kind,
    trust: ev.trust,
    ingestionSource: input.ingestionSource,
    eventAmountMinor: ev.money?.amountMinor ?? null,
    eventCurrency: ev.money?.currency ?? null,
    attemptAmountMinor: attempt.amountMinor,
    attemptCurrency: attempt.currency,
    invoiceAmountMinor: invoice.amount_minor,
    invoiceRank: invoice.settlement_rank,
    lifecycleState: invoice.lifecycle_state,
    ledgerBalanceBeforeMinor: ledgerBalanceMinor(before),
  });

  // -------------------------------------------- 失敗・キャンセル・期限切れは試行にだけ記録
  if (plan.decision === "attempt_only" && plan.attemptStatus !== null) {
    const changed = await advanceOpenAttempt(tx, attempt.id, plan.attemptStatus);
    const result: ApplyResult = changed ? "applied" : "ignored";
    await appendAuditLog(tx, {
      actorType: actorTypeFor(input.ingestionSource),
      action: "ledger.apply.attempt_only",
      targetType: "invoice",
      targetId: invoice.id,
      beforeRank: invoice.settlement_rank,
      afterRank: invoice.settlement_rank,
      providerKey: ev.providerKey,
      externalRef: ev.externalRef,
      requestId: input.requestId,
      detail: { kind: ev.kind, applyResult: result, attemptChanged: changed },
      now,
    });
    await finishPaymentEvent(tx, input.paymentEventId, result, now);
    return {
      ...emptyOutcome(result),
      invoiceId: invoice.id,
      attemptId: attempt.id,
      settlementStatus: invoice.settlement_status as SettlementStatus,
    };
  }

  // ------------------------------------------------------------------ 金額・通貨の突合（W8）
  if (plan.decision === "mismatch") {
    return applyMismatch(tx, { input, ev, attempt, invoice, plan, now });
  }

  // ------------------------------------------------------------------ 台帳への追記（W2）
  let ledgerAppended = false;
  const ledgerKind = plan.ledgerKind;

  if (
    plan.ledgerDirection !== null &&
    ledgerKind !== null &&
    plan.ledgerAmountMinor !== null &&
    plan.confidence !== null
  ) {
    const dedupeKey = ledgerDedupeKey({
      providerKey: ev.providerKey,
      kind: ev.kind,
      providerEventId: ev.providerEventId,
      declared: ev.ledgerDedupeKey,
    });
    const inserted = await insertLedgerEntry(tx, {
      invoiceId: invoice.id,
      eventId: invoice.event_id,
      direction: plan.ledgerDirection,
      kind: ledgerKind,
      amountMinor: plan.ledgerAmountMinor,
      confidence: plan.confidence,
      dedupeKey,
      sourcePaymentEventId: input.paymentEventId,
      recordedBy: input.recordedBy,
    });
    if (!inserted) {
      // 既に計上済み。以降の状態更新はスキップする（W2 / check_017）。
      await finishPaymentEvent(tx, input.paymentEventId, "duplicate", now);
      return {
        ...emptyOutcome("duplicate"),
        invoiceId: invoice.id,
        attemptId: attempt.id,
        settlementStatus: invoice.settlement_status as SettlementStatus,
      };
    }
    ledgerAppended = true;
  }

  // ------------------------------------------------------------------ ランクの前進（W3）
  let settlementStatus = invoice.settlement_status as SettlementStatus;
  let rankAdvanced = false;
  if (plan.targetStatus !== null) {
    const advanced = await advanceInvoiceRank(tx, invoice.id, plan.targetStatus, now);
    if (advanced !== null) {
      settlementStatus = advanced;
      rankAdvanced = true;
    }
  }

  // 成功した試行は閉じる（以後に届く expired / canceled で巻き戻らない。check_018）。
  if (plan.attemptStatus !== null) {
    await advanceOpenAttempt(tx, attempt.id, plan.attemptStatus);
  }

  // --------------------------------------------------- 非自動ラベルと要対応フラグの再計算
  // `adjustment`（突合できなかった受領事実）は確度の集合に混ぜない。混ぜると
  // 不一致の入金だけで `confirmation_method='automatic'` に化ける。
  const after = await readLedgerLines(tx, invoice.id);
  const confirmationMethod = deriveConfirmationMethod(
    after.filter((line) => line.kind !== "adjustment").map((line) => line.confidence),
  );

  const paidAfterVoid = plan.outboxKinds.includes("paid_after_void");
  const balanceAfter = ledgerBalanceMinor(after);
  const overpaid =
    plan.outboxKinds.includes("overpay_alert") || isOverpaid(balanceAfter, invoice.amount_minor);
  const needsAttention = invoice.needs_attention || paidAfterVoid || overpaid;

  await tx`
    UPDATE invoice
    SET auto_detected = auto_detected OR ${plan.autoDetected},
        confirmation_method = ${persistedConfirmationMethod(confirmationMethod)},
        needs_attention = ${needsAttention}
    WHERE id = ${invoice.id}
  `;

  if (paidAfterVoid) {
    outboxKinds.push("paid_after_void");
    await enqueueOutbox(tx, {
      kind: "paid_after_void",
      payload: {
        invoiceId: invoice.id,
        eventId: invoice.event_id,
        providerKey: ev.providerKey,
        externalRef: ev.externalRef,
        amountMinor: ev.money?.amountMinor ?? null,
      },
      runAfter: now,
    });
  }
  if (overpaid) {
    outboxKinds.push("overpay_alert");
    await enqueueOutbox(tx, {
      kind: "overpay_alert",
      payload: {
        invoiceId: invoice.id,
        eventId: invoice.event_id,
        balanceMinor: balanceAfter,
        invoiceAmountMinor: invoice.amount_minor,
      },
      runAfter: now,
    });
  }
  if (ev.kind === "disputed") {
    outboxKinds.push("dispute_alert");
    await enqueueOutbox(tx, {
      kind: "dispute_alert",
      payload: {
        invoiceId: invoice.id,
        eventId: invoice.event_id,
        providerKey: ev.providerKey,
        externalRef: ev.externalRef,
      },
      runAfter: now,
    });
  }

  await appendAuditLog(tx, {
    actorType: actorTypeFor(input.ingestionSource),
    action: "ledger.apply",
    targetType: "invoice",
    targetId: invoice.id,
    beforeRank: invoice.settlement_rank,
    afterRank: rankOf(settlementStatus),
    amountMinor: ev.money?.amountMinor ?? null,
    providerKey: ev.providerKey,
    externalRef: ev.externalRef,
    requestId: input.requestId,
    detail: {
      kind: ev.kind,
      applyResult: "applied",
      ledgerKind: ledgerKind ?? null,
      needsAttention,
      confirmationMethod,
    },
    now,
  });
  await finishPaymentEvent(tx, input.paymentEventId, "applied", now);

  return {
    result: "applied",
    invoiceId: invoice.id,
    attemptId: attempt.id,
    settlementStatus,
    rankAdvanced,
    ledgerAppended,
    ledgerKind,
    needsAttention,
    confirmationMethod,
    outboxKinds,
  };
}

// ============================================================================
// 内部
// ============================================================================

interface MismatchArgs {
  readonly input: ApplyToLedgerInput;
  readonly ev: NormalizedEvent;
  readonly attempt: PaymentAttemptRow;
  readonly invoice: InvoiceRow;
  readonly plan: ApplyPlan;
  readonly now: Date;
}

/**
 * 金額・通貨の不一致（check_023）。
 * 受領事実は `adjustment` として残し、**ランクは前進させず** `needs_attention` を立てる。
 */
async function applyMismatch(
  tx: postgres.TransactionSql,
  args: MismatchArgs,
): Promise<ApplyOutcome> {
  const { input, ev, attempt, invoice, plan, now } = args;
  const direction: LedgerDirection = plan.ledgerDirection ?? "credit";
  const amountMinor = plan.ledgerAmountMinor ?? 0;
  const confidence: LedgerConfidence = plan.confidence ?? "provider_verified";

  let ledgerAppended = false;
  if (amountMinor > 0) {
    const dedupeKey = ledgerDedupeKey({
      providerKey: ev.providerKey,
      kind: ev.kind,
      providerEventId: ev.providerEventId,
      declared: ev.ledgerDedupeKey,
    });
    ledgerAppended = await insertLedgerEntry(tx, {
      invoiceId: invoice.id,
      eventId: invoice.event_id,
      direction,
      kind: "adjustment",
      amountMinor,
      confidence,
      dedupeKey,
      sourcePaymentEventId: input.paymentEventId,
      recordedBy: input.recordedBy,
    });
  }

  await tx`UPDATE invoice SET needs_attention = true WHERE id = ${invoice.id}`;
  await enqueueOutbox(tx, {
    kind: "mismatch_alert",
    payload: {
      invoiceId: invoice.id,
      eventId: invoice.event_id,
      providerKey: ev.providerKey,
      externalRef: ev.externalRef,
      expectedAmountMinor: attempt.amountMinor,
      expectedCurrency: attempt.currency,
      observedAmountMinor: ev.money?.amountMinor ?? null,
      observedCurrency: ev.money?.currency ?? null,
    },
    runAfter: now,
  });
  await appendAuditLog(tx, {
    actorType: actorTypeFor(input.ingestionSource),
    action: "ledger.apply.mismatch",
    targetType: "invoice",
    targetId: invoice.id,
    beforeRank: invoice.settlement_rank,
    afterRank: invoice.settlement_rank,
    amountMinor: ev.money?.amountMinor ?? null,
    providerKey: ev.providerKey,
    externalRef: ev.externalRef,
    requestId: input.requestId,
    detail: {
      kind: ev.kind,
      applyResult: "mismatch",
      expectedAmountMinor: attempt.amountMinor,
      ledgerAppended,
    },
    now,
  });
  await finishPaymentEvent(tx, input.paymentEventId, "mismatch", now);

  return {
    result: "mismatch",
    invoiceId: invoice.id,
    attemptId: attempt.id,
    settlementStatus: invoice.settlement_status as SettlementStatus,
    rankAdvanced: false,
    ledgerAppended,
    ledgerKind: ledgerAppended ? "adjustment" : null,
    needsAttention: true,
    confirmationMethod: null,
    outboxKinds: ["mismatch_alert"],
  };
}

/** 突合基準は `payment_attempt.amount_minor` と `payment_attempt.currency`（§9）。 */
function amountMatchesAttempt(ev: NormalizedEvent, attempt: PaymentAttemptRow): boolean {
  if (ev.money === null) return false;
  return ev.money.amountMinor === attempt.amountMinor && ev.money.currency === attempt.currency;
}

interface InsertLedgerArgs {
  readonly invoiceId: string;
  readonly eventId: string;
  readonly direction: LedgerDirection;
  readonly kind: LedgerKind;
  readonly amountMinor: number;
  readonly confidence: LedgerConfidence;
  readonly dedupeKey: string;
  readonly sourcePaymentEventId: string | null;
  readonly recordedBy: string;
}

/** 追記。`false` は既に同じ `dedupe_key` が計上済みという意味（W2）。 */
async function insertLedgerEntry(
  tx: postgres.TransactionSql,
  args: InsertLedgerArgs,
): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO ledger_entry (invoice_id, event_id, direction, kind, amount_minor,
                              confidence, dedupe_key, source_payment_event_id, recorded_by)
    VALUES (${args.invoiceId}, ${args.eventId}, ${args.direction}, ${args.kind},
            ${args.amountMinor}, ${args.confidence}, ${args.dedupeKey},
            ${args.sourcePaymentEventId}::bigint,
            ${args.recordedBy})
    ON CONFLICT (invoice_id, dedupe_key) DO NOTHING
    RETURNING id
  `;
  return rows.length === 1;
}

/**
 * ランクの前進（W3）。`WHERE settlement_rank < $new` を外さない。
 * 前進しなかったら `null`（後発の逆順イベントは請求を動かさない。check_018）。
 */
async function advanceInvoiceRank(
  tx: postgres.TransactionSql,
  invoiceId: string,
  target: SettlementStatus,
  now: Date,
): Promise<SettlementStatus | null> {
  const targetRank = rankOf(target);
  const rows = await tx<{ settlement_status: string }[]>`
    UPDATE invoice
    SET settlement_status = ${target},
        paid_at = COALESCE(paid_at, CASE WHEN ${targetRank}::int >= 40 THEN ${now} END)
    WHERE id = ${invoiceId} AND settlement_rank < ${targetRank}
    RETURNING settlement_status
  `;
  const row = rows[0];
  return row === undefined ? null : (row.settlement_status as SettlementStatus);
}

async function finishPaymentEvent(
  tx: postgres.TransactionSql,
  paymentEventId: string | null,
  result: ApplyResult,
  now: Date,
): Promise<void> {
  if (paymentEventId === null) return;
  await setPaymentEventResult(tx, paymentEventId, result, now);
}

function actorTypeFor(source: IngestionSource): "webhook" | "system" {
  return source === "webhook" ? "webhook" : "system";
}

function emptyOutcome(result: ApplyResult): ApplyOutcome {
  return {
    result,
    invoiceId: null,
    attemptId: null,
    settlementStatus: null,
    rankAdvanced: false,
    ledgerAppended: false,
    ledgerKind: null,
    needsAttention: false,
    confirmationMethod: null,
    outboxKinds: [],
  };
}
