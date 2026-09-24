/**
 * `planApply`（`src/lib/ledger/apply.ts`）の単体テスト（check_094 / check_021 / check_023）。
 *
 * `planApply` は DB に触れない純関数で、§9「`applyToLedger` の不変条件」そのものである。
 * 全遷移 × 全種別をここで網羅し、DB を伴う実行側は
 * `tests/integration/webhook-route.test.ts` と `tests/contract/**` が押さえる。
 *
 * `npm run test:unit` は CI で Postgres 無しに走る（`.github/workflows/gate.yml`）ので、
 * このファイルは接続を一切持たない。
 */

import { describe, expect, it, vi } from "vitest";

import { SETTLEMENT_STATUSES, rankOf, type SettlementStatus } from "@/lib/ledger/rank";
import type { PaymentEventKind } from "@/lib/payments/types";

vi.mock("server-only", () => ({}));

const { planApply } = await import("@/lib/ledger/apply");

type PlanInput = Parameters<typeof planApply>[0];

const ALL_KINDS: readonly PaymentEventKind[] = [
  "authorized",
  "succeeded",
  "failed",
  "canceled",
  "expired",
  "refunded",
  "refund_pending",
  "refund_failed",
  "disputed",
  "dispute_resolved",
  "unknown",
];

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    kind: "succeeded",
    trust: "verified",
    ingestionSource: "webhook",
    eventAmountMinor: 3000,
    eventCurrency: "JPY",
    attemptAmountMinor: 3000,
    attemptCurrency: "JPY",
    invoiceAmountMinor: 3000,
    invoiceRank: rankOf("unpaid"),
    lifecycleState: "active",
    ledgerBalanceBeforeMinor: 0,
    ...overrides,
  };
}

describe("planApply — 全遷移 × 全種別", () => {
  it("どの状態 × どの種別でもランクは後退しない（W3）", () => {
    for (const status of SETTLEMENT_STATUSES) {
      for (const kind of ALL_KINDS) {
        const plan = planApply(input({ kind, invoiceRank: rankOf(status) }));
        if (plan.targetStatus === null) {
          expect(plan.rankAdvances).toBe(false);
          continue;
        }
        if (plan.rankAdvances) {
          expect(rankOf(plan.targetStatus)).toBeGreaterThan(rankOf(status));
        } else {
          expect(rankOf(plan.targetStatus)).toBeLessThanOrEqual(rankOf(status));
        }
      }
    }
  });

  it("全 status に到達できる（到達性）", () => {
    const reachable = new Set<SettlementStatus>(["unpaid"]);
    for (const kind of ALL_KINDS) {
      const plan = planApply(input({ kind, invoiceRank: rankOf("unpaid") }));
      if (plan.targetStatus !== null && plan.rankAdvances) reachable.add(plan.targetStatus);
    }
    expect([...reachable].sort()).toEqual([...SETTLEMENT_STATUSES].sort());
  });
});

describe("planApply — 順序逆転（check_018）", () => {
  it("paid に expired が届いてもランクは動かず、台帳も増えない", () => {
    const plan = planApply({
      ...input({ kind: "expired", invoiceRank: rankOf("paid") }),
      eventAmountMinor: null,
      eventCurrency: null,
    });
    expect(plan.decision).toBe("attempt_only");
    expect(plan.rankAdvances).toBe(false);
    expect(plan.ledgerKind).toBeNull();
    expect(plan.attemptStatus).toBe("expired");
  });

  it("paid に succeeded が再度届いてもランクは進まない（同値は前進ではない）", () => {
    const plan = planApply(input({ invoiceRank: rankOf("paid") }));
    expect(plan.targetStatus).toBe("paid");
    expect(plan.rankAdvances).toBe(false);
  });
});

describe("planApply — 金額不一致（check_023）", () => {
  it("突合基準（payment_attempt.amount_minor）と違う金額は adjustment 1 件・rank 不変・要対応", () => {
    const plan = planApply(input({ eventAmountMinor: 2500 }));
    expect(plan.decision).toBe("mismatch");
    expect(plan.ledgerKind).toBe("adjustment");
    expect(plan.ledgerAmountMinor).toBe(2500);
    expect(plan.rankAdvances).toBe(false);
    expect(plan.targetStatus).toBeNull();
    expect(plan.needsAttention).toBe(true);
    expect(plan.outboxKinds).toEqual(["mismatch_alert"]);
  });

  it("突合の基準は invoice ではなく attempt である", () => {
    // 請求額 5000・提示額 3000 の試行に 3000 が届く → 一致（mismatch にしない）。
    const plan = planApply(
      input({ invoiceAmountMinor: 5000, attemptAmountMinor: 3000, eventAmountMinor: 3000 }),
    );
    expect(plan.decision).toBe("apply");
    expect(plan.ledgerKind).toBe("payment");
  });

  it("通貨が違えば金額が同じでも不一致", () => {
    const plan = planApply(input({ eventCurrency: "USD" }));
    expect(plan.decision).toBe("mismatch");
  });

  it("金額を伴う種別なのに金額が無いイベントは不一致として扱う", () => {
    const plan = planApply(input({ eventAmountMinor: null, eventCurrency: null }));
    expect(plan.decision).toBe("mismatch");
    // 金額が無いので台帳行は作れない。
    expect(plan.ledgerAmountMinor).toBeNull();
  });
});

describe("planApply — 取消後入金（check_021）", () => {
  it("void 済みでも前進させ、要対応と paid_after_void を立てる", () => {
    const plan = planApply(input({ lifecycleState: "void" }));
    expect(plan.decision).toBe("apply");
    expect(plan.targetStatus).toBe("paid");
    expect(plan.rankAdvances).toBe(true);
    expect(plan.needsAttention).toBe(true);
    expect(plan.outboxKinds).toContain("paid_after_void");
  });
});

describe("planApply — 二重払い（台帳残高 > 請求額）", () => {
  it("残高が請求額を超える入金は overpay として積む", () => {
    const plan = planApply(input({ ledgerBalanceBeforeMinor: 3000, invoiceRank: rankOf("paid") }));
    expect(plan.ledgerKind).toBe("overpay");
    expect(plan.needsAttention).toBe(true);
    expect(plan.outboxKinds).toContain("overpay_alert");
    // 状態は paid のまま（前進しない）。
    expect(plan.rankAdvances).toBe(false);
  });

  it("残高が請求額ちょうどに収まる入金は payment のまま", () => {
    const plan = planApply(input({ ledgerBalanceBeforeMinor: 0 }));
    expect(plan.ledgerKind).toBe("payment");
    expect(plan.needsAttention).toBe(false);
    expect(plan.outboxKinds).toEqual([]);
  });
});

describe("planApply — 紛争（check_096）", () => {
  it("disputed は charged_back へ前進し、chargeback の debit を積む", () => {
    const plan = planApply(input({ kind: "disputed", invoiceRank: rankOf("paid") }));
    expect(plan.targetStatus).toBe("charged_back");
    expect(plan.rankAdvances).toBe(true);
    expect(plan.ledgerKind).toBe("chargeback");
    expect(plan.ledgerDirection).toBe("debit");
    expect(plan.outboxKinds).toContain("dispute_alert");
  });

  it("dispute_resolved はランクを戻さず、chargeback_reversal を積むだけ", () => {
    const plan = planApply(input({ kind: "dispute_resolved", invoiceRank: rankOf("charged_back") }));
    expect(plan.targetStatus).toBeNull();
    expect(plan.rankAdvances).toBe(false);
    expect(plan.ledgerKind).toBe("chargeback_reversal");
    expect(plan.ledgerDirection).toBe("credit");
  });
});

describe("planApply — 確度と非自動ラベル", () => {
  it("trust='unverified' は適用せず保留にする（§3-3 の再照会待ち）", () => {
    const plan = planApply(input({ trust: "unverified" }));
    expect(plan.decision).toBe("hold");
    expect(plan.ledgerKind).toBeNull();
    expect(plan.targetStatus).toBeNull();
  });

  it("trust ごとに confidence が決まる", () => {
    expect(planApply(input({ trust: "verified" })).confidence).toBe("provider_verified");
    expect(planApply(input({ trust: "reverified" })).confidence).toBe("provider_polled");
    expect(planApply(input({ trust: "attested" })).confidence).toBe("organizer_attested");
  });

  it("ingestion_source='manual' のときだけ auto_detected を立てない", () => {
    expect(planApply(input({ ingestionSource: "manual" })).autoDetected).toBe(false);
    expect(planApply(input({ ingestionSource: "webhook" })).autoDetected).toBe(true);
    expect(planApply(input({ ingestionSource: "poll" })).autoDetected).toBe(true);
    expect(planApply(input({ ingestionSource: "bank" })).autoDetected).toBe(true);
  });
});
