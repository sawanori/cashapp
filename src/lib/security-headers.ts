/**
 * セキュリティヘッダ（R-SEC-12 / check_075）。
 *
 * ★ **全レスポンス**に付ける。middleware（`src/middleware.ts`）が一括で載せるので、
 *   個々の Route Handler では付けない（付け忘れの経路を作らない）。
 *
 * ★ CSP は nonce ベース。リクエストごとに nonce を作り、`script-src` に
 *   `'nonce-<値>'` と `'strict-dynamic'` を置く。`'strict-dynamic'` があると
 *   ホスト名の許可リスト（`https:` 等）は**無視され**、nonce の付いたスクリプトと
 *   そこから動的に読み込まれたものだけが実行される。
 *
 * ★ `frame-ancestors` は `'none'`（暫定）。LIFF アプリが iframe に置かれる要件が
 *   あるかは未実測 [不明]。実機で確かめるのは task_013 / task_022 で、
 *   そこで必要と分かれば LINE のドメインに限って緩める。既定は締める側に倒す。
 *
 * ★ HSTS は `development` では付けない（http で開くローカルに付けると、
 *   そのブラウザで以後 localhost が https 固定になり開発がとまる）。
 *
 * ★ このモジュールはブラウザ由来の値を一切読まない（＝ヘッダ注入の入口にならない）。
 */

export const CSP_HEADER = "Content-Security-Policy";
export const HSTS_HEADER = "Strict-Transport-Security";
export const CONTENT_TYPE_OPTIONS_HEADER = "X-Content-Type-Options";
export const REFERRER_POLICY_HEADER = "Referrer-Policy";
/** middleware が下流（Route Handler / Server Component）へ nonce を渡すための内部ヘッダ。 */
export const NONCE_REQUEST_HEADER = "x-csp-nonce";

/** nonce を作る（128 ビット、base64）。 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export interface SecurityHeaderOptions {
  readonly nonce: string;
  /** `development` のときだけ HSTS を外す。 */
  readonly appEnv: string;
}

/**
 * CSP の値を組み立てる。
 *
 * `connect-src` に `https://api.line.me` を入れているのは LIFF SDK が LINE の
 * エンドポイントを叩くため。実機で不足が判明したら task_013 / task_022 で足す。
 * `style-src` の `'unsafe-inline'` は Next.js が inline style を出すための妥協で、
 * `script-src` 側には入れない（XSS の実害が出るのはスクリプト側）。
 */
export function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://api.line.me",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** 全レスポンスに載せるヘッダ一式。 */
export function buildSecurityHeaders(
  options: SecurityHeaderOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    [CSP_HEADER]: buildContentSecurityPolicy(options.nonce),
    [CONTENT_TYPE_OPTIONS_HEADER]: "nosniff",
    [REFERRER_POLICY_HEADER]: "no-referrer",
  };
  if (options.appEnv !== "development") {
    headers[HSTS_HEADER] = "max-age=63072000; includeSubDomains; preload";
  }
  return headers;
}

/** テストと middleware が共有する「必ず付くヘッダ」の一覧。 */
export const REQUIRED_SECURITY_HEADERS: readonly string[] = [
  CSP_HEADER,
  CONTENT_TYPE_OPTIONS_HEADER,
  REFERRER_POLICY_HEADER,
];

/** `APP_ENV !== 'production'` で 404 にする経路（§7-7 / §9 / R-SEC-05）。 */
export const PRODUCTION_ONLY_PATH_PREFIXES: readonly string[] = ["/api/webhooks/", "/api/cron/"];

export function isProductionOnlyPath(pathname: string): boolean {
  return PRODUCTION_ONLY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
