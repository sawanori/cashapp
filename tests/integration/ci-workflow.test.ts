/**
 * `.github/workflows/gate-integration.yml` の静的検証。
 *
 * done_definition 第 5 項「gate.yml に integration ジョブが追加され PR で緑」は
 * GitHub リモートが未作成（PO 判断待ち）で `git push` も禁止コマンドのため、
 * 実 PR での緑は deferred（docs/concerns/task_011.md）。
 * ここで機械的に確かめられるのは次の 3 点だけであり、それを確かめる:
 *
 *   1. ファイルが `.github/workflows/gate-<job>.yml` の規約どおりの名前で実在する
 *      （並行タスク衝突回避の規約。`gate.yml` は task_009 の所有物なので編集しない）
 *   2. YAML として妥当で、`jobs.<job>` がファイル名の `<job>` と一致する
 *   3. 各ステップの `run:` が呼ぶ `npm run <script>` が package.json に実在する
 *      （CI が存在しないスクリプトを叩いて落ちる状態で main に入らない）
 *
 * DB には触らないが、verify_commands に入っている `npm run test:integration` で
 * 必ず走らせたいのでこのディレクトリに置く。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { REPO_ROOT } from "./setup";

/** このタスクが所有するワークフロー。job 名はファイル名の `gate-<job>.yml` から導く。 */
const WORKFLOW_FILE = "gate-integration.yml";
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", WORKFLOW_FILE);

interface WorkflowStep {
  readonly run?: unknown;
  readonly uses?: unknown;
}
interface WorkflowJob {
  readonly name?: unknown;
  readonly steps?: unknown;
}
interface Workflow {
  readonly name?: unknown;
  readonly jobs?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value, "オブジェクトであること").toBe("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

describe("gate-integration.yml の静的検証（実 PR での緑は deferred）", () => {
  it("`.github/workflows/gate-<job>.yml` の規約どおりに実在し、YAML として妥当", async () => {
    const raw = await readFile(WORKFLOW_PATH, "utf8");
    expect(raw.length).toBeGreaterThan(0);

    // parse は不正な YAML で throw する。ここが通れば「YAML として妥当」。
    const parsed = parseYaml(raw) as Workflow;
    const doc = asRecord(parsed);

    const expectedJobName = WORKFLOW_FILE.replace(/^gate-/, "").replace(/\.yml$/, "");
    expect(doc["name"]).toBe(`gate-${expectedJobName}`);

    const jobs = asRecord(doc["jobs"]);
    // `gate-<job>.yml` は <job> ちょうど 1 つを持つ（gate.yml と衝突しないため）。
    expect(Object.keys(jobs)).toEqual([expectedJobName]);

    const job = asRecord(jobs[expectedJobName]) as WorkflowJob;
    expect(job.name).toBe(expectedJobName);
    expect(Array.isArray(job.steps)).toBe(true);
  });

  it("ステップが呼ぶ npm スクリプトがすべて package.json に実在する", async () => {
    const raw = await readFile(WORKFLOW_PATH, "utf8");
    const doc = asRecord(parseYaml(raw) as Workflow);
    const jobs = asRecord(doc["jobs"]);
    const job = asRecord(jobs["integration"]) as WorkflowJob;
    const steps = job.steps as WorkflowStep[];

    const pkgRaw = await readFile(path.join(REPO_ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
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

    // 本タスクが CI に載せたと主張している 3 本は必ず含まれていること。
    for (const required of ["test:integration", "gates:sync", "db:diff:drizzle"]) {
      expect(referenced, `${required} が CI ステップに無い`).toContain(required);
    }
  });

  it("`supabase stop` / `supabase db reset` を含まない（運用上の禁止コマンド）", async () => {
    const raw = await readFile(WORKFLOW_PATH, "utf8");
    const runLines = raw
      .split("\n")
      .filter((line) => /^\s*(-\s*)?(name:|run:)/.test(line) || /^\s{8,}\S/.test(line))
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(runLines).not.toMatch(/supabase\s+stop/);
    expect(runLines).not.toMatch(/supabase\s+db\s+reset/);
  });
});
