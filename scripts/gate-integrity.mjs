#!/usr/bin/env node
// scripts/gate-integrity.mjs
//
// G13 (docs/implementation-plan.md §15-2): the harness files that decide what
// the harness allows must not change silently. Every file under
//
//   docs/gates/**, .claude/**, .github/workflows/**, scripts/gate-*,
//   scripts/deny-*, scripts/record-run.sh, scripts/append-handoff.sh,
//   scripts/session-brief.mjs, scripts/assert-*, scripts/validate-*,
//   scripts/ci/**
//
// is hashed (sha256) and compared against docs/gates/integrity-baseline.json.
// Added, removed and modified files are all violations: a new workflow file or
// a new deny-* script changes the gate net just as much as an edit does.
//
// The baseline itself lives under docs/gates/**, which every guard in this repo
// treats as write-protected for Edit / Write / Bash (R-SEC-07, F13). This
// script is the one sanctioned writer, and only when asked explicitly:
//
//   node scripts/gate-integrity.mjs --write-baseline
//
// That is a real residual risk and is recorded as such in
// docs/concerns/task_006.md: an agent that can run this command can launder a
// tamper by regenerating the baseline. What the baseline buys is that the
// laundering shows up as a diff in docs/gates/** — which CODEOWNERS (task_009)
// and the test-tamper-guard CI job put in front of a human.
//
// Usage:
//   node scripts/gate-integrity.mjs [--root <dir>] [--base <dir>]
//                                   [--baseline <file>] [--write-baseline]
//                                   [--json] [--quiet]
//
// Exit codes: 0 match / 1 mismatch (or missing baseline) / 2 usage error.

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const BASELINE_REL = "docs/gates/integrity-baseline.json";

/**
 * Directories scanned in full, and single files / prefixes pinned by name.
 * Kept as data so the report can name the rule a file came in under.
 */
export const INTEGRITY_PATTERNS = [
  { kind: "dir", value: "docs/gates" },
  { kind: "dir", value: ".claude" },
  { kind: "dir", value: ".github/workflows" },
  { kind: "dir", value: "scripts/ci" },
  { kind: "prefix", value: "scripts/gate-" },
  { kind: "prefix", value: "scripts/deny-" },
  { kind: "prefix", value: "scripts/assert-" },
  { kind: "prefix", value: "scripts/validate-" },
  { kind: "file", value: "scripts/record-run.sh" },
  { kind: "file", value: "scripts/append-handoff.sh" },
  { kind: "file", value: "scripts/session-brief.mjs" },
];

/** Never hashed: the baseline cannot contain its own hash. */
const SELF_EXCLUDE = new Set([BASELINE_REL]);

/** Noise that is not part of the harness contract. */
const NAME_EXCLUDE = new Set([".DS_Store"]);

/** @param {string} dir @param {string} prefix @param {string[]} out */
function walk(dir, prefix, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (NAME_EXCLUDE.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/**
 * The file universe always comes from `base` (the real repository), never from
 * an overlay root: a violation fixture supplies only a wrong baseline, and the
 * point of that fixture is a hash MISMATCH on a real file, not a phantom
 * "file disappeared".
 *
 * @param {string} base
 * @returns {string[]} repo-relative paths, sorted, de-duplicated
 */
export function listIntegrityFiles(base) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const pattern of INTEGRITY_PATTERNS) {
    if (pattern.kind === "dir") {
      /** @type {string[]} */
      const out = [];
      walk(path.join(base, pattern.value), pattern.value, out);
      for (const rel of out) found.add(rel);
      continue;
    }
    if (pattern.kind === "file") {
      if (fs.existsSync(path.join(base, pattern.value))) found.add(pattern.value);
      continue;
    }
    // prefix: scripts/gate-* and friends live directly under scripts/
    const dir = path.dirname(pattern.value);
    const namePrefix = path.basename(pattern.value);
    let entries;
    try {
      entries = fs.readdirSync(path.join(base, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (NAME_EXCLUDE.has(entry.name)) continue;
      if (!entry.name.startsWith(namePrefix)) continue;
      found.add(`${dir}/${entry.name}`);
    }
  }
  for (const self of SELF_EXCLUDE) found.delete(self);
  return [...found].sort();
}

/** @param {string} abs */
function sha256(abs) {
  return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}

/**
 * @param {{root: string, base: string, resolve: (rel: string) => string}} ctx
 * @returns {{files: Record<string, string>, count: number}}
 */
export function collectIntegrity(ctx) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of listIntegrityFiles(ctx.base)) {
    const abs = ctx.resolve(rel);
    try {
      files[rel] = sha256(abs);
    } catch {
      files[rel] = "<unreadable>";
    }
  }
  return { files, count: Object.keys(files).length };
}

/** Counter carried in the same baseline so G7 has a recorded floor. */
export function countContractTests(ctx) {
  /** @type {string[]} */
  const out = [];
  walk(ctx.resolve("tests/contract"), "", out);
  return out.filter((f) => f.endsWith(".ts") || f.endsWith(".tsx")).length;
}

/**
 * @param {{root: string, base: string, resolve: (rel: string) => string}} ctx
 * @returns {{status: "ok"|"violation", targets: number, violations: string[], notes: string[], baseline: unknown}}
 */
export function checkIntegrity(ctx) {
  const violations = [];
  const notes = [];
  const current = collectIntegrity(ctx);

  const baselinePath = ctx.resolve(BASELINE_REL);
  /** @type {any} */
  let baseline = null;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch {
    violations.push(
      `${BASELINE_REL} を読めません（未作成または JSON として不正）。` +
        "`node scripts/gate-integrity.mjs --write-baseline` で基準値を作成してください",
    );
    return { status: "violation", targets: current.count, violations, notes, baseline: null };
  }

  const recorded = baseline && typeof baseline.files === "object" && baseline.files !== null
    ? baseline.files
    : null;
  if (!recorded) {
    violations.push(`${BASELINE_REL} に files オブジェクトがありません`);
    return { status: "violation", targets: current.count, violations, notes, baseline };
  }

  for (const [rel, hash] of Object.entries(current.files)) {
    const want = recorded[rel];
    if (want === undefined) {
      violations.push(`追加: ${rel}（基準値に無いファイルがゲート対象領域に増えています）`);
      continue;
    }
    if (want !== hash) {
      violations.push(`不一致: ${rel}（基準値 ${String(want).slice(0, 12)}… / 実測 ${hash.slice(0, 12)}…）`);
    }
  }
  for (const rel of Object.keys(recorded)) {
    if (current.files[rel] === undefined) {
      violations.push(`欠落: ${rel}（基準値にあるファイルがありません）`);
    }
  }

  notes.push(`ハッシュ対象 ${current.count} ファイル（sha256）`);
  return {
    status: violations.length > 0 ? "violation" : "ok",
    targets: current.count,
    violations,
    notes,
    baseline,
  };
}

/** @param {string} base */
function headCommit(base) {
  try {
    return execFileSync("git", ["-C", base, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * @param {{root: string, base: string, resolve: (rel: string) => string}} ctx
 * @returns {string} the path written
 */
export function writeBaseline(ctx) {
  const current = collectIntegrity(ctx);
  const target = path.join(ctx.base, BASELINE_REL);
  const payload = {
    $comment:
      "G13 の基準値。docs/gates/** は PO 専管のため、このファイルの唯一の書き込み経路は " +
      "`node scripts/gate-integrity.mjs --write-baseline` である（scripts/deny-test-weakening.sh / " +
      "deny-dangerous-bash.sh が Edit / Write / Bash 経由の直接書き込みを遮断する）。" +
      "ゲート対象領域を意図して変更したときだけ再生成し、差分を PR で人間に見せること。",
    schema_version: 1,
    algorithm: "sha256",
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    generated_by: "scripts/gate-integrity.mjs --write-baseline",
    generated_at_commit: headCommit(ctx.base),
    patterns: INTEGRITY_PATTERNS,
    counters: {
      contract_test_min_count: countContractTests(ctx),
    },
    files: current.files,
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return target;
}

// ---------------------------------------------------------------------- CLI --

function parseArgs(argv) {
  const out = { root: "", base: "", write: false, json: false, quiet: false };
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
      case "--write-baseline":
        out.write = true;
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
          "Usage: node scripts/gate-integrity.mjs [--root <dir>] [--base <dir>] [--write-baseline] [--json] [--quiet]\n",
        );
        process.exit(0);
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function usage(message) {
  process.stderr.write(`gate-integrity: ${message}\n`);
  process.exit(2);
}

export function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  }
}

/** Root-first resolution: the overlay wins when it has the file. */
export function makeResolver(root, base) {
  return (/** @type {string} */ rel) => {
    const candidate = path.join(root, rel);
    if (fs.existsSync(candidate)) return candidate;
    return path.join(base, rel);
  };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base || repoRoot();
  const root = args.root || base;
  const ctx = { root, base, resolve: makeResolver(root, base) };

  if (args.write) {
    const written = writeBaseline(ctx);
    process.stdout.write(`gate:integrity — 基準値を書きました: ${path.relative(base, written)}\n`);
    process.exit(0);
  }

  const result = checkIntegrity(ctx);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!args.quiet) {
    for (const note of result.notes) process.stdout.write(`      ${note}\n`);
    for (const v of result.violations) process.stdout.write(`G13 ${v}\n`);
    process.stdout.write(
      `\ngate:integrity — ${result.targets} ファイルを照合、${result.violations.length} 件の不一致\n`,
    );
  }
  process.exit(result.status === "violation" ? 1 : 0);
}
