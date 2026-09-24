// tests/unit/hooks/lint-changed.test.ts
//
// PostToolUse(Edit|Write|MultiEdit) の 3 本目、`npm run lint:changed` の検証。
//
// 元の定義は `eslint --max-warnings=0 $(git diff --name-only ... origin/main...HEAD ... 2>/dev/null)`
// だった。このリポジトリには remote が無いため `origin/main...HEAD` は常に失敗し、
// `2>/dev/null` に飲まれてファイル一覧が空になり、eslint は引数ゼロで起動して
// 何も検査せず exit 0 を返していた（空振り）。フックは緑のまま、lint は 1 行も
// 走っていない、という一番たちの悪い形。
//
// 直した定義は remote を参照せず、未コミット差分（HEAD との差分）とステージ済み
// 差分の和を対象にし、対象が 0 件なら「対象なし」と明示して exit 0、対象があれば
// eslint を実際に起動する。ここではその定義を package.json から読み出し、使い捨ての
// git リポジトリと eslint のスタブに対して実行して挙動を直に確かめる。

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface PackageJson {
  scripts: Record<string, string | undefined>;
}

const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
const script = pkg.scripts["lint:changed"] ?? "";

interface ScriptResult {
  status: number;
  stdout: string;
  eslintArgv: string[];
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lint-changed-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "-q");
  git("config", "user.email", "lint-changed@example.invalid");
  git("config", "user.name", "lint-changed");
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "tracked.ts"), "export const a = 1;\n");
  writeFileSync(path.join(dir, "README.md"), "seed\n");
  git("add", "src/tracked.ts", "README.md");
  git("commit", "-q", "-m", "seed");

  // eslint のスタブ。呼ばれた事実と渡された引数だけを記録する。
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const stub = path.join(bin, "eslint");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${path.join(dir, "argv.txt")}'\n`);
  chmodSync(stub, 0o755);
  return dir;
}

function runScript(dir: string): ScriptResult {
  const result = spawnSync("sh", ["-c", script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}` },
  });
  const argvFile = path.join(dir, "argv.txt");
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    eslintArgv: existsSync(argvFile)
      ? readFileSync(argvFile, "utf8").split("\n").filter((line) => line !== "")
      : [],
  };
}

const git = (dir: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
};

describe("lint:changed — 定義", () => {
  it("package.json に定義されている", () => {
    expect(script).not.toBe("");
  });

  it("remote（origin/…）を参照しない", () => {
    expect(script).not.toContain("origin/");
  });

  it("未コミット差分（HEAD）とステージ済み差分（--cached）の両方を見る", () => {
    expect(script).toContain("HEAD");
    expect(script).toContain("--cached");
  });
});

describe("lint:changed — 実挙動", () => {
  it("対象が 0 件なら『対象なし』と出して exit 0（eslint は起動しない）", () => {
    const dir = makeRepo();
    const result = runScript(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("対象なし");
    expect(result.eslintArgv).toEqual([]);
  });

  it("未コミットの .ts 変更があれば eslint に渡す", () => {
    const dir = makeRepo();
    writeFileSync(path.join(dir, "src", "tracked.ts"), "export const a = 2;\n");
    const result = runScript(dir);
    expect(result.status).toBe(0);
    expect(result.eslintArgv).toContain("src/tracked.ts");
    expect(result.eslintArgv).toContain("--max-warnings=0");
  });

  it("ステージ済みの新規 .tsx も対象になる", () => {
    const dir = makeRepo();
    writeFileSync(path.join(dir, "src", "added.tsx"), "export const B = () => null;\n");
    git(dir, "add", "src/added.tsx");
    const result = runScript(dir);
    expect(result.status).toBe(0);
    expect(result.eslintArgv).toContain("src/added.tsx");
  });

  it(".ts / .tsx 以外の変更は対象にならない", () => {
    const dir = makeRepo();
    writeFileSync(path.join(dir, "README.md"), "changed\n");
    const result = runScript(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("対象なし");
    expect(result.eslintArgv).toEqual([]);
  });

  it("eslint が落ちたら lint:changed も落ちる（空振りで緑にならない）", () => {
    const dir = makeRepo();
    writeFileSync(path.join(dir, "bin", "eslint"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(dir, "bin", "eslint"), 0o755);
    writeFileSync(path.join(dir, "src", "tracked.ts"), "export const a = 3;\n");
    const result = runScript(dir);
    expect(result.status).toBe(1);
  });
});
