// tests/unit/hooks/record-run.test.ts
//
// check_062 の前半（記録経路そのもの）の機械検証。
// scripts/record-run.sh が「実 exit code・stdout 末尾・HEAD・UTC 時刻」を
// 自作せず自動記入することを確かめる。check_062 の後半（Write ツールでの
// 直接書き込みが PreToolUse で遮断されること）は
// tests/unit/hooks/deny-test-weakening.test.ts が受け持つ。
//
// 本物のリポジトリを汚さないよう、使い捨ての git リポジトリを OS の一時
// ディレクトリに作り、そこへ record-run.sh を複製して走らせる。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceScript = path.join(repoRoot, "scripts", "record-run.sh");

interface RunLogEntry {
  type: string;
  command?: string;
  observation?: string;
  exit_code?: number;
  stdout_tail?: string;
  commit: string;
  ran_at: string;
  by: string;
}

let sandbox = "";
let scriptPath = "";
let headSha = "";

function git(args: string[]): void {
  const result = spawnSync("git", args, { cwd: sandbox, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function recordRun(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", [scriptPath, ...args], {
    cwd: sandbox,
    encoding: "utf8",
    env: { ...process.env, RECORD_RUN_BY: "vitest@sandbox" },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function readLog(taskId: string): RunLogEntry[] {
  const file = path.join(sandbox, "docs", "run-log", `${taskId}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as RunLogEntry[];
}

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "record-run-"));
  git(["init", "--quiet"]);
  git(["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "--allow-empty", "--quiet", "-m", "init"]);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sandbox, encoding: "utf8" });
  headSha = (head.stdout ?? "").trim();

  fs.mkdirSync(path.join(sandbox, "scripts"), { recursive: true });
  scriptPath = path.join(sandbox, "scripts", "record-run.sh");
  fs.copyFileSync(sourceScript, scriptPath);
});

afterAll(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("record-run.sh — 失敗コマンドの記録", () => {
  it("実 exit code・stdout 末尾・HEAD・UTC 時刻を自動記入し、コマンドの exit code で終了する", () => {
    const result = recordRun([
      "task_sandbox_fail",
      "node",
      "-e",
      "console.log('こんにちは'); console.error('boom'); process.exit(3)",
    ]);

    expect(result.status).toBe(3);

    const entries = readLog("task_sandbox_fail");
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("command");
    expect(entry?.exit_code).toBe(3);
    expect(entry?.stdout_tail).toContain("boom");
    expect(entry?.stdout_tail).toContain("こんにちは");
    expect(entry?.commit).toBe(headSha);
    expect(entry?.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(entry?.by).toBe("vitest@sandbox");
    expect(entry?.command).toContain("node");
  });

  it("成功コマンドは exit 0 で記録される", () => {
    const result = recordRun(["task_sandbox_ok", "node", "-e", "console.log('ok')"]);
    expect(result.status).toBe(0);

    const entries = readLog("task_sandbox_ok");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.exit_code).toBe(0);
    expect(entries[0]?.stdout_tail).toContain("ok");
  });

  it("同じ task_id の記録は配列に追記される", () => {
    recordRun(["task_sandbox_append", "node", "-e", "console.log('one')"]);
    recordRun(["task_sandbox_append", "node", "-e", "console.log('two')"]);

    const entries = readLog("task_sandbox_append");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.stdout_tail).toContain("one");
    expect(entries[1]?.stdout_tail).toContain("two");
  });
});

describe("record-run.sh — 人手確認の記録", () => {
  it("--manual は観察結果と HEAD・UTC 時刻を記録して exit 0", () => {
    const result = recordRun(["--manual", "task_sandbox_manual", "SessionStart の注入を目視確認した"]);
    expect(result.status).toBe(0);

    const entries = readLog("task_sandbox_manual");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("manual");
    expect(entries[0]?.observation).toBe("SessionStart の注入を目視確認した");
    expect(entries[0]?.commit).toBe(headSha);
    expect(entries[0]?.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("record-run.sh — 入力の検証", () => {
  it("引数が足りなければ usage で exit 64", () => {
    expect(recordRun([]).status).toBe(64);
    expect(recordRun(["task_sandbox_only"]).status).toBe(64);
  });

  it("task_id にパス区切りを含められない", () => {
    expect(recordRun(["../escape", "node", "-e", ""]).status).toBe(64);
  });
});
