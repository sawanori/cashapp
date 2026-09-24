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

interface Packet {
  task_id: string;
  task: { constraint_ids: string[] };
  constraints: { id: string; text: string }[];
  metrics: { constraints_included: number; payload_bytes: number };
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
