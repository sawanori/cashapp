#!/usr/bin/env node
// scripts/gate-status.mjs
//
// UserPromptSubmit hook. One compact line per signal, injected before every
// prompt so "how much is still open" never has to be remembered:
//   - acceptance checks with no evidence yet (docs/acceptance-checks.json)
//   - tasks parked at BLOCKED / NEEDS_CONTEXT (docs/task-list.json)
//   - the outstanding balance of high-severity concerns
//
// Contract: prints one JSON object on stdout with
// hookSpecificOutput.additionalContext, and always exits 0. A prompt must
// never be refused because this script could not read a file.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const MAX_TASKS_LISTED = 10;

const root =
  process.env.CLAUDE_PROJECT_DIR ||
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** @param {string} rel */
function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  } catch {
    return null;
  }
}

const lines = [];

const checksFile = readJson("docs/acceptance-checks.json");
if (checksFile && Array.isArray(checksFile.checks)) {
  const total = checksFile.checks.length;
  const open = checksFile.checks.filter(
    (c) => c && (c.evidence === null || c.evidence === undefined || c.evidence === ""),
  ).length;
  lines.push(`未通過 check: ${open} / ${total}（evidence 未記入。docs/acceptance-checks.json）`);
} else {
  lines.push("未通過 check: docs/acceptance-checks.json を読めませんでした");
}

const taskList = readJson("docs/task-list.json");
if (taskList && Array.isArray(taskList.tasks)) {
  const parked = taskList.tasks.filter(
    (t) => t && (t.completion_status === "BLOCKED" || t.completion_status === "NEEDS_CONTEXT"),
  );
  if (parked.length === 0) {
    lines.push("BLOCKED / NEEDS_CONTEXT: 0 件");
  } else {
    const names = parked
      .slice(0, MAX_TASKS_LISTED)
      .map((t) => `${t.task_id}(${t.completion_status})`)
      .join(", ");
    const more = parked.length > MAX_TASKS_LISTED ? ` ほか${parked.length - MAX_TASKS_LISTED}件` : "";
    lines.push(`BLOCKED / NEEDS_CONTEXT: ${parked.length} 件 — ${names}${more}`);
  }

  let high = 0;
  const highTasks = [];
  for (const t of taskList.tasks) {
    if (!t || !Array.isArray(t.concerns)) continue;
    const n = t.concerns.filter(
      (c) => typeof c === "string" && /severity\s*[:：]\s*high/i.test(c),
    ).length;
    if (n > 0) {
      high += n;
      highTasks.push(`${t.task_id}×${n}`);
    }
  }
  const highDetail = highTasks.length > 0 ? ` — ${highTasks.slice(0, MAX_TASKS_LISTED).join(", ")}` : "";
  lines.push(`high concerns 残高: ${high} 件${highDetail}`);
} else {
  lines.push("BLOCKED / NEEDS_CONTEXT・high concerns: docs/task-list.json を読めませんでした");
}

const payload = {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: `【ゲート状況】${lines.join(" / ")}`,
  },
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
process.exit(0);
