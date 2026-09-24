// tests/unit/ci/check-pr-checklist.test.ts
//
// check_067 の機械検証。scripts/ci/check-pr-checklist.mjs に、fixture の PR 本文
// （チェックリスト空 / 記入済み）と差分パス（tests/** あり / なし）を入力し、
// 期待どおりの終了コードになることを確かめる。
//
//   差分あり × チェックリスト空   → 非 0
//   差分あり × 記入済み           → 0
//   差分なし                      → 0
//
// 併せて、実物の .github/PULL_REQUEST_TEMPLATE.md が
//   - 4 項目のラベルを判定器と同じ綴りで持っている
//   - 開いたまま（未記入）だと落ちる
// ことも見る。テンプレートとラベルの綴りがずれると、このゲートは「誰も記入できない
// のに落ちる」か「何を書いても通る」のどちらかに静かに壊れる。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const checker = path.join(repoRoot, "scripts", "ci", "check-pr-checklist.mjs");
const prTemplate = path.join(repoRoot, ".github", "PULL_REQUEST_TEMPLATE.md");

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-checklist-"));
  tmpDirs.push(dir);
  return dir;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  json: {
    status: string;
    guarded: { path: string; label: string }[];
    missing: string[];
    violations: string[];
  } | null;
}

function run(body: string, changed: string[]): RunResult {
  const dir = mkTmp();
  const bodyFile = path.join(dir, "body.md");
  const changedFile = path.join(dir, "changed.txt");
  fs.writeFileSync(bodyFile, body, "utf8");
  fs.writeFileSync(changedFile, `${changed.join("\n")}\n`, "utf8");

  const proc = spawnSync(
    process.execPath,
    [checker, "--body-file", bodyFile, "--changed-file", changedFile, "--json"],
    { encoding: "utf8", cwd: repoRoot },
  );

  let json: RunResult["json"] = null;
  try {
    json = JSON.parse(proc.stdout) as RunResult["json"];
  } catch {
    json = null;
  }
  return { status: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr, json };
}

const FILLED_CHECKLIST = [
  "## ゲート緩和チェックリスト",
  "",
  "- 何を緩めたか: tests/unit/foo.test.ts のケースを 1 件削除した",
  "- 理由: 仕様が変わり、削除したケースは存在しない分岐を見ていたため",
  "- 復旧予定日: 2026-10-15",
  "- 代替の検知手段: tests/contract/foo.contract.test.ts に同じ不変条件を移した",
].join("\n");

const EMPTY_CHECKLIST = [
  "## ゲート緩和チェックリスト",
  "",
  "- 何を緩めたか:",
  "- 理由:",
  "- 復旧予定日:",
  "- 代替の検知手段:",
].join("\n");

describe("check-pr-checklist: 保護対象の差分とチェックリストの組み合わせ", () => {
  it("tests/** に差分があり、チェックリストが空なら非 0 で落ちる", () => {
    const r = run(EMPTY_CHECKLIST, ["tests/unit/foo.test.ts", "src/app/page.tsx"]);
    expect(r.status).toBe(1);
    expect(r.json?.status).toBe("violation");
    expect(r.json?.missing).toEqual(["何を緩めたか", "理由", "復旧予定日", "代替の検知手段"]);
    expect(r.json?.guarded.map((g) => g.path)).toContain("tests/unit/foo.test.ts");
  });

  it("tests/** に差分があり、チェックリストが記入済みなら 0 で通る", () => {
    const r = run(FILLED_CHECKLIST, ["tests/unit/foo.test.ts"]);
    expect(r.status).toBe(0);
    expect(r.json?.status).toBe("ok");
    expect(r.json?.missing).toEqual([]);
  });

  it("保護対象に差分が無ければ、チェックリストが空でも 0 で通る", () => {
    const r = run(EMPTY_CHECKLIST, ["src/app/page.tsx", "docs/HANDOFF.md", "README.md"]);
    expect(r.status).toBe(0);
    expect(r.json?.status).toBe("ok");
    expect(r.json?.guarded).toEqual([]);
  });

  it("4 項目のうち 1 つでも空なら落ちる（部分記入を通さない）", () => {
    const partial = FILLED_CHECKLIST.replace("- 復旧予定日: 2026-10-15", "- 復旧予定日:");
    const r = run(partial, ["scripts/gate-check.mjs"]);
    expect(r.status).toBe(1);
    expect(r.json?.missing).toEqual(["復旧予定日"]);
  });

  it("記号だけの値は記入と認めない", () => {
    const dashes = [
      "- 何を緩めたか: -",
      "- 理由: ・",
      "- 復旧予定日: --",
      "- 代替の検知手段: ...",
    ].join("\n");
    const r = run(dashes, ["tests/unit/foo.test.ts"]);
    expect(r.status).toBe(1);
    expect(r.json?.missing).toEqual(["何を緩めたか", "理由", "復旧予定日", "代替の検知手段"]);
  });

  it("HTML コメントの中の説明文を『記入済み』と数えない", () => {
    const commented = [
      "## ゲート緩和チェックリスト",
      "<!--",
      "- 何を緩めたか: ここに書く",
      "- 理由: ここに書く",
      "- 復旧予定日: ここに書く",
      "- 代替の検知手段: ここに書く",
      "-->",
      "",
      "- 何を緩めたか:",
      "- 理由:",
      "- 復旧予定日:",
      "- 代替の検知手段:",
    ].join("\n");
    const r = run(commented, ["tests/unit/foo.test.ts"]);
    expect(r.status).toBe(1);
    expect(r.json?.missing.length).toBe(4);
  });

  it("「緩めていない」と書いてあれば通る（内容は検証しない設計である）", () => {
    const declined = [
      "- 何を緩めたか: 緩めていない",
      "- 理由: テストを 1 件追加しただけ",
      "- 復旧予定日: 該当なし",
      "- 代替の検知手段: 該当なし",
    ].join("\n");
    const r = run(declined, ["tests/unit/foo.test.ts"]);
    expect(r.status).toBe(0);
  });
});

describe("check-pr-checklist: 保護対象パスの網羅", () => {
  const guardedSamples: [string, string][] = [
    ["tests/unit/foo.test.ts", "tests/**"],
    ["scripts/gate-check.mjs", "scripts/**"],
    [".claude/settings.json", ".claude/**"],
    [".github/workflows/gate.yml", ".github/**"],
    ["docs/gates/legal-clearance.json", "docs/gates/**"],
    ["supabase/migrations/0001_init.sql", "supabase/migrations/**"],
    ["package.json", "package*.json"],
    ["package-lock.json", "package*.json"],
  ];

  for (const [file, label] of guardedSamples) {
    it(`${file} は ${label} として保護対象になる`, () => {
      const r = run(EMPTY_CHECKLIST, [file]);
      expect(r.status).toBe(1);
      expect(r.json?.guarded).toEqual([{ path: file, label }]);
    });
  }

  const unguardedSamples = [
    "src/app/page.tsx",
    "docs/PROGRESS.md",
    "docs/task-list.json",
    "supabase/config.toml",
    "testsuite/foo.ts",
    "packages/foo/package.json",
  ];

  for (const file of unguardedSamples) {
    it(`${file} は保護対象ではない`, () => {
      const r = run(EMPTY_CHECKLIST, [file]);
      expect(r.status).toBe(0);
      expect(r.json?.guarded).toEqual([]);
    });
  }
});

describe("check-pr-checklist: 入力の配線が壊れたときに緑にしない", () => {
  it("変更ファイル一覧が空なら非 0（PR に変更が無いのではなく入力の故障を疑う）", () => {
    const r = run(FILLED_CHECKLIST, []);
    expect(r.status).toBe(1);
    expect(r.json?.status).toBe("input-error");
  });

  it("PR 本文も変更ファイルも渡さなければ使用法エラー（exit 2）", () => {
    const proc = spawnSync(process.execPath, [checker], {
      encoding: "utf8",
      cwd: repoRoot,
      env: { ...process.env, PR_BODY: undefined, PR_CHANGED_FILES: undefined },
    });
    expect(proc.status).toBe(2);
  });
});

describe("check-pr-checklist: 実物の PR テンプレートとの整合", () => {
  it("テンプレートが 4 項目のラベルを同じ綴りで持っている", () => {
    const text = fs.readFileSync(prTemplate, "utf8");
    for (const label of ["何を緩めたか", "理由", "復旧予定日", "代替の検知手段"]) {
      expect(text).toContain(`- ${label}:`);
    }
  });

  it("テンプレートを未記入のまま出した PR は、保護対象の差分があれば落ちる", () => {
    const text = fs.readFileSync(prTemplate, "utf8");
    const r = run(text, ["tests/unit/foo.test.ts"]);
    expect(r.status).toBe(1);
    expect(r.json?.missing.length).toBe(4);
  });

  it("テンプレートを未記入のまま出しても、保護対象の差分が無ければ通る", () => {
    const text = fs.readFileSync(prTemplate, "utf8");
    const r = run(text, ["src/app/page.tsx"]);
    expect(r.status).toBe(0);
  });
});
