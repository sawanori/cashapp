import { test, expect } from "@playwright/test";

/**
 * `src/app/(liff)/events/[id]/share/page.tsx`（O-7 配布 / N8 / task_016）。
 *
 * ★ この画面は他の幹事画面（O-4〜O-6）と同じく `bootLiff()` → `/api/auth/line` →
 *   本体データ取得という順で進む（`src/lib/liff/client.ts`）。`@line/liff-mock` の既定値は
 *   `isInClient: false` で、これを上書きする経路はブラウザ側から到達できない
 *   （プラグインの差し込みはアプリ内部の動的 import に閉じており、`window` に露出しない。
 *   `docs/vendor-docs/line/liff-sdk.md` §3）。したがって liff-mock 有効時、この e2e が
 *   実際に確かめられるのは **LINE アプリの外から開いたときの経路**である
 *   （`outside_line`。認証済みフェーズの `ShareSheet` 描画は `tests/unit/components/
 *   ShareSheet.test.tsx` が props 経由で検査する。フル認証込みの E2E 基盤は task_022 の scope。
 *   premortem P-11 の「画面を作る各タスクに最小 1 本の E2E を持たせる」に対応する）。
 *
 * ★ N8 が求める「shareTargetPicker が無くても URL コピーのフォールバックが必ず出る」ことを、
 *   この画面でも実ブラウザで固定する。`outside_line` の描画は `StateView` が持つ共通実装だが、
 *   **この新しいルート（`/events/:id/share`）でも**同じ 3 導線（① LINE で開く ② URL コピー
 *   ③ QR の案内）が欠けずに出ることを確認する。
 *
 * ★ **`127.0.0.1` ではなく `localhost` に接続する（実測。task_016 で発見した既存の穴）。**
 *   `playwright.config.ts` の既定 `baseURL` は `http://127.0.0.1:<port>` だが、Next.js 16 の
 *   dev サーバーは `allowedDevOrigins` 未設定のとき `127.0.0.1` からの `/_next/*` dev リソース
 *   取得を「オリジン不一致」としてブロックする（サーバーログに `Blocked cross-origin request
 *   to Next.js dev resource /_next/hmr from "127.0.0.1"` と出る）。RSC のクライアント参照解決が
 *   これに依存しているため、ブロックされると**ハイドレーションが永久に終わらず**、
 *   `useEffect` が一度も発火しない（`bootLiff()` は呼ばれすらしない。画面は `loading` のまま
 *   固まる）。`localhost` に向けると同じサーバーが同じ内容を問題なく返す（実機の LINE アプリ内
 *   ブラウザはこの経路を通らないため本番には影響しない）。恒久修正は `next.config.ts` に
 *   `allowedDevOrigins: ["127.0.0.1"]` を足すか `playwright.config.ts` の既定 `baseURL` を
 *   `localhost` にする案があるが、どちらも task_016 の files_to_create/files_to_modify の外
 *   なので、ここではこのテストファイルだけで `localhost` を使う
 *   （`docs/concerns/task_016.md` C-016 に記録）。
 */

test.use({
  baseURL: `http://localhost:${process.env["PLAYWRIGHT_PORT"] ?? "3100"}`,
});

const EVENT_ID = "00000000-0000-4000-8000-000000000000";

/**
 * dev サーバー固有のノイズ（アプリのコードとは無関係）だけを除外する。
 *   - React dev ビルドの `eval()` 疎通確認（スタックトレース再構成に使えるかを試すだけで、
 *     成否に関わらず機能をブロックしない。`react-server-dom-turbopack` の
 *     `checkEvalAvailabilityOnceDev` 実装を確認済み。単なる console.error）。
 *   - `next dev` の HMR（Fast Refresh）用 WebSocket の接続エラー（ライブリロードだけの機能で、
 *     初回描画やこの画面の状態遷移には無関係）。
 */
function isKnownDevServerNoise(text: string): boolean {
  return text.includes("eval() is not supported in this environment") || text.includes("/_next/hmr");
}

test("LINE の外から開くと、URL コピーを含むフォールバックが出る（shareTargetPicker に依存しない）", async ({
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

  await page.goto(`/events/${EVENT_ID}/share`);

  // ① LINE で開く導線。
  await expect(page.getByRole("link", { name: "LINE アプリで開く" })).toBeVisible();
  // ② URL をコピーして貼る導線（shareTargetPicker が使えなくても必ず出る。N8）。
  await expect(page.getByText(/次の URL をコピーして/)).toBeVisible();
  await expect(page.locator("code")).toBeVisible();
  // ③ QR の案内（別端末用であることの明記）。
  await expect(page.getByText(/別の端末から読み取るとき/)).toBeVisible();

  // shareTargetPicker の導線（補助）は outside_line では一切出ない。
  await expect(page.getByRole("button", { name: "LINE の友だちに送る" })).toHaveCount(0);

  expect(unexpectedConsoleErrors, `console errors: ${unexpectedConsoleErrors.join("\n")}`).toEqual([]);
});
