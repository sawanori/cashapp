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
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = path.join(repoRoot, "scripts", "deny-dangerous-bash.sh");
const fixturePkg = path.join(repoRoot, "tests", "unit", "hooks", "fixtures", "package.json");

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
];

const allowed: string[] = [
  "npm run test:unit",
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
});

describe("deny-dangerous-bash.sh — 保護対象への Bash 経由の書き込み", () => {
  for (const command of blockedWrites) {
    it(`exit 2: ${command}`, () => {
      expect(run(command).status).toBe(2);
    });
  }
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
