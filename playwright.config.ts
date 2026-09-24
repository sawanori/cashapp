import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.PLAYWRIGHT_PORT ?? "3100";
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;

// Covers both tests/e2e (Playwright + @line/liff-mock, task_022) and
// tests/a11y (axe-core via @axe-core/playwright, task_022). tests/unit and
// tests/security are Vitest's (`*.test.ts`), not Playwright's — the
// `*.spec.ts` naming convention keeps the two runners from picking up each
// other's files.
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Pixel 7"] }, // LINE ミニアプリは LINE アプリ内ブラウザ（縦画面）が主戦場
    },
  ],
  webServer: {
    // No standalone `dev` npm script exists in this repo (out of task_003's
    // scope) — invoke the locally installed Next CLI directly.
    command: `npx next dev -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
