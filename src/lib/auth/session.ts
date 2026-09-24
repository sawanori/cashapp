/**
 * セッション JWT と `__Host-` Cookie（サーバー専用。§7-4 / R-SEC-10）。
 *
 * ★ 署名は HS256。鍵は `kid` で選ぶ。**検証は現行＋直前の 2 鍵まで**で、
 *   2 世代前の `kid` は「鍵が見つからない」で 401 になる。
 *   2 鍵までという上限は `SESSION_KEYS` の解析側（`src/lib/config/env.ts`）で
 *   構造的に担保してある（3 個書けない）。
 *
 * ★ `session_epoch` をクレームに入れる。`app_user.session_epoch` を 1 進めるだけで
 *   そのユーザーの発行済みセッションが**全部**無効になる（個別失効）。
 *   全体失効は全行の epoch を進める。鍵を回す必要が無い。
 *
 * ★ Cookie は `__Host-session`。`__Host-` 接頭辞はブラウザ側で
 *   「Secure ／ Path=/ ／ Domain 属性なし」を強制するため、サブドメインからの
 *   上書き（cookie tossing）ができない。属性は HttpOnly / Secure / SameSite=Lax / Path=/。
 *
 * ★ **JS から設定する Cookie を 1 つも作らない**（R-SEC-12）。CSRF トークンは Cookie では
 *   なくレスポンスボディで返し、`X-CSRF-Token` ヘッダで受ける（`src/lib/auth/csrf.ts`）。
 *
 * ★ ローカル開発の注意: `__Host-` は Secure を要求するため、`http://localhost` では
 *   ブラウザが Cookie を保存しない。ローカルで画面を動かすときは https で開くこと
 *   （`wrangler dev --local-protocol https` 等）。名前を環境で変えると
 *   「本番だけ落ちる」経路ができるので、名前は環境によらず固定する。
 */

import "server-only";

import { SignJWT, decodeProtectedHeader, errors as joseErrors, jwtVerify } from "jose";
import type postgres from "postgres";

import type { AppConfig, SessionKey } from "@/lib/config/env";
import { currentSessionKey, sessionKeyByKid } from "@/lib/config/env";
import { AppError, ERROR_CODES, unauthorized } from "@/lib/errors";

export const SESSION_COOKIE_NAME = "__Host-session";
/** 30 分スライディング（§7-4）。 */
export const SESSION_TTL_SECONDS = 30 * 60;
export const SESSION_ISSUER = "cashapp";
export const SESSION_AUDIENCE = "cashapp-session";
/** `exp` / `iat` の許容ずれ。ID トークン側（60 秒）と揃える。 */
export const SESSION_CLOCK_TOLERANCE_SECONDS = 60;

export interface SessionClaims {
  /** `app_user.id`（UUID）。LINE の userId ではない。 */
  readonly userId: string;
  /** 発行時点の `app_user.session_epoch`。 */
  readonly epoch: number;
  /** このセッション固有の ID。CSRF トークンの導出元でもある。 */
  readonly jti: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** 署名に使われた鍵の `kid`。 */
  readonly kid: string;
}

export class SessionError extends Error {
  public readonly code = "session_invalid";

  public constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

function keyMaterial(key: SessionKey): Uint8Array {
  return new TextEncoder().encode(key.value);
}

function newJti(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface IssuedSession {
  readonly token: string;
  readonly jti: string;
  readonly expiresAt: Date;
  readonly kid: string;
}

/** 現行鍵でセッション JWT を発行する。 */
export async function issueSession(
  config: AppConfig,
  input: { readonly userId: string; readonly epoch: number; readonly now?: Date },
): Promise<IssuedSession> {
  const key = currentSessionKey(config);
  const now = input.now ?? new Date();
  const issuedAtSeconds = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = issuedAtSeconds + SESSION_TTL_SECONDS;
  const jti = newJti();

  const token = await new SignJWT({ epoch: input.epoch })
    .setProtectedHeader({ alg: "HS256", kid: key.kid, typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(input.userId)
    .setJti(jti)
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(expiresAtSeconds)
    .sign(keyMaterial(key));

  return { token, jti, expiresAt: new Date(expiresAtSeconds * 1000), kid: key.kid };
}

/**
 * セッション JWT を検証する。失敗はすべて `SessionError`（理由は呼び出し側に出さない）。
 *
 * `epoch` の突き合わせはここでは行わない。DB の現在値が要るため、
 * 呼び出し側が `assertSessionEpoch()` を続けて呼ぶこと。
 */
export async function verifySession(
  config: AppConfig,
  token: string,
  options: { readonly now?: Date } = {},
): Promise<SessionClaims> {
  if (token.length === 0) {
    throw new SessionError("session token is empty");
  }

  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new SessionError("session token header is not decodable");
  }
  if (typeof kid !== "string" || kid.length === 0) {
    throw new SessionError("session token has no kid");
  }

  // ★ 2 世代前の kid はここで落ちる（鍵が設定に無い）。
  const key = sessionKeyByKid(config, kid);
  if (key === undefined) {
    throw new SessionError("session token was signed with an unknown key");
  }

  try {
    const { payload, protectedHeader } = await jwtVerify(token, keyMaterial(key), {
      algorithms: ["HS256"],
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      clockTolerance: SESSION_CLOCK_TOLERANCE_SECONDS,
      ...(options.now === undefined ? {} : { currentDate: options.now }),
    });

    const { sub, jti, iat, exp, epoch } = payload;
    if (typeof sub !== "string" || sub.length === 0) {
      throw new SessionError("session token has no subject");
    }
    if (typeof jti !== "string" || jti.length === 0) {
      throw new SessionError("session token has no jti");
    }
    if (typeof iat !== "number" || typeof exp !== "number") {
      throw new SessionError("session token has no iat/exp");
    }
    if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch <= 0) {
      throw new SessionError("session token has no session epoch");
    }

    return {
      userId: sub,
      epoch,
      jti,
      issuedAt: new Date(iat * 1000),
      expiresAt: new Date(exp * 1000),
      kid: protectedHeader.kid ?? kid,
    };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    if (error instanceof joseErrors.JOSEError) {
      // jose の理由（署名不一致 / 期限切れ / aud 不一致）を外には出さない。
      throw new SessionError("session token verification failed");
    }
    throw new SessionError("session token verification failed");
  }
}

/**
 * `session_epoch` の突き合わせ（R-SEC-10）。
 * DB の現在値より古い epoch のセッションは、期限内でも無効。
 */
export function assertSessionEpoch(claims: SessionClaims, currentEpoch: number): void {
  if (claims.epoch !== currentEpoch) {
    throw new SessionError("session epoch is stale");
  }
}

/** `Set-Cookie` の値を組み立てる。 */
export function buildSessionCookie(token: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

/** セッションを消す `Set-Cookie`。 */
export function buildClearedSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

export interface AuthenticatedSession {
  readonly claims: SessionClaims;
  readonly userId: string;
  readonly sessionEpoch: number;
}

/**
 * 30 分スライディング（§7-4）の判定。
 *
 * 有効期間の**半分を過ぎていたら**更新する。毎リクエストで再発行しないのは、
 * 再発行で `jti` が変わり、それに束縛された CSRF トークン（`src/lib/auth/csrf.ts`）が
 * 入れ替わるためである。更新のたびに古い CSRF トークンが無効になるので、
 * 入れ替わりの回数は少ないほうがよい。
 */
export function shouldRefreshSession(claims: SessionClaims, now: Date = new Date()): boolean {
  const total = claims.expiresAt.getTime() - claims.issuedAt.getTime();
  if (total <= 0) return true;
  return now.getTime() - claims.issuedAt.getTime() >= total / 2;
}

/**
 * Cookie のセッションを検証し、DB の現在値（`session_epoch` / `status`）と突き合わせる。
 *
 * ★ **DB を必ず引く。** JWT の `epoch` だけを信じると、失効させたはずのセッションが
 *   期限（30 分）まで生き続ける。失効を即時にするのが `session_epoch` の目的である。
 *
 * 失敗は 401 `UNAUTHORIZED`（停止済みユーザーだけ 403 `USER_SUSPENDED`）。
 * 401 は通常系として扱う（クライアントは共通フェッチラッパで 1 回だけ静かに再認証する。§7-4）。
 */
export async function requireSession(
  config: AppConfig,
  sql: postgres.Sql,
  request: Request,
): Promise<AuthenticatedSession> {
  const token = readSessionCookie(request.headers.get("cookie"));
  if (token === undefined) {
    throw unauthorized("no session cookie");
  }

  let claims: SessionClaims;
  try {
    claims = await verifySession(config, token);
  } catch {
    throw unauthorized("session token is not valid");
  }

  const rows = await sql<{ session_epoch: number; status: string }[]>`
    SELECT session_epoch, status FROM app_user WHERE id = ${claims.userId}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw unauthorized("session subject does not exist");
  }
  if (row.status === "suspended") {
    throw new AppError(ERROR_CODES.USER_SUSPENDED, 403, "このアカウントではご利用いただけません。");
  }
  try {
    assertSessionEpoch(claims, row.session_epoch);
  } catch {
    throw unauthorized("session epoch is stale");
  }

  return { claims, userId: claims.userId, sessionEpoch: row.session_epoch };
}

/** `Cookie` ヘッダからセッション JWT を取り出す。無ければ undefined。 */
export function readSessionCookie(cookieHeader: string | null): string | undefined {
  if (cookieHeader === null || cookieHeader.length === 0) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}
