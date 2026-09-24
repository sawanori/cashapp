/**
 * GET /api/e/preview — 同意の前に見せる最小情報（§9 / P-1 / check_086）。
 *
 * ★ **セッション不要**。招待トークンは `X-Join-Token` ヘッダで受け取る（パスに置かない。
 *   制約 X-ID / §7-4 の識別子規約）。
 * ★ 返すのはイベント名・幹事の表示名・締切・人数・金額レンジだけ。**氏名も個別金額も
 *   支払状況も返さない**（`EventPreview` の型がその境界そのもの）。
 * ★ IP 単位のレート制限を **DB へ接続する前**に掛ける。バックエンドが無ければ 503
 *   （fail-closed。`src/lib/auth/rate-limit.ts`）。
 * ★ 認可ではなく公開最小情報なので、トークンが無効・期限切れ・ローテーション済みのときは
 *   すべて 404 に畳む（どれで落ちたかを教えない）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
  RateLimiterUnavailableError,
  resolveRateLimiter,
  type RateLimitEnv,
} from "@/lib/auth/rate-limit";
import { currentPepper, loadAppConfig, type RawEnv } from "@/lib/config/env";
import { createVerifiedDbClient, type DbEnv } from "@/lib/db/client";
import { buildEventPreview } from "@/lib/db/repositories/claims";
import {
  AppError,
  ERROR_CODES,
  newRequestId,
  rateLimited,
  toErrorResponse,
} from "@/lib/errors";
import { readJoinTokenHeader, resolveEventByJoinToken } from "@/lib/join-token";
import { hashIp, logEvent } from "@/lib/logger";

type RouteEnv = RawEnv & DbEnv & RateLimitEnv;

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const { env } = await getCloudflareContext({ async: true });
  const routeEnv = env as unknown as RouteEnv;

  let db: Awaited<ReturnType<typeof createVerifiedDbClient>> | undefined;
  try {
    const config = loadAppConfig(routeEnv);

    // --- ① レート制限（DB へ接続する前） ---
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

    // 生 IP はここから先へ持ち出さない。キーには HMAC 済みの参照値だけを使う（§7-5）。
    const clientIp = request.headers.get("cf-connecting-ip");
    const pepper = currentPepper(config);
    const ipRef =
      clientIp === null || clientIp.length === 0 ? "unknown" : await hashIp(clientIp, pepper.value);
    const decision = await rateLimiter.check(`e-preview:${ipRef}`);
    if (!decision.allowed) {
      throw rateLimited("preview rate limit exceeded");
    }

    // --- ② トークン（ヘッダ） ---
    const joinToken = readJoinTokenHeader(request);

    // --- ③ DB ---
    db = await createVerifiedDbClient(routeEnv);
    const event = await resolveEventByJoinToken(db.sql, joinToken);
    const preview = await buildEventPreview(db.sql, event);

    logEvent("info", "e.preview", {
      requestId,
      outcome: "ok",
      rateLimitBackend: decision.backend,
    });

    return Response.json({ preview, requestId }, { status: 200 });
  } catch (error) {
    logEvent("info", "e.preview.failed", {
      requestId,
      code: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL,
    });
    return toErrorResponse(error, requestId);
  } finally {
    if (db !== undefined) {
      await db.close().catch(() => undefined);
    }
  }
}
