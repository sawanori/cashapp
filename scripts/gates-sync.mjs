#!/usr/bin/env node
/**
 * scripts/gates-sync.mjs — ゲート台帳（JSON 正本）と DB 射影（compliance_gate）の同期・差分検査。
 *
 * ★ 正本は docs/gates/compliance-gates.json（Git 管理・PR 対象・変更は PO のみ）。
 *   DB の compliance_gate はその射影にすぎない（docs/gates/README.md）。
 *
 * 使い方:
 *   node scripts/gates-sync.mjs            # 差分検査のみ。差分があれば exit 1
 *   node scripts/gates-sync.mjs --apply    # JSON の内容で DB を上書きし、その後に検査
 *   node scripts/gates-sync.mjs --json     # 結果を JSON で出力（CI 用）
 *
 * 接続は直接接続（マイグレーション経路）で行う。ランタイムの app_rw は compliance_gate に
 * SELECT しか持たないため、--apply は特権ロールでしか通らない（R-SEC-03）。
 * 接続文字列は DATABASE_URL、無ければローカル supabase の既定値。
 *
 * 出力に接続文字列（パスワード）を出さない。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATES_JSON = path.join(REPO_ROOT, "docs", "gates", "compliance-gates.json");
const LOCAL_DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/** JSON と DB の両方で比較する列。ここに無い列（synced_at 等）は比較しない。 */
const COMPARED_FIELDS = [
  "description",
  "required_for",
  "status",
  "valid_until",
  "evidence_uri",
  "approved_by",
  "source_ref",
];

/**
 * text[] 列を文字列配列にする。ドライバが型 OID を引けていない場合は Postgres の
 * 配列リテラル（`{phase1,phase2}`）が素の文字列で返ってくるため、その形も受ける。
 */
function toStringArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    const inner = value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
    if (inner.length === 0) return [];
    return inner.split(",").map((v) => v.trim().replace(/^"(.*)"$/, "$1"));
  }
  throw new Error(`unexpected required_for value: ${JSON.stringify(value)}`);
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid timestamp in gate ledger: ${String(value)}`);
  }
  return date.toISOString();
}

function normalizeGateFromJson(gate) {
  return {
    gate_key: gate.gate_key,
    description: gate.description,
    required_for: toStringArray(gate.required_for),
    status: gate.status,
    valid_until: normalizeTimestamp(gate.valid_until ?? null),
    evidence_uri: gate.evidence_uri ?? null,
    approved_by: gate.approved_by ?? null,
    source_ref: gate.source ?? null,
  };
}

function normalizeGateFromDb(row) {
  return {
    gate_key: row.gate_key,
    description: row.description,
    required_for: toStringArray(row.required_for),
    status: row.status,
    valid_until: normalizeTimestamp(row.valid_until),
    evidence_uri: row.evidence_uri,
    approved_by: row.approved_by,
    source_ref: row.source_ref,
  };
}

function fieldDiff(expected, actual) {
  const differences = [];
  for (const field of COMPARED_FIELDS) {
    const a = JSON.stringify(expected[field] ?? null);
    const b = JSON.stringify(actual[field] ?? null);
    if (a !== b) differences.push({ field, expected: expected[field] ?? null, actual: actual[field] ?? null });
  }
  return differences;
}

/**
 * @returns {Promise<{ ok: boolean, missing_in_db: string[], unexpected_in_db: string[], mismatched: object[], gate_count: number }>}
 */
export async function compareGates(sql, gatesJson) {
  const expected = gatesJson.gates.map(normalizeGateFromJson);
  const rows = await sql`
    SELECT gate_key, description, required_for, status, valid_until,
           evidence_uri, approved_by, source_ref
    FROM compliance_gate
  `;
  const actualByKey = new Map(rows.map((row) => [row.gate_key, normalizeGateFromDb(row)]));

  const missing_in_db = [];
  const mismatched = [];
  for (const gate of expected) {
    const actual = actualByKey.get(gate.gate_key);
    if (!actual) {
      missing_in_db.push(gate.gate_key);
      continue;
    }
    const differences = fieldDiff(gate, actual);
    if (differences.length > 0) mismatched.push({ gate_key: gate.gate_key, differences });
  }

  const expectedKeys = new Set(expected.map((g) => g.gate_key));
  const unexpected_in_db = [...actualByKey.keys()].filter((k) => !expectedKeys.has(k)).sort();

  return {
    ok: missing_in_db.length === 0 && unexpected_in_db.length === 0 && mismatched.length === 0,
    missing_in_db,
    unexpected_in_db,
    mismatched,
    gate_count: expected.length,
  };
}

export async function applyGates(sql, gatesJson) {
  const expected = gatesJson.gates.map(normalizeGateFromJson);
  await sql.begin(async (tx) => {
    for (const gate of expected) {
      await tx`
        INSERT INTO compliance_gate
          (gate_key, description, required_for, status, valid_until,
           evidence_uri, approved_by, source_ref)
        VALUES (${gate.gate_key}, ${gate.description}, ${gate.required_for}, ${gate.status},
                ${gate.valid_until}, ${gate.evidence_uri}, ${gate.approved_by}, ${gate.source_ref})
        ON CONFLICT (gate_key) DO UPDATE SET
          description  = EXCLUDED.description,
          required_for = EXCLUDED.required_for,
          status       = EXCLUDED.status,
          valid_until  = EXCLUDED.valid_until,
          evidence_uri = EXCLUDED.evidence_uri,
          approved_by  = EXCLUDED.approved_by,
          source_ref   = EXCLUDED.source_ref,
          synced_at    = now()
      `;
    }
    const keys = expected.map((g) => g.gate_key);
    await tx`DELETE FROM compliance_gate WHERE gate_key <> ALL(${keys})`;
  });
}

export async function loadGatesJson() {
  const raw = await readFile(GATES_JSON, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.gates)) {
    throw new Error("docs/gates/compliance-gates.json: 'gates' must be an array");
  }
  return parsed;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const asJson = args.includes("--json");

  // 特権（マイグレーション）経路。ランタイムの app_rw は compliance_gate に SELECT しか
  // 持たないため、--apply には DATABASE_URL_MIGRATOR 相当のロールが要る。
  const connectionString =
    process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL ?? LOCAL_DEFAULT_URL;
  const gatesJson = await loadGatesJson();

  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    if (apply) await applyGates(sql, gatesJson);
    const result = await compareGates(sql, gatesJson);

    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      process.stdout.write(
        `gates:sync OK — ${result.gate_count} gate(s) in docs/gates/compliance-gates.json match compliance_gate\n`,
      );
    } else {
      process.stderr.write("gates:sync FAILED — docs/gates/compliance-gates.json and compliance_gate differ\n");
      if (result.missing_in_db.length > 0) {
        process.stderr.write(`  missing in DB: ${result.missing_in_db.join(", ")}\n`);
      }
      if (result.unexpected_in_db.length > 0) {
        process.stderr.write(`  unexpected in DB: ${result.unexpected_in_db.join(", ")}\n`);
      }
      for (const m of result.mismatched) {
        for (const d of m.differences) {
          process.stderr.write(
            `  ${m.gate_key}.${d.field}: json=${JSON.stringify(d.expected)} db=${JSON.stringify(d.actual)}\n`,
          );
        }
      }
      process.stderr.write("  正本は JSON。DB を JSON に合わせるには: npm run gates:sync -- --apply\n");
    }
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await sql.end();
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    // 接続文字列を出さない。
    process.stderr.write(`gates:sync ERROR — ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
