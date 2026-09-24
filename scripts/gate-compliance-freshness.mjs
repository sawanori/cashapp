#!/usr/bin/env node
// scripts/gate-compliance-freshness.mjs
//
// `docs/gates/compliance-gates.json`（ゲート台帳の正本）の陳腐化検査（R-LAW-14）。
//
// 「ゲートが `passed` のまま、期限（`valid_until`）が来ていることに誰も気づかない」を防ぐ。
// 見るのは 3 つ:
//   1. `status === 'passed'` の行は `valid_until` を持つこと（無期限の `passed` を許さない —
//      無期限は「一度確認したら永久に有効」という前提を機械が確かめられない）。
//   2. `valid_until` が現在時刻より過去でないこと（期限切れの `passed` を検出）。
//   3. `generated_at` が妥当な日付であること（未更新の台帳を検出する足がかり）。
//
// `status` の変更は PO のみが行う（`docs/gates/README.md`）。本スクリプトは読み取り検査のみ
// で、ファイルを書き換えない。
//
// Exit codes: 0 clean / 1 陳腐化あり / 2 usage・ファイル不在・JSON 不正。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  let file = path.join(REPO_ROOT, "docs", "gates", "compliance-gates.json");
  let now = new Date();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--file") {
      const next = argv[i + 1];
      if (next === undefined) {
        process.stderr.write("gate-compliance-freshness: --file requires a value\n");
        process.exit(2);
      }
      file = path.isAbsolute(next) ? next : path.join(REPO_ROOT, next);
      i += 1;
    } else if (argv[i] === "--now") {
      const next = argv[i + 1];
      if (next === undefined) {
        process.stderr.write("gate-compliance-freshness: --now requires a value\n");
        process.exit(2);
      }
      now = new Date(next);
      i += 1;
    }
  }
  return { file, now };
}

export function checkFreshness(doc, now) {
  const violations = [];

  if (typeof doc.generated_at !== "string" || Number.isNaN(Date.parse(doc.generated_at))) {
    violations.push({ gateKey: null, reason: "generated_at is missing or not a valid date" });
  }

  const gates = Array.isArray(doc.gates) ? doc.gates : [];
  for (const gate of gates) {
    if (gate?.status !== "passed") continue;
    if (typeof gate.valid_until !== "string") {
      violations.push({ gateKey: gate.gate_key, reason: "passed gate has no valid_until" });
      continue;
    }
    const validUntil = new Date(gate.valid_until);
    if (Number.isNaN(validUntil.getTime())) {
      violations.push({ gateKey: gate.gate_key, reason: "valid_until is not a valid date" });
      continue;
    }
    if (validUntil.getTime() <= now.getTime()) {
      violations.push({ gateKey: gate.gate_key, reason: `valid_until (${gate.valid_until}) has passed` });
    }
  }

  return violations;
}

function main() {
  const { file, now } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(file)) {
    process.stderr.write(`gate-compliance-freshness: file not found: ${file}\n`);
    process.exit(2);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`gate-compliance-freshness: invalid JSON in ${file}: ${message}\n`);
    process.exit(2);
  }

  const violations = checkFreshness(doc, now);
  for (const v of violations) {
    process.stdout.write(`STALE ${v.gateKey ?? "(document)"}: ${v.reason}\n`);
  }
  process.stdout.write(
    `\ngate:compliance-freshness — ${violations.length} staleness violation(s)\n`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
