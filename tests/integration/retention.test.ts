/**
 * 保持期間 cron の統合テスト（check_043 / R-DATA-01 / premortem P-03）。
 *
 *   - **アプリの通常導線だけ**（イベントを作って `closed` にする）から起点が生まれ、
 *     `retention_due_at` が cron 自身によって埋まる（フィクスチャで直接書かない）
 *   - 期日を過ぎたイベントの `participant.display_label` が NULL になる
 *   - `event.organizer_label` は NOT NULL 制約のため**固定文字列へ置換**される
 *     （check_043 の「NULL」とはここだけ食い違う。docs/concerns/task_020.md 参照）
 *   - `webhook_delivery.raw_body` は 14 日で NULL、`body_sha256` は残る
 *   - 期日前のイベントには触らない
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

const { REDACTED_ORGANIZER_LABEL, RETENTION_DAYS, runRetention } = await import("@/lib/retention");

const DAY_MS = 24 * 60 * 60 * 1000;

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

interface EventFixture {
  readonly eventId: string;
  readonly participantId: string;
}

/** 幹事 → イベント → 参加者。`collect_by_at` が「終了」の代理になる（P-03）。 */
async function insertEvent(
  tx: postgres.TransactionSql,
  suffix: string,
  options: { readonly status: string; readonly collectByAt: Date },
): Promise<EventFixture> {
  const unique = `${suffix}-${crypto.randomUUID().slice(0, 8)}`;
  const [user] = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`ret-${unique}`)}, ${`ret:${unique}`}, 'development')
    RETURNING id
  `;
  const [event] = await tx<{ id: string }[]>`
    INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                       minors_included, status, collect_by_at)
    VALUES (${user!.id}, ${`ev-${unique}`}, '山田太郎', ${Buffer.from(`jt-ret-${unique}`)},
            false, ${options.status}, ${options.collectByAt})
    RETURNING id
  `;
  const [participant] = await tx<{ id: string }[]>`
    INSERT INTO participant (event_id, display_label)
    VALUES (${event!.id}, '鈴木花子')
    RETURNING id
  `;
  return { eventId: event!.id, participantId: participant!.id };
}

async function labelsOf(
  tx: postgres.TransactionSql,
  fixture: EventFixture,
): Promise<{ organizer: string; participant: string | null; dueAt: Date | null }> {
  const [event] = await tx<{ organizer_label: string; retention_due_at: Date | null }[]>`
    SELECT organizer_label, retention_due_at FROM event WHERE id = ${fixture.eventId}
  `;
  const [participant] = await tx<{ display_label: string | null }[]>`
    SELECT display_label FROM participant WHERE id = ${fixture.participantId}
  `;
  return {
    organizer: event?.organizer_label ?? "",
    participant: participant?.display_label ?? null,
    dueAt: event?.retention_due_at ?? null,
  };
}

describe("保持期間 cron（check_043）", () => {
  it("終了 +90 日を過ぎたイベントの表示名を消す。期日は cron が自分で埋める", async () => {
    await withRollback(appRw, async (tx) => {
      const now = new Date();
      // 100 日前に締め切って closed にしたイベント（= 期日 10 日前）。
      const old = await insertEvent(tx, "ret-old", {
        status: "closed",
        collectByAt: new Date(now.getTime() - 100 * DAY_MS),
      });
      // 10 日前に締め切った closed（= 期日は 80 日先）。
      const recent = await insertEvent(tx, "ret-recent", {
        status: "closed",
        collectByAt: new Date(now.getTime() - 10 * DAY_MS),
      });
      // 集金中のイベントは期日そのものを持たない。
      const collecting = await insertEvent(tx, "ret-collecting", {
        status: "collecting",
        collectByAt: new Date(now.getTime() - 100 * DAY_MS),
      });

      const result = await runRetention(tx, now);

      expect(result.dueDatesBackfilled).toBeGreaterThanOrEqual(2);
      expect(result.participantLabelsCleared).toBeGreaterThanOrEqual(1);
      expect(result.organizerLabelsRedacted).toBeGreaterThanOrEqual(1);

      const oldLabels = await labelsOf(tx, old);
      expect(oldLabels.dueAt).not.toBeNull();
      expect(oldLabels.participant).toBeNull();
      expect(oldLabels.organizer).toBe(REDACTED_ORGANIZER_LABEL);

      const recentLabels = await labelsOf(tx, recent);
      expect(recentLabels.dueAt).not.toBeNull();
      expect(recentLabels.participant).toBe("鈴木花子");
      expect(recentLabels.organizer).toBe("山田太郎");

      const collectingLabels = await labelsOf(tx, collecting);
      expect(collectingLabels.dueAt).toBeNull();
      expect(collectingLabels.participant).toBe("鈴木花子");
    });
  });

  it("期日は 終了 + 90 日 で、2 回目の実行では動かない（冪等）", async () => {
    await withRollback(appRw, async (tx) => {
      const now = new Date();
      const collectByAt = new Date(now.getTime() - 100 * DAY_MS);
      const fixture = await insertEvent(tx, "ret-idem", { status: "closed", collectByAt });

      await runRetention(tx, now);
      const first = await labelsOf(tx, fixture);
      expect(first.dueAt?.getTime()).toBe(collectByAt.getTime() + RETENTION_DAYS * DAY_MS);

      const second = await runRetention(tx, now);
      expect(second.participantLabelsCleared).toBe(0);
      expect(second.organizerLabelsRedacted).toBe(0);
      const after = await labelsOf(tx, fixture);
      expect(after.dueAt?.getTime()).toBe(first.dueAt?.getTime());
    });
  });

  it("14 日を過ぎた webhook_delivery.raw_body は消え、body_sha256 は残る", async () => {
    await withRollback(appRw, async (tx) => {
      const now = new Date();
      const digest = "a".repeat(64);
      const [oldRow] = await tx<{ id: string }[]>`
        INSERT INTO webhook_delivery (provider_key, received_at, sig_ok, ip_allowed, http_status,
                                      body_sha256, raw_body)
        VALUES ('fixture_provider', ${new Date(now.getTime() - 15 * DAY_MS)}, true, true, 200,
                ${digest}, '{"secret":"keep-me-out"}')
        RETURNING id
      `;
      const [freshRow] = await tx<{ id: string }[]>`
        INSERT INTO webhook_delivery (provider_key, received_at, sig_ok, ip_allowed, http_status,
                                      body_sha256, raw_body)
        VALUES ('fixture_provider', ${new Date(now.getTime() - 13 * DAY_MS)}, true, true, 200,
                ${digest}, '{"still":"here"}')
        RETURNING id
      `;

      const result = await runRetention(tx, now);
      expect(result.rawBodiesCleared).toBeGreaterThanOrEqual(1);

      const [old] = await tx<{ raw_body: string | null; body_sha256: string }[]>`
        SELECT raw_body, body_sha256 FROM webhook_delivery WHERE id = ${oldRow!.id}
      `;
      expect(old?.raw_body).toBeNull();
      expect(old?.body_sha256).toBe(digest);

      const [fresh] = await tx<{ raw_body: string | null }[]>`
        SELECT raw_body FROM webhook_delivery WHERE id = ${freshRow!.id}
      `;
      expect(fresh?.raw_body).not.toBeNull();
    });
  });
});
