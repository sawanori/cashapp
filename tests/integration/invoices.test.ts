/**
 * 請求の発行・金額訂正・取消の統合テスト（実 Postgres。`supabase start` 済みのローカル / CI）。
 *
 * task_015 done_definition / acceptance-checks:
 *   - O-6「既発行スキップ」: 2 回目の発行で新しい請求が増えない。
 *   - PATCH /api/invoices/:id は `settlement_rank = 0` かつ open attempt 無しのときだけ通る。
 *   - check_008: `settlement_rank >= 40` の請求を void すると 409 `VOID_NOT_ALLOWED`。
 *     Webhook 経路から void を呼ぶコードが存在しないことも静的に確かめる。
 *
 * 隔離: すべて `withRollback` のトランザクション内で行う。接続は本番と同じ最小権限ロール `app_rw`。
 */

import fs from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  REPO_ROOT,
  createAppRwSql,
  createMigratorSql,
  ensureAppRwLoginPassword,
  expectFailure,
  withRollback,
} from "./setup";

vi.mock("server-only", () => ({}));

const { AppError } = await import("@/lib/errors");
const { createEvent } = await import("@/lib/db/repositories/events");
const { createParticipants } = await import("@/lib/db/repositories/participants");
const {
  issueInvoices,
  parseIssueInvoicesBody,
  parseUpdateInvoiceBody,
  updateInvoiceAmount,
  voidInvoice,
} = await import("@/lib/db/repositories/invoices");
const { approveAdd, requestAdd } = await import("@/lib/db/repositories/claims");

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

/** 生きた決済試行を 1 件作る（`payment_attempt.is_open` は生成列）。 */
async function insertOpenAttempt(
  tx: postgres.TransactionSql,
  organizerUserId: string,
  invoiceId: string,
  suffix: string,
): Promise<void> {
  const bindingRows = await tx<{ id: string }[]>`
    INSERT INTO provider_binding (organizer_user_id, provider_key, capabilities)
    VALUES (${organizerUserId}, 'manual_confirm', '{}'::jsonb)
    RETURNING id
  `;
  const bindingId = bindingRows[0]?.id;
  if (bindingId === undefined) throw new Error("failed to insert provider_binding");
  await tx`
    INSERT INTO payment_attempt (invoice_id, provider_key, provider_binding_id, external_ref, amount_minor)
    VALUES (${invoiceId}, 'manual_confirm', ${bindingId},
            ${`iv_${suffix.replace(/[^A-Za-z0-9_-]/g, "")}`}, 3000)
  `;
}

describe("parseIssueInvoicesBody（O-6.5 の確認済みフラグ）", () => {
  it("confirmed: true 以外は 400", () => {
    expect(parseIssueInvoicesBody({ confirmed: true }).confirmed).toBe(true);
    expect(() => parseIssueInvoicesBody({})).toThrow(AppError);
    expect(() => parseIssueInvoicesBody({ confirmed: false })).toThrow(AppError);
    expect(() => parseIssueInvoicesBody({ confirmed: "true" })).toThrow(AppError);
    expect(() => parseIssueInvoicesBody(null)).toThrow(AppError);
  });
});

describe("parseUpdateInvoiceBody", () => {
  it("1〜1,000,000 の整数だけを受け付ける", () => {
    expect(parseUpdateInvoiceBody({ amountMinor: 5000 }).amountMinor).toBe(5000);
    expect(() => parseUpdateInvoiceBody({ amountMinor: 0 })).toThrow(AppError);
    expect(() => parseUpdateInvoiceBody({ amountMinor: 1_000_001 })).toThrow(AppError);
    expect(() => parseUpdateInvoiceBody({ amountMinor: 1.5 })).toThrow(AppError);
    expect(() => parseUpdateInvoiceBody({})).toThrow(AppError);
  });
});

describe("請求の一括発行（O-6）", () => {
  it("名簿の人数ぶん発行され、2 回目は 1 件も増えない（既発行スキップ）", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const event = await createEvent(tx, organizerId, baseEventInput());
      await createParticipants(tx, organizerId, event.event.id, [
        { displayLabel: "山田" },
        { displayLabel: "鈴木" },
        { displayLabel: "佐藤" },
      ]);

      const first = await issueInvoices(tx, organizerId, event.event.id);
      expect(first.created).toBe(3);
      expect(first.skipped).toBe(0);
      expect(first.amountMinor).toBe(3000);

      const second = await issueInvoices(tx, organizerId, event.event.id);
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(3);

      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM invoice WHERE event_id = ${event.event.id}
      `;
      expect(Number(rows[0]?.n)).toBe(3);
    });
  });

  it("未承認の追加リクエストには発行されず、承認後に発行される（check_088）", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const event = await createEvent(tx, organizerId, baseEventInput());
      await createParticipants(tx, organizerId, event.event.id, [{ displayLabel: "山田" }]);
      const requester = await insertOrganizer(tx, uniq());
      const requesterRef = Buffer.from(`requester-${requester}`);
      const requested = await requestAdd(tx, event.event.id, {
        lineUserRef: requesterRef,
        pepperVersion: 1,
        input: { displayLabel: "田中" },
      });

      const first = await issueInvoices(tx, organizerId, event.event.id);
      expect(first.created).toBe(1);

      const pendingInvoice = await tx<{ id: string }[]>`
        SELECT id FROM invoice WHERE participant_id = ${requested.participantId}
      `;
      expect(pendingInvoice.length).toBe(0);

      await approveAdd(tx, organizerId, event.event.id, requested.participantId);
      const second = await issueInvoices(tx, organizerId, event.event.id);
      expect(second.created).toBe(1);
      expect(second.skipped).toBe(1);
    });
  });

  it("既定金額が無いイベントでは発行できない（400）", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const event = await createEvent(tx, organizerId, baseEventInput({ defaultAmountMinor: null }));
      await createParticipants(tx, organizerId, event.event.id, [{ displayLabel: "山田" }]);

      await expect(issueInvoices(tx, organizerId, event.event.id)).rejects.toThrow(AppError);
      try {
        await issueInvoices(tx, organizerId, event.event.id);
        expect.unreachable();
      } catch (error) {
        expect((error as InstanceType<typeof AppError>).status).toBe(400);
        expect((error as InstanceType<typeof AppError>).code).toBe("AMOUNT_NOT_SET");
      }
    });
  });

  it("他人のイベントには発行できない（403）", async () => {
    await withRollback(appRw, async (tx) => {
      const owner = await insertOrganizer(tx, uniq());
      const stranger = await insertOrganizer(tx, uniq());
      const event = await createEvent(tx, owner, baseEventInput());
      await createParticipants(tx, owner, event.event.id, [{ displayLabel: "山田" }]);

      try {
        await issueInvoices(tx, stranger, event.event.id);
        expect.unreachable();
      } catch (error) {
        expect((error as InstanceType<typeof AppError>).status).toBe(403);
      }
    });
  });
});

describe("金額の訂正（PATCH /api/invoices/:id）", () => {
  it("未払い・open attempt 無しなら変更できる", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const event = await createEvent(tx, organizerId, baseEventInput());
      await createParticipants(tx, organizerId, event.event.id, [{ displayLabel: "山田" }]);
      await issueInvoices(tx, organizerId, event.event.id);
      const invoiceRows = await tx<{ id: string }[]>`
        SELECT id FROM invoice WHERE event_id = ${event.event.id}
      `;
      const invoiceId = invoiceRows[0]!.id;

      const updated = await updateInvoiceAmount(tx, organizerId, invoiceId, { amountMinor: 4500 });
      expect(updated.amountMinor).toBe(4500);
    });
  });

  it("生きた決済試行があると 409 INVOICE_NOT_EDITABLE", async () => {
    await withRollback(appRw, async (tx) => {
      const suffix = uniq();
      const organizerId = await insertOrganizer(tx, suffix);
      const event = await createEvent(tx, organizerId, baseEventInput());
      await createParticipants(tx, organizerId, event.event.id, [{ displayLabel: "山田" }]);
      await issueInvoices(tx, organizerId, event.event.id);
      const invoiceRows = await tx<{ id: string }[]>`
        SELECT id FROM invoice WHERE event_id = ${event.event.id}
      `;
      const invoiceId = invoiceRows[0]!.id;
      await insertOpenAttempt(tx, organizerId, invoiceId, suffix);

      try {
        await updateInvoiceAmount(tx, organizerId, invoiceId, { amountMinor: 4500 });
        expect.unreachable();
      } catch (error) {
        expect((error as InstanceType<typeof AppError>).status).toBe(409);
        expect((error as InstanceType<typeof AppError>).code).toBe("INVOICE_NOT_EDITABLE");
      }
    });
  });

  it("支払済み（rank >= 40）は変更できない", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const event = await createEvent(tx, organizerId, baseEventInput());
      await createParticipants(tx, organizerId, event.event.id, [{ displayLabel: "山田" }]);
      await issueInvoices(tx, organizerId, event.event.id);
      const invoiceRows = await tx<{ id: string }[]>`
        SELECT id FROM invoice WHERE event_id = ${event.event.id}
      `;
      const invoiceId = invoiceRows[0]!.id;
      await tx`UPDATE invoice SET settlement_status = 'paid', paid_at = now() WHERE id = ${invoiceId}`;

      try {
        await updateInvoiceAmount(tx, organizerId, invoiceId, { amountMinor: 4500 });
        expect.unreachable();
      } catch (error) {
        expect((error as InstanceType<typeof AppError>).status).toBe(409);
      }
    });
  });

  it("他人の請求は 404（存在を教えない）", async () => {
    await withRollback(appRw, async (tx) => {
      const owner = await insertOrganizer(tx, uniq());
      const stranger = await insertOrganizer(tx, uniq());
      const event = await createEvent(tx, owner, baseEventInput());
      await createParticipants(tx, owner, event.event.id, [{ displayLabel: "山田" }]);
      await issueInvoices(tx, owner, event.event.id);
      const invoiceRows = await tx<{ id: string }[]>`
        SELECT id FROM invoice WHERE event_id = ${event.event.id}
      `;
      const invoiceId = invoiceRows[0]!.id;

      try {
        await updateInvoiceAmount(tx, stranger, invoiceId, { amountMinor: 4500 });
        expect.unreachable();
      } catch (error) {
        expect((error as InstanceType<typeof AppError>).status).toBe(404);
      }
    });
  });
});

describe("請求の取消（check_008）", () => {
  it("未払いなら取り消せる。2 回目は 409 VOID_NOT_ALLOWED", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const event = await createEvent(tx, organizerId, baseEventInput());
      await createParticipants(tx, organizerId, event.event.id, [{ displayLabel: "山田" }]);
      await issueInvoices(tx, organizerId, event.event.id);
      const invoiceRows = await tx<{ id: string }[]>`
        SELECT id FROM invoice WHERE event_id = ${event.event.id}
      `;
      const invoiceId = invoiceRows[0]!.id;

      const voided = await voidInvoice(tx, organizerId, invoiceId);
      expect(voided.lifecycleState).toBe("void");

      const stored = await tx<{ lifecycle_state: string; voided_at: Date | null }[]>`
        SELECT lifecycle_state, voided_at FROM invoice WHERE id = ${invoiceId}
      `;
      expect(stored[0]?.lifecycle_state).toBe("void");
      expect(stored[0]?.voided_at).not.toBeNull();

      try {
        await voidInvoice(tx, organizerId, invoiceId);
        expect.unreachable();
      } catch (error) {
        expect((error as InstanceType<typeof AppError>).status).toBe(409);
        expect((error as InstanceType<typeof AppError>).code).toBe("VOID_NOT_ALLOWED");
      }
    });
  });

  it("支払済み（rank >= 40）の請求は 409 VOID_NOT_ALLOWED（check_008）", async () => {
    await withRollback(appRw, async (tx) => {
      const organizerId = await insertOrganizer(tx, uniq());
      const event = await createEvent(tx, organizerId, baseEventInput());
      await createParticipants(tx, organizerId, event.event.id, [{ displayLabel: "山田" }]);
      await issueInvoices(tx, organizerId, event.event.id);
      const invoiceRows = await tx<{ id: string }[]>`
        SELECT id FROM invoice WHERE event_id = ${event.event.id}
      `;
      const invoiceId = invoiceRows[0]!.id;
      await tx`UPDATE invoice SET settlement_status = 'paid', paid_at = now() WHERE id = ${invoiceId}`;

      const error = await expectFailure(tx, async (sp) => {
        await voidInvoice(sp, organizerId, invoiceId);
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(409);
      expect((error as InstanceType<typeof AppError>).code).toBe("VOID_NOT_ALLOWED");

      const stored = await tx<{ lifecycle_state: string }[]>`
        SELECT lifecycle_state FROM invoice WHERE id = ${invoiceId}
      `;
      expect(stored[0]?.lifecycle_state).toBe("active");
    });
  });
});

describe("check_008（静的）: Webhook 経路から void を呼ばない", () => {
  function listSourceFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listSourceFiles(full));
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        out.push(full);
      }
    }
    return out;
  }

  it("voidInvoice を import しているのは幹事用のルートだけである", () => {
    const files = listSourceFiles(path.join(REPO_ROOT, "src"));
    const importers = files.filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      return (
        source.includes("voidInvoice") &&
        !file.endsWith(path.join("lib", "db", "repositories", "invoices.ts"))
      );
    });
    expect(importers.map((file) => path.relative(REPO_ROOT, file))).toEqual([
      path.join("src", "app", "api", "invoices", "[id]", "void", "route.ts"),
    ]);
  });

  it("src/app/api/webhooks 配下に void の呼び出しが無い", () => {
    const webhookFiles = listSourceFiles(path.join(REPO_ROOT, "src", "app", "api", "webhooks"));
    for (const file of webhookFiles) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toContain("voidInvoice");
    }
  });
});
