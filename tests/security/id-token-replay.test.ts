/**
 * ID トークン再利用の統合テスト（check_110 / ADR-009 / R-SEC-08）。
 *
 * `tests/integration/auth.test.ts`（task_012/013 所有）が「同一 ID トークンの逐次 2 回目の
 * 提示は 401」を既に検査済みなので、ここでは 3 つの補強的な角度だけを扱う。
 *   1. **競合**: 同一トークンを同時に 2 回提示しても、単回使用の記録（`markUsed`）は
 *      片方にしか成立しない（`INSERT ... ON CONFLICT DO NOTHING` の原子性）。
 *   2. **鍵の独立性**: 単回使用の判定キーは `jti`（あれば）優先で、ペイロードの他の値
 *      （`sub` 等）には依存しない — 同じ `jti` を異なる `sub` で再提示しても再利用として拒否
 *      される（トークンの中身を差し替えても単回使用の壁は回避できない）。
 *   3. **DB 層の二重化**: `used_id_token` テーブル自体の一意制約が、アプリ層の判定を
 *      経由しない直接 INSERT でも重複を拒否する（防御の多重化の実測）。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "../integration/setup";

vi.mock("server-only", () => ({}));

const { MIN_SECRET_BYTES, loadAppConfig } = await import("@/lib/config/env");
const { authenticateWithLineIdToken, LINE_ID_TOKEN_ISSUER } = await import("@/lib/auth/line-verify");
const { createDbUsedIdTokenStore, idTokenUsageKey } = await import("@/lib/auth/used-token");
const { AppError } = await import("@/lib/errors");

const LOGIN_CHANNEL_ID = "2000000000";

function testConfig(): ReturnType<typeof loadAppConfig> {
  return loadAppConfig({
    APP_ENV: "development",
    LINE_ENV_PROFILE: JSON.stringify({
      env: "development",
      liffId: `${LOGIN_CHANNEL_ID}-abcd1234`,
      loginChannelId: LOGIN_CHANNEL_ID,
    }),
    PEPPER: `1:${"p".repeat(MIN_SECRET_BYTES)}`,
    SESSION_KEYS: `cur:${"s".repeat(MIN_SECRET_BYTES)}`,
    CRON_SECRETS: "c".repeat(MIN_SECRET_BYTES),
  });
}

const ALLOW_ALL_LIMITER = { check: async () => ({ allowed: true, backend: "workers-rate-limit-binding" as const }) };

let migrator: postgres.Sql;
let appRw: postgres.Sql;

beforeAll(async () => {
  migrator = createMigratorSql();
  await ensureAppRwLoginPassword(migrator);
  appRw = createAppRwSql();
});

afterAll(async () => {
  await appRw?.end();
  await migrator?.end();
});

function uniq(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function lineSub(suffix: string): string {
  const hex = suffix.padStart(32, "0").slice(-32).replace(/[^0-9a-f]/g, "0");
  return `U${hex}`;
}

function verifyFetchFor(sub: string, nowSeconds: number, jti?: string): typeof fetch {
  return (async (): Promise<Response> =>
    Response.json({
      iss: LINE_ID_TOKEN_ISSUER,
      sub,
      aud: LOGIN_CHANNEL_ID,
      exp: nowSeconds + 3600,
      iat: nowSeconds - 5,
      ...(jti === undefined ? {} : { jti }),
    })) as unknown as typeof fetch;
}

function asSql(tx: postgres.TransactionSql): postgres.Sql {
  return tx as unknown as postgres.Sql;
}

describe("同一 ID トークンの同時提示は、単回使用の壁を片方にしか通さない", () => {
  it("2 並行の同一トークン提示のうち、1 本だけが成功し、もう 1 本は 401", async () => {
    await withRollback(appRw, async (tx) => {
      const sub = lineSub(`r1-${uniq()}`);
      const now = new Date();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const idToken = `id-token-race-${uniq()}`;
      const store = createDbUsedIdTokenStore(asSql(tx));

      const run = () =>
        authenticateWithLineIdToken(
          {
            config: testConfig(),
            sql: asSql(tx),
            usedTokenStore: store,
            rateLimiter: ALLOW_ALL_LIMITER,
            clientIp: "203.0.113.20",
            now,
            fetchImpl: verifyFetchFor(sub, nowSeconds),
          },
          idToken,
        );

      const results = await Promise.allSettled([run(), run()]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
      expect(((rejected[0] as PromiseRejectedResult).reason as InstanceType<typeof AppError>).status).toBe(401);

      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM used_id_token
        WHERE jti_or_hash = ${await idTokenUsageKey(idToken, undefined)}
      `;
      expect(rows[0]?.n).toBe("1");
    });
  });
});

describe("単回使用の判定キーはペイロードの中身に依存しない（jti 優先）", () => {
  it("同じ jti を異なる sub で再提示しても再利用として拒否される", async () => {
    await withRollback(appRw, async (tx) => {
      const jti = `jti-fixed-${uniq()}`;
      const now = new Date();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const store = createDbUsedIdTokenStore(asSql(tx));
      const deps = {
        config: testConfig(),
        sql: asSql(tx),
        usedTokenStore: store,
        rateLimiter: ALLOW_ALL_LIMITER,
        clientIp: "203.0.113.21",
        now,
      };

      const first = await authenticateWithLineIdToken(
        { ...deps, fetchImpl: verifyFetchFor(lineSub(`j1-${uniq()}`), nowSeconds, jti) },
        "id-token-a",
      );
      expect(first.session.token.split(".")).toHaveLength(3);

      let thrown: unknown;
      try {
        // トークン文字列は別物・sub も別物だが jti は同じ ⇒ 単回使用の壁で拒否されるはず。
        await authenticateWithLineIdToken(
          { ...deps, fetchImpl: verifyFetchFor(lineSub(`j2-${uniq()}`), nowSeconds, jti) },
          "id-token-b-different-string",
        );
        expect.unreachable("expected replay rejection");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as InstanceType<typeof AppError>).status).toBe(401);
    });
  });
});

describe("used_id_token の一意制約はアプリ層を経由しない直接 INSERT でも重複を拒否する", () => {
  it("同じ jti_or_hash を 2 回 INSERT すると 2 回目は一意制約違反（23505）", async () => {
    await withRollback(appRw, async (tx) => {
      const key = `direct-insert-${uniq()}`;
      const expiresAt = new Date(Date.now() + 3600_000);
      await tx`INSERT INTO used_id_token (jti_or_hash, expires_at) VALUES (${key}, ${expiresAt})`;

      let failure: unknown;
      try {
        await tx.savepoint(async (sp) => {
          await sp`INSERT INTO used_id_token (jti_or_hash, expires_at) VALUES (${key}, ${expiresAt})`;
        });
      } catch (error) {
        failure = error;
      }
      expect((failure as { code?: string } | undefined)?.code).toBe("23505");
    });
  });
});
