#!/usr/bin/env node
// scripts/wording-lint.mjs
//
// Machine-checks the forbidden vocabulary declared in docs/wording-policy.md.
//
// Two failure modes, both exit 1:
//   1. A forbidden word matched. Printed as: "<id> <file>:<line>"
//   2. A pattern group scanned ZERO files. A gate with nothing to look at is
//      not a passing gate (R-TH-01). `expect_targets: "now"` requires at least
//      one target today; `"from_task_XXX"` tolerates zero until that task is
//      DONE, and fails afterwards.
//
// Exit codes: 0 clean / 1 violation or empty gate / 2 usage or config error.
//
// Usage:
//   node scripts/wording-lint.mjs [--root <dir>] [--policy <file>]
//                                 [--task-list <file>] [--run-log-dir <dir>]
//                                 [--quiet]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MARKER_BEGIN = "<!-- machine-readable:begin -->";
const MARKER_END = "<!-- machine-readable:end -->";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const GLOB_CHARS = /^[A-Za-z0-9_./*?{},-]+$/;
// Private-use placeholders so `**` survives the `*` substitution below.
const STAR_STAR_SLASH = "\u0001";
const STAR_STAR = "\u0002";

/** @param {string} message */
function fail(message) {
  process.stderr.write(`wording-lint: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    root: "",
    policy: "",
    taskList: "",
    runLogDir: "",
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--root":
        if (next === undefined) fail("--root requires a value");
        out.root = next;
        i += 1;
        break;
      case "--policy":
        if (next === undefined) fail("--policy requires a value");
        out.policy = next;
        i += 1;
        break;
      case "--task-list":
        if (next === undefined) fail("--task-list requires a value");
        out.taskList = next;
        i += 1;
        break;
      case "--run-log-dir":
        if (next === undefined) fail("--run-log-dir requires a value");
        out.runLogDir = next;
        i += 1;
        break;
      case "--quiet":
        out.quiet = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(
          "Usage: node scripts/wording-lint.mjs [--root <dir>] [--policy <file>] [--task-list <file>] [--run-log-dir <dir>] [--quiet]\n",
        );
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return out;
}

/** Converts the supported glob subset into an anchored RegExp. */
function globToRegExp(glob) {
  if (!GLOB_CHARS.test(glob)) {
    fail(`unsupported character in glob: ${glob}`);
  }
  let g = glob.replace(/\./g, "\\.");
  if (g.includes("{")) {
    g = g.replace(/,/g, "|").replace(/\{/g, "(?:").replace(/\}/g, ")");
  }
  g = g
    .split("**/").join(STAR_STAR_SLASH)
    .split("**").join(STAR_STAR)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .split(STAR_STAR_SLASH).join("(?:.*/)?")
    .split(STAR_STAR).join(".*");
  return new RegExp(`^(?:${g})$`);
}

/** @param {string[]} globs */
function globsToMatcher(globs) {
  const regexes = globs.map(globToRegExp);
  return (/** @type {string} */ file) => regexes.some((re) => re.test(file));
}

function listFiles(root) {
  if (fs.existsSync(path.join(root, ".git"))) {
    const out = execFileSync(
      "git",
      ["-C", root, "ls-files", "-co", "--exclude-standard"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return out.split("\n").filter((l) => l.length > 0).sort();
  }
  const acc = [];
  const skip = new Set([".git", "node_modules", ".next", ".open-next", ".wrangler"]);
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
      else if (ent.isFile()) acc.push(rel);
    }
  };
  walk(root, "");
  return acc.sort();
}

function extractPolicy(policyPath) {
  if (!fs.existsSync(policyPath)) fail(`policy file not found: ${policyPath}`);
  const md = fs.readFileSync(policyPath, "utf8");
  const start = md.indexOf(MARKER_BEGIN);
  const end = md.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) {
    fail(`machine-readable block not found in ${policyPath}`);
  }
  const block = md.slice(start + MARKER_BEGIN.length, end);
  const fenceStart = block.indexOf("```json");
  const fenceEnd = block.indexOf("```", fenceStart + 7);
  if (fenceStart === -1 || fenceEnd === -1) {
    fail(`no \`\`\`json fence inside the machine-readable block of ${policyPath}`);
  }
  const json = block.slice(fenceStart + 7, fenceEnd);
  try {
    return JSON.parse(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`machine-readable block is not valid JSON: ${message}`);
  }
}

function escapeLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A task counts as DONE only when BOTH signals agree: task-list.json says
 * DONE / DONE_WITH_CONCERNS, and docs/run-log/<task_id>.json exists.
 */
function makeTaskIsDone(taskListPath, runLogDir) {
  let statuses = null;
  return (taskId) => {
    if (!fs.existsSync(path.join(runLogDir, `${taskId}.json`))) return false;
    if (statuses === null) {
      statuses = new Map();
      if (fs.existsSync(taskListPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(taskListPath, "utf8"));
          const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
          for (const t of tasks) {
            if (typeof t?.task_id === "string") {
              statuses.set(t.task_id, t.completion_status ?? null);
            }
          }
        } catch {
          // An unreadable task ledger must not silently mark tasks DONE.
        }
      }
    }
    const status = statuses.get(taskId);
    return status === "DONE" || status === "DONE_WITH_CONCERNS";
  };
}

/** Index ranges of every allowed-phrase occurrence in a line. */
function allowedRanges(line, allowedPhrases) {
  const ranges = [];
  for (const phrase of allowedPhrases) {
    if (phrase.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = line.indexOf(phrase, from);
      if (at === -1) break;
      ranges.push([at, at + phrase.length]);
      from = at + 1;
    }
  }
  return ranges;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let root = args.root;
  if (root === "") {
    try {
      root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim();
    } catch {
      fail("not inside a git repository and --root not given");
    }
  }
  if (!fs.existsSync(root)) fail(`no such directory: ${root}`);

  const policyPath = args.policy || path.join(root, "docs", "wording-policy.md");
  const taskListPath = args.taskList || path.join(root, "docs", "task-list.json");
  const runLogDir = args.runLogDir || path.join(root, "docs", "run-log");

  const policy = extractPolicy(policyPath);
  const forbidden = Array.isArray(policy?.forbidden) ? policy.forbidden : null;
  if (forbidden === null || forbidden.length === 0) {
    fail(`policy has no "forbidden" entries: ${policyPath}`);
  }
  const allowedPhrases = Array.isArray(policy?.allowed_phrases)
    ? policy.allowed_phrases
    : [];
  const globalExclude = Array.isArray(policy?.global_exclude_globs)
    ? globsToMatcher(policy.global_exclude_globs)
    : () => false;

  const taskIsDone = makeTaskIsDone(taskListPath, runLogDir);
  const files = listFiles(root);
  const log = (s) => {
    if (!args.quiet) process.stdout.write(`${s}\n`);
  };

  let violations = 0;
  let emptyGates = 0;
  let scanned = 0;

  for (const entry of forbidden) {
    const id = typeof entry?.id === "string" ? entry.id : null;
    if (id === null) fail("a forbidden entry has no id");
    const patterns = Array.isArray(entry.patterns) ? entry.patterns : [];
    if (patterns.length === 0) fail(`${id}: patterns is empty`);
    const globs = Array.isArray(entry.globs) ? entry.globs : [];
    if (globs.length === 0) fail(`${id}: globs is empty`);
    const expectTargets = entry.expect_targets;
    if (typeof expectTargets !== "string") fail(`${id}: expect_targets is missing`);

    const include = globsToMatcher(globs);
    const exclude = Array.isArray(entry.exclude_globs) && entry.exclude_globs.length > 0
      ? globsToMatcher(entry.exclude_globs)
      : () => false;

    const targets = files.filter((f) => include(f) && !globalExclude(f) && !exclude(f));

    if (targets.length === 0) {
      if (expectTargets === "now") {
        process.stderr.write(
          `EMPTY ${id}: expect_targets=now but 0 files matched ${JSON.stringify(globs)}\n`,
        );
        emptyGates += 1;
      } else if (expectTargets.startsWith("from_task_")) {
        const dep = expectTargets.slice("from_".length);
        if (taskIsDone(dep)) {
          process.stderr.write(
            `EMPTY ${id}: expect_targets=${expectTargets} and ${dep} is DONE, but 0 files matched ${JSON.stringify(globs)}\n`,
          );
          emptyGates += 1;
        } else {
          log(`defer ${id} (0 targets; waiting on ${dep})`);
        }
      } else {
        fail(`${id}: unsupported expect_targets: ${expectTargets}`);
      }
      continue;
    }

    scanned += 1;
    const isRegex = entry.regex === true;
    const regexes = patterns.map((p) => {
      try {
        return new RegExp(isRegex ? p : escapeLiteral(p), "g");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return fail(`${id}: invalid pattern ${JSON.stringify(p)}: ${message}`);
      }
    });

    let entryHits = 0;
    for (const rel of targets) {
      const abs = path.join(root, rel);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const lines = fs.readFileSync(abs, "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        const allowed = allowedPhrases.length > 0 ? allowedRanges(line, allowedPhrases) : [];
        for (const re of regexes) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(line)) !== null) {
            if (m[0].length === 0) {
              re.lastIndex += 1;
              continue;
            }
            const start = m.index;
            const stop = start + m[0].length;
            const exempt = allowed.some(([as, ae]) => as <= start && stop <= ae);
            if (!exempt) {
              process.stdout.write(
                `${id} ${rel}:${i + 1} | ${m[0]} | ${line.trim().slice(0, 120)}\n`,
              );
              entryHits += 1;
            }
          }
        }
      }
    }

    violations += entryHits;
    if (entryHits === 0) log(`ok    ${id} (${targets.length} file(s))`);
  }

  log("");
  log(
    `gate:wording — scanned ${scanned} pattern group(s), ${violations} violation(s), ${emptyGates} empty gate(s)`,
  );

  process.exit(violations > 0 || emptyGates > 0 ? 1 : 0);
}

main();
