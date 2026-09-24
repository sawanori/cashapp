/**
 * LIFF のモック読み込み（制約 I4 / R-LINE-05）。
 *
 * ★ **このファイルは本番バンドルに入れてはいけない。**
 *   到達経路は `src/lib/liff/client.ts` の
 *   `if (process.env.NEXT_PUBLIC_LIFF_MOCK === "1") { await import("./mock") }` 1 か所だけである。
 *   本番ビルドではこの環境変数が未定義なので、条件式が定数 `false` に畳まれ、
 *   動的 import ごと到達不能になる。その結果を `npm run build:web-only` が
 *   `.next` の grep で毎回確かめる（check_079）。
 *
 * ★ E2E（Playwright）は実ブラウザで動くので `vi.mock` が効かない（制約 I4）。
 *   モックの切り替えは**環境変数**でしか行わない。テストコードから直接この関数を呼ばないこと。
 *
 * ★ 差し込み方は `@line/liff-mock` の公式 README のとおり（docs/vendor-docs/line/liff-sdk.md §3、
 *   取得日 2026-09-24）: `liff.use(new LiffMockPlugin())` してから `liff.init({ …, mock: true })`。
 *   本 SDK を差し替えるのではなく、LIFF Plugin として差し込む。
 */

import type { LiffLike } from "./client";

/**
 * モードを有効にした LIFF インスタンスを返す。
 *
 * `@line/liff` と `@line/liff-mock` の import を**この関数の中の動的 import**に閉じるのは、
 * 静的 import にすると本ファイルを読み込んだ時点で両方がチャンクに載るためである。
 */
export async function loadMockedLiff(): Promise<LiffLike> {
  const [sdk, mock] = await Promise.all([import("@line/liff"), import("@line/liff-mock")]);
  const liff = sdk.default as unknown as LiffLike & {
    use(plugin: unknown): void;
  };
  liff.use(new mock.LiffMockPlugin());
  return liff;
}
