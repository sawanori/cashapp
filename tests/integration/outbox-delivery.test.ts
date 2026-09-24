/**
 * `src/lib/outbox-transports.ts` の統合テスト（task_023 / check_113 / done_definition #1）。
 *
 *   - `OUTBOX_TRANSPORT` の全 kind が `createOutboxDeliver`（送信部分をモック差し替え）経由で
 *     例外なく配達できる（未定義 0 件。実 DB の `runOutboxBatch` と組み合わせて検証）
 *   - `ops_alert` は PII を含まない payload で運営者向け内部 webhook（モック）を呼ぶ
 *   - `organizer_notify` は ADR-007（パターン B, proposed・PO 承認前の暫定運用）どおり LINE API を一切呼ばず、
 *     `notifyOrganizer()` 経由で完了する（モック）
 *   - `sendOpsAlertViaWebhook` と本番既定の `deliverOutboxJob`（送信部分を未モックのまま）自体も
 *     `globalThis.fetch` スタブで直接検証する（200 / 非 2xx→throw / 未設定→fetch 未呼び出し。
 *     task_023 修正ラウンドで追加。レビューのギャップ §（実 I/O 関数が未実行）に対応）
 */

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("not available in integration tests");
  },
}));

import { createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "./setup";

const { OUTBOX_TRANSPORT, enqueueOutbox, transportFor } = await import("@/lib/outbox");
const { runOutboxBatch } = await import("@/app/api/cron/outbox/route");
const { createOutboxDeliver, deliverOutboxJob, sendOpsAlertViaWebhook } = await import(
  "@/lib/outbox-transports"
);
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

describe("sendOpsAlertViaWebhook / deliverOutboxJob（本番既定の実装そのものを検証。task_023 修正ラウンド）", () => {
  const ENV_KEY = "OPS_ALERT_WEBHOOK_URL";
  const originalEnvValue = process.env[ENV_KEY];

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnvValue;
    }
  });

  it("OPS_ALERT_WEBHOOK_URL が未設定なら fetch を呼ばずログのみで完了する（fail-open）", async () => {
    delete process.env[ENV_KEY];
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      await expect(
        sendOpsAlertViaWebhook({ kind: "mismatch_alert", outboxId: "x", attempts: 0 }),
      ).resolves.toBeUndefined();
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("200 応答なら例外を投げず、POST で PII を含まない payload を送る", async () => {
    process.env[ENV_KEY] = "https://example.invalid/ops-alert";
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    try {
      await expect(
        sendOpsAlertViaWebhook({ kind: "mismatch_alert", outboxId: "x", attempts: 1 }),
      ).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://example.invalid/ops-alert");
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.body).toEqual({ kind: "mismatch_alert", outboxId: "x", attempts: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("非 2xx 応答なら例外を投げる（R-OPS-01: 呼び出し側の再試行・dead letter 経路に委ねる）", async () => {
    process.env[ENV_KEY] = "https://example.invalid/ops-alert";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;

    try {
      await expect(
        sendOpsAlertViaWebhook({ kind: "mismatch_alert", outboxId: "x", attempts: 0 }),
      ).rejects.toThrow(/500/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("deliverOutboxJob（本番既定の配達関数）は ops_alert を sendOpsAlertViaWebhook 経由で実際に配達する", async () => {
    process.env[ENV_KEY] = "https://example.invalid/ops-alert";
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    try {
      await expect(
        deliverOutboxJob({ id: "job-1", kind: "mismatch_alert", transport: "ops_alert", attempts: 0 }),
      ).resolves.toBeUndefined();
      expect(called).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("deliverOutboxJob（本番既定の配達関数）は organizer_notify を notifyOrganizer 経由で配達し外部へ fetch しない", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      await expect(
        deliverOutboxJob({
          id: "job-2",
          kind: "payment_detected",
          transport: "organizer_notify",
          attempts: 0,
        }),
      ).resolves.toBeUndefined();
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
