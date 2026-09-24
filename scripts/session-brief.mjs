#!/usr/bin/env node
// scripts/session-brief.mjs
//
// SessionStart hook. Injects the state a fresh session cannot see for itself:
// which compliance gates are still not passed, whether production payments are
// legally cleared, which external inquiries are still unanswered (overdue ones
// first), and the tail of docs/HANDOFF.md.
//
// Counters R-TH-05 (state lost between sessions) and R-TH-12 (no one notices a
// gate or an inquiry is stuck).
//
// Contract: prints one JSON object on stdout with
// hookSpecificOutput.additionalContext, and always exits 0. A session must
// never fail to start because this script could not read a file.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const HANDOFF_TAIL_LINES = 40;
const MAX_GATES_LISTED = 20;
const MAX_INQUIRIES_LISTED = 20;

const root =
  process.env.CLAUDE_PROJECT_DIR ||
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** @param {string} rel */
function readText(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

/** @param {string} rel */
function readJson(rel) {
  const text = readText(rel);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const lines = [];
const push = (s) => lines.push(s);

push("【セッションブリーフ】scripts/session-brief.mjs（SessionStart）");
push("");

// ------------------------------------------------------------- gate status --
const complianceGates = readJson("docs/gates/compliance-gates.json");
if (complianceGates && Array.isArray(complianceGates.gates)) {
  const gates = complianceGates.gates;
  const open = gates.filter((g) => g && g.status !== "passed" && g.status !== "n/a");
  push(`■ コンプライアンスゲート: 未通過 ${open.length} / 全 ${gates.length} 件（docs/gates/compliance-gates.json）`);
  for (const g of open.slice(0, MAX_GATES_LISTED)) {
    const required = Array.isArray(g.required_for) ? g.required_for.join(",") : "?";
    push(`   - ${g.gate_key} [status=${g.status} / required_for=${required}]`);
  }
  if (open.length > MAX_GATES_LISTED) {
    push(`   …ほか ${open.length - MAX_GATES_LISTED} 件`);
  }
} else {
  push("■ コンプライアンスゲート: docs/gates/compliance-gates.json を読めませんでした（未作成か壊れています）");
}

// --------------------------------------------------------- legal clearance --
const clearance = readJson("docs/gates/legal-clearance.json");
if (clearance && typeof clearance.cleared === "boolean") {
  if (clearance.cleared) {
    push(
      `■ 本番決済クリアランス: cleared=true（承認 ${clearance.approved_by ?? "?"} / ${clearance.approved_at ?? "?"}）`,
    );
  } else {
    push("■ 本番決済クリアランス: cleared=false — 本番の資金移動を有効化してはいけません（L11）");
  }
} else {
  push("■ 本番決済クリアランス: docs/gates/legal-clearance.json を読めませんでした → cleared=false として扱ってください");
}

// ------------------------------------------------------- external inquiries --
const inquiriesFile = readJson("docs/external-inquiries.json");
if (inquiriesFile && Array.isArray(inquiriesFile.inquiries)) {
  const now = Date.now();
  const openInquiries = inquiriesFile.inquiries.filter(
    (q) => q && q.status !== "answered" && q.status !== "superseded",
  );
  const withMeta = openInquiries.map((q) => {
    const deadline = q.no_response_deadline ? Date.parse(q.no_response_deadline) : NaN;
    const overdueDays = Number.isNaN(deadline) ? null : Math.floor((now - deadline) / 86400000);
    return { q, overdueDays };
  });
  // Overdue first, longest overdue at the top; then sent-but-not-due; then drafts.
  withMeta.sort((a, b) => {
    const aOver = a.overdueDays !== null && a.overdueDays >= 0;
    const bOver = b.overdueDays !== null && b.overdueDays >= 0;
    if (aOver !== bOver) return aOver ? -1 : 1;
    if (aOver && bOver) return (b.overdueDays ?? 0) - (a.overdueDays ?? 0);
    const aSent = a.q.status === "sent";
    const bSent = b.q.status === "sent";
    if (aSent !== bSent) return aSent ? -1 : 1;
    return 0;
  });
  const overdueCount = withMeta.filter((m) => m.overdueDays !== null && m.overdueDays >= 0).length;
  push(
    `■ 未回答の外部照会: ${openInquiries.length} 件（うち期限超過 ${overdueCount} 件。docs/external-inquiries.json）`,
  );
  for (const { q, overdueDays } of withMeta.slice(0, MAX_INQUIRIES_LISTED)) {
    const gateKeys = Array.isArray(q.gate_keys) && q.gate_keys.length > 0 ? q.gate_keys.join(",") : "-";
    if (overdueDays !== null && overdueDays >= 0) {
      push(`   [期限超過 ${overdueDays}日] ${q.id} → ${q.to} / gates=${gateKeys}`);
      if (q.default_decision_on_timeout) {
        push(`       既定判断: ${String(q.default_decision_on_timeout).slice(0, 120)}`);
      }
    } else {
      push(`   - ${q.id} → ${q.to} [status=${q.status}] / gates=${gateKeys}`);
    }
  }
  if (withMeta.length > MAX_INQUIRIES_LISTED) {
    push(`   …ほか ${withMeta.length - MAX_INQUIRIES_LISTED} 件`);
  }
} else {
  push("■ 未回答の外部照会: docs/external-inquiries.json を読めませんでした");
}

// -------------------------------------------------------------- handoff tail --
const handoff = readText("docs/HANDOFF.md");
push("");
if (handoff === null) {
  push("■ docs/HANDOFF.md が読めませんでした");
} else {
  const tail = handoff.replace(/\n+$/, "").split("\n").slice(-HANDOFF_TAIL_LINES);
  push(`■ docs/HANDOFF.md 末尾 ${tail.length} 行:`);
  for (const line of tail) push(`   ${line}`);
}

const payload = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: lines.join("\n"),
  },
};

process.stdout.write(`${JSON.stringify(payload)}\n`);
process.exit(0);
