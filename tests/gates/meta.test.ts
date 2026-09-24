// tests/gates/meta.test.ts  —  npm run test:gate-meta
//
// メタゲート（G0 / check_064 / R-TH-01 / F12）。
//
// ゲートが緑であることは、2 つの全く違う事実のどちらかを意味しうる:
//   (a) 違反が無かった
//   (b) そもそも何も見ていなかった
// exit code はこの 2 つを区別しない。区別をつけるのがこのテストで、
// tests/gates/fixtures/violations/ に置いた反例を 1 本ずつ実際に走らせ、
// 対応するゲートが **非ゼロ終了し、かつ意図した違反行を出力する** ことを確かめる。
//
// 「非ゼロ終了」だけでは足りない。gate-constraints.sh は対象 0 件のゲートがあるだけで
// exit 1 になるので、フィクスチャのディレクトリを --root に渡すと無関係な理由でも
// 非ゼロになる。meta.json の expect_output_contains が「意図した違反で落ちた」ことを固定する。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixturesDir = path.join(repoRoot, "tests", "gates", "fixtures", "violations");

/** §15-2 のゲート表。1 件でも反例を持たないゲートがあってはならない。 */
const GATE_IDS = [
  "G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7",
  "G8", "G9", "G10", "G11", "G12", "G13", "G14",
] as const;

const MIN_RUNNABLE_FIXTURES = 10;

interface Runner {
  cmd: string;
  args: string[];
}

interface FixtureMeta {
  fixture_id: string;
  gate: string | string[];
  description: string;
  runner: Runner | null;
  blocked_on?: string;
  expect_exit_nonzero: boolean;
  expect_output_contains: string;
  inputs?: Record<string, string>;
  absent?: string[];
  provenance: { authored_by: string; kind: string; note?: string };
}

interface Fixture {
  dir: string;
  abs: string;
  meta: FixtureMeta;
}

function loadFixtures(): Fixture[] {
  const names = fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return names.map((name) => {
    const abs = path.join(fixturesDir, name);
    const meta = JSON.parse(fs.readFileSync(path.join(abs, "meta.json"), "utf8")) as FixtureMeta;
    return { dir: name, abs, meta };
  });
}

function run(runner: Runner, fixtureAbs: string): { status: number; output: string } {
  const args = runner.args.map((a) => (a === "{FIXTURE}" ? fixtureAbs : a));
  const result = spawnSync(runner.cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const fixtures = loadFixtures();
const runnable = fixtures.filter((f) => f.meta.runner !== null);
const pending = fixtures.filter((f) => f.meta.runner === null);

interface TaskListFile {
  tasks: { task_id: string; completion_status: string | null }[];
}

const taskList = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "docs", "task-list.json"), "utf8"),
) as TaskListFile;

describe("違反フィクスチャの集合", () => {
  it("実行可能な反例が 10 本以上ある", () => {
    expect(runnable.length).toBeGreaterThanOrEqual(MIN_RUNNABLE_FIXTURES);
  });

  it("G0〜G14 のすべてに対応する反例がある", () => {
    const covered = new Set<string>();
    for (const f of fixtures) {
      const gates = Array.isArray(f.meta.gate) ? f.meta.gate : [f.meta.gate];
      for (const g of gates) covered.add(g);
    }
    const missing = GATE_IDS.filter((g) => !covered.has(g));
    expect(missing).toEqual([]);
  });

  it("各 meta.json が fixture_id・gate・provenance・期待出力を宣言している", () => {
    const problems: string[] = [];
    for (const f of fixtures) {
      if (f.meta.fixture_id !== f.dir) problems.push(`${f.dir}: fixture_id が一致しません`);
      if (!f.meta.gate) problems.push(`${f.dir}: gate がありません`);
      if (!f.meta.description) problems.push(`${f.dir}: description がありません`);
      if (f.meta.expect_exit_nonzero !== true) problems.push(`${f.dir}: expect_exit_nonzero が true ではありません`);
      if (!f.meta.provenance?.authored_by) problems.push(`${f.dir}: provenance.authored_by がありません`);
      if (!f.meta.provenance?.kind) problems.push(`${f.dir}: provenance.kind がありません`);
      if (f.meta.runner && !f.meta.expect_output_contains) {
        problems.push(`${f.dir}: runner があるのに expect_output_contains がありません`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("実行手段が無い反例は、待っているタスクを名指ししている（未着手であること込み）", () => {
    const problems: string[] = [];
    for (const f of pending) {
      const blockedOn = f.meta.blocked_on;
      if (!blockedOn) {
        problems.push(`${f.dir}: runner が無いのに blocked_on がありません`);
        continue;
      }
      const task = taskList.tasks.find((t) => t.task_id === blockedOn);
      if (!task) {
        problems.push(`${f.dir}: blocked_on=${blockedOn} が docs/task-list.json にありません`);
        continue;
      }
      if (task.completion_status === "DONE" || task.completion_status === "DONE_WITH_CONCERNS") {
        problems.push(
          `${f.dir}: blocked_on=${blockedOn} は既に ${task.completion_status} です。runner を埋めてください`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});

describe.each(runnable.map((f) => [f.dir, f] as const))(
  "反例 %s",
  (_name, fixture) => {
    const runner = fixture.meta.runner as Runner;
    const gates = Array.isArray(fixture.meta.gate) ? fixture.meta.gate.join("/") : fixture.meta.gate;

    it(`${gates} が非ゼロ終了し、意図した違反を出力する`, () => {
      const { status, output } = run(runner, fixture.abs);
      expect(
        status,
        `${fixture.dir}: ${runner.cmd} ${runner.args.join(" ")} が exit 0 になりました。ゲートが空振りしています。\n${output}`,
      ).not.toBe(0);
      expect(
        output,
        `${fixture.dir}: 非ゼロ終了はしましたが、期待した違反行が出ていません（別の理由で落ちた可能性）。\n${output}`,
      ).toContain(fixture.meta.expect_output_contains);
    });
  },
);

describe("対象 0 件のゲートは合格にしない", () => {
  it("gate:constraints は対象ファイルが 1 件も無い root で exit 1 になる", () => {
    // 反例ディレクトリのうち src/** を 1 つも持たないものを使う。
    const emptyRoot = path.join(fixturesDir, "g0-gate-with-zero-targets");
    const result = spawnSync(
      "bash",
      [
        "scripts/gate-constraints.sh",
        "--root",
        emptyRoot,
        "--constraints",
        "docs/constraints.json",
        "--task-list",
        "docs/task-list.json",
        "--run-log-dir",
        "docs/run-log",
      ],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).toBe(1);
    expect(output).toContain("expect_targets=now but 0 files matched");
  });

  it("gate:check の全ゲートは、対象 0 件のまま ok にならない（理由つき defer になる）", () => {
    const result = spawnSync("node", ["scripts/gate-check.mjs", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const report = JSON.parse(result.stdout) as {
      results: { id: string; status: string; targets: number; notes: string[] }[];
    };
    const silentlyEmpty = report.results
      .filter((r) => r.status === "ok" && r.targets === 0)
      .map((r) => r.id);
    expect(silentlyEmpty).toEqual([]);
    const deferWithoutReason = report.results
      .filter((r) => r.status === "defer" && r.notes.length === 0)
      .map((r) => r.id);
    expect(deferWithoutReason).toEqual([]);
  });
});
