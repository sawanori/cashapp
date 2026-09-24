/**
 * `src/lib/outbox-transports.ts` の統合テスト（task_023 / check_113 / done_definition #1）。
 *
 *   - `OUTBOX_TRANSPORT` の全 kind が `deliverOutboxJob` 経由で例外なく配達できる（未定義 0 件）
 *   - `ops_alert` は PII を含まない payload で運営者向け内部 webhook（モック）を呼ぶ
 *   - `organizer_notify` は ADR-007（パターン B, accepted）どおり LINE API を一切呼ばず、
 *     `notifyOrganizer()` 経由で完了する（モック）
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("not available in integration tests");
  },
}));

import { createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "./setup";

const { OUTBOX_TRANSPORT, enqueueOutbox, transportFor } = await import("@/lib/outbox");
const { runOutboxBatch } = await import("@/app/api/cron/outbox/route");
const { createOutboxDeliver } = await import("@/lib/outbox-transports");
const { notifyOrganizer } = await import("@/lib/line/messaging");

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

describe("outbox の配達先実装（check_113）", () => {
  it("OUTBOX_TRANSPORT の全 kind に配達先があり、実際に配達も失敗せず完了する（未定義 0 件）", async () => {
    const kinds = Object.keys(OUTBOX_TRANSPORT);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(() => transportFor(kind)).not.toThrow();
    }

    await withRollback(appRw, async (tx) => {
      const deliver = createOutboxDeliver({
        sendOpsAlert: async () => undefined,
        notifyOrganizer: async () => ({ delivered: true, channel: "in_app_badge", reason: "test" }),
      });

      for (const kind of kinds) {
        const id = await enqueueOutbox(tx, { kind, payload: { probe: kind } });
        const result = await runOutboxBatch(tx, { deliver });

        expect(result.failed).toBe(0);
        expect(result.unknownKinds).toBe(0);
        const rows = await tx<{ done_at: Date | null }[]>`
          SELECT done_at FROM outbox WHERE id = ${id}
        `;
        expect(rows[0]?.done_at).not.toBeNull();
      }
    });
  });

  it("ops_alert は PII を含まない payload で運営者向け webhook（モック）を呼ぶ", async () => {
    await withRollback(appRw, async (tx) => {
      const sent: OpsAlertCall[] = [];
      const deliver = createOutboxDeliver({
        sendOpsAlert: async (payload) => {
          sent.push(payload);
        },
        notifyOrganizer: () => {
          throw new Error("organizer notifier must not be called for ops_alert");
        },
      });

      await enqueueOutbox(tx, {
        kind: "mismatch_alert",
        payload: { invoiceId: "00000000-0000-0000-0000-000000000000" },
      });
      const result = await runOutboxBatch(tx, { deliver });

      expect(result.delivered).toBe(1);
      expect(sent).toHaveLength(1);
      const payload = sent[0];
      if (payload === undefined) throw new Error("no ops_alert payload captured");
      expect(Object.keys(payload).sort()).toEqual(["attempts", "kind", "outboxId"]);
      expect(payload.kind).toBe("mismatch_alert");
      // 生の LINE userId（U + 32 桁 hex）が payload に混ざっていないこと。
      expect(JSON.stringify(payload)).not.toMatch(/U[0-9a-f]{32}/);
    });
  });

  it("organizer_notify は LINE API を呼ばず notifyOrganizer 経由で完了する（ADR-007 パターン B）", async () => {
    await withRollback(appRw, async (tx) => {
      let organizerCalls = 0;
      const opsAlertCalls: unknown[] = [];
      const deliver = createOutboxDeliver({
        sendOpsAlert: async (payload) => {
          opsAlertCalls.push(payload);
        },
        notifyOrganizer: async () => {
          organizerCalls += 1;
          return notifyOrganizer();
        },
      });

      await enqueueOutbox(tx, {
        kind: "payment_detected",
        payload: { invoiceId: "00000000-0000-0000-0000-000000000000" },
      });
      const result = await runOutboxBatch(tx, { deliver });

      expect(result.delivered).toBe(1);
      expect(organizerCalls).toBe(1);
      expect(opsAlertCalls).toHaveLength(0);
    });
  });

  it("notifyOrganizer は Phase 1 は in_app_badge 固定で外部へ fetch しない", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      const result = await notifyOrganizer();
      expect(result.delivered).toBe(true);
      expect(result.channel).toBe("in_app_badge");
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

interface OpsAlertCall {
  readonly kind: string;
  readonly outboxId: string;
  readonly attempts: number;
}
