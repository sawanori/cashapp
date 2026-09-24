/**
 * `(web)` ルートグループのレイアウト — LINE に依存しない通常ブラウザ側の外殻（ADR-013）。
 *
 * ★ **ここは「LINE が使えなくなったときの退避先」ではない。**
 *   Phase 1 で `(web)` に置くのは 2 つだけである（`docs/decisions/ADR-013-web-route-group.md`）。
 *     - 静的な法務ページ（運営者情報・利用規約・プライバシーポリシー。O-13 相当。task_021）
 *     - 管理者画面（別 IdP。task_021）
 *   幹事・参加者の集金導線の LINE 非依存版は Phase 1 に **存在しない**。
 *   `npm run build:web-only` が担保するのは「ビルドが LINE SDK 無しで通ること」だけであり、
 *   「LINE を外しても集金が回ること」ではない（§4-4 / A7 の退避欄 / R-LINE-05）。
 *
 * ★ したがってこのファイルは **`src/lib/liff/**` と `@line/liff` を 1 つも import しない**。
 *   その不在は `scripts/build-web-only.mjs` が静的な import グラフの走査で機械的に確かめる。
 *
 * ★ 運営者名・所在地・連絡先の実値をここに書かない（法務ページ本文は task_021 の担当で、
 *   実値は PO が入れる）。存在しない事実を先回りで書かないこと。
 */

import type { ReactNode } from "react";

export default function WebLayout({
  children,
}: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <div className="app-shell" data-route-group="web">
      <a className="skip-link" href="#web-main">
        本文へスキップ
      </a>
      <main id="web-main">{children}</main>
      <footer className="app-shell__footer">
        {/* 運営者情報・規約・プライバシーポリシーへのリンクは task_021 がここに足す。 */}
        <p>運営者情報・利用規約・プライバシーポリシーは準備中です。</p>
      </footer>
    </div>
  );
}
