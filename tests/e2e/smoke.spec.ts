import { test, expect } from "@playwright/test";

// task_003 の雛形。実体（LIFF 起動フロー・claim・決済導線など）は task_022 が追加する。
test("トップページが開く", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("cashapp");
});
