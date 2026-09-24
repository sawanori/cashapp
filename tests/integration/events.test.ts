/**
 * イベント・参加者 API の統合テスト（実 Postgres。`supabase start` 済みのローカル / CI）。
 * task_014 done_definition:
 *   - 他人の event への GET（サマリ）/PATCH/participants 一覧が 403
 *   - organizer_label 空は作成不可（400。DB 側の CHECK 制約も併せて確認）
 *   - 生きた attempt がある参加者の DELETE が 409 HAS_OPEN_ATTEMPT
 *   - 冪等キー再送は同一応答・越境（同キー別内容）は 409・response_body に joinToken を残さない
 *   - 100 名の名簿をカーソルページングで取り切れる
 *
 * 隔離: すべて `withRollback` のトランザクション内で行い、並列に走る他タスクのデータを汚さない。
 * 接続は本番と同じ最小権限ロール `app_rw`（`src/lib/db/client.ts` の `RUNTIME_DB_ROLE`）。
 * 監査連鎖（並行 insert・改竄検知）は `tests/integration/audit-chain.test.ts` に分離する。
 */

import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { asPgError, createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, insertBaseFixture, withRollback } from "./setup";

vi.mock("server-only", () => ({}));

const { AppError } = await import("@/lib/errors");
const {
  MAX_ACTIVE_EVENTS_PER_ORGANIZER,
  assertEventOwnedByOrganizer,
  createEvent,
  getEventSummary,
  updateEvent,
} = await import("@/lib/db/repositories/events");
type CreateEventInput = Parameters<typeof createEvent>[2];
const { createParticipants, listParticipants, removeParticipant } = await import(
  "@/lib/db/repositories/participants"
);
const { computeRequestHash, idempotencyUserRef, runIdempotent } = await import("@/lib/idempotency");

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

/**
 * `assertEventOwnedByOrganizer` / `getEventSummary` / `listParticipants` / `runIdempotent` は
 * 読み取り専用の `postgres.Sql` を取る（`src/lib/db/repositories/events.ts` 等）。
 * `withRollback` のコールバックは `postgres.TransactionSql` を渡すため、`tests/integration/auth.test.ts`
 * と同じ方針でここだけ型を合わせる（実行時は同じオブジェクトで、トランザクション内でも読み書き可能）。
 */
function asSql(tx: postgres.TransactionSql): postgres.Sql {
  return tx as unknown as postgres.Sql;
}

async function insertOrganizer(tx: postgres.TransactionSql, suffix: string): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`organizer-${suffix}`)}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("failed to insert test organizer");
  return row.id;
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

const ALL_PARTICIPANTS_QUERY = {
  filter: "all" as const,
  q: null,
  cursor: null,
  limit: 30,
  sort: "created_asc" as const,
};

describe("IDOR: 他人の event への GET/PATCH/participants", () => {
  it("作成者は自分の event を取得・更新・名簿参照できる", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const created = await createEvent(tx, organizerId, baseEventInput());

      const owned = await assertEventOwnedByOrganizer(asSql(tx), organizerId, created.event.id);
      expect(owned.id).toBe(created.event.id);

      const summary = await getEventSummary(asSql(tx), organizerId, created.event.id);
      expect(summary.id).toBe(created.event.id);
      expect(summary.organizerLabel).toBe("山田太郎");

      const updated = await updateEvent(tx, organizerId, created.event.id, { title: "改題" });
      expect(updated.title).toBe("改題");

      const list = await listParticipants(asSql(tx), organizerId, created.event.id, ALL_PARTICIPANTS_QUERY);
      expect(list.items).toEqual([]);
    });
  });

  it("他人（organizer B）は GET（サマリ）/PATCH/participants 一覧のいずれも 403 になる", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerA = await insertOrganizer(tx, `${uniq()}-a`);
      const organizerB = await insertOrganizer(tx, `${uniq()}-b`);
      const created = await createEvent(tx, organizerA, baseEventInput());
      const eventId = created.event.id;

      const assertForbidden = async (promise: Promise<unknown>): Promise<void> => {
        let thrown: unknown;
        try {
          await promise;
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(AppError);
        expect((thrown as InstanceType<typeof AppError>).status).toBe(403);
        expect((thrown as InstanceType<typeof AppError>).code).toBe("FORBIDDEN");
      };

      await assertForbidden(assertEventOwnedByOrganizer(asSql(tx), organizerB, eventId));
      await assertForbidden(getEventSummary(asSql(tx), organizerB, eventId));
      await assertForbidden(updateEvent(tx, organizerB, eventId, { title: "乗っ取り" }));
      await assertForbidden(listParticipants(asSql(tx), organizerB, eventId, ALL_PARTICIPANTS_QUERY));
      await assertForbidden(createParticipants(tx, organizerB, eventId, [{ displayLabel: "侵入者" }]));

      // 他人の PATCH が本当に無効だったことを確認する（タイトルは変わっていない）。
      const summary = await getEventSummary(asSql(tx), organizerA, eventId);
      expect(summary.title).toBe("夏合宿");
    });
  });

  it("存在しない event は 404（403 ではなく）", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      let thrown: unknown;
      try {
        await getEventSummary(asSql(tx), organizerId, "00000000-0000-0000-0000-000000000000");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as InstanceType<typeof AppError>).status).toBe(404);
    });
  });
});

describe("organizer_label が空だと作成できない", () => {
  it("parseCreateEventBody を経由しない直接呼び出しでも、空文字は呼び出し側の責務として弾かれる想定を確認する", async () => {
    // parseCreateEventBody（純粋関数）のユニットテストは tests/unit/api/events.test.ts が担当する。
    // ここでは DB 側の CHECK 制約（多層防御）が、アプリ検証を迂回した空文字挿入も拒否することを示す。
    await withRollback(migrator, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const error = await (async (): Promise<unknown> => {
        try {
          await tx`
            INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash, minors_included)
            VALUES (${organizerId}, 'タイトル', '', ${Buffer.from(`join-${uniq()}`)}, false)
          `;
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeDefined();
      // 23514 = check_violation
      expect(asPgError(error).code).toBe("23514");
    });
  });
});

describe("幹事あたりのイベント数上限", () => {
  it(`${String(MAX_ACTIVE_EVENTS_PER_ORGANIZER)} 件を超える作成は 429`, async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      for (let i = 0; i < MAX_ACTIVE_EVENTS_PER_ORGANIZER; i += 1) {
        await createEvent(tx, organizerId, baseEventInput({ title: `event-${i}` }));
      }
      let thrown: unknown;
      try {
        await createEvent(tx, organizerId, baseEventInput({ title: "one-too-many" }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as InstanceType<typeof AppError>).status).toBe(429);
    });
  });
});

describe("参加者の論理削除・HAS_OPEN_ATTEMPT（check_081）", () => {
  it("生きた決済試行がある参加者の DELETE は 409 HAS_OPEN_ATTEMPT", async () => {
    await withRollback(appRw, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      await tx`
        INSERT INTO payment_attempt (invoice_id, provider_key, provider_binding_id, external_ref, amount_minor)
        VALUES (${f.invoiceId}, 'manual_confirm', ${f.bindingId}, ${`iv_${uniq().replace(/[^A-Za-z0-9_-]/g, "")}`}, 3000)
      `;

      let thrown: unknown;
      try {
        await removeParticipant(tx, f.userId, f.eventId, f.participantId);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as InstanceType<typeof AppError>).status).toBe(409);
      expect((thrown as InstanceType<typeof AppError>).code).toBe("HAS_OPEN_ATTEMPT");

      // 試行が決着（succeeded）すれば is_open が false になり、削除できるようになる。
      await tx`UPDATE payment_attempt SET status = 'succeeded' WHERE invoice_id = ${f.invoiceId}`;
      const removed = await removeParticipant(tx, f.userId, f.eventId, f.participantId);
      expect(removed.alreadyRemoved).toBe(false);

      // 論理削除は冪等: もう一度呼んでも 409 にはならない。
      const removedAgain = await removeParticipant(tx, f.userId, f.eventId, f.participantId);
      expect(removedAgain.alreadyRemoved).toBe(true);
    });
  });

  it("台帳（ledger_entry / 支払済み invoice）を持つ参加者の DELETE は 500 にならず論理削除だけが起きる（check_081）", async () => {
    await withRollback(appRw, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      await tx`UPDATE invoice SET settlement_status = 'paid' WHERE id = ${f.invoiceId}`;

      const removed = await removeParticipant(tx, f.userId, f.eventId, f.participantId);
      expect(removed.alreadyRemoved).toBe(false);

      const participantRows = await tx<{ status: string }[]>`
        SELECT status FROM participant WHERE id = ${f.participantId}
      `;
      expect(participantRows[0]?.status).toBe("removed");

      // 請求データ自体は一切変更されていない（名簿からの表示のみが変わる）。
      const invoiceRows = await tx<{ settlement_status: string; amount_minor: number }[]>`
        SELECT settlement_status, amount_minor FROM invoice WHERE id = ${f.invoiceId}
      `;
      expect(invoiceRows[0]?.settlement_status).toBe("paid");
      expect(invoiceRows[0]?.amount_minor).toBe(3000);
    });
  });

  it("存在しない participant は 404", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const created = await createEvent(tx, organizerId, baseEventInput());
      let thrown: unknown;
      try {
        await removeParticipant(tx, organizerId, created.event.id, "00000000-0000-0000-0000-000000000000");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as InstanceType<typeof AppError>).status).toBe(404);
    });
  });
});

describe("冪等キー（Idempotency-Key）", () => {
  it("同じキー・同じ内容の再送は同一応答を返し、event は 1 件しか作られない。response_body に joinToken は残らない", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const payload = { title: "冪等テスト", organizerLabel: "幹事", minorsIncluded: false };
      const requestHash = await computeRequestHash(payload);
      const userRef = idempotencyUserRef(organizerId);
      const key = `idem-${uniq()}`;
      const endpoint = "POST /api/events (test)";

      const run = (): ReturnType<typeof runIdempotent> =>
        runIdempotent({ sql: tx, userRef, endpoint, key, requestHash }, async () => {
          const result = await createEvent(tx, organizerId, baseEventInput({ title: payload.title }));
          return {
            statusCode: 201,
            cacheableBody: { event: { id: result.event.id } },
            extra: { joinToken: result.joinToken },
          };
        });

      const first = await run();
      expect(first.replayed).toBe(false);
      expect(typeof first.body["joinToken"]).toBe("string");
      const eventId = (first.body["event"] as { id: string }).id;

      const second = await run();
      expect(second.replayed).toBe(true);
      expect((second.body["event"] as { id: string }).id).toBe(eventId);
      // 再送の応答には joinToken が含まれない（保存されていないため）。
      expect(second.body).not.toHaveProperty("joinToken");

      const countRows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM event WHERE organizer_user_id = ${organizerId}
      `;
      expect(countRows[0]?.n).toBe("1");

      // DB に保存された response_body 自体にも joinToken が無いことを直接確認する。
      const storedRows = await tx<{ response_body: Record<string, unknown> | null }[]>`
        SELECT response_body FROM idempotency_key
        WHERE user_ref = ${userRef} AND endpoint = ${endpoint} AND key = ${key}
      `;
      expect(storedRows[0]?.response_body).not.toHaveProperty("joinToken");
    });
  });

  it("同じキーで内容の異なるリクエスト（越境）は 409 IDEMPOTENCY_CONFLICT", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const userRef = idempotencyUserRef(organizerId);
      const key = `idem-conflict-${uniq()}`;
      const endpoint = "POST /api/events (test)";

      const firstHash = await computeRequestHash({ title: "A" });
      await runIdempotent(
        { sql: tx, userRef, endpoint, key, requestHash: firstHash },
        async () => {
          const result = await createEvent(tx, organizerId, baseEventInput({ title: "A" }));
          return { statusCode: 201, cacheableBody: { event: { id: result.event.id } } };
        },
      );

      const secondHash = await computeRequestHash({ title: "B（別内容）" });
      let thrown: unknown;
      try {
        await runIdempotent(
          { sql: tx, userRef, endpoint, key, requestHash: secondHash },
          async () => {
            const result = await createEvent(tx, organizerId, baseEventInput({ title: "B" }));
            return { statusCode: 201, cacheableBody: { event: { id: result.event.id } } };
          },
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as InstanceType<typeof AppError>).status).toBe(409);
      expect((thrown as InstanceType<typeof AppError>).code).toBe("IDEMPOTENCY_CONFLICT");

      // 競合したリクエストのハンドラは実行されていない（event が 2 件目作られていない）。
      const countRows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM event WHERE organizer_user_id = ${organizerId}
      `;
      expect(countRows[0]?.n).toBe("1");
    });
  });

  // P-01（docs/research/premortem-phase1b-2026-09-24.md）の是正を固定する 2 本。
  // 予約（idempotency_key）・業務書き込み・done 更新は呼び出し側の 1 トランザクションにまとめて
  // あるべきで、`handler` の失敗はその**全体**を打ち消す（予約だけを DELETE で個別に解放しない）。
  // ここでは本番の `sql.begin()` に相当するものを `tx.savepoint()` で模し（外側は withRollback
  // が既にトランザクションを開いているため）、savepoint への ROLLBACK で同じ効果を確認する。
  describe("冪等予約のトランザクション原子性（P-01 是正）", () => {
    it("handler が業務行を書き込んだ後に例外を投げると、業務行・予約行のどちらも残らない", async () => {
      await withRollback(appRw, async (tx) => {
        const organizerId = await insertOrganizer(tx, uniq());
        const payload = { title: "原子性テスト" };
        const requestHash = await computeRequestHash(payload);
        const userRef = idempotencyUserRef(organizerId);
        const key = `idem-atomic-${uniq()}`;
        const endpoint = "POST /api/events (atomic test)";

        let thrown: unknown;
        try {
          await tx.savepoint(async (sp) =>
            runIdempotent({ sql: sp, userRef, endpoint, key, requestHash }, async () => {
              // 業務データを書き込んだ**あとに**例外を投げる（P-01 が描写する
              // 「業務 tx はコミット済みだがその後の経路で例外」を、同一トランザクション内の
              // 途中失敗として模す）。
              await createEvent(sp, organizerId, baseEventInput({ title: payload.title }));
              throw new Error("simulated crash after business write, before commit");
            }),
          );
        } catch (error) {
          thrown = error;
        }
        expect((thrown as Error | undefined)?.message).toBe(
          "simulated crash after business write, before commit",
        );

        // 業務行（event）が残っていない: ロールバックが業務書き込みごと打ち消した。
        const eventRows = await tx<{ n: string }[]>`
          SELECT count(*)::text AS n FROM event
          WHERE organizer_user_id = ${organizerId} AND title = ${payload.title}
        `;
        expect(eventRows[0]?.n).toBe("0");

        // 予約行（idempotency_key）も残っていない: TTL 24h の間ブロックされ続ける孤児にならない。
        const reservationRows = await tx<{ n: string }[]>`
          SELECT count(*)::text AS n FROM idempotency_key
          WHERE user_ref = ${userRef} AND endpoint = ${endpoint} AND key = ${key}
        `;
        expect(reservationRows[0]?.n).toBe("0");

        // 同じキーでの再送は、孤児化した予約に阻まれず、業務処理を 1 回だけ新規に実行できる
        // （P-01 が禁じる「二重実行」ではなく、まっさらな 1 回目として扱われることを確認）。
        const retry = await tx.savepoint(async (sp) =>
          runIdempotent({ sql: sp, userRef, endpoint, key, requestHash }, async () => {
            const result = await createEvent(sp, organizerId, baseEventInput({ title: payload.title }));
            return { statusCode: 201, cacheableBody: { event: { id: result.event.id } } };
          }),
        );
        expect(retry.replayed).toBe(false);

        const eventRowsAfterRetry = await tx<{ n: string }[]>`
          SELECT count(*)::text AS n FROM event
          WHERE organizer_user_id = ${organizerId} AND title = ${payload.title}
        `;
        expect(eventRowsAfterRetry[0]?.n).toBe("1");
      });
    });

    it("成功時は業務行と done 更新が同一トランザクションでコミットされる（部分コミットが起きない）", async () => {
      await withRollback(appRw, async (tx) => {
        const organizerId = await insertOrganizer(tx, uniq());
        const payload = { title: "同時コミットテスト" };
        const requestHash = await computeRequestHash(payload);
        const userRef = idempotencyUserRef(organizerId);
        const key = `idem-commit-${uniq()}`;
        const endpoint = "POST /api/events (commit test)";

        const outcome = await tx.savepoint(async (sp) =>
          runIdempotent({ sql: sp, userRef, endpoint, key, requestHash }, async () => {
            const result = await createEvent(sp, organizerId, baseEventInput({ title: payload.title }));
            return { statusCode: 201, cacheableBody: { event: { id: result.event.id } } };
          }),
        );
        expect(outcome.replayed).toBe(false);

        // savepoint はコミットされている（ROLLBACK していない）ので、外側の tx から見て
        // 業務行と idempotency_key の両方が 'done' として存在する。
        const eventRows = await tx<{ n: string }[]>`
          SELECT count(*)::text AS n FROM event
          WHERE organizer_user_id = ${organizerId} AND title = ${payload.title}
        `;
        expect(eventRows[0]?.n).toBe("1");

        const stateRows = await tx<{ state: string }[]>`
          SELECT state FROM idempotency_key
          WHERE user_ref = ${userRef} AND endpoint = ${endpoint} AND key = ${key}
        `;
        expect(stateRows[0]?.state).toBe("done");
      });
    });
  });
});

describe("100 名の名簿をカーソルページングで取り切る（check_082 / R-UX-03）", () => {
  it("limit=30 で全 100 名を重複・欠落なく巡回できる", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const created = await createEvent(tx, organizerId, baseEventInput());
      const eventId = created.event.id;

      const labels = Array.from({ length: 100 }, (_, i) => ({ displayLabel: `参加者${i}` }));
      const inserted = await createParticipants(tx, organizerId, eventId, labels);
      expect(inserted).toHaveLength(100);

      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      for (;;) {
        const page = await listParticipants(asSql(tx), organizerId, eventId, {
          filter: "all",
          q: null,
          cursor,
          limit: 30,
          sort: "created_asc",
        });
        pages += 1;
        for (const item of page.items) {
          expect(seen.has(item.id)).toBe(false);
          seen.add(item.id);
        }
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
        expect(pages).toBeLessThan(10); // 無限ループの保険
      }

      expect(seen.size).toBe(100);
      expect(pages).toBe(4); // 30 + 30 + 30 + 10
    });
  });

  it("101 件目の登録は上限超過で 429（MAX_PARTICIPANTS_PER_EVENT）", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const created = await createEvent(tx, organizerId, baseEventInput());
      const eventId = created.event.id;

      const labels = Array.from({ length: 100 }, (_, i) => ({ displayLabel: `参加者${i}` }));
      await createParticipants(tx, organizerId, eventId, labels);

      let thrown: unknown;
      try {
        await createParticipants(tx, organizerId, eventId, [{ displayLabel: "101 人目" }]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as InstanceType<typeof AppError>).status).toBe(429);
    });
  });

  it("既定フィルタ unpaid は支払済みを除外し、q は前方一致で絞り込む", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const created = await createEvent(tx, organizerId, baseEventInput());
      const eventId = created.event.id;

      const [unpaid, paidTarget] = await createParticipants(tx, organizerId, eventId, [
        { displayLabel: "未払い花子" },
        { displayLabel: "支払済み太郎" },
      ]);

      const [invoiceRow] = await tx<{ id: string }[]>`
        INSERT INTO invoice (event_id, participant_id, amount_minor, settlement_status)
        VALUES (${eventId}, ${paidTarget!.id}, 3000, 'paid')
        RETURNING id
      `;
      expect(invoiceRow?.id).toBeDefined();

      const unpaidOnly = await listParticipants(asSql(tx), organizerId, eventId, {
        filter: "unpaid",
        q: null,
        cursor: null,
        limit: 30,
        sort: "created_asc",
      });
      expect(unpaidOnly.items.map((i) => i.id)).toEqual([unpaid!.id]);

      const searched = await listParticipants(asSql(tx), organizerId, eventId, {
        filter: "all",
        q: "未払い",
        cursor: null,
        limit: 30,
        sort: "created_asc",
      });
      expect(searched.items.map((i) => i.id)).toEqual([unpaid!.id]);
    });
  });
});
