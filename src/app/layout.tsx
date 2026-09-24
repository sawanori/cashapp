/**
 * ルートレイアウト。
 *
 * ★ **`<body>` の最上流に、JavaScript を 1 行も使わない案内を 2 つ置く**（R-LINE-03 / check_078）。
 *   どちらも React の状態に依存しない。ここが白画面を出さないための最後の砦である。
 *
 *   1. サポート下限未満のブラウザ向けの案内
 *      `.legacy-browser-notice` は既定で **表示**され、`src/styles/tokens.css` の
 *      `@supports` を満たすブラウザでだけ CSS で隠れる。`@supports` を解さない古い WebView では
 *      隠す規則が適用されないので、案内が残る。下限の根拠は `docs/supported-browsers.md`。
 *
 *   2. JavaScript が無効なときの案内
 *      `<noscript>` の中。LIFF SDK は JavaScript が動かなければ絶対に初期化できないので、
 *      「SDK 失敗時の静的フォールバック」の静的版でもある。
 *      SDK の読み込みが 3 秒で間に合わなかった動的なケースは
 *      `src/lib/liff/client.ts` が `sdk_unavailable` を返し、画面側が同じ
 *      `StaticFallback` を出す。
 *
 * ★ タイポグラフィと色のトークンは `src/styles/tokens.css` に 1 本化する（web-typography 準拠。
 *   Web フォントは 1 つも読み込まない）。ここでの import がアプリ全体への適用点である。
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { StaticFallback } from "@/components/StaticFallback";
import "@/styles/tokens.css";

export const metadata: Metadata = {
  title: "cashapp",
  description: "幹事の精算・集金の台帳（LINE ミニアプリ）",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>
        {/* ① サポート下限未満（CSS だけで判定する。JS 不要）。 */}
        <div className="legacy-browser-notice">
          <StaticFallback reason="legacy" />
        </div>
        {/* ② JavaScript 無効（＝ LIFF SDK が初期化できない）。 */}
        <noscript>
          <StaticFallback reason="no_script" />
        </noscript>
        {children}
      </body>
    </html>
  );
}
