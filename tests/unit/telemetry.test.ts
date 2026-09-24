/**
 * フロントテレメトリ（check_078 / R-LINE-03）。
 *
 * 検査の主眼は「**送る中身に PII と自由入力が無い**」ことである。
 * そのため、送信側（`src/lib/telemetry.ts`）と受信側（`POST /api/telemetry/client-error`）の
 * 両方で「`code` 以外は受け付けない・持ち出さない」を確かめる。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const cloudflareEnv: Record<string, unknown> = {};
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({ env: cloudflareEnv, cf: undefined, ctx: undefined }),
}));

const {
  CLIENT_ERROR_CODES,
  TELEMETRY_ENDPOINT,
  buildClientErrorPayload,
  classifyUserAgent,
  isClientErrorCode,
  reportClientError,
} = await import("@/lib/telemetry");
const { POST, parseClientErrorBody, MAX_TELEMETRY_BODY_BYTES } = await import(
  "@/app/api/telemetry/client-error/route"
);
const { LOG_KEY_ALLOWLIST } = await import("@/lib/logger");

/** レート制限のローカル逃げ道（src/lib/auth/rate-limit.ts の 3 条件）。 */
function setEnvWithRateLimitBypass(): void {
  for (const key of Object.keys(cloudflareEnv)) delete cloudflareEnv[key];
  cloudflareEnv["APP_ENV"] = "development";
  cloudflareEnv["ALLOW_LOCAL_RATE_LIMIT_BYPASS"] = "1";
  cloudflareEnv["LINE_ENV_PROFILE"] = JSON.stringify({
    env: "development",
    liffId: "2000000000-abcd1234",
    loginChannelId: "2000000000",
  });
  cloudflareEnv["PEPPER"] = `1:${"p".repeat(32)}`;
  cloudflareEnv["SESSION_KEYS"] = `k1:${"s".repeat(32)}`;
  cloudflareEnv["CRON_SECRETS"] = "c".repeat(32);
}

function telemetryRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://example.test/api/telemetry/client-error", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("送信側: ボディは code 1 キーだけ", () => {
  it("buildClientErrorPayload の戻り値のキーは code ちょうど 1 つ", () => {
    const payload = buildClientErrorPayload(CLIENT_ERROR_CODES.LIFF_INIT_FAILED);
    expect(Object.keys(payload)).toEqual(["code"]);
  });

  it("reportClientError が実際に送るのも code 1 キーだけ（PII・自由入力なし）", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;

    const ok = await reportClientError(CLIENT_ERROR_CODES.SDK_LOAD_FAILED, { fetchImpl });

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TELEMETRY_ENDPOINT);
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(["code"]);
    expect(sent["code"]).toBe("sdk_load_failed");
    // Cookie を積まない（セッション不要のエンドポイントであり、識別子を運ばせない）。
    expect(calls[0]?.init.credentials).toBe("omit");
  });

  it("送信に失敗しても例外を投げず false を返す（テレメトリで画面を壊さない）", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(
      reportClientError(CLIENT_ERROR_CODES.SCRIPT_ERROR, { fetchImpl }),
    ).resolves.toBe(false);
  });

  it("allowlist 外の文字列はコードとして認めない（自由入力欄を作らない）", () => {
    expect(isClientErrorCode("liff_init_failed")).toBe(true);
    expect(isClientErrorCode("user said the app is broken")).toBe(false);
    expect(isClientErrorCode("U0123456789abcdef0123456789abcdef")).toBe(false);
  });

  it("classifyUserAgent は 3 値にしか畳まない（端末が特定できる粒度を残さない）", () => {
    expect(classifyUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Line/14.0")).toBe(
      "ios",
    );
    expect(classifyUserAgent("Mozilla/5.0 (Linux; Android 13; Pixel 7) Line/14.0")).toBe("android");
    expect(classifyUserAgent("Mozilla/5.0 (Windows NT 10.0)")).toBe("other");
    expect(classifyUserAgent(null)).toBe("other");
  });
});

describe("受信側: parseClientErrorBody", () => {
  it("code だけのボディを受け付ける", () => {
    expect(parseClientErrorBody({ code: "liff_init_failed" })).toEqual({
      code: "liff_init_failed",
    });
  });

  it("余分なキーがあれば 400（『ついでに載せる』経路を塞ぐ）", () => {
    expect(() =>
      parseClientErrorBody({ code: "liff_init_failed", message: "ログインできません" }),
    ).toThrowError();
    expect(() =>
      parseClientErrorBody({ code: "liff_init_failed", userId: "U0123456789abcdef" }),
    ).toThrowError();
  });

  it("allowlist 外のコードは 400", () => {
    expect(() => parseClientErrorBody({ code: "whatever" })).toThrowError();
  });

  it("オブジェクト以外は 400", () => {
    expect(() => parseClientErrorBody("liff_init_failed")).toThrowError();
    expect(() => parseClientErrorBody(["liff_init_failed"])).toThrowError();
    expect(() => parseClientErrorBody(null)).toThrowError();
  });
});

describe("POST /api/telemetry/client-error", () => {
  let logLines: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setEnvWithRateLimitBypass();
    logLines = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logLines.push(String(line));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("受け付けて 202 を返し、記録は allowlist のキーだけ（PII なし）", async () => {
    const response = await POST(
      telemetryRequest(
        { code: CLIENT_ERROR_CODES.LIFF_INIT_FAILED },
        {
          "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Line/14.0",
          "cf-connecting-ip": "203.0.113.9",
        },
      ),
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["recorded"]).toBe(true);
    expect(typeof body["requestId"]).toBe("string");

    const record = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry["event"] === "telemetry.client_error");
    expect(record, "telemetry.client_error のログ行が無い").toBeDefined();

    // 記録されるのは { code, liffIdFingerprint, uaClass, requestId } の系統だけ。
    expect(record?.["code"]).toBe("liff_init_failed");
    expect(record?.["uaClass"]).toBe("ios");
    expect(typeof record?.["liffIdFingerprint"]).toBe("string");

    // 生 IP・UA 文字列・自由入力がどこにも残っていない。
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("203.0.113.9");
    expect(serialized).not.toContain("iPhone");
    expect(serialized).not.toContain("Mozilla");

    // ログのキーはすべて allowlist（＋ 常設の ts / level / event）に載っているものだけ。
    const allowed = new Set([...LOG_KEY_ALLOWLIST, "ts", "level", "event"]);
    for (const key of Object.keys(record ?? {})) {
      expect(allowed.has(key), `allowlist 外のキーが記録されている: ${key}`).toBe(true);
    }
  });

  it("allowlist 外のコードは 400 で、その値を記録しない", async () => {
    const response = await POST(telemetryRequest({ code: "U0123456789abcdef0123456789abcdef" }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    // エラー応答の形は { code, message, requestId } の 3 キー（§9）。
    expect(Object.keys(body).sort()).toEqual(["code", "message", "requestId"]);
    expect(JSON.stringify(logLines)).not.toContain("U0123456789abcdef0123456789abcdef");
  });

  it("ボディが大きすぎれば読まずに 400", async () => {
    const oversized = JSON.stringify({ code: "a".repeat(MAX_TELEMETRY_BODY_BYTES * 2) });
    const response = await POST(telemetryRequest(oversized));
    expect(response.status).toBe(400);
  });

  /**
   * Content-Length の無い本文（chunked）に対する上限（GPT-6 Astra F-3）。
   *
   * `request.text()` は**本文を読み終えてから**しか長さを返さないので、それだけでは
   * 「256 バイト上限」は受信量を一切制限しない。上限は**読む量**に掛かっていなければならない。
   * 実測の根拠は undici（Node 22）の挙動である。`new Request(url, { body: ReadableStream })` は
   * `content-length` を付けず（ヘッダは `null`）、`request.body` は **pull 駆動**なので、
   * 読むのをやめればソース側の `pull` も止まる。
   */
  describe("Content-Length の無い本文（F-3）", () => {
    const CHUNK_BYTES = 64;

    /** 送出したバイト数を数えながらチャンク送信するリクエストを作る。 */
    function chunkedRequest(
      totalBytes: number,
      pulled: { bytes: number },
      headers: Record<string, string> = {},
    ): Request {
      const encoder = new TextEncoder();
      const chunkCount = Math.ceil(totalBytes / CHUNK_BYTES);
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= chunkCount) {
            controller.close();
            return;
          }
          const size = Math.min(CHUNK_BYTES, totalBytes - index * CHUNK_BYTES);
          const chunk = encoder.encode("a".repeat(size));
          index += 1;
          pulled.bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return new Request("https://example.test/api/telemetry/client-error", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: stream,
        duplex: "half",
      } as unknown as RequestInit);
    }

    it("チャンク本文が 257 バイトを超えたら 400（Content-Length は付いていない）", async () => {
      const pulled = { bytes: 0 };
      const request = chunkedRequest(MAX_TELEMETRY_BODY_BYTES + 1, pulled);
      // 前提の確認: この経路には Content-Length が無い（あるなら別の枝で弾かれてしまう）。
      expect(request.headers.get("content-length")).toBeNull();

      const response = await POST(request);

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("BAD_REQUEST");
    });

    it("上限を超えた時点で読むのをやめる（本文全体を受け取らない）", async () => {
      const totalBytes = MAX_TELEMETRY_BODY_BYTES * 16; // 4096 バイト
      const pulled = { bytes: 0 };

      const response = await POST(chunkedRequest(totalBytes, pulled));

      expect(response.status).toBe(400);
      // 読んだ量は上限 + 1 チャンク以内で止まっている。本文全体は受け取っていない。
      expect(pulled.bytes).toBeLessThanOrEqual(MAX_TELEMETRY_BODY_BYTES + CHUNK_BYTES * 2);
      expect(pulled.bytes).toBeLessThan(totalBytes);
    });

    it("レート制限の判定は本文を読む前に終わっている（本文に触れずに 503）", async () => {
      // バックエンドが無い ＝ fail-closed で 503。この判定が本文読み込みより後にあると、
      // 「制限に掛かる相手の本文を先に全部読む」ことになる。
      delete cloudflareEnv["ALLOW_LOCAL_RATE_LIMIT_BYPASS"];
      const pulled = { bytes: 0 };
      const totalBytes = MAX_TELEMETRY_BODY_BYTES * 16;
      const request = chunkedRequest(totalBytes, pulled);

      const response = await POST(request);

      expect(response.status).toBe(503);
      // ルートが本文へ触れていないことの直接の証拠。`bodyUsed` は本文ストリームが
      // disturbed になった時点で true になる。
      expect(request.bodyUsed).toBe(false);
      expect(request.body?.locked).toBe(false);
      // 送出済みの 1 チャンクは `ReadableStream` 既定の highWaterMark（1 チャンク）による
      // 先読みであり、受け手とは無関係に出る（誰も触れなくても 64 バイト出ることを実測した）。
      expect(pulled.bytes).toBeLessThanOrEqual(CHUNK_BYTES);
      expect(pulled.bytes).toBeLessThan(totalBytes);
    });
  });

  it("レート制限のバックエンドが無ければ fail-closed で 503", async () => {
    delete cloudflareEnv["ALLOW_LOCAL_RATE_LIMIT_BYPASS"];

    const response = await POST(telemetryRequest({ code: CLIENT_ERROR_CODES.SCRIPT_ERROR }));

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("RATE_LIMIT_UNAVAILABLE");
  });

  it("設定が壊れていても記録は続ける（設定不正こそ拾いたい事象）", async () => {
    delete cloudflareEnv["LINE_ENV_PROFILE"];

    const response = await POST(telemetryRequest({ code: CLIENT_ERROR_CODES.LIFF_INIT_FAILED }));

    expect(response.status).toBe(202);
    const record = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry["event"] === "telemetry.client_error");
    expect(record?.["code"]).toBe("liff_init_failed");
    expect(record?.["liffIdFingerprint"]).toBeUndefined();
  });
});
