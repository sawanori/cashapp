#!/usr/bin/env node
// scripts/ci/assert-release-gate.mjs  —  check_051 の判定器
//
// `.github/workflows/release.yml` を YAML としてパースし、本番デプロイの前に 2 段ゲートが
// 「実際に構造として」置かれていることをアサートする（docs/implementation-plan.md §16-6、
// L11、R-SEC-07）。grep ではなくパースにするのは、コメントや別ジョブに同じ文字列を書いた
// だけで緑になる空振りを避けるため（R-TH-01）。
//
// アサートすること:
//   1. ジョブ `release-gate` が存在する。
//   2. release.yml の他のすべてのジョブが、`needs` を辿ると必ず `release-gate` に到達する
//      （= ゲートより先に走るジョブが 1 つも無い）。
//   3. `release-gate` の最初の実行ステップ（`actions/checkout` を除く最初の `run`）が
//      docs/gates/release-mode.json の payments_enabled を読んでいる。
//   4. `release-gate` のどこかで (a) 段 = PAYMENTS_ENABLED が false であることの検証と
//      `npm ls` による決済 SDK 不在の検証、(b) 段 = docs/gates/legal-clearance.json の
//      `.cleared == true` の検証、の両方が書かれている。
//   5. デプロイジョブが `cloudflare/wrangler-action` で `deploy --env production` を実行し、
//      `environment: production` に属し、API トークンを `secrets.` から受け取っている。
//   6. release.yml がローカルの .env / .dev.vars を読み込んでいない
//      （implementation_steps「release.yml をローカルの .env を読まない構成に」）。
//
// 使い方:
//   node scripts/ci/assert-release-gate.mjs [--file <path>] [--json]
//
// 終了コード: 0 合格 / 1 違反 / 2 使用法・読み取りエラー

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parse as parseYaml } from "yaml";

export const RELEASE_WORKFLOW_REL = ".github/workflows/release.yml";
export const GATE_JOB_ID = "release-gate";

const RELEASE_MODE_PATH = "docs/gates/release-mode.json";
const LEGAL_CLEARANCE_PATH = "docs/gates/legal-clearance.json";

/** @param {unknown} v @returns {string} */
function textOf(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join("\n");
  if (v && typeof v === "object") return Object.values(v).map(textOf).join("\n");
  return "";
}

/** ジョブの `steps` のうち、`run:` を持つものの本文を順番に返す。 */
function runSteps(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return steps.filter((s) => s && typeof s.run === "string");
}

/**
 * `needs` を辿って `from` から `target` に到達できるか。
 * 循環は訪問済み集合で止める。
 */
function reachesVia(jobs, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const job = jobs[from];
  if (!job) return false;
  const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
  return needs.some((n) => reachesVia(jobs, String(n), target, seen));
}

/**
 * @param {string} yamlText
 * @returns {{status: "ok"|"violation", violations: string[], notes: string[]}}
 */
export function checkReleaseGate(yamlText) {
  const violations = [];
  const notes = [];

  /** @type {any} */
  let doc;
  try {
    doc = parseYaml(yamlText);
  } catch (e) {
    return {
      status: "violation",
      violations: [`${RELEASE_WORKFLOW_REL} が YAML としてパースできません: ${e instanceof Error ? e.message : String(e)}`],
      notes,
    };
  }

  const jobs = doc && typeof doc === "object" ? doc.jobs : null;
  if (!jobs || typeof jobs !== "object") {
    return { status: "violation", violations: [`${RELEASE_WORKFLOW_REL} に jobs がありません`], notes };
  }

  // --- 1. ゲートジョブの存在 ---------------------------------------------
  const gate = jobs[GATE_JOB_ID];
  if (!gate) {
    return {
      status: "violation",
      violations: [`${RELEASE_WORKFLOW_REL} にジョブ \`${GATE_JOB_ID}\` がありません（先頭の 2 段ゲート。§16-6）`],
      notes,
    };
  }

  const jobIds = Object.keys(jobs);
  notes.push(`ジョブ ${jobIds.length} 件: ${jobIds.join(" / ")}`);

  // --- 2. ゲートより先に走るジョブが無い -----------------------------------
  for (const id of jobIds) {
    if (id === GATE_JOB_ID) continue;
    if (!reachesVia(jobs, id, GATE_JOB_ID)) {
      violations.push(
        `ジョブ \`${id}\` は needs を辿っても \`${GATE_JOB_ID}\` に到達しません（ゲートより先に走れてしまいます）`,
      );
    }
  }

  // --- 3. 先頭ステップが release-mode.json を読む ---------------------------
  const gateRuns = runSteps(gate);
  if (gateRuns.length === 0) {
    violations.push(`\`${GATE_JOB_ID}\` に run ステップがありません`);
  } else {
    const first = gateRuns[0].run;
    if (!first.includes(RELEASE_MODE_PATH)) {
      violations.push(
        `\`${GATE_JOB_ID}\` の最初の run ステップが ${RELEASE_MODE_PATH} を読んでいません（先頭が 2 段ゲートである必要があります）`,
      );
    }
    if (!/payments_enabled/.test(first)) {
      violations.push(`\`${GATE_JOB_ID}\` の最初の run ステップが payments_enabled を判定していません`);
    }
  }

  const gateBody = gateRuns.map((s) => s.run).join("\n");

  // --- 4. (a) 段と (b) 段 --------------------------------------------------
  if (!/PAYMENTS_ENABLED/.test(gateBody)) {
    violations.push(`(a) 段がありません: \`${GATE_JOB_ID}\` がビルド設定の PAYMENTS_ENABLED を検証していません`);
  }
  // `npm ls` は**コマンドの位置**にあること。エラーメッセージの中に "npm ls" と
  // 書いてあるだけで通ってしまうと、この検査は文字列の存在確認に堕ちる。
  if (!/(?:^|[;&|(]|\$\()\s*npm\s+ls\b/m.test(gateBody)) {
    violations.push(`(a) 段がありません: \`${GATE_JOB_ID}\` が \`npm ls\` で決済 SDK の不在を検証していません`);
  }
  if (!gateBody.includes(LEGAL_CLEARANCE_PATH)) {
    violations.push(`(b) 段がありません: \`${GATE_JOB_ID}\` が ${LEGAL_CLEARANCE_PATH} を読んでいません`);
  }
  if (!/\.cleared\s*==\s*true/.test(gateBody)) {
    violations.push(`(b) 段がありません: \`${GATE_JOB_ID}\` が \`.cleared == true\` を必須にしていません`);
  }

  // --- 5. デプロイジョブ ---------------------------------------------------
  //
  // ステップの `name:` にも同じ文字列を書けるので、判定は `uses` と `with` の
  // **構造**から取る（ジョブ全体の文字列検索にすると、名前を変えただけで通る）。
  /** @type {{jobId: string, step: any}[]} */
  const deploySteps = [];
  for (const id of jobIds) {
    const steps = Array.isArray(jobs[id]?.steps) ? jobs[id].steps : [];
    for (const step of steps) {
      if (step && typeof step.uses === "string" && /^cloudflare\/wrangler-action(@|$)/.test(step.uses.trim())) {
        deploySteps.push({ jobId: id, step });
      }
    }
  }

  if (deploySteps.length === 0) {
    violations.push("cloudflare/wrangler-action を使うデプロイステップがありません（§16-6）");
  }
  for (const { jobId, step } of deploySteps) {
    const job = jobs[jobId];
    const withBlock = step.with && typeof step.with === "object" ? step.with : {};
    const command = typeof withBlock.command === "string" ? withBlock.command : "";
    if (!/(^|\n)\s*deploy\s+--env\s+production\s*(\n|$)/.test(command)) {
      violations.push(
        `ジョブ \`${jobId}\`: wrangler-action の \`command\` が \`deploy --env production\` ではありません（実際: ${JSON.stringify(command)}）`,
      );
    }
    const environment = job?.environment;
    const envName = typeof environment === "string" ? environment : environment?.name;
    if (envName !== "production") {
      violations.push(
        `ジョブ \`${jobId}\`: \`environment: production\` がありません（CLOUDFLARE_API_TOKEN と本番シークレットは environment: production にのみ置く。§16-6 / L11）`,
      );
    }
    const apiToken = typeof withBlock.apiToken === "string" ? withBlock.apiToken : "";
    if (!/secrets\.CLOUDFLARE_API_TOKEN/.test(apiToken)) {
      violations.push(
        `ジョブ \`${jobId}\`: \`apiToken\` が \${{ secrets.CLOUDFLARE_API_TOKEN }} から渡されていません（実際: ${JSON.stringify(apiToken)}）`,
      );
    }
  }
  const deployIds = [...new Set(deploySteps.map((d) => d.jobId))];

  // --- 6. ローカルの .env / .dev.vars を読まない ---------------------------
  const wholeText = textOf(doc);
  const localEnvRe = /(^|[\s"'`;|&(])(?:source|\.)\s+\.env|dotenv|cp\s+\.env|\.dev\.vars(?!\.example)|--env-file[= ]\s*\.env/m;
  if (localEnvRe.test(wholeText)) {
    violations.push(
      `${RELEASE_WORKFLOW_REL} がローカルの .env / .dev.vars を読もうとしています（本番シークレットは environment: production からのみ。§16-6）`,
    );
  }

  notes.push(`(a) 段 / (b) 段 / デプロイジョブ ${deployIds.length} 件を検査`);
  return { status: violations.length > 0 ? "violation" : "ok", violations, notes };
}

// ---------------------------------------------------------------------- CLI --

function usage(message) {
  process.stderr.write(`assert-release-gate: ${message}\n`);
  process.stderr.write("Usage: node scripts/ci/assert-release-gate.mjs [--file <path>] [--json]\n");
  process.exit(2);
}

function parseArgs(argv) {
  const out = { file: "", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--file":
        if (next === undefined) usage("--file requires a value");
        out.file = next;
        i += 1;
        break;
      case "--json":
        out.json = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write("Usage: node scripts/ci/assert-release-gate.mjs [--file <path>] [--json]\n");
        process.exit(0);
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }
  return out;
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file || path.resolve(process.cwd(), RELEASE_WORKFLOW_REL);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    usage(`読めません: ${file}（${e instanceof Error ? e.message : String(e)}）`);
  }

  const result = checkReleaseGate(text);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ file, ...result }, null, 2)}\n`);
  } else {
    for (const n of result.notes) process.stdout.write(`      ${n}\n`);
    for (const v of result.violations) process.stdout.write(`check_051 FAIL ${v}\n`);
    process.stdout.write(`\nassert-release-gate — ${file} を検査、違反 ${result.violations.length} 件\n`);
  }
  process.exit(result.status === "ok" ? 0 : 1);
}
