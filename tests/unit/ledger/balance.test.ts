/**
 * `src/lib/ledger/balance.ts` の単体テスト（check_094）。
 *
 * - 二重払いの検知は試行の件数ではなく**台帳残高 > 請求額**
 * - `confirmation_method` は `confidence` の集合から導出し、自動と手動が混ざれば `mixed`
 * - `mixed` は DB に保存できないので、保存値は**非自動側**へ倒す（バッジを消さない）
 */

import { describe, expect, it } from "vitest";

import {
  deriveConfirmationMethod,
  isAutomaticConfidence,
  isOverpaid,
  ledgerBalanceMinor,
  persistedConfirmationMethod,
  type LedgerLine,
} from "@/lib/ledger/balance";

function line(partial: Partial<LedgerLine>): LedgerLine {
  return {
    direction: "credit",
    kind: "payment",
    amountMinor: 3000,
    confidence: "provider_verified",
    ...partial,
  };
}

describe("ledgerBalanceMinor", () => {
  it("credit − debit", () => {
    expect(ledgerBalanceMinor([])).toBe(0);
    expect(ledgerBalanceMinor([line({})])).toBe(3000);
    expect(
      ledgerBalanceMinor([line({}), line({ direction: "debit", kind: "refund" })]),
    ).toBe(0);
  });

  it("adjustment（突合できなかった受領事実）は残高に数えない", () => {
    expect(ledgerBalanceMinor([line({ kind: "adjustment", amountMinor: 2500 })])).toBe(0);
    expect(
      ledgerBalanceMinor([line({}), line({ kind: "adjustment", amountMinor: 2500 })]),
    ).toBe(3000);
  });

  it("chargeback は debit として残高を減らす", () => {
    expect(
      ledgerBalanceMinor([line({}), line({ direction: "debit", kind: "chargeback" })]),
    ).toBe(0);
  });
});

describe("isOverpaid", () => {
  it("残高が請求額を超えたときだけ true（試行の件数は見ない）", () => {
    expect(isOverpaid(3000, 3000)).toBe(false);
    expect(isOverpaid(2999, 3000)).toBe(false);
    expect(isOverpaid(6000, 3000)).toBe(true);
  });
});

describe("deriveConfirmationMethod", () => {
  it("自動だけなら automatic", () => {
    expect(deriveConfirmationMethod(["provider_verified"])).toBe("automatic");
    expect(deriveConfirmationMethod(["provider_polled", "bank_matched"])).toBe("automatic");
  });

  it("手動だけなら manual_by_organizer", () => {
    expect(deriveConfirmationMethod(["organizer_attested"])).toBe("manual_by_organizer");
  });

  it("混在は mixed（check_094: バッジが消えない）", () => {
    expect(deriveConfirmationMethod(["provider_verified", "organizer_attested"])).toBe("mixed");
  });

  it("台帳が空なら非自動側の既定に倒す", () => {
    expect(deriveConfirmationMethod([])).toBe("manual_by_organizer");
  });

  it("organizer_attested だけが手動である", () => {
    expect(isAutomaticConfidence("provider_verified")).toBe(true);
    expect(isAutomaticConfidence("provider_polled")).toBe(true);
    expect(isAutomaticConfidence("bank_matched")).toBe(true);
    expect(isAutomaticConfidence("organizer_attested")).toBe(false);
  });
});

describe("persistedConfirmationMethod", () => {
  it("mixed は非自動側に倒す（DB の CHECK は 2 値しか持たない）", () => {
    expect(persistedConfirmationMethod("mixed")).toBe("manual_by_organizer");
    expect(persistedConfirmationMethod("automatic")).toBe("automatic");
    expect(persistedConfirmationMethod("manual_by_organizer")).toBe("manual_by_organizer");
  });
});
