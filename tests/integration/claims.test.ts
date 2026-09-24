/**
 * claim・同意・自己申告・追加リクエストの統合テスト（実 Postgres）。
 *
 * acceptance-checks:
 *   - check_003: 既に claim 済み／他人が claim 済みの participantId で claim → 409 ALREADY_CLAIMED。
 *   - check_086: 同意前の candidates / claim は 403。consent_log に文言バージョンと時刻。
 *   - check_087: self-report は `ledger_entry` に 1 行も書かず `payment_self_report` に記録する。
 *   - check_088: 候補 0 件 → request-add → approve-add で claim 可能になる。cannot-pay で要対応。
 *   - check_085: unclaim 後に本人が claim し直せる。支払済みの unclaim で needs_attention。
 *
 * 隔離: すべて `withRollback` のトランザクション内。接続は最小権限ロール `app_rw`。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
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
const { issueInvoices } = await import("@/lib/db/repositories/invoices");
const {
  PARTICIPANT_CONSENT_KIND,
  PARTICIPANT_CONSENT_TEXT_VERSION,
  approveAdd,
  assertParticipantConsent,
  claimParticipant,
  deriveParticipantInvoiceState,
  getMyInvoice,
  listCandidates,
  loadUserRef,
  parseClaimBody,
  parseSelfReportBody,
  parseUnclaimBody,
  recordParticipantConsent,
  reportCannotPay,
  requestAdd,
  selfReport,
  unclaimParticipant,
} = await import("@/lib/db/repositories/claims");

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

interface TestUser {
  readonly id: string;
  readonly ref: Buffer;
}

async function insertUser(tx: postgres.TransactionSql, suffix: string): Promise<TestUser> {
  const ref = Buffer.from(`user-${suffix}`);
  const rows = await tx<{ id: string }[]>`
    INSERT INTO app_user (line_user_ref, identity_scope, line_env)
    VALUES (${ref}, ${`test:${suffix}`}, 'development')
    RETURNING id
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("failed to insert test user");
  return { id: row.id, ref };
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
  readonly participants: readonly { id: string; claimToken: string }[];
}

/** 幹事・イベント・名簿（氏名共有あり）・請求まで作る。 */
async function setupEvent(
  tx: postgres.TransactionSql,
  labels: readonly string[] = ["山田", "鈴木"],
  options: { readonly shareNames?: boolean; readonly issue?: boolean } = {},
): Promise<Fixture> {
  const organizer = await insertUser(tx, uniq());
  const event = await createEvent(tx, organizer.id, baseEventInput());
  const created = await createParticipants(
    tx,
    organizer.id,
    event.event.id,
    labels.map((displayLabel) => ({ displayLabel })),
  );
  if (options.shareNames !== false) {
    await tx`UPDATE participant SET name_visibility = 'participants' WHERE event_id = ${event.event.id}`;
  }
  if (options.issue !== false) {
    await issueInvoices(tx, organizer.id, event.event.id);
  }
  return {
    organizerId: organizer.id,
    eventId: event.event.id,
    participants: created.map((p) => ({ id: p.id, claimToken: p.claimToken })),
  };
}

// ============================================================================
// 入力検証（純粋関数）
// ============================================================================

describe("parseClaimBody", () => {
  it("participantId 経路は confirmed: true が必須（P-2 の確認ダイアログ）", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(parseClaimBody({ participantId: id, confirmed: true }).participantId).toBe(id);
    expect(() => parseClaimBody({ participantId: id })).toThrow(AppError);
    expect(() => parseClaimBody({ participantId: id, confirmed: false })).toThrow(AppError);
  });

  it("participantId と claimToken の同時指定・両方欠落は 400", () => {
    expect(() => parseClaimBody({})).toThrow(AppError);
    expect(() =>
      parseClaimBody({
        participantId: "11111111-2222-3333-4444-555555555555",
        claimToken: "aaaaaaaaaaaaaaaaaaaaaa",
        confirmed: true,
      }),
    ).toThrow(AppError);
  });

  it("claimToken 経路は確認フラグ不要（個別リンクは自動確定）", () => {
    const parsed = parseClaimBody({ claimToken: "aaaaaaaaaaaaaaaaaaaaaa" });
    expect(parsed.claimToken).toBe("aaaaaaaaaaaaaaaaaaaaaa");
  });
});

describe("parseSelfReportBody（自由記述を受け取らない。premortem P-07）", () => {
  it("method だけを受け付け、note などの追加キーは 400", () => {
    expect(parseSelfReportBody({ method: "cash" }).method).toBe("cash");
    expect(() => parseSelfReportBody({ method: "cash", note: "山田さんから受領" })).toThrow(AppError);
    expect(() => parseSelfReportBody({ method: "unknown_method" })).toThrow(AppError);
    expect(() => parseSelfReportBody({})).toThrow(AppError);
  });
});

describe("parseUnclaimBody（理由は固定の分類）", () => {
  it("既定の分類だけを受け付ける", () => {
    expect(parseUnclaimBody({ reason: "wrong_person" }).reason).toBe("wrong_person");
    expect(() => parseUnclaimBody({ reason: "本人ではなかったため" })).toThrow(AppError);
    expect(() => parseUnclaimBody({})).toThrow(AppError);
  });
});

describe("deriveParticipantInvoiceState", () => {
  const base = {
    claimTokenHash: Buffer.from("x"),
    confirmedByOrganizerAt: null,
    invoiceId: "i",
    settlementRank: 0,
    lifecycleState: "active",
    hasOpenAttempt: false,
    selfReportedAt: null,
    collectByAt: null,
  };

  it("申告済みは支払済みにも未払いにもならない", () => {
    expect(deriveParticipantInvoiceState({ ...base, selfReportedAt: new Date() })).toBe(
      "self_reported",
    );
    expect(deriveParticipantInvoiceState(base)).toBe("unpaid");
    expect(deriveParticipantInvoiceState({ ...base, settlementRank: 40 })).toBe("paid");
  });

  it("取消・手続き中・期限切れ・未発行・承認待ちを区別する", () => {
    expect(deriveParticipantInvoiceState({ ...base, lifecycleState: "void" })).toBe("voided");
    expect(deriveParticipantInvoiceState({ ...base, hasOpenAttempt: true })).toBe("pending_checkout");
    expect(
      deriveParticipantInvoiceState(
        { ...base, collectByAt: new Date("2020-01-01T00:00:00Z") },
        new Date("2026-01-01T00:00:00Z"),
      ),
    ).toBe("expired");
    expect(deriveParticipantInvoiceState({ ...base, invoiceId: null })).toBe("not_issued");
    expect(
      deriveParticipantInvoiceState({ ...base, claimTokenHash: null, confirmedByOrganizerAt: null }),
    ).toBe("awaiting_approval");
  });

  it("支払済みは期限を過ぎていても期限切れにならない", () => {
    expect(
      deriveParticipantInvoiceState(
        { ...base, settlementRank: 40, collectByAt: new Date("2020-01-01T00:00:00Z") },
        new Date("2026-01-01T00:00:00Z"),
      ),
    ).toBe("paid");
  });
});

// ============================================================================
// 同意（check_086）
// ============================================================================

describe("同意（L6 / check_086）", () => {
  it("同意前は候補一覧も claim も 403 CONSENT_REQUIRED", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const participant = await insertUser(tx, uniq());

      const error = await expectFailure(tx, async (sp) => {
        await assertParticipantConsent(asSql(sp), participant.id);
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(403);
      expect((error as InstanceType<typeof AppError>).code).toBe("CONSENT_REQUIRED");

      // 同意を記録すると通る。
      await recordParticipantConsent(tx, participant.id);
      await assertParticipantConsent(asSql(tx), participant.id);

      const rows = await tx<{ consent_kind: string; text_version: string; accepted_at: Date }[]>`
        SELECT consent_kind, text_version, accepted_at FROM consent_log WHERE user_id = ${participant.id}
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]?.consent_kind).toBe(PARTICIPANT_CONSENT_KIND);
      expect(rows[0]?.text_version).toBe(PARTICIPANT_CONSENT_TEXT_VERSION);
      expect(rows[0]?.accepted_at).toBeInstanceOf(Date);
      expect(fixture.participants.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// 候補一覧（check_002）
// ============================================================================

describe("候補一覧（GET /api/e/candidates）", () => {
  it("氏名だけを返し、金額・支払状況のキーを 1 つも含まない", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const candidates = await listCandidates(asSql(tx), fixture.eventId);
      expect(candidates.length).toBe(2);
      for (const candidate of candidates) {
        expect(Object.keys(candidate).sort()).toEqual(["displayLabel", "id"]);
      }
    });
  });

  it("幹事が氏名の共有を許可していない行は返さない（R-LAW-06）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx, ["山田", "鈴木"], { shareNames: false });
      const candidates = await listCandidates(asSql(tx), fixture.eventId);
      expect(candidates).toEqual([]);
    });
  });

  it("既に claim された行と未承認の追加リクエストは候補から消える", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());
      await requestAdd(tx, fixture.eventId, { displayLabel: "田中" });
      await tx`UPDATE participant SET name_visibility = 'participants' WHERE event_id = ${fixture.eventId}`;

      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participants[0]!.id, confirmed: true },
      });

      const candidates = await listCandidates(asSql(tx), fixture.eventId);
      expect(candidates.map((c) => c.id)).toEqual([fixture.participants[1]!.id]);
    });
  });
});

// ============================================================================
// claim（check_003 / check_085）
// ============================================================================

describe("claim の 3 本と unclaim（check_003 / check_085）", () => {
  it("名簿選択で claim でき、自分の請求だけが見える", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());

      const claimed = await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participants[0]!.id, confirmed: true },
      });
      expect(claimed.via).toBe("roster");

      const view = await getMyInvoice(asSql(tx), fixture.eventId, user.ref);
      expect(view.participantId).toBe(fixture.participants[0]!.id);
      expect(view.amountMinor).toBe(3000);
      expect(view.state).toBe("unpaid");
    });
  });

  it("個別リンク（claimToken）なら確認フラグ無しで確定する", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());

      const claimed = await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { claimToken: fixture.participants[1]!.claimToken },
      });
      expect(claimed.via).toBe("claim_token");
      expect(claimed.participantId).toBe(fixture.participants[1]!.id);
    });
  });

  it("他人が claim 済みの participant は claim できない（409 ALREADY_CLAIMED）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const first = await insertUser(tx, uniq());
      const second = await insertUser(tx, uniq());

      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: first.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participants[0]!.id, confirmed: true },
      });

      const error = await expectFailure(tx, async (sp) => {
        await claimParticipant(sp, {
          eventId: fixture.eventId,
          lineUserRef: second.ref,
          pepperVersion: 1,
          input: { participantId: fixture.participants[0]!.id, confirmed: true },
        });
      });
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(409);
      expect((error as InstanceType<typeof AppError>).code).toBe("ALREADY_CLAIMED");
    });
  });

  it("同じ人が同じイベントで 2 人目を claim できない（409）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());

      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participants[0]!.id, confirmed: true },
      });

      const error = await expectFailure(tx, async (sp) => {
        await claimParticipant(sp, {
          eventId: fixture.eventId,
          lineUserRef: user.ref,
          pepperVersion: 1,
          input: { participantId: fixture.participants[1]!.id, confirmed: true },
        });
      });
      expect((error as InstanceType<typeof AppError>).code).toBe("ALREADY_CLAIMED");
    });
  });

  it("同じ人が同じ participant を再送した場合だけは成功として返る（応答の取りこぼし対策）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());
      const input = { participantId: fixture.participants[0]!.id, confirmed: true };

      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input,
      });
      const again = await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input,
      });
      expect(again.participantId).toBe(fixture.participants[0]!.id);

      const rows = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM participant_claim
        WHERE event_id = ${fixture.eventId} AND released_at IS NULL
      `;
      expect(Number(rows[0]?.n)).toBe(1);
    });
  });

  it("unclaim すると本人がもう一度 claim できる", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());
      const input = { participantId: fixture.participants[0]!.id, confirmed: true };

      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input,
      });

      const unclaimed = await unclaimParticipant(
        tx,
        fixture.organizerId,
        fixture.eventId,
        fixture.participants[0]!.id,
      );
      expect(unclaimed.released).toBe(true);
      expect(unclaimed.needsAttention).toBe(false);

      const reclaimed = await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input,
      });
      expect(reclaimed.participantId).toBe(fixture.participants[0]!.id);

      const history = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM participant_claim WHERE participant_id = ${fixture.participants[0]!.id}
      `;
      expect(Number(history[0]?.n)).toBe(2);
    });
  });

  it("支払済みの請求を持つ参加者を unclaim すると needs_attention が立つ（check_085）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());
      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participants[0]!.id, confirmed: true },
      });
      await tx`
        UPDATE invoice SET settlement_status = 'paid', paid_at = now()
        WHERE participant_id = ${fixture.participants[0]!.id}
      `;

      const unclaimed = await unclaimParticipant(
        tx,
        fixture.organizerId,
        fixture.eventId,
        fixture.participants[0]!.id,
      );
      expect(unclaimed.released).toBe(true);
      expect(unclaimed.needsAttention).toBe(true);

      const rows = await tx<{ needs_attention: boolean; settlement_rank: number }[]>`
        SELECT needs_attention, settlement_rank FROM invoice
        WHERE participant_id = ${fixture.participants[0]!.id}
      `;
      expect(rows[0]?.needs_attention).toBe(true);
      // ランクは動かさない（W3）。
      expect(rows[0]?.settlement_rank).toBe(40);
    });
  });

  it("他人のイベントの参加者は unclaim できない（403）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const stranger = await insertUser(tx, uniq());
      const error = await expectFailure(tx, async (sp) => {
        await unclaimParticipant(sp, stranger.id, fixture.eventId, fixture.participants[0]!.id);
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(403);
    });
  });
});

// ============================================================================
// 追加リクエスト（check_088）
// ============================================================================

describe("追加リクエストと承認（check_088）", () => {
  it("未承認のうちは claim できず、approve-add 後に claim できる", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());

      const requested = await requestAdd(tx, fixture.eventId, { displayLabel: "田中" });
      expect(requested.awaitingApproval).toBe(true);

      const error = await expectFailure(tx, async (sp) => {
        await claimParticipant(sp, {
          eventId: fixture.eventId,
          lineUserRef: user.ref,
          pepperVersion: 1,
          input: { participantId: requested.participantId, confirmed: true },
        });
      });
      expect((error as InstanceType<typeof AppError>).code).toBe("AWAITING_APPROVAL");

      await approveAdd(tx, fixture.organizerId, fixture.eventId, requested.participantId);
      const claimed = await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { participantId: requested.participantId, confirmed: true },
      });
      expect(claimed.participantId).toBe(requested.participantId);
    });
  });

  it("他人のイベントは承認できない（403）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const stranger = await insertUser(tx, uniq());
      const requested = await requestAdd(tx, fixture.eventId, { displayLabel: "田中" });
      const error = await expectFailure(tx, async (sp) => {
        await approveAdd(sp, stranger.id, fixture.eventId, requested.participantId);
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(403);
    });
  });
});

// ============================================================================
// 自己申告（check_087）
// ============================================================================

describe("自己申告（check_087）", () => {
  it("payment_self_report にだけ記録され、ledger_entry には 1 行も書かれない", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());
      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participants[0]!.id, confirmed: true },
      });

      const before = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM ledger_entry`;

      const reported = await selfReport(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        input: { method: "paypay_p2p" },
      });
      expect(reported.reportedAt).toBeInstanceOf(Date);

      const reports = await tx<{ method: string; note: string | null }[]>`
        SELECT method, note FROM payment_self_report WHERE invoice_id = ${reported.invoiceId}
      `;
      expect(reports.length).toBe(1);
      expect(reports[0]?.method).toBe("paypay_p2p");
      // 自由記述は受け取らないので常に NULL（premortem P-07）。
      expect(reports[0]?.note).toBeNull();

      const after = await tx<{ n: string }[]>`SELECT count(*)::text AS n FROM ledger_entry`;
      expect(after[0]?.n).toBe(before[0]?.n);

      const invoice = await tx<{ settlement_rank: number; needs_attention: boolean }[]>`
        SELECT settlement_rank, needs_attention FROM invoice WHERE id = ${reported.invoiceId}
      `;
      // ランクは動かない（申告は入金の確定ではない）。
      expect(invoice[0]?.settlement_rank).toBe(0);

      const view = await getMyInvoice(asSql(tx), fixture.eventId, user.ref);
      expect(view.state).toBe("self_reported");
      expect(view.selfReportedAt).toBeInstanceOf(Date);
    });
  });

  it("claim していない人は自己申告できない（403 NOT_CLAIMED）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const stranger = await insertUser(tx, uniq());
      const error = await expectFailure(tx, async (sp) => {
        await selfReport(sp, {
          eventId: fixture.eventId,
          lineUserRef: stranger.ref,
          input: { method: "cash" },
        });
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(403);
      expect((error as InstanceType<typeof AppError>).code).toBe("NOT_CLAIMED");
    });
  });

  it("請求が未発行なら 409 INVOICE_NOT_ISSUED", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx, ["山田"], { issue: false });
      const user = await insertUser(tx, uniq());
      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participants[0]!.id, confirmed: true },
      });
      const error = await expectFailure(tx, async (sp) => {
        await selfReport(sp, {
          eventId: fixture.eventId,
          lineUserRef: user.ref,
          input: { method: "cash" },
        });
      });
      expect((error as InstanceType<typeof AppError>).status).toBe(409);

      const view = await getMyInvoice(asSql(tx), fixture.eventId, user.ref);
      expect(view.state).toBe("not_issued");
    });
  });
});

// ============================================================================
// 支払手段なし（check_088）
// ============================================================================

describe("支払手段なし（cannot-pay）", () => {
  it("自分の請求に needs_attention が立つ（ランクは動かない）", async () => {
    await withRollback(appRw, async (tx) => {
      const fixture = await setupEvent(tx);
      const user = await insertUser(tx, uniq());
      await claimParticipant(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
        pepperVersion: 1,
        input: { participantId: fixture.participants[0]!.id, confirmed: true },
      });

      const flagged = await reportCannotPay(tx, {
        eventId: fixture.eventId,
        lineUserRef: user.ref,
      });
      const rows = await tx<{ needs_attention: boolean; settlement_rank: number }[]>`
        SELECT needs_attention, settlement_rank FROM invoice WHERE id = ${flagged.invoiceId}
      `;
      expect(rows[0]?.needs_attention).toBe(true);
      expect(rows[0]?.settlement_rank).toBe(0);
    });
  });
});

// ============================================================================
// セッション → line_user_ref
// ============================================================================

describe("loadUserRef", () => {
  it("app_user.id から line_user_ref を引ける", async () => {
    await withRollback(appRw, async (tx) => {
      const user = await insertUser(tx, uniq());
      const ref = await loadUserRef(asSql(tx), user.id);
      expect(Buffer.from(ref.lineUserRef).equals(user.ref)).toBe(true);
      expect(ref.pepperVersion).toBeGreaterThan(0);
    });
  });
});
