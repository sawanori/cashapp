/**
 * CSRF 対策の統合テスト（check_058 / W6 / R-SEC-12）。
 *
 * `src/lib/auth/csrf.ts` の純粋関数（`assertSameOriginRequest` / `deriveCsrfToken` /
 * `assertCsrfToken` / `isCsrfExemptPath`）を厚く検査したうえで、実ルート境界でも
 * 「`X-CSRF-Token` 無しの POST（Webhook / cron / telemetry / preview を除く）→ 403」を
 * 実際に確かめる（check_058 の verification_method そのもの）。
 *
 * ★ 実ルート呼び出しは `POST /api/events` を使う。CSRF 検証は
 *   `createVerifiedDbClient()` → `requireSession()`（`session_epoch` / `status` の SELECT のみ。
 *   timestamptz に触れない）の**直後**、かつ `runIdempotent()` の予約 INSERT（timestamptz を
 *   束縛する）より**前**で完結するため、`docs/concerns/task_022.md` に記録した
 *   drizzle 経由の timestamptz 不具合を踏まずに実測できる（本タスクで実測確認済み）。
 *   セッションは `issueSession()` で実際に発行し、`app_user` 行も実 DB に作る
 *   （`Cookie` を手で組み立てるのではなく、本物の署名検証を通す）。
 */

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { appRwConnectionString, createAppRwSql, createMigratorSql, ensureAppRwLoginPassword } from "../integration/setup";

vi.mock("server-only", () => ({}));

const cloudflareEnv: Record<string, unknown> = {};
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({ env: cloudflareEnv, cf: undefined, ctx: undefined }),
}));

const { MIN_SECRET_BYTES, loadAppConfig } = await import("@/lib/config/env");
const { issueSession, buildSessionCookie } = await import("@/lib/auth/session");
const {
  CSRF_HEADER,
  CSRF_EXEMPT_PATH_PREFIXES,
  assertCsrfToken,
  deriveCsrfToken,
  isCsrfExemptPath,
  timingSafeEqual,
} = await import("@/lib/auth/csrf");
const { CsrfError } = await import("@/lib/auth/csrf");
const { assertSameOriginRequest } = await import("@/lib/auth/request-guard");
const { AppError } = await import("@/lib/errors");
const { POST: eventsPOST } = await import("@/app/api/events/route");

const LOGIN_CHANNEL_ID = "2000000000";
const SESSION_SECRET = "s".repeat(MIN_SECRET_BYTES);

function testConfig(): ReturnType<typeof loadAppConfig> {
  return loadAppConfig({
    APP_ENV: "development",
    LINE_ENV_PROFILE: JSON.stringify({
      env: "development",
      liffId: `${LOGIN_CHANNEL_ID}-abcd1234`,
      loginChannelId: LOGIN_CHANNEL_ID,
    }),
    PEPPER: `1:${"p".repeat(MIN_SECRET_BYTES)}`,
    SESSION_KEYS: `cur:${SESSION_SECRET}`,
    CRON_SECRETS: "c".repeat(MIN_SECRET_BYTES),
  });
}

let migrator: postgres.Sql;
let appRw: postgres.Sql;

beforeAll(async () => {
  migrator = createMigratorSql();
  await ensureAppRwLoginPassword(migrator);
  appRw = createAppRwSql();
  Object.assign(cloudflareEnv, {
    DATABASE_URL: appRwConnectionString(),
    APP_ENV: "development",
    LINE_ENV_PROFILE: JSON.stringify({
      env: "development",
      liffId: `${LOGIN_CHANNEL_ID}-abcd1234`,
      loginChannelId: LOGIN_CHANNEL_ID,
    }),
    PEPPER: `1:${"p".repeat(MIN_SECRET_BYTES)}`,
    SESSION_KEYS: `cur:${SESSION_SECRET}`,
    CRON_SECRETS: "c".repeat(MIN_SECRET_BYTES),
  });
});

afterEach(async () => {
  // 実コミットしたテスト用ユーザーを片付ける（`POST /api/events` は独自の DB 接続を開くため
  // `withRollback` に包めない。IDOR/claims テストと同じ後始末方針）。
  await appRw`DELETE FROM app_user WHERE identity_scope LIKE 'csrf-test:%'`;
});

afterAll(async () => {
  await appRw?.end();
  await migrator?.end();
});

function uniq(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function insertSessionedUser(): Promise<{ userId: string; cookie: string; jti: string; kid: string }> {
  const suffix = uniq();
  const rows = await appRw<{ id: string; session_epoch: number }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`csrf-${suffix}`)}, ${`csrf-test:${suffix}`}, 'development')
    RETURNING id, session_epoch
  `;
  const row = rows[0]!;
  const issued = await issueSession(testConfig(), { userId: row.id, epoch: row.session_epoch });
  return { userId: row.id, cookie: buildSessionCookie(issued.token), jti: issued.jti, kid: issued.kid };
}

const CREATE_EVENT_BODY = {
  title: "csrf-probe",
  organizerLabel: "probe",
  eventAt: null,
  venue: null,
  offering: null,
  defaultAmountMinor: 1000,
  collectByAt: null,
  minorsIncluded: false,
  allowCash: false,
  feeDisclosureAccepted: true,
};

describe("実ルート境界（check_058）: X-CSRF-Token が無い POST は 403", () => {
  it("有効なセッションでも X-CSRF-Token ヘッダが無ければ CSRF_INVALID 403（書き込みは起きない）", async () => {
    const session = await insertSessionedUser();
    const request = new Request("http://127.0.0.1:3100/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:3100",
        cookie: session.cookie,
        "idempotency-key": `csrf-missing-${uniq()}`,
      },
      body: JSON.stringify(CREATE_EVENT_BODY),
    });

    const response = await eventsPOST(request);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("CSRF_INVALID");

    const rows = await appRw<{ n: string }[]>`
      SELECT count(*)::text AS n FROM event WHERE organizer_user_id = ${session.userId}
    `;
    expect(rows[0]?.n).toBe("0");
  });

  it("トークンが不一致でも同じく 403（総当たりで通らない）", async () => {
    const session = await insertSessionedUser();
    const request = new Request("http://127.0.0.1:3100/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:3100",
        cookie: session.cookie,
        "idempotency-key": `csrf-wrong-${uniq()}`,
        [CSRF_HEADER]: "a".repeat(43),
      },
      body: JSON.stringify(CREATE_EVENT_BODY),
    });

    const response = await eventsPOST(request);
    expect(response.status).toBe(403);
  });

  it("正しい CSRF トークンなら CSRF の壁は越える（この先の 500 は別の既知不具合。docs/concerns/task_022.md）", async () => {
    const session = await insertSessionedUser();
    const token = await deriveCsrfToken(testConfig(), session.jti, session.kid);
    const request = new Request("http://127.0.0.1:3100/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:3100",
        cookie: session.cookie,
        "idempotency-key": `csrf-ok-${uniq()}`,
        [CSRF_HEADER]: token,
      },
      body: JSON.stringify(CREATE_EVENT_BODY),
    });

    const response = await eventsPOST(request);
    // CSRF はもう理由ではない。403 にはならない（500 も CSRF_INVALID も想定内だが、
    // ここで検査したいのは「403 CSRF_INVALID を返さないこと」だけ）。
    expect(response.status).not.toBe(403);
  });
});

describe("assertSameOriginRequest（クロスサイト送信の判定）", () => {
  const SELF = "https://app.example";

  it("同一オリジンの Origin ヘッダは通る", () => {
    expect(() =>
      assertSameOriginRequest(
        new Request(`${SELF}/api/events`, { method: "POST", headers: { origin: SELF, host: "app.example" } }),
      ),
    ).not.toThrow();
  });

  it("別オリジンの Origin は AppError(403)", () => {
    expect(() =>
      assertSameOriginRequest(
        new Request(`${SELF}/api/events`, {
          method: "POST",
          headers: { origin: "https://evil.example", host: "app.example" },
        }),
      ),
    ).toThrow(AppError);
  });

  it("null オリジン（サンドボックス化された iframe / data: 由来）は AppError(403)", () => {
    expect(() =>
      assertSameOriginRequest(
        new Request(`${SELF}/api/events`, {
          method: "POST",
          headers: { origin: "null", host: "app.example" },
        }),
      ),
    ).toThrow(AppError);
  });

  it("Origin も Sec-Fetch-Site も無ければ fail-closed で AppError(403)", () => {
    expect(() =>
      assertSameOriginRequest(new Request(`${SELF}/api/events`, { method: "POST" })),
    ).toThrow(AppError);
  });

  it("Origin が同一でも Sec-Fetch-Site が他サイトを名乗っていれば AppError(403)", () => {
    expect(() =>
      assertSameOriginRequest(
        new Request(`${SELF}/api/events`, {
          method: "POST",
          headers: { origin: SELF, host: "app.example", "sec-fetch-site": "cross-site" },
        }),
      ),
    ).toThrow(AppError);
  });

  it("Origin が無く Sec-Fetch-Site: same-origin だけなら通る", () => {
    expect(() =>
      assertSameOriginRequest(
        new Request(`${SELF}/api/events`, {
          method: "POST",
          headers: { host: "app.example", "sec-fetch-site": "same-origin" },
        }),
      ),
    ).not.toThrow();
  });
});

describe("assertCsrfToken（セッション束縛トークンの検証）", () => {
  it("欠落・不一致・別セッション（別 jti）由来のトークンはすべて CsrfError", async () => {
    const config = testConfig();
    const jtiA = "a".repeat(32);
    const jtiB = "b".repeat(32);
    const valid = await deriveCsrfToken(config, jtiA, "cur");

    await expect(assertCsrfToken(config, null, jtiA, "cur")).rejects.toThrow(CsrfError);
    await expect(assertCsrfToken(config, "", jtiA, "cur")).rejects.toThrow(CsrfError);
    await expect(assertCsrfToken(config, `${valid}x`, jtiA, "cur")).rejects.toThrow(CsrfError);
    // 別セッション（jti が違う）の正しいトークンを持ち込んでも通らない。
    const otherValid = await deriveCsrfToken(config, jtiB, "cur");
    await expect(assertCsrfToken(config, otherValid, jtiA, "cur")).rejects.toThrow(CsrfError);
    // 自分の jti に対する正しいトークンは通る。
    await expect(assertCsrfToken(config, valid, jtiA, "cur")).resolves.toBeUndefined();
  });

  it("timingSafeEqual は長さの違いも内容の違いも漏らさず false", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("CSRF 免除経路（W6）は Webhook / cron / telemetry / preview / return / auth/line だけ", () => {
  it("免除リストに載っている接頭辞は immune、それ以外の書き込み系は免除されない", () => {
    for (const prefix of CSRF_EXEMPT_PATH_PREFIXES) {
      expect(isCsrfExemptPath(prefix)).toBe(true);
    }
    for (const path of [
      "/api/events",
      "/api/e/claim",
      "/api/e/checkout",
      "/api/invoices/abc/manual-attest",
      "/api/events/abc/participants",
    ]) {
      expect(isCsrfExemptPath(path)).toBe(false);
    }
  });
});
