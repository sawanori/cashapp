/**
 * CSRF 対策（R-SEC-12 / check_058）。
 *
 * ★ **Cookie を 1 つも増やさない。** ダブルサブミット Cookie 方式（非 HttpOnly の
 *   CSRF Cookie をクライアント JS が読んでヘッダに載せる）は採らない。理由は 2 つ:
 *     1. 1 件の XSS で CSRF トークンが読まれる（JS から読める Cookie だから）。
 *     2. iOS Safari と LINE の WebView の ITP が JS から設定された Cookie の寿命を
 *        短く丸めるため、決済からの復帰直後に Cookie が落ちて状態変更が不定期に失敗する。
 *
 * ★ 代わりに **セッションに束縛した派生トークン**にする。
 *     token = base64url(HMAC-SHA256("csrf:" + <セッション JWT の jti>, <現行セッション鍵>))
 *   - サーバーはレスポンス**ボディ**で返す（`POST /api/auth/line` と `GET /api/me`）。
 *   - クライアントはメモリに保持し、状態変更時に `X-CSRF-Token` ヘッダで送る。
 *   - サーバーは **Cookie 由来のセッションの jti から再計算して比較する**だけなので、
 *     トークンを保存しない（DB も Cookie も使わない）。
 *   - 別セッションのトークンは jti が違うので通らない。セッションが切れれば
 *     CSRF トークンも自動的に無効になる。
 *
 * ★ 比較は定数時間で行う。
 */

import "server-only";

import type { AppConfig } from "@/lib/config/env";
import { currentSessionKey, sessionKeyByKid } from "@/lib/config/env";

/** クライアントが使うヘッダ名。 */
export const CSRF_HEADER = "X-CSRF-Token";

/**
 * CSRF 検証を免除する経路（§9 / 制約 W6 / check_058）。
 *
 * - `/api/webhooks/*`: 送信元は決済事業者。Cookie を持たないので CSRF の前提が無い。
 *   認証は送信元 IP 許可リストと署名検証（task_022）。
 * - `/api/cron/*`: 送信元は cron Worker。認証は `CRON_SECRETS` の許容リスト。
 * - `/api/telemetry/client-error`: 認証なし・レート制限のみ。
 * - `/api/auth/line`: セッションを**作る**エンドポイントなので、まだ jti が無い。
 *   代わりに ID トークンの単回使用（ADR-009）と IP レート制限で守る。
 * - `/api/e/preview`: セッション不要の公開最小情報（読み取り）。
 * - `/api/return/*`: セッション不要・15 分・読み取り専用。
 */
export const CSRF_EXEMPT_PATH_PREFIXES: readonly string[] = [
  "/api/webhooks/",
  "/api/cron/",
  "/api/telemetry/",
  "/api/auth/line",
  "/api/e/preview",
  "/api/return/",
];

export function isCsrfExemptPath(pathname: string): boolean {
  return CSRF_EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export class CsrfError extends Error {
  public readonly code = "csrf_invalid";

  public constructor(message: string) {
    super(message);
    this.name = "CsrfError";
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 長さの違いも漏らさない定数時間比較。 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

async function hmacBase64Url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(mac));
}

/**
 * セッションの `jti` から CSRF トークンを導出する。
 *
 * `kid` を渡すとその鍵で導出する。セッション鍵をローテーションした直後でも、
 * 直前鍵で発行済みのセッションが持つ CSRF トークンを検証できるようにするため。
 */
export async function deriveCsrfToken(
  config: AppConfig,
  sessionJti: string,
  kid?: string,
): Promise<string> {
  const key = kid === undefined ? currentSessionKey(config) : sessionKeyByKid(config, kid);
  if (key === undefined) {
    throw new CsrfError("csrf token key is unknown");
  }
  return hmacBase64Url(key.value, `csrf:${sessionJti}`);
}

/**
 * `X-CSRF-Token` を検証する。欠落・不一致はどちらも `CsrfError`（呼び出し側で 403）。
 *
 * @param presented リクエストの `X-CSRF-Token` ヘッダ（無ければ null）
 * @param sessionJti Cookie 由来のセッションの `jti`
 * @param sessionKid そのセッションの署名に使われた `kid`
 */
export async function assertCsrfToken(
  config: AppConfig,
  presented: string | null,
  sessionJti: string,
  sessionKid: string,
): Promise<void> {
  if (presented === null || presented.length === 0) {
    throw new CsrfError("csrf token is missing");
  }
  const expected = await deriveCsrfToken(config, sessionJti, sessionKid);
  if (!timingSafeEqual(presented, expected)) {
    throw new CsrfError("csrf token does not match the session");
  }
}
