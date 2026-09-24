// tests/unit/ci/release-gate-shell.test.ts
//
// `.github/workflows/release.yml` の `release-gate` ジョブ **本体（シェル）** の機械検証。
//
// `scripts/ci/assert-release-gate.mjs`（check_051）は「先頭の run ステップが
// release-mode.json を読み、PAYMENTS_ENABLED / `npm ls` / `.cleared == true` に
// 言及し、後続ジョブが needs で release-gate に到達し、状態関数や continue-on-error で
// 無効化されていない」という**静的な形**しか見ていない。分岐が実際にどう判定するかは
// 1 つも固定されていなかった。実機で取れていたのは release-mode.json 不在の 1 経路だけで
// （run 35986191784: release-gate = failure / deploy = skipped）、
// (a) 段・(b) 段の判定は無検証のまま required ゲートになっていた。
//
// docs/gates/** は PO 専管で AI は書き込めない（scripts/deny-test-weakening.sh）。
// そこで acceptance ジョブ側と同じ手法を使う: 実ファイルを YAML パースして
// `run:` 本文をそのまま取り出し、`docs/gates/` を fixture のディレクトリ名に置換して
// 一時ディレクトリで `bash` に食わせる。判定器のコピーではなく **CI が実際に走らせる
// 文字列** を走らせるので、YAML を書き換えれば必ずこのテストが動く。
//
// `npm ci` と `npm ls` の 2 行はネットワークと実 node_modules が要るので、
// fixture のファイルを読む形に置換する。置換が空振り（＝本文が変わって対象行が
// 消えた）ならテストは即座に失敗する。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowPath = path.join(repoRoot, ".github", "workflows", "release.yml");

/** fixture 側のゲート定義ディレクトリ名。docs/gates/ には一切書き込まない。 */
const GATES_DIR = "gates-fixture";

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

/**
 * release-gate の最初の run ステップ（2 段ゲート本体）を取り出し、
 * 一時ディレクトリで実行できる形に置換する。
 */
function extractGateBody(): string {
  const doc = YAML.parse(fs.readFileSync(workflowPath, "utf8")) as WorkflowDoc;
  const steps = doc.jobs?.["release-gate"]?.steps;
  if (!Array.isArray(steps)) {
    throw new Error("release.yml に jobs['release-gate'].steps がありません");
  }
  const first = steps.find((step) => typeof step.run === "string" && step.run.trim().length > 0);
  const body = first?.run;
  if (typeof body !== "string") {
    throw new Error("release-gate に run: 本文のステップがありません");
  }

  // 置換は「必ず当たること」を要求する。当たらなければ本文が変わっている。
  const substitutions: Array<[string, string]> = [
    ["docs/gates/", `${GATES_DIR}/`],
    // ネットワークが要る行。fixture では no-op にする。
    ["npm ci\n", "true\n"],
    // 実 node_modules が要る行。fixture の npm-ls.txt を依存ツリーとして読ませる。
    ["npm ls --all --parseable 2>/dev/null || true", "cat ./npm-ls.txt 2>/dev/null || true"],
  ];
  let out = body;
  for (const [from, to] of substitutions) {
    if (!out.includes(from)) {
      throw new Error(`release.yml の release-gate 本文に ${JSON.stringify(from)} がありません（テストの置換が空振り）`);
    }
    out = out.split(from).join(to);
  }
  return out;
}

let gateBody = "";

beforeAll(() => {
  gateBody = extractGateBody();
});

interface Fixture {
  /** gates-fixture/release-mode.json の中身。null なら作らない（不在の検証）。 */
  mode?: unknown | null;
  /** gates-fixture/legal-clearance.json の中身。null なら作らない。 */
  clearance?: unknown | null;
  /** 走査対象のビルド設定ファイル。キーは相対パス。 */
  files?: Record<string, string>;
  /** `npm ls --all --parseable` の代わりに読ませる依存ツリー。 */
  npmLs?: string;
}

interface RunResult {
  status: number;
  output: string;
}

function runGate(fixture: Fixture): RunResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-gate-shell-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, GATES_DIR), { recursive: true });

  if (fixture.mode !== null && fixture.mode !== undefined) {
    fs.writeFileSync(path.join(dir, GATES_DIR, "release-mode.json"), JSON.stringify(fixture.mode), "utf8");
  }
  if (fixture.clearance !== null && fixture.clearance !== undefined) {
    fs.writeFileSync(path.join(dir, GATES_DIR, "legal-clearance.json"), JSON.stringify(fixture.clearance), "utf8");
  }
  for (const [rel, text] of Object.entries(fixture.files ?? {})) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, "utf8");
  }
  fs.writeFileSync(path.join(dir, "npm-ls.txt"), fixture.npmLs ?? "", "utf8");

  const scriptPath = path.join(dir, "gate.sh");
  fs.writeFileSync(scriptPath, gateBody, "utf8");

  const proc = spawnSync("bash", [scriptPath], { cwd: dir, encoding: "utf8", input: "" });
  return { status: proc.status ?? -1, output: `${proc.stdout ?? ""}\n${proc.stderr ?? ""}` };
}

/** 決済なし・正常系の土台。個々のテストが必要な部分だけ差し替える。 */
const MODE_NO_PAYMENTS = {
  schema_version: 1,
  payments_enabled: false,
  provider_keys: ["manual_confirm"],
  basis: null,
  approved_by: null,
};

/** フラグの正本。DB の feature_flag を seed する migration の形。 */
const SQL_FLAG_FALSE =
  "INSERT INTO feature_flag (key, value, updated_by)\n" +
  "VALUES ('PAYMENTS_ENABLED', 'false', 'po:noritaka')\n" +
  "ON CONFLICT (key) DO NOTHING;\n";

const CLEAN_FILES: Record<string, string> = {
  "wrangler.toml": 'name = "cashapp"\n',
  "supabase/migrations/0002_seed_gates.sql": SQL_FLAG_FALSE,
};

const CLEAN_TREE = "/tmp/x/node_modules/react\n/tmp/x/node_modules/next\n/tmp/x/node_modules/zod\n";

describe("release.yml release-gate: fail-closed", () => {
  it("release-mode.json が無ければ先頭で落ちる（不在を通さない）", () => {
    const res = runGate({ mode: null, files: CLEAN_FILES, npmLs: CLEAN_TREE });
    expect(res.status).toBe(1);
    expect(res.output).toContain("release-mode.json がありません");
  });

  it("payments_enabled が true / false のどちらでもなければ落ちる", () => {
    const res = runGate({
      mode: { schema_version: 1, payments_enabled: "maybe", provider_keys: ["manual_confirm"] },
      files: CLEAN_FILES,
      npmLs: CLEAN_TREE,
    });
    expect(res.status).toBe(1);
    expect(res.output).toContain("payments_enabled が true / false ではありません");
  });

  it("payments_enabled キーそのものが無ければ落ちる", () => {
    const res = runGate({ mode: { schema_version: 1 }, files: CLEAN_FILES, npmLs: CLEAN_TREE });
    expect(res.status).toBe(1);
    expect(res.output).toContain("payments_enabled が true / false ではありません");
  });
});

describe("release.yml release-gate: (a) 段（payments_enabled=false）", () => {
  it("正常系: provider_keys=[manual_confirm]・フラグ false 明示・決済 SDK なしで通る", () => {
    const res = runGate({ mode: MODE_NO_PAYMENTS, files: CLEAN_FILES, npmLs: CLEAN_TREE });
    expect(res.status).toBe(0);
    expect(res.output).toContain("(a) 段を通過しました");
  });

  it("provider_keys に自動アダプタの鍵が並んでいれば落ちる", () => {
    const res = runGate({
      mode: { ...MODE_NO_PAYMENTS, provider_keys: ["manual_confirm", "payjp"] },
      files: CLEAN_FILES,
      npmLs: CLEAN_TREE,
    });
    expect(res.status).toBe(1);
    expect(res.output).toContain("provider_keys が manual_confirm だけではありません");
  });

  it("provider_keys が空でも落ちる（manual_confirm だけ、が条件）", () => {
    const res = runGate({
      mode: { ...MODE_NO_PAYMENTS, provider_keys: [] },
      files: CLEAN_FILES,
      npmLs: CLEAN_TREE,
    });
    expect(res.status).toBe(1);
    expect(res.output).toContain("provider_keys が manual_confirm だけではありません");
  });

  // -------------------------------------------------------------------
  // この周で塞いだ穴。「true が無い＝false 扱い」をやめ、false の明示を要求する。
  // 旧実装は走査対象のどこにも PAYMENTS_ENABLED が無い状態（＝実リポの状態）で
  // 何にも当たらないまま EXIT=0 を返していた。
  // -------------------------------------------------------------------
  it("走査対象のどこにも PAYMENTS_ENABLED が無ければ落ちる（不在を false と見なさない）", () => {
    const res = runGate({
      mode: MODE_NO_PAYMENTS,
      files: { "wrangler.toml": 'name = "cashapp"\n' },
      npmLs: CLEAN_TREE,
    });
    expect(res.status).toBe(1);
    expect(res.output).toContain("PAYMENTS_ENABLED=false の明示がありません");
  });

  it.each([
    ['PAYMENTS_ENABLED = "false"\n', "wrangler.toml", "toml の KEY = \"value\""],
    ["PAYMENTS_ENABLED=false\n", ".env.example", "env の KEY=value"],
    ['  PAYMENTS_ENABLED: "false",\n', "next.config.ts", "ts の KEY: value"],
  ])("%s（%s）を false の明示として読める", (text, file) => {
    const res = runGate({
      mode: MODE_NO_PAYMENTS,
      files: { [file]: text },
      npmLs: CLEAN_TREE,
    });
    expect(res.status).toBe(0);
    expect(res.output).toContain("(a) 段を通過しました");
  });

  it("正本（supabase/migrations の feature_flag seed）だけでも false の明示として読める", () => {
    const res = runGate({
      mode: MODE_NO_PAYMENTS,
      files: { "supabase/migrations/0002_seed_gates.sql": SQL_FLAG_FALSE },
      npmLs: CLEAN_TREE,
    });
    expect(res.status).toBe(0);
    expect(res.output).toContain("supabase/migrations/0002_seed_gates.sql");
  });

  it.each([
    ['PAYMENTS_ENABLED = "true"\n', "wrangler.toml"],
    ["PAYMENTS_ENABLED=true\n", ".env.example"],
    ["VALUES ('PAYMENTS_ENABLED', 'true', 'po:noritaka')\n", "supabase/migrations/0099_enable.sql"],
  ])("ビルド設定・migration が true にしていれば落ちる（%s）", (text, file) => {
    const res = runGate({
      mode: MODE_NO_PAYMENTS,
      files: { ...CLEAN_FILES, [file]: text },
      npmLs: CLEAN_TREE,
    });
    expect(res.status).toBe(1);
    expect(res.output).toContain("PAYMENTS_ENABLED を true にしています");
  });

  it("走査対象のビルド設定が 1 つも無ければ落ちる（走査 0 件を緑にしない）", () => {
    const res = runGate({ mode: MODE_NO_PAYMENTS, files: {}, npmLs: CLEAN_TREE });
    expect(res.status).toBe(1);
    expect(res.output).toContain("走査対象のビルド設定が 1 つもありません");
  });

  it.each(["stripe", "payjp", "square", "komoju"])("依存ツリーに決済 SDK %s があれば落ちる", (sdk) => {
    const res = runGate({
      mode: MODE_NO_PAYMENTS,
      files: CLEAN_FILES,
      npmLs: `${CLEAN_TREE}/tmp/x/node_modules/${sdk}\n`,
    });
    expect(res.status).toBe(1);
    expect(res.output).toContain(`決済 SDK が依存ツリーにあります: ${sdk}`);
  });

  it("npm ls の出力が空なら落ちる（走査 0 件を緑にしない）", () => {
    const res = runGate({ mode: MODE_NO_PAYMENTS, files: CLEAN_FILES, npmLs: "" });
    expect(res.status).toBe(1);
    expect(res.output).toContain("npm ls の出力が空です");
  });

  it("名前の一部が一致するだけのパッケージは決済 SDK と見なさない（偽陽性の対照）", () => {
    const res = runGate({
      mode: MODE_NO_PAYMENTS,
      files: CLEAN_FILES,
      npmLs: `${CLEAN_TREE}/tmp/x/node_modules/stripe-like-utils\n/tmp/x/node_modules/@types/square-root\n`,
    });
    expect(res.status).toBe(0);
    expect(res.output).toContain("(a) 段を通過しました");
  });
});

describe("release.yml release-gate: (b) 段（payments_enabled=true・L11）", () => {
  const MODE_PAYMENTS = { schema_version: 1, payments_enabled: true, provider_keys: ["payjp"] };
  const CLEARED = {
    cleared: true,
    basis: "弁護士確認 2026-10-01",
    approved_by: "po:noritaka",
    approved_at: "2026-10-01",
  };

  it("legal-clearance.json が無ければ落ちる", () => {
    const res = runGate({ mode: MODE_PAYMENTS, clearance: null });
    expect(res.status).toBe(1);
    expect(res.output).toContain("legal-clearance.json がありません");
  });

  it("cleared=false なら落ちる", () => {
    const res = runGate({ mode: MODE_PAYMENTS, clearance: { ...CLEARED, cleared: false } });
    expect(res.status).toBe(1);
    expect(res.output).toContain("cleared が true ではありません");
  });

  it.each(["basis", "approved_by", "approved_at"])(
    "cleared=true でも %s が空なら落ちる",
    (field) => {
      const res = runGate({
        mode: MODE_PAYMENTS,
        clearance: { ...CLEARED, [field]: "" },
      });
      expect(res.status).toBe(1);
      expect(res.output).toContain(`の ${field} が空です`);
    },
  );

  it.each(["basis", "approved_by", "approved_at"])(
    "cleared=true でも %s が null なら落ちる",
    (field) => {
      const res = runGate({
        mode: MODE_PAYMENTS,
        clearance: { ...CLEARED, [field]: null },
      });
      expect(res.status).toBe(1);
      expect(res.output).toContain(`の ${field} が空です`);
    },
  );

  it("cleared=true で根拠と承認者が揃っていれば通る", () => {
    const res = runGate({ mode: MODE_PAYMENTS, clearance: CLEARED });
    expect(res.status).toBe(0);
    expect(res.output).toContain("(b) 段を通過しました");
  });

  it("(b) 段は (a) 段の決済 SDK 不在検査を通らない（決済ありなので SDK があってよい）", () => {
    const res = runGate({
      mode: MODE_PAYMENTS,
      clearance: CLEARED,
      npmLs: "/tmp/x/node_modules/payjp\n",
    });
    expect(res.status).toBe(0);
    expect(res.output).not.toContain("決済 SDK が依存ツリーにあります");
  });
});
