/**
 * outbox 配達 cron の統合テスト（check_104 / R-OPS-01）。
 *
 *   - `OUTBOX_TRANSPORT` に配達先の無い `kind` が 0 件であること（表と実際に積む側の一致）
 *   - 配達成功で `done_at`、失敗で `attempts` 増加と**指数バックオフ**
 *   - `max_attempts` 到達で `dead_lettered_at` が立ち、以後取り出されない
 *   - 表に無い `kind`（DB へ直接入った行）は配達されない
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("not available in integration tests");
  },
}));

const { OUTBOX_TRANSPORT, enqueueOutbox, transportFor } = await import("@/lib/outbox");
const { runOutboxBatch, backoffSeconds } = await import("@/app/api/cron/outbox/route");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

interface OutboxState {
  readonly attempts: number;
  readonly done_at: Date | null;
  readonly dead_lettered_at: Date | null;
  readonly run_after: Date;
}

async function stateOf(tx: postgres.TransactionSql, id: string): Promise<OutboxState> {
  const rows = await tx<OutboxState[]>`
    SELECT attempts, done_at, dead_lettered_at, run_after FROM outbox WHERE id = ${id}
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("outbox row not found");
  return row;
}

describe("kind → transport の対応表（check_104）", () => {
  it("表のすべての kind に配達先がある（未定義 0 件）", () => {
    const undefinedKinds = Object.keys(OUTBOX_TRANSPORT).filter((kind) => {
      try {
        transportFor(kind);
        return false;
      } catch {
        return true;
      }
    });
    expect(undefinedKinds).toEqual([]);
    expect(Object.keys(OUTBOX_TRANSPORT).length).toBeGreaterThan(0);
  });

  it("台帳が積む kind がすべて表にある（積んだが誰も配らない、を作らない）", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src", "lib", "ledger", "apply.ts"), "utf8");
    const pushed = [...source.matchAll(/outboxKinds\.push\("([a-z0-9_]+)"\)/g)].map((m) => m[1] ?? "");
    expect(pushed.length).toBeGreaterThan(0);
    for (const kind of pushed) {
      expect(Object.keys(OUTBOX_TRANSPORT)).toContain(kind);
    }
  });
});

describe("outbox の配達", () => {
  it("配達に成功した行は done_at が入り、次のバッチでは拾わない", async () => {
    await withRollback(appRw, async (tx) => {
      const id = await enqueueOutbox(tx, {
        kind: "orphan_alert",
        payload: { providerKey: "fixture_provider", externalRef: "iv_ok_1" },
      });

      const delivered: string[] = [];
      const first = await runOutboxBatch(tx, {
        deliver: (job) => {
          delivered.push(job.id);
          return Promise.resolve();
        },
      });

      expect(first.delivered).toBeGreaterThanOrEqual(1);
      expect(delivered).toContain(id);
      const state = await stateOf(tx, id);
      expect(state.done_at).not.toBeNull();

      const second = await runOutboxBatch(tx, { deliver: () => Promise.resolve() });
      expect(second.picked).toBe(0);
    });
  });

  it("失敗は attempts を増やし、指数バックオフで run_after を先送りする", async () => {
    await withRollback(appRw, async (tx) => {
      const now = new Date();
      const id = await enqueueOutbox(tx, {
        kind: "mismatch_alert",
        payload: { invoiceId: "00000000-0000-0000-0000-000000000000" },
        runAfter: now,
      });

      const result = await runOutboxBatch(tx, {
        now,
        deliver: () => Promise.reject(new Error("transport down")),
      });

      expect(result.failed).toBe(1);
      expect(result.deadLettered).toBe(0);
      const state = await stateOf(tx, id);
      expect(state.attempts).toBe(1);
      expect(state.done_at).toBeNull();
      expect(state.run_after.getTime()).toBe(now.getTime() + backoffSeconds(1) * 1000);
      // 2 回目の失敗は 1 回目より先まで待つ（指数）。
      expect(backoffSeconds(2)).toBeGreaterThan(backoffSeconds(1));
      expect(backoffSeconds(30)).toBeLessThanOrEqual(3_600);
    });
  });

  it("max_attempts に達したら dead_lettered_at が立ち、以後取り出されない", async () => {
    await withRollback(appRw, async (tx) => {
      const now = new Date();
      const id = await enqueueOutbox(tx, {
        kind: "payment_detected",
        payload: { invoiceId: "00000000-0000-0000-0000-000000000000" },
        runAfter: now,
        maxAttempts: 2,
      });

      // 1 回目: 失敗（バックオフで先送り）→ 取り出せるよう run_after を戻す。
      await runOutboxBatch(tx, { now, deliver: () => Promise.reject(new Error("down")) });
      await tx`UPDATE outbox SET run_after = ${now}, locked_until = NULL WHERE id = ${id}`;
      // 2 回目: max_attempts 到達。
      const second = await runOutboxBatch(tx, {
        now,
        deliver: () => Promise.reject(new Error("down")),
      });

      expect(second.deadLettered).toBe(1);
      const state = await stateOf(tx, id);
      expect(state.attempts).toBe(2);
      expect(state.dead_lettered_at).not.toBeNull();

      const third = await runOutboxBatch(tx, { now, deliver: () => Promise.resolve() });
      expect(third.picked).toBe(0);
    });
  });

  it("表に無い kind は配達されず、失敗として記録される", async () => {
    await withRollback(appRw, async (tx) => {
      // `run_after` は明示する（DB の now() と JS の now がミリ秒単位で前後すると
      // 「まだ実行時刻ではない」と判定されて取り出されないため、時刻に依存させない）。
      const now = new Date();
      const rows = await tx<{ id: string }[]>`
        INSERT INTO outbox (kind, payload, run_after)
        VALUES ('not_in_transport_table', '{}'::jsonb, ${new Date(now.getTime() - 60_000)})
        RETURNING id
      `;
      const id = rows[0]?.id ?? "";

      const delivered: string[] = [];
      const result = await runOutboxBatch(tx, {
        now,
        deliver: (job) => {
          delivered.push(job.id);
          return Promise.resolve();
        },
      });

      expect(result.unknownKinds).toBe(1);
      expect(delivered).not.toContain(id);
      const state = await stateOf(tx, id);
      expect(state.attempts).toBe(1);
      expect(state.done_at).toBeNull();
    });
  });
});
