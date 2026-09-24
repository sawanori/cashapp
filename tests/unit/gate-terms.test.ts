/**
 * `scripts/gate-terms.mjs` のユニットテスト（task_021 scope）。
 *
 * 他の gate スクリプトのテスト（`tests/unit/config/env.test.ts` の `gate-env-scope.mjs`、
 * `tests/gates/meta.test.ts` の `gate-check.mjs`）と同じく、`.mjs` を別プロセスとして
 * `spawnSync` で起動する（`.ts` から `.mjs` を直接 import すると型宣言が無く typecheck が
 * 落ちるため。R-TH-01 と同じ考え方で「ゲートが空振りしても緑になる」ことがないことを
 * フィクスチャで確認する）。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "gate-terms.mjs");

const VALID_TERMS = `# 利用規約

参加者が決済事業者に対して会費の支払いを完了した時点で、参加者の幹事に対する支払債務は消滅
するものとします。

運営者は、運営者の故意又は重大な過失による場合を除き、直近12か月間に支払われた利用料の合計
額を上限として賠償の責任を負うものとします。

未成年の参加者が含まれるイベントでは、自動連携を提供しません。

利用者は、反社会的勢力に該当しないことを表明し、保証します。

削除請求への対応は擬似匿名化により行います。
`;

const REQUIRED_MARKERS = [
  "支払債務は消滅",
  "上限として",
  "未成年",
  "反社会的勢力",
  "擬似匿名化",
];

let tmpFiles: string[] = [];

function writeFixture(content: string): string {
  const file = path.join(os.tmpdir(), `gate-terms-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(file, content, "utf8");
  tmpFiles.push(file);
  return file;
}

function run(file: string): { readonly status: number | null; readonly stdout: string } {
  const result = spawnSync("node", [SCRIPT, "--file", file], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
}

afterEach(() => {
  for (const f of tmpFiles) {
    fs.rmSync(f, { force: true });
  }
  tmpFiles = [];
});

describe("gate-terms.mjs — 必須条項", () => {
  it("すべての必須条項が揃っていれば exit 0", () => {
    const file = writeFixture(VALID_TERMS);
    const { status, stdout } = run(file);
    expect(status).toBe(0);
    expect(stdout).toContain("5/5 required clauses present");
  });

  for (const marker of REQUIRED_MARKERS) {
    it(`必須条項「${marker}」が欠けていれば exit 1（空振りで緑にならない）`, () => {
      const broken = VALID_TERMS.split(marker).join("");
      const file = writeFixture(broken);
      const { status, stdout } = run(file);
      expect(status).toBe(1);
      expect(stdout).toContain("MISSING");
    });
  }
});

describe("gate-terms.mjs — 全部免責の検出", () => {
  it("正常な terms.md では exit 0", () => {
    const file = writeFixture(VALID_TERMS);
    expect(run(file).status).toBe(0);
  });

  it("包括的な免責文言が混入すると exit 1", () => {
    const broken = `${VALID_TERMS}\n運営者は一切の責任を負いません。\n`;
    const file = writeFixture(broken);
    const { status, stdout } = run(file);
    expect(status).toBe(1);
    expect(stdout).toContain("BLANKET_DISCLAIMER");
  });

  it("ファイルが存在しなければ exit 2（usage エラー。0/1 と区別する）", () => {
    const { status } = run(path.join(os.tmpdir(), "does-not-exist-gate-terms.md"));
    expect(status).toBe(2);
  });
});

describe("実ファイル src/content/terms.md", () => {
  it("必須条項をすべて満たし、全部免責を含まない（既定の --file で exit 0）", () => {
    const result = spawnSync("node", [SCRIPT], { encoding: "utf8", cwd: REPO_ROOT });
    expect(result.status).toBe(0);
  });
});
