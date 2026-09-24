// @vitest-environment jsdom

/**
 * `src/components/StateView.tsx`（§8-3 / R-UX-04 / R-LINE-02）。
 *
 * 検査するのは 3 点。
 *   1. 8 状態すべてが描けること（規約が「全画面で 8 状態」なので、8 未満で通ってはいけない）。
 *   2. **色だけで意味を運んでいない**こと ＝ どの状態にもテキストとアイコンが必ず出る。
 *   3. `outside_line` のフォールバックが「① LINE で開く → ② URL → ③ QR は別端末用」の順であること。
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StateView, VIEW_STATES, type ViewState } from "@/components/StateView";

afterEach(() => {
  cleanup();
});

const PERMANENT_LINK = "https://miniapp.line.me/2000000000-abcd1234";

describe("StateView の 8 状態", () => {
  it("規約どおり 8 状態ちょうどを持つ", () => {
    expect([...VIEW_STATES].sort()).toEqual(
      [
        "auth_unavailable",
        "degraded",
        "empty",
        "error",
        "forbidden",
        "gate_blocked",
        "loading",
        "outside_line",
      ].sort(),
    );
    expect(VIEW_STATES).toHaveLength(8);
  });

  it.each([...VIEW_STATES])("%s: 色・テキスト・アイコンの三重表現になっている", (state) => {
    const { container } = render(<StateView state={state} />);
    const root = container.querySelector(".state-view");

    expect(root, `${state} が描画されていない`).not.toBeNull();
    // ① 色: data-tone が付いている（実際の色はトークン側）。
    expect(root?.getAttribute("data-tone")).toBeTruthy();
    expect(root?.getAttribute("data-state")).toBe(state);
    // ② テキスト: 見出し文が空でない。
    const title = root?.querySelector(".state-view__title");
    expect(title?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    // ③ アイコン: 読み上げからは外し、視覚的な手掛かりとしては必ず出す。
    const icon = root?.querySelector("svg.state-view__icon");
    expect(icon, `${state} にアイコンが無い`).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it.each<[ViewState, string]>([
    ["loading", "status"],
    ["degraded", "status"],
    ["error", "alert"],
    ["forbidden", "alert"],
    ["auth_unavailable", "alert"],
    ["gate_blocked", "alert"],
  ])("%s は role=%s で読み上げに届く", (state, role) => {
    render(<StateView state={state} />);
    expect(screen.getByRole(role)).toBeInTheDocument();
  });

  it("状態ごとに見出し文が異なる（同じ文言を使い回していない）", () => {
    const titles = new Set<string>();
    for (const state of VIEW_STATES) {
      const { container } = render(<StateView state={state} />);
      titles.add(container.querySelector(".state-view__title")?.textContent ?? "");
      cleanup();
    }
    expect(titles.size).toBe(VIEW_STATES.length);
  });
});

describe("outside_line のフォールバック順序（§7-3）", () => {
  it("① LINE で開く → ② URL → ③ QR は別端末用 の順で出る", () => {
    const { container } = render(
      <StateView state="outside_line" permanentLink={PERMANENT_LINK} />,
    );
    const fallback = container.querySelector(".state-view__fallback");
    expect(fallback).not.toBeNull();

    const link = within(fallback as HTMLElement).getByRole("link", { name: /LINE/ });
    expect(link).toHaveAttribute("href", PERMANENT_LINK);

    const text = fallback?.textContent ?? "";
    const openIndex = text.indexOf("LINE アプリで開く");
    const urlIndex = text.indexOf("コピー");
    const qrIndex = text.indexOf("QR");
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(urlIndex).toBeGreaterThan(openIndex);
    expect(qrIndex).toBeGreaterThan(urlIndex);
  });

  it("QR は『別の端末から』の用途であることを明記する（同一端末では読めない）", () => {
    render(<StateView state="outside_line" permanentLink={PERMANENT_LINK} />);
    expect(screen.getByText(/別の端末/)).toBeInTheDocument();
  });

  it("パーマネントリンクが無ければリンクを出さない（押しても何も起きない導線を作らない）", () => {
    const { container } = render(<StateView state="outside_line" />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("outside_line 以外の通常状態ではフォールバック欄を出さない", () => {
    const { container } = render(<StateView state="empty" permanentLink={PERMANENT_LINK} />);
    expect(container.querySelector(".state-view__fallback")).toBeNull();
  });
});

describe("requestId の扱い（§8-3）", () => {
  it("渡されたときだけ不透明 ID として出す", () => {
    render(<StateView state="error" requestId="0123456789abcdef0123456789abcdef" />);
    expect(screen.getByText("0123456789abcdef0123456789abcdef")).toBeInTheDocument();
  });

  it("渡されなければ出さない", () => {
    const { container } = render(<StateView state="error" />);
    expect(container.querySelector(".state-view__request-id")).toBeNull();
  });
});

describe("文言ポリシー（docs/wording-policy.md）", () => {
  const FORBIDDEN = [
    "自動チェック",
    "自動で確認",
    "入金を確認しました",
    "寄付",
    "募金",
    "投げ銭",
    "カンパ",
    "支援",
    "応援",
    "領収書",
    "インボイス",
    "適格請求書",
  ];

  it("どの状態の固定文言にも禁止語が出ない", () => {
    for (const state of VIEW_STATES) {
      const { container } = render(<StateView state={state} permanentLink={PERMANENT_LINK} />);
      const text = container.textContent ?? "";
      for (const word of FORBIDDEN) {
        expect(text, `${state} の文言に禁止語「${word}」が含まれている`).not.toContain(word);
      }
      cleanup();
    }
  });
});
