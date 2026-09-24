/**
 * `parseDefaultAmountMinor`（O-3 イベント作成・既定金額の入力パース。§8-1 / task_014）。
 *
 * 敵対レビュー GPT F-1（`docs/review-log/task_014.json`）: `既定金額` の input は
 * `type="number"` で、ブラウザは指数表記（"5e2" 等）を妥当な値として受け付ける。修正前は
 * `Number.parseInt(raw, 10)` で文字列の先頭だけを読んでいたため、"5e2" は「5」として静かに
 * 解釈され、ユーザーが「500」のつもりで入力した金額が別の金額として保存され得た。
 */

import { describe, expect, it } from "vitest";

import { parseDefaultAmountMinor } from "@/app/(liff)/events/new/page";

describe("parseDefaultAmountMinor（敵対レビュー GPT F-7）", () => {
  it("指数表記を正しい数値として展開する（5e2 → 500。修正前は 5 になっていた）", () => {
    expect(parseDefaultAmountMinor("5e2")).toBe(500);
  });

  it("小数を含む指数表記でも、結果が整数なら受け付ける（1.5e2 → 150）", () => {
    expect(parseDefaultAmountMinor("1.5e2")).toBe(150);
  });

  it("結果が非整数になる指数表記は null（1e-2 → 0.01）", () => {
    expect(parseDefaultAmountMinor("1e-2")).toBeNull();
  });

  it("桁区切りのカンマは null（修正前の parseInt は先頭の 5 だけを読んでいた）", () => {
    expect(parseDefaultAmountMinor("5,000")).toBeNull();
  });

  it("先頭に数字が無い文字列は null", () => {
    expect(parseDefaultAmountMinor("abc")).toBeNull();
  });

  it("空文字・空白のみは null（未入力）", () => {
    expect(parseDefaultAmountMinor("")).toBeNull();
    expect(parseDefaultAmountMinor("   ")).toBeNull();
  });

  it("通常の整数はそのまま数値になる", () => {
    expect(parseDefaultAmountMinor("3000")).toBe(3000);
    expect(parseDefaultAmountMinor("  3000  ")).toBe(3000);
  });

  it("負の数は Number.isInteger を満たすが、呼び出し側の <input min=1> とは別に値自体は通す", () => {
    // parseDefaultAmountMinor 自身は正負を判定しない（下限は input の min 属性と
    // サーバー側バリデーションの責務）。ここでは「静かに別の値へ化けない」ことだけを保証する。
    expect(parseDefaultAmountMinor("-5")).toBe(-5);
  });
});
