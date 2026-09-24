/**
 * middleware — 全レスポンスへのセキュリティヘッダ付与と、非 production での経路封鎖。
 *
 * ★ ここでやることは 2 つだけにする。
 *   1. `APP_ENV !== 'production'` のとき `/api/webhooks/*` と `/api/cron/*` を **404**
 *      にする（§7-7 / §9 / R-SEC-05）。存在を隠すので 403 ではなく 404 にする。
 *   2. リクエストごとに CSP nonce を作り、セキュリティヘッダを**全レスポンス**に載せる
 *      （R-SEC-12 / check_075）。nonce は内部ヘッダ（`x-csp-nonce`）で下流へ渡す。
 *
 * ★ CSP は**リクエストヘッダにも同じ値を載せる**。これは任意ではなく必須である。
 *   Next.js が自前の `<script>`（ブートストラップと `self.__next_f` のインラインデータ）に
 *   nonce を付ける経路は、**リクエストヘッダの `Content-Security-Policy` を読む 1 本だけ**で、
 *   `x-csp-nonce` のような独自ヘッダは見ない
 *   （node_modules/next/dist/server/app-render/app-render.js:209-210 が
 *   `headers['content-security-policy']` から `getScriptNonceFromHeader()` で取り出す）。
 *   レスポンスにだけ CSP を載せると、配信される CSP は `script-src 'nonce-…' 'strict-dynamic'`
 *   （`'self'` も `'unsafe-inline'` も無い）なのに出力される script に nonce が付かず、
 *   ブラウザがアプリの JS を**全部**ブロックする。
 *
 * ★ 認証・CSRF の判定はここに置かない。middleware は DB に触れず
 *   `session_epoch` を突き合わせられないため、ここで「認証済み」と判断すると
 *   失効済みセッションを通してしまう。判定は各 Route Handler が
 *   `requireSession()`（`src/lib/auth/session-guard` 相当の処理）で行う。
 *
 * ★ `APP_ENV` が読めないときは **production ではない**とみなす（fail-safe な側）。
 *   その結果 webhook / cron が 404 になるのは「止まる」方向の失敗であり、
 *   「非本番で本番用の経路が開く」より安全である。
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  CSP_HEADER,
  NONCE_REQUEST_HEADER,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  generateNonce,
  isProductionOnlyPath,
} from "@/lib/security-headers";

export function middleware(request: NextRequest): NextResponse {
  const appEnv = process.env["APP_ENV"] ?? "unknown";
  const nonce = generateNonce();
  const securityHeaders = buildSecurityHeaders({ nonce, appEnv });
  const pathname = request.nextUrl.pathname;

  if (appEnv !== "production" && isProductionOnlyPath(pathname)) {
    const blocked = new NextResponse(null, { status: 404 });
    for (const [name, value] of Object.entries(securityHeaders)) {
      blocked.headers.set(name, value);
    }
    return blocked;
  }

  const requestHeaders = new Headers(request.headers);
  // ★ クライアントが投げてきた nonce ヘッダ・CSP ヘッダを信用しない。必ず上書きする。
  requestHeaders.set(NONCE_REQUEST_HEADER, nonce);
  // ★ Next.js の nonce 伝播はここだけを見る（上の doc コメント）。`buildContentSecurityPolicy`
  //   は同じ nonce に対して純粋に同じ文字列を返すので、レスポンス側の CSP と必ず一致する
  //   （一致することは tests/unit/security-headers.test.ts が検査している）。
  requestHeaders.set(CSP_HEADER, buildContentSecurityPolicy(nonce));

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(securityHeaders)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  /**
   * 静的アセットと画像最適化を除く全経路。ヘッダの付け忘れを作らないため、
   * 除外は「ヘッダを付けても意味が無いもの」だけに限る。
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
