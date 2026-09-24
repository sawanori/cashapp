import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

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
