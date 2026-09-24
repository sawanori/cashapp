/**
 * LINE の ID トークン検証と、`/api/auth/line` の組み立て（サーバー専用）。
 *
 * 一次資料: `docs/vendor-docs/line/verify.md`（取得日 2026-09-24）。
 * 判断の記録: `docs/decisions/ADR-009-id-token-single-use.md`。
 *
 * ★ 検証はサーバーで必ず行う（制約 N2）。LIFF SDK が返すデコード済み ID トークンや
 *   プロフィール情報は受け取らない（LINE の一次資料が明示的に禁じている。
 *   docs/vendor-docs/line/verify.md §2）。受け取るのは `idToken` 1 個だけである。
 *
 * ★ `client_id` に入れるのは **LINE Login チャネル ID**（N3）。
 *   LIFF ID との整合は起動時に `src/lib/config/env.ts` が落としている。
 *
 * ★ 失敗の理由を外に出さない。改竄・期限切れ・aud 不一致・再利用は**すべて**
 *   401 `ID_TOKEN_INVALID` に畳む（どこで落ちたかを攻撃者に教えない）。
 *
 * ★ `idToken` 本体をログにも例外にも載せない（R-SEC-04）。
 */

import "server-only";

import type postgres from "postgres";

import type { AppConfig } from "@/lib/config/env";
import { currentPepper } from "@/lib/config/env";
import { deriveCsrfToken } from "@/lib/auth/csrf";
import {
  LINE_USER_ID_RE,
  computeLineUserRef,
  resolveAppUser,
  userRefFingerprint,
  type AppUserRow,
} from "@/lib/auth/pepper";
import type { RateLimiter } from "@/lib/auth/rate-limit";
import { issueSession, type IssuedSession } from "@/lib/auth/session";
import { idTokenUsageKey, type UsedIdTokenStore } from "@/lib/auth/used-token";
import { AppError, ERROR_CODES, badRequest, idTokenInvalid, rateLimited } from "@/lib/errors";
import { hashIp } from "@/lib/logger";

/** 一次資料 §1。 */
export const LINE_VERIFY_ENDPOINT = "https://api.line.me/oauth2/v2.1/verify";

/** LINE が ID トークンに載せる issuer。 */
export const LINE_ID_TOKEN_ISSUER = "https://access.line.me";

/** `exp` / `iat` の許容ずれ（§7-4 / ADR-009）。 */
export const ID_TOKEN_CLOCK_SKEW_SECONDS = 60;

/** ID トークンの長さの上限（乱打で巨大な本文を投げられるのを止める）。 */
export const MAX_ID_TOKEN_LENGTH = 4096;

/** verify の成功レスポンス（本アプリが使うフィールドのみ）。 */
export interface LineVerifiedPayload {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly exp: number;
  readonly iat: number;
  /** 一次資料のペイロード一覧には無い。将来増えたら単回使用キーに使う。 */
  readonly jti?: string | undefined;
}

export interface VerifyIdTokenOptions {
  readonly idToken: string;
  readonly loginChannelId: string;
  readonly now?: Date;
  readonly fetchImpl?: typeof fetch;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * `POST https://api.line.me/oauth2/v2.1/verify` を叩いて ID トークンを検証する。
 *
 * LINE 側で署名・issuer・audience・期限が検証される。その上で、
 * **こちら側でも `aud` / `iss` / `exp` / `iat` / `sub` の形を検査する**。
 * 環境取り違え（R-LINE-04）は「LINE 側の検証は通るが、自分が期待した環境ではない」形でも
 * 起きるため、`aud` の突き合わせは自前でも持つ。
 */
export async function verifyLineIdToken(options: VerifyIdTokenOptions): Promise<LineVerifiedPayload> {
  const { idToken, loginChannelId } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();

  if (idToken.length === 0 || idToken.length > MAX_ID_TOKEN_LENGTH) {
    throw idTokenInvalid("id token length out of range");
  }

  const body = new URLSearchParams({ id_token: idToken, client_id: loginChannelId });

  let response: Response;
  try {
    response = await doFetch(LINE_VERIFY_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    // ネットワーク例外のメッセージには URL やヘッダが載ることがあるので握りつぶす。
    throw idTokenInvalid("verify endpoint is unreachable");
  }

  // ★ 一次資料はエラー時のステータスコードを明示していない。2xx 以外は一律で失敗にする。
  if (!response.ok) {
    throw idTokenInvalid(`verify endpoint returned ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw idTokenInvalid("verify endpoint returned a non-JSON body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw idTokenInvalid("verify endpoint returned an unexpected body");
  }

  const record = parsed as Record<string, unknown>;
  const iss = record["iss"];
  const sub = record["sub"];
  const aud = record["aud"];
  const exp = asNumber(record["exp"]);
  const iat = asNumber(record["iat"]);
  const jti = typeof record["jti"] === "string" ? (record["jti"] as string) : undefined;

  if (typeof iss !== "string" || typeof sub !== "string" || typeof aud !== "string") {
    throw idTokenInvalid("verify payload is missing iss/sub/aud");
  }
  if (exp === undefined || iat === undefined) {
    throw idTokenInvalid("verify payload is missing exp/iat");
  }
  if (iss !== LINE_ID_TOKEN_ISSUER) {
    throw idTokenInvalid("issuer mismatch");
  }
  // ★ N3: 期待するのは LINE Login チャネル ID。
  if (aud !== loginChannelId) {
    throw idTokenInvalid("audience mismatch");
  }
  if (!LINE_USER_ID_RE.test(sub)) {
    throw idTokenInvalid("subject is not a LINE user id");
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (nowSeconds > exp + ID_TOKEN_CLOCK_SKEW_SECONDS) {
    throw idTokenInvalid("id token is expired");
  }
  if (iat > nowSeconds + ID_TOKEN_CLOCK_SKEW_SECONDS) {
    throw idTokenInvalid("id token was issued in the future");
  }

  return { iss, sub, aud, exp, iat, jti };
}

export interface AuthenticateDeps {
  readonly config: AppConfig;
  readonly sql: postgres.Sql;
  readonly usedTokenStore: UsedIdTokenStore;
  readonly rateLimiter: RateLimiter;
  readonly fetchImpl?: typeof fetch;
  readonly now?: Date;
  /** `CF-Connecting-IP`。無ければ null（レート制限のキーは `unknown` になる）。 */
  readonly clientIp: string | null;
}

export interface AuthenticateResult {
  readonly user: AppUserRow;
  readonly session: IssuedSession;
  readonly csrfToken: string;
  readonly migratedFromPepperVersion: number | null;
  readonly created: boolean;
  readonly rateLimitBackend: string;
  /** ログ用。生の userId でも `line_user_ref` そのものでもない。 */
  readonly userRefFingerprint: string;
}

/** リクエストボディから `idToken` を取り出す。形が違えば 400。 */
export function readIdTokenFromBody(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const idToken = (body as Record<string, unknown>)["idToken"];
  if (typeof idToken !== "string" || idToken.length === 0) {
    throw badRequest("idToken is required");
  }
  return idToken;
}

/**
 * `/api/auth/line` の本体。ルートハンドラは Cloudflare の env を解決してこれを呼ぶだけにする
 * （統合テストが同じ経路をそのまま叩けるように、ここを唯一の入口にする）。
 */
export async function authenticateWithLineIdToken(
  deps: AuthenticateDeps,
  idToken: string,
): Promise<AuthenticateResult> {
  const { config, sql, usedTokenStore, rateLimiter } = deps;
  const now = deps.now ?? new Date();
  const pepper = currentPepper(config);

  // ① IP 単位のレート制限。生 IP は使わず HMAC にしてから鍵にする（§7-5）。
  const ipRef =
    deps.clientIp === null || deps.clientIp.length === 0
      ? "unknown"
      : await hashIp(deps.clientIp, pepper.value);
  const decision = await rateLimiter.check(`auth-line:${ipRef}`);
  if (!decision.allowed) {
    throw rateLimited("too many authentication attempts from this address");
  }

  // ② LINE で検証。
  const payload = await verifyLineIdToken({
    idToken,
    loginChannelId: config.line.loginChannelId,
    now,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  });

  // ③ 単回使用（ADR-009）。2 回目の提示は 401。
  const usageKey = await idTokenUsageKey(idToken, payload.jti);
  const firstUse = await usedTokenStore.markUsed(usageKey, new Date(payload.exp * 1000));
  if (!firstUse) {
    throw idTokenInvalid("id token was already used");
  }

  // ④ `line_user_ref` を作り `app_user` を解決（必要なら pepper_version を移行）。
  const resolved = await resolveAppUser(sql, config, payload.sub);
  if (resolved.user.status === "suspended") {
    throw new AppError(
      ERROR_CODES.USER_SUSPENDED,
      403,
      "このアカウントではご利用いただけません。",
    );
  }

  // ⑤ セッション JWT と CSRF トークン。
  const session = await issueSession(config, {
    userId: resolved.user.id,
    epoch: resolved.user.sessionEpoch,
    now,
  });
  const csrfToken = await deriveCsrfToken(config, session.jti, session.kid);

  const userRef = await computeLineUserRef(payload.sub, pepper);

  return {
    user: resolved.user,
    session,
    csrfToken,
    migratedFromPepperVersion: resolved.migratedFromPepperVersion,
    created: resolved.created,
    rateLimitBackend: decision.backend,
    userRefFingerprint: userRefFingerprint(userRef),
  };
}
