// @vitest-environment jsdom

/**
 * `src/components/SummaryBar.tsx`（O-4 サマリ / 「非自動ラベルの 8 層」④サマリ内訳）。
 *
 * check_034: 自動 1・手動 1・申告 1（幹事確認待ち）の状態で
 * 「支払済み 2/4（自動 1 / 手動 1）」と「幹事確認待ち 1」が出て、合算値のみの表示が無いこと。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SummaryBar } from "@/components/SummaryBar";

afterEach(() => {
  cleanup();
});

describe("check_034: 自動 1・手動 1・申告 1 の状態", () => {
  it("『支払済み 2/4（自動 1 / 手動 1）』と『幹事確認待ち 1』の両方が出る", () => {
    render(
      <SummaryBar
        participantCount={4}
        paidAutomaticCount={1}
        paidManualCount={1}
        unpaidCount={1}
        selfReportedCount={1}
        needsAttentionCount={0}
        feeMinorEstimate={0}
        netMinorEstimate={4000}
      />,
    );

    expect(screen.getByText(/支払済み\s*2\/4/)).toBeInTheDocument();
    expect(screen.getByText(/自動\s*1/)).toBeInTheDocument();
    expect(screen.getByText(/手動\s*1/)).toBeInTheDocument();
    expect(screen.getByText(/幹事確認待ち\s*1/)).toBeInTheDocument();
  });

  it("合算値のみの表示（内訳の無い『支払済み 2』単独）は無い", () => {
    const { container } = render(
      <SummaryBar
        participantCount={4}
        paidAutomaticCount={1}
        paidManualCount={1}
        unpaidCount={1}
        selfReportedCount={1}
        needsAttentionCount={0}
        feeMinorEstimate={0}
        netMinorEstimate={4000}
      />,
    );

    const headline = container.querySelector(".summary-bar__headline");
    expect(headline).not.toBeNull();
    // 見出し行そのものに内訳（自動 / 手動）の文字列が同居していること。
    expect(headline?.textContent).toMatch(/自動/);
    expect(headline?.textContent).toMatch(/手動/);
  });
});

describe("要対応・混在・手数料と受取見込額の並記", () => {
  it("needsAttentionCount=0 のときは要対応行を出さない", () => {
    render(
      <SummaryBar
        participantCount={2}
        paidAutomaticCount={0}
        paidManualCount={0}
        unpaidCount={2}
        needsAttentionCount={0}
        feeMinorEstimate={0}
        netMinorEstimate={0}
      />,
    );
    expect(screen.queryByText(/要対応/)).not.toBeInTheDocument();
  });

  it("needsAttentionCount>0 のときは要対応件数を出す", () => {
    render(
      <SummaryBar
        participantCount={2}
        paidAutomaticCount={1}
        paidManualCount={0}
        unpaidCount={1}
        needsAttentionCount={2}
        feeMinorEstimate={0}
        netMinorEstimate={1000}
      />,
    );
    expect(screen.getByText(/要対応\s*2\s*件/)).toBeInTheDocument();
  });

  it("mixedCount>0 のときは『混在』を内訳に含める", () => {
    render(
      <SummaryBar
        participantCount={3}
        paidAutomaticCount={1}
        paidManualCount={1}
        mixedCount={1}
        unpaidCount={0}
        needsAttentionCount={0}
        feeMinorEstimate={0}
        netMinorEstimate={3000}
      />,
    );
    expect(screen.getByText(/混在\s*1/)).toBeInTheDocument();
  });

  it("手数料と受取見込額を並記する（推定表記つき）", () => {
    render(
      <SummaryBar
        participantCount={1}
        paidAutomaticCount={0}
        paidManualCount={0}
        unpaidCount={1}
        needsAttentionCount={0}
        feeMinorEstimate={0}
        netMinorEstimate={3000}
      />,
    );
    expect(screen.getByText(/手数料（推定）/)).toBeInTheDocument();
    expect(screen.getByText(/受取見込額（推定）/)).toBeInTheDocument();
  });

  it("金額が null のときは『未定』と表示し、数値を捏造しない", () => {
    render(
      <SummaryBar
        participantCount={0}
        paidAutomaticCount={0}
        paidManualCount={0}
        unpaidCount={0}
        needsAttentionCount={0}
        feeMinorEstimate={null}
        netMinorEstimate={null}
      />,
    );
    const amountRows = screen.getAllByText(/未定/);
    expect(amountRows.length).toBeGreaterThanOrEqual(2);
  });
});
