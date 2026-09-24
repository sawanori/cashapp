#!/usr/bin/env node
/**
 * scripts/gate-env-scope.mjs — 環境スコープの静的スナップショット検査（`npm run gate:env`）。
 *
 * 目的（R-SEC-05 / R-SEC-09 / R-LINE-04）:
 *   「staging のデプロイが本番の Supabase / 本番の LIFF / 本番の Hyperdrive を掴んでいない」
 *   「service role キーがどちらのランタイムにも渡っていない」
 *   「必須の秘密値の名前が、どこかに書かれている（雛形として辿れる）」
 *   の 3 点を、**デプロイせずにリポジトリの中身だけで**確かめる。
 *
 * 見るファイル:
 *   - wrangler.toml                     … メインアプリ Worker
 *   - workers/cron/wrangler.toml        … cron 専用 Worker
 *   - .dev.vars.example / .env.example  … 秘密値の雛形（名前だけを見る。値は見ない）
 *   - docs/ops/env-baseline.json        … 期待名の正本（**task_035 が作る**。無ければ pending）
 *
 * 判定:
 *   - violation が 1 件でもあれば exit 1。
 *   - pending（まだ存在しない前提に依存する項目）は exit 0 のまま出力に残す。
 *     存在しないものを violation にすると、このゲートが着手前から赤になり意味を失う。
 *
 * ライブ検査:
 *   `wrangler secret list --env <env>` の名前一覧との突き合わせは、CLI が認証済みのときだけ行う。
 *   未認証なら**静的検査のみで判定した旨を明記して** exit 0 にする（CI 接続は task_024）。
 *
 * 使い方:
 *   node scripts/gate-env-scope.mjs [--root <dir>] [--no-live]
 *   --root  検査対象のルート（テストのフィクスチャを指すため）。既定はリポジトリルート。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/** ランタイムに渡してはいけない変数名（値ではなく名前で弾く）。 */
const FORBIDDEN_RUNTIME_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
  "SERVICE_ROLE_KEY",
  "DATABASE_URL_MIGRATOR",
  "POSTGRES_PASSWORD",
  "ALLOW_PRIVILEGED_DB_ROLE",
  "ALLOW_LOCAL_RATE_LIMIT_BYPASS",
];

/** `[vars]`（平文）に書いてはいけない秘密値の名前。シークレットストア経由でしか渡さない。 */
const SECRET_ONLY_NAMES = ["PEPPER", "SESSION_KEYS", "CRON_SECRETS", "DATABASE_URL"];

/** 雛形のどこかに名前が現れてほしい必須の秘密値（§7-4）。 */
const REQUIRED_SECRET_NAMES = ["LINE_ENV_PROFILE", "PEPPER", "SESSION_KEYS", "CRON_SECRETS"];

/**
 * staging / production で同じ値になっていて**当然**のキー。
 *
 * バインディング名（`binding = "HYPERDRIVE"`）はコード側が参照する識別子なので、
 * 環境ごとに変えてはいけない。ここで除外しないと「同じ値を共有している」検査が
 * 常に赤になり、本当に危ないもの（Hyperdrive の `id`、`service`、project ref）が埋もれる。
 */
const SHARED_VALUE_EXEMPT_KEYS = [
  "binding",
  "compatibility_date",
  "compatibility_flags",
  "main",
  "mode",
  "directory",
  "crons",
];

/** wrangler の environment 名と、その `[vars] APP_ENV` の期待値。 */
const ENV_APP_ENV = {
  "": "development",
  staging: "staging",
  production: "production",
};

function parseArgs(argv) {
  const args = { root: REPO_ROOT, live: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("--root requires a directory");
      }
      args.root = path.resolve(value);
      i += 1;
    } else if (arg === "--no-live") {
      args.live = false;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

/**
 * 最小限の TOML 読み取り。
 *
 * このゲートが必要とするのは「どの表にどのキーがあり、その値（文字列）は何か」だけである。
 * 完全な TOML パーサは要らないし、依存を増やしたくない（ゲートは依存が少ないほど壊れない）。
 * 対応する構文: `[table]` / `[[array of tables]]` / `key = "string"` / `key = 123` / `key = true`
 * / `key = ["a", "b"]`（1 行のみ）。行コメント（`#`）は落とす。
 *
 * @returns {{ path: string, key: string, value: string, line: number }[]}
 */
function readTomlAssignments(text) {
  const out = [];
  let tablePath = "";
  const arrayIndex = new Map();
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const withoutComment = stripTomlComment(raw).trim();
    if (withoutComment.length === 0) continue;

    const arrayTable = /^\[\[([^\]]+)\]\]$/.exec(withoutComment);
    if (arrayTable !== null) {
      const name = arrayTable[1].trim();
      const next = (arrayIndex.get(name) ?? -1) + 1;
      arrayIndex.set(name, next);
      tablePath = `${name}[${next}]`;
      continue;
    }
    const table = /^\[([^\]]+)\]$/.exec(withoutComment);
    if (table !== null) {
      tablePath = table[1].trim();
      continue;
    }

    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(withoutComment);
    if (assignment === null) continue;
    out.push({
      path: tablePath,
      key: assignment[1],
      value: unquote(assignment[2].trim()),
      line: i + 1,
    });
  }
  return out;
}

/** 文字列リテラルの中の `#` をコメント開始と誤認しないようにしながら行コメントを落とす。 */
function stripTomlComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") {
      inString = !inString;
    } else if (ch === "#" && !inString) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/** `env.staging.vars` → `staging`、`vars` → `""`、`env.production.hyperdrive[0]` → `production`。 */
function environmentOf(tablePath) {
  const match = /^env\.([A-Za-z0-9_-]+)(?:\.|\[|$)/.exec(tablePath);
  return match === null ? "" : match[1];
}

/** `.env` / `.dev.vars` 形式のファイルから、コメントを除いた代入行の変数名を拾う。 */
function readEnvNames(text) {
  const names = new Set();
  const commented = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      const inner = /^#\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
      if (inner !== null) commented.add(inner[1]);
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match !== null) names.add(match[1]);
  }
  return { names, commented };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const violations = [];
  const pending = [];
  const notes = [];
  const ok = [];

  const mainTomlPath = path.join(args.root, "wrangler.toml");
  const cronTomlPath = path.join(args.root, "workers/cron/wrangler.toml");

  if (!existsSync(mainTomlPath)) {
    violations.push(`wrangler.toml not found under ${args.root}`);
    report({ violations, pending, notes, ok });
    process.exit(1);
  }

  const runtimes = [{ label: "main", file: mainTomlPath }];
  if (existsSync(cronTomlPath)) {
    runtimes.push({ label: "cron", file: cronTomlPath });
  } else {
    pending.push("workers/cron/wrangler.toml not found — cron runtime checks skipped");
  }

  /** @type {Map<string, {label: string, env: string, path: string, key: string, value: string}[]>} */
  const byRuntime = new Map();

  for (const runtime of runtimes) {
    const assignments = readTomlAssignments(readFileSync(runtime.file, "utf8")).map((a) => ({
      ...a,
      label: runtime.label,
      env: environmentOf(a.path),
    }));
    byRuntime.set(runtime.label, assignments);

    // (1) 禁止された変数名がランタイムに渡っていないこと。
    for (const assignment of assignments) {
      const inVars = /(^|\.)vars$/.test(assignment.path);
      if (!inVars) continue;
      if (FORBIDDEN_RUNTIME_NAMES.includes(assignment.key)) {
        violations.push(
          `${runtime.label}: ${assignment.key} must never be a runtime var ` +
            `(${path.relative(args.root, runtime.file)}:${assignment.line})`,
        );
      }
      if (SECRET_ONLY_NAMES.includes(assignment.key)) {
        violations.push(
          `${runtime.label}: ${assignment.key} is a secret and must be set with ` +
            `\`wrangler secret put\`, not [vars] ` +
            `(${path.relative(args.root, runtime.file)}:${assignment.line})`,
        );
      }
    }

    // (2) APP_ENV が environment 名と一致していること。
    for (const [envName, expected] of Object.entries(ENV_APP_ENV)) {
      const appEnv = assignments.find(
        (a) => a.env === envName && /(^|\.)vars$/.test(a.path) && a.key === "APP_ENV",
      );
      if (appEnv === undefined) {
        if (runtime.label === "cron") continue; // cron Worker は APP_ENV を持たない設計。
        pending.push(`${runtime.label}: [env.${envName || "default"}.vars] has no APP_ENV`);
        continue;
      }
      if (appEnv.value !== expected) {
        violations.push(
          `${runtime.label}: [env.${envName || "default"}.vars] APP_ENV is '${appEnv.value}', expected '${expected}'`,
        );
      } else {
        ok.push(`${runtime.label}: APP_ENV of '${envName || "default"}' is '${expected}'`);
      }
    }

    // (3) staging と production が同じ値を共有していないこと
    //     （＝本番の Hyperdrive ID・本番のサービス名・本番の ref が staging に混入していない）。
    const stagingValues = new Map();
    for (const a of assignments) {
      if (a.env !== "staging") continue;
      if (a.value.length < 8) continue;
      if (SHARED_VALUE_EXEMPT_KEYS.includes(a.key)) continue;
      stagingValues.set(a.value, a);
    }
    for (const a of assignments) {
      if (a.env !== "production") continue;
      if (a.value.length < 8) continue;
      if (SHARED_VALUE_EXEMPT_KEYS.includes(a.key)) continue;
      const clash = stagingValues.get(a.value);
      if (clash !== undefined) {
        violations.push(
          `${runtime.label}: value shared between staging and production ` +
            `([${clash.path}] ${clash.key} == [${a.path}] ${a.key}) — ` +
            `staging must not reference any production resource`,
        );
      }
    }
    if (assignments.some((a) => a.env === "staging") && assignments.some((a) => a.env === "production")) {
      ok.push(`${runtime.label}: staging and production share no non-trivial value`);
    }
  }

  // (4) docs/ops/env-baseline.json（期待名の正本。task_035 が作る）。
  const baselinePath = path.join(args.root, "docs/ops/env-baseline.json");
  if (existsSync(baselinePath)) {
    let baseline;
    try {
      baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    } catch {
      violations.push("docs/ops/env-baseline.json is not valid JSON");
      baseline = undefined;
    }
    if (baseline !== undefined) {
      checkBaseline(baseline, byRuntime, { violations, pending, ok, root: args.root });
    }
  } else {
    pending.push(
      "docs/ops/env-baseline.json not found — expected-name comparison is deferred to task_035 " +
        "(the runtime/staging/production leak checks above still ran)",
    );
  }

  // (5) 必須の秘密値の名前が雛形のどこかにあること（値ではなく名前だけを見る）。
  const templates = [".dev.vars.example", ".env.example"]
    .map((name) => ({ name, file: path.join(args.root, name) }))
    .filter((t) => existsSync(t.file));
  if (templates.length === 0) {
    pending.push("no .dev.vars.example / .env.example found — secret name template check skipped");
  } else {
    const documented = new Map();
    for (const template of templates) {
      const { names, commented } = readEnvNames(readFileSync(template.file, "utf8"));
      for (const name of names) documented.set(name, template.name);
      for (const name of commented) {
        if (!documented.has(name)) documented.set(name, `${template.name} (commented out)`);
      }
    }
    for (const name of REQUIRED_SECRET_NAMES) {
      const where = documented.get(name);
      if (where === undefined) {
        violations.push(
          `${name} is required at startup but is not documented in .dev.vars.example / .env.example`,
        );
      } else {
        ok.push(`${name} is documented in ${where}`);
      }
    }
    // ローカル限定の逃げ道が .env.example の runtime 節に漏れていないこと。
    const envExample = templates.find((t) => t.name === ".env.example");
    if (envExample !== undefined) {
      const raw = readFileSync(envExample.file, "utf8");
      const start = raw.indexOf(">>> runtime");
      const end = raw.indexOf("<<< runtime");
      if (start >= 0 && end > start) {
        const section = raw.slice(start, end);
        for (const name of ["ALLOW_PRIVILEGED_DB_ROLE", "ALLOW_LOCAL_RATE_LIMIT_BYPASS"]) {
          if (section.includes(name)) {
            violations.push(`${name} must not appear in the runtime section of .env.example`);
          }
        }
        ok.push(".env.example runtime section carries no local-only escape hatch");
      }
    }
  }

  // (6) ライブ検査（wrangler CLI が認証済みのときだけ）。
  if (!args.live) {
    notes.push("live check skipped (--no-live)");
  } else if (args.root !== REPO_ROOT) {
    notes.push("live check skipped (--root points at a fixture, not the real project)");
  } else {
    const authenticated =
      typeof process.env.CLOUDFLARE_API_TOKEN === "string" &&
      process.env.CLOUDFLARE_API_TOKEN.length > 0;
    if (!authenticated) {
      notes.push(
        "**静的検査のみで判定した**: wrangler CLI が未認証（CLOUDFLARE_API_TOKEN 未設定）のため " +
          "`wrangler secret list` との突き合わせは行っていない。CI 接続は task_024。",
      );
    } else {
      for (const envName of ["staging", "production"]) {
        try {
          const raw = execFileSync(
            "npx",
            ["--no-install", "wrangler", "secret", "list", "--env", envName],
            { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
          );
          const remoteNames = [...raw.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
          for (const name of REQUIRED_SECRET_NAMES) {
            if (!remoteNames.includes(name)) {
              violations.push(`${envName}: secret '${name}' is not set on the deployed Worker`);
            }
          }
          for (const name of FORBIDDEN_RUNTIME_NAMES) {
            if (remoteNames.includes(name)) {
              violations.push(`${envName}: secret '${name}' must not exist on the Worker`);
            }
          }
          ok.push(`${envName}: wrangler secret list cross-check ran (${remoteNames.length} names)`);
        } catch (error) {
          notes.push(
            `**静的検査のみで判定した**（${envName}）: \`wrangler secret list\` を実行できなかった ` +
              `(${error instanceof Error ? error.message.split("\n")[0] : "unknown error"})`,
          );
        }
      }
    }
  }

  report({ violations, pending, notes, ok });
  process.exit(violations.length > 0 ? 1 : 0);
}

/**
 * `docs/ops/env-baseline.json` の形（task_035 が作る想定。存在しないうちは pending）:
 * {
 *   "runtimes": {
 *     "main": { "staging": { "vars": ["APP_ENV"], "bindings": ["HYPERDRIVE"], "secrets": ["PEPPER"] } }
 *   },
 *   "production_only_values": ["<production project ref>", "<production liff id>"]
 * }
 */
function checkBaseline(baseline, byRuntime, sink) {
  const runtimes = baseline.runtimes ?? {};
  for (const [label, environments] of Object.entries(runtimes)) {
    const assignments = byRuntime.get(label);
    if (assignments === undefined) {
      sink.pending.push(`baseline mentions runtime '${label}' but its wrangler.toml was not read`);
      continue;
    }
    for (const [envName, expected] of Object.entries(environments)) {
      const envKey = envName === "default" ? "" : envName;
      for (const varName of expected.vars ?? []) {
        const found = assignments.some(
          (a) => a.env === envKey && /(^|\.)vars$/.test(a.path) && a.key === varName,
        );
        if (found) {
          sink.ok.push(`${label}/${envName}: var '${varName}' present`);
        } else {
          sink.violations.push(`${label}/${envName}: expected var '${varName}' is missing`);
        }
      }
      for (const bindingName of expected.bindings ?? []) {
        const found = assignments.some((a) => a.env === envKey && a.key === "binding" && a.value === bindingName);
        if (found) {
          sink.ok.push(`${label}/${envName}: binding '${bindingName}' present`);
        } else {
          sink.violations.push(`${label}/${envName}: expected binding '${bindingName}' is missing`);
        }
      }
    }
  }

  const productionOnly = baseline.production_only_values ?? [];
  for (const [label, assignments] of byRuntime.entries()) {
    for (const assignment of assignments) {
      if (assignment.env === "production") continue;
      for (const secretValue of productionOnly) {
        if (typeof secretValue !== "string" || secretValue.length < 4) continue;
        if (assignment.value.includes(secretValue)) {
          sink.violations.push(
            `${label}: production-only value appears outside [env.production] ` +
              `([${assignment.path}] ${assignment.key})`,
          );
        }
      }
    }
  }
  if (productionOnly.length > 0) {
    sink.ok.push(`production_only_values: ${productionOnly.length} value(s) checked against non-production scopes`);
  } else {
    sink.pending.push(
      "docs/ops/env-baseline.json has no production_only_values — " +
        "add the production Supabase project ref / LIFF ID / Hyperdrive id there (task_035 / task_024)",
    );
  }
}

function report(result) {
  for (const line of result.ok) console.log(`ok      ${line}`);
  for (const line of result.pending) console.log(`pending ${line}`);
  for (const line of result.notes) console.log(`note    ${line}`);
  for (const line of result.violations) console.log(`VIOLATION ${line}`);
  console.log(
    `\ngate:env — ${result.violations.length} violation(s), ${result.pending.length} pending, ${result.ok.length} check(s) passed`,
  );
}

main();
