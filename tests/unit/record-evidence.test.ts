// tests/unit/record-evidence.test.ts
//
// scripts/record-evidence.mjs（acceptance-checks.json の evidence を書く唯一の経路）の機械検証。
// G9（evidence.commit === HEAD）と「捏造した command を残さない」を固定する。
// 実 docs/acceptance-checks.json は触らず、一時ディレクトリのフィクスチャに対して走らせる。

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { maskSecrets, scriptNameOf } from "../../scripts/record-evidence.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const script = path.join(repoRoot, "scripts", "record-evidence.mjs");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "record-evidence-"));
  const checks = path.join(dir, "acceptance-checks.json");
  const pkg = path.join(dir, "package.json");
  writeFileSync(
    checks,
    JSON.stringify(
      {
        feature: "fixture",
        checks: [
          { id: "check_ok", manual_or_automated: "automated", verification_method: "npm run fx:ok（説明つき）", evidence: null },
          { id: "check_fail", manual_or_automated: "automated", verification_method: "npm run fx:fail", evidence: null },
          { id: "check_missing", manual_or_automated: "automated", verification_method: "npm run fx:absent", evidence: null },
          { id: "check_manual", manual_or_automated: "manual", verification_method: "画面で目視", evidence: null },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(pkg, JSON.stringify({ name: "fx", scripts: { "fx:ok": "node -e \"process.exit(0)\"", "fx:fail": "node -e \"process.exit(3)\"" } }));
  return { dir, checks, pkg };
}

function run(args: string[], fx: { checks: string; pkg: string }) {
  const r = spawnSync("node", [script, "--file", fx.checks, "--package-json", fx.pkg, ...args], { cwd: repoRoot, encoding: "utf8" });
  const doc = JSON.parse(readFileSync(fx.checks, "utf8"));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, doc };
}

describe("record-evidence.mjs — evidence は実行結果から機械的に書かれる", () => {
  it("verification_method から npm script 名だけを読む（説明文・全角括弧は無視）", () => {
    expect(scriptNameOf("npm run test:e2e（tests/e2e/organizer-flow.spec.ts）")).toBe("test:e2e");
    expect(scriptNameOf("npm run gate:constraints")).toBe("gate:constraints");
    expect(scriptNameOf("画面で目視")).toBeNull();
    expect(scriptNameOf(undefined)).toBeNull();
  });

  it("exit 0 の check は commit=HEAD・exit_code=0 で記録される", () => {
    const fx = fixture();
    const r = run(["--check", "check_ok"], fx);
    expect(r.status).toBe(0);
    const ev = r.doc.checks[0].evidence;
    expect(ev.commit).toBe(head);
    expect(ev.kind).toBe("automated");
    expect(ev.command).toBe("npm run fx:ok");
    expect(ev.exit_code).toBe(0);
    expect(ev.by).toBe("scripts/record-evidence.mjs");
    expect(typeof ev.dirty_files).toBe("number");
    expect(ev.output_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("失敗した check も exit_code 付きで記録し、終了コード 1 で知らせる（失敗を隠さない）", () => {
    const fx = fixture();
    const r = run(["--check", "check_fail"], fx);
    expect(r.status).toBe(1);
    expect(r.doc.checks[1].evidence.exit_code).toBe(3);
    expect(r.doc.checks[1].evidence.commit).toBe(head);
  });

  it("package.json に無い script は記録せず違反（exit 2）にする（捏造した command を残さない）", () => {
    const fx = fixture();
    const r = run(["--check", "check_missing"], fx);
    expect(r.status).toBe(2);
    expect(r.doc.checks[2].evidence).toBeNull();
    expect(r.stderr).toContain("fx:absent");
  });

  it("manual の check は --manual --by --note が揃ったときだけ記録し、automated には使えない", () => {
    const fx = fixture();
    const bad = run(["--check", "check_manual"], fx);
    expect(bad.status).toBe(2);
    expect(bad.doc.checks[3].evidence).toBeNull();
    const missingBy = run(["--check", "check_manual", "--manual", "--note", "見た"], fx);
    expect(missingBy.status).toBe(3);
    const ok = run(["--check", "check_manual", "--manual", "--by", "noritaka", "--note", "画面で確認した"], fx);
    expect(ok.status).toBe(0);
    expect(ok.doc.checks[3].evidence).toMatchObject({ kind: "manual", by: "noritaka", commit: head });
    const wrong = run(["--check", "check_ok", "--manual", "--by", "noritaka", "--note", "x"], fx);
    expect(wrong.status).toBe(2);
  });

  it("同じ script を参照する複数の check は 1 回の実行結果を共有し、shared_with に元の check を残す", () => {
    const fx = fixture();
    const counter = path.join(fx.dir, "count.txt");
    const pkg = JSON.parse(readFileSync(fx.pkg, "utf8"));
    pkg.scripts["fx:count"] = `node -e "require('fs').appendFileSync(${JSON.stringify(counter)}, 'x')"`;
    writeFileSync(fx.pkg, JSON.stringify(pkg));
    const doc = JSON.parse(readFileSync(fx.checks, "utf8"));
    doc.checks.push(
      { id: "check_c1", manual_or_automated: "automated", verification_method: "npm run fx:count", evidence: null },
      { id: "check_c2", manual_or_automated: "automated", verification_method: "npm run fx:count（別の観点）", evidence: null },
    );
    writeFileSync(fx.checks, JSON.stringify(doc));
    const r = run(["--check", "check_c1", "--check", "check_c2"], fx);
    expect(r.status).toBe(0);
    expect(readFileSync(counter, "utf8")).toBe("x");
    const [c1, c2] = r.doc.checks.filter((c: { id: string }) => c.id === "check_c1" || c.id === "check_c2");
    expect(c1.evidence.commit).toBe(head);
    expect(c1.evidence.shared_with).toBeUndefined();
    expect(c2.evidence.shared_with).toBe("check_c1");
    expect(c2.evidence.output_sha256).toBe(c1.evidence.output_sha256);
  });

  it("--dry-run は何も書かない", () => {
    const fx = fixture();
    const r = run(["--check", "check_ok", "--dry-run"], fx);
    expect(r.status).toBe(0);
    expect(r.doc.checks[0].evidence).toBeNull();
  });

  it("出力の秘密値らしきトークンはマスクされる", () => {
    const live = ["sk", "live", "abcdef123456"].join("_");
    expect(maskSecrets(`key=${live} Authorization: Bearer abcdefghijklmnop PAYPAY_API_KEY=xyz postgres://app:pw@h/db`)).not.toContain(live);
    expect(maskSecrets(`PAYPAY_API_KEY=xyz`)).toBe("PAYPAY_API_KEY=***");
    expect(maskSecrets(`postgres://app:pw@h/db`)).toBe("postgres://app:***@h/db");
  });
});
