/**
 * 監査ログのハッシュ連鎖 統合テスト（実 Postgres）。task_014 scope / check_057。
 *
 *   - 並行 insert 20 本 → prev_hash の重複 0 件、すべて一致（`verifyAuditChain` が ok: true）。
 *   - 1 行改変で以降の検証が失敗する（`brokenAtId` が壊れた行を指す）。
 *
 * `npm run audit:verify`（CLI・cron・required check への登録）は
 * `src/lib/audit.ts` の docstring が明記するとおり task_018/020 の担当であり、ここでは
 * その下敷きである `verifyAuditChain()` を直接検査する。
 *
 * 隔離方針: `audit_log` はどの参加者・イベントにも属さない**全体共有**の追記専用テーブルであり、
 * `withRollback` で作った行は他の統合テストが読む `audit_log` の内容に一切影響しない
 * （`verifyAuditChain` は「先頭から検証してすべて一致するか」だけを見るため、他のテストが
 * 別のトランザクションで追記した行が増えても、そのこと自体は失敗の原因にならない）。
 *
 * 「1 行改変」だけは実 DB のトリガ（`audit_log_no_update`）で UPDATE 自体が拒否される
 * （`tests/integration/schema.test.ts` の check_013 が示すとおり、テーブル所有者でも迂回不可）。
 * そこで `ALTER TABLE ... DISABLE/ENABLE TRIGGER` という **トランザクショナルな DDL** を使い、
 * migrator（特権ロール）のトランザクション内でだけトリガを外して改変・検証し、
 * そのトランザクションを `withRollback` で必ずロールバックする。トリガの無効化も改変も
 * ロールバックで完全に巻き戻るため、実テーブルには一切の痕跡が残らない。
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { appRwConnectionString, createAppRwSql, createMigratorSql, ensureAppRwLoginPassword, withRollback } from "./setup";

vi.mock("server-only", () => ({}));

const { appendAuditLog, verifyAuditChain } = await import("@/lib/audit");

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

describe("appendAuditLog / verifyAuditChain: 連鎖の正しさ", () => {
  it("逐次 15 件の追記は途切れなく連鎖し、id は単調増加する", async () => {
    await withRollback(appRw, async (tx) => {
      const marker = uniq();
      const rows: { id: string; rowHash: Buffer; prevHash: Buffer | null }[] = [];
      for (let i = 0; i < 15; i += 1) {
        const row = await appendAuditLog(tx, {
          actorType: "system",
          action: `test.audit_chain.sequential.${marker}`,
          targetType: "test",
          targetId: `${marker}-${i}`,
          requestId: `req-${marker}-${i}`,
        });
        rows.push(row);
      }

      // id は単調増加（`audit_log.id` は bigint。postgres.js は文字列で返すため BigInt() で比較する）。
      for (let i = 1; i < rows.length; i += 1) {
        expect(BigInt(rows[i]!.id) > BigInt(rows[i - 1]!.id)).toBe(true);
      }
      // 連鎖: 各行の prevHash は直前の行の rowHash と一致する。
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i]!.prevHash?.equals(rows[i - 1]!.rowHash)).toBe(true);
      }
      // rowHash の重複が無い（15 件とも別内容）。
      const hashes = new Set(rows.map((r) => r.rowHash.toString("hex")));
      expect(hashes.size).toBe(15);

      const result = await verifyAuditChain(tx as unknown as postgres.Sql);
      expect(result.ok).toBe(true);
      expect(result.brokenAtId).toBeNull();
      expect(result.rowsChecked).toBeGreaterThanOrEqual(15);
    });
  });

  it("並行 20 本の追記でも prev_hash の重複が 0 件で、連鎖全体が一致する（check_057）", async () => {
    // ブロッキング advisory xact lock（appendAuditLog 内部）で直列化されることを、
    // 本当に別コネクション・別トランザクションの並行書き込みで確かめる。
    // 直後にトリガを一時的に外して痕跡を消す（下記）ため、素の app_rw プールではなく
    // 専用プールを使う（`./setup` の共有プールは max:2 に絞られており 20 並行に足りない）。
    const wide = postgres(appRwConnectionString(), {
      max: 20,
      prepare: false,
      onnotice: () => {},
    });

    const marker = `concurrent-${uniq()}`;
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          wide.begin(async (tx) =>
            appendAuditLog(tx, {
              actorType: "system",
              action: `test.audit_chain.concurrent.${marker}`,
              targetType: "test",
              targetId: `${marker}-${i}`,
              requestId: `req-${marker}-${i}`,
              detail: { test_marker: marker, seq: i },
            }),
          ),
        ),
      );

      expect(results).toHaveLength(20);
      const rowHashSet = new Set(results.map((r) => r.rowHash.toString("hex")));
      expect(rowHashSet.size).toBe(20); // rowHash の重複 0 件
      const prevHashSet = new Set(results.map((r) => (r.prevHash === null ? "null" : r.prevHash.toString("hex"))));
      expect(prevHashSet.size).toBe(20); // prev_hash の重複 0 件（各行が異なる直前行を指す）

      const chainResult = await verifyAuditChain(wide);
      expect(chainResult.ok).toBe(true);
      expect(chainResult.brokenAtId).toBeNull();

      // 20 件がすべて id 連番になっている（他の並行書き込みに割り込まれていない）ことを確認する。
      const idRows = await wide<{ id: string }[]>`
        SELECT id FROM audit_log WHERE detail->>'test_marker' = ${marker} ORDER BY id ASC
      `;
      expect(idRows).toHaveLength(20);
      for (let i = 1; i < idRows.length; i += 1) {
        expect(BigInt(idRows[i]!.id)).toBe(BigInt(idRows[i - 1]!.id) + 1n);
      }
    } finally {
      // 後始末: このテストが作った 20 行だけを正確に取り除き、共有テーブルを元の状態に戻す。
      // audit_log は DELETE がトリガで拒否される（app_rw も所有者も例外なし）ため、
      // migrator のトランザクション内だけトリガを外して削除し、そのままコミットする
      // （このコミットは「後始末」自体が目的であり、ロールバックしない）。
      await migrator.begin(async (mtx) => {
        await mtx`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete`;
        await mtx`DELETE FROM audit_log WHERE detail->>'test_marker' = ${marker}`;
        await mtx`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete`;
      });
      await wide.end({ timeout: 5 });
    }
  });

  it("1 行の改変（row_hash の書き換え）で、以降の検証が必ず失敗する", async () => {
    await withRollback(migrator, async (tx) => {
      const marker = uniq();
      const row1 = await appendAuditLog(tx, {
        actorType: "system",
        action: `test.audit_chain.tamper.${marker}`,
        targetType: "test",
        targetId: `${marker}-1`,
        requestId: `req-${marker}-1`,
      });
      const row2 = await appendAuditLog(tx, {
        actorType: "system",
        action: `test.audit_chain.tamper.${marker}`,
        targetType: "test",
        targetId: `${marker}-2`,
        requestId: `req-${marker}-2`,
      });
      const row3 = await appendAuditLog(tx, {
        actorType: "system",
        action: `test.audit_chain.tamper.${marker}`,
        targetType: "test",
        targetId: `${marker}-3`,
        requestId: `req-${marker}-3`,
      });

      const before = await verifyAuditChain(tx as unknown as postgres.Sql);
      expect(before.ok).toBe(true);

      // 追記専用トリガはテーブル所有者（migrator）でも DML を止める（check_013）。
      // ALTER TABLE ... DISABLE/ENABLE TRIGGER はトランザクショナルな DDL なので、
      // このトランザクションが最終的にロールバックされれば、無効化そのものも巻き戻る。
      await tx`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`;
      await tx`UPDATE audit_log SET row_hash = decode('00112233445566778899aabbccddeeff0011223344556677889900112233', 'hex') WHERE id = ${row2.id}::bigint`;
      await tx`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`;

      const after = await verifyAuditChain(tx as unknown as postgres.Sql);
      expect(after.ok).toBe(false);
      // row2 の row_hash 自体を書き換えたので、row2 は「自分の内容から再計算した row_hash が
      // 保存値と一致しない」で即座に壊れていると判定される（row3 の prev_hash 不一致を待つまでも
      // ない。verifyAuditChain は各行ごとに (1) prev_hash の連結 (2) 自分自身の row_hash の
      // 両方を検査するため、改変された当の行が最初の break point になるのが正しい）。
      expect(after.brokenAtId).toBe(row2.id);
      expect(after.reason).toContain("row_hash does not match");

      // row1 だけを見れば連鎖はまだ壊れていない（壊れているのは row2 自身から）ことの確認。
      expect(BigInt(row1.id) < BigInt(row2.id)).toBe(true);
      expect(BigInt(row2.id) < BigInt(row3.id)).toBe(true);
    });
  });

  it("prev_hash 自体を書き換えても、その行自身の row_hash 不一致として検出される", async () => {
    await withRollback(migrator, async (tx) => {
      const marker = uniq();
      const row1 = await appendAuditLog(tx, {
        actorType: "system",
        action: `test.audit_chain.tamper2.${marker}`,
        targetType: "test",
        targetId: `${marker}-1`,
        requestId: `req-${marker}-1`,
      });
      const row2 = await appendAuditLog(tx, {
        actorType: "system",
        action: `test.audit_chain.tamper2.${marker}`,
        targetType: "test",
        targetId: `${marker}-2`,
        requestId: `req-${marker}-2`,
      });
      void row1;

      await tx`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`;
      await tx`UPDATE audit_log SET prev_hash = decode('ff'::text, 'hex') WHERE id = ${row2.id}::bigint`;
      await tx`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`;

      const after = await verifyAuditChain(tx as unknown as postgres.Sql);
      expect(after.ok).toBe(false);
      expect(after.brokenAtId).toBe(row2.id);
    });
  });
});
