// tests/unit/ci/acceptance-rerun.test.ts
//
// `.github/workflows/gate.yml` の acceptance ジョブ「完了タスクの verify_commands を
// CI で再実行」ステップの機械検証。
//
// このステップは F2（完了の過大申告）に対する最後の防衛線である。実装者の自己申告
// （docs/run-log/**）ではなく、CI が台帳の verify_commands を自分で走らせ直して
// 赤いものを赤いまま伝播させる。そして docs/task-list.json は誰でも書ける普通の
// ファイルで、test-tamper-guard の保護対象にも G13 のハッシュ対象にも入っていない。
// つまり「台帳に 1 行足すと再実行が常に成功する」形の穴は、そのまま
// 完了の過大申告を素通りさせる穴になる。
//
// これまでに 2 つの穴を実測で潰した。どちらも「検出ログすら出さずに緑になる」形だった。
//   (1) 台帳の文字列を `sh -c` に渡していたため `npm run x || true` が通った
//       → `^npm run <script>$` の完全一致を要求し、シェルを介さず引数として渡す
//   (2) 一覧を `done < <(jq …)` でループの**標準入力**に流し込んでいたため、
//       標準入力を読むコマンドが 1 本混ざるとそのコマンドが一覧を食い尽くし、
//       後続の verify_commands が実行されないまま「失敗 0 / exit 0」で緑になった
//       → 一覧を fd 3 に逃がし、再実行する子プロセスの標準入力を `< /dev/null` で塞ぐ
//
// 検証の方法: 実ファイル `.github/workflows/gate.yml` を YAML パースして当該ステップの
// `run:` 本文をそのまま取り出し、fixture の package.json / docs/task-list.json を置いた
// 一時ディレクトリで `bash` に食わせる。判定器のコピーではなく**実際に CI が走らせる
// 文字列**を走らせるので、YAML を書き換えれば必ずこのテストが動く。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowPath = path.join(repoRoot, ".github", "workflows", "gate.yml");

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowDoc {
  jobs?: Record<string, { steps?: WorkflowStep[] } | undefined>;
}

/** 実ファイルから acceptance ジョブの再実行ステップの `run:` 本文を取り出す。 */
function extractRerunBody(): string {
  const doc = YAML.parse(fs.readFileSync(workflowPath, "utf8")) as WorkflowDoc;
  const steps = doc.jobs?.acceptance?.steps;
  if (!Array.isArray(steps)) {
    throw new Error("gate.yml に jobs.acceptance.steps がありません");
  }
  const matched = steps.filter(
    (step) => typeof step.name === "string" && step.name.includes("verify_commands を CI で再実行"),
  );
  if (matched.length !== 1) {
    throw new Error(
      `gate.yml の acceptance に「verify_commands を CI で再実行」ステップが ${matched.length} 件あります（1 件であるべき）`,
    );
  }
  const body = matched[0]?.run;
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new Error("再実行ステップに run: 本文がありません");
  }
  return body;
}

let rerunBody = "";

beforeAll(() => {
  rerunBody = extractRerunBody();
});

interface Ledger {
  tasks: Array<{
    task_id: string;
    completion_status: string | null;
    verify_commands?: string[];
  }>;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  output: string;
}

/**
 * fixture の package.json と docs/task-list.json を置いた一時ディレクトリで、
 * 実ファイルから取り出した再実行ループをそのまま走らせる。
 */
function runLoop(scripts: Record<string, string>, ledger: Ledger): RunResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-rerun-"));
  tmpDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "acceptance-rerun-fixture", private: true, scripts }, null, 2),
    "utf8",
  );
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "task-list.json"), JSON.stringify(ledger, null, 2), "utf8");

  const scriptPath = path.join(dir, "loop.sh");
  fs.writeFileSync(scriptPath, rerunBody, "utf8");

  const proc = spawnSync("bash", [scriptPath], {
    cwd: dir,
    encoding: "utf8",
    // 標準入力は「閉じた空のパイプ」にする。子プロセスがここを読んでも
    // 一覧（fd 3）は減らないことを固定するため、意図的に ignore ではなく空入力を渡す。
    input: "",
    env: { ...process.env },
  });
  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  return { status: proc.status ?? -1, stdout, stderr, output: `${stdout}\n${stderr}` };
}

/** 「実行 N / 委譲 N / 失敗 N / 形式違反 N」のサマリ行を数値に戻す。 */
function summaryOf(out: string): { ran: number; skipped: number; failed: number; malformed: number } {
  const m = out.match(/実行 (\d+) \/ 委譲 (\d+) \/ 失敗 (\d+) \/ 形式違反 (\d+)/);
  if (!m) throw new Error(`サマリ行が出力にありません:\n${out}`);
  return {
    ran: Number(m[1]),
    skipped: Number(m[2]),
    failed: Number(m[3]),
    malformed: Number(m[4]),
  };
}

const done = (verify_commands: string[]): Ledger => ({
  tasks: [{ task_id: "t1", completion_status: "DONE", verify_commands }],
});

describe("gate.yml acceptance: verify_commands の再実行", () => {
  it("正常系: 完全一致のコマンドが実行され、全部通れば exit 0", () => {
    const res = runLoop({ ok1: "exit 0", ok2: "exit 0" }, done(["npm run ok1", "npm run ok2"]));
    expect(res.status).toBe(0);
    expect(summaryOf(res.output)).toEqual({ ran: 2, skipped: 0, failed: 0, malformed: 0 });
  });

  it("赤いコマンドは赤いまま伝播する（exit 1）", () => {
    const res = runLoop({ bad: "exit 7" }, done(["npm run bad"]));
    expect(res.status).toBe(1);
    expect(summaryOf(res.output).failed).toBe(1);
    expect(res.output).toContain("FAIL  npm run bad");
  });

  // ---------------------------------------------------------------------
  // 穴 (2) の回帰固定。これがこの周で塞いだもの。
  // 旧実装（一覧をループの標準入力に流し、`npm run "$name"` の stdin を塞がない）では
  // 下の 1 本目が一覧を食い尽くし、2 本目が実行されないまま exit 0 になっていた。
  // ---------------------------------------------------------------------
  it("標準入力を読むコマンドが混ざっても、後続の verify_commands が飛ばされない", () => {
    const res = runLoop(
      { "aaa-eats-stdin": "cat > /dev/null; exit 0", "zzz-should-fail": "exit 7" },
      done(["npm run aaa-eats-stdin", "npm run zzz-should-fail"]),
    );
    expect(res.output).toContain("RUN   npm run zzz-should-fail");
    expect(res.output).toContain("FAIL  npm run zzz-should-fail");
    expect(summaryOf(res.output)).toEqual({ ran: 1, skipped: 0, failed: 1, malformed: 0 });
    expect(res.status).toBe(1);
  });

  it("標準入力を読むコマンドが先頭にあっても、後続 2 本がどちらも実行される", () => {
    const res = runLoop(
      {
        "aaa-eats-stdin": "cat > /dev/null; exit 0",
        "mmm-ok": "exit 0",
        "zzz-ok": "exit 0",
      },
      done(["npm run aaa-eats-stdin", "npm run mmm-ok", "npm run zzz-ok"]),
    );
    expect(res.status).toBe(0);
    expect(summaryOf(res.output).ran).toBe(3);
    expect(res.output).toContain("RUN   npm run mmm-ok");
    expect(res.output).toContain("RUN   npm run zzz-ok");
  });

  it("標準入力を読むコマンドの前に赤いコマンドがあっても赤のまま（食い尽くしで緑化しない）", () => {
    const res = runLoop(
      { "aaa-fails": "exit 3", "zzz-eats-stdin": "cat > /dev/null; exit 0" },
      done(["npm run aaa-fails", "npm run zzz-eats-stdin"]),
    );
    expect(res.status).toBe(1);
    expect(summaryOf(res.output)).toEqual({ ran: 1, skipped: 0, failed: 1, malformed: 0 });
  });

  // ---------------------------------------------------------------------
  // 穴 (1) の回帰固定（3 周目で塞いだもの）。
  // ---------------------------------------------------------------------
  it.each([
    ["npm run bad || true", "|| true"],
    ["npm run bad ; echo ok", "; echo"],
    ["npm run bad && echo ok", "&& echo"],
    ["npm run bad | cat", "パイプ"],
    ["node -e 'process.exit(0)'", "npm 以外"],
  ])("完全一致でない値 %s は実行せず形式違反にする", (cmd) => {
    const res = runLoop({ bad: "exit 3", ok1: "exit 0" }, done([cmd, "npm run ok1"]));
    expect(res.status).toBe(1);
    expect(res.output).toContain("完全一致ではありません");
    expect(summaryOf(res.output).malformed).toBe(1);
    // 違反を 1 件見つけても残りは走る（黙って打ち切らない）。
    expect(summaryOf(res.output).ran).toBe(1);
  });

  // ---------------------------------------------------------------------
  // DB 依存の委譲。名前で判定するので、シェルを足して委譲判定をすり抜けられない。
  // ---------------------------------------------------------------------
  it("実 Postgres が要るコマンドは gate-integration.yml へ委譲し、飛ばした事実を出力する", () => {
    const res = runLoop({ ok1: "exit 0" }, done(["npm run test:integration", "npm run ok1"]));
    expect(res.status).toBe(0);
    expect(res.output).toContain("SKIP  npm run test:integration");
    expect(res.output).toContain("gate-integration.yml");
    expect(summaryOf(res.output)).toEqual({ ran: 1, skipped: 1, failed: 0, malformed: 0 });
  });

  it("委譲対象の名前にシェルを足した値は委譲されず形式違反になる", () => {
    const res = runLoop({ ok1: "exit 0" }, done(["npm run test:integration || true", "npm run ok1"]));
    expect(res.status).toBe(1);
    expect(summaryOf(res.output)).toEqual({ ran: 1, skipped: 0, failed: 0, malformed: 1 });
  });

  // ---------------------------------------------------------------------
  // 空振りを緑にしない。
  // ---------------------------------------------------------------------
  it("台帳から 1 行も読めなければ exit 1（走査 0 件を緑にしない）", () => {
    const res = runLoop({ ok1: "exit 0" }, { tasks: [] });
    expect(res.status).toBe(1);
    expect(res.output).toContain("再実行の対象が 0 件です");
  });

  it("completion_status が null のタスクだけなら再実行対象が 0 件で exit 1", () => {
    const res = runLoop(
      { ok1: "exit 0" },
      { tasks: [{ task_id: "t1", completion_status: null, verify_commands: ["npm run ok1"] }] },
    );
    expect(res.status).toBe(1);
    expect(res.output).toContain("再実行の対象が 0 件です");
  });

  it("全件が形式違反のとき、『0 件』ではなく形式違反として落ちる", () => {
    const res = runLoop({ ok1: "exit 0" }, done(["npm run ok1 || true"]));
    expect(res.status).toBe(1);
    expect(summaryOf(res.output)).toEqual({ ran: 0, skipped: 0, failed: 0, malformed: 1 });
    // 1 行は読めているので「台帳の読み取りが壊れている」ではない。
    expect(res.output).not.toContain("再実行の対象が 0 件です");
  });
});
