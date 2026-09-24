/**
 * middleware — 全レスポンスへのセキュリティヘッダ付与と、非 production での経路封鎖。
 *
 * ★ ここでやることは 2 つだけにする。
 *   1. `APP_ENV !== 'production'` のとき `/api/webhooks/*` と `/api/cron/*` を **404**
 *      にする（§7-7 / §9 / R-SEC-05）。存在を隠すので 403 ではなく 404 にする。
 *   2. リクエストごとに CSP nonce を作り、セキュリティヘッダを**全レスポンス**に載せる
 *      （R-SEC-12 / check_075）。nonce は内部ヘッダ（`x-csp-nonce`）で下流へ渡す。
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
  NONCE_REQUEST_HEADER,
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
  // ★ クライアントが投げてきた nonce ヘッダを信用しない。必ず上書きする。
  requestHeaders.set(NONCE_REQUEST_HEADER, nonce);

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
