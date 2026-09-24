// @vitest-environment jsdom

/**
 * `src/components/FeeEstimate.tsx`（O-3 / check_080）。
 *
 * 検査するのは 2 点。
 *   1. 集金総額・手数料・受取見込額・入金予定時期のすべてが「推定」表記で描画され、
 *      確定値（率・金額を断定した表現）を出さないこと。
 *   2. 同意チェックが入るまで送信ボタンが disabled のままであること。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeeEstimate } from "@/components/FeeEstimate";

afterEach(() => {
  cleanup();
});

describe("check_080: 推定表記", () => {
  it("集金総額・手数料・受取見込額・入金予定時期のラベルすべてに『推定』が付く", () => {
    render(
      <FeeEstimate providerKey="manual_confirm" defaultAmountMinor={3000} onConfirm={() => {}} />,
    );

    expect(screen.getByText("集金総額（推定）")).toBeInTheDocument();
    expect(screen.getByText("手数料（推定）")).toBeInTheDocument();
    expect(screen.getByText("受取見込額（推定）")).toBeInTheDocument();
    expect(screen.getByText("入金予定時期（推定）")).toBeInTheDocument();
  });

  it("手数料に確定値（率・金額の断定表現）を出さない。定性文言のみ", () => {
    render(
      <FeeEstimate providerKey="manual_confirm" defaultAmountMinor={3000} onConfirm={() => {}} />,
    );

    const dl = screen.getByText("手数料（推定）").closest("div");
    expect(dl).not.toBeNull();
    const feeText = dl?.textContent ?? "";
    // 「手数料」の近くに具体的な数字（%・円）を置かない（docs/wording-policy.md W-FEE-FIXED）。
    expect(feeText).not.toMatch(/[0-9０-９]+\s*[%％]/);
    expect(feeText).not.toMatch(/[0-9０-９]+\s*円/);
    expect(feeText).toMatch(/手数料なし/);
  });

  it("金額未入力（defaultAmountMinor=null）でも確定値を捏造せず『未定』と表示する", () => {
    render(<FeeEstimate providerKey="manual_confirm" defaultAmountMinor={null} onConfirm={() => {}} />);

    const totalDd = screen.getByText("集金総額（推定）").closest("div");
    expect(totalDd?.textContent).toMatch(/未定/);
  });
});

describe("同意チェックと送信ボタン", () => {
  it("未チェックでは送信ボタンが disabled で、onConfirm は呼ばれない", () => {
    const onConfirm = vi.fn();
    render(<FeeEstimate providerKey="manual_confirm" defaultAmountMinor={3000} onConfirm={onConfirm} />);

    const button = screen.getByRole("button", { name: /この内容でイベントを作成する/ });
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("チェックを入れると送信ボタンが有効になり、押すと onConfirm が呼ばれる", () => {
    const onConfirm = vi.fn();
    render(<FeeEstimate providerKey="manual_confirm" defaultAmountMinor={3000} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole("checkbox"));
    const button = screen.getByRole("button", { name: /この内容でイベントを作成する/ });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("submitting=true のときは、チェック済みでも送信ボタンが disabled", () => {
    render(
      <FeeEstimate
        providerKey="manual_confirm"
        defaultAmountMinor={3000}
        onConfirm={() => {}}
        submitting={true}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox"));
    const button = screen.getByRole("button", { name: /この内容でイベントを作成する/ });
    expect(button).toBeDisabled();
  });
});
