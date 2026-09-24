// tests/unit/ci/assert-release-gate.test.ts
//
// check_051 の機械検証。scripts/ci/assert-release-gate.mjs が
// `.github/workflows/release.yml` の先頭 2 段ゲートを YAML パースで検査できていること。
//
// 実物の release.yml が通ることだけを見ても、判定器が「常に 0 を返すだけの空振り」で
// あるかどうかは分からない（R-TH-01）。壊した fixture が確実に落ちることを、
// アサートの項目ごとに 1 本ずつ置く。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const asserter = path.join(repoRoot, "scripts", "ci", "assert-release-gate.mjs");
const realWorkflow = path.join(repoRoot, ".github", "workflows", "release.yml");

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  violations: string[];
}

function runOn(yamlText: string): RunResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-gate-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "release.yml");
  fs.writeFileSync(file, yamlText, "utf8");

  const proc = spawnSync(process.execPath, [asserter, "--file", file, "--json"], {
    encoding: "utf8",
    cwd: repoRoot,
  });

  let violations: string[] = [];
  try {
    const parsed = JSON.parse(proc.stdout) as { violations?: string[] };
    violations = parsed.violations ?? [];
  } catch {
    violations = [];
  }
  return { status: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr, violations };
}

const realWorkflowText = fs.readFileSync(realWorkflow, "utf8");

describe("assert-release-gate: 実物の release.yml", () => {
  it("リポジトリの .github/workflows/release.yml が合格する", () => {
    const proc = spawnSync(process.execPath, [asserter], { encoding: "utf8", cwd: repoRoot });
    expect(proc.stdout + proc.stderr).not.toContain("check_051 FAIL");
    expect(proc.status).toBe(0);
  });

  it("--file を省略するとリポジトリ直下の release.yml を見る", () => {
    const proc = spawnSync(process.execPath, [asserter, "--json"], { encoding: "utf8", cwd: repoRoot });
    const parsed = JSON.parse(proc.stdout) as { file: string };
    expect(parsed.file).toBe(realWorkflow);
  });
});

describe("assert-release-gate: 壊した fixture は落ちる", () => {
  it("release-gate ジョブが無ければ落ちる", () => {
    const broken = realWorkflowText.replace(/^  release-gate:$/m, "  preflight:");
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("release-gate");
  });

  it("deploy が needs を張っていなければ落ちる（ゲートより先に走れる）", () => {
    const broken = realWorkflowText.replace(/^    needs: \[release-gate\]$/m, "    # needs removed");
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("到達しません");
  });

  it("先頭の run ステップが release-mode.json を読まなければ落ちる", () => {
    const broken = realWorkflowText.replace(
      /^      - name: 2 段ゲート.*$/m,
      '      - name: noop\n        run: echo hello\n      - name: 2 段ゲート',
    );
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("最初の run ステップ");
  });

  it("(a) 段の npm ls（決済 SDK 不在）が無ければ落ちる", () => {
    const broken = realWorkflowText.replace(/npm ls --all --parseable/g, "true");
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("npm ls");
  });

  it("(a) 段の PAYMENTS_ENABLED 検証が無ければ落ちる", () => {
    const broken = realWorkflowText.replace(/PAYMENTS_ENABLED/g, "SOME_OTHER_FLAG");
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("PAYMENTS_ENABLED");
  });

  it("(b) 段の .cleared == true が無ければ落ちる", () => {
    const broken = realWorkflowText.replace(/\.cleared == true/g, ".cleared != null");
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain(".cleared == true");
  });

  it("legal-clearance.json を読まなければ落ちる", () => {
    const broken = realWorkflowText.replace(
      /docs\/gates\/legal-clearance\.json/g,
      "docs/gates/something-else.json",
    );
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("legal-clearance.json");
  });

  it("environment: production が無ければ落ちる", () => {
    const broken = realWorkflowText.replace(/^    environment: production$/m, "    # environment removed");
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("environment: production");
  });

  it("wrangler の command が deploy --env production でなければ落ちる", () => {
    const broken = realWorkflowText.replace("command: deploy --env production", "command: deploy");
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("deploy --env production");
  });

  it("apiToken が secrets 由来でなければ落ちる", () => {
    const broken = realWorkflowText.replace(
      "apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}",
      "apiToken: ${{ vars.CLOUDFLARE_API_TOKEN }}",
    );
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("ローカルの .env を読むステップがあれば落ちる", () => {
    const broken = realWorkflowText.replace(
      "      - name: OpenNext ビルド",
      "      - name: leak\n        run: source .env\n      - name: OpenNext ビルド",
    );
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain(".env");
  });

  it("cloudflare/wrangler-action を使うジョブが無ければ落ちる", () => {
    const broken = realWorkflowText.replace("cloudflare/wrangler-action@v4", "some/other-action@v1");
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("wrangler-action");
  });

  it("YAML として壊れていれば落ちる（パースできないものを通さない）", () => {
    const r = runOn("jobs:\n  - [unbalanced\n");
    expect(r.status).toBe(1);
  });

  it("jobs が無ければ落ちる", () => {
    const r = runOn("name: release\non:\n  workflow_dispatch:\n");
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("jobs");
  });
});

// needs グラフの到達性だけを見ていた頃は、`needs: [release-gate]` の下に `if: always()` を
// 1 行足すだけで「ゲートが赤でもデプロイが走る release.yml」が違反 0 件で通った
// [実測 2026-09-24、敵対レビューの指摘]。needs が実際に効いていることまで見る。
describe("assert-release-gate: needs の無効化を検出する", () => {
  /** deploy ジョブに `if:` を足した release.yml を作る。 */
  function withDeployIf(expr: string): string {
    return realWorkflowText.replace(
      /^    needs: \[release-gate\]$/m,
      `    needs: [release-gate]\n    if: ${expr}`,
    );
  }

  const neutralizing: [string, string][] = [
    ["always()", "always()"],
    ["failure()", "failure()"],
    ["cancelled()", "cancelled()"],
    ["${{ !success() }}", "!success()"],
    ["${{ success() == false }}", "success() の比較"],
    ["${{ always() && github.ref == 'refs/heads/main' }}", "always()"],
  ];

  for (const [expr, label] of neutralizing) {
    it(`deploy の if: ${expr} で落ちる`, () => {
      const r = runOn(withDeployIf(expr));
      expect(r.status).toBe(1);
      const joined = r.violations.join("\n");
      expect(joined).toContain("`deploy` の `if:`");
      expect(joined).toContain(label);
    });
  }

  it("状態関数を含まない if:（絞り込み条件）は通す（偽陽性を出さない）", () => {
    const r = runOn(withDeployIf("${{ github.ref == 'refs/heads/main' }}"));
    expect(r.violations).toEqual([]);
    expect(r.status).toBe(0);
  });

  it("release-gate 自身の if: は見ない（先頭ジョブなので迂回路にならない）", () => {
    const patched = realWorkflowText.replace(
      /^  release-gate:\n    runs-on: ubuntu-latest$/m,
      "  release-gate:\n    if: always()\n    runs-on: ubuntu-latest",
    );
    const r = runOn(patched);
    expect(r.violations).toEqual([]);
    expect(r.status).toBe(0);
  });
});

describe("assert-release-gate: ゲートの失敗を握りつぶす記述を検出する", () => {
  it("release-gate にジョブ単位の continue-on-error があれば落ちる", () => {
    const broken = realWorkflowText.replace(
      /^  release-gate:\n    runs-on: ubuntu-latest$/m,
      "  release-gate:\n    runs-on: ubuntu-latest\n    continue-on-error: true",
    );
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("continue-on-error");
  });

  it("ゲートのステップに continue-on-error があれば落ちる", () => {
    const broken = realWorkflowText.replace(
      "        run: npm run gate:integrity",
      "        run: npm run gate:integrity\n        continue-on-error: true",
    );
    const r = runOn(broken);
    expect(r.status).toBe(1);
    const joined = r.violations.join("\n");
    expect(joined).toContain("continue-on-error");
    expect(joined).toContain("ハッシュ照合");
  });

  it("2 段ゲートのステップ自身に continue-on-error があれば落ちる", () => {
    const broken = realWorkflowText.replace(
      /^      - name: 2 段ゲート(.*)$/m,
      "      - name: 2 段ゲート$1\n        continue-on-error: true",
    );
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("continue-on-error");
  });

  it("評価できない式の continue-on-error も落とす（fail-closed）", () => {
    const broken = realWorkflowText.replace(
      "        run: npm run gate:integrity",
      "        run: npm run gate:integrity\n        continue-on-error: ${{ github.actor == 'x' }}",
    );
    const r = runOn(broken);
    expect(r.status).toBe(1);
    expect(r.violations.join("\n")).toContain("continue-on-error");
  });

  it("continue-on-error: false は通す（偽陽性を出さない）", () => {
    const patched = realWorkflowText.replace(
      "        run: npm run gate:integrity",
      "        run: npm run gate:integrity\n        continue-on-error: false",
    );
    const r = runOn(patched);
    expect(r.violations).toEqual([]);
    expect(r.status).toBe(0);
  });
});

describe("assert-release-gate: CLI の契約", () => {
  it("読めないファイルを渡すと exit 2（使用法エラー）", () => {
    const proc = spawnSync(process.execPath, [asserter, "--file", "/nonexistent/release.yml"], {
      encoding: "utf8",
      cwd: repoRoot,
    });
    expect(proc.status).toBe(2);
  });

  it("知らない引数を渡すと exit 2", () => {
    const proc = spawnSync(process.execPath, [asserter, "--nope"], { encoding: "utf8", cwd: repoRoot });
    expect(proc.status).toBe(2);
  });
});
