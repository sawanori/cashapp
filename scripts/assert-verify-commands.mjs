#!/usr/bin/env node
// scripts/assert-verify-commands.mjs
//
// CI の acceptance ジョブ（§16-6）が最初に走らせる検査。G1 と G2 だけを切り出したもので、
// 判定ロジックは scripts/gate-check.mjs から import している（同じ規則が 2 実装に分かれて
// 片方だけ直る、という壊れ方を作らないため）。
//
// 検査すること:
//   G1  全タスクに done_definition。docs/** 以外を作るタスクには verify_commands、
//       docs/** だけのタスクには verify_commands か manual_verification のどちらか。
//   G2  着手済みタスクの verify_commands が package.json.scripts に実在する。
//       未着手の参照は warn。§13 の表にも package.json にも無い名前は未着手でも違反（捏造）。
//
// Usage: node scripts/assert-verify-commands.mjs [--root <dir>] [--base <dir>] [--json] [--quiet]
// Exit codes: 0 clean / 1 violation / 2 usage or read error.

import path from "node:path";
import process from "node:process";

import { createContext, runGates } from "./gate-check.mjs";
import { repoRoot } from "./gate-integrity.mjs";

const SCOPE = ["G1", "G2"];

function usage(message) {
  process.stderr.write(`assert-verify-commands: ${message}\n`);
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
          "Usage: node scripts/assert-verify-commands.mjs [--root <dir>] [--base <dir>] [--json] [--quiet]\n",
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
  for (const e of configErrors) process.stderr.write(`assert-verify-commands: ${e}\n`);
  process.exit(2);
}

const scoped = results.filter((r) => SCOPE.includes(r.id));
const violations = scoped.flatMap((r) => r.violations.map((v) => `${r.id} ${v}`));
const warnings = scoped.flatMap((r) => r.warnings.map((w) => `${r.id} ${w}`));
const targets = scoped.reduce((n, r) => n + r.targets, 0);

if (args.json) {
  process.stdout.write(`${JSON.stringify({ root, base, results: scoped }, null, 2)}\n`);
} else if (!args.quiet) {
  for (const w of warnings) process.stdout.write(`   warn ${w}\n`);
  for (const v of violations) process.stdout.write(`   FAIL ${v}\n`);
  process.stdout.write(
    `\nassert-verify-commands — 対象 ${targets} 件、違反 ${violations.length} 件 / warn ${warnings.length} 件\n`,
  );
}

process.exit(violations.length > 0 ? 1 : 0);
