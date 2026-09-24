import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

// Every case spawns `node scripts/wording-lint.mjs` (and some also spawn git),
// so the wall clock is dominated by process startup rather than by the
// assertions. Same reason as tests/unit/gate-constraints.test.ts: the budget is
// raised, no assertion is relaxed.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const lintScript = path.join(repoRoot, "scripts", "wording-lint.mjs");
const realPolicyPath = path.join(repoRoot, "docs", "wording-policy.md");

interface ForbiddenEntry {
  id: string;
  patterns: string[];
  globs: string[];
  expect_targets: string;
  regex?: boolean;
  exclude_globs?: string[];
  reason?: string;
}

interface Policy {
  global_exclude_globs?: string[];
  allowed_phrases?: string[];
  forbidden: ForbiddenEntry[];
}

interface LintResult {
  status: number;
  stdout: string;
  stderr: string;
}

const MARKER_BEGIN = "<!-- machine-readable:begin -->";
const MARKER_END = "<!-- machine-readable:end -->";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wording-lint-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, rel: string, contents: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
}

function writePolicy(root: string, policy: Policy): string {
  const md = [
    "# fixture policy",
    "",
    MARKER_BEGIN,
    "```json",
    JSON.stringify(policy, null, 2),
    "```",
    MARKER_END,
    "",
  ].join("\n");
  writeFile(root, "policy.md", md);
  return path.join(root, "policy.md");
}

/**
 * Turns a fixture directory into a real git repository so the linter takes the
 * `git ls-files` branch instead of the `fs.readdir` fallback. `core.quotePath`
 * stays ON (git's default) because that is the condition under which non-ASCII
 * paths used to fall out of every pattern group.
 */
function initGitRepo(root: string): void {
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const init = git("init", "-q");
  expect(init.status, `git init failed: ${init.stderr}`).toBe(0);
  git("config", "user.email", "lint@example.invalid");
  git("config", "user.name", "lint fixture");
  git("config", "core.quotePath", "true");
}

function gitAddAll(root: string): void {
  const res = spawnSync("git", ["-C", root, "add", "-A"], { encoding: "utf8" });
  expect(res.status, `git add failed: ${res.stderr}`).toBe(0);
}

function runLint(root: string, policyPath: string): LintResult {
  const res = spawnSync(
    "node",
    [
      lintScript,
      "--root",
      root,
      "--policy",
      policyPath,
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

function readRealPolicy(): Policy {
  const md = fs.readFileSync(realPolicyPath, "utf8");
  const start = md.indexOf(MARKER_BEGIN);
  const end = md.indexOf(MARKER_END);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = md.slice(start + MARKER_BEGIN.length, end);
  const fenceStart = block.indexOf("```json");
  const fenceEnd = block.indexOf("```", fenceStart + 7);
  expect(fenceStart).toBeGreaterThan(-1);
  expect(fenceEnd).toBeGreaterThan(fenceStart);
  return JSON.parse(block.slice(fenceStart + 7, fenceEnd)) as Policy;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("docs/wording-policy.md", () => {
  const policy = readRealPolicy();

  it("declares id / patterns / globs / expect_targets for every forbidden group", () => {
    expect(policy.forbidden.length).toBeGreaterThan(0);
    for (const entry of policy.forbidden) {
      expect(typeof entry.id, "id").toBe("string");
      expect(entry.patterns.length, `${entry.id} patterns`).toBeGreaterThan(0);
      expect(entry.globs.length, `${entry.id} globs`).toBeGreaterThan(0);
      expect(
        entry.expect_targets === "now" || /^from_task_\d{3}$/.test(entry.expect_targets),
        `${entry.id} expect_targets=${entry.expect_targets}`,
      ).toBe(true);
    }
  });

  it("keeps docs/research and docs/inquiries out of the scan", () => {
    const excluded = policy.global_exclude_globs ?? [];
    expect(excluded).toContain("docs/research/**");
    expect(excluded).toContain("docs/inquiries/**");
  });

  it("covers every forbidden word named in the task scope", () => {
    const allPatterns = policy.forbidden.flatMap((e) => e.patterns).join("\n");
    for (const word of [
      "自動チェック",
      "自動で確認",
      "入金を確認しました",
      "寄付",
      "募金",
      "投げ銭",
      "カンパ",
      "支援",
      "応援",
      "クラウドファンディング",
      "チャリティ",
      "領収書",
      "インボイス",
      "適格請求書",
      "記入例",
      "審査の通し方",
    ]) {
      expect(allPatterns, word).toContain(word);
    }
  });
});

describe("scripts/wording-lint.mjs (fixture policy)", () => {
  const basePolicy: Policy = {
    global_exclude_globs: ["docs/research/**", "docs/inquiries/**"],
    allowed_phrases: ["会費受領記録"],
    forbidden: [
      {
        id: "W-FIXTURE",
        patterns: ["寄付"],
        globs: ["src/**/*.ts"],
        expect_targets: "now",
      },
    ],
  };

  it("reports a forbidden word as '<id> <file>:<line>' and exits 1", () => {
    const root = makeTempRepo();
    const policyPath = writePolicy(root, basePolicy);
    writeFile(root, "src/ui.ts", 'const a = "ok";\nconst b = "寄付を受け付けます";\n');

    const res = runLint(root, policyPath);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("W-FIXTURE src/ui.ts:2");
  });

  it("exits 0 when the target files are clean", () => {
    const root = makeTempRepo();
    const policyPath = writePolicy(root, basePolicy);
    writeFile(root, "src/ui.ts", 'const a = "会費受領記録";\n');

    const res = runLint(root, policyPath);

    expect(res.status).toBe(0);
  });

  it("does not scan docs/research or docs/inquiries", () => {
    const root = makeTempRepo();
    const policyPath = writePolicy(root, {
      ...basePolicy,
      forbidden: [
        {
          id: "W-FIXTURE",
          patterns: ["寄付"],
          globs: ["src/**/*.ts", "docs/**/*.md"],
          expect_targets: "now",
        },
      ],
    });
    writeFile(root, "src/ui.ts", "const a = 1;\n");
    writeFile(root, "docs/research/consolidated.md", "寄付という語は一次資料に出る\n");
    writeFile(root, "docs/inquiries/lawyer.md", "寄付の該当性について照会する\n");

    const res = runLint(root, policyPath);

    expect(res.status).toBe(0);
  });

  it("expands a brace glob so both alternatives are scanned", () => {
    const root = makeTempRepo();
    const policyPath = writePolicy(root, {
      ...basePolicy,
      forbidden: [
        {
          id: "W-FIXTURE",
          patterns: ["寄付"],
          globs: ["src/**/*.{ts,tsx}"],
          expect_targets: "now",
        },
      ],
    });
    writeFile(root, "src/ok.tsx", "export const ok = 1;\n");
    writeFile(root, "src/bad.ts", 'export const label = "寄付";\n');

    const res = runLint(root, policyPath);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("W-FIXTURE src/bad.ts:1");
  });

  it("exits 1 when an expect_targets=now group has zero files to scan", () => {
    const root = makeTempRepo();
    const policyPath = writePolicy(root, basePolicy);
    writeFile(root, "README.md", "no source files at all\n");

    const res = runLint(root, policyPath);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("EMPTY W-FIXTURE");
  });

  it("scans a non-ASCII path inside a git repo with core.quotePath on", () => {
    const root = makeTempRepo();
    initGitRepo(root);
    const policyPath = writePolicy(root, basePolicy);
    writeFile(root, "src/ok.ts", 'const a = "ok";\n');
    writeFile(root, "src/集金.ts", 'const b = "寄付を受け付けます";\n');
    gitAddAll(root);

    const res = runLint(root, policyPath);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("W-FIXTURE src/集金.ts:1");
  });

  it("fails closed when every target is tracked but gone from the working tree", () => {
    const root = makeTempRepo();
    initGitRepo(root);
    const policyPath = writePolicy(root, basePolicy);
    writeFile(root, "src/a.ts", 'const a = "ok";\n');
    gitAddAll(root);
    fs.rmSync(path.join(root, "src", "a.ts"));

    const res = runLint(root, policyPath);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("UNREADABLE W-FIXTURE");
    expect(res.stdout).toContain("W-FIXTURE src/a.ts:1");
  });

  it("fails closed when the only target is bigger than the scan limit", () => {
    const root = makeTempRepo();
    const policyPath = writePolicy(root, basePolicy);
    writeFile(root, "src/a.ts", `// ${"x".repeat(2 * 1024 * 1024)}\nconst b = "寄付";\n`);

    const res = runLint(root, policyPath);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("over the 2097152-byte scan limit");
    expect(res.stderr).toContain("UNREADABLE W-FIXTURE");
  });

  it("tolerates zero targets while the declared task is not DONE, and fails once it is", () => {
    const root = makeTempRepo();
    const policyPath = writePolicy(root, {
      ...basePolicy,
      forbidden: [
        {
          id: "W-LATER",
          patterns: ["記入例"],
          globs: ["docs/pilot/**/*.md"],
          expect_targets: "from_task_025",
        },
      ],
    });
    writeFile(root, "README.md", "no pilot material yet\n");
    writeFile(
      root,
      "task-list.json",
      `${JSON.stringify({ tasks: [{ task_id: "task_025", completion_status: null }] }, null, 2)}\n`,
    );

    const deferred = runLint(root, policyPath);
    expect(deferred.status).toBe(0);

    writeFile(
      root,
      "task-list.json",
      `${JSON.stringify({ tasks: [{ task_id: "task_025", completion_status: "DONE" }] }, null, 2)}\n`,
    );
    writeFile(root, "run-log/task_025.json", "[]\n");

    const enforced = runLint(root, policyPath);
    expect(enforced.status).toBe(1);
    expect(enforced.stderr).toContain("EMPTY W-LATER");
  });
});

describe("scripts/wording-lint.mjs (real policy against a fixture tree)", () => {
  it("flags 自動照合 but not the approved 『自動照合ではありません』", () => {
    const root = makeTempRepo();
    writeFile(root, "src/ui.ts", 'const badge = "幹事が手動で確認（自動照合ではありません）";\n');
    const clean = runLint(root, realPolicyPath);
    expect(clean.status).toBe(0);

    writeFile(root, "src/ui.ts", 'const badge = "自動照合しました";\n');
    const flagged = runLint(root, realPolicyPath);
    expect(flagged.status).toBe(1);
    expect(flagged.stdout).toContain("W-AUTO src/ui.ts:1");
  });

  it("flags 『入金を確認しました』 and donation vocabulary", () => {
    const root = makeTempRepo();
    writeFile(
      root,
      "src/ui.ts",
      'const a = "入金を確認しました";\nconst b = "クラウドファンディング";\nconst c = "領収書";\n',
    );

    const res = runLint(root, realPolicyPath);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("W-AUTO src/ui.ts:1");
    expect(res.stdout).toContain("W-DONATION src/ui.ts:2");
    expect(res.stdout).toContain("W-RECEIPT src/ui.ts:3");
  });

  it("flags a concrete fee rate but not an undetermined-fee sentence", () => {
    const root = makeTempRepo();
    writeFile(root, "src/ui.ts", 'const note = "決済手数料は幹事のご負担です";\n');
    const clean = runLint(root, realPolicyPath);
    expect(clean.status).toBe(0);

    writeFile(root, "src/ui.ts", 'const note = "決済手数料は3.8%です";\n');
    const rate = runLint(root, realPolicyPath);
    expect(rate.status).toBe(1);
    expect(rate.stdout).toContain("W-FEE-FIXED src/ui.ts:1");

    writeFile(root, "src/ui.ts", 'const note = "手数料は無料です";\n');
    const free = runLint(root, realPolicyPath);
    expect(free.status).toBe(1);
    expect(free.stdout).toContain("W-FEE-FIXED src/ui.ts:1");
  });
});
