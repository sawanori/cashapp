/**
 * 実行時ゲートの判定（`docs/implementation-plan.md` §7-6 / §10-3）。
 *
 * ★ **正本は `docs/gates/compliance-gates.json`**（Git 管理・PR 対象・変更は PO のみ）。
 *   DB の `compliance_gate` はその射影にすぎず、`scripts/gates-sync.mjs` が JSON から同期する
 *   （`docs/gates/README.md`）。したがって:
 *     - 「どのゲートがこのフェーズをブロックするか」の**集合**は正本（このファイルの
 *       `CANONICAL_GATES`）が決める。
 *     - 「いまそのゲートが通っているか」の**状態**は DB 射影を読む
 *       （`src/lib/db/repositories/gates.ts`）。
 *   正本にあるのに DB に行が無いゲートは、**未通過として扱う**（射影の欠落で穴が開かない）。
 *
 * ★ `CANONICAL_GATES` が正本と食い違ったら `tests/unit/payments/registry.test.ts` が落ちる。
 *   Workers ランタイムからリポジトリのファイルは読めないため、正本の写しをここに持ち、
 *   食い違いをテストで機械検査する（写しを手で書き換えても、テストが正本と突き合わせる）。
 *
 * ★ 通過の条件は 2 つ:
 *     1. `status` が `passed` または `n/a`
 *     2. `valid_until` が `null`（無期限）または現在時刻より後（R-LAW-14 のゲート陳腐化対策）
 */

import type { ComplianceGateRow } from "@/lib/db/repositories/gates";

export type GatePhase = "phase1" | "phase2";

export interface CanonicalGate {
  readonly gateKey: string;
  readonly requiredFor: readonly GatePhase[];
}

/**
 * `docs/gates/compliance-gates.json`（schema_version 1 / generated_at 2026-09-24）の写し。
 * 正本との一致は `tests/unit/payments/registry.test.ts` が JSON を読んで検査する。
 */
export const CANONICAL_GATES: readonly CanonicalGate[] = [
  { gateKey: "G0-USER", requiredFor: ["phase1", "phase2"] },
  { gateKey: "GATE-LINE-POLICY", requiredFor: ["phase1"] },
  { gateKey: "GATE-LINE-SHARE", requiredFor: ["phase1"] },
  { gateKey: "GATE-LEGAL-PII", requiredFor: ["phase1"] },
  { gateKey: "GATE-LEGAL-FUNDS", requiredFor: ["phase2"] },
  { gateKey: "GATE-PP-MERCHANDISE", requiredFor: ["phase2"] },
  { gateKey: "GATE-PP-ONBOARD", requiredFor: ["phase2"] },
  { gateKey: "GATE-PP-WEBHOOK", requiredFor: ["phase2"] },
  { gateKey: "GATE-CRED-CUSTODY", requiredFor: ["phase2"] },
  { gateKey: "GATE-PP-IP-RANGE", requiredFor: ["phase2"] },
];

/** 当該フェーズをブロックしうるゲートキー（正本の順序を保つ）。 */
export function requiredGateKeysFor(phase: GatePhase): readonly string[] {
  return CANONICAL_GATES.filter((gate) => gate.requiredFor.includes(phase)).map(
    (gate) => gate.gateKey,
  );
}

/**
 * 自動アダプタ（新規の資金移動を起こす経路）がブロックされるフェーズ。
 *
 * Phase 1 の出荷アダプタは `manual_confirm` のみで、これは資金移動を起こさないため
 * ゲートを一切見ない。ゲートを見るのは自動アダプタだけであり、その有効化は Phase 2 である。
 * したがって自動アダプタは phase1 と phase2 の**両方**のゲートを満たす必要がある。
 */
export const AUTOMATIC_PROVIDER_GATE_PHASES: readonly GatePhase[] = ["phase1", "phase2"];

export type GateBlockReason = "missing" | "not_passed" | "expired";

export interface BlockingGate {
  readonly gateKey: string;
  readonly reason: GateBlockReason;
}

/** 1 件のゲート射影が通過しているか。行が無い場合は呼び出し側が `missing` を立てる。 */
export function gateBlockReason(row: ComplianceGateRow, now: Date): GateBlockReason | null {
  if (row.status !== "passed" && row.status !== "n/a") return "not_passed";
  if (row.validUntil !== null && row.validUntil.getTime() <= now.getTime()) return "expired";
  return null;
}

/**
 * 必須ゲートのうち最初にブロックしているものを返す。すべて通過していれば `null`。
 * 判定順は正本の並び順に固定する（どのゲートで止まったかが実行ごとに揺れないようにする）。
 */
export function findBlockingGate(
  requiredKeys: readonly string[],
  rows: readonly ComplianceGateRow[],
  now: Date,
): BlockingGate | null {
  const byKey = new Map(rows.map((row) => [row.gateKey, row]));
  for (const key of requiredKeys) {
    const row = byKey.get(key);
    if (row === undefined) return { gateKey: key, reason: "missing" };
    const reason = gateBlockReason(row, now);
    if (reason !== null) return { gateKey: key, reason };
  }
  return null;
}

/** 複数フェーズ分の必須ゲートキーを、正本の順序のまま重複なしで返す。 */
export function requiredGateKeysForPhases(phases: readonly GatePhase[]): readonly string[] {
  const keys: string[] = [];
  for (const gate of CANONICAL_GATES) {
    if (gate.requiredFor.some((phase) => phases.includes(phase)) && !keys.includes(gate.gateKey)) {
      keys.push(gate.gateKey);
    }
  }
  return keys;
}
