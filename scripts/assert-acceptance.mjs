#!/usr/bin/env node
// scripts/assert-acceptance.mjs  —  npm run gate:acceptance
//
// CI の acceptance ジョブ（§16-6）の 2 本目。受入チェックの台帳そのものを検査する。
// 判定ロジックは scripts/gate-check.mjs から import している（同じ規則を 2 か所に書かない）。
//
//   G3  すべての check が 1 つ以上の task から参照されている（誰も実行しないチェックを作らない）
//   G4  完了を名乗るタスクが run-log に裏づけを持っている（完了の過大申告 F2）
//   G9  evidence.commit === HEAD（古い証跡が受入基準の横に居座るのを防ぐ）
//
// さらに、run-log を信用しない立場（§15-1 の 5）を明示するために、evidence を持つ check の
// verification_method に書かれた npm スクリプトが実在するかも見る。実行そのものは CI が行う。
//
// Usage: node scripts/assert-acceptance.mjs [--root <dir>] [--base <dir>] [--json] [--quiet]
// Exit codes: 0 clean / 1 violation / 2 usage or read error.

import path from "node:path";
import process from "node:process";

import { createContext, runGates, scriptNameOf } from "./gate-check.mjs";
import { repoRoot } from "./gate-integrity.mjs";

const SCOPE = ["G3", "G4", "G9"];

function usage(message) {
  process.stderr.write(`assert-acceptance: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { root: "", base: "", json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--root":
        if (next === undefined) usage("--root requires a value");
        out.root = next;
        i += 1;
        break;
      case "--base":
        if (next === undefined) usage("--base requires a value");
        out.base = next;
        i += 1;
        break;
      case "--json":
        out.json = true;
        break;
      case "--quiet":
        out.quiet = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(
          "Usage: node scripts/assert-acceptance.mjs [--root <dir>] [--base <dir>] [--json] [--quiet]\n",
        );
        process.exit(0);
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const base = path.resolve(args.base || repoRoot());
const root = path.resolve(args.root || base);
const ctx = createContext({ root, base });
const { configErrors, results } = runGates(ctx);

if (configErrors.length > 0) {
  for (const e of configErrors) process.stderr.write(`assert-acceptance: ${e}\n`);
  process.exit(2);
}

const scoped = results.filter((r) => SCOPE.includes(r.id));
const violations = scoped.flatMap((r) => r.violations.map((v) => `${r.id} ${v}`));
const warnings = scoped.flatMap((r) => r.warnings.map((w) => `${r.id} ${w}`));

// evidence を持つ check の検証手段が実在するか（CI はこの後で実際に再実行する）
const checksFile = ctx.readJson("docs/acceptance-checks.json");
const pkg = ctx.readJson("package.json");
const scripts = new Set(Object.keys(pkg?.scripts ?? {}));
let evidenced = 0;
for (const c of Array.isArray(checksFile?.checks) ? checksFile.checks : []) {
  if (!c || c.evidence === null || c.evidence === undefined) continue;
  evidenced += 1;
  const name = scriptNameOf(String(c.verification_method ?? ""));
  if (name === null) continue;
  if (!scripts.has(name)) {
    violations.push(`G3 ${c.id}: evidence があるのに verification_method の \`${name}\` が package.json にありません`);
  }
}

const targets = scoped.reduce((n, r) => n + r.targets, 0);

if (args.json) {
  process.stdout.write(`${JSON.stringify({ root, base, evidenced, results: scoped }, null, 2)}\n`);
} else if (!args.quiet) {
  for (const r of scoped) {
    for (const n of r.notes) process.stdout.write(`        ${r.id} ${n}\n`);
  }
  for (const w of warnings) process.stdout.write(`   warn ${w}\n`);
  for (const v of violations) process.stdout.write(`   FAIL ${v}\n`);
  process.stdout.write(
    `\ngate:acceptance — 対象 ${targets} 件（evidence 付き ${evidenced} 件）、違反 ${violations.length} 件 / warn ${warnings.length} 件\n`,
  );
}

process.exit(violations.length > 0 ? 1 : 0);
