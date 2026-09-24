/**
 * `.github/workflows/gate-web-only.yml` の静的検証。
 *
 * done_definition 第 5 項「gate.yml に web-only ジョブが追加され緑」は、GitHub リモートが
 * 未作成（PO 判断待ち）で `git push` も禁止コマンドのため、**実 PR での緑は deferred**
 * （docs/concerns/task_013.md）。ここで機械的に確かめられるのは次の 3 点だけであり、それを確かめる:
 *
 *   1. ファイルが `.github/workflows/gate-<job>.yml` の規約どおりの名前で実在する
 *      （並行タスク衝突回避の規約。`gate.yml` は task_009 の所有物なので編集しない）
 *   2. YAML として妥当で、`jobs.<job>` がファイル名の `<job>` と一致する
 *   3. 各ステップの `run:` が呼ぶ `npm run <script>` が package.json に実在する
 *
 * 形式は task_011 の `tests/integration/ci-workflow.test.ts` に合わせてある。ただし本ファイルは
 * DB を要らないので `tests/unit` に置き、`npm run test:unit` で毎回走らせる。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** このタスクが所有するワークフロー。job 名はファイル名の `gate-<job>.yml` から導く。 */
const WORKFLOW_FILE = "gate-web-only.yml";
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", WORKFLOW_FILE);
const JOB_NAME = "web-only";

interface WorkflowStep {
  readonly run?: unknown;
  readonly uses?: unknown;
}
interface WorkflowJob {
  readonly name?: unknown;
  readonly steps?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value, "オブジェクトであること").toBe("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

describe("gate-web-only.yml の静的検証（実 PR での緑は deferred）", () => {
  it("`.github/workflows/gate-<job>.yml` の規約どおりに実在し、YAML として妥当", async () => {
    const raw = await readFile(WORKFLOW_PATH, "utf8");
    expect(raw.length).toBeGreaterThan(0);

    const doc = asRecord(parseYaml(raw));
    const expectedJobName = WORKFLOW_FILE.replace(/^gate-/, "").replace(/\.yml$/, "");
    expect(expectedJobName).toBe(JOB_NAME);
    expect(doc["name"]).toBe(`gate-${JOB_NAME}`);

    const jobs = asRecord(doc["jobs"]);
    // `gate-<job>.yml` は <job> ちょうど 1 つを持つ（gate.yml と衝突しないため）。
    expect(Object.keys(jobs)).toEqual([JOB_NAME]);

    const job = asRecord(jobs[JOB_NAME]) as WorkflowJob;
    expect(job.name).toBe(JOB_NAME);
    expect(Array.isArray(job.steps)).toBe(true);
  });

  it("ステップが呼ぶ npm スクリプトがすべて package.json に実在する", async () => {
    const raw = await readFile(WORKFLOW_PATH, "utf8");
    const jobs = asRecord(asRecord(parseYaml(raw))["jobs"]);
    const job = asRecord(jobs[JOB_NAME]) as WorkflowJob;
    const steps = job.steps as WorkflowStep[];

    const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};

    const referenced: string[] = [];
    for (const step of steps) {
      if (typeof step.run !== "string") continue;
      for (const match of step.run.matchAll(/\bnpm run (?:--silent )?([A-Za-z0-9:_-]+)/g)) {
        referenced.push(match[1]!);
      }
    }

    // 空振り禁止: 1 つも拾えていないなら、正規表現かワークフローのどちらかが壊れている。
    expect(referenced.length, "ワークフローが npm スクリプトを 1 つも呼んでいない").toBeGreaterThan(
      0,
    );
    for (const name of referenced) {
      expect(scripts[name], `package.json に scripts.${name} が無い`).toBeTypeOf("string");
    }
    expect(referenced, "build:web-only が CI ステップに無い").toContain("build:web-only");
  });

  it("web-only ジョブは独立ファイルにあり、共有の gate.yml には定義されていない", async () => {
    // 並行タスク衝突回避の規約: CI ジョブの追加は gate.yml を編集せず
    // `.github/workflows/gate-<job>.yml` として独立ファイルで行う。
    // `gate.yml` は task_009 の所有物なので、存在の有無にかかわらず本タスクは触らない。
    const { existsSync } = await import("node:fs");
    const sharedGate = path.join(REPO_ROOT, ".github", "workflows", "gate.yml");
    if (!existsSync(sharedGate)) return;

    const raw = await readFile(sharedGate, "utf8");
    const jobs = asRecord(asRecord(parseYaml(raw))["jobs"]);
    expect(
      Object.keys(jobs),
      "web-only ジョブは gate-web-only.yml が持つ（gate.yml に二重定義しない）",
    ).not.toContain(JOB_NAME);
  });

  it("build:web-only が scripts/build-web-only.mjs を呼ぶ", async () => {
    const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["build:web-only"]).toContain("scripts/build-web-only.mjs");
  });
});
