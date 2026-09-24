/**
 * IDOR（他人のイベント・請求・名簿への到達）の統合テスト（実 Postgres・ロール `app_rw`）。
 *
 * task_022 scope / check_110。`tests/integration/idor.test.ts`（task_015 所有）が
 * claim / unclaim / preview の境界を репository 関数レベルで検査済みなので、ここでは
 * それとは別の表面 — 幹事の所有権ガード（`assertEventOwnedByOrganizer` を経由する
 * イベント参照・請求金額訂正・取消・名簿一覧）を対象にする。
 *
 * ★ ルート本体（`POST()`/`GET()`）ではなく、各ルートが呼ぶ**エクスポート済みの本体関数**を
 *   直接 `withRollback` のトランザクションで呼ぶ（`tests/integration/checkout.test.ts` /
 *   `manual-attest.test.ts` と同じ方針）。理由: `createVerifiedDbClient()`（各ルートの入口）は
 *   `drizzle(client, { schema })` の副作用で timestamptz の読み書きが壊れる既知の不具合が
 *   あり（`docs/concerns/task_021.md` #1・`docs/concerns/task_022.md` で本タスクが実測を追記）、
 *   実ルート経由では IDOR 判定に到達する前に無関係な 500 で落ちる。本体関数はこの壊れた
 *   経路を経由しないため、認可判定そのものは安全に検査できる。
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
const { createEvent, assertEventOwnedByOrganizer, getEventSummary } = await import(
  "@/lib/db/repositories/events"
);
const { createParticipants, listParticipants } = await import("@/lib/db/repositories/participants");
const { issueInvoices, updateInvoiceAmount, voidInvoice } = await import(
  "@/lib/db/repositories/invoices"
);

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

function asSql(tx: postgres.TransactionSql): postgres.Sql {
  return tx as unknown as postgres.Sql;
}

async function insertUser(tx: postgres.TransactionSql, suffix: string): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`u-${suffix}`)}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  return rows[0]!.id;
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
  readonly invoiceId: string;
}

async function setupEventWithInvoice(tx: postgres.TransactionSql): Promise<Fixture> {
  const organizerId = await insertUser(tx, uniq());
  const created = await createEvent(tx, organizerId, baseEventInput());
  const participants = await createParticipants(tx, organizerId, created.event.id, [
    { displayLabel: "参加者A" },
  ]);
  await issueInvoices(tx, organizerId, created.event.id);
  const invoiceRows = await tx<{ id: string }[]>`
    SELECT id FROM invoice WHERE participant_id = ${participants[0]!.id}
  `;
  return { organizerId, eventId: created.event.id, invoiceId: invoiceRows[0]!.id };
}

describe("assertEventOwnedByOrganizer — 他人のイベントは 404（存在を教えない）", () => {
  it("所有者は通り、非所有者は 404、存在しない ID も 404（同じ結末）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEventWithInvoice(tx);
      const stranger = await insertUser(tx, uniq());

      const owned = await assertEventOwnedByOrganizer(asSql(tx), fixture.organizerId, fixture.eventId);
      expect(owned.id).toBe(fixture.eventId);

      const forbidden = await expectFailure(tx, async (sp) => {
        await assertEventOwnedByOrganizer(asSql(sp), stranger, fixture.eventId);
      });
      expect(forbidden).toBeInstanceOf(AppError);
      expect((forbidden as InstanceType<typeof AppError>).status).toBe(403);

      const notFound = await expectFailure(tx, async (sp) => {
        await assertEventOwnedByOrganizer(asSql(sp), stranger, "00000000-0000-4000-8000-000000000000");
      });
      expect((notFound as InstanceType<typeof AppError>).status).toBe(404);
    });
  });
});

describe("GET /api/events/:id 相当（getEventSummary）は非所有者に届かない", () => {
  it("非所有者の呼び出しは summary を構築する前に 403 で止まる", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEventWithInvoice(tx);
      const stranger = await insertUser(tx, uniq());

      const error = await expectFailure(tx, async (sp) => {
        await getEventSummary(asSql(sp), stranger, fixture.eventId);
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(403);
    });
  });
});

describe("PATCH /api/invoices/:id 相当（updateInvoiceAmount）は他人の請求を訂正できない", () => {
  it("他人の請求 ID を指定しても 404（自分の請求の個数・状態は変わらない）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEventWithInvoice(tx);
      const attacker = await insertUser(tx, uniq());

      const error = await expectFailure(tx, async (sp) => {
        await updateInvoiceAmount(sp, attacker, fixture.invoiceId, { amountMinor: 1 });
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(404);

      const rows = await tx<{ amount_minor: number }[]>`
        SELECT amount_minor FROM invoice WHERE id = ${fixture.invoiceId}
      `;
      expect(rows[0]?.amount_minor).toBe(3000);
    });
  });
});

describe("POST /api/invoices/:id/void 相当（voidInvoice）は他人の請求を取り消せない", () => {
  it("他人の請求 ID を指定しても 404、lifecycle_state は active のまま", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEventWithInvoice(tx);
      const attacker = await insertUser(tx, uniq());

      const error = await expectFailure(tx, async (sp) => {
        await voidInvoice(sp, attacker, fixture.invoiceId);
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(404);

      const rows = await tx<{ lifecycle_state: string }[]>`
        SELECT lifecycle_state FROM invoice WHERE id = ${fixture.invoiceId}
      `;
      expect(rows[0]?.lifecycle_state).toBe("active");
    });
  });
});

describe("GET /api/events/:id/participants 相当（listParticipants）は他人の名簿を返さない", () => {
  it("非所有者の呼び出しは行を 1 件も返さず 403 で止まる", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEventWithInvoice(tx);
      const stranger = await insertUser(tx, uniq());

      const error = await expectFailure(tx, async (sp) => {
        await listParticipants(asSql(sp), stranger, fixture.eventId, {
          cursor: null,
          q: null,
          filter: "all",
          sort: "created_asc",
          limit: 50,
        });
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(403);
    });
  });
});
