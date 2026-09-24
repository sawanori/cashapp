/**
 * 静的フォールバック（R-LINE-03「白画面を出さない」）。
 *
 * ★ **JavaScript が 1 行も動かなくても文字が出ること**が、このコンポーネントの存在理由である。
 *   したがって次を守る。
 *     - `"use client"` を書かない。イベントハンドラも `useState` も持たない。
 *     - 表示に必要な情報をすべて props と固定文言で持つ（fetch しない）。
 *     - 操作は `<a>` だけで表現する。再試行の導線は **常に出す**
 *       （省略時はアプリの入口 `/` へ。JS 無しでも押せて、必ず実在する URL）。
 *       「LINE アプリで開く」は LIFF ID から組み立てたパーマネントリンクを渡されたときだけ出る。
 *
 * ★ 出る場面は 3 つ。`reason` で切り替える。
 *     1. `legacy`        … サポート下限未満のブラウザ。`.legacy-browser-notice` の中に置き、
 *                          `@supports` を満たすブラウザでは CSS で隠れる（src/styles/tokens.css）。
 *     2. `no_script`     … JavaScript が無効。`<noscript>` の中に置く。
 *     3. `sdk_unavailable` … LIFF SDK を 3 秒以内に読めなかった、または `liff.init` が失敗した
 *                          （`src/lib/liff/client.ts` の `sdk_unavailable` / `init_failed`）。
 *
 * ★ 幹事への連絡は **LINE のトークで直接**（§7-5）。このアプリはメール・電話・住所を扱わないので、
 *   連絡先フォームや宛先を出さない。固定文言で「LINE のトークで幹事へ」とだけ案内する。
 *
 * ★ `docs/wording-policy.md` の禁止語を使わない。
 */

import type { ReactNode } from "react";

export type StaticFallbackReason = "legacy" | "no_script" | "sdk_unavailable";

interface FallbackCopy {
  readonly title: string;
  readonly body: string;
}

const COPY: Readonly<Record<StaticFallbackReason, FallbackCopy>> = {
  legacy: {
    title: "この端末では表示できません",
    body: "ご利用の端末のブラウザが古いため、この画面を正しく表示できません。LINE アプリと端末の OS を最新にしてから、もう一度お試しください。",
  },
  no_script: {
    title: "JavaScript を有効にしてください",
    body: "この画面は JavaScript を使って動きます。ブラウザの設定で JavaScript を有効にするか、LINE アプリから開き直してください。",
  },
  sdk_unavailable: {
    title: "読み込みに失敗しました",
    body: "通信が不安定か、必要なファイルを取得できませんでした。もう一度お試しください。",
  },
};

/**
 * 再試行の既定の遷移先 ＝ アプリの入口（`/`）。
 *
 * ★ なぜ「現在の URL」ではないのか: このコンポーネントが出る 3 か所のうち 2 か所は
 *   Server Component（`src/app/layout.tsx` の `legacy` / `no_script`、
 *   `src/app/(liff)/layout.tsx` の `sdk_unavailable`）で、**そこでは現在のパスを取る手段が無い**。
 *
 * ★ なぜ `href=""`（現在の URL に解決される）にしないのか: `a[href]` を link ロールに
 *   対応づける規則は href が**空でない**ことを条件にしている実装があり
 *   （`aria-query` の `{name:"href", constraints:["set"]}`）、空文字だとスクリーンリーダーに
 *   リンクとして届かない可能性がある。白画面を出さないための最後の砦で、
 *   届くかどうかが実装依存になる書き方は採らない。
 *
 * ★ なぜ `#` にしないのか: 押しても何も起きないため。
 *
 * `/` は LIFF のエンドポイント URL が指す入口であり、必ず実在する。
 * 現在の URL に戻したいときは呼び出し側が `retryHref` を明示する
 * （クライアント側から出す場合は `window.location.href` を渡せる）。
 */
const APP_ENTRY_HREF = "/";

export interface StaticFallbackProps {
  readonly reason: StaticFallbackReason;
  /**
   * 再試行の遷移先。省略すると**アプリの入口（`/`）を開き直す**（`APP_ENTRY_HREF`）。
   * 現在のページを開き直したいときは呼び出し側が明示的に渡す。
   * `#` のような「押しても何も起きない」値を渡さないこと。
   */
  readonly retryHref?: string | undefined;
  /**
   * LINE で開くためのパーマネントリンク。
   * `src/lib/liff/client.ts` の `liffPermanentLink(liffId)` が組み立てる
   * （`https://liff.line.me/{liffId}`。一次資料は `docs/vendor-docs/line/liff-sdk.md` §4）。
   * LIFF ID そのものが解決できない場面では渡しようが無いので、そのときだけ導線が 1 つ減る。
   */
  readonly permanentLink?: string | undefined;
}

export function StaticFallback({
  reason,
  retryHref,
  permanentLink,
}: StaticFallbackProps): ReactNode {
  const copy = COPY[reason];
  // 省略時・空文字のときはアプリの入口へ（JS 不要）。上の `APP_ENTRY_HREF` の注記を参照。
  const retryTarget =
    retryHref === undefined || retryHref.length === 0 ? APP_ENTRY_HREF : retryHref;
  const retryLabel = retryTarget === APP_ENTRY_HREF ? "アプリを開き直す" : "もう一度読み込む";

  return (
    <section className="static-fallback" data-reason={reason}>
      <h2 className="static-fallback__title">{copy.title}</h2>
      <p className="static-fallback__body">{copy.body}</p>

      <ul className="static-fallback__actions">
        <li>
          <a className="tap-target state-view__action" href={retryTarget}>
            {retryLabel}
          </a>
        </li>
        {permanentLink === undefined || permanentLink.length === 0 ? null : (
          <li>
            <a className="tap-target" href={permanentLink}>
              LINE アプリで開く
            </a>
          </li>
        )}
      </ul>

      <p className="static-fallback__contact">
        解決しないときは、LINE のトークで幹事へご連絡ください。
      </p>
    </section>
  );
}

export default StaticFallback;
