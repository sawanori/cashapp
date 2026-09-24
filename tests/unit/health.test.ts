/**
 * GET /api/health のユニットテスト。
 *
 * task_003 では静的な `{ status: "ok" }` を返すだけだった。task_012 で
 * 環境設定の fingerprint（pepper / liffId / channelId）を返すようになり、
 * 設定が不正なら 503 + `status: "degraded"` を返す（check_074 / check_076 の外形側）。
 * DB 疎通・reconcile 鮮度・outbox 滞留を見た degraded 判定は task_023。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * ルートは `@opennextjs/cloudflare` の `getCloudflareContext()` で Workers の env を取る。
 * ユニットテストでは platform proxy が無いので、テストが用意した env を返すモックに差し替える。
 */
const cloudflareEnv: Record<string, string | undefined> = {};
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({ env: cloudflareEnv, cf: undefined, ctx: undefined }),
}));

const { GET } = await import("@/app/api/health/route");
const { MIN_SECRET_BYTES, configFingerprints, loadAppConfig } = await import("@/lib/config/env");

const PEPPER = "p".repeat(MIN_SECRET_BYTES);

const VALID_ENV = {
  APP_ENV: "development",
  LINE_ENV_PROFILE: JSON.stringify({
    env: "development",
    liffId: "2000000000-abcd1234",
    loginChannelId: "2000000000",
  }),
  PEPPER: `1:${PEPPER}`,
  SESSION_KEYS: `k1:${"s".repeat(MIN_SECRET_BYTES)}`,
  CRON_SECRETS: "c".repeat(MIN_SECRET_BYTES),
} as const;

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of Object.keys(cloudflareEnv)) {
    delete cloudflareEnv[key];
  }
  Object.assign(cloudflareEnv, values);
}

beforeEach(() => {
  setEnv({ ...VALID_ENV });
});

describe("GET /api/health", () => {
  it("設定が揃っていれば 200 で ok を返す", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["appEnv"]).toBe("development");
  });

  it("pepper / liffId / channelId の fingerprint を返す（check_074 / check_076）", async () => {
    const body = (await (await GET()).json()) as Record<string, unknown>;

    expect(body["pepperVersion"]).toBe(1);
    expect(body["pepperFingerprint"]).toMatch(/^[0-9a-f]{16}$/);
    expect(body["liffIdFingerprint"]).toMatch(/^[0-9a-f]{16}$/);
    expect(body["channelIdFingerprint"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("fingerprint は設定から決まる値と一致する（環境間の比較に使える）", async () => {
    const expected = await configFingerprints(loadAppConfig(VALID_ENV));
    const body = (await (await GET()).json()) as Record<string, unknown>;

    expect(body["pepperFingerprint"]).toBe(expected.pepperFingerprint);
    expect(body["liffIdFingerprint"]).toBe(expected.liffIdFingerprint);
    expect(body["channelIdFingerprint"]).toBe(expected.channelIdFingerprint);
  });

  it("秘密値そのものは応答に出ない", async () => {
    const text = await (await GET()).text();

    expect(text).not.toContain(PEPPER);
    expect(text).not.toContain("s".repeat(MIN_SECRET_BYTES));
    expect(text).not.toContain("c".repeat(MIN_SECRET_BYTES));
  });

  it("PEPPER を変えると pepperFingerprint が変わる（環境の取り違えが外から見える）", async () => {
    const before = (await (await GET()).json()) as Record<string, unknown>;
    setEnv({ ...VALID_ENV, PEPPER: `1:${"q".repeat(MIN_SECRET_BYTES)}` });
    const after = (await (await GET()).json()) as Record<string, unknown>;

    expect(after["pepperFingerprint"]).not.toBe(before["pepperFingerprint"]);
    expect(after["liffIdFingerprint"]).toBe(before["liffIdFingerprint"]);
  });

  it("設定が不正なら 503 degraded を返し、理由の詳細は出さない", async () => {
    setEnv({ ...VALID_ENV, PEPPER: undefined });
    const res = await GET();

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("degraded");
    expect(body["code"]).toBe("CONFIG_INVALID");
    expect(body["pepperFingerprint"]).toBeUndefined();
  });

  it("APP_ENV と LINE_ENV_PROFILE が食い違えば 503（R-LINE-04）", async () => {
    setEnv({
      ...VALID_ENV,
      APP_ENV: "staging",
      LINE_ENV_PROFILE: JSON.stringify({
        env: "development",
        liffId: "2000000000-abcd1234",
        loginChannelId: "2000000000",
      }),
    });

    expect((await GET()).status).toBe(503);
  });
});
