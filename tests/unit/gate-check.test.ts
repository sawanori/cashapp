// tests/unit/gate-check.test.ts
//
// check_037 の機械検証。scripts/gate-check.mjs の CLI 契約と、G0〜G14 の判定ロジックのうち
// 「違反フィクスチャでは表現しにくい分岐」を押さえる:
//
//   - overlay（--root 優先・--base フォールバック）と meta.json の absent / inputs
//   - --only が exit code の範囲だけを絞り、ゲートの実行そのものは絞らないこと
//     （G0 は他ゲートの対象件数を見るので、全ゲートが走らないと判定できない）
//   - G2 の 3 分岐（未着手の未定義参照は warn / 着手済みは違反 / 捏造は未着手でも違反）
//   - ADR のステータス表記 2 形式
//
// 「現状のリポジトリで exit 0」は本ファイルでは検査しない。それは `npm run gate:check` 自身の
// 実行結果（docs/run-log/task_006.json）で示すものであり、ここに入れると G13 のハッシュ基準値が
// 並行タスクの変更で動くたびに無関係な test:unit が赤くなる。
// 空振りしていないことの検査は tests/gates/meta.test.ts（npm run test:gate-meta）が受け持つ。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const gateCheck = path.join(repoRoot, "scripts", "gate-check.mjs");

interface GateResult {
  id: string;
  title: string;
  status: "ok" | "violation" | "warn" | "defer";
  targets: number;
  violations: string[];
  warnings: string[];
  notes: string[];
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const tempDirs: string[] = [];

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-check-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, rel: string, body: unknown): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

function runGateCheck(args: string[]): RunResult {
  const res = spawnSync("node", [gateCheck, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function report(args: string[]): { status: number; results: GateResult[] } {
  const res = runGateCheck([...args, "--json"]);
  const parsed = JSON.parse(res.stdout) as { results: GateResult[] };
  return { status: res.status, results: parsed.results };
}

function gate(results: GateResult[], id: string): GateResult {
  const found = results.find((r) => r.id === id);
  if (!found) throw new Error(`gate ${id} not in report`);
  return found;
}

/** 最小の task を組み立てる。省略した項目は G1 / G2 を通る既定値。 */
function task(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    task_id: "task_950",
    title: "fixture task",
    completion_status: null,
    risk_level: "low",
    adversarial_review: "not_required",
    files_to_create: ["src/lib/example.ts"],
    files_to_modify: [],
    done_definition: ["test:unit が緑"],
    verify_commands: ["npm run test:unit"],
    manual_verification: null,
    acceptance_check_ids: [],
    concerns: [],
    ...overrides,
  };
}

function taskListWith(tasks: Record<string, unknown>[]): Record<string, unknown> {
  return { feature: "unit fixture", version: 1, generated_at: "2026-09-24", notes: "", tasks };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("CLI 契約", () => {
  it("G0〜G14 の 15 ゲートをこの順で報告する", () => {
    const { results } = report([]);
    expect(results.map((r) => r.id)).toEqual([
      "G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7",
      "G8", "G9", "G10", "G11", "G12", "G13", "G14",
    ]);
    for (const r of results) {
      expect(r.title.length).toBeGreaterThan(0);
      expect(["ok", "violation", "warn", "defer"]).toContain(r.status);
    }
  });

  it("知らないゲート ID を --only に渡すと exit 2", () => {
    const res = runGateCheck(["--only", "G99"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("unknown gate id");
  });

  it("task-list を読めない root では exit 2（違反 0 件の緑にしない）", () => {
    const root = makeRoot();
    write(root, "meta.json", { absent: ["docs/task-list.json"] });
    const res = runGateCheck(["--root", root, "--base", repoRoot]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("docs/task-list.json");
  });
});

describe("overlay の解決", () => {
  it("--root にあるファイルが優先され、無いものは --base から読まれる", () => {
    const root = makeRoot();
    write(root, "docs/task-list.json", taskListWith([task({ task_id: "task_951", done_definition: [] })]));
    const { results } = report(["--root", root, "--base", repoRoot]);
    // overlay の task-list が使われている
    expect(gate(results, "G1").violations.join("\n")).toContain("task_951: done_definition が空");
    expect(gate(results, "G1").targets).toBe(1);
    // §13 の表は base から読めているので、実在するスクリプト名は捏造扱いにならない
    expect(gate(results, "G2").violations).toEqual([]);
  });

  it("meta.json の absent は base のファイルを『無い』ことにする", () => {
    const root = makeRoot();
    write(root, "meta.json", { absent: ["docs/run-log/task_011.json"] });
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G4").violations.join("\n")).toContain("docs/run-log/task_011.json がありません");
  });

  it("meta.json の inputs は論理パスを別名のファイルへ差し替える", () => {
    const root = makeRoot();
    write(root, "meta.json", { inputs: { "docs/task-list.json": "tl.json" } });
    write(root, "tl.json", taskListWith([task({ task_id: "task_952", done_definition: [] })]));
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G1").violations.join("\n")).toContain("task_952: done_definition が空");
  });

  it("meta.json の inputs はディレクトリごと差し替えられる", () => {
    const root = makeRoot();
    write(root, "meta.json", { inputs: { "docs/run-log": "rl" } });
    write(root, "docs/task-list.json", taskListWith([task({ task_id: "task_953", completion_status: "DONE" })]));
    write(root, "rl/task_953.json", [
      {
        type: "command",
        command: "npm run test:unit",
        exit_code: 0,
        stdout_tail: "ok",
        commit: "abc",
        ran_at: "2026-09-24T00:00:00Z",
        by: "unit@test",
      },
    ]);
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G4").violations).toEqual([]);
    expect(gate(results, "G4").targets).toBe(1);
  });
});

describe("--only の範囲", () => {
  it("違反のあるゲートを --only から外すと exit 0 になる", () => {
    const root = makeRoot();
    write(root, "docs/task-list.json", taskListWith([task({ task_id: "task_954", done_definition: [] })]));
    const failing = runGateCheck(["--root", root, "--base", repoRoot, "--only", "G1", "--quiet"]);
    expect(failing.status).toBe(1);
    const passing = runGateCheck(["--root", root, "--base", repoRoot, "--only", "G10", "--quiet"]);
    expect(passing.status).toBe(0);
  });

  it("--only を指定しても全ゲートが実行される（G0 が他ゲートの対象件数を見るため）", () => {
    const { results } = report(["--only", "G10"]);
    expect(results).toHaveLength(15);
    expect(gate(results, "G0").notes.join(" ")).toContain("違反フィクスチャ");
  });
});

describe("G2 の 3 分岐", () => {
  it("未着手タスクの未定義スクリプト参照は warn にとどまる", () => {
    const root = makeRoot();
    write(
      root,
      "docs/task-list.json",
      taskListWith([task({ task_id: "task_955", completion_status: null, verify_commands: ["npm run test:contract"] })]),
    );
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G2").violations).toEqual([]);
    expect(gate(results, "G2").warnings.join("\n")).toContain("`test:contract` は未定義");
  });

  it("着手済みタスクの未定義スクリプト参照は違反になる", () => {
    const root = makeRoot();
    write(
      root,
      "docs/task-list.json",
      taskListWith([
        task({ task_id: "task_956", completion_status: "in_progress", verify_commands: ["npm run test:contract"] }),
      ]),
    );
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G2").violations.join("\n")).toContain("`test:contract` が package.json.scripts にありません");
  });

  it("§13 の表にも package.json にも無い名前は、未着手でも捏造として違反になる", () => {
    const root = makeRoot();
    write(
      root,
      "docs/task-list.json",
      taskListWith([task({ task_id: "task_957", completion_status: null, verify_commands: ["npm run make:it:green"] })]),
    );
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G2").violations.join("\n")).toContain("コマンド捏造");
  });
});

describe("G5 の猶予", () => {
  it("task_007 が未完なら warn、DONE なら違反に切り替わる", () => {
    const highDone = task({
      task_id: "task_958",
      completion_status: "DONE",
      risk_level: "high",
      adversarial_review: "required",
    });

    const waiting = makeRoot();
    write(
      waiting,
      "docs/task-list.json",
      taskListWith([highDone, task({ task_id: "task_007", completion_status: null })]),
    );
    const before = report(["--root", waiting, "--base", repoRoot]);
    expect(gate(before.results, "G5").status).toBe("warn");
    expect(gate(before.results, "G5").violations).toEqual([]);

    const ready = makeRoot();
    write(
      ready,
      "docs/task-list.json",
      taskListWith([highDone, task({ task_id: "task_007", completion_status: "DONE" })]),
    );
    const after = report(["--root", ready, "--base", repoRoot]);
    expect(gate(after.results, "G5").status).toBe("violation");
    expect(gate(after.results, "G5").violations.join("\n")).toContain("docs/review-log/task_958.json");
  });
});

describe("G10 の ADR ステータス表記", () => {
  it("箇条書き形式と見出し形式の両方を読む", () => {
    const root = makeRoot();
    write(
      root,
      "docs/decisions/ADR-960-inline.md",
      "# ADR-960\n\n- ステータス: accepted\n- Confidence: high\n\n本文に未確認の依存は無い。\n",
    );
    write(
      root,
      "docs/decisions/ADR-961-heading.md",
      "# ADR-961\n\n## ステータス\n\n`accepted`\n\n## 決定\n\n未確認の外部仕様 [不明] に依存する。\n",
    );
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G10").targets).toBe(2);
    const joined = gate(results, "G10").violations.join("\n");
    expect(joined).toContain("ADR-961-heading.md");
    expect(joined).not.toContain("ADR-960-inline.md");
  });
});

describe("G11 のしきい値", () => {
  it("未解決 high が 2 件までは in_progress を止めない", () => {
    const root = makeRoot();
    write(
      root,
      "docs/task-list.json",
      taskListWith([
        task({
          task_id: "task_962",
          concerns: ["[severity: high] 未解決 A です。対応案を書いてあります。", "[severity: high] 未解決 B です。対応案を書いてあります。"],
        }),
        task({ task_id: "task_963", completion_status: "in_progress" }),
      ]),
    );
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G11").violations).toEqual([]);
  });

  it("『修正済み』と書かれた high concerns は残高に数えない", () => {
    const root = makeRoot();
    write(
      root,
      "docs/task-list.json",
      taskListWith([
        task({
          task_id: "task_964",
          concerns: [
            "[severity: high] 未解決 A です。対応案を書いてあります。",
            "[severity: high] 未解決 B です。対応案を書いてあります。",
            "[severity: high / 本セッションで修正済み] C は直しました。",
          ],
        }),
        task({ task_id: "task_965", completion_status: "in_progress" }),
      ]),
    );
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G11").violations).toEqual([]);
    expect(gate(results, "G11").notes.join(" ")).toContain("未解決 high concerns 2 件");
  });

  it("残懸念が docs/concerns/<task_id>.md にしか無くても残高に数える", () => {
    const root = makeRoot();
    write(
      root,
      "docs/task-list.json",
      taskListWith([
        task({ task_id: "task_966", completion_status: "DONE_WITH_CONCERNS", concerns: [] }),
        task({ task_id: "task_967", completion_status: "in_progress" }),
      ]),
    );
    write(
      root,
      "docs/concerns/task_966.md",
      [
        "# task_966 の残懸念",
        "",
        "## 1. 署名検証が未実装",
        "",
        "- **深刻度**: high",
        "- **対応案**: 契約テストを先に書く。",
        "",
        "## 2. 冪等キーの越境",
        "",
        "- **深刻度**: high",
        "- **対応案**: 複合一意で塞ぐ。",
        "",
        "## 3. 追記専用トリガ漏れ",
        "",
        "- **深刻度**: high",
        "- **対応案**: マイグレーションを追加する。",
        "",
      ].join("\n"),
    );
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G11").notes.join(" ")).toContain("未解決 high concerns 3 件");
    expect(gate(results, "G11").violations.join("\n")).toContain("task_967 を進められません");
  });
});

describe("G4 の manual_verification 対応づけ", () => {
  /** PROGRESS.md をベースから拾わせないための空の宣言 */
  const emptyProgress = "# PROGRESS（unit fixture）\n\n宣言なし。\n";

  function manualEntry(observation: string): Record<string, unknown> {
    return {
      type: "manual",
      observation,
      by: "po@example",
      ran_at: "2026-09-24T00:00:00Z",
      commit: "0123456789abcdef0123456789abcdef01234567",
    };
  }

  it("項目 3 件に対し manual 記録 1 件なら、残り 2 件が違反になる", () => {
    const root = makeRoot();
    write(root, "docs/PROGRESS.md", emptyProgress);
    write(
      root,
      "docs/task-list.json",
      taskListWith([
        task({
          task_id: "task_970",
          completion_status: "DONE",
          files_to_create: ["docs/ops/example.md"],
          verify_commands: [],
          manual_verification: ["項目 A を確認", "項目 B を確認", "項目 C を確認"],
        }),
      ]),
    );
    write(root, "docs/run-log/task_970.json", [manualEntry("項目 A を確認 した。想定どおり。")]);
    const { results } = report(["--root", root, "--base", repoRoot]);
    const g4 = gate(results, "G4");
    expect(g4.violations.join("\n")).toContain("manual_verification[1]");
    expect(g4.violations.join("\n")).toContain("manual_verification[2]");
    expect(g4.violations.filter((v) => v.includes("manual_verification[0]"))).toEqual([]);
  });

  it("項目を名乗る manual 記録が項目数ぶんあれば通る", () => {
    const root = makeRoot();
    write(root, "docs/PROGRESS.md", emptyProgress);
    write(
      root,
      "docs/task-list.json",
      taskListWith([
        task({
          task_id: "task_971",
          completion_status: "DONE",
          files_to_create: ["docs/ops/example.md"],
          verify_commands: [],
          manual_verification: ["項目 A を確認", "項目 B を確認"],
        }),
      ]),
    );
    write(root, "docs/run-log/task_971.json", [
      manualEntry("manual_verification[0] 項目 A を確認 した。"),
      manualEntry("manual_verification[1] 項目 B を確認 した。"),
    ]);
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G4").violations).toEqual([]);
    expect(gate(results, "G4").warnings).toEqual([]);
  });

  it("同じ項目を名乗る記録が 2 件あっても、名乗られていない項目は充当されない", () => {
    const root = makeRoot();
    write(root, "docs/PROGRESS.md", emptyProgress);
    write(
      root,
      "docs/task-list.json",
      taskListWith([
        task({
          task_id: "task_972",
          completion_status: "DONE",
          files_to_create: ["docs/ops/example.md"],
          verify_commands: [],
          manual_verification: ["項目 A を確認", "項目 B を確認", "項目 C を確認"],
        }),
      ]),
    );
    write(root, "docs/run-log/task_972.json", [
      manualEntry("manual_verification[0] 一度目の確認。"),
      manualEntry("manual_verification[0] 二度目の確認。"),
    ]);
    const { results } = report(["--root", root, "--base", repoRoot]);
    const g4 = gate(results, "G4");
    // 2 件目は名乗りが [0] なので 1st pass では使われず、2nd pass で残り項目に回る。
    // 3 項目に対し記録は 2 件しか無いので、最後の 1 項目は必ず落ちる。
    expect(g4.violations.join("\n")).toContain("manual_verification[2]");
  });

  it("実施者・UTC 日時・HEAD のいずれかを欠く manual 記録は充当に使わない", () => {
    const root = makeRoot();
    write(root, "docs/PROGRESS.md", emptyProgress);
    write(
      root,
      "docs/task-list.json",
      taskListWith([
        task({
          task_id: "task_973",
          completion_status: "DONE",
          files_to_create: ["docs/ops/example.md"],
          verify_commands: [],
          manual_verification: ["項目 A を確認"],
        }),
      ]),
    );
    write(root, "docs/run-log/task_973.json", [
      { type: "manual", observation: "項目 A を確認 した。", ran_at: "2026-09-24T00:00:00Z" },
    ]);
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G4").violations.join("\n")).toContain("manual_verification[0]");
  });
});

describe("G4 の PROGRESS.md と台帳の同期", () => {
  it("PROGRESS.md が完了を宣言しているのに台帳が null なら違反になる", () => {
    const root = makeRoot();
    write(root, "docs/task-list.json", taskListWith([task({ task_id: "task_974" })]));
    write(root, "docs/PROGRESS.md", "# PROGRESS\n\n- task_974: DONE — 完了と宣言している。\n");
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G4").violations.join("\n")).toContain("task_974: docs/PROGRESS.md は DONE");
  });

  it("両者が一致していれば違反にならない", () => {
    const root = makeRoot();
    write(
      root,
      "docs/task-list.json",
      taskListWith([task({ task_id: "task_975", completion_status: "DONE" })]),
    );
    write(root, "docs/PROGRESS.md", "# PROGRESS\n\n- task_975: DONE — 完了と宣言している。\n");
    write(root, "docs/run-log/task_975.json", [
      {
        type: "command",
        command: "npm run test:unit",
        exit_code: 0,
        commit: "0123456789abcdef0123456789abcdef01234567",
        ran_at: "2026-09-24T00:00:00Z",
        by: "po@example",
      },
    ]);
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G4").violations).toEqual([]);
  });
});

describe("gate-inputs は overlay からしか読まない", () => {
  it("--root の gate-inputs/head.txt は G9 の HEAD を固定する", () => {
    const root = makeRoot();
    const pinned = "1111111111111111111111111111111111111111";
    write(root, "gate-inputs/head.txt", `${pinned}\n`);
    write(root, "docs/acceptance-checks.json", {
      feature: "unit fixture",
      version: 1,
      checks: [
        {
          id: "check_901",
          target: "例",
          rule: "例",
          expected_result: "例",
          verification_method: "automated",
          evidence: { commit: "2222222222222222222222222222222222222222" },
        },
      ],
    });
    const { results } = report(["--root", root, "--base", repoRoot]);
    expect(gate(results, "G9").violations.join("\n")).toContain(pinned.slice(0, 12));
  });

  it("ベース側に gate-inputs/ があると G8 / G0 が違反として報告する", () => {
    // リポジトリのトップレベルを symlink で束ねた使い捨てのベースを組み立てる
    // （リポジトリ自体は変更しない）。
    const fakeBase = makeRoot();
    for (const name of fs.readdirSync(repoRoot)) {
      fs.symlinkSync(path.join(repoRoot, name), path.join(fakeBase, name));
    }
    write(fakeBase, "gate-inputs/git-diff.json", { lines: ["+++ b/src/harmless.ts", "+export const x = 1;"] });
    const { results, status } = report(["--base", fakeBase, "--only", "G8"]);
    expect(status).toBe(1);
    expect(gate(results, "G8").violations.join("\n")).toContain("リポジトリ直下に gate-inputs/ があります");
    expect(gate(results, "G0").violations.join("\n")).toContain("リポジトリ直下に gate-inputs/ があります");
    // 植え付けた偽 diff は採用されない: 実作業ツリーの追加行が走査される
    expect(gate(results, "G8").targets).toBeGreaterThan(2);
  });
});

describe("Stop フック向けの出力先", () => {
  it("非ゼロ終了のときは違反行と集計行を stderr にも書く", () => {
    const root = makeRoot();
    write(root, "docs/task-list.json", taskListWith([task({ task_id: "task_976", done_definition: [] })]));
    const res = runGateCheck(["--root", root, "--base", repoRoot, "--only", "G1"]);
    expect(res.status).toBe(1);
    // Claude Code の Stop フックは非ブロッキングの非ゼロ終了で stderr だけを見せる
    expect(res.stderr).toContain("gate:check —");
    expect(res.stderr).toContain("FAIL G1");
    expect(res.stderr).toContain("done_definition が空");
  });

  it("exit 0 のときは stderr に何も書かない", () => {
    const res = runGateCheck(["--only", "G3", "--quiet"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
  });
});
