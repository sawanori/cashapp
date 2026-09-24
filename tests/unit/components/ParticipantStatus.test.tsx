// @vitest-environment jsdom

/**
 * P-3 の状態表示（`ParticipantStatus`。`src/components/InvoiceRow.tsx`）。
 *
 * done_definition: **申告状態のスナップショットが支払済みと異なる**（check_087 / R-UX-02）。
 * 「幹事が受け取ったと申告」は入金の確定ではないため、色・文言・アイコンのどれも
 * 支払済みと重ねてはならない。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ParticipantStatus,
  type ParticipantViewState,
} from "@/components/InvoiceRow";

vi.mock("server-only", () => ({}));

const { PARTICIPANT_INVOICE_STATES } = await import("@/lib/db/repositories/claims");

afterEach(() => {
  cleanup();
});

function renderState(state: ParticipantViewState): HTMLElement {
  const { container } = render(
    <ParticipantStatus
      state={state}
      amountMinor={3000}
      autoDetected={false}
      confirmationMethod="manual_by_organizer"
    />,
  );
  return container;
}

describe("申告済みと支払済みが同じ見た目にならない（check_087）", () => {
  it("self_reported のスナップショット", () => {
    expect(renderState("self_reported")).toMatchSnapshot();
  });

  it("paid のスナップショット", () => {
    expect(renderState("paid")).toMatchSnapshot();
  });

  it("2 つの状態の描画結果が一致しない", () => {
    const selfReported = renderState("self_reported").innerHTML;
    cleanup();
    const paid = renderState("paid").innerHTML;
    expect(selfReported).not.toBe(paid);
  });

  it("tone（色の手掛かり）も data-state も異なる", () => {
    const selfReported = renderState("self_reported").querySelector(".participant-status");
    cleanup();
    const paid = renderState("paid").querySelector(".participant-status");
    expect(selfReported?.getAttribute("data-tone")).not.toBe(paid?.getAttribute("data-tone"));
    expect(selfReported?.getAttribute("data-state")).toBe("self_reported");
    expect(paid?.getAttribute("data-state")).toBe("paid");
  });

  it("申告済みは許可文言を出し、『支払済み』とは書かない", () => {
    render(
      <ParticipantStatus
        state="self_reported"
        amountMinor={3000}
        autoDetected={false}
        confirmationMethod={null}
      />,
    );
    expect(screen.getByText(/あなたの申告を幹事が確認中です/)).toBeInTheDocument();
    expect(screen.queryByText("支払済み")).not.toBeInTheDocument();
  });
});

describe("状態の三重表現（色＋テキスト＋アイコン）", () => {
  it("すべての状態が data-tone・日本語ラベル・アイコンを持つ", () => {
    for (const state of PARTICIPANT_INVOICE_STATES) {
      cleanup();
      const container = renderState(state);
      const root = container.querySelector(".participant-status");
      expect(root).not.toBeNull();
      expect(root?.getAttribute("data-tone")).toBeTruthy();
      expect(container.querySelectorAll("svg[aria-hidden='true']").length).toBeGreaterThan(0);
      const text = container.querySelector(".participant-status__state-text")?.textContent ?? "";
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe("UI の状態集合とサーバーの状態集合が一致する", () => {
  it("claims.ts の PARTICIPANT_INVOICE_STATES を UI 側の型がすべて受け取れる", () => {
    // 片側にだけ状態が増えると（例: サーバーが返すのに画面が描けない）ここで落ちる。
    const uiStates: readonly ParticipantViewState[] = [
      "awaiting_approval",
      "not_issued",
      "unpaid",
      "pending_checkout",
      "self_reported",
      "paid",
      "expired",
      "voided",
    ];
    expect([...PARTICIPANT_INVOICE_STATES].sort()).toEqual([...uiStates].sort());
  });
});

describe("非自動ラベル（8 層の③参加者画面）", () => {
  it("autoDetected=false なら参加者画面にも非自動の注記を出す", () => {
    render(
      <ParticipantStatus
        state="paid"
        amountMinor={3000}
        autoDetected={false}
        confirmationMethod="manual_by_organizer"
      />,
    );
    expect(screen.getByTestId("participant-non-auto-badge")).toBeInTheDocument();
  });

  it("autoDetected=true なら出さない", () => {
    render(
      <ParticipantStatus
        state="paid"
        amountMinor={3000}
        autoDetected={true}
        confirmationMethod="automatic"
      />,
    );
    expect(screen.queryByTestId("participant-non-auto-badge")).not.toBeInTheDocument();
  });
});

describe("金額未設定", () => {
  it("amountMinor が null なら『金額未設定』を出す", () => {
    render(
      <ParticipantStatus
        state="not_issued"
        amountMinor={null}
        autoDetected={false}
        confirmationMethod={null}
      />,
    );
    expect(screen.getByText("金額未設定")).toBeInTheDocument();
  });
});
