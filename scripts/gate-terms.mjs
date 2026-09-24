#!/usr/bin/env node
// scripts/gate-terms.mjs
//
// `src/content/terms.md`（利用規約）の機械検査。task_021 scope。
//
// 2 つのことを見る:
//   1. 必須条項が揃っているか（L5 / scope: 一部免責・上限型、債務消滅時点、未成年、
//      反社排除、擬似匿名化）。文言そのものの法的十分性は判定できない
//      （`docs/wording-policy.md` と同じ限界。見るのは条項の**存在**だけ）。
//   2. 「全部免責」（包括的な責任の免除。消費者契約法8条で無効とされうる表現）が
//      混入していないか。存在すれば exit 1。
//
// Exit codes: 0 clean / 1 violation・必須条項欠落 / 2 usage・ファイル不在。
//
// Usage: node scripts/gate-terms.mjs [--file <path>]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  let file = path.join(REPO_ROOT, "src", "content", "terms.md");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--file") {
      const next = argv[i + 1];
      if (next === undefined) {
        process.stderr.write("gate-terms: --file requires a value\n");
        process.exit(2);
      }
      file = path.isAbsolute(next) ? next : path.join(REPO_ROOT, next);
      i += 1;
    }
  }
  return { file };
}

/**
 * 必須条項マーカー。terms.md の実文言に依存する部分文字列一致（正規表現ではない）。
 * 「存在するか」だけを見る — 法的十分性の判定はしない。
 */
export const REQUIRED_CLAUSE_MARKERS = [
  { id: "DEBT_EXTINGUISH", label: "支払債務の消滅時点", pattern: "支払債務は消滅" },
  { id: "LIABILITY_CAP", label: "一部免責・上限型の免責", pattern: "上限として" },
  { id: "MINORS", label: "未成年に関する条項", pattern: "未成年" },
  { id: "ANTI_ORGANIZED_CRIME", label: "反社会的勢力の排除", pattern: "反社会的勢力" },
  { id: "PSEUDO_ANONYMIZATION", label: "擬似匿名化（削除請求への対応）", pattern: "擬似匿名化" },
];

/**
 * 「全部免責」（包括的な免責）を示す表現。ここに 1 つでも一致すると exit 1。
 * `REQUIRED_CLAUSE_MARKERS` の `LIABILITY_CAP`（一部免責・上限型）と対になる禁止側の検査。
 */
export const BLANKET_DISCLAIMER_PATTERNS = [
  /一切.{0,4}責任を負い?ません/,
  /一切.{0,4}責任を負わない/,
  /いかなる場合(で)?も.{0,10}責任を負い?ません/,
  /如何なる場合(で)?も.{0,10}責任を負い?ません/,
  /何ら責任を負い?ません/,
  /全部免責/,
  /責任を一切負わない/,
];

export function checkTerms(content) {
  const missing = REQUIRED_CLAUSE_MARKERS.filter((m) => !content.includes(m.pattern));
  const blanketHits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const re of BLANKET_DISCLAIMER_PATTERNS) {
      if (re.test(lines[i])) {
        blanketHits.push({ line: i + 1, text: lines[i].trim(), pattern: re.source });
      }
    }
  }
  return { missing, blanketHits };
}

function main() {
  const { file } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(file)) {
    process.stderr.write(`gate-terms: file not found: ${file}\n`);
    process.exit(2);
  }
  const content = fs.readFileSync(file, "utf8");
  const { missing, blanketHits } = checkTerms(content);

  let ok = true;
  for (const marker of REQUIRED_CLAUSE_MARKERS) {
    const isMissing = missing.some((m) => m.id === marker.id);
    process.stdout.write(`${isMissing ? "MISSING" : "ok     "} ${marker.id} (${marker.label})\n`);
    if (isMissing) ok = false;
  }
  for (const hit of blanketHits) {
    process.stdout.write(
      `BLANKET_DISCLAIMER ${file}:${hit.line} | ${hit.text.slice(0, 120)}\n`,
    );
    ok = false;
  }

  process.stdout.write(
    `\ngate:terms — ${REQUIRED_CLAUSE_MARKERS.length - missing.length}/${REQUIRED_CLAUSE_MARKERS.length} required clauses present, ${blanketHits.length} blanket-disclaimer hit(s)\n`,
  );
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
