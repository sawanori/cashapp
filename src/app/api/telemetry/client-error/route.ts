/**
 * POST /api/telemetry/client-error — ブラウザ側の起動失敗を 1 行だけ残す（§9 / R-LINE-03）。
 *
 * ★ **セッション不要**。セッションを張れない状態（`liff.init` 失敗・SDK 読み込み失敗・
 *   ログインループ打ち切り）こそが、このエンドポイントが拾いたい事象である。
 *   認証を要求すると、拾いたい事象のときだけ何も届かない。
 *
 * ★ 代わりに次の 4 つで守る。
 *   1. **IP 単位のレート制限**（`src/lib/auth/rate-limit.ts`。バックエンドが無ければ fail-closed）。
 *      **本文を読む前に判定する**。後ろに置くと、制限に掛かる相手の本文を先に受け取ってしまう。
 *   2. **コードの allowlist**（`src/lib/telemetry.ts` の `CLIENT_ERROR_CODES`）。
 *      未知のコードは 400 で捨てる。自由入力欄を一切作らない。
 *   3. **ボディ長の上限**。`{"code":"..."}` 以上の大きさを読まない。
 *      `Content-Length` があれば 1 バイトも読まずに拒否し、**無ければストリームを
 *      上限までしか読まない**（`readBoundedBody`）。`await request.text()` だけだと
 *      chunked 送信に対して「全部読んでから長さを測る」ことになり、上限が受信量を制限しない。
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
 * 本文を **最大 `maxBytes` バイトまでしか読まない**。超えた時点で読むのをやめて 400 にする。
 *
 * ★ `await request.text()` ではこの上限は成り立たない。`text()` は**本文を読み終えてから**
 *   文字列を返すので、`Content-Length` を付けずにチャンクで送られると、長さを検査できるのは
 *   全部受け取った後である。すなわち上限が守るのは「解析する量」だけで、
 *   **受信量・メモリ使用量は何も制限されない**（セッション不要の公開エンドポイントなので、
 *   ここは誰でも叩ける）。読む側で打ち切って初めて上限になる。
 *
 * ★ `Content-Length` があるときの早期拒否は残す（1 バイトも読まずに済む）。
 *   ただしヘッダは自己申告なので、**申告が無い／過少申告**の場合はここが唯一の砦である。
 *
 * @param request 本文を持つリクエスト。`body` が無い実装では `text()` へ退避する。
 * @param maxBytes 許すバイト数。これを **1 バイトでも超えたら** 400。
 */
export async function readBoundedBody(
  request: Pick<Request, "body" | "text">,
  maxBytes: number,
): Promise<string> {
  const stream = request.body;
  if (stream === null || typeof stream.getReader !== "function") {
    // ストリームが取れない実装（テストダブル等）。ここだけは読み切ってから測るしかない。
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw badRequest("request body is too large");
    }
    return text;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // ここで読むのをやめる。残りは受け取らない（送信側の pull も止まる）。
        await reader.cancel();
        throw badRequest("request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

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

    // --- レート制限は**本文を読む前**に判定する ---
    //   後ろに置くと、制限に掛かる相手の本文を先に受け取ってしまう（＝制限が守るのは
    //   ログ行の本数だけで、受信量は守らない）。バックエンドが無ければここで fail-closed。
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

    // --- ここでようやく本文を読む（上限まで） ---
    const raw = await readBoundedBody(request, MAX_TELEMETRY_BODY_BYTES);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw badRequest("request body is not JSON");
    }
    const { code } = parseClientErrorBody(parsed);

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
