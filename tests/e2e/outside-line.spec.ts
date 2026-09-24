import { test, expect } from "@playwright/test";

/**
 * check_029: `liff.isInClient()` が false のとき `liff.login()` を呼ばず `outside_line`
 * （『LINE で開く』→ URL コピー → QR の順）が表示される。
 *
 * `tests/e2e/share.spec.ts`（task_016）が `/events/:id/share` で同じ検証を行っているので、
 * ここでは**別の幹事画面**（O-3 イベント作成 `/events/new`）で同じ契約を固定し、
 * 「outside_line のフォールバックは画面ごとの実装ではなく `StateView` 共有部品の契約である」
 * ことを裏付ける（P-11: 画面を作る各タスクに最小 1 本の E2E を持たせる、の task_022 側の担保）。
 *
 * `@line/liff-mock` の既定値は `isInClient: false` で、この値を上書きする経路は
 * アプリ内部の動的 import に閉じておりブラウザ側から到達できない（`docs/vendor-docs/line/
 * liff-sdk.md` §3・share.spec.ts の docstring）。したがってこの e2e が実際に確かめられるのは
 * **LINE アプリの外から開いたときの経路**である。認証済みフェーズの検証は
 * `tests/unit/liff/client.test.ts` が `bootLiff()` の分岐を props/DI で検査している。
 *
 * `127.0.0.1` ではなく `localhost` に接続する（task_016 で発見した既存の穴。
 * `docs/concerns/task_016.md` C-016-1）。
 */

test.use({
  baseURL: `http://localhost:${process.env["PLAYWRIGHT_PORT"] ?? "3100"}`,
});

function isKnownDevServerNoise(text: string): boolean {
  return text.includes("eval() is not supported in this environment") || text.includes("/_next/hmr");
}

test("LINE の外から /events/new を開くと login() を呼ばず outside_line のフォールバックが出る", async ({
  page,
}) => {
  const unexpectedConsoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !isKnownDevServerNoise(msg.text())) {
      unexpectedConsoleErrors.push(msg.text());
    }
  });
  page.on("pageerror", (error) => {
    unexpectedConsoleErrors.push(error.message);
  });

  await page.goto("/events/new");

  await expect(page.getByRole("link", { name: "LINE アプリで開く" })).toBeVisible();
  await expect(page.getByText(/次の URL をコピーして/)).toBeVisible();
  await expect(page.getByText(/別の端末から読み取るとき/)).toBeVisible();

  // イベント作成フォーム（認証後にしか出ない要素）は描画されていない。
  await expect(page.getByRole("button", { name: /作成/ })).toHaveCount(0);

  expect(unexpectedConsoleErrors, `console errors: ${unexpectedConsoleErrors.join("\n")}`).toEqual([]);
});
