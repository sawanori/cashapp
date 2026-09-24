// tests/unit/validate-findings.test.ts
//
// check_066 / R-TH-08 / R-TH-11。`scripts/validate-findings.mjs` は敵対レビューの
// 返信封筒（FINDINGS）に対する機械強制である。規律ではなく機械で守るのは 3 点:
//
//   1. repro の無い high は high として通らない（R-TH-08。誤検出の high で
//      task-loop が 3 周する事故を止める）
//   2. `model_id_actual` / `cli_version` / `backend` を欠く返信は無効
//      （R-TH-11。どのモデルが答えたか分からないレビューは票にしない）
//   3. 不達（`reviewer_route: "unavailable"`）は欠票として通すが、
//      不達が PASS を名乗ることは許さない（成功の偽装を作らない）
//
// スクリプトは子プロセスとして起動して実際の CLI 契約を検査する
// （tests/unit/wording-lint.test.ts と同じ流儀。実行時の終了コードが契約の一部）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const script = path.join(repoRoot, "scripts", "validate-findings.mjs");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-findings-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Downgrade {
  finding_id: string;
  from: string;
  to: string;
  reason: string;
}

interface Report {
  valid: boolean;
  errors: string[];
  warnings: string[];
  counts_as_vote: boolean;
  reviewer_route: string;
  counts: {
    high: number;
    medium: number;
    low: number;
    info: number;
    unknown: number;
    total: number;
    downgraded: number;
  };
  downgrades: Downgrade[];
  envelope: Record<string, unknown> | null;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  report: Report | null;
}

/**
 * ホワイトリストを渡さずに起動すると、検証側は既定で
 * `<repoRoot>/docs/metrics/model-bench.md`（task_010 が作る予定のファイル）を読む。
 * それだと「そのファイルが出来た瞬間に、中身次第でここの期待が崩れる」テストになるので、
 * **どのケースでもホワイトリストを明示する**。フィクスチャで使うモデル ID
 * （gpt-6-astra / gemini-2.5-pro）は既定のホワイトリストに載せてある。
 */
function run(envelope: unknown, extraArgs: string[] = []): RunResult {
  const dir = makeTempDir();
  const file = path.join(dir, "envelope.json");
  fs.writeFileSync(
    file,
    typeof envelope === "string" ? envelope : JSON.stringify(envelope, null, 2),
    "utf8",
  );
  const args = extraArgs.includes("--whitelist")
    ? extraArgs
    : [...extraArgs, "--whitelist", writeWhitelist(["gpt-6-astra", "gemini-2.5-pro"])];
  const res = spawnSync("node", [script, file, "--json", ...args], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  let report: Report | null = null;
  try {
    report = JSON.parse(res.stdout) as Report;
  } catch {
    report = null;
  }
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, report };
}

function baseEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "F-1",
    severity: "medium",
    title: "claim が二重に適用され得る",
    detail: "participant_id の一意制約が無いため同じ参加者を 2 回 claim できる。",
    repro: "POST /api/claims {participantId:'p1'} を 2 回連続で送る",
    ...overrides,
  };
}

/** 成果物のあるディレクトリにホワイトリストを置く（docs/metrics/model-bench.md 相当）。 */
function writeWhitelist(models: string[]): string {
  const dir = makeTempDir();
  const file = path.join(dir, "model-bench.md");
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

describe("validate-findings.mjs — 封筒スキーマ", () => {
  it("必須フィールドの揃った封筒は valid で exit 0", () => {
    const res = run(baseEnvelope({ findings: [finding()] }));
    expect(res.status).toBe(0);
    expect(res.report?.valid).toBe(true);
    expect(res.report?.counts_as_vote).toBe(true);
    expect(res.report?.counts.medium).toBe(1);
    expect(res.report?.errors).toEqual([]);
  });

  it("引数が無ければ usage エラー（exit 2）", () => {
    const res = spawnSync("node", [script], { encoding: "utf8", cwd: repoRoot });
    expect(res.status).toBe(2);
  });

  it("JSON として壊れた封筒は invalid（exit 1）", () => {
    const res = run("{ this is not json");
    expect(res.status).toBe(1);
    expect(res.report?.valid).toBe(false);
    expect(res.report?.errors.join("\n")).toMatch(/JSON/);
  });

  it("未知の severity は invalid（exit 1）", () => {
    const res = run(baseEnvelope({ findings: [finding({ severity: "critical" })] }));
    expect(res.status).toBe(1);
    expect(res.report?.valid).toBe(false);
    expect(res.report?.errors.join("\n")).toMatch(/severity/);
  });

  it("finding の detail 欠落は invalid（exit 1）", () => {
    const f = finding();
    delete f.detail;
    const res = run(baseEnvelope({ findings: [f] }));
    expect(res.status).toBe(1);
    expect(res.report?.errors.join("\n")).toMatch(/detail/);
  });
});

describe("validate-findings.mjs — R-TH-11 モデル同一性", () => {
  it("model_id_actual の欠落は invalid（exit 1）", () => {
    const env = baseEnvelope();
    delete env.model_id_actual;
    const res = run(env);
    expect(res.status).toBe(1);
    expect(res.report?.valid).toBe(false);
    expect(res.report?.errors.join("\n")).toMatch(/model_id_actual/);
  });

  it("cli_version の欠落は invalid（exit 1）", () => {
    const env = baseEnvelope();
    delete env.cli_version;
    const res = run(env);
    expect(res.status).toBe(1);
    expect(res.report?.errors.join("\n")).toMatch(/cli_version/);
  });

  it("backend の欠落は invalid（exit 1）", () => {
    const env = baseEnvelope();
    delete env.backend;
    const res = run(env);
    expect(res.status).toBe(1);
    expect(res.report?.errors.join("\n")).toMatch(/backend/);
  });

  it("ホワイトリスト外のモデルは model_mismatch へ落ち、票にならない", () => {
    const wl = writeWhitelist(["gpt-6-astra"]);
    const res = run(baseEnvelope({ model_id_actual: "gpt-5-mini", findings: [finding()] }), [
      "--whitelist",
      wl,
    ]);
    expect(res.status).toBe(0);
    expect(res.report?.valid).toBe(true);
    expect(res.report?.reviewer_route).toBe("model_mismatch");
    expect(res.report?.counts_as_vote).toBe(false);
    expect(res.report?.warnings.join("\n")).toMatch(/model_mismatch/);
  });

  it("ホワイトリストに載っているモデルは verified のまま票になる", () => {
    const wl = writeWhitelist(["gpt-6-astra"]);
    const res = run(baseEnvelope({ findings: [finding()] }), ["--whitelist", wl]);
    expect(res.status).toBe(0);
    expect(res.report?.reviewer_route).toBe("verified");
    expect(res.report?.counts_as_vote).toBe(true);
  });

  it("ホワイトリスト未設定は警告のみで落とさない（task_010 で作られる）", () => {
    const missing = path.join(makeTempDir(), "does-not-exist.md");
    const res = run(baseEnvelope({ findings: [finding()] }), ["--whitelist", missing]);
    expect(res.status).toBe(0);
    expect(res.report?.warnings.join("\n")).toMatch(/model_whitelist_unconfigured/);
    expect(res.report?.counts_as_vote).toBe(true);
  });
});

describe("validate-findings.mjs — R-TH-08 repro 必須", () => {
  it("repro の無い high は info へ降格する", () => {
    const f = finding({ id: "F-9", severity: "high" });
    delete f.repro;
    const res = run(baseEnvelope({ verdict: "FAIL", findings: [f] }));
    expect(res.status).toBe(0);
    expect(res.report?.valid).toBe(true);
    expect(res.report?.counts.high).toBe(0);
    expect(res.report?.counts.info).toBe(1);
    expect(res.report?.downgrades).toEqual([
      { finding_id: "F-9", from: "high", to: "info", reason: "repro_missing" },
    ]);
  });

  it("repro が空文字の high も info へ降格する", () => {
    const res = run(
      baseEnvelope({ verdict: "FAIL", findings: [finding({ severity: "high", repro: "   " })] }),
    );
    expect(res.status).toBe(0);
    expect(res.report?.counts.high).toBe(0);
    expect(res.report?.counts.info).toBe(1);
  });

  it("repro のある high は high のまま残る", () => {
    const res = run(
      baseEnvelope({ verdict: "FAIL", findings: [finding({ severity: "high" })] }),
    );
    expect(res.status).toBe(0);
    expect(res.report?.counts.high).toBe(1);
    expect(res.report?.downgrades).toEqual([]);
  });

  it("medium は repro が無くても降格しない（必須なのは high のみ）", () => {
    const f = finding({ severity: "medium" });
    delete f.repro;
    const res = run(baseEnvelope({ findings: [f] }));
    expect(res.status).toBe(0);
    expect(res.report?.counts.medium).toBe(1);
    expect(res.report?.downgrades).toEqual([]);
  });
});

describe("validate-findings.mjs — Gemini は引用なしを UNKNOWN にする", () => {
  it("citation の無い gemini の high は unknown になる", () => {
    const res = run(
      baseEnvelope({
        reviewer: "adversarial-reviewer-gemini",
        vendor: "gemini",
        model_id_actual: "gemini-2.5-pro",
        cli_version: "0.38.1",
        backend: "antigravity",
        verdict: "FAIL",
        findings: [finding({ severity: "high" })],
      }),
    );
    expect(res.status).toBe(0);
    expect(res.report?.counts.high).toBe(0);
    expect(res.report?.counts.unknown).toBe(1);
    expect(res.report?.downgrades[0]?.reason).toBe("citation_missing");
  });

  it("citation のある gemini の high は high のまま残る", () => {
    const res = run(
      baseEnvelope({
        reviewer: "adversarial-reviewer-gemini",
        vendor: "gemini",
        model_id_actual: "gemini-2.5-pro",
        cli_version: "0.38.1",
        backend: "antigravity",
        verdict: "FAIL",
        findings: [
          finding({
            severity: "high",
            citation: "「加盟店は…」https://example.invalid/terms 取得日 2026-09-24",
          }),
        ],
      }),
    );
    expect(res.status).toBe(0);
    expect(res.report?.counts.high).toBe(1);
  });

  it("gpt は citation が無くても降格しない（引用義務は Gemini 側の役割）", () => {
    const res = run(baseEnvelope({ verdict: "FAIL", findings: [finding({ severity: "high" })] }));
    expect(res.report?.counts.high).toBe(1);
  });
});

describe("validate-findings.mjs — 不達（欠票）", () => {
  function unavailable(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const env = baseEnvelope({
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

  it("不達の封筒は valid だが票にはならない", () => {
    const res = run(unavailable());
    expect(res.status).toBe(0);
    expect(res.report?.valid).toBe(true);
    expect(res.report?.reviewer_route).toBe("unavailable");
    expect(res.report?.counts_as_vote).toBe(false);
  });

  it("不達の理由が無ければ invalid", () => {
    const env = unavailable();
    delete env.unavailable_reason;
    const res = run(env);
    expect(res.status).toBe(1);
    expect(res.report?.errors.join("\n")).toMatch(/unavailable_reason/);
  });

  it("試行コマンドが無ければ invalid", () => {
    const env = unavailable();
    delete env.attempted_command;
    const res = run(env);
    expect(res.status).toBe(1);
    expect(res.report?.errors.join("\n")).toMatch(/attempted_command/);
  });

  it("不達が PASS を名乗ったら invalid（成功の偽装を作らない）", () => {
    const res = run(unavailable({ verdict: "PASS" }));
    expect(res.status).toBe(1);
    expect(res.report?.errors.join("\n")).toMatch(/verdict/);
  });

  it("不達なのに finding があれば invalid", () => {
    const res = run(unavailable({ findings: [finding()] }));
    expect(res.status).toBe(1);
    expect(res.report?.errors.join("\n")).toMatch(/findings/);
  });
});
