// tests/unit/ci/secrets-grep.test.ts
//
// `scripts/ci/secrets-grep.sh`（CI の secrets ジョブの本体、R-SEC-04 / §16-6）の機械検証。
//
// このゲートは 2 通りに壊れる。
//   (1) 何も検出しない（空振りしても緑）… R-TH-01
//   (2) 正当なコードに当たり続ける（常に赤）… required に入れた瞬間にマージ不能になり、
//       回避として branch protection ごと解除される。R-TH-04 の実際の壊れ方。
// (2) は実際に起きた: シークレットの「名前」で `.open-next` 全体を走査していたため、
// `src/lib/config/env.ts` が正当に参照する PEPPER / SESSION_KEYS / CRON_SECRETS /
// DATABASE_URL にサーバーバンドルで自分から当たっていた [実測 2026-09-24]。
//
// そこで走査を 2 群に分けた。このテストは両方向を固定する:
//   - サーバーバンドルに名前があるのは正常（落ちてはいけない）
//   - クライアント配布物に名前があるのは違反（必ず落ちる）
//   - 値のパターンは両群で違反
//   - どちらかの群の走査対象が 0 件なら違反（空振りを緑にしない）

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = path.join(repoRoot, "scripts", "ci", "secrets-grep.sh");

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 値そのものはこのファイルにベタ書きしない（scripts/deny-test-weakening.sh の
// PROD_KEY_RE がファイルへの書き込みを止める。ゲートの意図どおり）。
const LIVE_KEY = `sk_${"live"}_AbCdEf0123456789`;
const JWT = `eyJhbGciOi${"JIUzI1NiIsInR5cCI6IkpXVCJ9"}.payload.signature`;
const PG_URL = `postgres://app_rw:${"s3cr3tpass"}@db.example.com:5432/app`;

/** 成果物ツリーを作る。キーは root からの相対パス。 */
function makeTree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-grep-"));
  tmpDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, "utf8");
  }
  return dir;
}

function run(root: string): { status: number; stdout: string; stderr: string } {
  const proc = spawnSync("bash", [script, "--root", root], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  return { status: proc.status ?? -1, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

/** どのケースにも入れる「汚れていないクライアント配布物」。 */
const CLEAN_CLIENT: Record<string, string> = {
  ".next/static/chunks/app.js": 'console.log("client");\n',
  ".open-next/assets/_next/static/chunks/app.js": 'console.log("asset");\n',
};

/** src/lib/config/env.ts がバンドルされた状態を模したサーバーバンドル。 */
const SERVER_WITH_NAMES: Record<string, string> = {
  ".open-next/server-functions/default/handler.mjs":
    "const p=process.env.PEPPER;const s=process.env.SESSION_KEYS;" +
    "const c=process.env.CRON_SECRETS;const d=process.env.DATABASE_URL;" +
    'if(!p)throw new Error("PEPPER is not set");\n',
  ".open-next/worker.js": 'export default { fetch(){ return new Response("x"); } };\n',
};

describe("secrets-grep.sh — 正常系", () => {
  it("サーバーバンドルがシークレット名を参照しているだけなら通る（偽陽性を出さない）", () => {
    const root = makeTree({ ...CLEAN_CLIENT, ...SERVER_WITH_NAMES });
    const r = run(root);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("違反 0 件");
  });

  it("走査した群とファイル数をログに出す（何を見たかが追える）", () => {
    const root = makeTree({ ...CLEAN_CLIENT, ...SERVER_WITH_NAMES });
    const r = run(root);
    expect(r.stdout).toContain("(A) クライアント配布物");
    expect(r.stdout).toContain("(B) サーバーバンドル");
  });
});

describe("secrets-grep.sh — クライアント配布物にシークレット名（必ず落ちる）", () => {
  const names = [
    "PEPPER",
    "SESSION_KEYS",
    "CRON_SECRETS",
    "APP_RW_PASSWORD",
    "DATABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CLOUDFLARE_API_TOKEN",
    "LINE_CHANNEL_SECRET",
    "LINE_LOGIN_CHANNEL_SECRET",
    "PAYJP_SECRET_KEY",
    "PAYPAY_API_SECRET",
    "STRIPE_SECRET_KEY",
  ];

  for (const name of names) {
    it(`.next/static に ${name} があると落ちる`, () => {
      const root = makeTree({
        ...CLEAN_CLIENT,
        ...SERVER_WITH_NAMES,
        ".next/static/chunks/leak.js": `const v=process.env.${name};\n`,
      });
      const r = run(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`シークレット名 ${name} がクライアント配布物にあります`);
    });
  }

  it(".open-next/assets にシークレット名があると落ちる", () => {
    const root = makeTree({
      ...CLEAN_CLIENT,
      ...SERVER_WITH_NAMES,
      ".open-next/assets/_next/static/chunks/leak.js": 'const v="DATABASE_URL";\n',
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("シークレット名 DATABASE_URL がクライアント配布物にあります");
  });

  it("違反ファイルの名前は出すが、行の中身（値）は出さない", () => {
    const root = makeTree({
      ...CLEAN_CLIENT,
      ...SERVER_WITH_NAMES,
      ".next/static/chunks/leak.js": 'const v="PEPPER=1:supersecretvalue";\n',
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("leak.js");
    expect(r.stderr).not.toContain("supersecretvalue");
  });
});

describe("secrets-grep.sh — 値のパターン（両群で落ちる）", () => {
  it("サーバーバンドルに本番鍵の値があると落ちる", () => {
    const root = makeTree({
      ...CLEAN_CLIENT,
      ...SERVER_WITH_NAMES,
      ".open-next/server-functions/default/leak.mjs": `const k="${LIVE_KEY}";\n`,
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("サーバーバンドルにあります");
  });

  it("サーバーバンドルに資格情報つき Postgres URL があると落ちる", () => {
    const root = makeTree({
      ...CLEAN_CLIENT,
      ...SERVER_WITH_NAMES,
      ".open-next/server-functions/default/leak.mjs": `const u="${PG_URL}";\n`,
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("サーバーバンドルにあります");
  });

  it("クライアント配布物に JWT があると落ちる", () => {
    const root = makeTree({
      ...CLEAN_CLIENT,
      ...SERVER_WITH_NAMES,
      ".next/static/chunks/leak.js": `const t="${JWT}";\n`,
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("クライアント配布物にあります");
  });
});

describe("secrets-grep.sh — 空振りを緑にしない（R-TH-01）", () => {
  it("ビルドしていなければ落ちる", () => {
    const root = makeTree({ "README.md": "no build\n" });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("クライアント配布物がありません");
  });

  it(".open-next が無い（build:cf を飛ばした）だけでも落ちる", () => {
    const root = makeTree({ ".next/static/chunks/app.js": 'console.log("x");\n' });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("サーバーバンドルがありません");
  });

  it(".next/static が無い（build を飛ばした）だけでも落ちる", () => {
    const root = makeTree({ ...SERVER_WITH_NAMES });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("クライアント配布物がありません");
  });

  it("ディレクトリはあるがファイルが 0 件なら落ちる", () => {
    const root = makeTree({ ".open-next/server-functions/default/handler.mjs": "x\n" });
    fs.mkdirSync(path.join(root, ".next/static"), { recursive: true });
    fs.mkdirSync(path.join(root, ".open-next/assets"), { recursive: true });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("走査対象のファイルが 0 件です");
  });
});
