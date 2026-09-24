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
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { authenticateWithLineIdToken, readIdTokenFromBody } from "@/lib/auth/line-verify";
import {
  RateLimiterUnavailableError,
  resolveRateLimiter,
  type RateLimitEnv,
} from "@/lib/auth/rate-limit";
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest("request body is not JSON");
    }
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

    db = await createVerifiedDbClient(routeEnv);

    const result = await authenticateWithLineIdToken(
      {
        config,
        sql: db.sql,
        usedTokenStore: createDbUsedIdTokenStore(db.sql),
        rateLimiter,
        clientIp: request.headers.get("cf-connecting-ip"),
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
