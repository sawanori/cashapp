#!/usr/bin/env node
/**
 * scripts/db-diff-drizzle.mjs — `npm run db:diff:drizzle` の判定器（check_071 の drizzle 側）。
 *
 * ## 何を見るか
 *
 * drizzle-kit に「実 DB（introspect 結果）から src/lib/db/schema.ts に到達するには
 * 何をすればよいか」を吐かせ、その SQL に**テーブル / 列の層の乖離**が 1 文でもあれば
 * exit 1 にする。実行そのものは呼び出し側（package.json の db:diff:drizzle）が行い、
 * この判定器は生成された .sql を読むだけである。
 *
 * ## 「差分 0」ではなく「テーブル / 列の層の差分 0」を見る理由
 *
 * src/lib/db/schema.ts は implementation-plan.md §7-2 の裁定に従い**列だけ**を宣言し、
 * supabase/migrations/*.sql にある unique / check / index / foreign key を書き写さない
 * （DDL の二重化を避けるため）。その結果 drizzle-kit の出力には制約と索引の
 * DROP が常に大量に並ぶ。これは設計どおりであって乖離ではない。
 * したがって「出力が空であること」を条件にすると恒久的に赤になり、ゲートとして死ぬ。
 *
 * 一方、CREATE TABLE / DROP TABLE / ALTER COLUMN と、**相方のいない**
 * ADD COLUMN / DROP COLUMN は、Drizzle の型が正本スキーマから本当にずれた印である。
 * ここだけを exit 1 の条件にする。
 *
 * ## 生成列の drop + add 対が例外になる理由
 *
 * drizzle-kit 0.31.11 は GENERATED ALWAYS AS ... STORED 列を差分なしと判定できず、
 * 同じ列に対し `drop column` と `ADD COLUMN`（同一定義）を必ず対で吐く。
 * 実測では invoice.settlement_rank と payment_attempt.is_open の 2 列が該当する。
 * よって「同じ (table, column) に drop と add が両方ある」ものだけを打ち消し、
 * **片側しか無い**ものを本物の乖離として報告する。列が本当に消えた / 増えたときは
 * 片側しか出ないので、この打ち消しでゲートは緩まない。
 *
 * 注意: これは check_071 が本来要求する「drizzle-kit 差分 0」そのものではない。
 * 「差分 0」を満たすには schema.ts に全制約を書き写す必要があり §7-2 と衝突するため、
 * 裁定は task_038 に委ねてある。未達である事実は docs/task-list.json の task_011 の
 * concerns と docs/HANDOFF.md に記録してある。
 *
 * Usage: node scripts/db-diff-drizzle.mjs <生成された .sql を含むディレクトリ>
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** @param {string} message */
function fail(message) {
  process.stderr.write(`db:diff:drizzle: ${message}\n`);
  process.exit(1);
}

const outDir = process.argv[2];
if (!outDir) {
  fail("usage: node scripts/db-diff-drizzle.mjs <out-dir>");
}

// out ディレクトリには 2 種類の .sql が同居する。
//   idx 0 … `drizzle-kit pull` が書く**実 DB の丸写し**（全テーブルの CREATE TABLE）。
//   idx 1 … `drizzle-kit generate` が書く**差分**。判定したいのはこちらだけ。
// ディレクトリ内の .sql を無差別に読むと idx 0 の CREATE TABLE を乖離と誤認するので、
// meta/_journal.json の entries を正としてファイルを選ぶ。
const journalPath = path.join(outDir, "meta", "_journal.json");
let journal;
try {
  journal = JSON.parse(readFileSync(journalPath, "utf8"));
} catch (error) {
  fail(`cannot read ${journalPath}: ${String(error)} — drizzle-kit pull did not run`);
}

const entries = Array.isArray(journal.entries) ? journal.entries : [];
if (entries.length === 0) {
  fail(`${journalPath} has no entries — drizzle-kit pull did not run`);
}

const existing = new Set(readdirSync(outDir).filter((name) => name.endsWith(".sql")));
const sqlFiles = [];
for (const entry of entries) {
  if (typeof entry.idx !== "number" || entry.idx < 1) {
    continue; // idx 0 は introspect の丸写し。差分ではない。
  }
  const file = `${entry.tag}.sql`;
  if (!existing.has(file)) {
    fail(`journal lists ${file} but it is missing from ${outDir}`);
  }
  sqlFiles.push(path.join(outDir, file));
}

// generate が 1 本も書かなかった = 文字どおり差分ゼロ。check_071 の理想形。
if (sqlFiles.length === 0) {
  process.stdout.write("db:diff:drizzle: OK — drizzle-kit generate produced no diff at all\n");
  process.exit(0);
}

const sql = sqlFiles.map((f) => readFileSync(f, "utf8")).join("\n");

// `--> statement-breakpoint` で区切られた文の集合にする。
const statements = sql
  .split(/-->\s*statement-breakpoint/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/** @type {string[]} */
const hardViolations = [];
/** @type {Map<string, {drop: string[], add: string[]}>} */
const columnOps = new Map();

/** @param {string} table @param {string} column */
function columnKey(table, column) {
  return `${table}.${column}`;
}

for (const statement of statements) {
  const upper = statement.toUpperCase();

  if (/\bCREATE\s+TABLE\b/.test(upper) || /\bDROP\s+TABLE\b/.test(upper)) {
    hardViolations.push(statement);
    continue;
  }
  if (/\bALTER\s+COLUMN\b/.test(upper)) {
    hardViolations.push(statement);
    continue;
  }

  const dropColumn = /ALTER\s+TABLE\s+"?([A-Za-z0-9_]+)"?\s+DROP\s+COLUMN\s+"?([A-Za-z0-9_]+)"?/i.exec(
    statement,
  );
  if (dropColumn) {
    const key = columnKey(dropColumn[1], dropColumn[2]);
    const entry = columnOps.get(key) ?? { drop: [], add: [] };
    entry.drop.push(statement);
    columnOps.set(key, entry);
    continue;
  }

  const addColumn = /ALTER\s+TABLE\s+"?([A-Za-z0-9_]+)"?\s+ADD\s+COLUMN\s+"?([A-Za-z0-9_]+)"?/i.exec(
    statement,
  );
  if (addColumn) {
    const key = columnKey(addColumn[1], addColumn[2]);
    const entry = columnOps.get(key) ?? { drop: [], add: [] };
    entry.add.push(statement);
    columnOps.set(key, entry);
  }
}

/** @type {string[]} */
const unpairedColumnOps = [];
/** @type {string[]} */
const pairedGeneratedColumns = [];

for (const [key, entry] of [...columnOps.entries()].sort()) {
  if (entry.drop.length > 0 && entry.add.length > 0) {
    pairedGeneratedColumns.push(key);
    continue;
  }
  const side = entry.drop.length > 0 ? "DROP COLUMN" : "ADD COLUMN";
  unpairedColumnOps.push(`${key}: ${side} without a matching counterpart`);
}

const total = statements.length;
process.stdout.write(
  `db:diff:drizzle: ${total} statement(s) in ${sqlFiles.length} file(s) under ${outDir}\n`,
);
process.stdout.write(
  `db:diff:drizzle: ignored by design — constraint/index statements (schema.ts declares columns only, §7-2)\n`,
);
if (pairedGeneratedColumns.length > 0) {
  process.stdout.write(
    `db:diff:drizzle: ignored drop+add pairs (drizzle-kit re-emits GENERATED columns): ${pairedGeneratedColumns.join(", ")}\n`,
  );
}

if (hardViolations.length === 0 && unpairedColumnOps.length === 0) {
  process.stdout.write("db:diff:drizzle: OK — no table/column drift\n");
  process.exit(0);
}

process.stderr.write("db:diff:drizzle: table/column drift detected\n");
for (const violation of hardViolations) {
  process.stderr.write(`  [statement] ${violation.replace(/\s+/g, " ").slice(0, 300)}\n`);
}
for (const violation of unpairedColumnOps) {
  process.stderr.write(`  [column]    ${violation}\n`);
}
process.exit(1);
