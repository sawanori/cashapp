/**
 * `src/lib/config/env.ts` の起動時アサートと、`npm run gate:env` の判定のテスト。
 *
 * done_definition:
 *   - 「本番以外の project ref で起動が失敗することをテストで確認」
 *   - 「gate:env が staging に本番 project ref を混入させた fixture で非 0、正常 fixture で 0」
 * acceptance-checks: check_074（PEPPER 未設定 / 31 バイトで起動失敗）、check_076（環境プロファイルの整合）。
 *
 * `env.ts` は `import "server-only"` を持つ。server-only パッケージは `react-server` 条件が
 * 無い解決経路（＝このテストランナー）で読むと throw する設計なので、空実装に差し替える
 * （`tests/unit/db-client.test.ts` と同じ手当て）。
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  EXPECTED_SUPABASE_PROJECT_REF,
  EnvConfigError,
  MAX_SESSION_KEYS,
  MIN_SECRET_BYTES,
  configFingerprints,
  currentPepper,
  currentSessionKey,
  fingerprint,
  loadAppConfig,
  pepperByVersion,
  sessionKeyByKid,
} = await import("@/lib/config/env");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = path.join(REPO_ROOT, "tests/unit/config/fixtures/env-scope");

const PEPPER_V1 = "p".repeat(MIN_SECRET_BYTES);
const PEPPER_V2 = "q".repeat(MIN_SECRET_BYTES);
const SESSION_KEY_1 = "s".repeat(MIN_SECRET_BYTES);
const SESSION_KEY_2 = "t".repeat(MIN_SECRET_BYTES);
const CRON_SECRET = "c".repeat(MIN_SECRET_BYTES);

function profile(env: string, liffId = "2000000000-abcd1234", loginChannelId = "2000000000") {
  return JSON.stringify({ env, liffId, loginChannelId });
}

const VALID_DEV = {
  APP_ENV: "development",
  LINE_ENV_PROFILE: profile("development"),
  PEPPER: `1:${PEPPER_V1}`,
  SESSION_KEYS: `k1:${SESSION_KEY_1}`,
  CRON_SECRETS: CRON_SECRET,
} as const;

describe("loadAppConfig — 正常系", () => {
  it("揃っていれば読める", () => {
    const config = loadAppConfig(VALID_DEV);
    expect(config.appEnv).toBe("development");
    expect(config.line.liffId).toBe("2000000000-abcd1234");
    expect(config.line.loginChannelId).toBe("2000000000");
    expect(config.supabaseProjectRef).toBeNull();
  });

  it("PEPPER はバージョン降順で並び、現行は最大バージョン", () => {
    const config = loadAppConfig({ ...VALID_DEV, PEPPER: `1:${PEPPER_V1},2:${PEPPER_V2}` });
    expect(config.peppers.map((p) => p.version)).toEqual([2, 1]);
    expect(currentPepper(config).version).toBe(2);
    expect(pepperByVersion(config, 1)?.value).toBe(PEPPER_V1);
    expect(pepperByVersion(config, 9)).toBeUndefined();
  });

  it("SESSION_KEYS は記載順を保ち、先頭が現行", () => {
    const config = loadAppConfig({
      ...VALID_DEV,
      SESSION_KEYS: `cur:${SESSION_KEY_1},prev:${SESSION_KEY_2}`,
    });
    expect(config.sessionKeys.map((k) => k.kid)).toEqual(["cur", "prev"]);
    expect(currentSessionKey(config).kid).toBe("cur");
    expect(sessionKeyByKid(config, "prev")?.value).toBe(SESSION_KEY_2);
    expect(sessionKeyByKid(config, "two-generations-ago")).toBeUndefined();
  });

  it("CRON_SECRETS はカンマ区切りの許容リストとして読める", () => {
    const second = "d".repeat(MIN_SECRET_BYTES);
    const config = loadAppConfig({ ...VALID_DEV, CRON_SECRETS: `${CRON_SECRET},${second}` });
    expect(config.cronSecrets).toEqual([CRON_SECRET, second]);
  });
});

describe("loadAppConfig — 必須 env（check_074）", () => {
  it("APP_ENV が無いと落ちる", () => {
    expect(() => loadAppConfig({ ...VALID_DEV, APP_ENV: undefined })).toThrow(EnvConfigError);
  });

  it("APP_ENV が既知の 3 値以外なら落ちる", () => {
    expect(() => loadAppConfig({ ...VALID_DEV, APP_ENV: "preview" })).toThrow(/APP_ENV must be one of/);
  });

  it.each([["PEPPER"], ["SESSION_KEYS"], ["CRON_SECRETS"], ["LINE_ENV_PROFILE"]])(
    "%s が未設定なら落ちる",
    (name) => {
      expect(() => loadAppConfig({ ...VALID_DEV, [name]: undefined })).toThrow(EnvConfigError);
    },
  );

  it("PEPPER が 31 バイトなら落ちる（32 バイト未満は不可）", () => {
    const short = "p".repeat(MIN_SECRET_BYTES - 1);
    expect(() => loadAppConfig({ ...VALID_DEV, PEPPER: `1:${short}` })).toThrow(
      /PEPPER version 1 must be at least 32 bytes, got 31 bytes/,
    );
  });

  it("SESSION_KEYS が 31 バイトなら落ちる", () => {
    const short = "s".repeat(MIN_SECRET_BYTES - 1);
    expect(() => loadAppConfig({ ...VALID_DEV, SESSION_KEYS: `k1:${short}` })).toThrow(
      /must be at least 32 bytes/,
    );
  });

  it("CRON_SECRETS が 31 バイトなら落ちる", () => {
    const short = "c".repeat(MIN_SECRET_BYTES - 1);
    expect(() => loadAppConfig({ ...VALID_DEV, CRON_SECRETS: short })).toThrow(
      /CRON_SECRETS\[0\] must be at least 32 bytes/,
    );
  });

  it("秘密値そのものは例外メッセージに出ない", () => {
    const short = "z".repeat(MIN_SECRET_BYTES - 1);
    try {
      loadAppConfig({ ...VALID_DEV, PEPPER: `1:${short}` });
      throw new Error("expected loadAppConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvConfigError);
      expect((error as Error).message).not.toContain(short);
    }
  });

  it("PEPPER にバージョン番号が無ければ落ちる", () => {
    expect(() => loadAppConfig({ ...VALID_DEV, PEPPER: PEPPER_V1 })).toThrow(
      /PEPPER entries must look like/,
    );
  });

  it("PEPPER のバージョンが重複していたら落ちる", () => {
    expect(() =>
      loadAppConfig({ ...VALID_DEV, PEPPER: `1:${PEPPER_V1},1:${PEPPER_V2}` }),
    ).toThrow(/duplicate version 1/);
  });

  it(`SESSION_KEYS が ${MAX_SESSION_KEYS + 1} 個なら落ちる（2 世代前を通さないため）`, () => {
    const three = `a:${SESSION_KEY_1},b:${SESSION_KEY_2},c:${"u".repeat(MIN_SECRET_BYTES)}`;
    expect(() => loadAppConfig({ ...VALID_DEV, SESSION_KEYS: three })).toThrow(
      /at most 2 keys/,
    );
  });
});

describe("loadAppConfig — LINE_ENV_PROFILE の整合（check_076 / 制約 N3 / R-LINE-04）", () => {
  it("APP_ENV と profile.env が食い違えば落ちる", () => {
    expect(() =>
      loadAppConfig({ ...VALID_DEV, APP_ENV: "staging", LINE_ENV_PROFILE: profile("development") }),
    ).toThrow(/does not match APP_ENV/);
  });

  it("loginChannelId が LIFF ID のハイフン前と違えば落ちる（別チャネルの ID 混入）", () => {
    expect(() =>
      loadAppConfig({
        ...VALID_DEV,
        LINE_ENV_PROFILE: profile("development", "2000000000-abcd1234", "1999999999"),
      }),
    ).toThrow(/loginChannelId must equal the channel id embedded in liffId/);
  });

  it("LIFF ID の形が違えば落ちる", () => {
    expect(() =>
      loadAppConfig({
        ...VALID_DEV,
        LINE_ENV_PROFILE: profile("development", "not-a-liff-id", "2000000000"),
      }),
    ).toThrow(/liffId must look like/);
  });

  it("JSON でなければ落ちる", () => {
    expect(() => loadAppConfig({ ...VALID_DEV, LINE_ENV_PROFILE: "not json" })).toThrow(
      /not valid JSON/,
    );
  });
});

describe("loadAppConfig — APP_ENV と Supabase project ref の整合（check_076 / R-SEC-05）", () => {
  const stagingRef = EXPECTED_SUPABASE_PROJECT_REF.staging;
  const productionRef = EXPECTED_SUPABASE_PROJECT_REF.production;

  it("staging と production に固定された ref は別物である", () => {
    expect(stagingRef).not.toBe(productionRef);
    expect(stagingRef).not.toBeNull();
    expect(productionRef).not.toBeNull();
  });

  it("APP_ENV=production に staging の project ref を渡すと起動に失敗する", () => {
    expect(() =>
      loadAppConfig({
        ...VALID_DEV,
        APP_ENV: "production",
        LINE_ENV_PROFILE: profile("production"),
        SUPABASE_PROJECT_REF: stagingRef ?? "",
      }),
    ).toThrow(/is not the project ref pinned for APP_ENV='production'/);
  });

  it("APP_ENV=staging に production の project ref を渡すと起動に失敗する", () => {
    expect(() =>
      loadAppConfig({
        ...VALID_DEV,
        APP_ENV: "staging",
        LINE_ENV_PROFILE: profile("staging"),
        SUPABASE_PROJECT_REF: productionRef ?? "",
      }),
    ).toThrow(/is not the project ref pinned for APP_ENV='staging'/);
  });

  it("SUPABASE_PROJECT_REF が未設定なら staging / production は起動できない", () => {
    expect(() =>
      loadAppConfig({
        ...VALID_DEV,
        APP_ENV: "staging",
        LINE_ENV_PROFILE: profile("staging"),
      }),
    ).toThrow(/SUPABASE_PROJECT_REF is not set/);
  });

  // ★ 実 ref はまだ採番されていない（staging=task_035 / production=task_024）。
  //   プレースホルダのままでは形式検査に落ちるので、**本番はそもそも起動できない**。
  //   これは意図した fail-closed であり、実値を入れるのが上記タスクの仕事である。
  it("pin 済みの値がプレースホルダのままなら、その値を渡しても起動できない（fail-closed）", () => {
    expect(() =>
      loadAppConfig({
        ...VALID_DEV,
        APP_ENV: "production",
        LINE_ENV_PROFILE: profile("production"),
        SUPABASE_PROJECT_REF: productionRef ?? "",
      }),
    ).toThrow(/is not a valid Supabase project ref/);
  });

  it("development では project ref を要求しない", () => {
    expect(loadAppConfig(VALID_DEV).supabaseProjectRef).toBeNull();
  });
});

describe("fingerprint（check_074 / check_076）", () => {
  it("同じ値からは同じ fingerprint、違う値からは違う fingerprint", async () => {
    const a = await fingerprint("pepper", PEPPER_V1);
    const b = await fingerprint("pepper", PEPPER_V1);
    const c = await fingerprint("pepper", PEPPER_V2);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ラベルが違えば同じ値でも fingerprint が違う", async () => {
    expect(await fingerprint("pepper", "x")).not.toBe(await fingerprint("liffId", "x"));
  });

  it("fingerprint から元の値は復元できない（値が出力に含まれない）", async () => {
    const fp = await fingerprint("pepper", PEPPER_V1);
    expect(fp).not.toContain(PEPPER_V1);
    expect(fp.length).toBe(16);
  });

  it("configFingerprints が 3 種類と現行 pepper_version を返す", async () => {
    const config = loadAppConfig({ ...VALID_DEV, PEPPER: `1:${PEPPER_V1},2:${PEPPER_V2}` });
    const fps = await configFingerprints(config);
    expect(fps.pepperVersion).toBe(2);
    expect(fps.pepperFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fps.liffIdFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fps.channelIdFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fps.liffIdFingerprint).not.toBe(fps.channelIdFingerprint);
  });
});

function runGateEnv(fixtureDir: string): { exitCode: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts/gate-env-scope.mjs"), "--root", fixtureDir, "--no-live"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    return { exitCode: 0, output };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("npm run gate:env（scripts/gate-env-scope.mjs）", () => {
  it("正常 fixture では exit 0", () => {
    const result = runGateEnv(path.join(FIXTURES, "ok"));
    expect(result.output).toContain("0 violation(s)");
    expect(result.exitCode).toBe(0);
  });

  it("staging に本番 project ref / 本番 Hyperdrive ID を混入させた fixture では非 0", () => {
    const result = runGateEnv(path.join(FIXTURES, "leak"));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("value shared between staging and production");
    expect(result.output).toContain("SUPABASE_PROJECT_REF");
  });

  it("秘密値を [vars] に置いた fixture・service role キーを渡した fixture では非 0", () => {
    const result = runGateEnv(path.join(FIXTURES, "secret-in-vars"));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("SUPABASE_SERVICE_ROLE_KEY must never be a runtime var");
    expect(result.output).toContain("PEPPER is a secret");
  });

  it("実リポジトリに対しても exit 0（静的検査のみで判定した旨が出力に残る）", () => {
    const result = runGateEnv(REPO_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("0 violation(s)");
  });
});
