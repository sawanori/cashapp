/**
 * POST /api/auth/line — LIFF の ID トークンを受け取り、セッションを発行する（§7-4 / §9）。
 *
 * 受け取るのは `{ idToken }` **だけ**。LIFF SDK が返すデコード済み ID トークンや
 * プロフィール情報はサーバーへ送らせない・受け取らない（制約 N2。LINE の一次資料が明示的に
 * 禁じている。docs/vendor-docs/line/verify.md §2）。
 *
 * 本体の手順は `src/lib/auth/line-verify.ts` の `authenticateWithLineIdToken()` に置いてある。
 * ここは Cloudflare の env を解決して呼び、Cookie と応答ボディを組み立てるだけにする
 * （統合テストが同じ経路をそのまま叩けるようにするため）。
 *
 * ★ CSRF トークンは**応答ボディでだけ**返す。Cookie には入れない（R-SEC-12）。
 *
 * ★ 前段ガードの順番を変えないこと（敵対レビュー F-1 / F-2, 2026-09-24）。
 *   1. クロスサイト送信の拒否（403）… セッションを**作る**経路なので、ここを開けると
 *      攻撃者のアカウントのセッション Cookie を被害者に発行させられる（ログイン CSRF）。
 *   2. `Content-Type` の検査（415）と本文の未知フィールド拒否（400）。
 *   3. レート制限（429）… **DB へ接続する前**に判定する。
 *   4. ここで初めて `createVerifiedDbClient()`。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
  authenticateWithLineIdToken,
  enforceAuthRateLimit,
  readIdTokenFromBody,
  singleFlightRateLimiter,
} from "@/lib/auth/line-verify";
import {
  RateLimiterUnavailableError,
  resolveRateLimiter,
  type RateLimitEnv,
} from "@/lib/auth/rate-limit";
import {
  AUTH_LINE_BODY_KEYS,
  assertJsonContentType,
  assertOnlyKnownBodyKeys,
  assertSameOriginRequest,
} from "@/lib/auth/request-guard";
import { buildSessionCookie } from "@/lib/auth/session";
import { createDbUsedIdTokenStore } from "@/lib/auth/used-token";
import { loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { AppError, ERROR_CODES, badRequest, newRequestId, toErrorResponse } from "@/lib/errors";
import { logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv & RateLimitEnv;

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);

    // ① クロスサイトからの送信を最初に落とす（ログイン CSRF / セッション固定。F-1）。
    assertSameOriginRequest(request);
    // ② フォームが送れる Content-Type を弾く（415）。
    assertJsonContentType(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
    // ③ 未知フィールドは受け取らない（詰め物で有効な JSON を作る手口を止める。制約 N2）。
    assertOnlyKnownBodyKeys(body, AUTH_LINE_BODY_KEYS);
    const idToken = readIdTokenFromBody(body);

    let rateLimiter;
    try {
      rateLimiter = resolveRateLimiter(routeEnv);
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) {
        throw new AppError(
          ERROR_CODES.RATE_LIMIT_UNAVAILABLE,
          503,
          "ただいま受け付けできません。時間をおいてお試しください。",
          { detail: "no rate limiting backend is bound" },
        );
      }
      throw error;
    }

    // ④ レート制限は DB へ接続する**前**に判定する（F-2）。
    //    `authenticateWithLineIdToken()` も同じ判定を行うので、同じキーの 2 回目が
    //    バックエンドのカウンタを二重に消費しないようラップして渡す。
    const clientIp = request.headers.get("cf-connecting-ip");
    const requestRateLimiter = singleFlightRateLimiter(rateLimiter);
    await enforceAuthRateLimit(config, requestRateLimiter, clientIp);

    db = await createVerifiedDbClient(routeEnv);

    const result = await authenticateWithLineIdToken(
      {
        config,
        sql: db.sql,
        usedTokenStore: createDbUsedIdTokenStore(db.sql),
        rateLimiter: requestRateLimiter,
        clientIp,
      },
      idToken,
    );

    logEvent("info", "auth.session_issued", {
      requestId,
      userId: result.user.id,
      userRefFp: result.userRefFingerprint,
      kid: result.session.kid,
      sessionEpoch: result.user.sessionEpoch,
      pepperVersion: result.user.pepperVersion,
      appEnv: config.appEnv,
      rateLimitBackend: result.rateLimitBackend,
      outcome: result.created ? "created" : "existing",
      ...(result.migratedFromPepperVersion === null
        ? {}
        : { reason: `pepper_migrated_from_v${result.migratedFromPepperVersion}` }),
    });

    return Response.json(
      {
        csrfToken: result.csrfToken,
        expiresAt: result.session.expiresAt.toISOString(),
        requestId,
      },
      {
        status: 200,
        headers: { "set-cookie": buildSessionCookie(result.session.token) },
      },
    );
  } catch (error) {
    logEvent("warn", "auth.failed", {
      requestId,
      code: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL,
      ...(error instanceof AppError && error.detail !== undefined ? { detail: error.detail } : {}),
    });
    return toErrorResponse(error, requestId);
  } finally {
    if (db !== undefined) {
      await db.close().catch(() => undefined);
    }
  }
}
