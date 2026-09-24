#!/usr/bin/env node
// scripts/record-evidence.mjs — docs/acceptance-checks.json の evidence を「検証コマンドの実行結果から機械的に」書く唯一の経路。
//
// docs/implementation-plan.md §15-1 / G9（evidence.commit === HEAD）/ R-TH-02。
// evidence は Edit / Write（scripts/deny-test-weakening.sh）からも Bash のリダイレクト（scripts/deny-dangerous-bash.sh、
// docs/acceptance-checks.json は保護対象）からも書けない。run-log に対する scripts/record-run.sh と同じ位置づけで、
// このスクリプトだけが evidence を書く。書くのは「今の HEAD で、この check の verification_method を実際に走らせた結果」
// であり、成功も失敗もそのまま残す（失敗を evidence にしないと「evidence が無い = まだ走らせていない」と
// 区別できなくなる）。
//
// 使い方:
//   node scripts/record-evidence.mjs --check <id> [--check <id> ...]     指定した check を実行して記録
//   node scripts/record-evidence.mjs --task <task_id>                    その task の acceptance_check_ids を全件
//   node scripts/record-evidence.mjs --all-automated                     manual_or_automated=automated の全件
//   node scripts/record-evidence.mjs --check <id> --manual --by <人名> --note "<観察結果>"
//                                                                        manual の check を人手確認として記録（by は必須）
//   共通: [--dry-run] [--require-clean] [--file <acceptance-checks.json>] [--package-json <path>] [--task-list <path>]
//
// 判定:
//   * verification_method から `npm run <script>` を取り出す（assert-acceptance.mjs の G3 と同じ読み方）。
//     取り出せない・package.json に無い場合は記録せず違反として数える（捏造した command を残さない）。
//   * `npm run <script>` はシェルを介さず spawnSync で実行する（引数・パイプの注入を受けない）。
//   * 記録項目: commit（HEAD 全桁）/ ran_at / by / command / exit_code / duration_ms / dirty_files（git status --porcelain の
//     行数。プレモータム P-04: 汚れた作業ツリーでの結果を後から見分けるため）/ output_sha256 / output_tail（末尾 400 字、
//     秘密値らしきトークンはマスク）。
//   * --require-clean: dirty_files > 0 なら何も実行せず exit 4。最終 HEAD での一括記録に使う。
//
// 終了コード: 0 = 全件 exit 0 で記録 / 1 = 記録したが exit≠0 の check あり / 2 = 記録できない check あり（違反）/
//             3 = usage / 4 = --require-clean で作業ツリーが汚れている

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, "..");

function usage(msg) {
  if (msg) process.stderr.write(`record-evidence: ${msg}\n`);
  process.stderr.write(
    "Usage: node scripts/record-evidence.mjs (--check <id> [--check <id>...] | --task <task_id> | --all-automated)\n" +
      "       [--manual --by <name> --note <text>] [--dry-run] [--require-clean]\n" +
      "       [--file <acceptance-checks.json>] [--package-json <path>] [--task-list <path>]\n",
  );
  process.exit(3);
}

function parseArgs(argv) {
  const o = { checks: [], task: null, allAutomated: false, manual: false, by: null, note: null, dryRun: false, requireClean: false, file: null, pkg: null, taskList: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) usage(`${a} には値が要ります`); return v; };
    if (a === "--check") o.checks.push(next());
    else if (a === "--task") o.task = next();
    else if (a === "--all-automated") o.allAutomated = true;
    else if (a === "--manual") o.manual = true;
    else if (a === "--by") o.by = next();
    else if (a === "--note") o.note = next();
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--require-clean") o.requireClean = true;
    else if (a === "--file") o.file = next();
    else if (a === "--package-json") o.pkg = next();
    else if (a === "--task-list") o.taskList = next();
    else if (a === "-h" || a === "--help") usage();
    else usage(`unknown argument: ${a}`);
  }
  return o;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function git(args) {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

/** verification_method から `npm run <script>` の script 名を取り出す。無ければ null。 */
export function scriptNameOf(method) {
  if (typeof method !== "string") return null;
  const m = /npm run ([A-Za-z0-9][A-Za-z0-9:_.-]*)/.exec(method);
  return m ? m[1] : null;
}

/** 秘密値らしきトークンを出力から落とす（evidence は docs に残るため）。 */
export function maskSecrets(text) {
  return String(text)
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, "$1_$2_***")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._-]{12,}/gi, "$1 ***")
    .replace(/\b([A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PEPPER|KEY)[A-Z0-9_]*)=([^\s"']+)/g, "$1=***")
    .replace(/postgres(ql)?:\/\/([^:\s]+):([^@\s]+)@/g, "postgres$1://$2:***@");
}

function dirtyFileCount() {
  const out = spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" });
  if (out.status !== 0) return -1;
  return out.stdout.split("\n").filter((l) => l.trim().length > 0).length;
}

function runNpmScript(name, cwd) {
  const started = Date.now();
  // シェルを介さない。`npm run <name>` の name は package.json に実在することを呼び出し側で確認済み。
  // cwd は読んだ package.json のディレクトリ（既定はリポジトリ直下。テストではフィクスチャの場所）。
  const r = spawnSync("npm", ["run", "--silent", name], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: process.env.CI ?? "1", FORCE_COLOR: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return {
    exit_code: r.status === null ? -1 : r.status,
    duration_ms: Date.now() - started,
    output,
    error: r.error ? String(r.error) : null,
  };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const file = o.file ? path.resolve(o.file) : path.join(REPO, "docs", "acceptance-checks.json");
  const pkgPath = o.pkg ? path.resolve(o.pkg) : path.join(REPO, "package.json");
  const taskListPath = o.taskList ? path.resolve(o.taskList) : path.join(REPO, "docs", "task-list.json");

  const doc = readJson(file);
  if (!doc || !Array.isArray(doc.checks)) usage(`${file} に checks[] がありません`);
  const pkg = readJson(pkgPath);
  const scripts = (pkg && typeof pkg.scripts === "object" && pkg.scripts) || {};

  let targets = [];
  if (o.checks.length) targets = o.checks;
  else if (o.task) {
    const tl = readJson(taskListPath);
    const t = (tl.tasks || []).find((x) => x.task_id === o.task);
    if (!t) usage(`task ${o.task} が ${taskListPath} にありません`);
    targets = t.acceptance_check_ids || [];
  } else if (o.allAutomated) {
    targets = doc.checks.filter((c) => c.manual_or_automated === "automated").map((c) => c.id);
  } else usage("--check / --task / --all-automated のいずれかが要ります");
  if (o.manual && (targets.length !== 1 || !o.by || !o.note)) usage("--manual は --check 1 件と --by と --note が必須です");

  const head = git(["rev-parse", "HEAD"]).trim();
  const dirty = dirtyFileCount();
  if (o.requireClean && dirty !== 0) {
    process.stderr.write(`record-evidence: 作業ツリーが汚れています（${dirty} 件）。--require-clean のため何も記録しません\n`);
    process.exit(4);
  }

  const byId = new Map(doc.checks.map((c) => [c.id, c]));
  const scriptRuns = new Map();
  let violations = 0;
  let failed = 0;
  let recorded = 0;
  for (const id of targets) {
    const c = byId.get(id);
    if (!c) { process.stderr.write(`record-evidence: ${id} は存在しません\n`); violations += 1; continue; }
    const ran_at = new Date().toISOString();
    if (o.manual) {
      if (c.manual_or_automated !== "manual") { process.stderr.write(`record-evidence: ${id} は automated です。--manual では記録できません\n`); violations += 1; continue; }
      const ev = { kind: "manual", commit: head, ran_at, by: o.by, note: maskSecrets(o.note), dirty_files: dirty };
      process.stdout.write(`${id}: manual by ${o.by}${o.dryRun ? "（dry-run）" : ""}\n`);
      if (!o.dryRun) c.evidence = ev;
      recorded += 1;
      continue;
    }
    if (c.manual_or_automated !== "automated") { process.stderr.write(`record-evidence: ${id} は manual です。--manual --by --note で記録してください\n`); violations += 1; continue; }
    const name = scriptNameOf(c.verification_method);
    if (!name) { process.stderr.write(`record-evidence: ${id} の verification_method から npm run <script> を読み取れません: ${c.verification_method}\n`); violations += 1; continue; }
    if (!(name in scripts)) { process.stderr.write(`record-evidence: ${id} の npm script "${name}" が ${pkgPath} にありません（記録しない）\n`); violations += 1; continue; }
    if (o.dryRun) { process.stdout.write(`${id}: npm run ${name}（dry-run）\n`); continue; }
    // 同じ HEAD・同じ script の結果は 1 回の実行を共有する（133 件の check が十数種の script を参照
    // するため、毎回走らせると test:unit だけで 1 時間以上かかる）。共有した事実は shared_with に残す。
    let r = scriptRuns.get(name);
    if (r) {
      process.stdout.write(`${id}: npm run ${name}（同一 HEAD での ${r.first_check} の実行結果を共有）\n`);
    } else {
      process.stdout.write(`${id}: npm run ${name} …`);
      r = { ...runNpmScript(name, path.dirname(pkgPath)), first_check: id };
      scriptRuns.set(name, r);
      process.stdout.write(` exit ${r.exit_code}（${r.duration_ms} ms）\n`);
    }
    const masked = maskSecrets(r.output);
    const ev = {
      kind: "automated",
      commit: head,
      ran_at,
      by: "scripts/record-evidence.mjs",
      command: `npm run ${name}`,
      exit_code: r.exit_code,
      duration_ms: r.duration_ms,
      dirty_files: dirty,
      output_sha256: crypto.createHash("sha256").update(r.output).digest("hex"),
      output_tail: masked.slice(-400),
    };
    if (r.error) ev.spawn_error = r.error;
    if (r.first_check !== id) ev.shared_with = r.first_check;
    c.evidence = ev;
    recorded += 1;
    if (r.exit_code !== 0) failed += 1;
  }

  if (!o.dryRun && recorded > 0) {
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`record-evidence — 記録 ${recorded} / 失敗 ${failed} / 違反 ${violations}（HEAD=${head.slice(0, 12)}… dirty_files=${dirty}）\n`);
  if (violations > 0) process.exit(2);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
