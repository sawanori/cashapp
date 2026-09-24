// tests/unit/hooks/deny-test-weakening.test.ts
//
// check_036 / check_062（Write ツール側）の機械検証。
// scripts/deny-test-weakening.sh を実際に spawn して、
// PreToolUse(Edit|Write|MultiEdit) のフック入力 JSON を stdin に流す。2 = 遮断。
//
// テスト弱体化の見本（.skip / .only / .todo）と本番鍵の見本は、
// いずれもリテラルで書かず実行時に組み立てる。リテラルで書くと
// このファイル自身が同じフックに引っかかって書き換えられなくなるため。

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = path.join(repoRoot, "scripts", "deny-test-weakening.sh");

const SKIP = ["it", "skip"].join(".");
const ONLY = ["describe", "only"].join(".");
const TODO = ["test", "todo"].join(".");
const LIVE_SECRET = ["sk", "live", "51ABCdefGHIjkl"].join("_");

interface RunResult {
  status: number;
  stderr: string;
}

function runHook(payload: unknown): RunResult {
  const result = spawnSync("bash", [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repoRoot },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

function write(filePath: string, content: string): RunResult {
  return runHook({ tool_name: "Write", tool_input: { file_path: filePath, content } });
}

function edit(filePath: string, oldString: string, newString: string): RunResult {
  return runHook({
    tool_name: "Edit",
    tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
  });
}

function multiEdit(
  filePath: string,
  edits: { old_string: string; new_string: string }[],
): RunResult {
  return runHook({ tool_name: "MultiEdit", tool_input: { file_path: filePath, edits } });
}

function mcp(toolName: string, toolInput: Record<string, unknown>): RunResult {
  return runHook({ tool_name: toolName, tool_input: toolInput });
}

const TWO_ASSERTIONS = [
  'it("rank は動かない", () => {',
  "  expect(invoice.settlementRank).toBe(0);",
  "  expect(ledger.entries).toHaveLength(1);",
  "});",
].join("\n");

const ONE_ASSERTION = [
  'it("rank は動かない", () => {',
  "  expect(invoice.settlementRank).toBe(0);",
  "});",
].join("\n");

describe("deny-test-weakening.sh — run-log / gates / evidence への直接書き込み", () => {
  it("Write で docs/run-log/<task>.json を書こうとすると exit 2", () => {
    expect(write("docs/run-log/task_005.json", "[]").status).toBe(2);
  });

  it("絶対パスでも docs/run-log/ は遮断する", () => {
    expect(write(path.join(repoRoot, "docs/run-log/task_005.json"), "[]").status).toBe(2);
  });

  it("Write で docs/gates/legal-clearance.json を書こうとすると exit 2", () => {
    expect(write("docs/gates/legal-clearance.json", '{"cleared": true}').status).toBe(2);
  });

  it("Edit で docs/gates/compliance-gates.json の status を書き換えると exit 2", () => {
    expect(edit("docs/gates/compliance-gates.json", '"status": "unknown"', '"status": "passed"').status).toBe(2);
  });

  it("Edit で acceptance-checks.json の evidence を書くと exit 2", () => {
    expect(edit("docs/acceptance-checks.json", '"evidence": null', '"evidence": "run-log"').status).toBe(2);
  });

  it("遮断時は理由を stderr に書く", () => {
    const result = write("docs/run-log/task_005.json", "[]");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("BLOCKED");
  });
});

describe("deny-test-weakening.sh — tests/** の弱体化", () => {
  it("expect を減らす Edit は exit 2", () => {
    expect(edit("tests/contract/duplicate.test.ts", TWO_ASSERTIONS, ONE_ASSERTION).status).toBe(2);
  });

  it("it/test ごと消す Edit は exit 2", () => {
    const before = `${TWO_ASSERTIONS}\n${TWO_ASSERTIONS}`;
    expect(edit("tests/contract/duplicate.test.ts", before, TWO_ASSERTIONS).status).toBe(2);
  });

  it("skip 修飾子の追加は exit 2", () => {
    const after = TWO_ASSERTIONS.replace("it(", `${SKIP}(`);
    expect(edit("tests/contract/duplicate.test.ts", TWO_ASSERTIONS, after).status).toBe(2);
  });

  it("only 修飾子の追加は exit 2", () => {
    const after = `${ONLY}("一部だけ", () => {\n${TWO_ASSERTIONS}\n});`;
    expect(edit("tests/contract/duplicate.test.ts", TWO_ASSERTIONS, after).status).toBe(2);
  });

  it("todo 修飾子の追加は exit 2", () => {
    const after = `${TODO}("あとで");\n${TWO_ASSERTIONS}`;
    expect(edit("tests/contract/duplicate.test.ts", TWO_ASSERTIONS, after).status).toBe(2);
  });

  it("MultiEdit でも合計のアサーション数で判定する", () => {
    const result = multiEdit("tests/contract/duplicate.test.ts", [
      { old_string: TWO_ASSERTIONS, new_string: ONE_ASSERTION },
      { old_string: "const a = 1;", new_string: "const a = 2;" },
    ]);
    expect(result.status).toBe(2);
  });

  it("アサーションを増やす Edit は通す", () => {
    expect(edit("tests/contract/duplicate.test.ts", ONE_ASSERTION, TWO_ASSERTIONS).status).toBe(0);
  });

  it("新しいテストファイルの作成は通す", () => {
    expect(write("tests/unit/new-thing.test.ts", TWO_ASSERTIONS).status).toBe(0);
  });
});

describe("deny-test-weakening.sh — ハーネス自身の保全", () => {
  it("Write でガード本体を書き換えると exit 2", () => {
    expect(write("scripts/deny-dangerous-bash.sh", "exit 0\n").status).toBe(2);
  });

  it("Edit でもう一方のガード本体を書き換えると exit 2", () => {
    expect(edit("scripts/deny-test-weakening.sh", "exit 2", "exit 0").status).toBe(2);
  });

  it("Write で record-run.sh を書き換えると exit 2", () => {
    expect(write("scripts/record-run.sh", "exit 0\n").status).toBe(2);
  });

  it("絶対パスでもガード本体は遮断する", () => {
    expect(write(path.join(repoRoot, "scripts/deny-dangerous-bash.sh"), "exit 0\n").status).toBe(2);
  });

  it("ガード以外の scripts/ は通す", () => {
    expect(write("scripts/session-brief.mjs", "process.exit(0);\n").status).toBe(0);
  });

  it("settings.json をそのまま書き直すのは通す", () => {
    const current = readFileSync(path.join(repoRoot, ".claude/settings.json"), "utf8");
    expect(write(".claude/settings.json", current).status).toBe(0);
  });

  it("settings.json からガードの参照を落とす Write は exit 2", () => {
    const current = readFileSync(path.join(repoRoot, ".claude/settings.json"), "utf8");
    const weakened = current.replace("deny-dangerous-bash.sh", "noop.sh");
    expect(weakened).not.toBe(current);
    expect(write(".claude/settings.json", weakened).status).toBe(2);
  });

  it("settings.json からガード登録を Edit で外すと exit 2", () => {
    const before = '"command": "bash \\"$CLAUDE_PROJECT_DIR/scripts/deny-test-weakening.sh\\""';
    const after = '"command": "true"';
    expect(edit(".claude/settings.json", before, after).status).toBe(2);
  });

  it("settings.json にフックを追加する Edit は通す", () => {
    const before = '"command": "bash \\"$CLAUDE_PROJECT_DIR/scripts/append-handoff.sh\\""';
    const after = [
      '"command": "bash \\"$CLAUDE_PROJECT_DIR/scripts/append-handoff.sh\\""',
      '},{"type": "command", "command": "npm run --silent gate:check"',
    ].join("\n");
    expect(edit(".claude/settings.json", before, after).status).toBe(0);
  });

  it("ガード参照を含まない .claude/ のファイルは通す", () => {
    expect(write(".claude/agents/release-auditor.md", "# release auditor\n").status).toBe(0);
  });
});

// スクリプト名の出現回数は構造の検査になっていない。`hooks` キーの改名・
// matcher の差し替え・event の付け替えは、名前を 1 つも減らさずにガードを
// 止められる。編集後のファイルを組み立てて jq で解析し、期待するイベント・
// matcher・コマンドが残っているかを見る。
describe("deny-test-weakening.sh — .claude/settings.json の構造検査", () => {
  const settings = readFileSync(path.join(repoRoot, ".claude/settings.json"), "utf8");
  const rewritten = (from: string, to: string): string => {
    const next = settings.replace(from, to);
    expect(next).not.toBe(settings);
    return next;
  };

  it("hooks キーの改名は exit 2", () => {
    expect(write(".claude/settings.json", rewritten('"hooks":', '"hooks_disabled":')).status).toBe(2);
  });

  it("PreToolUse の Bash matcher を別ツールに差し替えると exit 2", () => {
    expect(
      write(".claude/settings.json", rewritten('"matcher": "Bash"', '"matcher": "Task"')).status,
    ).toBe(2);
  });

  it("matcher を狭めると exit 2", () => {
    expect(
      write(
        ".claude/settings.json",
        rewritten('"matcher": "Edit|Write|MultiEdit"', '"matcher": "Write"'),
      ).status,
    ).toBe(2);
  });

  it("イベント名を付け替えて登録を無効化すると exit 2", () => {
    expect(
      write(".claude/settings.json", rewritten('"Stop": [', '"StopDisabled": [')).status,
    ).toBe(2);
  });

  it("PostToolUse の検査コマンドを 1 つ落とすと exit 2", () => {
    expect(write(".claude/settings.json", rewritten("lint:changed", "true")).status).toBe(2);
  });

  it("ガード名をコメントに残して command を無効化しても exit 2", () => {
    expect(
      write(
        ".claude/settings.json",
        rewritten(
          'bash \\"$CLAUDE_PROJECT_DIR/scripts/deny-dangerous-bash.sh\\"',
          "true # deny-dangerous-bash.sh",
        ),
      ).status,
    ).toBe(2);
  });

  it("JSON として壊れた settings.json は exit 2", () => {
    expect(write(".claude/settings.json", settings.slice(0, -20)).status).toBe(2);
  });

  it("matcher の拡張（対象ツールを増やす）は通す", () => {
    expect(
      write(
        ".claude/settings.json",
        rewritten('"matcher": "Edit|Write|MultiEdit"', '"matcher": "Edit|Write|MultiEdit|NotebookEdit"'),
      ).status,
    ).toBe(0);
  });

  it("遮断時はどの登録が失われたかを stderr に書く", () => {
    const result = write(".claude/settings.json", rewritten('"matcher": "Bash"', '"matcher": "Task"'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("PreToolUse[Bash] -> deny-dangerous-bash.sh");
  });
});

// PreToolUse の matcher が Edit|Write|MultiEdit だけだった間、MCP のファイル
// 編集ツールはこのガードを 1 度も起動せずに保護対象を書き換えられた。matcher を
// 広げたうえで、tool_input の relative_path 等から対象を取り出して同じ判定に掛ける。
describe("deny-test-weakening.sh — MCP のファイル編集ツール", () => {
  it("tests/** のアサーションを減らす replace_content は exit 2", () => {
    const result = mcp("mcp__serena__replace_content", {
      relative_path: "tests/contract/duplicate.test.ts",
      needle: TWO_ASSERTIONS,
      repl: ONE_ASSERTION,
      mode: "literal",
    });
    expect(result.status).toBe(2);
  });

  it("編集前を示さない symbol 編集で tests/** を触ると exit 2", () => {
    const result = mcp("mcp__serena__replace_symbol_body", {
      relative_path: "tests/contract/duplicate.test.ts",
      name_path: "duplicate",
      body: "it('x', () => {});",
    });
    expect(result.status).toBe(2);
  });

  it("シンボル削除で tests/** を触ると exit 2", () => {
    const result = mcp("mcp__serena__safe_delete_symbol", {
      relative_path: "tests/contract/duplicate.test.ts",
      name_path_pattern: "duplicate",
    });
    expect(result.status).toBe(2);
  });

  it("ガード本体を MCP で書き換えると exit 2", () => {
    const result = mcp("mcp__serena__replace_symbol_body", {
      relative_path: "scripts/deny-dangerous-bash.sh",
      name_path: "block",
      body: "exit 0",
    });
    expect(result.status).toBe(2);
  });

  it("docs/run-log を MCP で書き換えると exit 2", () => {
    const result = mcp("mcp__serena__replace_content", {
      relative_path: "docs/run-log/task_005.json",
      needle: "[]",
      repl: "[{}]",
      mode: "literal",
    });
    expect(result.status).toBe(2);
  });

  it("docs/gates を MCP で書き換えると exit 2", () => {
    const result = mcp("mcp__serena__replace_content", {
      relative_path: "docs/gates/legal-clearance.json",
      needle: "false",
      repl: "true",
      mode: "literal",
    });
    expect(result.status).toBe(2);
  });

  it(".claude/** は構造検査を組み立てられないので MCP からは一律 exit 2", () => {
    const result = mcp("mcp__serena__replace_content", {
      relative_path: ".claude/settings.json",
      needle: "Bash",
      repl: "Task",
      mode: "literal",
    });
    expect(result.status).toBe(2);
  });

  it("対象ファイルを限定しない一括編集は exit 2", () => {
    const result = mcp("mcp__serena__replace_in_files", {
      needle: "expect(",
      repl: "// expect(",
      mode: "literal",
    });
    expect(result.status).toBe(2);
  });

  it("グロブで保護対象へ広げる一括編集は exit 2", () => {
    const result = mcp("mcp__serena__replace_in_files", {
      relative_path: "src",
      paths_include_glob: "tests/**/*.ts",
      needle: "expect(",
      repl: "//",
      mode: "literal",
    });
    expect(result.status).toBe(2);
  });

  it("本番鍵を書き込む MCP 編集は exit 2", () => {
    const result = mcp("mcp__serena__replace_symbol_body", {
      relative_path: "src/lib/payments/keys.ts",
      name_path: "KEY",
      body: `const KEY = "${LIVE_SECRET}";`,
    });
    expect(result.status).toBe(2);
  });

  it("読み取り専用の MCP ツールは素通しする", () => {
    const result = mcp("mcp__serena__find_symbol", {
      relative_path: "tests/contract/duplicate.test.ts",
      name_path: "duplicate",
    });
    expect(result.status).toBe(0);
  });

  it("src 配下の MCP 編集は通す", () => {
    const result = mcp("mcp__serena__replace_symbol_body", {
      relative_path: "src/app/page.tsx",
      name_path: "Page",
      body: "export default function Page() {\n  return null;\n}",
    });
    expect(result.status).toBe(0);
  });

  it("settings.json の PreToolUse 編集側 matcher が MCP ツールを覆っている", () => {
    const doc: unknown = JSON.parse(readFileSync(path.join(repoRoot, ".claude/settings.json"), "utf8"));
    const preToolUse =
      (doc as { hooks: { PreToolUse?: { matcher?: string }[] } }).hooks.PreToolUse ?? [];
    const editEntry = preToolUse.find((entry) => (entry.matcher ?? "").split("|").includes("Edit"));
    expect(editEntry?.matcher).toContain("mcp__serena__");
  });
});

describe("deny-test-weakening.sh — 本番鍵", () => {
  it("本番シークレットを含む Write は exit 2", () => {
    expect(write("src/lib/payments/keys.ts", `export const KEY = "${LIVE_SECRET}";`).status).toBe(2);
  });

  it("本番決済環境フラグを含む Write は exit 2", () => {
    const assignment = `${["PAYPAY", "ENV"].join("_")}=${"PROD"}`;
    expect(write(".dev.vars", assignment).status).toBe(2);
  });
});

describe("deny-test-weakening.sh — 通常の編集は通す", () => {
  it("src 配下の Write", () => {
    expect(write("src/app/page.tsx", "export default function Page() {\n  return null;\n}\n").status).toBe(0);
  });

  it("docs/PROGRESS.md への追記", () => {
    expect(edit("docs/PROGRESS.md", "# PROGRESS", "# PROGRESS\n\n- task_005: DONE").status).toBe(0);
  });

  it("対象外のツール名は素通しする", () => {
    const result = runHook({ tool_name: "Bash", tool_input: { command: "echo hi" } });
    expect(result.status).toBe(0);
  });

  it("file_path の無い入力は素通しする", () => {
    expect(runHook({ tool_name: "Write", tool_input: {} }).status).toBe(0);
  });
});
