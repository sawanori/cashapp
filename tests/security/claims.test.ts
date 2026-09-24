/**
 * claim / unclaim の境界の統合テスト（実 Postgres・ロール `app_rw`）。task_022 scope / check_110。
 *
 * `tests/integration/claims.test.ts`（task_015 所有）が claim 3 本・同意・自己申告・追加
 * リクエストを厚く検査済みなので、ここではそれが対象にしていない 3 つの境界だけを扱う。
 *   1. 幹事が名簿から削除（論理削除）した参加者行は、UUID を知っていても claim できない。
 *   2. unclaim 後の**同時**再 claim（レース）でも「生きた claim は 1 つ」が DB 側で保証される
 *      （アプリの事前チェックではなく `participant_claim` の部分一意インデックスで決着する）。
 *   3. unclaim は「イベントの所有者」であることを要求する。参加者本人からは呼べない。
 *
 * ★ 呼び出しはすべて `withRollback` のトランザクション内でエクスポート済みの本体関数を直接呼ぶ
 *   （`createVerifiedDbClient()` 経由の実ルートは `docs/concerns/task_022.md` に記録した
 *   timestamptz の既知の不具合で無関係な 500 になるため経由しない）。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createAppRwSql,
  createMigratorSql,
  ensureAppRwLoginPassword,
  expectFailure,
  withRollback,
} from "../integration/setup";

vi.mock("server-only", () => ({}));

const { AppError } = await import("@/lib/errors");
const { createEvent } = await import("@/lib/db/repositories/events");
const { createParticipants, removeParticipant } = await import("@/lib/db/repositories/participants");
const { claimParticipant, unclaimParticipant } = await import("@/lib/db/repositories/claims");

type CreateEventInput = Parameters<typeof createEvent>[2];

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

async function insertUser(tx: postgres.TransactionSql, suffix: string): Promise<{ id: string; ref: Buffer }> {
  const ref = Buffer.from(`u-${suffix}`);
  const rows = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${ref}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  return { id: rows[0]!.id, ref };
}

function baseEventInput(overrides: Partial<CreateEventInput> = {}): CreateEventInput {
  return {
    title: "夏合宿",
    organizerLabel: "山田太郎",
    eventAt: null,
    venue: null,
    offering: null,
    defaultAmountMinor: 3000,
    collectByAt: null,
    minorsIncluded: false,
    allowCash: false,
    feeDisclosureAccepted: true,
    ...overrides,
  };
}

interface Fixture {
  readonly organizerId: string;
  readonly eventId: string;
  readonly participantId: string;
}

async function setupEvent(tx: postgres.TransactionSql): Promise<Fixture> {
  const organizer = await insertUser(tx, uniq());
  const created = await createEvent(tx, organizer.id, baseEventInput());
  const participants = await createParticipants(tx, organizer.id, created.event.id, [
    { displayLabel: "参加者A" },
  ]);
  await tx`UPDATE participant SET name_visibility = 'participants' WHERE event_id = ${created.event.id}`;
  return { organizerId: organizer.id, eventId: created.event.id, participantId: participants[0]!.id };
}

describe("削除済み参加者は claim できない", () => {
  it("幹事が名簿から削除した行は、UUID を知っていても 404（自動照合ではありません、と同種の存在秘匿）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const attacker = await insertUser(tx, uniq());

      await removeParticipant(tx, fixture.organizerId, fixture.eventId, fixture.participantId);

      const error = await expectFailure(tx, async (sp) => {
        await claimParticipant(sp, {
          eventId: fixture.eventId,
          lineUserRef: attacker.ref,
          pepperVersion: 1,
          input: { participantId: fixture.participantId, confirmed: true },
        });
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(404);

      const claims = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM participant_claim
        WHERE participant_id = ${fixture.participantId} AND released_at IS NULL
      `;
      expect(Number(claims[0]?.n)).toBe(0);
    });
  });
});

describe("unclaim 直後の同時再 claim は DB の一意インデックスで 1 本に決まる", () => {
  it("2 人が同時に claim しても、生きた claim は常に 1 件だけ", async () => {
    const suffix = uniq();
    let fixture: Fixture | undefined;
    let first: { id: string; ref: Buffer } | undefined;
    let second: { id: string; ref: Buffer } | undefined;

    try {
      // このケースだけは真の同時実行を検査するため実コミットが要る（他の統合テストと同じ理由。
      // `tests/integration/checkout.test.ts` の「同一請求へ同時 2 回 checkout」と同じ手口）。
      await appRw.begin(async (tx) => {
        fixture = await setupEvent(tx);
        first = await insertUser(tx, `${suffix}-1`);
        second = await insertUser(tx, `${suffix}-2`);
        await claimParticipant(tx, {
          eventId: fixture.eventId,
          lineUserRef: first.ref,
          pepperVersion: 1,
          input: { participantId: fixture.participantId, confirmed: true },
        });
        await unclaimParticipant(tx, fixture.organizerId, fixture.eventId, fixture.participantId);
      });
      const f = fixture!;
      const u1 = first!;
      const u2 = second!;

      const results = await Promise.allSettled([
        appRw.begin((tx) =>
          claimParticipant(tx, {
            eventId: f.eventId,
            lineUserRef: u1.ref,
            pepperVersion: 1,
            input: { participantId: f.participantId, confirmed: true },
          }),
        ),
        appRw.begin((tx) =>
          claimParticipant(tx, {
            eventId: f.eventId,
            lineUserRef: u2.ref,
            pepperVersion: 1,
            input: { participantId: f.participantId, confirmed: true },
          }),
        ),
      ]);

      const alive = await appRw<{ n: string }[]>`
        SELECT count(*)::text AS n FROM participant_claim
        WHERE participant_id = ${f.participantId} AND released_at IS NULL
      `;
      expect(alive[0]?.n).toBe("1");
      // 少なくとも 1 本は成功する（両方失敗は不合格）。
      expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    } finally {
      if (fixture !== undefined) {
        const f = fixture;
        await appRw`DELETE FROM participant_claim WHERE participant_id = ${f.participantId}`;
        await appRw`DELETE FROM participant WHERE id = ${f.participantId}`;
        await appRw`DELETE FROM event WHERE id = ${f.eventId}`;
        const ids = [f.organizerId, first?.id, second?.id].filter(
          (id): id is string => typeof id === "string",
        );
        if (ids.length > 0) {
          await appRw`DELETE FROM app_user WHERE id = ANY(${ids})`;
        }
      }
    }
  });
});

describe("unclaim は幹事本人しか呼べない", () => {
  it("参加者自身や他人の userId を渡しても 403 で、claim は生きたまま", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const participant = await insertUser(tx, uniq());
      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: participant.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participantId, confirmed: true },
      });

      // 参加者自身の app_user.id を「幹事」として渡しても通らない。
      const error = await expectFailure(tx, async (sp) => {
        await unclaimParticipant(sp, participant.id, fixture.eventId, fixture.participantId);
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(403);

      const claims = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM participant_claim
        WHERE participant_id = ${fixture.participantId} AND released_at IS NULL
      `;
      expect(Number(claims[0]?.n)).toBe(1);
    });
  });
});
