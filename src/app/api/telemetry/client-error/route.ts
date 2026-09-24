/**
 * POST /api/telemetry/client-error — ブラウザ側の起動失敗を 1 行だけ残す（§9 / R-LINE-03）。
 *
 * ★ **セッション不要**。セッションを張れない状態（`liff.init` 失敗・SDK 読み込み失敗・
 *   ログインループ打ち切り）こそが、このエンドポイントが拾いたい事象である。
 *   認証を要求すると、拾いたい事象のときだけ何も届かない。
 *
 * ★ 代わりに次の 4 つで守る。
 *   1. **IP 単位のレート制限**（`src/lib/auth/rate-limit.ts`。バックエンドが無ければ fail-closed）。
 *   2. **コードの allowlist**（`src/lib/telemetry.ts` の `CLIENT_ERROR_CODES`）。
 *      未知のコードは 400 で捨てる。自由入力欄を一切作らない。
 *   3. **ボディ長の上限**。`{"code":"..."}` 以上の大きさを読まない。
 *   4. **キーの本数**。`code` 以外のキーがあれば 400。「ついでに情報を載せる」経路を塞ぐ。
 *
 * ★ 記録するのは `{ code, liffIdFingerprint, uaClass, requestId }` の 4 つだけ。
 *   `liffIdFingerprint` と `uaClass` は **サーバーが自分で作る**（クライアントからは受け取らない）。
 *   生 IP・UA 文字列・URL・利用者識別子は記録しない（§7-5 / `src/lib/logger.ts` の allowlist）。
 */

import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
  RateLimiterUnavailableError,
  resolveRateLimiter,
  type RateLimitEnv,
} from "@/lib/auth/rate-limit";
import { configFingerprints, loadAppConfig, type RawEnv } from "@/lib/config/env";
import {
  AppError,
  ERROR_CODES,
  badRequest,
  newRequestId,
  rateLimited,
  toErrorResponse,
} from "@/lib/errors";
import { logEvent } from "@/lib/logger";
import { classifyUserAgent, isClientErrorCode, type ClientErrorCode } from "@/lib/telemetry";

type RouteEnv = RawEnv & RateLimitEnv;

/**
 * 受け付けるボディの最大バイト数。
 * 実体は `{"code":"login_loop_aborted"}` 程度（30 バイト前後）なので、桁で余裕を見ても 256 で足りる。
 */
export const MAX_TELEMETRY_BODY_BYTES = 256;

/**
 * ボディの検査。**`code` ちょうど 1 キー**であることまで見る。
 *
 * 余分なキーを黙って捨てるのではなく 400 にするのは、送信側に「ここは自由に足せる」と
 * 誤解させないためである（check_078「PII と自由入力が含まれない」）。
 */
export function parseClientErrorBody(body: unknown): { readonly code: ClientErrorCode } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object");
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "code") {
    throw badRequest("request body must contain exactly one key: code");
  }
  const code = (body as Record<string, unknown>)["code"];
  if (!isClientErrorCode(code)) {
    throw badRequest("code is not an allowed client error code");
  }
  return { code };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const uaClass = classifyUserAgent(request.headers.get("user-agent"));

  let routeEnv: RouteEnv;
  try {
    const context = await getCloudflareContext({ async: true });
    routeEnv = context.env as unknown as RouteEnv;
  } catch {
    // ローカルの `next dev` で platform proxy が立っていない場合。
    routeEnv = process.env as unknown as RouteEnv;
  }

  try {
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAX_TELEMETRY_BODY_BYTES) {
      throw badRequest("request body is too large");
    }

    const raw = await request.text();
    if (raw.length > MAX_TELEMETRY_BODY_BYTES) {
      throw badRequest("request body is too large");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw badRequest("request body is not JSON");
    }
    const { code } = parseClientErrorBody(parsed);

    let rateLimiter;
    try {
      rateLimiter = resolveRateLimiter(routeEnv);
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) {
        // fail-closed。テレメトリのために無制限の書き込み口を開けない。
        throw new AppError(
          ERROR_CODES.RATE_LIMIT_UNAVAILABLE,
          503,
          "ただいま受け付けできません。時間をおいてお試しください。",
          { detail: "no rate limiting backend is bound" },
        );
      }
      throw error;
    }

    // 生 IP はここから先へ持ち出さない。レート制限のキーとしてだけ使う。
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";
    const decision = await rateLimiter.check(`telemetry:${clientIp}`);
    if (!decision.allowed) {
      throw rateLimited("telemetry rate limit exceeded");
    }

    // LIFF ID の fingerprint は**サーバーの設定から**作る。設定が壊れていて作れないときこそ
    // 記録したい事象なので、作れなくても記録自体は続ける。
    let liffIdFingerprint: string | null = null;
    try {
      const config = loadAppConfig(routeEnv);
      liffIdFingerprint = (await configFingerprints(config)).liffIdFingerprint;
    } catch {
      liffIdFingerprint = null;
    }

    logEvent("warn", "telemetry.client_error", {
      requestId,
      code,
      uaClass,
      rateLimitBackend: decision.backend,
      ...(liffIdFingerprint === null ? {} : { liffIdFingerprint }),
    });

    return Response.json({ recorded: true, requestId }, { status: 202 });
  } catch (error) {
    logEvent("info", "telemetry.rejected", {
      requestId,
      uaClass,
      code: error instanceof AppError ? error.code : ERROR_CODES.INTERNAL,
    });
    return toErrorResponse(error, requestId);
  }
}
