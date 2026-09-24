import { test, expect, type Page } from "@playwright/test";

/**
 * check_028: 320 / 375 / 414px で横スクロールが出ない（`scrollWidth <= clientWidth`）。
 *
 * 対象は `/onboarding`（O-0）と、`liff.isInClient()=false` のときの共通フォールバック
 * （`StateView` の `outside_line`）。どちらも **LIFF 起動やセッションを必要とせず実ブラウザで
 * 確実に到達できる**画面である。
 *
 * ★ 「名簿 20 名超でも 1 行 1 参加者」（check_028 のもう一方の要件）は、参加者一覧画面
 *   （`/events/:id/participants`）が幹事のセッションと `GET /api/events/:id/participants`
 *   を要求するため、本タスクの実行時点では検証できない。理由は 2 つ重なっている:
 *     1. `@line/liff-mock` の既定値（`isInClient: false`）を上書きする経路がアプリの外に
 *        無く、`bootLiff()` が `ready` に到達しない（`tests/e2e/share.spec.ts` / `outside-
 *        line.spec.ts` の docstring で確認済み）。
 *     2. たとえセッションを直接発行しても、`createVerifiedDbClient()` 経由の実ルートは
 *        `docs/concerns/task_022.md` に記録した timestamptz の既知の不具合で 500 になる
 *        （本タスクで実測）。
 *   `docs/concerns/task_022.md` に deferred として記録する。
 */

const WIDTHS = [320, 375, 414] as const;

async function assertNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `scrollWidth (${overflow.scrollWidth}) must not exceed clientWidth (${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

for (const width of WIDTHS) {
  test(`/onboarding は ${width}px 幅で横スクロールしない`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "集金のはじめ方を選ぶ" })).toBeVisible();
    await assertNoHorizontalScroll(page);
  });
}

for (const width of WIDTHS) {
  test(`outside_line フォールバック（/events/new）は ${width}px 幅で横スクロールしない`, async ({
    page,
    baseURL,
  }) => {
    void baseURL;
    await page.setViewportSize({ width, height: 800 });
    // 127.0.0.1 は Next.js dev サーバーの allowedDevOrigins 未設定でブロックされる
    // （tests/e2e/share.spec.ts / outside-line.spec.ts の docstring）。
    await page.goto(`http://localhost:${process.env["PLAYWRIGHT_PORT"] ?? "3100"}/events/new`);
    await expect(page.getByRole("link", { name: "LINE アプリで開く" })).toBeVisible();
    await assertNoHorizontalScroll(page);
  });
}
