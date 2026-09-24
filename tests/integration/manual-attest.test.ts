/**
 * `POST /api/invoices/:id/manual-attest` の統合テスト（実 Postgres・ロール `app_rw`）。
 *
 * task_017 done_definition / check_009 / check_027:
 *   - `reason` が空または空白のみ → 400 で `manual_attestation` の行が作られない
 *   - 申告後の `GET /api/events/:id`（= `getEventSummary`）が
 *     `autoDetected:false` / `confirmationMethod:'manual_by_organizer'`、内訳が自動 0 / 手動 1
 *   - 同じ請求への 2 回目の申告で `ledger_entry` が増えない（`dedupe_key='attest:<id>'`）
 *   - 他人の請求は 404（存在を漏らさない）
 *   - 取消済み（`lifecycle_state='void'`）の請求は 409
 *
 * 隔離: すべて `withRollback` の中で行い、並列に走る他タスクのデータを汚さない。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createAppRwSql,
  createMigratorSql,
  ensureAppRwLoginPassword,
  withRollback,
} from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("not available in integration tests");
  },
}));

const { AppError } = await import("@/lib/errors");
const { getEventSummary } = await import("@/lib/db/repositories/events");
const { applyManualAttest, parseManualAttestBody } = await import(
  "@/app/api/invoices/[id]/manual-attest/route"
);

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

interface Fixture {
  readonly organizerId: string;
  readonly eventId: string;
  readonly invoiceIds: readonly string[];
}

/** 幹事 1 名・参加者 `participants` 名・請求 `participants` 件。 */
async function insertFixture(
  tx: postgres.TransactionSql,
  suffix: string,
  participants = 1,
): Promise<Fixture> {
  const [user] = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${Buffer.from(`organizer-${suffix}`)}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  const organizerId = user!.id;
  const [event] = await tx<{ id: string }[]>`
    INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                       minors_included, default_amount_minor)
    VALUES (${organizerId}, ${`event-${suffix}`}, '山田太郎', ${Buffer.from(`join-${suffix}`)},
            false, 3000)
    RETURNING id
  `;
  const eventId = event!.id;

  const invoiceIds: string[] = [];
  for (let i = 0; i < participants; i += 1) {
    const [participant] = await tx<{ id: string }[]>`
      INSERT INTO participant (event_id, display_label)
      VALUES (${eventId}, ${`p-${suffix}-${String(i)}`})
      RETURNING id
    `;
    const [invoice] = await tx<{ id: string }[]>`
      INSERT INTO invoice (event_id, participant_id, amount_minor)
      VALUES (${eventId}, ${participant!.id}, 3000)
      RETURNING id
    `;
    invoiceIds.push(invoice!.id);
  }
  return { organizerId, eventId, invoiceIds };
}

const VALID_INPUT = {
  method: "paypay_p2p" as const,
  reason: "本人から手渡しで受け取った",
  evidenceNote: null,
  confirmed: true as const,
};

describe("check_009: reason が空なら 400 で行が作られない", () => {
  it("空文字・空白のみ・欠落はすべて 400", () => {
    for (const reason of ["", "   ", "　", undefined]) {
      expect(() =>
        parseManualAttestBody({ method: "cash", reason, confirmed: true }),
      ).toThrow(AppError);
    }
  });

  it("400 になった申告は manual_attestation に 1 行も残さない", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertFixture(tx, uniq());
      const invoiceId = fixture.invoiceIds[0]!;

      expect(() =>
        parseManualAttestBody({ method: "cash", reason: "   ", confirmed: true }),
      ).toThrow(AppError);

      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM manual_attestation WHERE invoice_id = ${invoiceId}
      `;
      expect(rows[0]?.n).toBe("0");
    });
  });

  it("O-8 の確認ダイアログを通っていない（confirmed が true でない）申告は 400", () => {
    expect(() =>
      parseManualAttestBody({ method: "cash", reason: "受け取った", confirmed: false }),
    ).toThrow(AppError);
  });
});

describe("check_027: 申告後のサマリは自動 0 / 手動 1", () => {
  it("invoice が paid になり、auto_detected=false / confirmation_method=manual_by_organizer", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertFixture(tx, uniq(), 4);
      const invoiceId = fixture.invoiceIds[0]!;

      const result = await applyManualAttest(
        tx,
        fixture.organizerId,
        invoiceId,
        VALID_INPUT,
        "req-1",
      );
      expect(result.invoice.autoDetected).toBe(false);
      expect(result.invoice.confirmationMethod).toBe("manual_by_organizer");
      expect(result.invoice.settlementStatus).toBe("paid");
      expect(result.ledgerAppended).toBe(true);

      const rows = await tx<
        { auto_detected: boolean; confirmation_method: string; settlement_rank: number }[]
      >`
        SELECT auto_detected, confirmation_method, settlement_rank
        FROM invoice WHERE id = ${invoiceId}
      `;
      expect(rows[0]?.auto_detected).toBe(false);
      expect(rows[0]?.confirmation_method).toBe("manual_by_organizer");
      expect(rows[0]?.settlement_rank).toBe(40);
    });
  });

  it("getEventSummary の内訳が「支払済み 1/4（自動 0 / 手動 1）」になる", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertFixture(tx, uniq(), 4);
      await applyManualAttest(tx, fixture.organizerId, fixture.invoiceIds[0]!, VALID_INPUT, "req-2");

      const summary = await getEventSummary(asSql(tx), fixture.organizerId, fixture.eventId);
      expect(summary.participantCount).toBe(4);
      expect(summary.breakdown.paidAutomatic).toBe(0);
      expect(summary.breakdown.paidManual).toBe(1);
      expect(summary.breakdown.paidMixed).toBe(0);
      expect(summary.breakdown.unpaid).toBe(3);
    });
  });

  it("台帳は confidence='organizer_attested' / ingestion 由来の source_payment_event_id 無し", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertFixture(tx, uniq());
      const invoiceId = fixture.invoiceIds[0]!;
      await applyManualAttest(tx, fixture.organizerId, invoiceId, VALID_INPUT, "req-3");

      const rows = await tx<
        {
          confidence: string;
          dedupe_key: string;
          kind: string;
          direction: string;
          amount_minor: number;
          source_payment_event_id: string | null;
        }[]
      >`
        SELECT confidence, dedupe_key, kind, direction, amount_minor, source_payment_event_id
        FROM ledger_entry WHERE invoice_id = ${invoiceId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.confidence).toBe("organizer_attested");
      expect(rows[0]?.dedupe_key).toBe(`attest:${invoiceId}`);
      expect(rows[0]?.kind).toBe("payment");
      expect(rows[0]?.direction).toBe("credit");
      expect(rows[0]?.amount_minor).toBe(3000);
      expect(rows[0]?.source_payment_event_id).toBeNull();
    });
  });
});

describe("二重申告・認可・取消", () => {
  it("同じ請求への 2 回目の申告で ledger_entry が増えない（dedupe_key）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertFixture(tx, uniq());
      const invoiceId = fixture.invoiceIds[0]!;

      const first = await applyManualAttest(tx, fixture.organizerId, invoiceId, VALID_INPUT, "r1");
      const second = await applyManualAttest(tx, fixture.organizerId, invoiceId, VALID_INPUT, "r2");
      expect(first.ledgerAppended).toBe(true);
      expect(second.ledgerAppended).toBe(false);

      const ledger = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM ledger_entry WHERE invoice_id = ${invoiceId}
      `;
      expect(ledger[0]?.n).toBe("1");

      // 申告の証跡そのものは 2 件残る（「誰がいつ何と言ったか」は消さない）。
      const attestations = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM manual_attestation WHERE invoice_id = ${invoiceId}
      `;
      expect(attestations[0]?.n).toBe("2");
    });
  });

  it("他人の請求には申告できない（404。存在を漏らさない）", async () => {
    await withRollback(appRw, async (tx) => {
      const owner = await insertFixture(tx, uniq());
      const other = await insertFixture(tx, uniq());

      await expect(
        applyManualAttest(tx, other.organizerId, owner.invoiceIds[0]!, VALID_INPUT, "r"),
      ).rejects.toBeInstanceOf(AppError);

      try {
        await applyManualAttest(tx, other.organizerId, owner.invoiceIds[0]!, VALID_INPUT, "r");
        expect.unreachable();
      } catch (error) {
        expect((error as InstanceType<typeof AppError>).status).toBe(404);
      }

      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM manual_attestation WHERE invoice_id = ${owner.invoiceIds[0]!}
      `;
      expect(rows[0]?.n).toBe("0");
    });
  });

  it("取消済みの請求には申告できない（409）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertFixture(tx, uniq());
      const invoiceId = fixture.invoiceIds[0]!;
      await tx`
        UPDATE invoice SET lifecycle_state = 'void', voided_at = now() WHERE id = ${invoiceId}
      `;

      try {
        await applyManualAttest(tx, fixture.organizerId, invoiceId, VALID_INPUT, "r");
        expect.unreachable();
      } catch (error) {
        expect((error as InstanceType<typeof AppError>).status).toBe(409);
      }
    });
  });

  it("生きた試行は申告で取り下げられる（名簿が手続き中のまま固定されない）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await insertFixture(tx, uniq());
      const invoiceId = fixture.invoiceIds[0]!;
      const [binding] = await tx<{ id: string }[]>`
        INSERT INTO provider_binding (organizer_user_id, provider_key, status)
        VALUES (${fixture.organizerId}, 'manual_confirm', 'active')
        RETURNING id
      `;
      await tx`
        INSERT INTO payment_attempt (invoice_id, provider_key, provider_binding_id, external_ref,
                                     amount_minor)
        VALUES (${invoiceId}, 'manual_confirm', ${binding!.id},
                ${`iv_${invoiceId.replace(/-/g, "")}_1`}, 3000)
      `;

      await applyManualAttest(tx, fixture.organizerId, invoiceId, VALID_INPUT, "r");

      const rows = await tx<{ status: string; is_open: boolean }[]>`
        SELECT status, is_open FROM payment_attempt WHERE invoice_id = ${invoiceId}
      `;
      expect(rows[0]?.status).toBe("canceled");
      expect(rows[0]?.is_open).toBe(false);
    });
  });
});
