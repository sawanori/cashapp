#!/usr/bin/env node
// scripts/validate-findings.mjs
//
// 敵対レビューの返信封筒（FINDINGS）に対する機械強制。
// docs/implementation-plan.md §16-5 / task_007 / check_066 / R-TH-08 / R-TH-11。
//
// 規律ではなく機械で守るのは 3 点である。
//
//   1. **repro の無い high は high として通らない**（R-TH-08）。
//      diff しか見ていないレビュアは「別ファイルで担保済み」の事項を high で指摘する。
//      具体的な入力列（repro）を書けない指摘は info へ落とし、task-loop を回さない。
//   2. **`model_id_actual` / `cli_version` / `backend` を欠く返信は無効**（R-TH-11）。
//      CLI のフォールバックで別モデルが黙って答えた場合、レビューの質は落ちるのに
//      ゲートは緑になる。どのモデルが答えたか名乗らない返信は票にしない。
//      `docs/metrics/model-bench.md`（task_010）の合格モデルと照合し、外れていれば
//      `reviewer_route` を `model_mismatch` に落として票から外す。
//   3. **不達（`reviewer_route: "unavailable"`）は欠票として通すが、PASS は名乗らせない**。
//      経路が通らなかったことは事実として記録する（R-TH-03 / R-TH-13）。
//      不達が「合格」を返せてしまうと「3 ベンダー体制」という虚偽が機械的に作れる。
//
// スキーマ（封筒 1 通 = JSON オブジェクト 1 個）:
//
//   schema_version   1 固定
//   task_id          レビュー対象タスク
//   reviewer         エージェント名（例 adversarial-reviewer-gemini）
//   vendor           gemini | gpt | claude
//   reviewer_route   verified | cli-fallback | unavailable | model_mismatch
//   model_id_actual  実際に応答したモデル ID（unavailable 以外は必須）
//   cli_version      ラッパーが観測した CLI バージョン（同上）
//   backend          応答を返したバックエンド（同上）
//   ran_at           ISO8601（…Z）
//   verdict          PASS | FAIL | BLOCKED | UNKNOWN
//   findings[]       { id, severity, title, detail, repro?, citation?, file?, line?, suggested_fix? }
//   unavailable_reason / attempted_command   reviewer_route=unavailable のとき必須
//
// 使い方:
//   node scripts/validate-findings.mjs <envelope.json> [--json] [--quiet]
//                                      [--whitelist <file>] [--root <dir>]
//   node scripts/validate-findings.mjs -   # stdin から読む
//
// 終了コード: 0 = 封筒として妥当（降格があっても 0）/ 1 = 無効 / 2 = usage エラー。
// 「妥当」と「票になる」は別である。票になるかは出力の `counts_as_vote` を見る。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const SCHEMA_VERSION = 1;
export const VENDORS = ["gemini", "gpt", "claude"];
export const ROUTES = ["verified", "cli-fallback", "unavailable", "model_mismatch"];
export const VERDICTS = ["PASS", "FAIL", "BLOCKED", "UNKNOWN"];
export const SEVERITIES = ["high", "medium", "low", "info", "unknown"];

/** task_010 が書く合格モデル一覧。無ければホワイトリスト検査は「未設定」。 */
export const DEFAULT_WHITELIST_REL = "docs/metrics/model-bench.md";

const MARKER_BEGIN = "<!-- machine-readable:begin -->";
const MARKER_END = "<!-- machine-readable:end -->";
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** @param {unknown} v */
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * docs/metrics/model-bench.md から合格モデル ID を読む。
 * docs/wording-policy.md と同じ machine-readable ブロックの流儀にそろえてある。
 * @param {string} file
 * @returns {{ configured: boolean, models: string[], error: string | null }}
 */
export function readModelWhitelist(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { configured: false, models: [], error: null };
  }
  const begin = text.indexOf(MARKER_BEGIN);
  const end = text.indexOf(MARKER_END);
  if (begin === -1 || end === -1 || end < begin) {
    return { configured: false, models: [], error: `${file}: machine-readable ブロックがありません` };
  }
  const block = text.slice(begin + MARKER_BEGIN.length, end);
  const fenced = block.match(/```(?:json)?\s*([\s\S]*?)```/);
  const json = fenced ? fenced[1] : block;
  try {
    const parsed = JSON.parse(json);
    const models = Array.isArray(parsed.approved_models)
      ? parsed.approved_models.filter((m) => isNonEmptyString(m))
      : [];
    if (models.length === 0) {
      return { configured: false, models: [], error: `${file}: approved_models が空です` };
    }
    return { configured: true, models, error: null };
  } catch (e) {
    return { configured: false, models: [], error: `${file}: JSON として読めません（${String(e)}）` };
  }
}

/**
 * 封筒 1 通を検査して正規化する。
 *
 * @param {unknown} raw パース済みの封筒（JSON.parse の結果）
 * @param {{ whitelist?: { configured: boolean, models: string[], error: string | null } }} [options]
 * @returns {{
 *   valid: boolean,
 *   errors: string[],
 *   warnings: string[],
 *   counts_as_vote: boolean,
 *   reviewer_route: string,
 *   counts: Record<string, number>,
 *   downgrades: Array<{finding_id: string, from: string, to: string, reason: string}>,
 *   envelope: Record<string, unknown> | null
 * }}
 */
export function validateEnvelope(raw, options = {}) {
  const errors = [];
  const warnings = [];
  const downgrades = [];
  const counts = { high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0, downgraded: 0 };

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("封筒は JSON オブジェクトでなければなりません");
    return {
      valid: false,
      errors,
      warnings,
      counts_as_vote: false,
      reviewer_route: "invalid",
      counts,
      downgrades,
      envelope: null,
    };
  }

  /** @type {Record<string, unknown>} */
  const env = { ...raw };

  if (env.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version は ${SCHEMA_VERSION} でなければなりません（実際: ${JSON.stringify(env.schema_version)}）`);
  }
  if (!isNonEmptyString(env.task_id) || !/^[A-Za-z0-9_.-]+$/.test(String(env.task_id))) {
    errors.push("task_id が空、または使えない文字を含んでいます");
  }
  if (!isNonEmptyString(env.reviewer)) {
    errors.push("reviewer が空です");
  }
  if (!VENDORS.includes(String(env.vendor))) {
    errors.push(`vendor は ${VENDORS.join(" | ")} のいずれかでなければなりません（実際: ${JSON.stringify(env.vendor)}）`);
  }
  if (!ROUTES.includes(String(env.reviewer_route))) {
    errors.push(`reviewer_route は ${ROUTES.join(" | ")} のいずれかでなければなりません（実際: ${JSON.stringify(env.reviewer_route)}）`);
  }
  if (!VERDICTS.includes(String(env.verdict))) {
    errors.push(`verdict は ${VERDICTS.join(" | ")} のいずれかでなければなりません（実際: ${JSON.stringify(env.verdict)}）`);
  }
  if (!isNonEmptyString(env.ran_at) || !ISO_Z.test(String(env.ran_at))) {
    errors.push("ran_at が ISO8601（末尾 Z）ではありません");
  }
  if (!Array.isArray(env.findings)) {
    errors.push("findings は配列でなければなりません");
  }

  const route = String(env.reviewer_route);
  const unavailable = route === "unavailable";

  if (unavailable) {
    // 不達の封筒は「レビューが行われなかった」という記録である。
    // 行われていない以上、合否は名乗れないし finding も持てない。
    if (!isNonEmptyString(env.unavailable_reason)) {
      errors.push("reviewer_route=unavailable には unavailable_reason（不達の理由）が必要です");
    }
    if (!isNonEmptyString(env.attempted_command)) {
      errors.push("reviewer_route=unavailable には attempted_command（実際に試したコマンド）が必要です");
    }
    if (env.verdict !== "UNKNOWN") {
      errors.push(
        `reviewer_route=unavailable の verdict は UNKNOWN でなければなりません（実際: ${JSON.stringify(env.verdict)}）。不達が合否を名乗ることは許しません`,
      );
    }
    if (Array.isArray(env.findings) && env.findings.length > 0) {
      errors.push("reviewer_route=unavailable の封筒に findings を入れることはできません");
    }
  } else {
    // R-TH-11: どのモデルが答えたのか名乗らない返信は票にしない。
    for (const key of ["model_id_actual", "cli_version", "backend"]) {
      if (!isNonEmptyString(env[key])) {
        errors.push(`${key} が空です（R-TH-11: 応答したモデルを特定できない返信は無効）`);
      }
    }
  }

  const normalizedFindings = [];
  if (Array.isArray(env.findings)) {
    env.findings.forEach((f, i) => {
      const label = `findings[${i}]`;
      if (f === null || typeof f !== "object" || Array.isArray(f)) {
        errors.push(`${label} はオブジェクトでなければなりません`);
        return;
      }
      const id = isNonEmptyString(f.id) ? String(f.id) : `${label}`;
      if (!isNonEmptyString(f.id)) errors.push(`${label}.id が空です`);
      if (!isNonEmptyString(f.title)) errors.push(`${label}.title が空です`);
      if (!isNonEmptyString(f.detail)) errors.push(`${label}.detail が空です`);
      const severity = String(f.severity);
      if (!SEVERITIES.includes(severity)) {
        errors.push(`${label}.severity は ${SEVERITIES.join(" | ")} のいずれかでなければなりません（実際: ${JSON.stringify(f.severity)}）`);
        return;
      }

      let effective = severity;

      // R-TH-08: repro の無い high は high として通さない。
      if (effective === "high" && !isNonEmptyString(f.repro)) {
        downgrades.push({ finding_id: id, from: effective, to: "info", reason: "repro_missing" });
        effective = "info";
      }
      // 役割表（§16-2）: 敵対レビュー A（Gemini）は一次資料の逐語引用が仕事である。
      // 引用のない事実主張は「不明」であって指摘ではない。
      if (
        String(env.vendor) === "gemini" &&
        (effective === "high" || effective === "medium") &&
        !isNonEmptyString(f.citation)
      ) {
        downgrades.push({ finding_id: id, from: effective, to: "unknown", reason: "citation_missing" });
        effective = "unknown";
      }

      normalizedFindings.push({ ...f, effective_severity: effective });
    });
  }

  for (const f of normalizedFindings) {
    counts[f.effective_severity] += 1;
    counts.total += 1;
  }
  counts.downgraded = downgrades.length;

  // R-TH-11: 合格モデルのホワイトリストと照合する。未設定なら検査できないので
  // 「未設定」を警告として残す（task_010 が docs/metrics/model-bench.md を作る）。
  let effectiveRoute = route;
  const whitelist = options.whitelist ?? { configured: false, models: [], error: null };
  if (!unavailable && errors.length === 0) {
    if (!whitelist.configured) {
      warnings.push(
        `model_whitelist_unconfigured: 合格モデル一覧が読めないため model_id_actual=${String(env.model_id_actual)} を照合できませんでした${whitelist.error ? `（${whitelist.error}）` : "（task_010 で作成予定）"}`,
      );
    } else if (!whitelist.models.includes(String(env.model_id_actual))) {
      warnings.push(
        `model_mismatch: model_id_actual=${String(env.model_id_actual)} は合格モデル一覧（${whitelist.models.join(", ")}）にありません。このレビューは票になりません`,
      );
      effectiveRoute = "model_mismatch";
    }
  }
  if (effectiveRoute === "model_mismatch" && route !== "model_mismatch") {
    env.reviewer_route_declared = route;
  }
  env.reviewer_route = effectiveRoute;
  env.findings = normalizedFindings;

  const valid = errors.length === 0;
  const countsAsVote = valid && effectiveRoute !== "unavailable" && effectiveRoute !== "model_mismatch";

  return {
    valid,
    errors,
    warnings,
    counts_as_vote: countsAsVote,
    reviewer_route: valid ? effectiveRoute : "invalid",
    counts,
    downgrades,
    envelope: valid ? { ...env, validated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") } : env,
  };
}

/* ------------------------------ CLI ------------------------------ */

/** @param {string[]} argv */
export function parseArgs(argv) {
  const opts = { file: null, json: false, quiet: false, whitelist: null, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--whitelist") opts.whitelist = argv[++i] ?? null;
    else if (a === "--root") opts.root = argv[++i] ?? null;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option: ${a}`);
    else if (opts.file === null) opts.file = a;
    else throw new Error(`封筒は 1 通ずつ検査します（余分な引数: ${a}）`);
  }
  return opts;
}

const USAGE = `Usage:
  node scripts/validate-findings.mjs <envelope.json> [--json] [--quiet] [--whitelist <file>] [--root <dir>]
  node scripts/validate-findings.mjs -   # stdin から読む

終了コード: 0 = 妥当 / 1 = 無効 / 2 = usage エラー`;

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`validate-findings: ${String(e instanceof Error ? e.message : e)}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help || opts.file === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  let text;
  try {
    text = opts.file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(opts.file, "utf8");
  } catch (e) {
    process.stderr.write(`validate-findings: 封筒を読めません: ${String(e instanceof Error ? e.message : e)}\n`);
    return 2;
  }

  const root = opts.root ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const whitelistPath = opts.whitelist ?? path.join(root, DEFAULT_WHITELIST_REL);

  let parsed;
  let report;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    report = {
      valid: false,
      errors: [`封筒が JSON として読めません: ${String(e instanceof Error ? e.message : e)}`],
      warnings: [],
      counts_as_vote: false,
      reviewer_route: "invalid",
      counts: { high: 0, medium: 0, low: 0, info: 0, unknown: 0, total: 0, downgraded: 0 },
      downgrades: [],
      envelope: null,
    };
  }
  if (!report) {
    report = validateEnvelope(parsed, { whitelist: readModelWhitelist(whitelistPath) });
  }
  report.source_file = opts.file;

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (!opts.quiet) {
    const head = report.valid ? "valid" : "INVALID";
    process.stdout.write(
      `validate-findings: ${head} route=${report.reviewer_route} vote=${report.counts_as_vote} high=${report.counts.high} 降格=${report.counts.downgraded}\n`,
    );
    for (const e of report.errors) process.stdout.write(`  error: ${e}\n`);
    for (const w of report.warnings) process.stdout.write(`  warn : ${w}\n`);
    for (const d of report.downgrades) {
      process.stdout.write(`  降格 : ${d.finding_id} ${d.from} → ${d.to}（${d.reason}）\n`);
    }
  }

  return report.valid ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const selfPath = path.resolve(new URL(import.meta.url).pathname);
if (invokedPath === selfPath) {
  process.exit(main(process.argv.slice(2)));
}
