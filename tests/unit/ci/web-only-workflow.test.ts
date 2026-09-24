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

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";
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

/**
 * モックの定数畳み込みが成立する条件の回帰テスト（制約 I4 / check_079）。
 *
 * ★ 事実: Next.js がクライアント側の `process.env.NEXT_PUBLIC_*` を定数へ置換するのは
 *   `node_modules/next/dist/lib/static-env.js` の `getNextPublicEnvironmentVariables()` で、
 *   実装は `for (const key in process.env)` ＝ **存在するキーだけ** define にする。
 *   したがって `NEXT_PUBLIC_LIFF_MOCK` を **未設定**にすると畳み込みが起きず、
 *   `src/lib/liff/client.ts` の `await import("./mock")` が到達可能なまま残り、
 *   `@line/liff-mock` がクライアントチャンクとして `.next/static` に出力される（実測で確認済み）。
 *
 * ★ したがって「未設定にする」実装（`delete env[...]`）に戻したら **落ちなければならない**。
 */
describe("NEXT_PUBLIC_LIFF_MOCK の定数畳み込み条件（制約 I4）", () => {
  it("本番ビルド経路（build / build:cf）が NEXT_PUBLIC_LIFF_MOCK=0 に固定されている", async () => {
    // ★ 「定義されている」では足りない。`${NEXT_PUBLIC_LIFF_MOCK:-0}` のように外部の値を
    //   尊重する書き方だと、デプロイ環境に `NEXT_PUBLIC_LIFF_MOCK=1` を置くだけで
    //   ゲートもテストも緑のまま @line/liff-mock が本番バンドルに載る。右辺まで固定する。
    const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    for (const name of ["build", "build:cf"]) {
      const script = scripts[name];
      expect(script, `package.json に scripts.${name} が無い`).toBeTypeOf("string");
      const assignments = [...(script ?? "").matchAll(/NEXT_PUBLIC_LIFF_MOCK=(\S*)/g)].map(
        (match) => match[1],
      );
      expect(
        assignments.length,
        `scripts.${name} が NEXT_PUBLIC_LIFF_MOCK を定義していない（未定義だと畳み込まれず` +
          `@line/liff-mock が本番バンドルに載る）`,
      ).toBeGreaterThan(0);
      for (const value of assignments) {
        expect(
          value,
          `scripts.${name} の NEXT_PUBLIC_LIFF_MOCK が "0" に固定されていない（実際: "${value ?? ""}"）。` +
            `外部注入を許すと env 1 つでモックが本番バンドルに載る`,
        ).toBe("0");
      }
    }
  });

  it("build-web-only.mjs は NEXT_PUBLIC_LIFF_MOCK を削除せず、値を設定してビルドする", async () => {
    const source = await readFile(path.join(REPO_ROOT, "scripts", "build-web-only.mjs"), "utf8");
    expect(source, "delete で未設定にすると畳み込みが起きない").not.toMatch(
      /delete\s+env\[["']NEXT_PUBLIC_LIFF_MOCK["']\]/,
    );
    expect(source).toContain("NEXT_PUBLIC_LIFF_MOCK: MOCK_DISABLED_VALUE");
    expect(source).toMatch(/const MOCK_DISABLED_VALUE = "0"/);
  });

  it("Next.js の実装が『存在するキーだけを define にする』ままである", async () => {
    // 前提が変わったら（Next の更新で未設定キーも define されるようになったら）
    // 上の 2 つの縛りは不要になる。前提そのものを毎回確かめる。
    const staticEnv = await readFile(
      path.join(REPO_ROOT, "node_modules", "next", "dist", "lib", "static-env.js"),
      "utf8",
    );
    expect(staticEnv).toContain("function getNextPublicEnvironmentVariables()");
    expect(staticEnv).toMatch(/for\s*\(const key in process\.env\)/);
  });
});

/**
 * ゲート本体が実際に落ちることの検査（文面の grep ではなく、スクリプトを走らせて exit code を見る）。
 *
 * ★ ここを「スクリプトの本文に `MOCK_DISABLED_VALUE` と書いてある」で済ませると、
 *   比較を消してもテストは緑のままになる。fixture の木を作って本物を spawn し、
 *   `=1` と `${NEXT_PUBLIC_LIFF_MOCK:-0}` の**両方**で exit 1 になることを固定する。
 */
describe("build:web-only の本番ビルド経路検査（fixture tree で実走）", () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  /** ゲートを走らせられる最小の木。`--skip-build` を使うので next 本体は要らない。 */
  async function makeFixture(buildScript: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "web-only-gate-"));
    roots.push(root);
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await mkdir(path.join(root, "src", "app"), { recursive: true });
    await mkdir(path.join(root, ".next", "static"), { recursive: true });
    await copyFile(
      path.join(REPO_ROOT, "scripts", "build-web-only.mjs"),
      path.join(root, "scripts", "build-web-only.mjs"),
    );
    await writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ scripts: { build: buildScript, "build:cf": buildScript } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(root, "src", "app", "page.tsx"),
      "export default function Page(): null {\n  return null;\n}\n",
      "utf8",
    );
    await writeFile(path.join(root, ".next", "static", "chunk.js"), "console.log(0);\n", "utf8");
    return root;
  }

  function runGate(root: string): { status: number | null; stderr: string } {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "build-web-only.mjs"), "--skip-build"],
      { cwd: root, encoding: "utf8" },
    );
    return { status: result.status, stderr: result.stderr };
  }

  it("NEXT_PUBLIC_LIFF_MOCK=0 に固定した木では通る（空振りではないことの対照）", async () => {
    const root = await makeFixture("NEXT_PUBLIC_LIFF_MOCK=0 next build");
    const { status, stderr } = runGate(root);
    expect(status, stderr).toBe(0);
  });

  it("NEXT_PUBLIC_LIFF_MOCK=1 を置いたら落ちる", async () => {
    const root = await makeFixture("NEXT_PUBLIC_LIFF_MOCK=1 next build");
    const { status, stderr } = runGate(root);
    expect(status).toBe(1);
    expect(stderr).toContain("固定されていません");
  });

  it("外部注入を許す書き方（${NEXT_PUBLIC_LIFF_MOCK:-0}）でも落ちる", async () => {
    // デプロイ環境に 1 を置くだけでモックが載る形なので、0 が既定でも許さない。
    const root = await makeFixture("NEXT_PUBLIC_LIFF_MOCK=${NEXT_PUBLIC_LIFF_MOCK:-0} next build");
    const { status, stderr } = runGate(root);
    expect(status).toBe(1);
    expect(stderr).toContain("固定されていません");
  });

  it("未定義なら落ちる（畳み込みが起きない）", async () => {
    const root = await makeFixture("next build");
    const { status, stderr } = runGate(root);
    expect(status).toBe(1);
    expect(stderr).toContain("NEXT_PUBLIC_LIFF_MOCK を定義していません");
  });
});
