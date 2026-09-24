// tests/unit/merge-review.test.ts
//
// check_066 / R-TH-08 / R-TH-13。`scripts/merge-review.sh` は複数ベンダーの返信封筒を
// 1 つの判定に畳む。判定規則は 3 本しかない:
//
//   1. 実効 high が 1 件でもあれば差し戻し（exit 1）
//   2. 不達（`reviewer_route: "unavailable"`）は欠票として review-log に残し、
//      他に有効票があれば通す
//   3. 有効票が 0、または無効な封筒（必須フィールド欠落・モデル不一致）があれば
//      「レビュー不成立」（exit 3）。DONE 側で握り潰せないように非 0 で返す
//
// review-log は G5（gate-check.mjs）が読む正本でもあるので、書かれた JSON が
// 「model_id_actual / cli_version / backend を持つ封筒」または
// 「reviewer_route: unavailable の欠票記録」を含むことをここで固定する。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const script = path.join(repoRoot, "scripts", "merge-review.sh");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-review-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * 合格モデル一覧（`docs/metrics/model-bench.md` 形式）をフィクスチャとして書く。
 *
 * `--whitelist` を渡さずに起動すると、内部で呼ばれる validate-findings.mjs が
 * リポジトリルートの `docs/metrics/model-bench.md`（task_010 が作る予定のファイル）を
 * 読んでしまい、そのファイルが出来た瞬間にここの期待が中身次第で崩れる。
 * **リポジトリの状態に依存させないため、どのケースでも明示する。**
 */
function writeWhitelist(models: string[] = ["gpt-6-astra", "gemini-2.5-pro"]): string {
  const file = path.join(makeTempDir(), "model-bench.md");
  fs.writeFileSync(
    file,
    [
      "# モデル実測ベンチ（フィクスチャ）",
      "",
      "<!-- machine-readable:begin -->",
      "```json",
      JSON.stringify({ approved_models: models }, null, 2),
      "```",
      "<!-- machine-readable:end -->",
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface LogEntry {
  type?: string;
  task_id?: string;
  classification?: string;
  reviewer_route?: string;
  vendor?: string;
  model_id_actual?: string;
  cli_version?: string;
  backend?: string;
  source_file?: string;
  decision?: string;
  votes?: number;
  vendors?: string[];
  author_vendor?: string;
  missing_votes?: number;
  invalid_envelopes?: number;
  invalid_reviews?: number;
  self_reviews?: number;
  task_mismatches?: number;
  effective_high?: number;
  round?: number;
  validation?: { errors?: string[]; downgrades?: unknown[] };
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: "task_900",
    reviewer: "adversarial-reviewer-gpt",
    vendor: "gpt",
    reviewer_route: "verified",
    model_id_requested: "gpt-6-astra",
    model_id_actual: "gpt-6-astra",
    cli_version: "codex-cli 0.154.0",
    backend: "codex",
    ran_at: "2026-09-24T00:00:00Z",
    commit: "0000000000000000000000000000000000000000",
    verdict: "PASS",
    findings: [],
    ...overrides,
  };
}

function unavailableEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const env = envelope({
    reviewer_route: "unavailable",
    verdict: "UNKNOWN",
    findings: [],
    unavailable_reason: "codex の UserPromptSubmit フックが非 Claude モデルを遮断しました",
    attempted_command: "codex exec --json -m gpt-6-astra",
    ...overrides,
  });
  delete env.model_id_actual;
  delete env.cli_version;
  delete env.backend;
  return env;
}

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "F-1",
    severity: "high",
    title: "claim が二重に適用され得る",
    detail: "participant_id の一意制約が無いため同じ参加者を 2 回 claim できる。",
    repro: "POST /api/claims {participantId:'p1'} を 2 回連続で送る",
    ...overrides,
  };
}

interface MergeResult {
  status: number;
  stdout: string;
  stderr: string;
  log: LogEntry[];
  logPath: string;
}

function merge(envelopes: Record<string, unknown>[], extraArgs: string[] = []): MergeResult {
  const dir = makeTempDir();
  const files = envelopes.map((env, i) => {
    const file = path.join(dir, `envelope-${i}.json`);
    fs.writeFileSync(file, JSON.stringify(env, null, 2), "utf8");
    return file;
  });
  const logPath = path.join(dir, "review-log.json");
  const args = extraArgs.includes("--whitelist")
    ? extraArgs
    : [...extraArgs, "--whitelist", writeWhitelist()];
  const res = spawnSync("bash", [script, "task_900", "--out", logPath, ...args, ...files], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  let log: LogEntry[] = [];
  if (fs.existsSync(logPath)) {
    log = JSON.parse(fs.readFileSync(logPath, "utf8")) as LogEntry[];
  }
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, log, logPath };
}

function summaryOf(log: LogEntry[]): LogEntry | undefined {
  return log.filter((e) => e.type === "summary").pop();
}

describe("merge-review.sh — 判定", () => {
  it("引数が足りなければ usage エラー（exit 64）", () => {
    const res = spawnSync("bash", [script], { encoding: "utf8", cwd: repoRoot });
    expect(res.status).toBe(64);
  });

  it("全 PASS なら exit 0 で pass", () => {
    const res = merge([envelope(), envelope({ reviewer: "adversarial-reviewer-gemini" })]);
    expect(res.status).toBe(0);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("pass");
    expect(s?.votes).toBe(2);
    expect(s?.effective_high).toBe(0);
  });

  it("high が 1 件でもあれば差し戻し（exit 1）", () => {
    const res = merge([envelope({ verdict: "FAIL", findings: [finding()] }), envelope()]);
    expect(res.status).toBe(1);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("reject");
    expect(s?.effective_high).toBe(1);
  });

  it("repro の無い high は info へ降格されるので差し戻しにならない", () => {
    const f = finding();
    delete f.repro;
    const res = merge([envelope({ verdict: "FAIL", findings: [f] })]);
    expect(res.status).toBe(0);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("pass");
    expect(s?.effective_high).toBe(0);
  });

  it("不達は欠票として記録され、他に有効票があれば通過する", () => {
    const res = merge([unavailableEnvelope(), envelope({ reviewer: "adversarial-reviewer-gemini" })]);
    expect(res.status).toBe(0);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("pass");
    expect(s?.votes).toBe(1);
    expect(s?.missing_votes).toBe(1);
    const missing = res.log.find((e) => e.classification === "missing_vote");
    expect(missing?.reviewer_route).toBe("unavailable");
  });

  it("全部が不達ならレビュー不成立（exit 3）", () => {
    const res = merge([unavailableEnvelope(), unavailableEnvelope()]);
    expect(res.status).toBe(3);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("not_established");
    expect(s?.votes).toBe(0);
    expect(s?.missing_votes).toBe(2);
  });

  it("必須フィールドを欠く封筒はレビュー不成立（exit 3）で、無効として記録される", () => {
    const broken = envelope();
    delete broken.model_id_actual;
    const res = merge([broken, envelope({ reviewer: "adversarial-reviewer-gemini" })]);
    expect(res.status).toBe(3);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("not_established");
    expect(s?.invalid_envelopes).toBe(1);
    const invalid = res.log.find((e) => e.classification === "invalid");
    expect(invalid?.validation?.errors?.join("\n")).toMatch(/model_id_actual/);
  });

  it("ホワイトリスト外のモデルは票にならずレビュー不成立（exit 3）", () => {
    // --whitelist は validate-findings.mjs へそのまま渡る。合格モデル一覧に
    // 載っていないモデルが答えたレビューは「どのモデルが答えたか信用できない」
    // ので票にならない（R-TH-11）。
    const res = merge([envelope()], ["--whitelist", writeWhitelist(["gemini-2.5-pro"])]);
    expect(res.status).toBe(3);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("not_established");
    expect(s?.votes).toBe(0);
    expect(s?.invalid_reviews).toBe(1);
  });

  it("high と無効封筒が同時にあれば差し戻し（high が優先）", () => {
    const broken = envelope();
    delete broken.cli_version;
    const res = merge([broken, envelope({ verdict: "FAIL", findings: [finding()] })]);
    expect(res.status).toBe(1);
    expect(summaryOf(res.log)?.decision).toBe("reject");
  });
});

describe("merge-review.sh — review-log", () => {
  it("封筒 1 本ごとに 1 エントリと、末尾に summary を書く", () => {
    const res = merge([envelope(), unavailableEnvelope()]);
    expect(res.log.filter((e) => e.type !== "summary")).toHaveLength(2);
    expect(res.log[res.log.length - 1]?.type).toBe("summary");
  });

  it("G5 が読む形（model_id_actual / cli_version / backend、または unavailable）で残る", () => {
    const res = merge([envelope()]);
    const usable = res.log.some(
      (e) =>
        (typeof e.model_id_actual === "string" &&
          e.model_id_actual.length > 0 &&
          typeof e.cli_version === "string" &&
          typeof e.backend === "string") ||
        e.reviewer_route === "unavailable",
    );
    expect(usable).toBe(true);
  });

  it("同じ review-log に 2 周目を追記する（上書きしない）", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "review-log.json");
    const write = (env: Record<string, unknown>, name: string): string => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(env, null, 2), "utf8");
      return file;
    };
    const first = write(envelope(), "r1.json");
    const second = write(envelope({ reviewer: "adversarial-reviewer-gemini" }), "r2.json");
    const wl = writeWhitelist();

    const a = spawnSync(
      "bash",
      [script, "task_900", "--out", logPath, "--round", "1", "--whitelist", wl, first],
      { encoding: "utf8", cwd: repoRoot },
    );
    expect(a.status).toBe(0);
    const b = spawnSync(
      "bash",
      [script, "task_900", "--out", logPath, "--round", "2", "--whitelist", wl, second],
      { encoding: "utf8", cwd: repoRoot },
    );
    expect(b.status).toBe(0);

    const log = JSON.parse(fs.readFileSync(logPath, "utf8")) as LogEntry[];
    expect(log).toHaveLength(4); // 封筒 2 本 + summary 2 本
    expect(log.filter((e) => e.type === "summary").map((e) => e.round)).toEqual([1, 2]);
  });

  it("--dry-run は review-log を書かない", () => {
    const res = merge([envelope()], ["--dry-run"]);
    expect(res.status).toBe(0);
    expect(fs.existsSync(res.logPath)).toBe(false);
  });
});

describe("merge-review.sh — ベンダー独立性（§16-1 の 2）", () => {
  /** 作者と同じベンダー（claude）の封筒。スキーマ上は完全に妥当である。 */
  function selfReviewEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return envelope({
      reviewer: "self-review-by-author",
      vendor: "claude",
      model_id_actual: "claude-opus-5",
      cli_version: "n/a",
      backend: "self",
      ...overrides,
    });
  }

  const whitelistWithClaude = (): string =>
    writeWhitelist(["gpt-6-astra", "gemini-2.5-pro", "claude-opus-5"]);

  it("作者と同じベンダーの封筒 1 通ではレビューが成立しない（exit 3）", () => {
    // これが通ると「敵対レビュー済み」を作者自身が 1 通で作れてしまう。
    const res = merge([selfReviewEnvelope()], ["--whitelist", whitelistWithClaude()]);
    expect(res.status).toBe(3);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("not_established");
    expect(s?.votes).toBe(0);
    expect(s?.self_reviews).toBe(1);
    expect(s?.vendors).toEqual([]);
    expect(res.log.find((e) => e.type !== "summary")?.classification).toBe("self_review");
  });

  it("作者ベンダー以外の有効票が 1 件あれば通る（自己レビューは票に数えない）", () => {
    const res = merge(
      [selfReviewEnvelope(), envelope({ reviewer: "adversarial-reviewer-gpt" })],
      ["--whitelist", whitelistWithClaude()],
    );
    expect(res.status).toBe(0);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("pass");
    expect(s?.votes).toBe(1);
    expect(s?.self_reviews).toBe(1);
    expect(s?.vendors).toEqual(["gpt"]);
  });

  it("自己レビューが出した実効 high は差し戻しに数える（票にしないことと無視は別）", () => {
    const res = merge(
      [selfReviewEnvelope({ verdict: "FAIL", findings: [finding()] }), envelope()],
      ["--whitelist", whitelistWithClaude()],
    );
    expect(res.status).toBe(1);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("reject");
    expect(s?.effective_high).toBe(1);
  });

  it("--author-vendor none で自己レビュー除外を外せる", () => {
    const res = merge(
      [selfReviewEnvelope()],
      ["--whitelist", whitelistWithClaude(), "--author-vendor", "none"],
    );
    expect(res.status).toBe(0);
    const s = summaryOf(res.log);
    expect(s?.votes).toBe(1);
    expect(s?.self_reviews).toBe(0);
    expect(s?.vendors).toEqual(["claude"]);
  });

  it("--author-vendor gemini なら gemini の票が自己レビューになる", () => {
    const res = merge(
      [
        envelope({ reviewer: "adversarial-reviewer-gemini", vendor: "gemini", model_id_actual: "gemini-2.5-pro" }),
        envelope(),
      ],
      ["--author-vendor", "gemini"],
    );
    expect(res.status).toBe(0);
    const s = summaryOf(res.log);
    expect(s?.votes).toBe(1);
    expect(s?.self_reviews).toBe(1);
    expect(s?.vendors).toEqual(["gpt"]);
    expect(s?.author_vendor).toBe("gemini");
  });

  it("summary は投票ベンダー集合を重複なしで持つ", () => {
    const res = merge([
      envelope(),
      envelope({ reviewer: "adversarial-reviewer-gpt-2" }),
      envelope({ reviewer: "adversarial-reviewer-gemini", vendor: "gemini", model_id_actual: "gemini-2.5-pro" }),
    ]);
    expect(res.status).toBe(0);
    const s = summaryOf(res.log);
    expect(s?.votes).toBe(3);
    expect(s?.vendors).toEqual(["gemini", "gpt"]);
    expect(s?.author_vendor).toBe("claude");
  });

  it("--author-vendor に未知の値を渡すと usage エラー（exit 64）", () => {
    const res = merge([envelope()], ["--author-vendor", "bogus"]);
    expect(res.status).toBe(64);
  });
});

describe("merge-review.sh — 封筒の宛先照合（task_id）", () => {
  // 封筒の task_id は「そのレビューが何を読んだか」である。畳み先と違う封筒は
  // 別タスクの diff に対するレビューなので、こちらの敵対レビューの票にならない。
  // これを塞がないと、他タスクで正規に取得した封筒を流用するだけで
  // decision=pass / exit 0 を作れる（偽造は一切要らない）。

  it("畳み先と違う task_id の封筒は票にならずレビュー不成立（exit 3）", () => {
    const res = merge([envelope({ task_id: "task_009" })]);
    expect(res.status).toBe(3);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("not_established");
    expect(s?.votes).toBe(0);
    expect(s?.task_mismatches).toBe(1);
    expect(s?.vendors).toEqual([]);
    const entry = res.log.find((e) => e.type !== "summary");
    expect(entry?.classification).toBe("task_mismatch");
    // エントリ側は封筒の申告どおり残す（証拠を書き換えない）。
    expect(entry?.task_id).toBe("task_009");
  });

  it("有効票が別にあっても宛先違いが 1 通あればレビュー不成立（exit 3）", () => {
    const res = merge([envelope({ task_id: "task_009" }), envelope()]);
    expect(res.status).toBe(3);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("not_established");
    expect(s?.votes).toBe(1);
    expect(s?.task_mismatches).toBe(1);
  });

  it("宛先違いの封筒の実効 high は差し戻しに数えない（別の diff への指摘）", () => {
    const res = merge([envelope({ task_id: "task_009", verdict: "FAIL", findings: [finding()] })]);
    expect(res.status).toBe(3);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("not_established");
    expect(s?.effective_high).toBe(0);
  });

  it("宛先違いの不達封筒は欠票にも数えない", () => {
    const res = merge([unavailableEnvelope({ task_id: "task_009" })]);
    expect(res.status).toBe(3);
    const s = summaryOf(res.log);
    expect(s?.missing_votes).toBe(0);
    expect(s?.task_mismatches).toBe(1);
  });

  it("task_id が一致する封筒はこれまでどおり票になる（負の対照）", () => {
    const res = merge([envelope({ task_id: "task_900" })]);
    expect(res.status).toBe(0);
    const s = summaryOf(res.log);
    expect(s?.decision).toBe("pass");
    expect(s?.votes).toBe(1);
    expect(s?.task_mismatches).toBe(0);
  });
});
