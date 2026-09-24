#!/usr/bin/env node
// scripts/gate-check.mjs
//
// G0〜G14 (docs/implementation-plan.md §15-2). The same code runs from the Stop
// hook and from CI, so a gate can never be "green locally, red in CI" for the
// reason that two implementations drifted apart.
//
// Every gate reports four things, and all four matter:
//
//   status   ok | violation | warn | defer
//   targets  how many things it actually looked at. A gate that scanned ZERO
//            things is not a passing gate — it is a silently disabled one
//            (R-TH-01). G0 turns any `ok` with `targets === 0` into a
//            violation, so a gate whose subject does not exist yet must say so
//            explicitly with `defer` and a reason.
//   violations  the findings that make the run exit non-zero
//   notes       everything the reader needs to judge the verdict
//
// Overlay roots
// -------------
//   node scripts/gate-check.mjs --root tests/gates/fixtures/violations/<f>
//
// resolves every input file in `--root` first and falls back to `--base` (the
// repository) when the overlay does not carry it. That is how the violation
// fixtures work: each one supplies only the few files that encode its
// violation. A fixture may add `"absent": ["docs/run-log/task_x.json"]` to its
// meta.json to make a path read as missing even though the base repo has it.
//
//   --only G4        only these gates decide the exit code (all gates still
//                    run, because G0 has to see every gate's target count)
//   --json           machine-readable report on stdout
//
// Exit codes: 0 clean / 1 at least one violation / 2 usage or config error.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { checkIntegrity, makeResolver, repoRoot } from "./gate-integrity.mjs";

/** Order matters: this is the order of the report. */
export const GATE_IDS = [
  "G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7",
  "G8", "G9", "G10", "G11", "G12", "G13", "G14",
];

export const GATE_TITLES = {
  G0: "メタゲート（対象 0 件での合格を禁止・違反フィクスチャの実在）",
  G1: "done_definition と verify_commands / manual_verification の非空",
  G2: "verify_commands の実在とコマンド捏造の検知",
  G3: "各 check が 1 つ以上の task から参照されている",
  G4: "完了タスクの run-log（全 verify_commands exit 0 / manual 記録）",
  G5: "high × adversarial_review=required の完了に敵対レビュー記録",
  G6: "DONE_WITH_CONCERNS の concerns に severity と対応案",
  G7: "tests/contract のファイル数が減っていない",
  G8: "差分に実シークレットが含まれない",
  G9: "evidence.commit === HEAD",
  G10: "[設計] / [不明] 依存の ADR が accepted になっていない",
  G11: "severity=high の未解決 concerns 3 件以上で in_progress を禁止",
  G12: "fixture の provenance（captured_from）と autoDetect の宣言",
  G13: "ゲート定義ファイルのハッシュが基準値と一致",
  G14: "直近 7 日の監査連鎖が audit:verify で検証済み",
};

const DONE_STATES = new Set(["DONE", "DONE_WITH_CONCERNS"]);
const STARTED_STATES = new Set(["DONE", "DONE_WITH_CONCERNS", "in_progress"]);
const AUDIT_MAX_AGE_DAYS = 7;
const HIGH_CONCERN_BLOCK_THRESHOLD = 3;
const MIN_VIOLATION_FIXTURES = 10;

const FIXTURES_REL = "tests/gates/fixtures/violations";

/**
 * Files whose job is to CARRY secret patterns (gate definitions, guards, the
 * violation fixtures themselves, the env templates). G8 skips their diff hunks
 * and names them in the report, so the skip is visible rather than silent.
 */
const SECRET_CATALOG_FILES = [
  "docs/constraints.json",
  "docs/wording-policy.md",
  "scripts/deny-dangerous-bash.sh",
  "scripts/deny-test-weakening.sh",
  "scripts/gate-check.mjs",
  "scripts/ci/secrets-grep.sh",
  ".env.example",
  ".dev.vars.example",
];
const SECRET_CATALOG_PREFIXES = ["tests/unit/hooks/"];

/**
 * 違反フィクスチャは「秘密値の形をした値」を持つのが仕事なので、G8 の対象から外す。
 * task_006 の tests/gates/fixtures/** だけでなく、task_012 の
 * tests/unit/config/fixtures/env-scope/** のように各ゲートが自分のフィクスチャを
 * 持つので、tests 配下で fixtures ディレクトリを含むパスをまとめて扱う。
 * 残余リスク（本物の秘密値をフィクスチャに貼っても G8 では捕まらない）は
 * docs/concerns/task_006.md に記録してある。
 */
function isFixturePath(file) {
  return file.startsWith("tests/") && file.includes("/fixtures/");
}

// --------------------------------------------------------------- secret rules
// Assembled from fragments on purpose: scripts/deny-test-weakening.sh refuses
// any Write that puts a production key literal into a file, and G8 must not be
// the one file in the repository that trips its own gate.
const LIVE = "_live_";
const SECRET_RULES = [
  { id: "stripe-live-key", re: new RegExp(`\\b[sprk]k${LIVE}[A-Za-z0-9]{8,}`) },
  { id: "paypay-production-env", re: new RegExp(`PAYPAY_ENV\\s*[=:]\\s*["']?${"PROD"}\\b`) },
  {
    id: "supabase-service-role-jwt",
    re: /\b(SERVICE_ROLE|SERVICE_KEY)[A-Z_]*\s*[=:]\s*["']?eyJ[A-Za-z0-9_-]{20,}/,
  },
  { id: "bare-jwt", re: /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/ },
  {
    // §15-2 の G8 は「実シークレット（**本プロジェクトの名前・形式**）」を対象にしている。
    // 汎用の `[A-Z_]*TOKEN = <長い文字列>` まで広げると、テストが使う合成値
    // （例: 参加用トークンのテストデータ）が毎回引っかかって、本物の検出が
    // 埋もれる。名前はこのリポジトリが実際に使う秘密値だけに絞る:
    // .dev.vars.example / src/lib/config/env.ts の PEPPER・CRON_SECRETS・SESSION_KEYS、
    // §7-2 / §16-6 が挙げる決済・LINE・Supabase・Cloudflare の秘密値、DB パスワード。
    id: "project-secret-with-value",
    re: /\b(PEPPER|PII_PEPPER|CRON_SECRETS|SESSION_KEYS|SESSION_SIGNING_KEY|APP_RW_PASSWORD|LINE_CHANNEL_SECRET|LINE_LOGIN_CHANNEL_SECRET|PAYPAY_API_SECRET|PAYPAY_API_KEY|PAYJP_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|CLOUDFLARE_API_TOKEN)\s*[=:]\s*["']?([A-Za-z0-9+/_-]{16,})/,
  },
  {
    id: "database-url-with-password",
    re: /\bpostgres(ql)?:\/\/[A-Za-z0-9_.-]+:[^@\s"']{8,}@/,
  },
];
/** Values that are obviously templates, not secrets. */
const PLACEHOLDER_RE =
  /(xxxx|XXXX|\.\.\.|<[^>]*>|REDACTED|redacted|EXAMPLE|example|dummy|DUMMY|placeholder|PLACEHOLDER|changeme|CHANGEME|your[-_]|YOUR[-_]|local_dev_only|app_rw_local|postgres:postgres@)/;

// ------------------------------------------------------------------- context

/**
 * @param {{root: string, base: string}} opts
 */
export function createContext(opts) {
  const base = opts.base;
  const root = opts.root;
  const resolveRaw = makeResolver(root, base);

  /** @type {Set<string>} */
  let absent = new Set();
  /**
   * Logical path -> the overlay file that stands in for it.
   *
   * scripts/deny-test-weakening.sh refuses any Write to a file named
   * `docs/acceptance-checks.json` that mentions `evidence` — correctly, since
   * evidence must come from record-run.sh and not from an agent's keyboard
   * (G9 / R-TH-02). A violation fixture for G9 has to carry a wrong evidence
   * block, so it stores it under a different file name and declares the
   * mapping here rather than weakening the guard.
   *
   * @type {Record<string, string>}
   */
  let inputs = {};
  const metaPath = path.join(root, "meta.json");
  if (root !== base && fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (Array.isArray(meta.absent)) absent = new Set(meta.absent.map(String));
      if (meta.inputs && typeof meta.inputs === "object") inputs = meta.inputs;
    } catch {
      /* a malformed meta.json is the fixture's problem, reported by G0 */
    }
  }

  const resolve = (/** @type {string} */ rel) => {
    const exact = inputs[rel];
    if (typeof exact === "string") {
      const candidate = path.join(root, exact);
      if (fs.existsSync(candidate)) return candidate;
    }
    // Directory remapping: "docs/run-log" -> "run-log" also redirects
    // "docs/run-log/task_913.json". The guards refuse any Write whose path
    // contains docs/run-log/ or docs/gates/, fixture or not, so an overlay
    // that needs those trees has to hold them under a different name.
    for (const [logical, physical] of Object.entries(inputs)) {
      if (!rel.startsWith(`${logical}/`)) continue;
      const candidate = path.join(root, physical, rel.slice(logical.length + 1));
      if (fs.existsSync(candidate)) return candidate;
    }
    return resolveRaw(rel);
  };
  const exists = (/** @type {string} */ rel) => !absent.has(rel) && fs.existsSync(resolve(rel));
  const readText = (/** @type {string} */ rel) => {
    if (absent.has(rel)) return null;
    try {
      return fs.readFileSync(resolve(rel), "utf8");
    } catch {
      return null;
    }
  };
  const readJson = (/** @type {string} */ rel) => {
    const text = readText(rel);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const listDir = (/** @type {string} */ rel) => {
    try {
      return fs.readdirSync(resolve(rel), { withFileTypes: true });
    } catch {
      return [];
    }
  };

  const isOverlay = root !== base;

  /**
   * Overlay-ONLY read: never falls back to the repository.
   *
   * `gate-inputs/**` は「フィクスチャが差分や HEAD を固定するための入力」であって、
   * 本番のリポジトリが持っていてよいファイルではない。resolve() は overlay に
   * 無ければ base を読むので、そのまま使うとリポジトリ直下に
   * `gate-inputs/git-diff.json` を置くだけで G8 / G9 の入力を差し替えられる
   * （実 `git diff` / `git rev-parse HEAD` が一度も走らなくなる）。
   * その迂回路を塞ぐため、gate-inputs は overlay からしか読まない。
   * base 側に gate-inputs/ があること自体は baseGateInputs() が違反として報告する。
   */
  const readOverlayText = (/** @type {string} */ rel) => {
    if (!isOverlay) return null;
    if (absent.has(rel)) return null;
    const exact = inputs[rel];
    const candidates = [];
    if (typeof exact === "string") candidates.push(path.join(root, exact));
    for (const [logical, physical] of Object.entries(inputs)) {
      if (!rel.startsWith(`${logical}/`)) continue;
      candidates.push(path.join(root, physical, rel.slice(logical.length + 1)));
    }
    candidates.push(path.join(root, rel));
    for (const candidate of candidates) {
      try {
        return fs.readFileSync(candidate, "utf8");
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  };
  const readOverlayJson = (/** @type {string} */ rel) => {
    const text = readOverlayText(rel);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  return {
    root,
    base,
    absent,
    inputs,
    resolve,
    exists,
    readText,
    readJson,
    readOverlayText,
    readOverlayJson,
    listDir,
    isOverlay,
  };
}

/**
 * `gate-inputs/` はフィクスチャ専用の入力置き場である。実リポジトリ側に現れたら、
 * それは G8 / G9 の入力を差し替えようとした痕跡か、少なくとも誤配置である。
 * G13 のハッシュ対象領域にも入らない（＝新設が検知されない）ので、ここで名指しする。
 *
 * @param {ReturnType<typeof createContext>} ctx
 * @returns {string[]} base 側 gate-inputs/ の中身（repo 相対）
 */
function baseGateInputs(ctx) {
  const dir = path.join(ctx.base, "gate-inputs");
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    out.push(`gate-inputs/${e.name}${e.isDirectory() ? "/" : ""}`);
  }
  return out;
}

/** @param {ReturnType<typeof createContext>} ctx */
function headCommit(ctx) {
  // overlay からしか読まない（base 直下の gate-inputs/head.txt では差し替えられない）
  const pinned = ctx.readOverlayText("gate-inputs/head.txt");
  if (pinned !== null) return pinned.trim();
  try {
    return execFileSync("git", ["-C", ctx.base, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** @param {unknown} value */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** npm script name behind a `npm run <name>` verify command. */
export function scriptNameOf(command) {
  const m = /^\s*npm\s+run\s+(?:--silent\s+|-s\s+)?([^\s]+)/.exec(String(command));
  return m ? m[1] : null;
}

/** The §13 table of planned npm scripts — the anti-fabrication allowlist. */
export function plannedScriptNames(ctx) {
  const plan = ctx.readText("docs/implementation-plan.md");
  /** @type {Set<string>} */
  const names = new Set();
  if (plan === null) return names;
  const start = plan.indexOf("\n## 13.");
  const end = plan.indexOf("\n## 14.");
  if (start < 0 || end < 0 || end <= start) return names;
  for (const line of plan.slice(start, end).split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const m of firstCell.matchAll(/`([^`]+)`/g)) names.add(m[1]);
  }
  return names;
}

/** files_to_create + files_to_modify are all under docs/ (or there are none). */
function isDocsOnly(task) {
  const files = [...asArray(task.files_to_create), ...asArray(task.files_to_modify)];
  if (files.length === 0) return true;
  return files.every((f) => String(f).startsWith("docs/"));
}

/** A concern already fixed in-session is not an outstanding one for G11. */
function isResolvedConcern(text) {
  return typeof text === "string" && /(修正済み|解消済み|対応済み|達成済み|resolved)/.test(text);
}

/**
 * 残懸念の severity 表記。本プロジェクトでは 3 つの書き方が混在している:
 *   - docs/task-list.json の concerns[]      → `[severity: high] …`
 *   - docs/concerns/<task_id>.md             → `- **深刻度**: high（…）`
 *   - docs/HANDOFF.md の各タスク節           → `- **[severity: high] …**`
 * task-list.json の concerns[] だけを数えると、実際に残懸念が書かれている場所を
 * 見ていないことになる（G11 のしきい値が一生発火しない）。
 */
const SEVERITY_PATTERNS = [
  /\*\*深刻度\*\*\s*[:：]\s*(high|medium|low)/i,
  /深刻度\s*[:：]\s*(high|medium|low)/i,
  /severity\s*[:：]\s*(high|medium|low)/i,
  /【\s*(high|medium|low)\s*】/i,
  // docs/concerns/task_012.md の見出し形式: `## C-012-1 [high] …`
  /\[\s*(high|medium|low)\s*\]/i,
];

/** @returns {"high"|"medium"|"low"|null} */
function severityOf(text) {
  if (typeof text !== "string") return null;
  for (const re of SEVERITY_PATTERNS) {
    const m = re.exec(text);
    if (m) return /** @type {any} */ (m[1].toLowerCase());
  }
  return null;
}

/** @param {ReturnType<typeof createContext>} ctx @param {string} taskId */
function concernsFromFile(ctx, taskId) {
  const text = ctx.readText(`docs/concerns/${taskId}.md`);
  /** @type {{source: string, severity: string, body: string, resolved: boolean}[]} */
  const out = [];
  if (text === null) return out;
  const sections = text.split(/^##\s+/m).slice(1);
  for (const section of sections) {
    const severity = severityOf(section);
    if (severity === null) continue;
    out.push({
      source: `docs/concerns/${taskId}.md`,
      severity,
      body: section.trim(),
      resolved: isResolvedConcern(section.split("\n")[0]) || /対応済み|修正済み|解消済み/.test(section),
    });
  }
  return out;
}

/** @param {ReturnType<typeof createContext>} ctx @param {string} taskId */
function concernsFromHandoff(ctx, taskId) {
  const text = ctx.readText("docs/HANDOFF.md");
  /** @type {{source: string, severity: string, body: string, resolved: boolean}[]} */
  const out = [];
  if (text === null) return out;
  const lines = text.split("\n");
  let inTask = false;
  /** @type {string[]} */
  let buffer = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const body = buffer.join("\n").trim();
    buffer = [];
    const severity = severityOf(body);
    if (severity === null) return;
    out.push({
      source: "docs/HANDOFF.md",
      severity,
      body,
      resolved: isResolvedConcern(body),
    });
  };
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      flush();
      // `## task_006（…）` のように節見出しがタスクを名乗る
      inTask = new RegExp(`^##\\s+${taskId}(?:[（(\\s]|$)`).test(line);
      continue;
    }
    if (!inTask) continue;
    if (/^-\s/.test(line)) {
      flush();
      if (/^-\s*\*\*\[?\s*severity\s*[:：]/i.test(line)) buffer = [line];
      continue;
    }
    if (buffer.length > 0) buffer.push(line);
  }
  flush();
  // 同じ懸念が周回ごとに書き写されることがあるので先頭 60 文字で重複を落とす
  const seen = new Set();
  return out.filter((c) => {
    const key = c.body.slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * タスク 1 件の残懸念を 3 つの記録場所から集める。
 * @param {ReturnType<typeof createContext>} ctx
 * @param {any} task
 * @returns {{source: string, severity: string|null, body: string, resolved: boolean}[]}
 */
function collectConcerns(ctx, task) {
  const taskId = String(task.task_id);
  /** @type {{source: string, severity: string|null, body: string, resolved: boolean}[]} */
  const out = asArray(task.concerns).map((c) => {
    const body = typeof c === "string" ? c : JSON.stringify(c);
    return {
      source: "docs/task-list.json",
      severity: severityOf(body),
      body,
      resolved: isResolvedConcern(body),
    };
  });
  out.push(...concernsFromFile(ctx, taskId));
  out.push(...concernsFromHandoff(ctx, taskId));
  return out;
}

// --------------------------------------------------------------------- gates

function gateG1(ctx, s) {
  const violations = [];
  for (const t of s.tasks) {
    const id = t.task_id ?? "<no task_id>";
    if (asArray(t.done_definition).length === 0) {
      violations.push(`${id}: done_definition が空`);
    }
    const verify = asArray(t.verify_commands);
    const manual = asArray(t.manual_verification);
    if (verify.length === 0) {
      if (!isDocsOnly(t)) {
        violations.push(`${id}: docs/** 以外の成果物があるのに verify_commands が空`);
      } else if (manual.length === 0) {
        violations.push(`${id}: 成果物が docs/** のみだが verify_commands も manual_verification も空`);
      }
    }
  }
  return {
    targets: s.tasks.length,
    violations,
    notes: [`task ${s.tasks.length} 件を検査`],
  };
}

function gateG2(ctx, s) {
  const violations = [];
  const warnings = [];
  const planned = plannedScriptNames(ctx);
  const scripts = new Set(Object.keys(s.pkg?.scripts ?? {}));
  let checked = 0;

  if (planned.size === 0) {
    return {
      status: "violation",
      targets: 0,
      violations: ["docs/implementation-plan.md §13 の表からスクリプト名を 1 件も抽出できませんでした"],
      notes: [],
    };
  }

  for (const t of s.tasks) {
    const id = t.task_id ?? "<no task_id>";
    const started = STARTED_STATES.has(t.completion_status);
    for (const cmd of asArray(t.verify_commands)) {
      checked += 1;
      const name = scriptNameOf(cmd);
      if (name === null) {
        violations.push(`${id}: verify_command が \`npm run <script>\` 形式ではありません: ${cmd}`);
        continue;
      }
      const isReal = scripts.has(name);
      const isPlanned = planned.has(name);
      if (!isReal && !isPlanned) {
        // Neither defined nor planned: a fabricated command. A violation even
        // for a task nobody has started.
        violations.push(
          `${id}: コマンド捏造 — \`${name}\` は package.json.scripts にも §13 の予定表にもありません`,
        );
        continue;
      }
      if (!isReal) {
        if (started) {
          violations.push(
            `${id}(${t.completion_status}): \`${name}\` が package.json.scripts にありません（着手済みタスク）`,
          );
        } else {
          warnings.push(`${id}: \`${name}\` は未定義（未着手タスクなので warn）`);
        }
        continue;
      }
      if (!isPlanned) {
        warnings.push(
          `${id}: \`${name}\` は package.json にありますが §13 の表に載っていません（計画の追随漏れ）`,
        );
      }
    }
  }
  return {
    targets: checked,
    violations,
    warnings,
    notes: [`verify_command ${checked} 件を検査（§13 の予定表 ${planned.size} 名 / 実在 ${scripts.size} 名）`],
  };
}

function gateG3(ctx, s) {
  const violations = [];
  const referenced = new Set();
  for (const t of s.tasks) for (const c of asArray(t.acceptance_check_ids)) referenced.add(String(c));
  const known = new Set(s.checks.map((c) => String(c.id)));
  for (const c of s.checks) {
    if (!referenced.has(String(c.id))) {
      violations.push(`${c.id}: どの task からも参照されていません`);
    }
  }
  for (const ref of referenced) {
    if (!known.has(ref)) {
      violations.push(`${ref}: task から参照されていますが docs/acceptance-checks.json にありません`);
    }
  }
  return {
    targets: s.checks.length,
    violations,
    notes: [`check ${s.checks.length} 件 / 参照 ${referenced.size} 件`],
  };
}

function runLogEntries(ctx, taskId) {
  const data = ctx.readJson(`docs/run-log/${taskId}.json`);
  return Array.isArray(data) ? data : null;
}

/**
 * docs/PROGRESS.md が完了を宣言している task_id → ステータス。
 *
 * 完了申告が実際に書かれるのは PROGRESS.md であって台帳ではない（共通ルールが
 * 「完了時に PROGRESS.md に 1 行」としか指示していない）。台帳の
 * completion_status が null のままだと、G4 / G5 / G6 の対象集合がそのぶん小さく
 * なり、「完了の過大申告」を検知するはずのゲートが完了タスクを見ないという
 * 逆転が起きる。台帳との食い違いをここで名指しする。
 *
 * 行の形: `- task_006: DONE_WITH_CONCERNS — …` / `- task_011（レビュー修正・2 周目）: DONE — …`
 *
 * @param {ReturnType<typeof createContext>} ctx
 * @returns {Map<string, string>}
 */
export function progressDeclarations(ctx) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const text = ctx.readText("docs/PROGRESS.md");
  if (text === null) return out;
  const re = /^-\s*(task_[0-9A-Za-z_]+)(?:\s*[（(][^）)]*[）)])?\s*[:：]\s*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT|in_progress)\b/gm;
  for (const m of text.matchAll(re)) {
    // 同じ task が複数周ぶん並ぶ。最初の宣言（＝初回完了）を採る。
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

/** manual エントリが「実施者・UTC 日時・観察結果・HEAD」を全部持っているか。 */
function isCompleteManualEntry(e) {
  return Boolean(
    e &&
      e.type === "manual" &&
      typeof e.observation === "string" &&
      e.observation.trim().length > 0 &&
      typeof e.by === "string" &&
      e.by.length > 0 &&
      typeof e.ran_at === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?/.test(e.ran_at) &&
      typeof e.commit === "string" &&
      e.commit.length > 0,
  );
}

/**
 * manual エントリが manual_verification の項目 i を名指ししているか。
 * 名指しの形は 2 つ: `manual_verification[i]` という索引つきの参照か、
 * 項目文字列そのものの引き写し。
 */
function manualEntryNamesItem(entry, item, index) {
  const obs = String(entry.observation);
  if (obs.includes(`manual_verification[${index}]`)) return true;
  const needle = String(item).trim();
  return needle.length > 0 && obs.includes(needle);
}

/**
 * §15-2 G4 後半「`manual_verification` の**各項目について**実施者・UTC 日時・
 * 観察結果・HEAD が記録されている」の実装。
 *
 * 1 項目 1 記録の**単射**で割り当てる。無関係な manual エントリが 1 件あるだけで
 * N 項目すべてが満たされたことにしてはならない（それが以前の実装の穴）。
 * 名指し（`manual_verification[i]` か項目文字列の引き写し）があるエントリを先に
 * 固定し、残った項目には残ったエントリを 1 件ずつ充てる。名指しの無い充当は
 * warn として表に出す（黙って通さない）。
 *
 * @returns {{violations: string[], warnings: string[], matched: number}}
 */
function matchManualVerification(taskId, items, entries) {
  const complete = entries.filter(isCompleteManualEntry);
  const incomplete = entries.filter((e) => e && e.type === "manual" && !isCompleteManualEntry(e));
  /** @type {string[]} */
  const violations = [];
  /** @type {string[]} */
  const warnings = [];
  const used = new Set();
  /** @type {Map<number, number>} */
  const assigned = new Map();

  // 1st pass: 名指しされている項目を先に確定する
  items.forEach((item, i) => {
    for (let j = 0; j < complete.length; j += 1) {
      if (used.has(j)) continue;
      if (!manualEntryNamesItem(complete[j], item, i)) continue;
      used.add(j);
      assigned.set(i, j);
      return;
    }
  });
  // 2nd pass: 残った項目に、名指しの無い残りのエントリを 1 件ずつ充てる
  items.forEach((item, i) => {
    if (assigned.has(i)) return;
    for (let j = 0; j < complete.length; j += 1) {
      if (used.has(j)) continue;
      used.add(j);
      assigned.set(i, j);
      warnings.push(
        `${taskId}: manual_verification[${i}]「${String(item).slice(0, 30)}」は、` +
          "どの項目の記録か名乗っていない manual エントリで充当しました。" +
          "観察結果の先頭に `manual_verification[<索引>]` を書いてください",
      );
      return;
    }
  });

  items.forEach((item, i) => {
    if (assigned.has(i)) return;
    violations.push(
      `${taskId}: manual_verification[${i}]「${String(item).slice(0, 40)}」に対応する manual 記録` +
        `（実施者・UTC 日時・観察結果・HEAD）がありません` +
        `（項目 ${items.length} 件に対し要件を満たす manual 記録 ${complete.length} 件）`,
    );
  });
  if (incomplete.length > 0) {
    warnings.push(
      `${taskId}: 実施者・UTC 日時・観察結果・HEAD のいずれかを欠く manual エントリが ${incomplete.length} 件あります（充当対象外）`,
    );
  }
  return { violations, warnings, matched: assigned.size };
}

function gateG4(ctx, s) {
  const violations = [];
  const warnings = [];

  // --- 台帳と完了申告の食い違い -------------------------------------------
  // PROGRESS.md が完了を宣言しているのに台帳の completion_status が null なら、
  // G4 / G5 / G6 はそのタスクを一度も見ない。過小カウントそのものを違反にする。
  //
  // 片方だけを差し替えた overlay では、この対比は意味を持たない（フィクスチャの
  // task-list と本物の PROGRESS.md を突き合わせることになる）。両方が同じ層から
  // 来ているときだけ判定し、そうでなければ理由を notes に出して飛ばす。
  // 実リポジトリでは root === base なので常に判定される。
  const ledgerFromOverlay = ctx.readOverlayText("docs/task-list.json") !== null;
  const progressFromOverlay = ctx.readOverlayText("docs/PROGRESS.md") !== null;
  const driftComparable = !ctx.isOverlay || ledgerFromOverlay === progressFromOverlay;

  const declared = driftComparable ? progressDeclarations(ctx) : new Map();
  const byId = new Map(s.tasks.map((t) => [String(t.task_id), t]));
  let drift = 0;
  for (const [taskId, status] of declared) {
    const t = byId.get(taskId);
    if (!t) {
      violations.push(`docs/PROGRESS.md が ${taskId}(${status}) を宣言していますが docs/task-list.json にありません`);
      drift += 1;
      continue;
    }
    if (t.completion_status === null || t.completion_status === undefined) {
      violations.push(
        `${taskId}: docs/PROGRESS.md は ${status} を宣言していますが docs/task-list.json の completion_status が null です` +
          "（台帳が追随していないぶん G4 / G5 / G6 の対象から落ちます）",
      );
      drift += 1;
      continue;
    }
    if (t.completion_status !== status) {
      violations.push(
        `${taskId}: docs/PROGRESS.md は ${status}、docs/task-list.json は ${t.completion_status} と食い違っています`,
      );
      drift += 1;
    }
  }

  const done = s.tasks.filter((t) => DONE_STATES.has(t.completion_status));
  for (const t of done) {
    const id = t.task_id ?? "<no task_id>";
    const entries = runLogEntries(ctx, id);
    if (entries === null) {
      violations.push(`${id}(${t.completion_status}): docs/run-log/${id}.json がありません（完了の過大申告）`);
      continue;
    }
    const verify = asArray(t.verify_commands);
    if (verify.length > 0) {
      for (const cmd of verify) {
        const ok = entries.some(
          (e) => e && e.type === "command" && String(e.command).trim() === String(cmd).trim() && e.exit_code === 0,
        );
        if (!ok) violations.push(`${id}: run-log に \`${cmd}\` の exit 0 がありません`);
      }
      continue;
    }
    const manual = asArray(t.manual_verification);
    if (manual.length === 0) {
      violations.push(`${id}: verify_commands も manual_verification も無いまま完了しています`);
      continue;
    }
    const matched = matchManualVerification(id, manual, entries);
    violations.push(...matched.violations);
    warnings.push(...matched.warnings);
  }
  const notes = [
    `完了タスク ${done.length} 件を検査`,
    driftComparable
      ? `docs/PROGRESS.md の完了宣言 ${declared.size} 件 / 台帳との食い違い ${drift} 件`
      : "docs/PROGRESS.md と docs/task-list.json の一方だけが overlay 由来のため、完了宣言の対比は飛ばしました",
  ];
  if (done.length === 0 && declared.size === 0) {
    return {
      status: "defer",
      targets: 0,
      violations,
      warnings,
      notes: ["完了ステータスのタスクがまだ 1 件もなく、docs/PROGRESS.md にも完了宣言がありません"],
    };
  }
  return { targets: done.length + declared.size, violations, warnings, notes };
}

function gateG5(ctx, s) {
  const subject = s.tasks.filter(
    (t) =>
      DONE_STATES.has(t.completion_status) &&
      t.risk_level === "high" &&
      t.adversarial_review === "required",
  );
  const task007 = s.tasks.find((t) => t.task_id === "task_007");
  const task007Done = Boolean(task007 && DONE_STATES.has(task007.completion_status));

  const findings = [];
  for (const t of subject) {
    const id = t.task_id;
    const log = ctx.readJson(`docs/review-log/${id}.json`);
    if (log === null) {
      findings.push(`${id}: docs/review-log/${id}.json がありません`);
      continue;
    }
    const entries = Array.isArray(log) ? log : Array.isArray(log.entries) ? log.entries : [];
    const usable = entries.some(
      (e) =>
        e &&
        ((typeof e.model_id_actual === "string" && e.model_id_actual.length > 0 &&
          typeof e.cli_version === "string" && typeof e.backend === "string") ||
          e.reviewer_route === "unavailable"),
    );
    if (!usable) {
      findings.push(
        `${id}: review-log に finding 封筒（model_id_actual / cli_version / backend）も reviewer_route=unavailable の欠票記録もありません`,
      );
    }
  }

  if (subject.length === 0) {
    return {
      status: "defer",
      targets: 0,
      violations: [],
      notes: ["high × adversarial_review=required の完了タスクがまだありません"],
    };
  }
  if (!task007Done) {
    return {
      status: findings.length > 0 ? "warn" : "ok",
      targets: subject.length,
      violations: [],
      warnings: findings,
      notes: [
        `対象 ${subject.length} 件。task_007（レビュー経路）が DONE になるまで G5 は warn（§15-2）`,
      ],
    };
  }
  return {
    targets: subject.length,
    violations: findings,
    notes: [`対象 ${subject.length} 件。task_007 が DONE のため G5 はブロッキング`],
  };
}

function gateG6(ctx, s) {
  const violations = [];
  const notes = [];
  const subject = s.tasks.filter((t) => t.completion_status === "DONE_WITH_CONCERNS");
  for (const t of subject) {
    const concerns = asArray(t.concerns);
    if (concerns.length === 0) {
      // 台帳の concerns[] が空でも、本プロジェクトが実際に残懸念を書いている場所
      // （docs/concerns/<task_id>.md・docs/HANDOFF.md のタスク節）に severity つきの
      // 記録があればそれで足りる。どこにも無ければ「懸念つき完了」が中身を持たない。
      const collected = collectConcerns(ctx, t).filter(
        (c) => c.severity !== null && c.body.trim().length >= 40,
      );
      if (collected.length === 0) {
        violations.push(
          `${t.task_id}: DONE_WITH_CONCERNS ですが severity つきの残懸念が ` +
            "docs/task-list.json の concerns[] にも docs/concerns/<task_id>.md にも docs/HANDOFF.md にもありません",
        );
        continue;
      }
      const sources = [...new Set(collected.map((c) => c.source))].join(" / ");
      notes.push(`${t.task_id}: 台帳の concerns[] は空。${sources} の ${collected.length} 件で判定`);
      continue;
    }
    concerns.forEach((c, i) => {
      const text = typeof c === "string" ? c : JSON.stringify(c);
      if (!/severity\s*[:：]\s*(high|medium|low)/i.test(text)) {
        violations.push(`${t.task_id} concerns[${i}]: severity がありません`);
        return;
      }
      const body = text.replace(/\[[^\]]*severity[^\]]*\]/i, "").trim();
      if (body.length < 40) {
        violations.push(`${t.task_id} concerns[${i}]: 対応案の記述が短すぎます（${body.length} 文字）`);
      }
    });
  }
  if (subject.length === 0) {
    return {
      status: "defer",
      targets: 0,
      violations,
      notes: ["DONE_WITH_CONCERNS のタスクがまだありません"],
    };
  }
  return {
    targets: subject.length,
    violations,
    notes: [`DONE_WITH_CONCERNS ${subject.length} 件を検査`, ...notes],
  };
}

function countContractFiles(ctx) {
  const entries = ctx.listDir("tests/contract");
  let n = 0;
  for (const e of entries) {
    if (e.isFile() && /\.tsx?$/.test(e.name)) n += 1;
    if (e.isDirectory()) {
      for (const sub of ctx.listDir(`tests/contract/${e.name}`)) {
        if (sub.isFile() && /\.tsx?$/.test(sub.name)) n += 1;
      }
    }
  }
  return n;
}

function gateG7(ctx, s) {
  const baseline = ctx.readJson("docs/gates/integrity-baseline.json");
  const floor = Number(baseline?.counters?.contract_test_min_count ?? 0);
  const actual = countContractFiles(ctx);
  if (actual < floor) {
    return {
      targets: Math.max(actual, floor),
      violations: [
        `tests/contract のファイル数が ${floor} 件から ${actual} 件に減っています（基準値: docs/gates/integrity-baseline.json .counters.contract_test_min_count）`,
      ],
      notes: [],
    };
  }
  if (actual === 0) {
    return {
      status: "defer",
      targets: 0,
      violations: [],
      notes: ["tests/contract/ はまだ存在しません（task_018 で作成。基準値 0 と一致）"],
    };
  }
  return { targets: actual, violations: [], notes: [`tests/contract ${actual} 件（基準値 ${floor} 件以上）`] };
}

/** @returns {string|null} */
function loadDiff(ctx) {
  // overlay からしか読まない。base 直下に gate-inputs/git-diff.json を置いて
  // 実 diff の走査を丸ごと飛ばす迂回路を塞ぐため（baseGateInputs() が別途違反にする）。
  const structured = ctx.readOverlayJson("gate-inputs/git-diff.json");
  if (structured && Array.isArray(structured.lines)) {
    // Each line is either a string or an array of fragments joined here, so a
    // fixture can carry a secret-shaped value without any file in the
    // repository containing that literal (deny-test-weakening.sh would refuse
    // to write it, and G8 would otherwise flag its own fixture).
    return structured.lines
      .map((l) => (Array.isArray(l) ? l.join("") : String(l)))
      .join("\n");
  }
  const plain = ctx.readOverlayText("gate-inputs/git-diff.txt");
  if (plain !== null) return plain;
  try {
    const worktree = execFileSync("git", ["-C", ctx.base, "diff", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const staged = execFileSync("git", ["-C", ctx.base, "diff", "--cached"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    // Untracked-but-not-ignored files never appear in `git diff`, and a brand
    // new file is exactly where a pasted key lands. They are rendered as an
    // all-added diff so the same scanner sees them.
    const untracked = execFileSync(
      "git",
      ["-C", ctx.base, "ls-files", "--others", "--exclude-standard"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\n")
      .filter((f) => f.length > 0);
    const synthesized = [];
    for (const rel of untracked) {
      const abs = path.join(ctx.base, rel);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      let text;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (text.indexOf(String.fromCharCode(0)) >= 0) continue; // binary は走査しない
      synthesized.push(`+++ b/${rel}`);
      for (const line of text.split("\n")) synthesized.push(`+${line}`);
    }
    return `${worktree}\n${staged}\n${synthesized.join("\n")}`;
  } catch {
    return null;
  }
}

function isCatalogFile(file) {
  if (SECRET_CATALOG_FILES.includes(file)) return true;
  if (isFixturePath(file)) return true;
  return SECRET_CATALOG_PREFIXES.some((p) => file.startsWith(p));
}

function gateG8(ctx) {
  const strayInputs = baseGateInputs(ctx);
  const diff = loadDiff(ctx);
  if (diff === null) {
    return {
      status: "violation",
      targets: 0,
      violations: ["git diff を取得できませんでした（安全側に倒して違反として報告します）"],
      notes: [],
    };
  }
  const violations = [];
  /** @type {Set<string>} */
  const skipped = new Set();
  let currentFile = "";
  let scanned = 0;
  for (const raw of diff.split("\n")) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(raw);
    if (header) {
      currentFile = header[1] === "/dev/null" ? "" : header[1];
      continue;
    }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    if (currentFile && isCatalogFile(currentFile)) {
      skipped.add(currentFile);
      continue;
    }
    const line = raw.slice(1);
    scanned += 1;
    for (const rule of SECRET_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      if (PLACEHOLDER_RE.test(line)) continue;
      violations.push(
        `${currentFile || "<unknown file>"}: 実シークレットの形をした値（規則 ${rule.id}）`,
      );
      break;
    }
  }
  const notes = [`追加行 ${scanned} 行を走査`];
  if (strayInputs.length > 0) {
    violations.push(
      `リポジトリ直下に gate-inputs/ があります（${strayInputs.join(", ")}）。` +
        "これはフィクスチャ専用の入力置き場で、実リポジトリに置くと G8 / G9 の入力差し替えに使われます（無視して走査しました）",
    );
  }
  if (skipped.size > 0) {
    const list = [...skipped].sort();
    const shown = list.slice(0, 5).join(", ");
    const more = list.length > 5 ? ` ほか ${list.length - 5} ファイル` : "";
    notes.push(`パターン定義ファイル・違反フィクスチャのため除外: ${shown}${more}`);
  }
  if (scanned === 0) {
    return { status: "defer", targets: 0, violations, notes: [...notes, "差分に追加行がありません"] };
  }
  return { targets: scanned, violations, notes };
}

function gateG9(ctx, s) {
  const head = headCommit(ctx);
  const withEvidence = s.checks.filter((c) => c && c.evidence !== null && c.evidence !== undefined);
  const violations = [];
  for (const c of withEvidence) {
    const ev = c.evidence;
    if (typeof ev !== "object" || ev === null) {
      violations.push(`${c.id}: evidence がオブジェクトではありません`);
      continue;
    }
    if (typeof ev.commit !== "string" || ev.commit.length === 0) {
      violations.push(`${c.id}: evidence.commit がありません`);
      continue;
    }
    if (ev.commit !== head) {
      violations.push(
        `${c.id}: evidence.commit (${ev.commit.slice(0, 12)}…) が HEAD (${head.slice(0, 12)}…) と一致しません`,
      );
    }
  }
  if (withEvidence.length === 0) {
    return {
      status: "defer",
      targets: 0,
      violations,
      notes: [`evidence 記入済みの check がまだ 0 件です（HEAD=${head.slice(0, 12)}…）`],
    };
  }
  return {
    targets: withEvidence.length,
    violations,
    notes: [`evidence 付き check ${withEvidence.length} 件を HEAD=${head.slice(0, 12)}… と照合`],
  };
}

export function parseAdrStatus(text) {
  const inline = /^[-*]\s*(?:ステータス|Status)\s*[:：]\s*`?([A-Za-z_-]+)`?/m.exec(text);
  if (inline) return inline[1].toLowerCase();
  const heading = /^#{1,4}\s*(?:ステータス|Status)\s*$/m.exec(text);
  if (heading) {
    const rest = text.slice(heading.index + heading[0].length);
    const m = /`?([A-Za-z_-]+)`?/.exec(rest.replace(/^\s+/, ""));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function gateG10(ctx) {
  const files = ctx
    .listDir("docs/decisions")
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
  const violations = [];
  for (const name of files) {
    const text = ctx.readText(`docs/decisions/${name}`);
    if (text === null) continue;
    const status = parseAdrStatus(text);
    if (status === null) {
      violations.push(`${name}: ステータス行を読み取れません`);
      continue;
    }
    if (status !== "accepted") continue;
    const labels = [];
    if (text.includes("[設計]")) labels.push("[設計]");
    if (text.includes("[不明]")) labels.push("[不明]");
    if (labels.length > 0) {
      violations.push(`${name}: ${labels.join(" / ")} に依存したまま accepted になっています`);
    }
  }
  if (files.length === 0) {
    return { status: "violation", targets: 0, violations: ["docs/decisions/ に ADR がありません"], notes: [] };
  }
  return { targets: files.length, violations, notes: [`ADR ${files.length} 件を検査`] };
}

function gateG11(ctx, s) {
  /** @type {string[]} */
  const open = [];
  /** @type {Map<string, number>} */
  const bySource = new Map();
  for (const t of s.tasks) {
    for (const c of collectConcerns(ctx, t)) {
      if (c.severity !== "high" || c.resolved) continue;
      open.push(`${t.task_id}`);
      bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
    }
  }
  const inProgress = s.tasks.filter((t) => t.completion_status === "in_progress");
  const violations = [];
  if (open.length >= HIGH_CONCERN_BLOCK_THRESHOLD && inProgress.length > 0) {
    violations.push(
      `未解決の severity=high concerns が ${open.length} 件（${[...new Set(open)].join(", ")}）あるため、` +
        `in_progress のタスク ${inProgress.map((t) => t.task_id).join(", ")} を進められません`,
    );
  }
  const sources = [...bySource].map(([k, v]) => `${k}=${v}`).join(" / ") || "なし";
  return {
    targets: s.tasks.length,
    violations,
    notes: [
      `未解決 high concerns ${open.length} 件（${[...new Set(open)].join(", ") || "なし"}） / しきい値 ${HIGH_CONCERN_BLOCK_THRESHOLD} 件 / in_progress ${inProgress.length} 件`,
      `集計元: ${sources}`,
    ],
  };
}

function gateG12(ctx) {
  /** @type {{provider: string, file: string, synthesized: boolean, hasProvenance: boolean}[]} */
  const fixtures = [];
  for (const dir of ctx.listDir("tests/fixtures")) {
    if (!dir.isDirectory()) continue;
    for (const f of ctx.listDir(`tests/fixtures/${dir.name}`)) {
      if (!f.isFile() || !f.name.endsWith(".json")) continue;
      const rel = `tests/fixtures/${dir.name}/${f.name}`;
      const data = ctx.readJson(rel);
      const capturedFrom = data && typeof data.captured_from === "string" && data.captured_from.length > 0;
      const provenanceKind = data && data.provenance && typeof data.provenance.kind === "string"
        ? data.provenance.kind
        : null;
      fixtures.push({
        provider: dir.name,
        file: rel,
        synthesized: !capturedFrom && provenanceKind === "synthesized",
        hasProvenance: capturedFrom || provenanceKind !== null,
      });
    }
  }
  const violations = [];
  for (const f of fixtures) {
    if (!f.hasProvenance) {
      violations.push(`${f.file}: captured_from も provenance.kind もありません（provenance 欠落）`);
    }
  }
  // synthesized-only providers may not declare autoDetect
  const byProvider = new Map();
  for (const f of fixtures) {
    const list = byProvider.get(f.provider) ?? [];
    list.push(f);
    byProvider.set(f.provider, list);
  }
  for (const [provider, list] of byProvider) {
    const allSynthesized = list.length > 0 && list.every((f) => f.synthesized);
    if (!allSynthesized) continue;
    for (const entry of ctx.listDir("src/lib/payments/providers")) {
      if (!entry.isFile()) continue;
      const text = ctx.readText(`src/lib/payments/providers/${entry.name}`);
      if (text === null) continue;
      if (!text.includes(provider)) continue;
      if (/autoDetect\s*[:=]\s*true/.test(text)) {
        violations.push(
          `src/lib/payments/providers/${entry.name}: fixture が synthesized のみの provider「${provider}」で autoDetect を宣言しています`,
        );
      }
    }
  }
  if (fixtures.length === 0) {
    return {
      status: "defer",
      targets: 0,
      violations,
      notes: ["tests/fixtures/<provider>/ がまだありません（task_018 / task_019 で作成）"],
    };
  }
  return { targets: fixtures.length, violations, notes: [`fixture ${fixtures.length} 件を検査`] };
}

function gateG13(ctx) {
  const result = checkIntegrity(ctx);
  return { targets: result.targets, violations: result.violations, notes: result.notes };
}

function gateG14(ctx, s) {
  const scripts = new Set(Object.keys(s.pkg?.scripts ?? {}));
  if (!scripts.has("audit:verify")) {
    return {
      status: "defer",
      targets: 0,
      violations: [],
      notes: ["package.json に audit:verify がありません（task_018 で作成）"],
    };
  }
  const dirEntries = ctx.listDir("docs/run-log").filter((e) => e.isFile() && e.name.endsWith(".json"));
  /** @type {{ran_at: string, task: string}[]} */
  const runs = [];
  for (const e of dirEntries) {
    const entries = ctx.readJson(`docs/run-log/${e.name}`);
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || entry.type !== "command") continue;
      if (!String(entry.command).includes("audit:verify")) continue;
      if (entry.exit_code !== 0) continue;
      if (typeof entry.ran_at !== "string") continue;
      runs.push({ ran_at: entry.ran_at, task: e.name.replace(/\.json$/, "") });
    }
  }
  if (runs.length === 0) {
    return {
      targets: dirEntries.length,
      violations: [
        "docs/run-log/** に `npm run audit:verify` の exit 0 記録がありません（監査連鎖が未検証）",
      ],
      notes: [`run-log ${dirEntries.length} ファイルを走査`],
    };
  }
  runs.sort((a, b) => (a.ran_at < b.ran_at ? 1 : -1));
  const latest = runs[0];
  const ageMs = Date.now() - Date.parse(latest.ran_at);
  const ageDays = ageMs / 86_400_000;
  if (!Number.isFinite(ageDays)) {
    return {
      targets: runs.length,
      violations: [`audit:verify の最新記録の ran_at を解釈できません: ${latest.ran_at}`],
      notes: [],
    };
  }
  if (ageDays > AUDIT_MAX_AGE_DAYS) {
    return {
      targets: runs.length,
      violations: [
        `audit:verify の最新 exit 0 は ${latest.ran_at}（${ageDays.toFixed(1)} 日前、${latest.task}）で、${AUDIT_MAX_AGE_DAYS} 日を超えています`,
      ],
      notes: [],
    };
  }
  return {
    targets: runs.length,
    violations: [],
    notes: [`audit:verify の最新 exit 0: ${latest.ran_at}（${ageDays.toFixed(1)} 日前、${latest.task}）`],
  };
}

// ----------------------------------------------------------------- G0 (meta)

/** @returns {{fixtures: any[], errors: string[]}} */
export function loadFixtures(ctx) {
  /** @type {any[]} */
  const fixtures = [];
  /** @type {string[]} */
  const errors = [];
  const dirs = ctx.listDir(FIXTURES_REL).filter((e) => e.isDirectory());
  for (const d of dirs.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = `${FIXTURES_REL}/${d.name}/meta.json`;
    const meta = ctx.readJson(rel);
    if (meta === null) {
      errors.push(`${rel}: meta.json がありません（または JSON として不正）`);
      continue;
    }
    if (meta.fixture_id !== d.name) {
      errors.push(`${rel}: fixture_id (${meta.fixture_id}) がディレクトリ名 (${d.name}) と一致しません`);
    }
    for (const field of ["gate", "description", "provenance"]) {
      if (meta[field] === undefined) errors.push(`${rel}: ${field} がありません`);
    }
    if (meta.expect_exit_nonzero !== true) {
      errors.push(`${rel}: expect_exit_nonzero が true ではありません`);
    }
    const prov = meta.provenance ?? {};
    if (typeof prov.authored_by !== "string" || prov.authored_by.length === 0) {
      errors.push(`${rel}: provenance.authored_by がありません`);
    }
    if (typeof prov.kind !== "string" || prov.kind.length === 0) {
      errors.push(`${rel}: provenance.kind がありません`);
    }
    if (meta.runner !== null && meta.runner !== undefined) {
      if (typeof meta.runner.cmd !== "string" || !Array.isArray(meta.runner.args)) {
        errors.push(`${rel}: runner は {cmd, args} である必要があります`);
      }
      if (typeof meta.expect_output_contains !== "string" || meta.expect_output_contains.length === 0) {
        errors.push(`${rel}: runner があるのに expect_output_contains がありません`);
      }
    } else if (typeof meta.blocked_on !== "string" || meta.blocked_on.length === 0) {
      errors.push(`${rel}: runner が無い fixture には blocked_on（待っているタスク）が必要です`);
    }
    fixtures.push({ ...meta, dir: `${FIXTURES_REL}/${d.name}` });
  }
  return { fixtures, errors };
}

/**
 * G0 runs last: it judges the other gates' target counts, and the fixture set.
 * @param {ReturnType<typeof createContext>} ctx
 * @param {any[]} others
 */
function gateG0(ctx, others) {
  const violations = [];
  const warnings = [];
  const { fixtures, errors } = loadFixtures(ctx);
  violations.push(...errors);

  // 1. no gate may pass while having looked at nothing
  for (const r of others) {
    if (r.status === "ok" && r.targets === 0) {
      violations.push(
        `${r.id} は対象 0 件で ok になっています。対象が無い期間は defer（理由つき）で報告してください（R-TH-01）`,
      );
    }
    if (r.status === "defer" && r.notes.length === 0) {
      violations.push(`${r.id} が defer ですが理由がありません`);
    }
  }

  // 1b. ゲートの入力そのものが差し替えられていないか
  const strayInputs = baseGateInputs(ctx);
  if (strayInputs.length > 0) {
    violations.push(
      `リポジトリ直下に gate-inputs/ があります（${strayInputs.join(", ")}）。` +
        "フィクスチャ専用の入力置き場であり、実リポジトリに置かれていると G8 / G9 が実 diff / 実 HEAD を見ない状態を作れます",
    );
  }

  // 2. the fixture set itself
  const runnable = fixtures.filter((f) => f.runner);
  if (runnable.length < MIN_VIOLATION_FIXTURES) {
    violations.push(
      `実行可能な違反フィクスチャが ${runnable.length} 本しかありません（${MIN_VIOLATION_FIXTURES} 本以上が必要）`,
    );
  }
  const covered = new Set();
  for (const f of fixtures) {
    for (const g of Array.isArray(f.gate) ? f.gate : [f.gate]) covered.add(String(g));
  }
  for (const id of GATE_IDS) {
    if (!covered.has(id)) violations.push(`${id} に対応する違反フィクスチャがありません`);
  }
  const humanAuthored = fixtures.filter(
    (f) => typeof f.provenance?.authored_by === "string" && f.provenance.authored_by.startsWith("human"),
  );
  if (humanAuthored.length === 0) {
    warnings.push(
      "人間が手書きした違反フィクスチャが 0 本です（§15-2 / task_006 scope は 1 本目を人間の手書き・CODEOWNERS 対象と定めています。docs/concerns/task_006.md に deferred として記録）",
    );
  }

  return {
    targets: fixtures.length,
    violations,
    warnings,
    notes: [
      `違反フィクスチャ ${fixtures.length} 本（実行可能 ${runnable.length} 本 / 対象ゲート ${covered.size} 種）`,
      `対象 0 件で ok のゲート: ${others.filter((r) => r.status === "ok" && r.targets === 0).length} 件`,
    ],
  };
}

// ------------------------------------------------------------------- runner

/**
 * @param {ReturnType<typeof createContext>} ctx
 */
export function runGates(ctx) {
  const taskList = ctx.readJson("docs/task-list.json");
  const checksFile = ctx.readJson("docs/acceptance-checks.json");
  const pkg = ctx.readJson("package.json");

  /** @type {string[]} */
  const configErrors = [];
  if (taskList === null) configErrors.push("docs/task-list.json を読めません");
  if (checksFile === null) configErrors.push("docs/acceptance-checks.json を読めません");
  if (pkg === null) configErrors.push("package.json を読めません");
  if (configErrors.length > 0) {
    return { configErrors, results: [] };
  }

  const s = {
    tasks: asArray(taskList.tasks),
    checks: asArray(checksFile.checks),
    pkg,
  };

  const impls = [
    ["G1", () => gateG1(ctx, s)],
    ["G2", () => gateG2(ctx, s)],
    ["G3", () => gateG3(ctx, s)],
    ["G4", () => gateG4(ctx, s)],
    ["G5", () => gateG5(ctx, s)],
    ["G6", () => gateG6(ctx, s)],
    ["G7", () => gateG7(ctx, s)],
    ["G8", () => gateG8(ctx)],
    ["G9", () => gateG9(ctx, s)],
    ["G10", () => gateG10(ctx)],
    ["G11", () => gateG11(ctx, s)],
    ["G12", () => gateG12(ctx)],
    ["G13", () => gateG13(ctx)],
    ["G14", () => gateG14(ctx, s)],
  ];

  /** @type {any[]} */
  const results = [];
  for (const [id, fn] of impls) {
    let raw;
    try {
      raw = fn();
    } catch (err) {
      raw = {
        status: "violation",
        targets: 0,
        violations: [`ゲートの実行中に例外: ${err instanceof Error ? err.message : String(err)}`],
        notes: [],
      };
    }
    const violations = raw.violations ?? [];
    const status = raw.status ?? (violations.length > 0 ? "violation" : "ok");
    results.push({
      id,
      title: GATE_TITLES[id],
      status: violations.length > 0 ? "violation" : status,
      targets: raw.targets ?? 0,
      violations,
      warnings: raw.warnings ?? [],
      notes: raw.notes ?? [],
    });
  }

  const meta = gateG0(ctx, results);
  const metaViolations = meta.violations ?? [];
  results.unshift({
    id: "G0",
    title: GATE_TITLES.G0,
    status: metaViolations.length > 0 ? "violation" : "ok",
    targets: meta.targets,
    violations: metaViolations,
    warnings: meta.warnings ?? [],
    notes: meta.notes ?? [],
  });

  return { configErrors: [], results };
}

const STATUS_LABEL = { ok: "ok   ", violation: "FAIL ", warn: "warn ", defer: "defer" };

export function formatReport(results, only) {
  const lines = [];
  for (const r of results) {
    const scoped = only === null || only.has(r.id);
    const suffix = scoped ? "" : "  (--only の対象外。exit code には影響しません)";
    lines.push(`${STATUS_LABEL[r.status] ?? r.status} ${r.id} ${r.title} — 対象 ${r.targets} 件${suffix}`);
    for (const n of r.notes) lines.push(`        ${n}`);
    for (const w of r.warnings) lines.push(`   warn ${r.id} ${w}`);
    for (const v of r.violations) lines.push(`   FAIL ${r.id} ${v}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------- CLI --

function usage(message) {
  process.stderr.write(`gate-check: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { root: "", base: "", only: null, json: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--root":
        if (next === undefined) usage("--root requires a value");
        out.root = next;
        i += 1;
        break;
      case "--base":
        if (next === undefined) usage("--base requires a value");
        out.base = next;
        i += 1;
        break;
      case "--only":
        if (next === undefined) usage("--only requires a value");
        out.only = new Set(
          next
            .split(",")
            .map((x) => x.trim().toUpperCase())
            .filter((x) => x.length > 0),
        );
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
        process.stdout.write(
          "Usage: node scripts/gate-check.mjs [--root <dir>] [--base <dir>] [--only G1,G2] [--json] [--quiet]\n",
        );
        process.exit(0);
        break;
      default:
        usage(`unknown argument: ${arg}`);
    }
  }
  return out;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const base = path.resolve(args.base || repoRoot());
  const root = path.resolve(args.root || base);
  if (args.only) {
    for (const id of args.only) {
      if (!GATE_IDS.includes(id)) usage(`unknown gate id: ${id}`);
    }
  }
  const ctx = createContext({ root, base });
  const { configErrors, results } = runGates(ctx);
  if (configErrors.length > 0) {
    for (const e of configErrors) process.stderr.write(`gate-check: ${e}\n`);
    process.exit(2);
  }

  const scoped = results.filter((r) => args.only === null || args.only.has(r.id));
  const failing = scoped.filter((r) => r.status === "violation");
  const violationCount = failing.reduce((n, r) => n + r.violations.length, 0);
  const warnCount = results.reduce((n, r) => n + r.warnings.length, 0);

  const summary = `gate:check — ${scoped.length} ゲートを判定、${failing.length} ゲートが不合格（違反 ${violationCount} 件 / warn ${warnCount} 件）`;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ root, base, only: args.only ? [...args.only] : null, results }, null, 2)}\n`,
    );
  } else if (!args.quiet) {
    process.stdout.write(`${formatReport(results, args.only)}\n`);
    process.stdout.write(`\n${summary}\n`);
  }

  // Stop フックは `npm run --silent gate:check` を exit 1 で返す（exit 2 にすると
  // 停止をブロックし、ゲートが直るまでセッションが終われない罠になる）。
  // Claude Code が非ブロッキングの非ゼロ終了でセッションに見せるのは **stderr** なので、
  // stdout だけに書いていると「どのゲートが何件落ちたか」がその場に出ない。
  // 落ちたときは違反行と集計行を stderr にも出す。
  if (failing.length > 0) {
    const lines = [summary];
    for (const r of failing) {
      for (const v of r.violations) lines.push(`   FAIL ${r.id} ${v}`);
    }
    process.stderr.write(`${lines.join("\n")}\n`);
  }
  process.exit(failing.length > 0 ? 1 : 0);
}
