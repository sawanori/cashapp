// tests/unit/build-review-packet.test.ts
//
// R-TH-10（封筒のコスト暴走）。`scripts/build-review-packet.sh` は
// 「当該タスクの `constraint_ids` に載っている制約**だけ**」を全文同梱する。
//
// ここで固定するのは 1 点だけ: **突合が完全一致であること**。
// 実装は当初 `select([.id] | inside($ids))` を使っていたが、jq の `inside` は
// 配列要素どうしを「部分文字列として含むか」で比べる。そのため
// `constraint_ids: ["L11"]` が `L1` も引き当て、掛かっていない制約が封筒に
// 混ざっていた（`N1`/`N11`/`N12`、`W1`/`W12` も同じ組み合わせで起きる）。
// 接頭辞の衝突は実在の ID 体系（L1…L12 / N1…N11 / W1…W12）で必ず起きるので、
// 回帰しないようにここに置く。
//
// スクリプトは子プロセスとして起動し、`--root` に合成リポジトリを渡す
// （tests/unit/validate-findings.test.ts と同じ流儀。実行時の契約を検査する）。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const script = path.join(repoRoot, "scripts", "build-review-packet.sh");

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-review-packet-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface PacketFile {
  path: string;
  role: string;
  bytes: number;
  content?: string;
  content_included?: boolean;
}

interface Packet {
  task_id: string;
  task: { constraint_ids: string[] };
  constraints: { id: string; text: string }[];
  metrics: {
    constraints_included: number;
    payload_bytes: number;
    files_included?: number;
    self_declared_files?: number;
  };
  artifact?: {
    diff: string;
    files: PacketFile[];
    excluded_paths: { path: string; bytes: number; reason: string }[];
  };
  self_declared_concerns?: {
    note: string;
    content_included: boolean;
    files: PacketFile[];
  };
  reply_format?: { finding: { rules: string[]; optional: string[] } };
}

/** 接頭辞が衝突する ID を並べた合成リポジトリを作る。 */
function makeRoot(constraintIds: string[]): string {
  const root = makeTempDir();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });

  const ids = ["L1", "L11", "L12", "N1", "N11", "N12", "W1", "W12"];
  fs.writeFileSync(
    path.join(root, "docs", "constraints.json"),
    JSON.stringify(
      {
        version: 1,
        constraints: ids.map((id) => ({
          id,
          text: `${id} の本文`,
          enforcement: "grep",
          match_mode: "forbid",
          grep_patterns: [],
          globs: [],
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  fs.writeFileSync(
    path.join(root, "docs", "task-list.json"),
    JSON.stringify(
      {
        tasks: [
          {
            task_id: "task_900",
            title: "フィクスチャ",
            constraint_ids: constraintIds,
            risk_ids: [],
            acceptance_check_ids: [],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  return root;
}

function build(constraintIds: string[]): { status: number; stderr: string; packet: Packet } {
  const root = makeRoot(constraintIds);
  const out = path.join(root, "packet.json");
  const res = spawnSync("bash", [script, "task_900", "--root", root, "--out", out], {
    encoding: "utf8",
    cwd: root,
  });
  const packet = fs.existsSync(out)
    ? (JSON.parse(fs.readFileSync(out, "utf8")) as Packet)
    : ({} as Packet);
  return { status: res.status ?? -1, stderr: res.stderr ?? "", packet };
}

describe("build-review-packet.sh — constraint_ids の絞り込み（R-TH-10）", () => {
  it("constraint_ids に載っている制約だけを同梱する", () => {
    const res = build(["L11", "W12"]);
    expect(res.status).toBe(0);
    expect(res.packet.constraints.map((c) => c.id).sort()).toEqual(["L11", "W12"]);
    expect(res.packet.metrics.constraints_included).toBe(2);
  });

  it("接頭辞が一致するだけの制約は同梱しない（L11 は L1 を引き当てない）", () => {
    const res = build(["L11"]);
    expect(res.status).toBe(0);
    expect(res.packet.constraints.map((c) => c.id)).toEqual(["L11"]);
  });

  it("N1 を指定しても N11 / N12 は同梱しない（短い側から長い側へも広がらない）", () => {
    const res = build(["N1"]);
    expect(res.status).toBe(0);
    expect(res.packet.constraints.map((c) => c.id)).toEqual(["N1"]);
  });

  it("constraint_ids が空なら制約は 1 件も同梱しない", () => {
    const res = build([]);
    expect(res.status).toBe(0);
    expect(res.packet.constraints).toEqual([]);
    expect(res.packet.metrics.constraints_included).toBe(0);
  });

  it("存在しない ID は黙って無視される（封筒生成自体は成功する）", () => {
    const res = build(["L11", "DOES-NOT-EXIST"]);
    expect(res.status).toBe(0);
    expect(res.packet.constraints.map((c) => c.id)).toEqual(["L11"]);
  });

  it("同梱した制約は全文（text）を持つ", () => {
    const res = build(["W12"]);
    expect(res.status).toBe(0);
    expect(res.packet.constraints[0]?.text).toBe("W12 の本文");
  });
});

describe("build-review-packet.sh — 作者の自己申告はレビュー対象から外す", () => {
  // docs/concerns/<task_id>.md ・docs/HANDOFF.md ・docs/PROGRESS.md は作者自身が
  // 書いた既知懸念の台帳である。これを diff と同じ扱いで同梱すると、レビュアは
  // 台帳の項目をそのまま読み上げて high の finding にできてしまい、懸念を誠実に
  // 記録するほど差し戻しやすくなる（3 周ループが収束しない）。
  // R-TH-10 の面でも最も厚くなるファイル群なので、中身は同梱しない。
  // ただし**隠さない**: パスと大きさと理由を封筒に残す。

  function git(root: string, args: string[]): void {
    const res = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if ((res.status ?? -1) !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }
  }

  /** 実際の git リポジトリを作る（diff の除外まで検査したいので合成では足りない）。 */
  function makeGitRoot(): string {
    const root = fs.realpathSync(makeTempDir());
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "fixture@example.invalid"]);
    git(root, ["config", "user.name", "fixture"]);
    git(root, ["config", "commit.gpgsign", "false"]);

    fs.mkdirSync(path.join(root, "docs", "concerns"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });

    fs.writeFileSync(
      path.join(root, "docs", "task-list.json"),
      JSON.stringify(
        { tasks: [{ task_id: "task_900", title: "フィクスチャ", constraint_ids: [], risk_ids: [] }] },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(root, "src", "app.ts"), "export const a = 1;\n", "utf8");
    fs.writeFileSync(
      path.join(root, "docs", "concerns", "task_900.md"),
      "# task_900 の懸念\n\n## 1. 既知の穴（作者が自分で書いた）\nSENTINEL_CONCERN_TEXT\n",
      "utf8",
    );
    fs.writeFileSync(path.join(root, "docs", "PROGRESS.md"), "# 進捗\nSENTINEL_PROGRESS_TEXT\n", "utf8");
    fs.writeFileSync(path.join(root, "docs", "HANDOFF.md"), "# 引き継ぎ\nSENTINEL_HANDOFF_TEXT\n", "utf8");

    git(root, ["add", "docs", "src"]);
    git(root, ["commit", "-q", "-m", "fixture: initial"]);

    // この周回の変更（レビュー対象 1 本 + 自己申告 3 本）
    fs.writeFileSync(path.join(root, "src", "app.ts"), "export const a = 2;\n", "utf8");
    fs.appendFileSync(path.join(root, "docs", "concerns", "task_900.md"), "\n## 2. 追記した懸念\nSENTINEL_ADDED_CONCERN\n", "utf8");
    fs.appendFileSync(path.join(root, "docs", "PROGRESS.md"), "SENTINEL_ADDED_PROGRESS\n", "utf8");
    fs.appendFileSync(path.join(root, "docs", "HANDOFF.md"), "SENTINEL_ADDED_HANDOFF\n", "utf8");
    return root;
  }

  function buildInGitRoot(): { status: number; packet: Packet; raw: string } {
    const root = makeGitRoot();
    const out = path.join(root, "packet.json");
    const res = spawnSync("bash", [script, "task_900", "--root", root, "--out", out], {
      encoding: "utf8",
      cwd: root,
    });
    const raw = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    return {
      status: res.status ?? -1,
      packet: raw ? (JSON.parse(raw) as Packet) : ({} as Packet),
      raw,
    };
  }

  it("docs/concerns / PROGRESS / HANDOFF は artifact.files に入らない", { timeout: 30_000 }, () => {
    const res = buildInGitRoot();
    expect(res.status).toBe(0);
    const paths = (res.packet.artifact?.files ?? []).map((f) => f.path);
    expect(paths).toContain("src/app.ts");
    expect(paths).not.toContain("docs/concerns/task_900.md");
    expect(paths).not.toContain("docs/PROGRESS.md");
    expect(paths).not.toContain("docs/HANDOFF.md");
  });

  it("外したファイルは excluded_paths に理由つきで残る（隠さない）", { timeout: 30_000 }, () => {
    const res = buildInGitRoot();
    const excluded = res.packet.artifact?.excluded_paths ?? [];
    expect(excluded.map((e) => e.path).sort()).toEqual([
      "docs/HANDOFF.md",
      "docs/PROGRESS.md",
      "docs/concerns/task_900.md",
    ]);
    for (const e of excluded) {
      expect(e.reason).toBe("self_declared_concerns");
      expect(e.bytes).toBeGreaterThan(0);
    }
    expect(res.packet.metrics.self_declared_files).toBe(3);
  });

  it("自己申告の中身は封筒のどこにも載らない", { timeout: 30_000 }, () => {
    const res = buildInGitRoot();
    expect(res.packet.self_declared_concerns?.content_included).toBe(false);
    for (const f of res.packet.self_declared_concerns?.files ?? []) {
      expect(f.content).toBeUndefined();
      expect(f.content_included).toBe(false);
    }
    // 封筒の生テキストにも本文が出てこないこと（diff 経由の混入も含めて）
    expect(res.raw).not.toContain("SENTINEL_CONCERN_TEXT");
    expect(res.raw).not.toContain("SENTINEL_ADDED_CONCERN");
    expect(res.raw).not.toContain("SENTINEL_PROGRESS_TEXT");
    expect(res.raw).not.toContain("SENTINEL_ADDED_HANDOFF");
  });

  it("diff からも自己申告のハンクを外す（レビュー対象の変更は残す）", { timeout: 30_000 }, () => {
    const res = buildInGitRoot();
    const diff = res.packet.artifact?.diff ?? "";
    expect(diff).toContain("diff --git a/src/app.ts");
    expect(diff).toContain("export const a = 2;");
    expect(diff).not.toContain("diff --git a/docs/concerns/task_900.md");
    expect(diff).not.toContain("diff --git a/docs/PROGRESS.md");
    expect(diff).not.toContain("diff --git a/docs/HANDOFF.md");
  });

  it("reply_format は自己申告を指摘対象にしないよう指示する", { timeout: 30_000 }, () => {
    const res = buildInGitRoot();
    const rules = (res.packet.reply_format?.finding.rules ?? []).join("\n");
    expect(rules).toContain("self_declared_concerns");
    expect(rules).toContain("duplicate_of");
    expect(res.packet.reply_format?.finding.optional).toContain("duplicate_of");
  });
});
