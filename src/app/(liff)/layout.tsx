/**
 * `(liff)` ルートグループのレイアウト — LINE ミニアプリ側の外殻（§7-3 / ADR-013）。
 *
 * ★ **主導線はこちら**である。名簿・請求・台帳の画面はすべてこの下に置く
 *   （「主な機能はミニアプリ内で提供」というミニアプリの要件のため。§7-3）。
 *
 * ★ ここがやることは 2 つだけ。
 *   1. LIFF ID を**実行時に**クライアントへ渡す。
 *      `<meta name="x-liff-id">` に載せる。**ビルド時に焼き込まない**ことが要点で、
 *      `NEXT_PUBLIC_LIFF_ID` のような公開ビルド変数にすると、staging のビルド成果物に
 *      dev の LIFF ID が残る（R-LINE-04）。バンドルに含まれないことは
 *      `npm run build:web-only` の grep が毎回確かめる。
 *      読み出しは `src/lib/liff/client.ts` の `readLiffIdFromDocument()` だけが行う。
 *   2. 設定が壊れていて LIFF ID を出せないときに、**白画面にせず**静的フォールバックを出す
 *      （R-LINE-03）。
 *
 * ★ `force-dynamic` にする理由: LIFF ID は環境ごとに違う実行時の値であり、ビルド時に
 *   確定させてはいけない。静的化されると staging のビルドに dev の値が焼き付く。
 *
 * ★ LIFF SDK の初期化そのものはここでは行わない。起動順序（`init` → `isInClient` →
 *   `isLoggedIn` → `login`）は `src/lib/liff/client.ts` の `bootLiff()` に 1 本化してあり、
 *   それを呼ぶのは認証が要る画面（task_014 以降）である。
 */

import type { ReactNode } from "react";

import { StaticFallback } from "@/components/StaticFallback";
import { LIFF_ID_META_NAME } from "@/lib/liff/client";

/** 実行時の値を扱うので静的化しない（上のコメント参照）。 */
export const dynamic = "force-dynamic";

/**
 * LIFF ID を実行時に解決する。
 *
 * 失敗を握りつぶして `null` を返すのは、**ここで例外を投げると白画面になる**からである
 * （R-LINE-03）。失敗の記録は `/api/health` の `liffIdFingerprint`（設定不正なら 503）と
 * サーバーログが担う。
 */
async function resolveLiffId(): Promise<string | null> {
  try {
    const [{ getCloudflareContext }, { loadAppConfig }] = await Promise.all([
      import("@opennextjs/cloudflare"),
      import("@/lib/config/env"),
    ]);
    let env: unknown;
    try {
      const context = await getCloudflareContext({ async: true });
      env = context.env;
    } catch {
      // ローカルの `next dev` で platform proxy が立っていない場合。
      env = process.env;
    }
    return loadAppConfig(env as Parameters<typeof loadAppConfig>[0]).line.liffId;
  } catch {
    return null;
  }
}

export default async function LiffLayout({
  children,
}: Readonly<{ children: ReactNode }>): Promise<ReactNode> {
  const liffId = await resolveLiffId();

  if (liffId === null) {
    return (
      <div className="app-shell" data-route-group="liff">
        <StaticFallback reason="sdk_unavailable" />
      </div>
    );
  }

  return (
    <div className="app-shell" data-route-group="liff">
      <meta name={LIFF_ID_META_NAME} content={liffId} />
      <a className="skip-link" href="#liff-main">
        本文へスキップ
      </a>
      <main id="liff-main">{children}</main>
    </div>
  );
}
