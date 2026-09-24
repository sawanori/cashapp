/**
 * GET /api/health のユニットテスト、および DB 側 degraded 判定（`src/lib/health.ts`）の
 * ユニットテスト。
 *
 * task_003 では静的な `{ status: "ok" }` を返すだけだった。task_012 で
 * 環境設定の fingerprint（pepper / liffId / channelId）を返すようになり、
 * 設定が不正なら 503 + `status: "degraded"` を返す（check_074 / check_076 の外形側）。
 *
 * task_023 で `src/lib/health.ts` の DB 側 degraded 判定（DB 疎通・reconcile 鮮度・
 * outbox 滞留・直近 Webhook 受信。check_114）を追加した。
 *   - `describe("assessDbHealth")` は 4 条件それぞれを合成行（モックの `HealthDbReader`）で検証する。
 *     実 DB にも `src/lib/outbox.ts`（task_018 並行ドラフト中）にも依存しない。
 *   - `describe("GET /api/health — DB 側 degraded")` はルートへの配線（503 + 詳細非公開の
 *     `code: "DEGRADED"`）を、`@/lib/db/client` をモックして確認する。
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

/**
 * DB クライアントは合成行を返すスタブに差し替える。既定（`resetFakeDb()`）はすべて「シグナル無し」
 * （degraded にならない）。クエリの振り分けは SQL 文字列に含まれるテーブル名で行う
 * （`src/lib/health.ts` の `createSqlHealthReader` が発行する 4 種類のクエリのどれかに必ず一致する）。
 */
interface FakeDbBehavior {
  throwOnConnect: boolean;
  reconciliationRunStartedAt: Date | null;
  oldestPendingOutboxCreatedAt: Date | null;
  hasOpenPaymentAttempt: boolean;
  hasRecentWebhookDelivery: boolean;
}

function healthyFakeDbBehavior(): FakeDbBehavior {
  return {
    throwOnConnect: false,
    reconciliationRunStartedAt: null,
    oldestPendingOutboxCreatedAt: null,
    hasOpenPaymentAttempt: false,
    hasRecentWebhookDelivery: true,
  };
}

let fakeDbBehavior: FakeDbBehavior = healthyFakeDbBehavior();
const dbClientCalls: string[] = [];

vi.mock("@/lib/db/client", () => ({
  createVerifiedDbClient: async () => {
    dbClientCalls.push("createVerifiedDbClient");
    if (fakeDbBehavior.throwOnConnect) {
      throw new Error("simulated: database unreachable");
    }
    const fakeSql = async (strings: TemplateStringsArray): Promise<unknown[]> => {
      const text = strings.join(" ");
      if (text.includes("reconciliation_run")) {
        return fakeDbBehavior.reconciliationRunStartedAt === null
          ? []
          : [{ started_at: fakeDbBehavior.reconciliationRunStartedAt }];
      }
      if (text.includes("FROM outbox")) {
        return fakeDbBehavior.oldestPendingOutboxCreatedAt === null
          ? []
          : [{ created_at: fakeDbBehavior.oldestPendingOutboxCreatedAt }];
      }
      if (text.includes("payment_attempt")) {
        return [{ found: fakeDbBehavior.hasOpenPaymentAttempt }];
      }
      if (text.includes("webhook_delivery")) {
        return [{ found: fakeDbBehavior.hasRecentWebhookDelivery }];
      }
      throw new Error(`unexpected query in test: ${text}`);
    };
    return {
      sql: fakeSql as never,
      close: async (): Promise<void> => undefined,
    };
  },
}));

const { GET } = await import("@/app/api/health/route");
const { MIN_SECRET_BYTES, configFingerprints, loadAppConfig } = await import("@/lib/config/env");
const {
  assessDbHealth,
  RECONCILE_STALE_THRESHOLD_SECONDS,
  OUTBOX_OLDEST_PENDING_THRESHOLD_SECONDS,
} = await import("@/lib/health");

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
  fakeDbBehavior = healthyFakeDbBehavior();
  dbClientCalls.length = 0;
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

  it("設定が不正なら 503 degraded を返し、理由の詳細は出さない。DB には到達しない", async () => {
    setEnv({ ...VALID_ENV, PEPPER: undefined });
    const res = await GET();

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("degraded");
    expect(body["code"]).toBe("CONFIG_INVALID");
    expect(body["pepperFingerprint"]).toBeUndefined();
    // ★ 設定不正はガードの最初で弾く。DB クライアントに一切到達しない
    //   （tests/unit/auth/line-route.test.ts の F-2 と同じ方針）。
    expect(dbClientCalls).toEqual([]);
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

describe("GET /api/health — DB 側 degraded（task_023 / check_114）", () => {
  it("DB 側にシグナルが無ければ設定が正しい限り 200 を返す（DB クライアントには到達する）", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(dbClientCalls).toEqual(["createVerifiedDbClient"]);
  });

  it("reconcile の最新実行が 900 秒超なら 503 degraded（理由の詳細は出さない）", async () => {
    fakeDbBehavior.reconciliationRunStartedAt = new Date(
      Date.now() - (RECONCILE_STALE_THRESHOLD_SECONDS + 60) * 1000,
    );

    const res = await GET();

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("degraded");
    expect(body["code"]).toBe("DEGRADED");
    expect(Object.keys(body).sort()).toEqual(["code", "status"]);
  });

  it("outbox の未処理最古行が 24 時間超なら 503 degraded", async () => {
    fakeDbBehavior.oldestPendingOutboxCreatedAt = new Date(
      Date.now() - (OUTBOX_OLDEST_PENDING_THRESHOLD_SECONDS + 60) * 1000,
    );

    const res = await GET();

    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("DEGRADED");
  });

  it("open attempt があるのに直近 1 時間 Webhook が 0 件なら 503 degraded", async () => {
    fakeDbBehavior.hasOpenPaymentAttempt = true;
    fakeDbBehavior.hasRecentWebhookDelivery = false;

    const res = await GET();

    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>)["code"]).toBe("DEGRADED");
  });

  it("open attempt があっても直近に Webhook が届いていれば 200 のまま", async () => {
    fakeDbBehavior.hasOpenPaymentAttempt = true;
    fakeDbBehavior.hasRecentWebhookDelivery = true;

    expect((await GET()).status).toBe(200);
  });

  it("DB 接続自体が失敗しても 503 degraded を返す（詳細は出さない）", async () => {
    fakeDbBehavior.throwOnConnect = true;

    const res = await GET();

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("degraded");
    expect(body["code"]).toBe("DEGRADED");
    expect(JSON.stringify(body)).not.toContain("simulated");
  });
});

describe("assessDbHealth（合成行での 4 条件検証。実 DB にも task_018 にも依存しない）", () => {
  interface ReaderStub {
    latestReconciliationRunStartedAt: () => Promise<Date | null>;
    oldestPendingOutboxCreatedAt: () => Promise<Date | null>;
    hasOpenPaymentAttempt: () => Promise<boolean>;
    hasWebhookDeliverySince: (since: Date) => Promise<boolean>;
  }

  function healthyReader(overrides: Partial<ReaderStub> = {}): ReaderStub {
    return {
      latestReconciliationRunStartedAt: async () => null,
      oldestPendingOutboxCreatedAt: async () => null,
      hasOpenPaymentAttempt: async () => false,
      hasWebhookDeliverySince: async () => true,
      ...overrides,
    };
  }

  const NOW = new Date("2026-09-25T00:00:00.000Z");

  it("シグナルが無ければ degraded ではない", async () => {
    const result = await assessDbHealth(healthyReader(), NOW);

    expect(result.degraded).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("条件 1 — DB 疎通失敗: reader が例外を投げたら db_unreachable 単独になる", async () => {
    const reader = healthyReader({
      latestReconciliationRunStartedAt: async () => {
        throw new Error("connection refused");
      },
    });

    const result = await assessDbHealth(reader, NOW);

    expect(result.degraded).toBe(true);
    expect(result.reasons).toEqual(["db_unreachable"]);
  });

  it("条件 2 — reconcile 鮮度 900 秒超で degraded（reconcile_stale）", async () => {
    const stale = new Date(NOW.getTime() - (RECONCILE_STALE_THRESHOLD_SECONDS + 1) * 1000);
    const reader = healthyReader({ latestReconciliationRunStartedAt: async () => stale });

    const result = await assessDbHealth(reader, NOW);

    expect(result.degraded).toBe(true);
    expect(result.reasons).toContain("reconcile_stale");
  });

  it("900 秒以内なら reconcile 条件は degraded にならない（境界）", async () => {
    const fresh = new Date(NOW.getTime() - (RECONCILE_STALE_THRESHOLD_SECONDS - 1) * 1000);
    const reader = healthyReader({ latestReconciliationRunStartedAt: async () => fresh });

    const result = await assessDbHealth(reader, NOW);

    expect(result.degraded).toBe(false);
  });

  it("reconciliation_run が 1 行も無ければ degraded にならない（producer 不在時の既定）", async () => {
    const result = await assessDbHealth(healthyReader(), NOW);

    expect(result.degraded).toBe(false);
    expect(result.reasons).not.toContain("reconcile_stale");
  });

  it("条件 3 — outbox 最古行の経過が 24 時間超で degraded（outbox_stale）", async () => {
    const old = new Date(NOW.getTime() - (OUTBOX_OLDEST_PENDING_THRESHOLD_SECONDS + 1) * 1000);
    const reader = healthyReader({ oldestPendingOutboxCreatedAt: async () => old });

    const result = await assessDbHealth(reader, NOW);

    expect(result.degraded).toBe(true);
    expect(result.reasons).toContain("outbox_stale");
  });

  it("outbox に未処理行が無ければ degraded にならない", async () => {
    const result = await assessDbHealth(healthyReader(), NOW);

    expect(result.reasons).not.toContain("outbox_stale");
  });

  it("条件 4 — open attempt があるのに直近 1 時間 Webhook が 0 件で degraded（webhook_silent）", async () => {
    const reader = healthyReader({
      hasOpenPaymentAttempt: async () => true,
      hasWebhookDeliverySince: async () => false,
    });

    const result = await assessDbHealth(reader, NOW);

    expect(result.degraded).toBe(true);
    expect(result.reasons).toContain("webhook_silent");
  });

  it("open attempt があっても直近 Webhook があれば degraded にならない", async () => {
    const reader = healthyReader({
      hasOpenPaymentAttempt: async () => true,
      hasWebhookDeliverySince: async () => true,
    });

    const result = await assessDbHealth(reader, NOW);

    expect(result.degraded).toBe(false);
  });

  it("open attempt が無ければ Webhook 受信の有無を問わない（呼ばれない）", async () => {
    let webhookCheckCalled = false;
    const reader = healthyReader({
      hasOpenPaymentAttempt: async () => false,
      hasWebhookDeliverySince: async () => {
        webhookCheckCalled = true;
        return false;
      },
    });

    const result = await assessDbHealth(reader, NOW);

    expect(result.degraded).toBe(false);
    expect(webhookCheckCalled).toBe(false);
  });

  it("複数条件が同時に成立すれば reasons に複数入る", async () => {
    const stale = new Date(NOW.getTime() - (RECONCILE_STALE_THRESHOLD_SECONDS + 1) * 1000);
    const old = new Date(NOW.getTime() - (OUTBOX_OLDEST_PENDING_THRESHOLD_SECONDS + 1) * 1000);
    const reader = healthyReader({
      latestReconciliationRunStartedAt: async () => stale,
      oldestPendingOutboxCreatedAt: async () => old,
      hasOpenPaymentAttempt: async () => true,
      hasWebhookDeliverySince: async () => false,
    });

    const result = await assessDbHealth(reader, NOW);

    expect(result.degraded).toBe(true);
    expect(result.reasons).toEqual(["reconcile_stale", "outbox_stale", "webhook_silent"]);
  });
});
