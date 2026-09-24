/**
 * `src/lib/metrics/funnel.ts` の統合テスト（実 Postgres）。
 *
 * ★ 動機（レビューギャップの是正）: `tests/e2e/manual-only-complete.spec.ts` の
 *   ファネルテストは `recordFunnelStage` / `computeWeeklyFunnel` を一切呼ばず、同じ
 *   データモデルとクエリ形を複製しているだけだった（GPT-6 Astra の敵対レビュー F-2、
 *   本タスクのレビューギャップ「funnel.ts はリポジトリ内のどこからも import されていない」）。
 *   そのため `src/lib/metrics/funnel.ts` 自体の実装が壊れていても、E2E 側のテストは
 *   検出できなかった（`computeWeeklyFunnel` を全段ゼロ件の実装に差し替えても緑のまま）。
 *   ここでは実モジュールを直接 import して呼ぶ。
 *
 * ★ `import "server-only"` は Node（vitest。既定の `environment: "node"` — `window` が
 *   無い）では throw しない（`node_modules/server-only/index.js` は
 *   `typeof window !== 'undefined'` のときだけ throw する）。`vi.mock` は他の統合テスト
 *   （`tests/integration/audit-chain.test.ts` 等）と同じ慣習として念のためかけておく。
 *
 * ★ 隔離: `withRollback` で全操作を 1 トランザクションに包み、`audit_log`（追記専用・
 *   全体共有）には実コミットで行を残さない（`audit-chain.test.ts` と同じ方針）。
 *   `audit_log.target_id` は `event` への実外部キーを持たない（`text NOT NULL` のみ。
 *   `supabase/migrations/0001_init.sql`）ため、実在する `event` 行を作らず合成 ID を使う。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "./setup";

vi.mock("server-only", () => ({}));

const { FUNNEL_STAGES, funnelAction, recordFunnelStage, computeWeeklyFunnel, buildWeeklyMetricsFile, weeklyMetricsFileName, startOfIsoWeekUtc } =
  await import("@/lib/metrics/funnel");

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

describe("recordFunnelStage / computeWeeklyFunnel: 実装を直接呼んで検証する", () => {
  it("記録した 5 段すべてが同じ週の集計に 1 件ずつ現れる（本体が壊れていれば検出する）", async () => {
    const marker = uniq();
    const eventId = `funnel-test-${marker}`;
    const now = new Date();

    const result = await withRollback(appRw, async (tx) => {
      for (const stage of FUNNEL_STAGES) {
        await recordFunnelStage(tx, { eventId, stage, requestId: `req-${marker}-${stage}`, now });
      }
      // 実装の computeWeeklyFunnel を同一トランザクション内で呼ぶ（withRollback が
      // ロールバックする前なので、上で INSERT した未コミット行も見える）。
      return computeWeeklyFunnel(tx as unknown as postgres.Sql, now);
    });

    for (const stage of FUNNEL_STAGES) {
      expect(result.stages[stage]).toBeGreaterThanOrEqual(1);
    }
    expect(result.weekStart).toBe(startOfIsoWeekUtc(now).toISOString());
  });

  it("computeWeeklyFunnel は指定週の外の到達を数えない", async () => {
    const marker = uniq();
    const eventId = `funnel-test-outside-${marker}`;
    const farPast = new Date(Date.UTC(2020, 0, 1));

    const result = await withRollback(appRw, async (tx) => {
      await recordFunnelStage(tx, { eventId, stage: "landing", requestId: `req-${marker}`, now: farPast });
      // 参照週は「今」のまま（2020 年の行は今週の集計に入らないはず）。
      return computeWeeklyFunnel(tx as unknown as postgres.Sql, new Date());
    });

    expect(result.stages.landing).toBe(0);
  });

  it("buildWeeklyMetricsFile / weeklyMetricsFileName は実装が返す週次結果をそのまま包める", async () => {
    const marker = uniq();
    const eventId = `funnel-test-file-${marker}`;
    const now = new Date();

    const result = await withRollback(appRw, async (tx) => {
      await recordFunnelStage(tx, { eventId, stage: "paid", requestId: `req-${marker}`, now });
      return computeWeeklyFunnel(tx as unknown as postgres.Sql, now);
    });

    const file = buildWeeklyMetricsFile(result);
    expect(file.funnel).toBe(result);
    expect(weeklyMetricsFileName(result.weekStart)).toBe(`weekly-${result.weekStart.slice(0, 10)}.json`);

    // JSON へ書き出しても壊れない（実際の書き出し先 docs/metrics/ には触れない —
    // それは cron 等の後続タスクの仕事で、ここでは純粋な形の検査に留める）。
    const roundTripped = JSON.parse(JSON.stringify(file)) as typeof file;
    for (const stage of FUNNEL_STAGES) {
      expect(typeof roundTripped.funnel.stages[stage]).toBe("number");
    }
  });

  it("funnelAction は audit_log.action に実際に書き込まれる値と一致する", async () => {
    const marker = uniq();
    const eventId = `funnel-test-action-${marker}`;
    const now = new Date();

    const action = await withRollback(appRw, async (tx) => {
      await recordFunnelStage(tx, { eventId, stage: "consent", requestId: `req-${marker}`, now });
      const rows = await tx<{ action: string }[]>`
        SELECT action FROM audit_log WHERE target_type = 'event' AND target_id = ${eventId}
      `;
      return rows[0]?.action;
    });

    expect(action).toBe(funnelAction("consent"));
  });
});
