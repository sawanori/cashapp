/**
 * XSS・CSP の統合テスト（check_110 / R-SEC-12）。
 *
 * `tests/unit/security-headers.test.ts`（task_012 所有）が CSP の組み立てそのものを
 * 検査済みなので、ここでは task_022 の視点（実運用で XSS の踏み台になりうる箇所）から
 * 2 つを見る。
 *   1. CSP が実際に `unsafe-inline` / `unsafe-eval` を持ち込んでいないこと（帯域外の
 *      回帰確認。R-SEC-12 の最終防衛線）。
 *   2. **CSV 数式インジェクション（CSV Injection / Formula Injection）**。
 *      `GET /api/events/:id/export.csv`（`src/app/api/events/[id]/export.csv/route.ts`）の
 *      `csvField()` は引用符・カンマ・改行しかエスケープしておらず、セルの先頭が
 *      `=` / `+` / `-` / `@` のとき Excel・Google スプレッドシートがそのセルを**数式として
 *      評価する**。`display_label` は参加者の自己申告（`POST /api/e/request-add` の
 *      `displayLabel`）に由来しうるため、`=HYPERLINK("https://evil.example","click")` の
 *      ような値を名乗る参加者が、幹事が Excel で開いた CSV を通じてコードを実行させられる
 *      （XSS と同じ「信頼境界を越えたスクリプト実行」の帰結を持つ、DOM を経由しない亜種）。
 *      `src/app/api/events/[id]/export.csv/route.ts` は task_022 の files_to_modify に
 *      無いため修正はできない。この検査は現状の防御の有無を固定し、
 *      `docs/concerns/task_022.md` に対応案とともに記録する。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { buildContentSecurityPolicy, buildSecurityHeaders } = await import("@/lib/security-headers");
const { buildCsv, csvField } = await import("@/app/api/events/[id]/export.csv/route");

describe("CSP は unsafe-inline / unsafe-eval を持ち込まない（R-SEC-12）", () => {
  it("script-src が nonce と strict-dynamic のみで、インライン許可・eval 許可を含まない", () => {
    const csp = buildContentSecurityPolicy("test-nonce-value");
    const scriptSrc = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'nonce-test-nonce-value'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("同じ nonce に対して常に同じ CSP 文字列を返す（レスポンスとリクエストヘッダで食い違わない）", () => {
    expect(buildContentSecurityPolicy("abc")).toBe(buildContentSecurityPolicy("abc"));
  });

  it("buildSecurityHeaders は development で HSTS を外し、production では付ける", () => {
    const dev = buildSecurityHeaders({ nonce: "n", appEnv: "development" });
    const prod = buildSecurityHeaders({ nonce: "n", appEnv: "production" });
    expect(dev["Strict-Transport-Security"]).toBeUndefined();
    expect(prod["Strict-Transport-Security"]).toBeDefined();
    expect(dev["X-Content-Type-Options"]).toBe("nosniff");
  });
});

describe("CSV 数式インジェクション（export.csv / O-12）", () => {
  const BASE_ROW = {
    display_label: null as string | null,
    amount_minor: 3000,
    settlement_status: "unpaid",
    auto_detected: null as boolean | null,
    confirmation_method: null as string | null,
  };

  it.each([
    ["=", "=1+1"],
    ["+", "+1+1"],
    ["-", "-1+1"],
    ["@", "@SUM(1)"],
  ])("先頭が %s のセルは、Excel/Sheets に数式として解釈されない形で出力される", (_label, malicious) => {
    // カンマ・引用符・改行を含まない値を選ぶ（csvField は引用符で囲まないので、
    // 出力の 1 列目はこの値そのままになる — 抽出を単純に保つための意図的な選択）。
    //
    // ★ データ行の位置は固定（DISCLAIMER_LINES 3 行 + 空行 1 行 + ヘッダ 1 行 = 5 行目
    // （0-indexed）が 1 行目のデータ）。安全な実装（数式開始文字の前に `'` を前置するなど）
    // に直った後は出力が `malicious` そのままでは無くなるため、`line.startsWith(malicious)`
    // で行を探す方式は「未対策の現状」でしか一致せず、修正後に必ず失敗する
    // （固定インデックスなら現状・修正後のどちらでも同じ行を指せる）。
    const csv = buildCsv("manual_confirm", [{ ...BASE_ROW, display_label: malicious }]);
    const lines = csv.split("\r\n");
    const dataLine = lines[5];
    expect(dataLine, `expected a data row (index 5) in:\n${csv}`).toBeDefined();

    const field = dataLine!.split(",")[0]!;
    // 安全な実装なら、値の内容そのもの（前置文字を除いた部分）は変わらないはず。
    const withoutSafetyPrefix = field.startsWith("'") ? field.slice(1) : field;
    expect(withoutSafetyPrefix).toBe(malicious);
    // 現状 csvField() は数式開始文字をエスケープせず、値を無加工でそのまま通すため、
    // このアサーションは意図的に赤のまま固定する（対応案は docs/concerns/task_022.md #4）。
    // 上の 2 つの expect は矛盾しない: 前者は「値の中身が保たれる」こと、後者は
    // 「出力の先頭が数式開始文字であってはならない」ことを別々に見ているので、
    // 前置文字を足すだけの修正でどちらも同時に満たせる。
    const startsWithFormulaChar = /^[=+\-@]/.test(field);
    expect(
      startsWithFormulaChar,
      "csvField() が数式先頭文字をエスケープしていない（対応案は docs/concerns/task_022.md）",
    ).toBe(false);
  });

  it("参照: 引用符・カンマ・改行は正しく二重引用符で囲まれる（既存の防御は健全）", () => {
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField("plain")).toBe("plain");
  });
});
