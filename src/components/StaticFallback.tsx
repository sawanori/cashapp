/**
 * 静的フォールバック（R-LINE-03「白画面を出さない」）。
 *
 * ★ **JavaScript が 1 行も動かなくても文字が出ること**が、このコンポーネントの存在理由である。
 *   したがって次を守る。
 *     - `"use client"` を書かない。イベントハンドラも `useState` も持たない。
 *     - 表示に必要な情報をすべて props と固定文言で持つ（fetch しない）。
 *     - 操作は `<a>` だけで表現する。押すと再読み込みされる URL は呼び出し側が渡す。
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

export interface StaticFallbackProps {
  readonly reason: StaticFallbackReason;
  /**
   * 「もう一度読み込む」の遷移先。**呼び出し側が現在の URL をそのまま渡す**
   * （`window.location.href` 等）。渡されないときは再読み込み導線を出さない。
   * 空文字や `#` を href に置かない（押しても何も起きない導線を作らないため）。
   */
  readonly retryHref?: string | undefined;
  /** LINE で開くためのパーマネントリンク。渡されないときは出さない。 */
  readonly permanentLink?: string | undefined;
}

export function StaticFallback({
  reason,
  retryHref,
  permanentLink,
}: StaticFallbackProps): ReactNode {
  const copy = COPY[reason];

  return (
    <section className="static-fallback" data-reason={reason}>
      <h2 className="static-fallback__title">{copy.title}</h2>
      <p className="static-fallback__body">{copy.body}</p>

      <ul className="static-fallback__actions">
        {retryHref === undefined || retryHref.length === 0 ? null : (
          <li>
            <a className="tap-target state-view__action" href={retryHref}>
              もう一度読み込む
            </a>
          </li>
        )}
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
