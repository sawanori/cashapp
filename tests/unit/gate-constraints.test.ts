import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

// The subject under test is a shell script that shells out to jq / grep / xargs
// once per constraint entry: one `runRealGate` against the real 57-entry ledger
// measures ~4s on this repo's CI-class hardware, which sits right on vitest's
// 5000ms default and made this file flake (reported by task_007 / task_013 as
// "Test timed out in 5000ms"). The budget is raised; no assertion is relaxed.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const gateScript = path.join(repoRoot, "scripts", "gate-constraints.sh");
const constraintsPath = path.join(repoRoot, "docs", "constraints.json");

type Enforcement = "grep" | "test" | "manual";
type MatchMode = "forbid" | "require";

interface ConstraintEntry {
  id: string;
  text: string;
  confidence: string;
  source: string;
  enforcement: Enforcement;
  match_mode?: MatchMode;
  grep_patterns: string[];
  globs: string[];
  exclude_globs?: string[];
  allow_if_line_matches?: string[];
  expect_targets: string;
}

interface ConstraintsFile {
  constraints: ConstraintEntry[];
  gate_only_checks: ConstraintEntry[];
  global_exclude_globs: string[];
}

interface GateResult {
  status: number;
  stdout: string;
  stderr: string;
}

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-constraints-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, rel: string, contents: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
}

function runGate(root: string, extraArgs: string[] = []): GateResult {
  const res = spawnSync(
    "bash",
    [
      gateScript,
      "--root",
      root,
      "--constraints",
      path.join(root, "constraints.json"),
      "--task-list",
      path.join(root, "task-list.json"),
      "--run-log-dir",
      path.join(root, "run-log"),
      "--quiet",
      ...extraArgs,
    ],
    { encoding: "utf8" },
  );
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function writeConstraints(root: string, entries: Partial<ConstraintEntry>[]): void {
  const full = entries.map((e) => ({
    id: e.id ?? "T-X",
    text: e.text ?? "fixture constraint",
    confidence: e.confidence ?? "高",
    source: e.source ?? "fixture",
    enforcement: e.enforcement ?? "grep",
    match_mode: e.match_mode ?? "forbid",
    grep_patterns: e.grep_patterns ?? [],
    globs: e.globs ?? [],
    exclude_globs: e.exclude_globs ?? [],
    allow_if_line_matches: e.allow_if_line_matches ?? [],
    expect_targets: e.expect_targets ?? "now",
  }));
  writeFile(
    root,
    "constraints.json",
    `${JSON.stringify({ constraints: full, gate_only_checks: [], global_exclude_globs: [] }, null, 2)}\n`,
  );
}

/**
 * Turns a fixture directory into a real git repository so the gate takes the
 * `git ls-files` branch instead of the `find` fallback. `core.quotePath` is
 * left ON on purpose: that is git's default and the condition under which
 * non-ASCII paths used to fall out of every scan.
 */
function initGitRepo(root: string): void {
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const init = git("init", "-q");
  expect(init.status, `git init failed: ${init.stderr}`).toBe(0);
  git("config", "user.email", "gate@example.invalid");
  git("config", "user.name", "gate fixture");
  git("config", "core.quotePath", "true");
}

function gitAddAll(root: string): void {
  const res = spawnSync("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
  expect(res.status, `git add failed: ${res.stderr}`).toBe(0);
}

function markTaskDone(root: string, taskId: string): void {
  writeFile(
    root,
    "task-list.json",
    `${JSON.stringify({ tasks: [{ task_id: taskId, completion_status: "DONE" }] }, null, 2)}\n`,
  );
  writeFile(root, `run-log/${taskId}.json`, "[]\n");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("docs/constraints.json", () => {
  const parsed = JSON.parse(fs.readFileSync(constraintsPath, "utf8")) as ConstraintsFile;

  it("holds exactly 54 constraints (51 from consolidated.md §6 + 3 cross-cutting)", () => {
    expect(parsed.constraints).toHaveLength(54);
  });

  it("covers every id of L1-L12 / P1-P9 / W1-W12 / N1-N12 / I1-I6 plus X-TIME / X-ID / X-MONEY", () => {
    const expected: string[] = [];
    for (let i = 1; i <= 12; i += 1) expected.push(`L${i}`);
    for (let i = 1; i <= 9; i += 1) expected.push(`P${i}`);
    for (let i = 1; i <= 12; i += 1) expected.push(`W${i}`);
    for (let i = 1; i <= 12; i += 1) expected.push(`N${i}`);
    for (let i = 1; i <= 6; i += 1) expected.push(`I${i}`);
    expected.push("X-TIME", "X-ID", "X-MONEY");

    const actual = parsed.constraints.map((c) => c.id);
    expect([...actual].sort()).toEqual([...expected].sort());
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("gives every entry an expect_targets of 'now' or 'from_task_XXX'", () => {
    const all = [...parsed.constraints, ...parsed.gate_only_checks];
    for (const entry of all) {
      expect(typeof entry.expect_targets, `${entry.id} expect_targets`).toBe("string");
      expect(
        entry.expect_targets === "now" || /^from_task_\d{3}$/.test(entry.expect_targets),
        `${entry.id} expect_targets=${entry.expect_targets}`,
      ).toBe(true);
    }
  });

  it("declares a supported enforcement for every entry and patterns for every grep entry", () => {
    const all = [...parsed.constraints, ...parsed.gate_only_checks];
    for (const entry of all) {
      expect(["grep", "test", "manual"], `${entry.id} enforcement`).toContain(entry.enforcement);
      if (entry.enforcement === "grep") {
        expect(entry.grep_patterns.length, `${entry.id} grep_patterns`).toBeGreaterThan(0);
        expect(entry.globs.length, `${entry.id} globs`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the Vercel-era wording of I1 / I2 as superseded rather than deleting it", () => {
    for (const id of ["I1", "I2"]) {
      const entry = parsed.constraints.find((c) => c.id === id);
      expect(entry, id).toBeDefined();
      const record = entry as unknown as { superseded?: { original_text?: string } };
      expect(record.superseded?.original_text, `${id} superseded.original_text`).toBeTruthy();
    }
  });
});

describe("scripts/gate-constraints.sh", () => {
  it("reports a forbidden match as '<id> <file>:<line>' and exits 1", () => {
    const root = makeTempRepo();
    writeConstraints(root, [
      { id: "T-FORBID", grep_patterns: ["forbiddenToken"], globs: ["src/**/*.ts"] },
    ]);
    writeFile(root, "src/lib/a.ts", "const ok = 1;\n// nothing here\nconst bad = forbiddenToken;\n");

    const res = runGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("T-FORBID src/lib/a.ts:3");
  });

  it("exits 0 when the same gate has targets but no match", () => {
    const root = makeTempRepo();
    writeConstraints(root, [
      { id: "T-FORBID", grep_patterns: ["forbiddenToken"], globs: ["src/**/*.ts"] },
    ]);
    writeFile(root, "src/lib/a.ts", "const ok = 1;\n");

    const res = runGate(root);

    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("T-FORBID");
  });

  it("exits 1 when an expect_targets=now gate has zero files to scan", () => {
    const root = makeTempRepo();
    writeConstraints(root, [
      {
        id: "T-EMPTY",
        grep_patterns: ["forbiddenToken"],
        globs: ["src/**/*.ts"],
        expect_targets: "now",
      },
    ]);
    writeFile(root, "README.md", "no source files at all\n");

    const res = runGate(root);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("EMPTY T-EMPTY");
  });

  it("tolerates zero targets while the declared task is not DONE", () => {
    const root = makeTempRepo();
    writeConstraints(root, [
      {
        id: "T-DEFER",
        grep_patterns: ["forbiddenToken"],
        globs: ["src/lib/ledger/**/*.ts"],
        expect_targets: "from_task_018",
      },
    ]);
    writeFile(root, "README.md", "no ledger yet\n");
    writeFile(
      root,
      "task-list.json",
      `${JSON.stringify({ tasks: [{ task_id: "task_018", completion_status: null }] }, null, 2)}\n`,
    );

    const res = runGate(root);

    expect(res.status).toBe(0);
  });

  it("exits 1 for zero targets once the declared task is DONE", () => {
    const root = makeTempRepo();
    writeConstraints(root, [
      {
        id: "T-DEFER",
        grep_patterns: ["forbiddenToken"],
        globs: ["src/lib/ledger/**/*.ts"],
        expect_targets: "from_task_018",
      },
    ]);
    writeFile(root, "README.md", "still no ledger\n");
    markTaskDone(root, "task_018");

    const res = runGate(root);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("EMPTY T-DEFER");
  });

  it("flags a target file that is missing a required pattern (match_mode=require)", () => {
    const root = makeTempRepo();
    writeConstraints(root, [
      {
        id: "T-REQUIRE",
        match_mode: "require",
        grep_patterns: ["import[[:space:]]+[\"']server-only[\"']"],
        globs: ["src/lib/db/client.ts"],
      },
    ]);
    writeFile(root, "src/lib/db/client.ts", "export const db = null;\n");

    const missing = runGate(root);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("T-REQUIRE src/lib/db/client.ts:1");

    writeFile(root, "src/lib/db/client.ts", 'import "server-only";\nexport const db = null;\n');
    const present = runGate(root);
    expect(present.status).toBe(0);
  });

  it("does not flag a line covered by allow_if_line_matches", () => {
    const root = makeTempRepo();
    writeConstraints(root, [
      {
        id: "T-ALLOW",
        grep_patterns: ["status[[:space:]]*=[[:space:]]*[\"']paid[\"']"],
        globs: ["src/**/*.ts"],
        allow_if_line_matches: ["(status_rank|statusRank)"],
      },
    ]);
    writeFile(
      root,
      "src/lib/apply.ts",
      'update({ status = "paid" }, { where: statusRank < next });\n',
    );

    const allowed = runGate(root);
    expect(allowed.status).toBe(0);

    writeFile(root, "src/lib/apply.ts", 'update({ status = "paid" });\n');
    const flagged = runGate(root);
    expect(flagged.status).toBe(1);
    expect(flagged.stdout).toContain("T-ALLOW src/lib/apply.ts:1");
  });

  it("honours exclude_globs", () => {
    const root = makeTempRepo();
    writeConstraints(root, [
      {
        id: "T-EXCLUDE",
        grep_patterns: ["forbiddenToken"],
        globs: ["src/**/*.ts"],
        exclude_globs: ["src/lib/payments/providers/**"],
      },
    ]);
    writeFile(root, "src/lib/payments/providers/x.ts", "const a = forbiddenToken;\n");
    writeFile(root, "src/lib/other.ts", "const b = 1;\n");

    const res = runGate(root);

    expect(res.status).toBe(0);
  });

  it("scans a non-ASCII path inside a git repo with core.quotePath on", () => {
    const root = makeTempRepo();
    initGitRepo(root);
    writeConstraints(root, [
      { id: "T-FORBID", grep_patterns: ["forbiddenToken"], globs: ["src/**/*.ts"] },
    ]);
    writeFile(root, "src/ok.ts", "const ok = 1;\n");
    writeFile(root, "src/集金.ts", "const bad = forbiddenToken;\n");
    gitAddAll(root);

    const res = runGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("T-FORBID src/集金.ts:1");
  });

  it("fails closed when every target is tracked but gone from the working tree", () => {
    const root = makeTempRepo();
    initGitRepo(root);
    writeConstraints(root, [
      { id: "T-GONE", grep_patterns: ["forbiddenToken"], globs: ["src/**/*.ts"] },
    ]);
    writeFile(root, "src/a.ts", "const a = 1;\n");
    gitAddAll(root);
    fs.rmSync(path.join(root, "src", "a.ts"));

    const res = runGate(root);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("UNREADABLE T-GONE");
    expect(res.stdout).toContain("T-GONE src/a.ts:1");
  });

  it("reports an unreadable target while still scanning the readable ones", () => {
    const root = makeTempRepo();
    initGitRepo(root);
    writeConstraints(root, [
      { id: "T-PART", grep_patterns: ["forbiddenToken"], globs: ["src/**/*.ts"] },
    ]);
    writeFile(root, "src/a.ts", "const bad = forbiddenToken;\n");
    writeFile(root, "src/b.ts", "const b = 1;\n");
    gitAddAll(root);
    fs.rmSync(path.join(root, "src", "b.ts"));

    const res = runGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("T-PART src/b.ts:1");
    expect(res.stdout).toContain("T-PART src/a.ts:1");
    expect(res.stderr).not.toContain("UNREADABLE T-PART");
  });

  it("exits 2 on a grep pattern that grep itself refuses to compile", () => {
    const root = makeTempRepo();
    writeConstraints(root, [
      { id: "T-REGEX", grep_patterns: ["("], globs: ["src/**/*.ts"] },
    ]);
    writeFile(root, "src/a.ts", "export const value = 1;\n");

    const res = runGate(root);

    expect(res.status).toBe(2);
    expect(res.stderr).toContain("CONFIG T-REGEX");
  });

  it("exits 2 on an allow_if_line_matches pattern grep refuses to compile", () => {
    const root = makeTempRepo();
    writeConstraints(root, [
      {
        id: "T-ALLOW-REGEX",
        grep_patterns: ["forbiddenToken"],
        globs: ["src/**/*.ts"],
        allow_if_line_matches: ["a[b"],
      },
    ]);
    writeFile(root, "src/a.ts", "export const value = 1;\n");

    const res = runGate(root);

    expect(res.status).toBe(2);
    expect(res.stderr).toContain("CONFIG T-ALLOW-REGEX");
  });

  it("exits 2 on a structurally invalid constraints file", () => {
    const root = makeTempRepo();
    writeFile(
      root,
      "constraints.json",
      `${JSON.stringify({ constraints: [{ id: "T-BROKEN", enforcement: "grep" }] }, null, 2)}\n`,
    );
    writeFile(root, "src/a.ts", "const a = 1;\n");

    const res = runGate(root);

    expect(res.status).toBe(2);
    expect(res.stderr).toContain("T-BROKEN");
  });
});

describe("scripts/gate-constraints.sh (real docs/constraints.json against a fixture tree)", () => {
  /**
   * Every `expect_targets: "now"` entry in the real ledger needs at least one
   * file to look at, otherwise the gate fails for "empty gate" reasons before
   * it can demonstrate anything about its patterns. These stubs are the
   * minimum tree that satisfies all of them.
   */
  function seedCleanTree(root: string): void {
    writeFile(root, "src/app/page.ts", "export const page = 1;\n");
    writeFile(root, "src/app/view.tsx", "export const View = () => null;\n");
    writeFile(root, "tests/e2e/smoke.spec.ts", "export const smoke = 1;\n");
    writeFile(root, "wrangler.toml", '[placement]\nmode = "smart"\n');
    writeFile(root, "workers/cron/wrangler.toml", '[triggers]\ncrons = ["*/5 * * * *"]\n');
    writeFile(root, "task-list.json", `${JSON.stringify({ tasks: [] }, null, 2)}\n`);
  }

  function runRealGate(root: string): GateResult {
    const res = spawnSync(
      "bash",
      [
        gateScript,
        "--root",
        root,
        "--constraints",
        constraintsPath,
        "--task-list",
        path.join(root, "task-list.json"),
        "--run-log-dir",
        path.join(root, "run-log"),
        "--quiet",
      ],
      { encoding: "utf8" },
    );
    return {
      status: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  }

  it("passes on a clean tree", () => {
    const root = makeTempRepo();
    seedCleanTree(root);

    const res = runRealGate(root);

    expect(`${res.stdout}${res.stderr}`).not.toContain("EMPTY");
    expect(res.status).toBe(0);
  });

  it("catches the real forbidden patterns", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/app/page.ts",
      [
        'import Stripe from "stripe";',
        'const wallet = "アプリ内残高";',
        "liff.sendMessages([]);",
        "const p = liff.getDecodedIDToken();",
        'const cur = "USD";',
        'const donate = "寄付";',
        "window.localStorage.setItem(\"paid\", \"1\");",
        "const card = { cardNumber: \"4242\" };",
        "export { Stripe, wallet, p, cur, donate, card };",
      ].join("\n") + "\n",
    );
    writeFile(
      root,
      "src/app/view.tsx",
      [
        'import { drizzle } from "drizzle-orm";',
        "export const View = () => ({ dangerouslySetInnerHTML: { __html: drizzle } });",
      ].join("\n") + "\n",
    );

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    for (const id of ["P1", "L3", "N9", "N2", "L12", "N11", "N7", "L8", "I3", "GC-XSS"]) {
      expect(res.stdout, `${id} should have fired`).toContain(`${id} src/app/`);
    }
  });

  it("flags a paid write whose rank column is assigned but never compared (W3)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/update.ts",
      "export const query = \"UPDATE payments SET status = 'paid', status_rank = 2 WHERE id = $1\";\n",
    );

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("W3 src/lib/update.ts:1");
  });

  it("still exempts a paid write guarded by a rank comparison (W3)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/apply.ts",
      "export const query = \"UPDATE payments SET status = 'paid' WHERE status_rank < $2\";\n",
    );

    const res = runRealGate(root);

    expect(`${res.stdout}${res.stderr}`).not.toContain("W3 ");
    expect(res.status).toBe(0);
  });

  it("flags a dynamic import() of a payment SDK outside the adapter directory (P1)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/load-payment.ts",
      'export async function loadPayment() { return import("stripe"); }\n',
    );

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("P1 src/lib/load-payment.ts:1");
  });

  it("still allows a dynamic import() inside src/lib/payments/providers (P1)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/payments/providers/stripe.ts",
      'export const load = () => import("stripe");\n',
    );

    const res = runRealGate(root);

    expect(res.status).toBe(0);
  });

  it("flags a date column and a bare timestamp declared on the CREATE TABLE line (X-TIME)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "supabase/migrations/001.sql",
      "CREATE TABLE example (due_on date, created_at timestamp);\n",
    );

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("X-TIME supabase/migrations/001.sql:1");
  });

  it("still allows timestamptz and timestamp with time zone on one line (X-TIME)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "supabase/migrations/002.sql",
      "CREATE TABLE ok (a timestamptz, b timestamp with time zone NOT NULL, c timestamptz DEFAULT now());\n",
    );

    const res = runRealGate(root);

    expect(`${res.stdout}${res.stderr}`).not.toContain("X-TIME ");
    expect(res.status).toBe(0);
  });

  it("does not accept a commented-out server-only import (GC-SERVER-ONLY)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(root, "src/lib/db/client.ts", '// import "server-only";\nexport const db = null;\n');

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("GC-SERVER-ONLY src/lib/db/client.ts:1");
  });

  it("accepts an executed server-only import (GC-SERVER-ONLY)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(root, "src/lib/db/client.ts", 'import "server-only";\nexport const db = null;\n');
    writeFile(root, "src/lib/config/env.ts", 'import "server-only";\nexport const env = {};\n');

    const res = runRealGate(root);

    expect(res.status).toBe(0);
  });

  it("flags a DB import from a client .ts outside src/components (I3)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/hooks/use-db.ts",
      "'use client';\nimport postgres from 'postgres';\nexport const connect = () => postgres('postgres://localhost/db');\n",
    );

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("I3 src/hooks/use-db.ts:2");
  });

  it("still allows a DB import from a server module under src/lib (I3)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(root, "src/lib/server-db.ts", 'import postgres from "postgres";\nexport const c = postgres;\n');

    const res = runRealGate(root);

    expect(`${res.stdout}${res.stderr}`).not.toContain("I3 ");
    expect(res.status).toBe(0);
  });

  it("flags a rank comparison that moves the state backwards (W3)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/update.ts",
      "export const query = \"UPDATE payments SET status = 'paid', status_rank = 2 WHERE status_rank > 2\";\n",
    );

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("W3 src/lib/update.ts:1");
  });

  it("still exempts a forward guard written with the rank on the right (W3)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/apply2.ts",
      "export const query = \"UPDATE payments SET status = 'paid' WHERE $2 > status_rank\";\n",
    );

    const res = runRealGate(root);

    expect(`${res.stdout}${res.stderr}`).not.toContain("W3 ");
    expect(res.status).toBe(0);
  });

  it("flags a side-effect import and a spaced dynamic import of a payment SDK (P1)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/load-payment.ts",
      "import 'stripe';\nexport const loadPayment = () => import ('stripe');\n",
    );

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("P1 src/lib/load-payment.ts:1");
    expect(res.stdout).toContain("P1 src/lib/load-payment.ts:2");
  });

  it("flags timestamp(3) and an ALTER TABLE date column (X-TIME)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "supabase/migrations/003.sql",
      "CREATE TABLE example (created_at timestamp(3));\nALTER TABLE example ADD COLUMN due_on date;\n",
    );

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("X-TIME supabase/migrations/003.sql:1");
    expect(res.stdout).toContain("X-TIME supabase/migrations/003.sql:2");
  });

  it("still allows ALTER TABLE timestamptz and an English SQL comment (X-TIME)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "supabase/migrations/004.sql",
      [
        "-- the due date column is stored as timestamptz",
        "ALTER TABLE example ADD COLUMN created_at timestamptz NOT NULL;",
        "ALTER TABLE example ALTER COLUMN created_at TYPE timestamptz;",
        "CREATE TABLE ok2 (a timestamptz(3), b timestamptz);",
      ].join("\n") + "\n",
    );

    const res = runRealGate(root);

    expect(`${res.stdout}${res.stderr}`).not.toContain("X-TIME ");
    expect(res.status).toBe(0);
  });

  it("does not treat the SQL inequality <> as a forward rank guard (W3)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/update.ts",
      "export const query = \"UPDATE payments SET status = 'paid', status_rank = 2 WHERE status_rank <> 2\";\n",
    );

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("W3 src/lib/update.ts:1");
  });

  it("still exempts <= and >= rank guards (W3)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/apply3.ts",
      [
        "export const a = \"UPDATE payments SET status = 'paid' WHERE status_rank <= $2\";",
        "export const b = \"UPDATE payments SET status = 'paid' WHERE $2 >= status_rank\";",
      ].join("\n") + "\n",
    );

    const res = runRealGate(root);

    expect(`${res.stdout}${res.stderr}`).not.toContain("W3 ");
    expect(res.status).toBe(0);
  });

  it("does not accept a server-only import inside a block comment (GC-SERVER-ONLY)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/db/client.ts",
      '/*\nimport "server-only";\n*/\nexport const db = null;\n',
    );

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("GC-SERVER-ONLY src/lib/db/client.ts:1");
  });

  it("accepts a real server-only import that sits after a doc block comment (GC-SERVER-ONLY)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/db/client.ts",
      '/**\n * DB client. Connection strings look like postgres://user@host/db.\n */\nimport "server-only";\nexport const db = null;\n',
    );
    writeFile(root, "src/lib/config/env.ts", 'import "server-only";\nexport const env = {};\n');

    const res = runRealGate(root);

    expect(`${res.stdout}${res.stderr}`).not.toContain("GC-SERVER-ONLY ");
    expect(res.status).toBe(0);
  });

  it("still checks a .tsx under src/lib even though server .ts there is excluded (I3)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "src/lib/client-db.tsx",
      "'use client';\nimport postgres from 'postgres';\nexport const connect = postgres;\n",
    );

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("I3 src/lib/client-db.tsx:2");
  });

  it("still allows timestamp(3) with time zone (X-TIME)", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(
      root,
      "supabase/migrations/005.sql",
      "CREATE TABLE example (created_at timestamp(3) with time zone NOT NULL);\n",
    );

    const res = runRealGate(root);

    expect(`${res.stdout}${res.stderr}`).not.toContain("X-TIME ");
    expect(res.status).toBe(0);
  });

  it("fails an I1 / I2 tree whose required Cloudflare settings are missing", () => {
    const root = makeTempRepo();
    seedCleanTree(root);
    writeFile(root, "wrangler.toml", "name = \"cashapp\"\n");
    writeFile(root, "workers/cron/wrangler.toml", "name = \"cashapp-cron\"\n");

    const res = runRealGate(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("I1 wrangler.toml:1");
    expect(res.stdout).toContain("I2 workers/cron/wrangler.toml:1");
  });
});
