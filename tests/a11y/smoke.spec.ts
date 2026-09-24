import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// task_003 の雛形。実体（O-1〜P-7 全画面、320/375/414px、色+テキスト+アイコンの三重表現の
// 検証など）は task_022 が追加する。
test("トップページに axe-core 違反が無い", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
