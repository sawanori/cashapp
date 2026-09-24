/**
 * スキーマ v2 の統合テスト。`supabase start` が上げた実 Postgres に対して実行する。
 *
 * ここで証明するのは「コードがそう書いてある」ではなく「DB がそう振る舞う」ことである。
 * 対応する受入チェック: check_012 / 013 / 014 / 015 / 016 / 052 / 069 / 070 / 071。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as drizzleSchema from "../../src/lib/db/schema";

import grantsBaseline from "./grants-baseline.json";
import {
  REPO_ROOT,
  asPgError,
  createAppRwSql,
  createMigratorSql,
  ensureAppRwLoginPassword,
  expectFailure,
  insertBaseFixture,
  runSupabaseDbDiff,
  withRollback,
} from "./setup";

let migrator: postgres.Sql;
let appRw: postgres.Sql;

let fixtureCounter = 0;
function uniq(): string {
  fixtureCounter += 1;
  return `${process.pid}-${Date.now()}-${fixtureCounter}`;
}

interface Attempt {
  readonly ok: boolean;
  readonly error?: unknown;
}

/**
 * 同じ幹事・同じ provider_binding の下に 2 つ目のイベントを作る。
 * 「別イベントの event_id を名乗る行」を作ろうとする迂回テストで使う。
 */
async function insertSecondEvent(
  tx: postgres.TransactionSql,
  f: { readonly userId: string; readonly bindingId: string },
): Promise<string> {
  const suffix = uniq();
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO event (organizer_user_id, title, organizer_label, join_token_hash,
                       minors_included, provider_binding_id)
    VALUES (${f.userId}, ${`event2-${suffix}`}, 'organizer', ${Buffer.from(`join2-${suffix}`)},
            false, ${f.bindingId})
    RETURNING id
  `;
  return row!.id;
}

/** 文を実行し、成功したか例外になったかを返す。「0 行成功」を成功として扱う。 */
async function attempt(run: () => Promise<unknown>): Promise<Attempt> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

beforeAll(async () => {
  migrator = createMigratorSql();
  await ensureAppRwLoginPassword(migrator);
  appRw = createAppRwSql();
});

afterAll(async () => {
  await appRw?.end({ timeout: 5 });
  await migrator?.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// check_012 — 生成列 settlement_rank
// ---------------------------------------------------------------------------
describe("check_012: invoice.settlement_rank（生成列）", () => {
  it("settlement_status を更新すると rank が導かれ、rank の直接 UPDATE は拒否される", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());

      const initial = await tx<{ settlement_status: string; settlement_rank: number }[]>`
        SELECT settlement_status, settlement_rank FROM invoice WHERE id = ${f.invoiceId}
      `;
      expect(initial[0]?.settlement_status).toBe("unpaid");
      expect(initial[0]?.settlement_rank).toBe(0);

      await tx`UPDATE invoice SET settlement_status = 'paid' WHERE id = ${f.invoiceId}`;
      const advanced = await tx<{ settlement_rank: number }[]>`
        SELECT settlement_rank FROM invoice WHERE id = ${f.invoiceId}
      `;
      expect(advanced[0]?.settlement_rank).toBe(40);

      const error = await expectFailure(
        tx,
        (sp) => sp`UPDATE invoice SET settlement_rank = 99 WHERE id = ${f.invoiceId}`,
      );
      expect(error).toBeDefined();
      // 428C9 = ERRCODE_GENERATED_ALWAYS
      expect(asPgError(error).code).toBe("428C9");
    });
  });

  it("settlement_rank が NULL の行は 0 件", async () => {
    const rows = await migrator<{ count: string }[]>`
      SELECT count(*)::text AS count FROM invoice WHERE settlement_rank IS NULL
    `;
    expect(rows[0]?.count).toBe("0");
  });

  it("CHECK 制約 invoice_settlement_rank_not_null が実在する", async () => {
    const rows = await migrator<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'invoice'::regclass AND conname = 'invoice_settlement_rank_not_null'
    `;
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// check_013 — 追記専用（ledger_entry / audit_log）
// ---------------------------------------------------------------------------
describe("check_013: 追記専用テーブルの UPDATE / DELETE", () => {
  it("app_rw からの UPDATE ledger_entry は例外（0 行成功は不合格）", async () => {
    const result = await attempt(() => appRw`UPDATE ledger_entry SET memo = 'x'`);
    expect(result.ok).toBe(false);
    // 42501 = insufficient_privilege
    expect(asPgError(result.error).code).toBe("42501");
  });

  it("app_rw からの DELETE ledger_entry は例外", async () => {
    const result = await attempt(() => appRw`DELETE FROM ledger_entry`);
    expect(result.ok).toBe(false);
    expect(asPgError(result.error).code).toBe("42501");
  });

  it("app_rw からの UPDATE audit_log は例外", async () => {
    const result = await attempt(() => appRw`UPDATE audit_log SET action = 'x'`);
    expect(result.ok).toBe(false);
    expect(asPgError(result.error).code).toBe("42501");
  });

  it("app_rw からの DELETE audit_log は例外", async () => {
    const result = await attempt(() => appRw`DELETE FROM audit_log`);
    expect(result.ok).toBe(false);
    expect(asPgError(result.error).code).toBe("42501");
  });

  it("テーブル所有者（特権ロール）でもトリガが UPDATE / DELETE / TRUNCATE を止める", async () => {
    for (const statement of [
      "UPDATE ledger_entry SET memo = 'x'",
      "DELETE FROM ledger_entry",
      "TRUNCATE ledger_entry",
      "UPDATE audit_log SET action = 'x'",
      "DELETE FROM audit_log",
      "TRUNCATE audit_log",
    ]) {
      const result = await attempt(() => migrator.unsafe(statement));
      expect(result.ok, `expected a raised exception for: ${statement}`).toBe(false);
      // 0A000 = feature_not_supported（forbid_mutation() の RAISE EXCEPTION）
      expect(asPgError(result.error).code, statement).toBe("0A000");
      expect(asPgError(result.error).message, statement).toContain("append_only_violation");
    }
  });

  it("対象行が実在しても（0 行ではなくても）UPDATE は止まる", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      await tx`
        INSERT INTO ledger_entry
          (invoice_id, event_id, direction, kind, amount_minor, confidence, dedupe_key, recorded_by)
        VALUES (${f.invoiceId}, ${f.eventId}, 'credit', 'payment', 3000,
                'organizer_attested', ${`pay:${uniq()}`}, 'system')
      `;
      const error = await expectFailure(
        tx,
        (sp) => sp`UPDATE ledger_entry SET memo = 'x' WHERE invoice_id = ${f.invoiceId}`,
      );
      expect(error).toBeDefined();
      expect(asPgError(error).code).toBe("0A000");
    });
  });

  it("追記専用トリガが 6 本（各テーブル UPDATE / DELETE / TRUNCATE）実在する", async () => {
    const rows = await migrator<{ relname: string; tgname: string }[]>`
      SELECT c.relname, t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND c.relname IN ('ledger_entry', 'audit_log')
      ORDER BY c.relname, t.tgname
    `;
    expect(rows.map((r) => `${r.relname}.${r.tgname}`)).toEqual([
      "audit_log.audit_log_no_delete",
      "audit_log.audit_log_no_truncate",
      "audit_log.audit_log_no_update",
      "ledger_entry.ledger_entry_no_delete",
      "ledger_entry.ledger_entry_no_truncate",
      "ledger_entry.ledger_entry_no_update",
    ]);
  });
});

// ---------------------------------------------------------------------------
// check_069 — ランタイムロールと権限スナップショット
// ---------------------------------------------------------------------------
describe("check_069: ランタイムロールと権限", () => {
  it("ランタイム接続のロールは app_rw で、特権属性を持たない", async () => {
    const who = await migrator<{ current_user: string }[]>`SELECT current_user`;
    const runtime = await appRw<{ current_user: string }[]>`SELECT current_user`;
    expect(runtime[0]?.current_user).toBe("app_rw");
    expect(who[0]?.current_user).not.toBe("app_rw");

    const attrs = await migrator<
      { rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean }[]
    >`
      SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
      FROM pg_roles WHERE rolname = 'app_rw'
    `;
    expect(attrs[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    });
  });

  it("app_rw は DDL を実行できない", async () => {
    const result = await attempt(() => appRw`CREATE TABLE zzz_ddl_probe (i integer)`);
    expect(result.ok).toBe(false);
    expect(asPgError(result.error).code).toBe("42501");
  });

  it("role_table_grants がベースライン JSON と完全一致する", async () => {
    const rows = await migrator<{ grantee: string; table_name: string; privileges: string }[]>`
      SELECT grantee, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
      FROM information_schema.role_table_grants
      WHERE table_schema = ${grantsBaseline.schema} AND grantee = 'app_rw'
      GROUP BY grantee, table_name
    `;
    const actual: Record<string, string[]> = {};
    for (const row of rows) {
      actual[row.table_name] = row.privileges.split(",");
    }
    expect(actual).toEqual(grantsBaseline.grants.app_rw);
  });

  it("anon / authenticated は public スキーマに一切の権限を持たない", async () => {
    for (const role of grantsBaseline.roles_with_no_grants) {
      const exists = await migrator<{ n: string }[]>`
        SELECT count(*)::text AS n FROM pg_roles WHERE rolname = ${role}
      `;
      if (exists[0]?.n === "0") continue; // 素の PostgreSQL にはこのロールが無い
      const rows = await migrator<{ n: string }[]>`
        SELECT count(*)::text AS n FROM information_schema.role_table_grants
        WHERE table_schema = ${grantsBaseline.schema} AND grantee = ${role}
      `;
      expect(rows[0]?.n, `role ${role} must have no grants on public`).toBe("0");
    }
  });

  it(".env.example のランタイム欄に特権クレデンシャルが無い", async () => {
    const raw = await readFile(path.join(REPO_ROOT, ".env.example"), "utf8");
    const start = raw.indexOf(">>> runtime");
    const end = raw.indexOf("<<< runtime");
    expect(start, ".env.example に runtime 節の開始マーカーが必要").toBeGreaterThanOrEqual(0);
    expect(end, ".env.example に runtime 節の終了マーカーが必要").toBeGreaterThan(start);

    const runtimeSection = raw.slice(start, end);
    const assignments = runtimeSection
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    for (const line of assignments) {
      expect(line).not.toMatch(/SERVICE_ROLE|SERVICE_KEY|SUPABASE_SECRET|POSTGRES_PASSWORD/i);
      expect(line, "ランタイムに DB 接続文字列を置かない（Hyperdrive バインディング経由）")
        .not.toMatch(/^DATABASE_URL/);
      // 万一 Postgres URL を書いた場合でも app_rw 以外は不可。
      const match = /postgres(?:ql)?:\/\/([^:@/]+)/.exec(line);
      if (match) expect(match[1]).toBe("app_rw");
    }
  });
});

// ---------------------------------------------------------------------------
// check_014 / check_015 — 冪等の 3 段
// ---------------------------------------------------------------------------
describe("check_014: payment_event の (provider_key, provider_event_id) 一意", () => {
  it("同じイベント ID の 2 回目の INSERT は 0 行", async () => {
    await withRollback(migrator, async (tx) => {
      const eventId = `evt-${uniq()}`;
      const insert = (): Promise<{ id: string }[]> => tx<{ id: string }[]>`
        INSERT INTO payment_event
          (provider_key, provider_event_id, event_type, kind, external_ref,
           business_idem_key, ingestion_source, trust)
        VALUES ('manual_confirm', ${eventId}, 'payment.succeeded', 'succeeded',
                ${`iv_${uniq().replace(/-/g, "")}`}, 'charge_1:succeeded', 'webhook', 'verified')
        ON CONFLICT (provider_key, provider_event_id) DO NOTHING
        RETURNING id::text AS id
      `;
      expect(await insert()).toHaveLength(1);
      expect(await insert()).toHaveLength(0);
    });
  });
});

describe("check_015: ledger_entry の (invoice_id, dedupe_key) 一意", () => {
  it("同じ dedupe_key の 2 回目の INSERT は 0 行", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      const dedupeKey = `pay:iv_${uniq().replace(/-/g, "")}`;
      const insert = (): Promise<{ id: string }[]> => tx<{ id: string }[]>`
        INSERT INTO ledger_entry
          (invoice_id, event_id, direction, kind, amount_minor, confidence, dedupe_key, recorded_by)
        VALUES (${f.invoiceId}, ${f.eventId}, 'credit', 'payment', 3000,
                'provider_verified', ${dedupeKey}, 'system')
        ON CONFLICT (invoice_id, dedupe_key) DO NOTHING
        RETURNING id::text AS id
      `;
      expect(await insert()).toHaveLength(1);
      expect(await insert()).toHaveLength(0);
    });
  });

  it("business_idem_key に一意制約が無い（同一キーの 2 行目が通る）", async () => {
    const indexes = await migrator<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'payment_event'
    `;
    const uniqueOnBusinessKey = indexes.filter(
      (i) => i.indexdef.includes("UNIQUE") && i.indexdef.includes("business_idem_key"),
    );
    expect(uniqueOnBusinessKey).toEqual([]);

    await withRollback(migrator, async (tx) => {
      const businessKey = `charge_${uniq()}:refunded`;
      for (let i = 0; i < 2; i += 1) {
        const rows = await tx<{ id: string }[]>`
          INSERT INTO payment_event
            (provider_key, provider_event_id, event_type, kind, external_ref,
             business_idem_key, ingestion_source, trust)
          VALUES ('manual_confirm', ${`evt-${uniq()}-${i}`}, 'refund', 'refunded',
                  ${`iv_${uniq().replace(/-/g, "")}`}, ${businessKey}, 'webhook', 'verified')
          RETURNING id::text AS id
        `;
        expect(rows).toHaveLength(1);
      }
    });
  });

  // ledger_event_idx でイベント単位に集計する以上、「台帳行が名乗る event_id」は
  // 参照先 invoice の実 event_id と一致していなければ残高が静かに狂う。
  // 0004_ledger_event_scope_fk.sql の複合 FK がその一致を担保する（R-PAY-03）。
  it("別イベントの event_id を名乗る ledger_entry は作れない", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      const otherEventId = await insertSecondEvent(tx, f);

      const error = await expectFailure(tx, (sp) => sp`
        INSERT INTO ledger_entry
          (invoice_id, event_id, direction, kind, amount_minor, confidence, dedupe_key, recorded_by)
        VALUES (${f.invoiceId}, ${otherEventId}, 'credit', 'payment', 3000,
                'provider_verified', ${`cross:${uniq()}`}, 'system')
      `);
      expect(error).toBeDefined();
      // 23503 = foreign_key_violation（ledger_entry_event_invoice_fk）
      expect(asPgError(error).code).toBe("23503");

      const rows = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM ledger_entry l JOIN invoice i ON i.id = l.invoice_id
        WHERE l.event_id <> i.event_id
      `;
      expect(rows[0]?.n).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// check_016 — participant_claim の部分一意
// ---------------------------------------------------------------------------
describe("check_016: participant_claim の部分一意", () => {
  it("同一イベント・同一ユーザーの未解放 claim は 1 つだけ。解放後は再 claim できる", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      const [second] = await tx<{ id: string }[]>`
        INSERT INTO participant (event_id, display_label)
        VALUES (${f.eventId}, ${`p2-${uniq()}`})
        RETURNING id
      `;
      const userRef = Buffer.from(`claimer-${uniq()}`);

      const [firstClaim] = await tx<{ id: string }[]>`
        INSERT INTO participant_claim (event_id, participant_id, line_user_ref)
        VALUES (${f.eventId}, ${f.participantId}, ${userRef})
        RETURNING id
      `;
      expect(firstClaim?.id).toBeDefined();

      const error = await expectFailure(
        tx,
        (sp) => sp`
          INSERT INTO participant_claim (event_id, participant_id, line_user_ref)
          VALUES (${f.eventId}, ${second!.id}, ${userRef})
        `,
      );
      expect(error).toBeDefined();
      // 23505 = unique_violation
      expect(asPgError(error).code).toBe("23505");

      await tx`
        UPDATE participant_claim
        SET released_at = now(), released_reason = 'organizer_unclaim'
        WHERE id = ${firstClaim!.id}
      `;
      const reclaim = await tx<{ id: string }[]>`
        INSERT INTO participant_claim (event_id, participant_id, line_user_ref)
        VALUES (${f.eventId}, ${second!.id}, ${userRef})
        RETURNING id
      `;
      expect(reclaim).toHaveLength(1);
    });
  });

  // 部分一意 (event_id, line_user_ref) は「行が名乗る event_id」が participant の
  // 実際の event_id と一致していて初めて防御になる。0003_event_scope_fk.sql の
  // 複合 FK がその一致を DB で担保していることを確かめる（R-SEC-01）。
  it("participant が属さない event_id での claim は拒否される", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      const otherEventId = await insertSecondEvent(tx, f);

      const error = await expectFailure(tx, (sp) => sp`
        INSERT INTO participant_claim (event_id, participant_id, line_user_ref)
        VALUES (${otherEventId}, ${f.participantId}, ${Buffer.from(`spoof-${uniq()}`)})
      `);
      expect(error).toBeDefined();
      // 23503 = foreign_key_violation（participant_claim_event_participant_fk）
      expect(asPgError(error).code).toBe("23503");
    });
  });

  it("誤った event_id を使っても同一イベント内の未解放 claim を 2 つ持てない", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      const otherEventId = await insertSecondEvent(tx, f);
      const [second] = await tx<{ id: string }[]>`
        INSERT INTO participant (event_id, display_label)
        VALUES (${f.eventId}, ${`p2-${uniq()}`})
        RETURNING id
      `;
      const userRef = Buffer.from(`claimer-${uniq()}`);

      await tx`
        INSERT INTO participant_claim (event_id, participant_id, line_user_ref)
        VALUES (${f.eventId}, ${f.participantId}, ${userRef})
      `;
      // event_id を別イベントにすり替えれば部分一意を避けられる、という迂回が塞がれている。
      const error = await expectFailure(tx, (sp) => sp`
        INSERT INTO participant_claim (event_id, participant_id, line_user_ref)
        VALUES (${otherEventId}, ${second!.id}, ${userRef})
      `);
      expect(error).toBeDefined();
      expect(asPgError(error).code).toBe("23503");

      const rows = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM participant_claim
        WHERE line_user_ref = ${userRef} AND released_at IS NULL
      `;
      expect(rows[0]?.n).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// check_070 — 追加した DB 制約
// ---------------------------------------------------------------------------
describe("check_070: DB 制約の追加分", () => {
  it("同一 invoice に is_open な payment_attempt を 2 行作れない", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      const insertAttempt = (ref: string): Promise<unknown> => tx`
        INSERT INTO payment_attempt
          (invoice_id, provider_key, provider_binding_id, external_ref, amount_minor)
        VALUES (${f.invoiceId}, 'manual_confirm', ${f.bindingId}, ${ref}, 3000)
      `;
      await insertAttempt(`iv_${uniq().replace(/-/g, "")}_1`);

      const error = await expectFailure(tx, (sp) => sp`
        INSERT INTO payment_attempt
          (invoice_id, provider_key, provider_binding_id, external_ref, amount_minor)
        VALUES (${f.invoiceId}, 'manual_confirm', ${f.bindingId},
                ${`iv_${uniq().replace(/-/g, "")}_2`}, 3000)
      `);
      expect(error).toBeDefined();
      expect(asPgError(error).code).toBe("23505");
    });
  });

  it("試行を閉じれば同一 invoice に次の試行を作れる", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      const [first] = await tx<{ id: string }[]>`
        INSERT INTO payment_attempt
          (invoice_id, provider_key, provider_binding_id, external_ref, amount_minor)
        VALUES (${f.invoiceId}, 'manual_confirm', ${f.bindingId},
                ${`iv_${uniq().replace(/-/g, "")}_1`}, 3000)
        RETURNING id
      `;
      await tx`UPDATE payment_attempt SET status = 'canceled' WHERE id = ${first!.id}`;
      const rows = await tx<{ id: string }[]>`
        INSERT INTO payment_attempt
          (invoice_id, provider_key, provider_binding_id, external_ref, amount_minor)
        VALUES (${f.invoiceId}, 'manual_confirm', ${f.bindingId},
                ${`iv_${uniq().replace(/-/g, "")}_2`}, 3000)
        RETURNING id
      `;
      expect(rows).toHaveLength(1);
    });
  });

  it("未知の settlement_status は拒否される", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      const error = await expectFailure(
        tx,
        (sp) => sp`UPDATE invoice SET settlement_status = 'partially_settled' WHERE id = ${f.invoiceId}`,
      );
      expect(error).toBeDefined();
      // 実測: Postgres は生成列 settlement_rank の NOT NULL（23502）を
      // settlement_status の CHECK（23514）より先に評価する。どちらで落ちても
      // 「未知 status は入らない」は成立する。二重の防波堤があることが要点。
      expect(["23502", "23514"]).toContain(asPgError(error).code);
    });
  });

  it("settlement_status の CHECK が 6 値ちょうどを許す", async () => {
    const rows = await migrator<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'invoice'::regclass AND conname = 'invoice_settlement_status_check'
    `;
    expect(rows).toHaveLength(1);
    const def = rows[0]?.def ?? "";
    for (const status of [
      "unpaid",
      "authorized",
      "paid",
      "refund_pending",
      "refunded",
      "charged_back",
    ]) {
      expect(def).toContain(`'${status}'`);
    }
    expect(def.match(/'[a-z_]+'::text/g) ?? []).toHaveLength(6);
  });

  it("amount_minor の上限（1,000,000）超過は CHECK 違反", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      const [extra] = await tx<{ id: string }[]>`
        INSERT INTO participant (event_id, display_label)
        VALUES (${f.eventId}, ${`p3-${uniq()}`})
        RETURNING id
      `;
      const error = await expectFailure(tx, (sp) => sp`
        INSERT INTO invoice (event_id, participant_id, amount_minor)
        VALUES (${f.eventId}, ${extra!.id}, 1000001)
      `);
      expect(error).toBeDefined();
      expect(asPgError(error).code).toBe("23514");
    });
  });

  // UNIQUE (event_id, participant_id) は「行が名乗る event_id」が participant の
  // 実際の event_id と一致していて初めて「1 参加者 1 請求」を意味する。
  // 0003_event_scope_fk.sql の複合 FK がその一致を担保する（R-PAY-03）。
  it("別イベントの event_id を名乗る invoice は作れない", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      const otherEventId = await insertSecondEvent(tx, f);

      const error = await expectFailure(tx, (sp) => sp`
        INSERT INTO invoice (event_id, participant_id, amount_minor)
        VALUES (${otherEventId}, ${f.participantId}, 3000)
      `);
      expect(error).toBeDefined();
      // 23503 = foreign_key_violation（invoice_event_participant_fk）
      expect(asPgError(error).code).toBe("23503");

      const rows = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM invoice WHERE participant_id = ${f.participantId}
      `;
      expect(rows[0]?.n).toBe(1);
    });
  });

  it("participant_id は ON DELETE RESTRICT（請求のある参加者を物理削除できない）", async () => {
    await withRollback(migrator, async (tx) => {
      const f = await insertBaseFixture(tx, uniq());
      const error = await expectFailure(
        tx,
        (sp) => sp`DELETE FROM participant WHERE id = ${f.participantId}`,
      );
      expect(error).toBeDefined();
      // 23503 = foreign_key_violation
      expect(asPgError(error).code).toBe("23503");
    });
  });
});

// ---------------------------------------------------------------------------
// check_052 — ゲートの初期在庫とフラグ
// ---------------------------------------------------------------------------
describe("check_052: compliance_gate と feature_flag の初期在庫", () => {
  it("docs/gates/compliance-gates.json の全ゲートが status='unknown' で存在する", async () => {
    const raw = await readFile(
      path.join(REPO_ROOT, "docs", "gates", "compliance-gates.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { gates: { gate_key: string; status: string }[] };
    expect(parsed.gates).toHaveLength(10);

    const rows = await migrator<{ gate_key: string; status: string }[]>`
      SELECT gate_key, status FROM compliance_gate ORDER BY gate_key
    `;
    expect(rows.map((r) => r.gate_key)).toEqual(
      [...parsed.gates.map((g) => g.gate_key)].sort((a, b) => a.localeCompare(b)),
    );
    expect(rows.every((r) => r.status === "unknown")).toBe(true);
    expect(parsed.gates.every((g) => g.status === "unknown")).toBe(true);
  });

  it("PAYMENTS_ENABLED は 'false'", async () => {
    const rows = await migrator<{ value: string }[]>`
      SELECT value FROM feature_flag WHERE key = 'PAYMENTS_ENABLED'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("false");
  });

  it("status='passed' には evidence_uri が必須（CHECK）", async () => {
    await withRollback(migrator, async (tx) => {
      const error = await expectFailure(tx, (sp) => sp`
        UPDATE compliance_gate SET status = 'passed' WHERE gate_key = 'G0-USER'
      `);
      expect(error).toBeDefined();
      expect(asPgError(error).code).toBe("23514");
    });
  });

  it("feature_flag.updated_by に 'system' は入れられない（人間のみ）", async () => {
    await withRollback(migrator, async (tx) => {
      const error = await expectFailure(tx, (sp) => sp`
        INSERT INTO feature_flag (key, value, updated_by) VALUES ('PROBE_FLAG', 'x', 'system')
      `);
      expect(error).toBeDefined();
      expect(asPgError(error).code).toBe("23514");
    });
  });
});

// ---------------------------------------------------------------------------
// check_071 — マイグレーションが正本であること
// ---------------------------------------------------------------------------
describe("check_071: マイグレーションの正本", () => {
  it(
    "supabase db diff の差分が 0",
    async () => {
      const result = await runSupabaseDbDiff();
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode, output).toBe(0);
      expect(output).toContain("No schema changes found");
    },
    300_000,
  );

  it("適用済みマイグレーションが supabase/migrations の一覧と一致する", async () => {
    const rows = await migrator<{ version: string; name: string }[]>`
      SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version
    `;
    expect(rows.map((r) => `${r.version}_${r.name}`)).toEqual([
      "0001_init",
      "0002_seed_gates",
      "0003_event_scope_fk",
      "0004_ledger_event_scope_fk",
    ]);
  });

  it("Drizzle スキーマの全列が実 DB と一致する（名前・型・NOT NULL）", async () => {
    const dbColumns = await migrator<
      { relname: string; attname: string; sqltype: string; notnull: boolean }[]
    >`
      SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS sqltype, a.attnotnull AS notnull
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    `;
    const actual = new Map(
      dbColumns.map((c) => [`${c.relname}.${c.attname}`, `${normalizeSqlType(c.sqltype)}|${c.notnull}`]),
    );

    const expected = new Map<string, string>();
    for (const value of Object.values(drizzleSchema)) {
      if (!is(value, Table)) continue;
      const tableName = getTableName(value);
      for (const column of Object.values(getTableColumns(value))) {
        expected.set(
          `${tableName}.${column.name}`,
          `${normalizeSqlType(column.getSQLType())}|${column.notNull}`,
        );
      }
    }

    // Drizzle 側に無い DB 列（＝型が導けていない列）も、DB に無い Drizzle 列も許さない。
    expect([...expected.keys()].sort()).toEqual([...actual.keys()].sort());
    for (const [key, value] of expected) {
      expect(actual.get(key), key).toBe(value);
    }
  });
});

/** `char(3)` と `character(3)` のような表記ゆれだけを吸収する。 */
function normalizeSqlType(sqlType: string): string {
  return sqlType.replace(/^char\(/, "character(").trim();
}
