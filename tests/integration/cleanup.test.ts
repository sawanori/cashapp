/**
 * 冪等キー・単回使用トークンの掃除（check_072 / check_104 / R-SEC-08 / R-PAY-02）。
 *
 * `expires_at` を**過ぎた行だけ**が消え、未経過の行は残ることを確かめる。
 * 未経過の行まで消えると、ID トークンの単回使用と冪等キーの再送保護がその瞬間に破れる。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("not available in integration tests");
  },
}));

const { runIdempotencyCleanup } = await import("@/lib/retention");

const HOUR_MS = 60 * 60 * 1000;

let migrator: postgres.Sql;
let appRw: postgres.Sql;

beforeAll(async () => {
  migrator = createMigratorSql();
  await ensureAppRwLoginPassword(migrator);
  appRw = createAppRwSql();
});

afterAll(async () => {
  await appRw?.end({ timeout: 5 });
  await migrator?.end({ timeout: 5 });
});

async function tokenExists(tx: postgres.TransactionSql, key: string): Promise<boolean> {
  const rows = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM used_id_token WHERE jti_or_hash = ${key}
  `;
  return (rows[0]?.count ?? 0) > 0;
}

async function idemExists(tx: postgres.TransactionSql, key: string): Promise<boolean> {
  const rows = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM idempotency_key WHERE key = ${key}
  `;
  return (rows[0]?.count ?? 0) > 0;
}

describe("期限切れ行の掃除（check_072 / check_104）", () => {
  it("used_id_token は exp 経過行だけ消え、未経過行は残る", async () => {
    await withRollback(appRw, async (tx) => {
      const now = new Date();
      const expired = `sha256:${"1".repeat(64)}`;
      const alive = `sha256:${"2".repeat(64)}`;
      await tx`
        INSERT INTO used_id_token (jti_or_hash, expires_at)
        VALUES (${expired}, ${new Date(now.getTime() - HOUR_MS)}),
               (${alive}, ${new Date(now.getTime() + HOUR_MS)})
      `;

      const result = await runIdempotencyCleanup(tx, now);

      expect(result.usedIdTokensDeleted).toBeGreaterThanOrEqual(1);
      expect(await tokenExists(tx, expired)).toBe(false);
      expect(await tokenExists(tx, alive)).toBe(true);
    });
  });

  it("idempotency_key は expires_at 経過行だけ消え、未経過行は残る", async () => {
    await withRollback(appRw, async (tx) => {
      const now = new Date();
      const userRef = Buffer.from(`cleanup-${crypto.randomUUID().slice(0, 8)}`);
      const expiredKey = `key-expired-${crypto.randomUUID().slice(0, 8)}`;
      const aliveKey = `key-alive-${crypto.randomUUID().slice(0, 8)}`;
      const hash = "0".repeat(64);
      await tx`
        INSERT INTO idempotency_key (user_ref, endpoint, key, state, request_hash,
                                     status_code, expires_at)
        VALUES (${userRef}, 'POST /api/events', ${expiredKey}, 'done', ${hash}, 200,
                ${new Date(now.getTime() - 25 * HOUR_MS)}),
               (${userRef}, 'POST /api/events', ${aliveKey}, 'done', ${hash}, 200,
                ${new Date(now.getTime() + HOUR_MS)})
      `;

      const result = await runIdempotencyCleanup(tx, now);

      expect(result.idempotencyKeysDeleted).toBeGreaterThanOrEqual(1);
      expect(await idemExists(tx, expiredKey)).toBe(false);
      expect(await idemExists(tx, aliveKey)).toBe(true);
    });
  });
});
