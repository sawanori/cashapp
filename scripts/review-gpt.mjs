#!/usr/bin/env node
// scripts/review-gpt.mjs
//
// 敵対レビュー B（反例提示）への Bash ラッパー。
// docs/implementation-plan.md §16-2 / §16-5 / task_007 / R-TH-03 / R-TH-06 / R-TH-11。
//
// 本経路は現時点で通らない。`~/.codex/hooks/block-non-claude-model.sh` が
// UserPromptSubmit で非 Claude モデルのプロンプトを遮断するため、`codex exec` は
// **exit 0 のまま、エージェントの応答を 1 件も返さずに終わる**（本タスクで実測）。
// 終了コードだけを見ると成功に見えるのが、この経路のいちばん危ないところである。
//
// したがってこのラッパーの中心的な仕事は「成功を偽装しないこと」である。
//
//   * `--output-last-message` に最後のエージェント応答を書かせ、**その中身が
//     取れたときだけ**レビュー成立とみなす。exit 0 は成立の根拠にしない。
//   * 応答が空・CLI 不在・タイムアウト・JSON を取り出せない、のいずれでも
//     `reviewer_route: "unavailable"` の欠票封筒を返し、`attempted_command` と
//     `unavailable_reason` を必ず埋める（R-TH-03 / R-TH-13 の「欠票の事実を残す」）。
//   * codex 0.154.0 の `--json` イベント（thread.started / turn.started /
//     item.completed / turn.completed）には応答モデル ID が含まれない [実測]。
//     よって model_id_actual は観測できず、返信本文の自己申告しか根拠が無い。
//     自己申告しか無い場合は `reviewer_route: "cli-fallback"` とし
//     `model_id_source: "self_report"` を付けて、verified と区別する（R-TH-11）。
//
// 使い方:
//   node scripts/review-gpt.mjs --packet <packet.json|-> [--model <id>]
//        [--out <file>] [--timeout-ms <n>] [--cli <path>]
//
// 終了コード: 0 = レビューが成立した / 3 = 不達（unavailable 封筒を出した）/ 2 = usage。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_MODEL = "gpt-6-astra";
const DEFAULT_TIMEOUT_MS = 600000;
const VENDOR = "gpt";
const REVIEWER = "adversarial-reviewer-gpt";

const INSTRUCTION = [
  "あなたは決済台帳アプリの敵対的レビュアです。役割は「反例提示」であり、実装の改善提案ではありません。",
  "以下の review-packet（JSON）の artifact.diff と artifact.files だけを根拠にしてください。",
  "",
  "出力は JSON オブジェクト 1 個のみ。前後に説明文・Markdown コードフェンスを付けないでください。形式:",
  '{"model_id_actual":"<あなたが実際に動いているモデル ID>","verdict":"PASS|FAIL|BLOCKED|UNKNOWN","findings":[{"id":"F-1","severity":"high|medium|low|info|unknown","title":"...","detail":"...","file":"...","line":1,"repro":"...","suggested_fix":"..."}]}',
  "",
  "規則:",
  "- severity=high には repro（再現する具体的な入力列）が必須。repro を書けないなら severity は info にしてください（repro の無い high は機械的に info へ降格されます）。",
  "- packet に含まれていないコードについて指摘しないでください。担保箇所が同梱ファイルにあるなら指摘しないでください。",
  "- 指摘が無ければ findings を空配列にして verdict を PASS にしてください。",
  "",
  "review-packet:",
].join("\n");

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = {
    packet: null,
    model: DEFAULT_MODEL,
    out: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    cli: "codex",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--packet") opts.packet = argv[++i] ?? null;
    else if (a === "--model") opts.model = argv[++i] ?? DEFAULT_MODEL;
    else if (a === "--out") opts.out = argv[++i] ?? null;
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a === "--cli") opts.cli = argv[++i] ?? "codex";
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const USAGE = `Usage:
  node scripts/review-gpt.mjs --packet <packet.json|-> [--model <id>] [--out <file>] [--timeout-ms <n>] [--cli <path>]

終了コード: 0 = レビュー成立 / 3 = 不達（unavailable 封筒）/ 2 = usage`;

function nowZ() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function cliVersion(cli) {
  const r = spawnSync(cli, ["--version"], { encoding: "utf8" });
  if (r.error || typeof r.stdout !== "string") return "unknown";
  return r.stdout.trim().split("\n")[0] || "unknown";
}

/** JSONL イベント列から、診断に使える要約を作る。 */
export function summarizeEvents(stdout) {
  const types = [];
  const errors = [];
  if (typeof stdout !== "string") return { types, errors };
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (typeof ev.type === "string") types.push(ev.type);
    if (ev.item && ev.item.type === "error" && typeof ev.item.message === "string") {
      errors.push(ev.item.message);
    }
  }
  return { types, errors };
}

/** 返信本文から JSON オブジェクトを取り出す。```json フェンスは剥がす。 */
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

function unavailableEnvelope({ taskId, reason, command, commit, diagnostics }) {
  return {
    schema_version: 1,
    task_id: taskId,
    reviewer: REVIEWER,
    vendor: VENDOR,
    reviewer_route: "unavailable",
    model_id_requested: DEFAULT_MODEL,
    ran_at: nowZ(),
    commit,
    verdict: "UNKNOWN",
    findings: [],
    unavailable_reason: reason,
    attempted_command: command,
    diagnostics: diagnostics ?? {},
  };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`review-gpt: ${String(e instanceof Error ? e.message : e)}\n${USAGE}\n`);
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
    process.stderr.write(`review-gpt: packet を読めません: ${String(e instanceof Error ? e.message : e)}\n`);
    return 2;
  }
  let packet;
  try {
    packet = JSON.parse(packetText);
  } catch (e) {
    process.stderr.write(`review-gpt: packet が JSON ではありません: ${String(e instanceof Error ? e.message : e)}\n`);
    return 2;
  }
  const taskId = typeof packet.task_id === "string" ? packet.task_id : "unknown";
  const commit = typeof packet.commit === "string" ? packet.commit : "unknown";

  const lastMessageFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "review-gpt-")),
    "last-message.txt",
  );
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-m",
    opts.model,
    "--output-last-message",
    lastMessageFile,
    "-",
  ];
  const commandStr = `${opts.cli} exec --json --skip-git-repo-check -s read-only -m ${opts.model} --output-last-message <tmp> -  # instruction + packet on stdin`;

  const run = spawnSync(opts.cli, args, {
    input: `${INSTRUCTION}\n${packetText}\n`,
    encoding: "utf8",
    timeout: opts.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  const events = summarizeEvents(run.stdout);
  let lastMessage = "";
  try {
    lastMessage = fs.readFileSync(lastMessageFile, "utf8");
  } catch {
    lastMessage = "";
  }
  const diagnostics = {
    exit_code: run.status,
    event_types: events.types,
    cli_errors: events.errors,
    last_message_bytes: lastMessage.length,
    stderr_tail: String(run.stderr ?? "").slice(-1000),
  };

  let envelope;
  let exitCode;

  if (run.error) {
    const reason =
      run.error.code === "ENOENT"
        ? `codex CLI が見つかりません（${opts.cli}）`
        : run.error.code === "ETIMEDOUT"
          ? `codex CLI が ${opts.timeoutMs}ms で応答しませんでした`
          : `codex CLI の起動に失敗しました: ${String(run.error.message)}`;
    envelope = unavailableEnvelope({ taskId, reason, command: commandStr, commit, diagnostics });
    exitCode = 3;
  } else if (lastMessage.trim().length === 0) {
    // ここが本経路の主症状である。exit 0 でもエージェント応答が 1 件も無い。
    // 終了コードを成功の根拠にしない（R-TH-06: 静かな不達を成功と書かない）。
    envelope = unavailableEnvelope({
      taskId,
      reason:
        `codex exec はエージェントの応答を返しませんでした（exit ${run.status}、イベント: ${events.types.join(", ") || "なし"}）。` +
        "~/.codex/hooks/block-non-claude-model.sh が UserPromptSubmit で非 Claude モデルのプロンプトを遮断している状態と一致します（R-TH-03）。" +
        "解除は PO 承認事項（task_010）。",
      command: commandStr,
      commit,
      diagnostics,
    });
    exitCode = 3;
  } else {
    const reply = extractJsonObject(lastMessage);
    if (!reply || !Array.isArray(reply.findings)) {
      envelope = unavailableEnvelope({
        taskId,
        reason: `応答から findings を含む JSON を取り出せませんでした（先頭 300 字: ${lastMessage.slice(0, 300)}）`,
        command: commandStr,
        commit,
        diagnostics,
      });
      exitCode = 3;
    } else if (typeof reply.model_id_actual !== "string" || reply.model_id_actual.trim().length === 0) {
      // codex 0.154.0 の JSONL には応答モデル ID が無い [実測]。自己申告すら無ければ
      // model_id_actual を埋められないので、成立させない（R-TH-11）。
      envelope = unavailableEnvelope({
        taskId,
        reason:
          "応答に model_id_actual がありません。codex の JSONL イベントには応答モデル ID が含まれない [実測] ため、" +
          "自己申告が無いと誰が答えたか特定できません（R-TH-11）",
        command: commandStr,
        commit,
        diagnostics,
      });
      exitCode = 3;
    } else {
      envelope = {
        schema_version: 1,
        task_id: taskId,
        reviewer: REVIEWER,
        vendor: VENDOR,
        // 観測ではなく自己申告なので verified にはしない。
        reviewer_route: "cli-fallback",
        model_id_requested: opts.model,
        model_id_actual: reply.model_id_actual.trim(),
        model_id_source: "self_report",
        cli_version: cliVersion(opts.cli),
        backend: "codex",
        ran_at: nowZ(),
        commit,
        verdict: typeof reply.verdict === "string" ? reply.verdict : "UNKNOWN",
        findings: reply.findings,
        diagnostics,
        packet_bytes: packetText.length,
      };
      exitCode = 0;
    }
  }

  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, text, "utf8");
    process.stderr.write(`review-gpt: route=${envelope.reviewer_route} → ${opts.out}\n`);
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
