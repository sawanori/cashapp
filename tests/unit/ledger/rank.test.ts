/**
 * `src/lib/ledger/rank.ts` の単体テスト（check_094 / 制約 W3）。
 *
 * ランクの正本は DB の生成列（`supabase/migrations/0001_init.sql` の
 * `invoice.settlement_rank`）である。TypeScript 側の写しが正本とずれたら落ちるように、
 * DDL を読んで対応表を突き合わせる。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SETTLEMENT_RANK,
  SETTLEMENT_STATUSES,
  canAdvance,
  isAttemptOnlyKind,
  rankOf,
  targetStatusFor,
  type SettlementStatus,
} from "@/lib/ledger/rank";
import type { PaymentEventKind } from "@/lib/payments/types";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INIT_SQL = readFileSync(
  path.join(REPO_ROOT, "supabase", "migrations", "0001_init.sql"),
  "utf8",
);

const ALL_KINDS: readonly PaymentEventKind[] = [
  "authorized",
  "succeeded",
  "failed",
  "canceled",
  "expired",
  "refunded",
  "refund_pending",
  "refund_failed",
  "disputed",
  "dispute_resolved",
  "unknown",
];

describe("settlement rank", () => {
  it("DB の生成列（0001_init.sql）と同じ対応表である", () => {
    for (const status of SETTLEMENT_STATUSES) {
      const pattern = new RegExp(`WHEN '${status}'\\s+THEN (\\d+)`);
      const match = pattern.exec(INIT_SQL);
      expect(match, `0001_init.sql に ${status} の WHEN 句がありません`).not.toBeNull();
      expect(Number(match?.[1])).toBe(SETTLEMENT_RANK[status]);
    }
  });

  it("DDL の settlement_status CHECK と同じ集合である", () => {
    const match = /settlement_status\s+text NOT NULL DEFAULT 'unpaid' CHECK \(settlement_status IN\s*\(([^)]+)\)/.exec(
      INIT_SQL,
    );
    expect(match).not.toBeNull();
    const fromDdl = (match?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter((s) => s.length > 0)
      .sort();
    expect(fromDdl).toEqual([...SETTLEMENT_STATUSES].sort());
  });

  it("ランクは狭義単調増加（同値のランクが存在しない）", () => {
    const ranks = SETTLEMENT_STATUSES.map(rankOf);
    expect(new Set(ranks).size).toBe(ranks.length);
    for (let i = 1; i < ranks.length; i += 1) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1] ?? -1);
    }
  });

  it("canAdvance は前進だけを許す（同値・後退は false）", () => {
    expect(canAdvance(rankOf("unpaid"), "paid")).toBe(true);
    expect(canAdvance(rankOf("paid"), "paid")).toBe(false);
    expect(canAdvance(rankOf("paid"), "authorized")).toBe(false);
    expect(canAdvance(rankOf("paid"), "charged_back")).toBe(true);
  });
});

describe("targetStatusFor", () => {
  it("PaymentEventKind の 11 値すべてに分岐がある（例外を投げない）", () => {
    for (const kind of ALL_KINDS) {
      expect(() => targetStatusFor(kind)).not.toThrow();
    }
  });

  it("失敗・キャンセル・期限切れは請求の状態を動かさない", () => {
    for (const kind of ["failed", "canceled", "expired"] as const) {
      expect(targetStatusFor(kind)).toBeNull();
      expect(isAttemptOnlyKind(kind)).toBe(true);
    }
  });

  it("到達先のランクは既知の 6 値のいずれかである", () => {
    const known = new Set<SettlementStatus>(SETTLEMENT_STATUSES);
    for (const kind of ALL_KINDS) {
      const target = targetStatusFor(kind);
      if (target !== null) expect(known.has(target)).toBe(true);
    }
  });

  it("全 status に到達できる（unpaid は初期値、他はイベントで到達）", () => {
    const reachable = new Set<SettlementStatus>(["unpaid"]);
    for (const kind of ALL_KINDS) {
      const target = targetStatusFor(kind);
      if (target !== null) reachable.add(target);
    }
    expect([...reachable].sort()).toEqual([...SETTLEMENT_STATUSES].sort());
  });

  it("disputed は charged_back（80）へ前進する", () => {
    expect(targetStatusFor("disputed")).toBe("charged_back");
    expect(rankOf("charged_back")).toBe(80);
  });

  it("未知の種別を渡すと例外（分岐の書き忘れを実行時にも検出する）", () => {
    expect(() => targetStatusFor("not_a_kind" as PaymentEventKind)).toThrow();
  });
});
