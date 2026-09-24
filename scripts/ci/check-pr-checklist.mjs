#!/usr/bin/env node
// scripts/ci/check-pr-checklist.mjs  —  CI の test-tamper-guard ジョブの判定器
//
// 何をするか（docs/implementation-plan.md §16-6 / §16-8 F3、R-TH-04 / R-SEC-07）:
//   PR の差分に「ハーネス自身を緩められる場所」が含まれているとき、PR 本文の
//   ゲート緩和チェックリスト 4 項目（何を緩めたか / 理由 / 復旧予定日 / 代替の検知手段）
//   がすべて埋まっていることを要求する。
//
// 何をしないか:
//   記入内容の妥当性は検証しない。これは**人間の関門ではない**。単一アカウント運用では
//   CODEOWNERS の承認必須が構造的に成立しない（A19 / R-TH-04）ので、承認の代わりに
//   「何をどう緩めたかが PR 本文に残る」ことだけを機械的に強制する。事後追跡のための
//   記録強制であって、記入すれば通る。通ったことは「レビューされた」を意味しない。
//
// 入力:
//   PR 本文     … --body-file <path> / --body <text> / 環境変数 PR_BODY
//   変更ファイル … --changed-file <path>（1 行 1 パス）/ --changed <csv> / 環境変数 PR_CHANGED_FILES
//
// 使い方:
//   node scripts/ci/check-pr-checklist.mjs --body-file pr-body.txt --changed-file changed.txt
//   node scripts/ci/check-pr-checklist.mjs --json
//
// 終了コード: 0 合格 / 1 違反 / 2 使用法・入力エラー

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * 差分があったときにチェックリスト記入を要求するパス。
 * §16-6 の test-tamper-guard 行と docs/gates/README.md の対象に合わせている。
 * 追加するときは .github/PULL_REQUEST_TEMPLATE.md のコメントも直すこと。
 */
export const GUARDED_PATTERNS = [
  { label: "tests/**", test: (p) => p === "tests" || p.startsWith("tests/") },
  { label: "scripts/**", test: (p) => p === "scripts" || p.startsWith("scripts/") },
  { label: ".claude/**", test: (p) => p === ".claude" || p.startsWith(".claude/") },
  { label: ".github/**", test: (p) => p === ".github" || p.startsWith(".github/") },
  { label: "docs/gates/**", test: (p) => p === "docs/gates" || p.startsWith("docs/gates/") },
  {
    label: "supabase/migrations/**",
    test: (p) => p === "supabase/migrations" || p.startsWith("supabase/migrations/"),
  },
  {
    label: "package*.json",
    test: (p) => /^package(-lock)?\.json$/.test(p),
  },
];

/** PR テンプレートのチェックリスト項目。ラベルの綴りはテンプレートと一致させること。 */
export const CHECKLIST_LABELS = ["何を緩めたか", "理由", "復旧予定日", "代替の検知手段"];

/**
 * 「書いた」と認めない値。テンプレートを開いたまま出した PR を通さないための最低限。
 * 内容の妥当性は見ない（見ない、と決めたのが §16-6 の設計）。
 */
const EMPTY_VALUE_RE = /^[\s\-–—_.。、,，:：;；/|・*#>"'`(){}[\]<>]*$/u;

/** @param {string} rel */
export function isGuardedPath(rel) {
  const p = String(rel).trim().replace(/^\.\//, "");
  if (p === "") return null;
  for (const pattern of GUARDED_PATTERNS) {
    if (pattern.test(p)) return pattern.label;
  }
  return null;
}

/** HTML コメントは記入欄ではないので先に落とす（テンプレートの説明文が「記入済み」に見えないように）。 */
function stripHtmlComments(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * PR 本文からチェックリストの 4 項目を読む。
 *
 * 受け付ける書き方（テンプレートが出す形と、人が手で崩しがちな形）:
 *   - 何を緩めたか: xxx
 *   - **何を緩めたか**: xxx
 *   * 何を緩めたか ： xxx
 *   何を緩めたか: xxx
 *   - [x] 何を緩めたか: xxx
 *
 * @param {string} body
 * @returns {{values: Record<string, string>, missing: string[], filled: string[]}}
 */
export function parseChecklist(body) {
  const text = stripHtmlComments(body ?? "");
  /** @type {Record<string, string>} */
  const values = {};
  for (const label of CHECKLIST_LABELS) {
    // 行頭の箇条書き記号・チェックボックス・強調記号を許し、ラベル直後の「:」「：」を要求する。
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      String.raw`^[ \t]*(?:[-*+][ \t]*)?(?:\[[ xX]\][ \t]*)?\*{0,2}[ \t]*${escaped}[ \t]*\*{0,2}[ \t]*[:：][ \t]*(.*)$`,
      "mu",
    );
    const m = re.exec(text);
    values[label] = m ? m[1].trim() : "";
  }
  const missing = CHECKLIST_LABELS.filter((l) => EMPTY_VALUE_RE.test(values[l]));
  const filled = CHECKLIST_LABELS.filter((l) => !missing.includes(l));
  return { values, missing, filled };
}

/**
 * @param {{body: string, changedFiles: string[]}} input
 * @returns {{status: "ok"|"violation"|"input-error", guarded: {path: string, label: string}[], missing: string[], notes: string[], violations: string[]}}
 */
export function evaluate(input) {
  const notes = [];
  const violations = [];
  const files = (input.changedFiles ?? []).map((f) => String(f).trim()).filter((f) => f !== "");

  // 変更ファイルが 1 件も渡ってこない PR は存在しない。空で通すと、入力の配線が
  // 壊れた瞬間にこのゲートが恒久的に緑になる（R-TH-01 と同じ壊れ方）。
  if (files.length === 0) {
    return {
      status: "input-error",
      guarded: [],
      missing: [],
      notes: [],
      violations: [
        "変更ファイルの一覧が空です。PR に変更が無いのではなく、入力（--changed-file / PR_CHANGED_FILES）の配線が壊れている可能性が高いので、緑にしません",
      ],
    };
  }

  const guarded = [];
  for (const f of files) {
    const label = isGuardedPath(f);
    if (label !== null) guarded.push({ path: f, label });
  }

  notes.push(`変更 ${files.length} ファイル、うち保護対象 ${guarded.length} ファイル`);

  if (guarded.length === 0) {
    notes.push("保護対象の差分が無いため、ゲート緩和チェックリストの記入は求めません");
    return { status: "ok", guarded, missing: [], notes, violations };
  }

  const { missing, filled } = parseChecklist(input.body ?? "");
  notes.push(`チェックリスト記入済み ${filled.length}/${CHECKLIST_LABELS.length} 項目`);

  if (missing.length > 0) {
    const shown = [...new Set(guarded.map((g) => g.label))].join(" / ");
    violations.push(
      `保護対象（${shown}）に差分がありますが、PR 本文のゲート緩和チェックリストが未記入です: ${missing.join(" / ")}`,
    );
    violations.push(
      ".github/PULL_REQUEST_TEMPLATE.md の「ゲート緩和チェックリスト」の 4 項目すべてに 1 文字以上を書いてください（記入内容は検証しません。緩和の事実を残すための記録です）。緩めていないなら「緩めていない」と書いてください",
    );
    return { status: "violation", guarded, missing, notes, violations };
  }

  return { status: "ok", guarded, missing, notes, violations };
}

// ---------------------------------------------------------------------- CLI --

function usage(message) {
  process.stderr.write(`check-pr-checklist: ${message}\n`);
  process.stderr.write(
    "Usage: node scripts/ci/check-pr-checklist.mjs [--body-file <path>] [--body <text>] [--changed-file <path>] [--changed <csv>] [--json]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = { bodyFile: "", body: null, changedFile: "", changed: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--body-file":
        if (next === undefined) usage("--body-file requires a value");
        out.bodyFile = next;
        i += 1;
        break;
      case "--body":
        if (next === undefined) usage("--body requires a value");
        out.body = next;
        i += 1;
        break;
      case "--changed-file":
        if (next === undefined) usage("--changed-file requires a value");
        out.changedFile = next;
        i += 1;
        break;
      case "--changed":
        if (next === undefined) usage("--changed requires a value");
        out.changed = next;
        i += 1;
        break;
      case "--json":
        out.json = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(
          "Usage: node scripts/ci/check-pr-checklist.mjs [--body-file <path>] [--body <text>] [--changed-file <path>] [--changed <csv>] [--json]\n",
        );
        process.exit(0);
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function readSource(explicit, file, envName) {
  if (explicit !== null && explicit !== undefined) return explicit;
  if (file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (e) {
      usage(`読めません: ${file}（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  const fromEnv = process.env[envName];
  if (typeof fromEnv === "string") return fromEnv;
  return null;
}

// import されたとき（ユニットテスト）に CLI が走り出さないようにする。
// 判定の書き方は scripts/gate-integrity.mjs と揃えている。
const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));

  const body = readSource(args.body, args.bodyFile, "PR_BODY");
  if (body === null) {
    usage("PR 本文がありません（--body / --body-file / 環境変数 PR_BODY のいずれかを渡してください）");
  }

  const changedRaw = readSource(args.changed, args.changedFile, "PR_CHANGED_FILES");
  if (changedRaw === null) {
    usage(
      "変更ファイル一覧がありません（--changed / --changed-file / 環境変数 PR_CHANGED_FILES のいずれかを渡してください）",
    );
  }
  const changedFiles = String(changedRaw)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");

  const result = evaluate({ body, changedFiles });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const n of result.notes) process.stdout.write(`      ${n}\n`);
    for (const g of result.guarded) process.stdout.write(`      保護対象: ${g.path}（${g.label}）\n`);
    for (const v of result.violations) process.stdout.write(`test-tamper-guard FAIL ${v}\n`);
    process.stdout.write(
      `\ntest-tamper-guard — 保護対象 ${result.guarded.length} 件、違反 ${result.violations.length} 件\n`,
    );
  }

  process.exit(result.status === "ok" ? 0 : 1);
}
