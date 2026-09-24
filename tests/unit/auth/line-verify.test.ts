/**
 * `src/lib/auth/line-verify.ts` と `src/lib/auth/{used-token,rate-limit}.ts` のユニットテスト。
 *
 * acceptance-checks:
 *   - check_005: 改竄 / 期限切れ / aud 不一致 / exp ずれ 61 秒以上 → 401 ID_TOKEN_INVALID。
 *   - check_072: 同一 ID トークンの 2 回目 → 401、閾値超 → 429。
 *     （2 回目の 401 は DB を使う経路なので tests/integration/auth.test.ts でも通しで確かめる。
 *       ここでは単回使用ストアの契約と、429 が実際に投げられることを押さえる。）
 *
 * ADR: docs/decisions/ADR-009-id-token-single-use.md
 * 一次資料: docs/vendor-docs/line/verify.md（取得日 2026-09-24）
 */

import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

// errors.ts は `server-only` を読まないので素の静的 import でよい
// （`AppError` を型としても使うため、動的 import の分割代入では足りない）。
import { AppError, ERROR_CODES } from "@/lib/errors";

vi.mock("server-only", () => ({}));

const { loadAppConfig, MIN_SECRET_BYTES } = await import("@/lib/config/env");
const {
  ID_TOKEN_CLOCK_SKEW_SECONDS,
  LINE_ID_TOKEN_ISSUER,
  LINE_VERIFY_ENDPOINT,
  MAX_ID_TOKEN_LENGTH,
  authenticateWithLineIdToken,
  readIdTokenFromBody,
  verifyLineIdToken,
} = await import("@/lib/auth/line-verify");
const { idTokenUsageKey } = await import("@/lib/auth/used-token");
const {
  AUTH_RATE_LIMIT_MAX_REQUESTS,
  FixedWindowRateLimiterDurableObject,
  RateLimiterUnavailableError,
  resolveRateLimiter,
} = await import("@/lib/auth/rate-limit");

const LOGIN_CHANNEL_ID = "2000000000";
const SUB = "Ufedcba98765432100123456789abcdef";
const NOW = new Date("2026-09-24T00:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

const CONFIG = loadAppConfig({
  APP_ENV: "development",
  LINE_ENV_PROFILE: JSON.stringify({
    env: "development",
    liffId: `${LOGIN_CHANNEL_ID}-abcd1234`,
    loginChannelId: LOGIN_CHANNEL_ID,
  }),
  PEPPER: `1:${"p".repeat(MIN_SECRET_BYTES)}`,
  SESSION_KEYS: `k1:${"s".repeat(MIN_SECRET_BYTES)}`,
  CRON_SECRETS: "c".repeat(MIN_SECRET_BYTES),
});

function verifyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: LINE_ID_TOKEN_ISSUER,
    sub: SUB,
    aud: LOGIN_CHANNEL_ID,
    exp: NOW_SECONDS + 3600,
    iat: NOW_SECONDS - 10,
    ...overrides,
  };
}

function fetchReturning(
  body: unknown,
  init: { status?: number; json?: boolean } = {},
): typeof fetch {
  const stub = async (): Promise<Response> => {
    if (init.json === false) {
      return new Response("not json", { status: init.status ?? 200 });
    }
    return Response.json(body, { status: init.status ?? 200 });
  };
  return stub as unknown as typeof fetch;
}

async function expectIdTokenInvalid(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(ERROR_CODES.ID_TOKEN_INVALID);
    expect(appError.status).toBe(401);
    return appError;
  }
  throw new Error("expected the call to throw ID_TOKEN_INVALID");
}

describe("verifyLineIdToken — 一次資料どおりのリクエストを送る（制約 N3）", () => {
  it("POST で application/x-www-form-urlencoded、client_id は LINE Login チャネル ID", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const spyFetch = (async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return Response.json(verifyPayload());
    }) as unknown as typeof fetch;

    await verifyLineIdToken({
      idToken: "header.payload.signature",
      loginChannelId: LOGIN_CHANNEL_ID,
      now: NOW,
      fetchImpl: spyFetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(LINE_VERIFY_ENDPOINT);
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.get("client_id")).toBe(LOGIN_CHANNEL_ID);
    expect(body.get("id_token")).toBe("header.payload.signature");
    // nonce は送らない（ADR-009）。
    expect(body.get("nonce")).toBeNull();
  });

  it("正常なペイロードは sub / aud / exp / iat を返す", async () => {
    const payload = await verifyLineIdToken({
      idToken: "t",
      loginChannelId: LOGIN_CHANNEL_ID,
      now: NOW,
      fetchImpl: fetchReturning(verifyPayload()),
    });
    expect(payload.sub).toBe(SUB);
    expect(payload.aud).toBe(LOGIN_CHANNEL_ID);
  });
});

describe("verifyLineIdToken — 401 になる条件（check_005）", () => {
  it("LINE が 2xx 以外を返したら 401（改竄・署名不正はここに落ちる）", async () => {
    await expectIdTokenInvalid(() =>
      verifyLineIdToken({
        idToken: "tampered",
        loginChannelId: LOGIN_CHANNEL_ID,
        now: NOW,
        fetchImpl: fetchReturning({ error_description: "Invalid IdToken." }, { status: 400 }),
      }),
    );
  });

  it("aud が期待するチャネル ID と違えば 401", async () => {
    await expectIdTokenInvalid(() =>
      verifyLineIdToken({
        idToken: "t",
        loginChannelId: LOGIN_CHANNEL_ID,
        now: NOW,
        fetchImpl: fetchReturning(verifyPayload({ aud: "1999999999" })),
      }),
    );
  });

  it("iss が LINE 以外なら 401", async () => {
    await expectIdTokenInvalid(() =>
      verifyLineIdToken({
        idToken: "t",
        loginChannelId: LOGIN_CHANNEL_ID,
        now: NOW,
        fetchImpl: fetchReturning(verifyPayload({ iss: "https://evil.example" })),
      }),
    );
  });

  it(`exp が ${ID_TOKEN_CLOCK_SKEW_SECONDS + 1} 秒以上前なら 401`, async () => {
    await expectIdTokenInvalid(() =>
      verifyLineIdToken({
        idToken: "t",
        loginChannelId: LOGIN_CHANNEL_ID,
        now: NOW,
        fetchImpl: fetchReturning(
          verifyPayload({ exp: NOW_SECONDS - ID_TOKEN_CLOCK_SKEW_SECONDS - 1 }),
        ),
      }),
    );
  });

  it(`exp の超過が ${ID_TOKEN_CLOCK_SKEW_SECONDS} 秒以内なら通る（許容ずれ）`, async () => {
    const payload = await verifyLineIdToken({
      idToken: "t",
      loginChannelId: LOGIN_CHANNEL_ID,
      now: NOW,
      fetchImpl: fetchReturning(verifyPayload({ exp: NOW_SECONDS - ID_TOKEN_CLOCK_SKEW_SECONDS })),
    });
    expect(payload.sub).toBe(SUB);
  });

  it(`iat が ${ID_TOKEN_CLOCK_SKEW_SECONDS + 1} 秒以上未来なら 401`, async () => {
    await expectIdTokenInvalid(() =>
      verifyLineIdToken({
        idToken: "t",
        loginChannelId: LOGIN_CHANNEL_ID,
        now: NOW,
        fetchImpl: fetchReturning(
          verifyPayload({ iat: NOW_SECONDS + ID_TOKEN_CLOCK_SKEW_SECONDS + 1 }),
        ),
      }),
    );
  });

  it("sub が LINE の userId の形（U + 32 hex）でなければ 401", async () => {
    await expectIdTokenInvalid(() =>
      verifyLineIdToken({
        idToken: "t",
        loginChannelId: LOGIN_CHANNEL_ID,
        now: NOW,
        fetchImpl: fetchReturning(verifyPayload({ sub: "not-a-line-user-id" })),
      }),
    );
  });

  it("iss / sub / aud / exp / iat が欠けていれば 401", async () => {
    for (const missing of ["iss", "sub", "aud", "exp", "iat"]) {
      const payload = verifyPayload();
      delete payload[missing];
      await expectIdTokenInvalid(() =>
        verifyLineIdToken({
          idToken: "t",
          loginChannelId: LOGIN_CHANNEL_ID,
          now: NOW,
          fetchImpl: fetchReturning(payload),
        }),
      );
    }
  });

  it("JSON でない応答なら 401", async () => {
    await expectIdTokenInvalid(() =>
      verifyLineIdToken({
        idToken: "t",
        loginChannelId: LOGIN_CHANNEL_ID,
        now: NOW,
        fetchImpl: fetchReturning(null, { json: false }),
      }),
    );
  });

  it("fetch が例外を投げても 401 に畳まれる（URL やヘッダを外に出さない）", async () => {
    const throwing = (async (): Promise<Response> => {
      throw new Error("connect ECONNREFUSED https://api.line.me");
    }) as unknown as typeof fetch;
    const error = await expectIdTokenInvalid(() =>
      verifyLineIdToken({
        idToken: "t",
        loginChannelId: LOGIN_CHANNEL_ID,
        now: NOW,
        fetchImpl: throwing,
      }),
    );
    expect(error.message).not.toContain("ECONNREFUSED");
  });

  it("長すぎる ID トークンは LINE に投げる前に 401", async () => {
    let called = false;
    const spy = (async (): Promise<Response> => {
      called = true;
      return Response.json(verifyPayload());
    }) as unknown as typeof fetch;
    await expectIdTokenInvalid(() =>
      verifyLineIdToken({
        idToken: "x".repeat(MAX_ID_TOKEN_LENGTH + 1),
        loginChannelId: LOGIN_CHANNEL_ID,
        now: NOW,
        fetchImpl: spy,
      }),
    );
    expect(called).toBe(false);
  });

  it("ID トークン本体が例外メッセージに出ない（R-SEC-04）", async () => {
    const secretToken = "header.SECRETPAYLOAD.signature";
    const error = await expectIdTokenInvalid(() =>
      verifyLineIdToken({
        idToken: secretToken,
        loginChannelId: LOGIN_CHANNEL_ID,
        now: NOW,
        fetchImpl: fetchReturning({ error_description: "Invalid IdToken." }, { status: 400 }),
      }),
    );
    expect(`${error.message}${error.detail ?? ""}`).not.toContain("SECRETPAYLOAD");
  });
});

describe("readIdTokenFromBody", () => {
  it("idToken を取り出す", () => {
    expect(readIdTokenFromBody({ idToken: "abc" })).toBe("abc");
  });

  it.each([[null], ["string"], [[]], [{}], [{ idToken: 1 }], [{ idToken: "" }]])(
    "形が違えば 400 BAD_REQUEST: %s",
    (body) => {
      try {
        readIdTokenFromBody(body);
        throw new Error("expected readIdTokenFromBody to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(ERROR_CODES.BAD_REQUEST);
        expect((error as AppError).status).toBe(400);
      }
    },
  );

  it("decodedIdToken / profile を送っても無視される（制約 N2）", () => {
    expect(
      readIdTokenFromBody({ idToken: "abc", decodedIdToken: { sub: "Uspoofed" }, profile: {} }),
    ).toBe("abc");
  });
});

describe("idTokenUsageKey（単回使用キー / ADR-009）", () => {
  it("jti が無ければ sha256(idToken) を使う", async () => {
    const key = await idTokenUsageKey("token-a", undefined);
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(key).not.toContain("token-a");
  });

  it("同じトークンからは同じキー、違うトークンからは違うキー", async () => {
    expect(await idTokenUsageKey("token-a", undefined)).toBe(
      await idTokenUsageKey("token-a", undefined),
    );
    expect(await idTokenUsageKey("token-a", undefined)).not.toBe(
      await idTokenUsageKey("token-b", undefined),
    );
  });

  it("jti があればそちらを優先する", async () => {
    expect(await idTokenUsageKey("token-a", "jti-1")).toBe("jti:jti-1");
  });
});

describe("resolveRateLimiter（A27: in-memory を使わない）", () => {
  it("Rate Limiting バインディングがあればそれを使う", async () => {
    const seen: string[] = [];
    const limiter = resolveRateLimiter({
      AUTH_RATE_LIMITER: {
        limit: async ({ key }) => {
          seen.push(key);
          return { success: true };
        },
      },
    });
    const decision = await limiter.check("auth-line:abc");
    expect(decision).toEqual({ allowed: true, backend: "workers-rate-limit-binding" });
    expect(seen).toEqual(["auth-line:abc"]);
  });

  it("バインディングが false を返せば allowed=false", async () => {
    const limiter = resolveRateLimiter({
      AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
    });
    expect((await limiter.check("k")).allowed).toBe(false);
  });

  it("バインディングが無ければ Durable Object を使う", async () => {
    const limiter = resolveRateLimiter({
      AUTH_RATE_LIMITER_DO: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async () => Response.json({ allowed: false, count: 999 }),
        }),
      },
    });
    expect(await limiter.check("k")).toEqual({ allowed: false, backend: "durable-object" });
  });

  it("Durable Object が失敗したら通さない（fail-closed）", async () => {
    const limiter = resolveRateLimiter({
      AUTH_RATE_LIMITER_DO: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response("boom", { status: 500 }) }),
      },
    });
    expect((await limiter.check("k")).allowed).toBe(false);
  });

  it("どちらも無ければ例外（in-memory へフォールバックしない）", () => {
    expect(() => resolveRateLimiter({})).toThrow(RateLimiterUnavailableError);
  });

  it.each([
    [{ ALLOW_LOCAL_RATE_LIMIT_BYPASS: "1", APP_ENV: "development" }, true],
    [{ ALLOW_LOCAL_RATE_LIMIT_BYPASS: "0", APP_ENV: "development" }, false],
    [{ ALLOW_LOCAL_RATE_LIMIT_BYPASS: "1", APP_ENV: "staging" }, false],
    [{ ALLOW_LOCAL_RATE_LIMIT_BYPASS: "1", APP_ENV: "production" }, false],
    [{ APP_ENV: "development" }, false],
    [
      { ALLOW_LOCAL_RATE_LIMIT_BYPASS: "1", APP_ENV: "development", HYPERDRIVE: {} },
      false,
    ],
  ])("ローカル逃げ道は 3 条件すべてが揃ったときだけ（%o → %s）", (env, allowed) => {
    if (allowed) {
      expect(() => resolveRateLimiter(env)).not.toThrow();
    } else {
      expect(() => resolveRateLimiter(env)).toThrow(RateLimiterUnavailableError);
    }
  });
});

describe("FixedWindowRateLimiterDurableObject", () => {
  function fakeState(): { state: { storage: { get: <T>(k: string) => Promise<T | undefined>; put: <T>(k: string, v: T) => Promise<void> } } } {
    const store = new Map<string, unknown>();
    return {
      state: {
        storage: {
          get: async <T,>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
          put: async <T,>(key: string, value: T): Promise<void> => {
            store.set(key, value);
          },
        },
      },
    };
  }

  function request(limit: number): Request {
    return new Request("https://rate-limiter.invalid/limit", {
      method: "POST",
      body: JSON.stringify({ key: "k", limit, windowSeconds: 60 }),
    });
  }

  it("閾値までは allowed、超えたら allowed=false", async () => {
    const { state } = fakeState();
    let now = 1_000_000;
    const object = new FixedWindowRateLimiterDurableObject(state, () => now);

    for (let i = 0; i < 3; i += 1) {
      const response = await object.fetch(request(3));
      await expect(response.json()).resolves.toEqual({ allowed: true, count: i + 1 });
    }
    const over = await object.fetch(request(3));
    await expect(over.json()).resolves.toEqual({ allowed: false, count: 4 });

    // ウィンドウが明けたらカウンタが戻る。
    now += 60_000;
    const afterWindow = await object.fetch(request(3));
    await expect(afterWindow.json()).resolves.toEqual({ allowed: true, count: 1 });
  });

  it("既定の閾値はモジュール定数から来る", async () => {
    const { state } = fakeState();
    const object = new FixedWindowRateLimiterDurableObject(state, () => 0);
    const response = await object.fetch(
      new Request("https://rate-limiter.invalid/limit", {
        method: "POST",
        body: JSON.stringify({ key: "k" }),
      }),
    );
    const body = (await response.json()) as { allowed: boolean };
    expect(body.allowed).toBe(true);
    expect(AUTH_RATE_LIMIT_MAX_REQUESTS).toBeGreaterThan(0);
  });
});

describe("authenticateWithLineIdToken — レート制限（check_072 の 429）", () => {
  it("閾値超なら 429 を投げ、LINE への検証にも DB にも到達しない", async () => {
    let fetchCalled = false;
    const spyFetch = (async (): Promise<Response> => {
      fetchCalled = true;
      return Response.json(verifyPayload());
    }) as unknown as typeof fetch;

    // レート制限で落ちるので sql には触れない。触れたら参照エラーで落ちるため、
    // 「到達していない」ことがこのダミーで担保される。
    const unusedSql = undefined as unknown as postgres.Sql;

    try {
      await authenticateWithLineIdToken(
        {
          config: CONFIG,
          sql: unusedSql,
          usedTokenStore: {
            markUsed: async () => {
              throw new Error("used-token store must not be reached");
            },
          },
          rateLimiter: {
            check: async () => ({ allowed: false, backend: "workers-rate-limit-binding" }),
          },
          clientIp: "203.0.113.9",
          now: NOW,
          fetchImpl: spyFetch,
        },
        "some-id-token",
      );
      throw new Error("expected authenticateWithLineIdToken to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ERROR_CODES.RATE_LIMITED);
      expect((error as AppError).status).toBe(429);
    }
    expect(fetchCalled).toBe(false);
  });

  it("レート制限のキーは生 IP ではない（HMAC 済みの参照値）", async () => {
    const keys: string[] = [];
    const unusedSql = undefined as unknown as postgres.Sql;
    await authenticateWithLineIdToken(
      {
        config: CONFIG,
        sql: unusedSql,
        usedTokenStore: { markUsed: async () => true },
        rateLimiter: {
          check: async (key) => {
            keys.push(key);
            return { allowed: false, backend: "durable-object" };
          },
        },
        clientIp: "203.0.113.9",
        now: NOW,
        fetchImpl: fetchReturning(verifyPayload()),
      },
      "some-id-token",
    ).catch(() => undefined);

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^auth-line:[0-9a-f]{16}$/);
    expect(keys[0]).not.toContain("203.0.113.9");
  });
});
