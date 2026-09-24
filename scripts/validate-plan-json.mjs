#!/usr/bin/env node
// scripts/validate-plan-json.mjs  —  npm run gate:plan
//
// docs/task-list.json と docs/acceptance-checks.json の**構造**を検査する。
// gate-check.mjs（G0〜G14）が判定するのは中身の整合であって、JSON が壊れていたり
// 必須フィールドの型が違ったりすれば、その手前でどのゲートも意味を失う。
// PostToolUse フックに登録してあるので、台帳を壊す編集はその場で分かる。
//
// 検査すること:
//   - JSON として読めること、トップレベルの形
//   - task: task_id の一意性・必須フィールドの存在と型・列挙値・依存の解決・循環の不在
//   - check: id の一意性・必須フィールドの存在と型・列挙値
//   - 相互参照: acceptance_check_ids / constraint_ids が実在すること
//
// 検査しないこと（gate-check.mjs の担当）: 完了申告の裏取り、コマンドの実在、evidence の鮮度。
//
// Usage: node scripts/validate-plan-json.mjs [--root <dir>] [--json] [--quiet]
// Exit codes: 0 clean / 1 violation / 2 usage or read error.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { repoRoot } from "./gate-integrity.mjs";

const COMPLETION_STATES = new Set([
  "DONE",
  "DONE_WITH_CONCERNS",
  "BLOCKED",
  "NEEDS_CONTEXT",
  "in_progress",
]);
const RISK_LEVELS = new Set(["low", "medium", "high"]);
const REVIEW_MODES = new Set(["required", "not_required", "optional"]);
const CHECK_MODES = new Set(["automated", "manual"]);

const TASK_STRING_FIELDS = ["task_id", "title", "goal", "phase", "gate_level", "evidence_label"];
const TASK_ARRAY_FIELDS = [
  "scope",
  "non_scope",
  "files_to_read",
  "files_to_create",
  "files_to_modify",
  "dependencies",
  "implementation_steps",
  "done_definition",
  "verify_commands",
  "constraint_ids",
  "risk_ids",
  "acceptance_check_ids",
  "concerns",
];
const CHECK_STRING_FIELDS = ["id", "target", "rule", "expected_result", "verification_method"];

/** @param {string} message */
function usage(message) {
  process.stderr.write(`validate-plan-json: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { root: "", json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--root":
        if (next === undefined) usage("--root requires a value");
        out.root = next;
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
        process.stdout.write("Usage: node scripts/validate-plan-json.mjs [--root <dir>] [--json] [--quiet]\n");
        process.exit(0);
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }
  return out;
}

/**
 * @param {string} root
 * @returns {{violations: string[], counts: Record<string, number>}}
 */
export function validatePlanJson(root) {
  /** @type {string[]} */
  const violations = [];
  const counts = { tasks: 0, checks: 0, constraints: 0 };

  /** @param {string} rel */
  const read = (rel) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
    } catch (err) {
      violations.push(`${rel}: 読めません（${err instanceof Error ? err.message : String(err)}）`);
      return null;
    }
  };

  const taskList = read("docs/task-list.json");
  const checksFile = read("docs/acceptance-checks.json");
  const constraintsFile = read("docs/constraints.json");
  if (taskList === null || checksFile === null || constraintsFile === null) {
    return { violations, counts };
  }

  if (!Array.isArray(taskList.tasks)) {
    violations.push("docs/task-list.json: tasks が配列ではありません");
    return { violations, counts };
  }
  if (!Array.isArray(checksFile.checks)) {
    violations.push("docs/acceptance-checks.json: checks が配列ではありません");
    return { violations, counts };
  }

  const tasks = taskList.tasks;
  const checks = checksFile.checks;
  counts.tasks = tasks.length;
  counts.checks = checks.length;

  /** @type {Set<string>} */
  const constraintIds = new Set();
  for (const key of ["constraints", "gate_only_checks"]) {
    for (const entry of Array.isArray(constraintsFile[key]) ? constraintsFile[key] : []) {
      if (entry && typeof entry.id === "string") constraintIds.add(entry.id);
    }
  }
  counts.constraints = constraintIds.size;
  if (constraintIds.size === 0) {
    violations.push("docs/constraints.json: 制約 ID を 1 件も読み取れません");
  }

  // ---------------------------------------------------------------- tasks --
  /** @type {Map<string, number>} */
  const taskIndex = new Map();
  tasks.forEach((t, i) => {
    const where = `docs/task-list.json tasks[${i}]`;
    if (!t || typeof t !== "object") {
      violations.push(`${where}: オブジェクトではありません`);
      return;
    }
    const id = t.task_id;
    if (typeof id !== "string" || id.length === 0) {
      violations.push(`${where}: task_id がありません`);
    } else if (taskIndex.has(id)) {
      violations.push(`${where}: task_id が重複しています: ${id}`);
    } else {
      taskIndex.set(id, i);
    }

    const label = typeof id === "string" ? id : where;
    for (const field of TASK_STRING_FIELDS) {
      if (typeof t[field] !== "string" || t[field].length === 0) {
        violations.push(`${label}: ${field} が非空の文字列ではありません`);
      }
    }
    for (const field of TASK_ARRAY_FIELDS) {
      if (!Array.isArray(t[field])) {
        violations.push(`${label}: ${field} が配列ではありません`);
      }
    }
    if (t.manual_verification !== null && t.manual_verification !== undefined && !Array.isArray(t.manual_verification)) {
      violations.push(`${label}: manual_verification は null か配列である必要があります`);
    }
    if (t.completion_status !== null && !COMPLETION_STATES.has(t.completion_status)) {
      violations.push(`${label}: completion_status が 4 値 + in_progress + null のいずれでもありません: ${String(t.completion_status)}`);
    }
    if (!RISK_LEVELS.has(t.risk_level)) {
      violations.push(`${label}: risk_level が low / medium / high のいずれでもありません: ${String(t.risk_level)}`);
    }
    if (!REVIEW_MODES.has(t.adversarial_review)) {
      violations.push(`${label}: adversarial_review が required / not_required / optional のいずれでもありません: ${String(t.adversarial_review)}`);
    }
    if (typeof t.optional !== "boolean") {
      violations.push(`${label}: optional が boolean ではありません`);
    }
  });

  // dependencies: 解決と循環
  for (const t of tasks) {
    if (!t || typeof t.task_id !== "string") continue;
    for (const dep of Array.isArray(t.dependencies) ? t.dependencies : []) {
      if (!taskIndex.has(dep)) {
        violations.push(`${t.task_id}: dependencies の ${dep} が task-list にありません`);
      }
      if (dep === t.task_id) {
        violations.push(`${t.task_id}: 自分自身に依存しています`);
      }
    }
  }
  const cycle = findDependencyCycle(tasks);
  if (cycle) {
    violations.push(`依存に循環があります: ${cycle.join(" -> ")}`);
  }

  // --------------------------------------------------------------- checks --
  /** @type {Set<string>} */
  const checkIds = new Set();
  checks.forEach((c, i) => {
    const where = `docs/acceptance-checks.json checks[${i}]`;
    if (!c || typeof c !== "object") {
      violations.push(`${where}: オブジェクトではありません`);
      return;
    }
    const id = c.id;
    if (typeof id !== "string" || id.length === 0) {
      violations.push(`${where}: id がありません`);
    } else if (checkIds.has(id)) {
      violations.push(`${where}: id が重複しています: ${id}`);
    } else {
      checkIds.add(id);
    }
    const label = typeof id === "string" ? id : where;
    for (const field of CHECK_STRING_FIELDS) {
      if (typeof c[field] !== "string" || c[field].length === 0) {
        violations.push(`${label}: ${field} が非空の文字列ではありません`);
      }
    }
    if (!CHECK_MODES.has(c.manual_or_automated)) {
      violations.push(`${label}: manual_or_automated が automated / manual のいずれでもありません: ${String(c.manual_or_automated)}`);
    }
    for (const field of ["constraint_ids", "risk_ids"]) {
      if (!Array.isArray(c[field])) violations.push(`${label}: ${field} が配列ではありません`);
    }
    if (c.evidence !== null && (typeof c.evidence !== "object" || c.evidence === undefined)) {
      violations.push(`${label}: evidence は null かオブジェクトである必要があります`);
    }
  });

  // ------------------------------------------------------------ 相互参照 --
  for (const t of tasks) {
    if (!t || typeof t.task_id !== "string") continue;
    for (const ref of Array.isArray(t.acceptance_check_ids) ? t.acceptance_check_ids : []) {
      if (!checkIds.has(ref)) violations.push(`${t.task_id}: acceptance_check_ids の ${ref} が acceptance-checks にありません`);
    }
    for (const ref of Array.isArray(t.constraint_ids) ? t.constraint_ids : []) {
      if (!constraintIds.has(ref)) violations.push(`${t.task_id}: constraint_ids の ${ref} が constraints.json にありません`);
    }
  }
  for (const c of checks) {
    if (!c || typeof c.id !== "string") continue;
    for (const ref of Array.isArray(c.constraint_ids) ? c.constraint_ids : []) {
      if (!constraintIds.has(ref)) violations.push(`${c.id}: constraint_ids の ${ref} が constraints.json にありません`);
    }
  }

  return { violations, counts };
}

/** @returns {string[]|null} */
function findDependencyCycle(tasks) {
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  for (const t of tasks) {
    if (!t || typeof t.task_id !== "string") continue;
    graph.set(t.task_id, (Array.isArray(t.dependencies) ? t.dependencies : []).filter((d) => typeof d === "string"));
  }
  /** @type {Map<string, number>} */
  const state = new Map();
  /** @type {string[]} */
  const stack = [];

  /** @param {string} node */
  function visit(node) {
    const mark = state.get(node) ?? 0;
    if (mark === 1) {
      const from = stack.indexOf(node);
      return [...stack.slice(from), node];
    }
    if (mark === 2) return null;
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(node, 2);
    return null;
  }

  for (const node of graph.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------- CLI --

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root || repoRoot());
  const { violations, counts } = validatePlanJson(root);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ root, counts, violations }, null, 2)}\n`);
  } else if (!args.quiet) {
    for (const v of violations) process.stdout.write(`gate:plan ${v}\n`);
    process.stdout.write(
      `\ngate:plan — task ${counts.tasks} 件 / check ${counts.checks} 件 / 制約 ${counts.constraints} 件を検査、${violations.length} 件の構造違反\n`,
    );
  }
  process.exit(violations.length > 0 ? 1 : 0);
}
