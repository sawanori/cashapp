// tests/unit/hooks/deny-dangerous-bash.test.ts
//
// check_035 / check_036（Bash 側）/ check_062（Bash リダイレクト側）の機械検証。
// scripts/deny-dangerous-bash.sh を実際に spawn して、PreToolUse(Bash) の
// フック入力 JSON を stdin に流し、終了コードだけを見る。2 = 遮断。
//
// 別名呼び出しの解決は、実リポジトリの package.json ではなく
// tests/unit/hooks/fixtures/package.json を DENY_BASH_PACKAGE_JSON で指して
// 行う（実 package.json の scripts が変わってもこのテストの意味が変わらない）。

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = path.join(repoRoot, "scripts", "deny-dangerous-bash.sh");
const fixtureDir = path.join(repoRoot, "tests", "unit", "hooks", "fixtures");
const fixturePkg = path.join(fixtureDir, "package.json");

// 本番鍵・本番環境フラグの見本はリテラルで書かない。このファイル自身が
// scripts/deny-test-weakening.sh の本番鍵検出に引っかかって書けなくなるため。
const LIVE_SECRET = ["sk", "live", "51ABCdefGHIjkl"].join("_");
const PROD_ENV_ASSIGN = `${["PAYPAY", "ENV"].join("_")}=${"PROD"}`;

interface RunResult {
  status: number;
  stderr: string;
}

function run(command: string, packageJson: string = fixturePkg): RunResult {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
  const result = spawnSync("bash", [script], {
    input: payload,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repoRoot,
      DENY_BASH_PACKAGE_JSON: packageJson,
    },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

const blockedDestructive: string[] = [
  "wrangler deploy --env production",
  "wrangler deploy",
  "npx wrangler deploy",
  "wrangler versions deploy",
  "wrangler secret put PAYPAY_API_KEY --env production",
  `${PROD_ENV_ASSIGN} node scripts/charge.mjs`,
  "supabase db push",
  "supabase db reset --local",
  "git push -f origin main",
  "git push --force-with-lease origin main",
  "git reset --hard HEAD~1",
  "rm -rf /tmp/some-directory",
  "rm -fr build",
  // GNU coreutils の長い綴り。CI は Linux なのでこの書き方が実際に通る。
  // クラスタ化フラグの走査は `-` の直後が英字のトークンしか見ないため、
  // --recursive / --force は別途判定する。
  "rm --recursive --force /tmp/probe-dir",
  "rm --force --recursive /tmp/probe-dir",
  "pnpm install",
  "pnpm run build",
  "npm publish",
  `curl -H "Authorization: Bearer ${LIVE_SECRET}" https://api.example.com`,
  "node scripts/charge.mjs --live",
];

const blockedWrites: string[] = [
  "cat > docs/run-log/task_005.json",
  "echo '[]' > docs/run-log/task_005.json",
  "echo more >> docs/run-log/task_005.json",
  "jq '.cleared = true' a.json > docs/gates/legal-clearance.json",
  "echo x > docs/acceptance-checks.json",
  "echo x | tee docs/run-log/task_005.json",
  "echo x | tee -a docs/gates/compliance-gates.json",
  "sed -i '' 's/a/b/' tests/contract/duplicate.test.ts",
  "sed -i.bak 's/x/y/' scripts/deny-dangerous-bash.sh",
  "sed -i '' 's/x/y/' scripts/record-run.sh",
  "cp /tmp/settings.json .claude/settings.json",
  "mv /tmp/gate.yml .github/workflows/gate.yml",
  `python3 -c "open('docs/run-log/task_005.json','w').write('[]')"`,
  // 宛先の後ろにトークンが 1 つ付くだけで素通りしていた（最終トークンだけを
  // 見ていたため）。cp/mv は節の全トークンを検査する。
  "cp /tmp/a.json docs/gates/legal-clearance.json 2>/dev/null",
  "cp /tmp/a.json docs/gates/legal-clearance.json --verbose",
  "mv /tmp/gate.yml .github/workflows/gate.yml --force",
  "rsync -a /tmp/logs/ docs/run-log/ --delete",
  // 上書きだけを塞いでも、1 コマンドの削除でガードが全部消える。
  // ガード本体・フック登録・ゲート定義・テスト・run-log の削除と復元。
  "rm scripts/deny-dangerous-bash.sh",
  "rm -f scripts/deny-test-weakening.sh",
  "rm scripts/record-run.sh",
  "rm .claude/settings.json",
  "rm docs/run-log/task_005.json",
  "rm docs/gates/legal-clearance.json",
  "rm tests/contract/duplicate.test.ts",
  // ディレクトリごと。PROTECTED_RE は末尾スラッシュ付きなので
  // ディレクトリ名そのもの（docs/gates / .claude）は別の正規表現で見る。
  "rm -r docs/gates",
  "rm -r tests",
  "git clean -fd .claude",
  "git rm docs/gates/legal-clearance.json",
  "git checkout HEAD -- scripts/deny-dangerous-bash.sh",
  "git restore tests/contract/duplicate.test.ts",
  "unlink docs/run-log/task_005.json",
  "truncate -s 0 docs/gates/legal-clearance.json",
  // 実行権を落とす・/dev/null へ張り替えるのも無力化と同じ。
  "chmod -x scripts/deny-dangerous-bash.sh",
  "ln -sf /dev/null .claude/settings.json",
  // GNU sed の長い綴り。
  "sed --in-place s/expect/xpect/ tests/contract/duplicate.test.ts",
  // python の open だけを見ていたので、このリポジトリの実行系である node の
  // 同等経路が空いていた。perl -i / ruby / bun / deno も同じクラス。
  `node -e "require('fs').writeFileSync('docs/run-log/x.json','[]')"`,
  `node --eval "require('fs').writeFileSync('docs/gates/x.json','{}')"`,
  `bun -e "Bun.write('docs/run-log/x.json','[]')"`,
  `deno eval "Deno.writeTextFileSync('docs/run-log/x.json','[]')"`,
  "perl -i -pe s/expect/xpect/ tests/contract/duplicate.test.ts",
  `ruby -e "File.write('docs/run-log/x.json','[]')"`,
  // dd の of= はリダイレクトと同じく宛先を切り詰める。
  "dd if=/dev/null of=docs/run-log/task_005.json",
];

const blockedAliases: string[] = [
  // fixtures/package.json: deploy:production = "wrangler deploy --env production"
  "npm run deploy:production",
  "npm run-script deploy:production",
  "yarn deploy:production",
  // 2 段の入れ子（nested:deploy -> deploy:production）
  "npm run nested:deploy",
  // 連結の各節をたどる（release -> build && deploy:production）
  "npm run release",
  // record-run.sh でくるんでも中身は同じ判定を受ける
  "scripts/record-run.sh task_005 npm run deploy:production",
  // 解決不能 + 名前が deploy|secret|publish|reset|push|prod に一致 -> fail-closed
  "npm run prod-push",
  "npm run publish:beta",
  // npm のフラグを挟む形。.claude/settings.json の PostToolUse が
  // `npm run --silent <script>` を使うため、この書き方はリポジトリの慣習で
  // もある。フラグを読み飛ばして最初の非フラグトークンを名前として扱う。
  "npm run --silent deploy:production",
  "npm run -s deploy:production",
  "npm --silent run deploy:production",
  "npm run --workspace=w deploy:production",
  "yarn run --silent deploy:production",
  "yarn --silent deploy:production",
  // フラグ付きでも解決不能 + risky 名なら fail-closed
  "npm run --silent prod-push",
];

// 保護対象パスを「名指ししない」形の迂回路。いずれも修正前は exit 0 だった。
const blockedEvasions: string[] = [
  // (1) `>|` は noclobber を無視する上書きリダイレクト。normalize() が `|` を
  // 節区切りに変える前に `>` へ畳まないと、リダイレクト先が消えて素通りする。
  "echo x >| docs/run-log/task_005.json",
  "echo x >|docs/gates/legal-clearance.json",
  "cat /tmp/a.json >| .claude/settings.json",
  "echo x >| tests/unit/hooks/deny-dangerous-bash.test.ts",
  // (2) カレントディレクトリ・ワイルドカードを対象にした削除と復元。
  // リポジトリ直下の `.` は docs/run-log も tests も .claude も含む。
  "rm -r .",
  "rm -r ./",
  "rm -rf ./",
  "rm -r *",
  "git checkout .",
  "git restore .",
  "git checkout -- .",
  "git checkout HEAD -- .",
  // git clean はパスを 1 つも書かずに未追跡ファイルを全部消す。
  "git clean -fdx",
  "git clean -f",
  "git clean -fd",
  "git clean -xdf",
  "cd docs && git checkout .",
  // (3) パッチ適用。書き換え先は diff の中にしか書かれていない。
  "git apply /tmp/evil.patch",
  "git apply -p1 /tmp/evil.patch",
  "patch -p1 < /tmp/evil.patch",
  "git apply",
  "cat /tmp/evil.patch | patch -p1",
  // (4) cd 後の相対パスと、変数展開されたリダイレクト先。
  "cd docs/run-log && echo x > y.json",
  "cd docs/gates; echo x > legal-clearance.json",
  "cd docs && cd run-log && echo x > y.json",
  "cd docs/run-log && cat > y.json",
  "cd .claude && echo x > settings.json",
  "cd tests && echo x > smoke.test.ts",
  "cd docs/run-log && rm y.json",
  "cd docs/../docs/gates && echo x > a.json",
  "cd docs/run-log && echo x | tee y.json",
  "F=docs/run-log/x.json; echo x > $F",
  "echo x > ${F}",
  "OUT=$HOME/x; echo y > $OUT",
  "echo x | tee $DEST",
];

const allowed: string[] = [
  "npm run test:unit",
  // フラグ読み飛ばしが安全なスクリプトまで巻き込まないこと
  "npm run --silent test:unit",
  "npm --silent run test:unit",
  "npm install --silent",
  "scripts/record-run.sh task_005 npm run test:unit",
  "scripts/with-lock.sh git git commit -m 'task_005: hooks'",
  "npm run safe:chain",
  // 名前は reset に一致するが解決でき、本体は無害（rm -f のみで -r が無い）
  "npm run reset:fixtures",
  "git status --porcelain",
  "cat docs/run-log/task_005.json",
  "ls tests/unit/hooks",
  "grep -rn 'expect(' tests/unit",
  "echo hello > /tmp/scratch.txt",
  "node scripts/session-brief.mjs",
  "docker info",
  // 削除・権限・復元の判定が保護対象の外まで巻き込まないこと
  "rm -f /tmp/scratch.txt",
  "rm /tmp/scratch.txt",
  "chmod +x /tmp/scratch.sh",
  "chmod +x scripts/ci/record-worker-size.mjs",
  "git checkout main",
  "git add scripts/deny-dangerous-bash.sh",
  // インタプリタ判定が「-e 等のフラグ + 保護対象パス」の両方を要求すること
  "node --version",
  "python3 /tmp/helper.py",
  "node -e \"console.log(1)\"",
  // インタプリタ名が散文として出てくるだけのコマンド。-e / -c が
  // インタプリタ自身のオプションでないと遮断しない（実際に自分の
  // コミットメッセージがこれで弾かれた）。
  "git commit -m 'node / deno / bun / perl の迂回を塞ぐ。tests と docs/run-log は --force でも触らない'",
  // 迂回路を塞いだ副作用で普通の作業まで止めていないこと。
  "git clean -n",
  "git clean --dry-run",
  "cd src && echo x > page.tsx",
  "cd /tmp && echo x > y.json",
  "cd src/app && rm page.tsx",
  "cd docs && ls run-log",
  "git diff --name-only --diff-filter=ACMR HEAD -- '*.ts'",
  "scripts/record-run.sh task_005 npm run gate:constraints",
  "scripts/record-run.sh --manual task_005 'SessionStart の注入を目視で確認した'",
];

describe("deny-dangerous-bash.sh — 破壊的・本番系コマンド", () => {
  for (const command of blockedDestructive) {
    it(`exit 2: ${command}`, () => {
      expect(run(command).status).toBe(2);
    });
  }

  it("引用符と連続空白で難読化しても遮断する", () => {
    expect(run('wrangler    "deploy"   --env  production').status).toBe(2);
  });

  it("&& で連結された後続の節も見る", () => {
    expect(run("npm run build && wrangler deploy").status).toBe(2);
  });

  it("改行で区切られた行も見る", () => {
    expect(run("echo start\nwrangler deploy\necho done").status).toBe(2);
  });

  it("遮断時は理由を stderr に書く", () => {
    const result = run("wrangler deploy");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("BLOCKED");
  });

  // 遮断メッセージは該当サブコマンドを引用する。sk_live_ ルールと
  // wrangler secret put ルールは定義上「秘密値を含むコマンド」にしか当たらない
  // ので、素で引用すると遮断のたびに必ず秘密値がフック出力に載る（禁止事項）。
  it("秘密値は遮断メッセージに出さない（sk_live_ トークン）", () => {
    const result = run(`curl -H "Authorization: Bearer ${LIVE_SECRET}" https://api.example.com`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("BLOCKED");
    expect(result.stderr).not.toContain(LIVE_SECRET);
  });

  it("秘密値は遮断メッセージに出さない（wrangler secret put 以降）", () => {
    const result = run("wrangler secret put PAYPAY_API_KEY --env production");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("BLOCKED");
    expect(result.stderr).not.toContain("PAYPAY_API_KEY");
  });

  it("秘密値は遮断メッセージに出さない（環境変数への代入）", () => {
    const result = run("STRIPE_SECRET_KEY=rk_test_abc node scripts/charge.mjs --live");
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain("rk_test_abc");
  });
});

describe("deny-dangerous-bash.sh — 保護対象への Bash 経由の書き込み", () => {
  for (const command of blockedWrites) {
    it(`exit 2: ${command}`, () => {
      expect(run(command).status).toBe(2);
    });
  }
});

describe("deny-dangerous-bash.sh — 保護対象を名指ししない迂回路", () => {
  for (const command of blockedEvasions) {
    it(`exit 2: ${command}`, () => {
      expect(run(command).status).toBe(2);
    });
  }

  // パッチファイルは保護対象の外（一時ディレクトリ）に置いて渡す。フック自身が
  // コマンドラインに現れる保護対象パスを先に弾くため、tests/ 配下のフィクスチャを
  // そのまま渡すと「中身を読んだ結果」なのか「パスを見た結果」なのか区別できない。
  const tmpPatchDir = mkdtempSync(path.join(os.tmpdir(), "deny-bash-patch-"));
  const patchAt = (name: string): string => {
    const dest = path.join(tmpPatchDir, name);
    copyFileSync(path.join(fixtureDir, name), dest);
    return dest;
  };

  it("読めるパッチの中身まで見て、保護対象を書き換えるパッチは遮断する", () => {
    const result = run(`git apply ${patchAt("touches-protected.patch")}`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("パッチ本体が保護対象パスを含みます");
  });

  it("保護対象を含まないと示せるパッチは通す（無条件の fail-closed ではない）", () => {
    const result = run(`git apply ${patchAt("touches-src-only.patch")}`);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("コマンドラインが保護対象パスを名指しするパッチ適用も遮断する", () => {
    const result = run(`git apply ${path.join(fixtureDir, "touches-protected.patch")}`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("BLOCKED");
  });

  it("適用先を示せないパッチ（stdin）は fail-closed で遮断する", () => {
    const result = run("git apply < /tmp/unknown.patch");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("BLOCKED");
  });

  it("cd を追跡して宛先を解決していることを理由文で示す", () => {
    const result = run("cd docs/run-log && echo x > y.json");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("リダイレクト先");
  });

  it("変数展開された宛先は解決不能として遮断する", () => {
    const result = run("F=docs/run-log/x.json; echo x > $F");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("変数展開");
  });
});

describe("deny-dangerous-bash.sh — package.json.scripts の別名呼び出し", () => {
  for (const command of blockedAliases) {
    it(`exit 2: ${command}`, () => {
      expect(run(command).status).toBe(2);
    });
  }
});

describe("deny-dangerous-bash.sh — 通常の作業は通す", () => {
  for (const command of allowed) {
    it(`exit 0: ${command}`, () => {
      const result = run(command);
      expect({ command, status: result.status, stderr: result.stderr }).toEqual({
        command,
        status: 0,
        stderr: "",
      });
    });
  }
});

describe("deny-dangerous-bash.sh — 入力の異常系", () => {
  it("空の stdin は素通しする（フック以外からの誤起動）", () => {
    const result = spawnSync("bash", [script], { input: "", encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("壊れた JSON は安全側に倒して遮断する", () => {
    const result = spawnSync("bash", [script], { input: "{not json", encoding: "utf8" });
    expect(result.status).toBe(2);
  });

  it("command が無い入力は素通しする", () => {
    const result = spawnSync("bash", [script], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: {} }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  });
});
