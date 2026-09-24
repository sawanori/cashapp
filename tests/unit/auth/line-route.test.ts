/**
 * `POST /api/auth/line`（ルートハンドラそのもの）のユニットテスト。
 *
 * ここで見るのは **ルートの前段ガード**だけである。ID トークン検証・単回使用・
 * `app_user` の解決は `authenticateWithLineIdToken()` 側のテスト
 * （tests/unit/auth/line-verify.test.ts / tests/integration/auth.test.ts）が見る。
 *
 * 敵対レビュー（GPT-6 Astra, 2026-09-24）の指摘の再現と回帰:
 *   - F-1: Origin / Content-Type を見ず、追加フィールドも許容するため、攻撃者の
 *     未使用 ID トークンを別オリジンのフォーム（`enctype="text/plain"`）で
 *     被害者のブラウザから送らせると、被害者に攻撃者のセッション Cookie が発行される
 *     （ログイン CSRF / セッション固定）。
 *   - F-2: レート制限で弾くリクエストでも先に `createVerifiedDbClient()` を呼ぶため、
 *     429 になる乱打でも DB 接続と `SELECT session_user` が走る。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "@/lib/errors";

vi.mock("server-only", () => ({}));

/** ルートは `getCloudflareContext()` から env を取る（tests/unit/health.test.ts と同じ差し替え）。 */
const cloudflareEnv: Record<string, unknown> = {};
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({ env: cloudflareEnv, cf: undefined, ctx: undefined }),
}));

/**
 * DB クライアントは「到達したか」を数えるスパイに差し替える。
 * F-2 の「制限超過時は DB に到達しない」は、この配列が空であることで実測する。
 */
const dbClientCalls: string[] = [];
vi.mock("@/lib/db/client", () => ({
  createVerifiedDbClient: async () => {
    dbClientCalls.push("createVerifiedDbClient");
    return {
      sql: (() => {
        throw new Error("sql must not be used in this test");
      }) as never,
      close: async (): Promise<void> => undefined,
    };
  },
}));

/** 単回使用ストアも DB を触らせない（ルートのガードだけを見るため）。 */
vi.mock("@/lib/auth/used-token", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/used-token")>();
  return { ...actual, createDbUsedIdTokenStore: () => ({ markUsed: async () => true }) };
});

const SESSION_EXPIRES_AT = new Date("2026-09-25T00:00:00Z");
const CANNED_RESULT = {
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    sessionEpoch: 1,
    status: "active" as const,
    pepperVersion: 1,
    identityScope: "line-provider-v1",
    lineEnv: "development",
  },
  session: {
    token: "header.payload.signature",
    jti: "jti-1",
    kid: "k1",
    expiresAt: SESSION_EXPIRES_AT,
  },
  csrfToken: "csrf-token-value-0123456789",
  migratedFromPepperVersion: null,
  created: true,
  rateLimitBackend: "workers-rate-limit-binding",
  userRefFingerprint: "0123456789abcdef",
};

/** 認証本体は差し替える。呼ばれた回数と受け取った idToken だけを記録する。 */
const authCalls: string[] = [];
vi.mock("@/lib/auth/line-verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/line-verify")>();
  return {
    ...actual,
    authenticateWithLineIdToken: async (_deps: unknown, idToken: string) => {
      authCalls.push(idToken);
      return CANNED_RESULT;
    },
  };
});

const { POST } = await import("@/app/api/auth/line/route");
const { MIN_SECRET_BYTES } = await import("@/lib/config/env");
const { SESSION_COOKIE_NAME } = await import("@/lib/auth/session");

const SELF_ORIGIN = "https://app.example";
const AUTH_URL = `${SELF_ORIGIN}/api/auth/line`;

const BASE_ENV: Record<string, unknown> = {
  APP_ENV: "development",
  LINE_ENV_PROFILE: JSON.stringify({
    env: "development",
    liffId: "2000000000-abcd1234",
    loginChannelId: "2000000000",
  }),
  PEPPER: `1:${"p".repeat(MIN_SECRET_BYTES)}`,
  SESSION_KEYS: `k1:${"s".repeat(MIN_SECRET_BYTES)}`,
  CRON_SECRETS: "c".repeat(MIN_SECRET_BYTES),
};

function setEnv(values: Record<string, unknown>): void {
  for (const key of Object.keys(cloudflareEnv)) delete cloudflareEnv[key];
  Object.assign(cloudflareEnv, values);
}

/** 許可するレート制限バインディング。 */
function allowingLimiter(): { limit: () => Promise<{ success: boolean }> } {
  return { limit: async () => ({ success: true }) };
}

/** LIFF（自オリジン）の正規リクエスト。ブラウザが実際に付けるヘッダを再現する。 */
function liffRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(AUTH_URL, {
    method: "POST",
    headers: {
      host: "app.example",
      origin: SELF_ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function errorBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  dbClientCalls.length = 0;
  authCalls.length = 0;
  setEnv({ ...BASE_ENV, AUTH_RATE_LIMITER: allowingLimiter() });
});

describe("POST /api/auth/line — 正規の LIFF リクエスト", () => {
  it("自オリジンからの application/json は 200 でセッション Cookie を返す", async () => {
    const response = await POST(liffRequest({ idToken: "id-token-ok" }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["csrfToken"]).toBe(CANNED_RESULT.csrfToken);
    expect(body["expiresAt"]).toBe(SESSION_EXPIRES_AT.toISOString());
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(authCalls).toEqual(["id-token-ok"]);
    // 正規経路では DB に到達する（F-2 のテストが「常に空」で緑になる偽陽性を防ぐ）。
    expect(dbClientCalls).toEqual(["createVerifiedDbClient"]);
  });

  it("content-type に charset が付いていても通る", async () => {
    const response = await POST(
      liffRequest({ idToken: "id-token-charset" }, { "content-type": "application/json; charset=UTF-8" }),
    );

    expect(response.status).toBe(200);
    expect(authCalls).toEqual(["id-token-charset"]);
  });

  it("Origin が無くても Sec-Fetch-Site: same-origin なら通る", async () => {
    const response = await POST(
      new Request(AUTH_URL, {
        method: "POST",
        headers: {
          host: "app.example",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ idToken: "id-token-no-origin" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(authCalls).toEqual(["id-token-no-origin"]);
  });
});

describe("F-1: クロスサイトからのログイン送信を拒否する（ログイン CSRF / セッション固定）", () => {
  it("別オリジンのフォーム（enctype=text/plain）からの送信は 403 で、認証にも DB にも到達しない", async () => {
    // 指摘の repro をそのまま再現する。text/plain のフォーム本文は有効な JSON になる。
    const formBody = '{"idToken":"attacker-id-token","padding":"="}';
    const response = await POST(
      new Request(AUTH_URL, {
        method: "POST",
        headers: {
          host: "app.example",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "content-type": "text/plain;charset=UTF-8",
        },
        body: formBody,
      }),
    );

    expect(response.status).toBe(403);
    expect((await errorBody(response))["code"]).toBe(ERROR_CODES.CSRF_INVALID);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(authCalls).toEqual([]);
    expect(dbClientCalls).toEqual([]);
  });

  it("Origin が別オリジンなら 403（Content-Type が JSON でも）", async () => {
    const response = await POST(
      liffRequest(
        { idToken: "attacker-id-token" },
        { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      ),
    );

    expect(response.status).toBe(403);
    expect((await errorBody(response))["code"]).toBe(ERROR_CODES.CSRF_INVALID);
    expect(authCalls).toEqual([]);
  });

  it("Origin が 'null'（サンドボックス化された iframe 等）なら 403", async () => {
    const response = await POST(liffRequest({ idToken: "x" }, { origin: "null" }));

    expect(response.status).toBe(403);
    expect(authCalls).toEqual([]);
  });

  it("Origin も Sec-Fetch-Site も無いリクエストは 403（fail-closed）", async () => {
    const response = await POST(
      new Request(AUTH_URL, {
        method: "POST",
        headers: { host: "app.example", "content-type": "application/json" },
        body: JSON.stringify({ idToken: "x" }),
      }),
    );

    expect(response.status).toBe(403);
    expect((await errorBody(response))["code"]).toBe(ERROR_CODES.CSRF_INVALID);
    expect(authCalls).toEqual([]);
    expect(dbClientCalls).toEqual([]);
  });

  it("Sec-Fetch-Site が same-site / none なら 403", async () => {
    for (const site of ["same-site", "none"]) {
      dbClientCalls.length = 0;
      authCalls.length = 0;
      const response = await POST(
        new Request(AUTH_URL, {
          method: "POST",
          headers: {
            host: "app.example",
            "sec-fetch-site": site,
            "content-type": "application/json",
          },
          body: JSON.stringify({ idToken: "x" }),
        }),
      );
      expect(response.status).toBe(403);
      expect(authCalls).toEqual([]);
    }
  });

  it("JSON 以外の Content-Type は 415", async () => {
    const response = await POST(
      liffRequest('{"idToken":"x"}', { "content-type": "text/plain;charset=UTF-8" }),
    );

    expect(response.status).toBe(415);
    expect(authCalls).toEqual([]);
    expect(dbClientCalls).toEqual([]);
  });

  it("Content-Type が無いリクエストは 415", async () => {
    const request = new Request(AUTH_URL, {
      method: "POST",
      headers: {
        host: "app.example",
        origin: SELF_ORIGIN,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ idToken: "x" }),
    });
    request.headers.delete("content-type");

    const response = await POST(request);

    expect(response.status).toBe(415);
    expect(authCalls).toEqual([]);
  });

  it("未知のフィールドを含む本文は 400（idToken だけを受け取る。制約 N2）", async () => {
    const response = await POST(
      liffRequest({ idToken: "x", padding: "=", decodedIdToken: { sub: "Uspoofed" } }),
    );

    expect(response.status).toBe(400);
    expect((await errorBody(response))["code"]).toBe(ERROR_CODES.BAD_REQUEST);
    expect(authCalls).toEqual([]);
    expect(dbClientCalls).toEqual([]);
  });
});

describe("F-2: レート制限で拒否するリクエストは DB へ接続しない", () => {
  it("制限超過なら 429 を返し、createVerifiedDbClient() に到達しない", async () => {
    setEnv({ ...BASE_ENV, AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } });

    const response = await POST(liffRequest({ idToken: "id-token-rate-limited" }));

    expect(response.status).toBe(429);
    expect((await errorBody(response))["code"]).toBe(ERROR_CODES.RATE_LIMITED);
    expect(dbClientCalls).toEqual([]);
    expect(authCalls).toEqual([]);
  });

  it("バックエンドが 1 つも束縛されていなければ 503（fail-closed）で DB にも到達しない", async () => {
    setEnv({ ...BASE_ENV });

    const response = await POST(liffRequest({ idToken: "id-token-no-limiter" }));

    expect(response.status).toBe(503);
    expect((await errorBody(response))["code"]).toBe(ERROR_CODES.RATE_LIMIT_UNAVAILABLE);
    expect(dbClientCalls).toEqual([]);
  });

  it("レート制限のバックエンドは 1 リクエストにつき 1 回しか呼ばれない", async () => {
    let calls = 0;
    setEnv({
      ...BASE_ENV,
      AUTH_RATE_LIMITER: {
        limit: async () => {
          calls += 1;
          return { success: true };
        },
      },
    });

    const response = await POST(liffRequest({ idToken: "id-token-single-flight" }));

    expect(response.status).toBe(200);
    expect(calls).toBe(1);
  });
});
