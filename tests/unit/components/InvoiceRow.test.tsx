// @vitest-environment jsdom

/**
 * `src/components/InvoiceRow.tsx`（O-4 / 「非自動ラベルの 8 層」②幹事画面のバッジ）。
 *
 * check_031: `autoDetected=false` の行のスナップショットにバッジ要素が存在し、
 * 消すとスナップショットが失敗すること。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { InvoiceRow } from "@/components/InvoiceRow";

afterEach(() => {
  cleanup();
});

describe("非自動バッジ（check_031）", () => {
  it("autoDetected=false の行は非自動バッジを描画する（スナップショット固定）", () => {
    const { container } = render(
      <ul>
        <InvoiceRow
          displayLabel="山田"
          amountMinor={3000}
          status="paid"
          autoDetected={false}
          confirmationMethod="manual_by_organizer"
        />
      </ul>,
    );

    expect(screen.getByTestId("non-auto-badge")).toBeInTheDocument();
    expect(container).toMatchSnapshot();
  });

  it("autoDetected=false の行は status を問わず非自動バッジを出す", () => {
    render(
      <ul>
        <InvoiceRow
          displayLabel="鈴木"
          amountMinor={null}
          status="unpaid"
          autoDetected={false}
          confirmationMethod={null}
        />
      </ul>,
    );

    expect(screen.getByTestId("non-auto-badge")).toBeInTheDocument();
  });

  it("autoDetected=true の行は非自動バッジを出さない", () => {
    render(
      <ul>
        <InvoiceRow
          displayLabel="佐藤"
          amountMinor={5000}
          status="paid"
          autoDetected={true}
          confirmationMethod="automatic"
        />
      </ul>,
    );

    expect(screen.queryByTestId("non-auto-badge")).not.toBeInTheDocument();
  });
});

describe("状態の三重表現（色＋テキスト＋アイコン）", () => {
  it("各状態が data-tone と日本語ラベルの両方を持つ", () => {
    const cases: readonly [
      "unpaid" | "pending_checkout" | "paid" | "canceled",
      string,
    ][] = [
      ["unpaid", "未払い"],
      ["pending_checkout", "手続き中"],
      ["paid", "支払済み"],
      ["canceled", "取消"],
    ];

    for (const [status, expectedText] of cases) {
      cleanup();
      const { container } = render(
        <ul>
          <InvoiceRow
            displayLabel="テスト"
            amountMinor={1000}
            status={status}
            autoDetected={true}
            confirmationMethod={status === "paid" ? "automatic" : null}
          />
        </ul>,
      );
      const row = container.querySelector(".invoice-row");
      expect(row).not.toBeNull();
      expect(row?.getAttribute("data-tone")).toBeTruthy();
      expect(screen.getByText(new RegExp(expectedText))).toBeInTheDocument();
      // アイコン: aria-hidden の svg が status 用に必ず 1 つ以上存在する。
      expect(container.querySelectorAll("svg[aria-hidden='true']").length).toBeGreaterThan(0);
    }
  });
});

describe("手動確認の許可文言", () => {
  it("支払済み・手動確認の行は禁止語ではなく許可文言『自動照合ではありません』を使う", () => {
    render(
      <ul>
        <InvoiceRow
          displayLabel="高橋"
          amountMinor={2000}
          status="paid"
          autoDetected={false}
          confirmationMethod="manual_by_organizer"
        />
      </ul>,
    );

    expect(screen.getAllByText(/自動照合ではありません/).length).toBeGreaterThan(0);
  });
});

describe("金額未設定・表示名未設定のフォールバック", () => {
  it("amountMinor が null なら『金額未設定』、displayLabel が null なら代替文言を出す", () => {
    render(
      <ul>
        <InvoiceRow
          displayLabel={null}
          amountMinor={null}
          status="unpaid"
          autoDetected={true}
          confirmationMethod={null}
        />
      </ul>,
    );

    expect(screen.getByText("金額未設定")).toBeInTheDocument();
    expect(screen.getByText("（表示名未設定）")).toBeInTheDocument();
  });
});

describe("要対応表示", () => {
  it("needsAttention=true のときだけ『要対応』を出す", () => {
    const { rerender } = render(
      <ul>
        <InvoiceRow
          displayLabel="田中"
          amountMinor={1000}
          status="unpaid"
          autoDetected={true}
          confirmationMethod={null}
          needsAttention={true}
        />
      </ul>,
    );
    expect(screen.getByText("要対応")).toBeInTheDocument();

    rerender(
      <ul>
        <InvoiceRow
          displayLabel="田中"
          amountMinor={1000}
          status="unpaid"
          autoDetected={true}
          confirmationMethod={null}
          needsAttention={false}
        />
      </ul>,
    );
    expect(screen.queryByText("要対応")).not.toBeInTheDocument();
  });
});
