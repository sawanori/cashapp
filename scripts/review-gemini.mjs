#!/usr/bin/env node
// scripts/review-gemini.mjs
//
// 敵対レビュー A（規約・一次資料）への Bash ラッパー。
// docs/implementation-plan.md §16-2 / §16-5 / task_007 / R-TH-11。
//
// `.claude/workflows` から到達できるのは Claude ティアのモデルだけなので、Gemini へは
// CLI をラップして到達する。ラッパーの仕事はレビューそのものではなく、**返信に
// 「誰が答えたか」を機械で観測して貼ること**である（R-TH-11）。
//
//   * `gemini -o json` の `stats.models` から、`roles.main` を持つモデル ID を読む。
//     これは自己申告ではなく CLI が出す実測値である。指定と一致すれば
//     `reviewer_route: "verified"`、違えば `"cli-fallback"` として差分を残す。
//   * モデル ID を観測できなかった場合は成功にしない。`unavailable` を返す。
//     「答えたのが誰か分からないレビュー」は票にしないのが R-TH-11 の趣旨である。
//   * CLI の警告（非推奨通知・フォールバック通知）は捨てずに `raw_warnings` に転記する。
//
// 使い方:
//   node scripts/review-gemini.mjs --packet <packet.json|-> [--model <id>]
//        [--out <file>] [--timeout-ms <n>] [--cli <path>]
//
// 終了コード: 0 = レビューが成立した / 3 = 不達（unavailable 封筒を出した）/ 2 = usage。
// どちらの場合も封筒は必ず出す。判定は scripts/merge-review.sh が行う。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_MODEL = "gemini-2.5-pro";
const DEFAULT_TIMEOUT_MS = 600000;
const VENDOR = "gemini";
const REVIEWER = "adversarial-reviewer-gemini";

const INSTRUCTION = [
  "あなたは決済台帳アプリの敵対的レビュアです。役割は「規約・一次資料に照らした反証」であり、実装の改善提案ではありません。",
  "直前の stdin に review-packet（JSON）が入っています。artifact.diff と artifact.files（diff が触れたファイル全文と import 先）だけを根拠にしてください。",
  "",
  "出力は JSON オブジェクト 1 個のみ。前後に説明文・Markdown コードフェンスを付けないでください。形式:",
  '{"verdict":"PASS|FAIL|BLOCKED|UNKNOWN","findings":[{"id":"F-1","severity":"high|medium|low|info|unknown","title":"...","detail":"...","file":"...","line":1,"repro":"...","citation":"...","suggested_fix":"..."}]}',
  "",
  "規則:",
  "- severity=high には repro（再現する具体的な入力列）が必須。repro を書けないなら high にしない（repro の無い high は機械的に info へ降格されます）。",
  "- high / medium には citation（一次資料の逐語引用 + URL + 取得日）が必須。引用を出せない事実主張は severity を unknown にしてください。",
  "- packet に含まれていないコードについて指摘しないでください。担保箇所が同梱ファイルにあるなら指摘しないでください。",
  "- 指摘が無ければ findings を空配列にして verdict を PASS にしてください。",
].join("\n");

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = {
    packet: null,
    model: DEFAULT_MODEL,
    out: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cli: "gemini",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--packet") opts.packet = argv[++i] ?? null;
    else if (a === "--model") opts.model = argv[++i] ?? DEFAULT_MODEL;
    else if (a === "--out") opts.out = argv[++i] ?? null;
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a === "--cli") opts.cli = argv[++i] ?? "gemini";
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const USAGE = `Usage:
  node scripts/review-gemini.mjs --packet <packet.json|-> [--model <id>] [--out <file>] [--timeout-ms <n>] [--cli <path>]

終了コード: 0 = レビュー成立 / 3 = 不達（unavailable 封筒）/ 2 = usage`;

function nowZ() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** CLI のバージョンを観測する。取れなければ "unknown"。 */
function cliVersion(cli) {
  const r = spawnSync(cli, ["--version"], { encoding: "utf8" });
  if (r.error || typeof r.stdout !== "string") return "unknown";
  return r.stdout.trim().split("\n")[0] || "unknown";
}

/**
 * stderr から意味のある警告だけを拾う。skills の衝突通知などの常時ノイズは落とす。
 * @param {string} stderr
 */
function collectWarnings(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return [];
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const interesting = lines.filter((l) => /deprecat|fallback|antigravity|quota|rate.?limit|model/i.test(l));
  const capped = interesting.slice(0, 20);
  if (interesting.length > capped.length) {
    capped.push(`（他 ${interesting.length - capped.length} 行は省略）`);
  }
  return capped;
}

/** `stats.models` から roles.main を持つモデル ID を取り出す（実測値）。 */
export function observedModelId(stats) {
  if (!stats || typeof stats !== "object" || !stats.models || typeof stats.models !== "object") {
    return null;
  }
  const entries = Object.entries(stats.models);
  const main = entries.find(([, v]) => v && typeof v === "object" && v.roles && v.roles.main);
  if (main) return main[0];
  if (entries.length === 1) return entries[0][0];
  return null;
}

/** モデルの返信本文から JSON オブジェクトを取り出す。```json フェンスは剥がす。 */
export function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1].trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function unavailableEnvelope({ taskId, reason, command, warnings, commit }) {
  return {
    schema_version: 1,
    task_id: taskId,
    reviewer: REVIEWER,
    vendor: VENDOR,
    reviewer_route: "unavailable",
    model_id_requested: null,
    ran_at: nowZ(),
    commit,
    verdict: "UNKNOWN",
    findings: [],
    unavailable_reason: reason,
    attempted_command: command,
    raw_warnings: warnings ?? [],
  };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`review-gemini: ${String(e instanceof Error ? e.message : e)}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help || !opts.packet || !Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  let packetText;
  try {
    packetText = opts.packet === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(opts.packet, "utf8");
  } catch (e) {
    process.stderr.write(`review-gemini: packet を読めません: ${String(e instanceof Error ? e.message : e)}\n`);
    return 2;
  }
  let packet;
  try {
    packet = JSON.parse(packetText);
  } catch (e) {
    process.stderr.write(`review-gemini: packet が JSON ではありません: ${String(e instanceof Error ? e.message : e)}\n`);
    return 2;
  }
  const taskId = typeof packet.task_id === "string" ? packet.task_id : "unknown";
  const commit = typeof packet.commit === "string" ? packet.commit : "unknown";

  const args = ["-o", "json", "-m", opts.model, "-p", INSTRUCTION];
  const commandStr = `${opts.cli} -o json -m ${opts.model} -p <instruction>  # packet on stdin`;

  const run = spawnSync(opts.cli, args, {
    input: packetText,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  const warnings = collectWarnings(run.stderr);

  let envelope;
  let exitCode;

  if (run.error) {
    const reason =
      run.error.code === "ENOENT"
        ? `gemini CLI が見つかりません（${opts.cli}）`
        : run.error.code === "ETIMEDOUT"
          ? `gemini CLI が ${opts.timeoutMs}ms で応答しませんでした`
          : `gemini CLI の起動に失敗しました: ${String(run.error.message)}`;
    envelope = unavailableEnvelope({ taskId, reason, command: commandStr, warnings, commit });
    exitCode = 3;
  } else if (run.status !== 0) {
    envelope = unavailableEnvelope({
      taskId,
      reason: `gemini CLI が exit ${run.status} で終了しました: ${String(run.stderr ?? "").slice(-500)}`,
      command: commandStr,
      warnings,
      commit,
    });
    exitCode = 3;
  } else {
    let cliJson = null;
    try {
      cliJson = JSON.parse(run.stdout);
    } catch {
      cliJson = null;
    }
    const modelIdActual = cliJson ? observedModelId(cliJson.stats) : null;
    const reply = cliJson && typeof cliJson.response === "string" ? extractJsonObject(cliJson.response) : null;

    if (!cliJson) {
      envelope = unavailableEnvelope({
        taskId,
        reason: "gemini CLI の -o json 出力を JSON として読めませんでした",
        command: commandStr,
        warnings,
        commit,
      });
      exitCode = 3;
    } else if (!modelIdActual) {
      // R-TH-11: 誰が答えたか観測できないレビューは成立させない。
      envelope = unavailableEnvelope({
        taskId,
        reason: "stats.models から応答モデル（roles.main）を観測できませんでした。model_id_actual を名乗れないレビューは票にしません（R-TH-11）",
        command: commandStr,
        warnings,
        commit,
      });
      exitCode = 3;
    } else if (!reply || !Array.isArray(reply.findings)) {
      envelope = unavailableEnvelope({
        taskId,
        reason: `応答から findings を含む JSON を取り出せませんでした（先頭 300 字: ${String(cliJson.response ?? "").slice(0, 300)}）`,
        command: commandStr,
        warnings,
        commit,
      });
      exitCode = 3;
    } else {
      const backend = warnings.some((w) => /antigravity/i.test(w)) ? "antigravity" : "gemini-cli";
      envelope = {
        schema_version: 1,
        task_id: taskId,
        reviewer: REVIEWER,
        vendor: VENDOR,
        reviewer_route: modelIdActual === opts.model ? "verified" : "cli-fallback",
        model_id_requested: opts.model,
        model_id_actual: modelIdActual,
        model_id_source: "cli_stats",
        cli_version: cliVersion(opts.cli),
        backend,
        ran_at: nowZ(),
        commit,
        verdict: typeof reply.verdict === "string" ? reply.verdict : "UNKNOWN",
        findings: reply.findings,
        raw_warnings: warnings,
        packet_bytes: packetText.length,
      };
      exitCode = 0;
    }
  }

  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, text, "utf8");
    process.stderr.write(
      `review-gemini: route=${envelope.reviewer_route} model=${envelope.model_id_actual ?? "-"} → ${opts.out}\n`,
    );
  } else {
    process.stdout.write(text);
  }
  return exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const selfPath = path.resolve(new URL(import.meta.url).pathname);
if (invokedPath === selfPath) {
  process.exit(main(process.argv.slice(2)));
}
