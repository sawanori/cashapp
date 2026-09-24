import { test, expect } from "@playwright/test";

/**
 * check_112 の一部: `(web)` の静的法務ページと管理者画面が LINE SDK 無しで描画される。
 *
 * `npm run build:web-only`（`scripts/build-web-only.mjs` / `.github/workflows/
 * gate-web-only.yml`。task_013 所有）は「ビルド成果物に `@line/liff` / `@line/liff-mock` が
 * 混入していないこと」を import グラフの静的走査で担保している。ここでは**実ブラウザで**
 * `(web)` グループのページを開き、LIFF SDK のチャンクが 1 つもネットワーク要求されないこと
 * （静的検査の実行時側の裏付け）と、`@line/liff` を import しないという `(web)/admin`
 * 自身のコメント上の約束が実際の画面として成立していることを確認する。
 *
 * Phase 1 の `(web)` は静的法務ページと管理者画面だけで、幹事・参加者の集金導線の
 * LINE 非依存版は存在しない（ADR-013）。ここではその 2 画面だけを対象にする。
 */

test.use({
  baseURL: `http://localhost:${process.env["PLAYWRIGHT_PORT"] ?? "3100"}`,
});

test("/admin は LIFF SDK のチャンクを 1 つも要求せずに描画される", async ({ page }) => {
  const liffRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/liff-mock|@line\/liff|liff\.line\.me/i.test(url)) {
      liffRequests.push(url);
    }
  });

  await page.goto("/admin");

  // GitHub Personal Access Token を貼る入力欄が描画される（管理者画面の骨格）。
  await expect(page.getByLabel(/GitHub|トークン|Token/i).or(page.locator('input[type="password"], input[type="text"]').first())).toBeVisible();

  // ページ内のどの要素も `data-route-group="web"`（(web) レイアウトの目印）の下にある。
  await expect(page.locator('[data-route-group="web"]')).toBeVisible();

  expect(liffRequests, `unexpected LIFF-related network requests: ${liffRequests.join(", ")}`).toEqual([]);
});

test("(web) レイアウトはスキップリンクと運営者情報欄を持つ（O-13 の骨格）", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.locator(".skip-link")).toHaveText("本文へスキップ");
  // 実値（運営者名・所在地）は PO 未確定のため「準備中」のプレースホルダのまま
  // （docs/concerns/task_021.md #5・本タスクの docs/concerns/task_022.md も参照）。
  await expect(page.getByText(/運営者情報・利用規約・プライバシーポリシー/)).toBeVisible();
});
