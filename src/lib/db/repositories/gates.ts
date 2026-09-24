/**
 * `compliance_gate` / `feature_flag` の読み取り（`docs/implementation-plan.md` §7-6 / §10-3）。
 *
 * ★ どちらも**射影の読み取りだけ**を行う。正本は `docs/gates/compliance-gates.json`
 *   （ゲート）と管理 API（フラグ・二人承認・`audit_log`）であり、ここから書き換えない。
 *   ランタイムロール `app_rw` は `compliance_gate` に SELECT しか持たない
 *   （`supabase/migrations/0001_init.sql` の GRANT）。
 *
 * ★ フラグの既定は**安全側**。行が無い・値が読めないときは「無効」に倒す
 *   （`PAYMENTS_ENABLED` の行が消えたら決済が開くのではなく閉じる）。
 */

import "server-only";

import type postgres from "postgres";

/** 読み書きの口。プールの `Sql` とトランザクションの `TransactionSql` の共通部分。 */
type SqlLike = postgres.ISql;

// ============================================================================
// compliance_gate
// ============================================================================

export type ComplianceGateStatus = "unknown" | "inquired" | "passed" | "failed" | "n/a";

export interface ComplianceGateRow {
  readonly gateKey: string;
  readonly status: ComplianceGateStatus;
  readonly validUntil: Date | null;
}

interface ComplianceGateDbRow {
  readonly gate_key: string;
  readonly status: string;
  readonly valid_until: Date | null;
}

const GATE_STATUSES: readonly string[] = ["unknown", "inquired", "passed", "failed", "n/a"];

function toGateStatus(value: string): ComplianceGateStatus {
  // DB 側に CHECK 制約があるので通常は必ず一致する。一致しないなら安全側（未通過）に倒す。
  return GATE_STATUSES.includes(value) ? (value as ComplianceGateStatus) : "unknown";
}

/**
 * 指定したゲートキーの射影を読む。**存在しないキーは行が返らない**（呼び出し側が
 * `findBlockingGate` で `missing` として扱う。`src/lib/payments/gates.ts`）。
 */
export async function getComplianceGates(
  sql: SqlLike,
  gateKeys: readonly string[],
): Promise<readonly ComplianceGateRow[]> {
  if (gateKeys.length === 0) return [];
  const rows = await sql<ComplianceGateDbRow[]>`
    SELECT gate_key, status, valid_until
    FROM compliance_gate
    WHERE gate_key = ANY(${sql.array(gateKeys as string[])})
  `;
  return rows.map((row) => ({
    gateKey: row.gate_key,
    status: toGateStatus(row.status),
    validUntil: row.valid_until,
  }));
}

// ============================================================================
// feature_flag
// ============================================================================

/** 決済機能そのもののキルスイッチ（`supabase/migrations/0002_seed_gates.sql`）。 */
export const FLAG_PAYMENTS_ENABLED = "PAYMENTS_ENABLED";

/** 事業者ごとのモード。`off` で当該アダプタだけを止める。 */
export function providerModeFlagKey(providerKey: string): string {
  return `PROVIDER_${providerKey.toUpperCase()}_MODE`;
}

/** 行が無ければ `null`。呼び出し側が安全側の既定を決める。 */
export async function getFeatureFlag(sql: SqlLike, key: string): Promise<string | null> {
  const rows = await sql<{ value: string }[]>`
    SELECT value FROM feature_flag WHERE key = ${key}
  `;
  return rows[0]?.value ?? null;
}

/**
 * 真偽フラグ。**`'true'` のときだけ true**（行が無い・別の値なら false）。
 * 「読めなかったら開く」を構造的に不可能にする。
 */
export async function isFeatureFlagEnabled(sql: SqlLike, key: string): Promise<boolean> {
  return (await getFeatureFlag(sql, key)) === "true";
}
