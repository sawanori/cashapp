/**
 * ログ・例外・ビルド成果物に資格情報 / 生 userId / 生 IP / joinToken が出ないことの検査（check_041）。
 *
 * 対応リスク: R-SEC-04 / R-SEC-02。制約 L7。
 *
 * 検査は 3 層。
 *   1. `src/lib/logger.ts` のキー allowlist と値のスクラブが、意図的に汚した入力で機能すること。
 *   2. 実際に `console.log` / `console.error` へ流れた文字列に秘密値が出ないこと
 *      （意図的に例外を起こした経路を含む）。
 *   3. リポジトリの中身とビルド成果物（`.next/static` / `.open-next`）に、
 *      ローカル雛形の秘密値・LINE の生 userId・service role キーの形が出ないこと。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

// errors.ts は `server-only` を読まないので素の静的 import でよい（型としても使うため）。
import { AppError } from "@/lib/errors";

vi.mock("server-only", () => ({}));

const { LOG_KEY_ALLOWLIST, REDACTION_RULES, buildLogRecord, hashIp, logEvent, redact } =
  await import("@/lib/logger");
const { MIN_SECRET_BYTES, loadAppConfig } = await import("@/lib/config/env");
const { verifyLineIdToken } = await import("@/lib/auth/line-verify");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 検査に使う「絶対に出てはいけない」代表値。 */
const RAW_LINE_USER_ID = "Uabcdef0123456789abcdef0123456789";
const RAW_IPV4 = "198.51.100.77";
const RAW_IPV6 = "2001:db8::dead:beef";
const RAW_ID_TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVYWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODkifQ.c2lnbmF0dXJlLXZhbHVl";
const RAW_JOIN_TOKEN = "joIN7okEnAbCdEfGhIjKlMnOpQrStUvWxYz012345";
const RAW_PEPPER = "p".repeat(MIN_SECRET_BYTES);
const RAW_CONNECTION_STRING = "postgresql://app_rw:supersecretpassword@db.example.internal:5432/postgres";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger — キーの allowlist", () => {
  it("allowlist に無いキーは落ちる", () => {
    const record = buildLogRecord("info", "test.event", {
      idToken: RAW_ID_TOKEN,
      joinToken: RAW_JOIN_TOKEN,
      ip: RAW_IPV4,
      sub: RAW_LINE_USER_ID,
      pepper: RAW_PEPPER,
      password: "hunter2",
    });
    expect(Object.keys(record).sort()).toEqual(["event", "level", "ts"]);
  });

  it("allowlist にあるキーは残る", () => {
    const record = buildLogRecord("info", "auth.session_issued", {
      requestId: "a".repeat(32),
      userId: "11111111-2222-3333-4444-555555555555",
      kid: "cur",
      sessionEpoch: 3,
    });
    expect(record["requestId"]).toBe("a".repeat(32));
    expect(record["userId"]).toBe("11111111-2222-3333-4444-555555555555");
    expect(record["kid"]).toBe("cur");
    expect(record["sessionEpoch"]).toBe(3);
  });

  it("オブジェクト・配列はキーが allowlist にあっても載らない（構造ごと渡す事故を止める）", () => {
    const record = buildLogRecord("info", "test.event", {
      detail: { secret: RAW_PEPPER },
      reason: [RAW_LINE_USER_ID],
    });
    expect(record["detail"]).toBeUndefined();
    expect(record["reason"]).toBeUndefined();
  });

  it("allowlist には秘密値を運びうる名前が入っていない", () => {
    for (const forbidden of [
      "idToken",
      "id_token",
      "joinToken",
      "join_token",
      "claimToken",
      "pepper",
      "PEPPER",
      "sessionKey",
      "cronSecret",
      "ip",
      "sub",
      "lineUserId",
      "password",
      "token",
      "cookie",
      "authorization",
    ]) {
      expect(LOG_KEY_ALLOWLIST, `${forbidden} must not be loggable`).not.toContain(forbidden);
    }
  });
});

describe("logger — 値のスクラブ", () => {
  it.each([
    ["LINE の生 userId", RAW_LINE_USER_ID],
    ["IPv4", RAW_IPV4],
    ["IPv6", RAW_IPV6],
    ["ID トークン（JWT）", RAW_ID_TOKEN],
    ["joinToken らしい長い不透明文字列", RAW_JOIN_TOKEN],
    ["接続文字列", RAW_CONNECTION_STRING],
    ["Bearer トークン", `Authorization: Bearer ${RAW_JOIN_TOKEN}`],
    ["PEPPER の代入形", `PEPPER=${RAW_PEPPER}`],
    ["CRON_SECRETS の代入形", `CRON_SECRETS=${"c".repeat(40)}`],
    ["service role キーの代入形", `SUPABASE_SERVICE_ROLE_KEY=${"k".repeat(40)}`],
  ])("%s は redact される", (_label, value) => {
    const scrubbed = redact(`before ${value} after`);
    expect(scrubbed).not.toContain(value);
    expect(scrubbed).toContain("[redacted:");
  });

  it("allowlist を通ったキーの値もスクラブされる", () => {
    const record = buildLogRecord("warn", "auth.failed", {
      detail: `verify failed for ${RAW_LINE_USER_ID} from ${RAW_IPV4}`,
    });
    const detail = String(record["detail"]);
    expect(detail).not.toContain(RAW_LINE_USER_ID);
    expect(detail).not.toContain(RAW_IPV4);
  });

  it("event 名自体もスクラブされる", () => {
    const record = buildLogRecord("info", `auth.${RAW_LINE_USER_ID}`, {});
    expect(String(record["event"])).not.toContain(RAW_LINE_USER_ID);
  });

  it("requestId はスクラブされない（ログとエラー応答の突き合わせに使うため）", () => {
    const requestId = "0123456789abcdef0123456789abcdef";
    const record = buildLogRecord("info", "test.event", { requestId });
    expect(record["requestId"]).toBe(requestId);
  });

  it("スクラブ規則は 1 つも空振りしない（全規則に一致例がある）", () => {
    const samples: Record<string, string> = {
      "line-user-id": RAW_LINE_USER_ID,
      authorization: `Bearer ${"a".repeat(20)}`,
      jwt: RAW_ID_TOKEN,
      "connection-string": RAW_CONNECTION_STRING,
      ipv4: RAW_IPV4,
      ipv6: RAW_IPV6,
      "secret-assignment": `PEPPER=${RAW_PEPPER}`,
      "long-opaque": RAW_JOIN_TOKEN,
      "long-opaque-b64url": "aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh-iiii",
    };
    for (const rule of REDACTION_RULES) {
      const sample = samples[rule.label];
      expect(sample, `no sample for redaction rule '${rule.label}'`).toBeDefined();
      expect(redact(sample ?? "")).toContain("[redacted:");
    }
  });
});

describe("hashIp — 生 IP をログに残さない（§7-5）", () => {
  it("同じ IP は同じ参照値、違う IP は違う参照値", async () => {
    const a = await hashIp(RAW_IPV4, RAW_PEPPER);
    const b = await hashIp(RAW_IPV4, RAW_PEPPER);
    const c = await hashIp("203.0.113.1", RAW_PEPPER);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("参照値から元の IP は読み取れない", async () => {
    const ref = await hashIp(RAW_IPV4, RAW_PEPPER);
    expect(ref).not.toContain(RAW_IPV4);
    expect(ref).not.toContain("198");
  });

  it("PEPPER が違えば参照値も違う", async () => {
    expect(await hashIp(RAW_IPV4, RAW_PEPPER)).not.toBe(await hashIp(RAW_IPV4, "q".repeat(32)));
  });
});

describe("実際に標準出力へ流れる文字列（意図的に例外を起こした経路を含む）", () => {
  function captureConsole(): { lines: string[] } {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    return { lines };
  }

  it("汚染された入力を渡しても秘密値が出力に出ない", () => {
    const captured = captureConsole();
    logEvent("error", "auth.failed", {
      detail: `id_token=${RAW_ID_TOKEN} ip=${RAW_IPV4} sub=${RAW_LINE_USER_ID} join=${RAW_JOIN_TOKEN}`,
      code: "ID_TOKEN_INVALID",
      requestId: "f".repeat(32),
      idToken: RAW_ID_TOKEN,
      pepper: RAW_PEPPER,
    });

    const output = captured.lines.join("\n");
    expect(output.length).toBeGreaterThan(0);
    for (const secret of [RAW_ID_TOKEN, RAW_IPV4, RAW_LINE_USER_ID, RAW_JOIN_TOKEN, RAW_PEPPER]) {
      expect(output, `secret leaked into logs: ${secret.slice(0, 8)}…`).not.toContain(secret);
    }
    expect(output).toContain("ID_TOKEN_INVALID");
  });

  it("ID トークン検証の失敗経路が、トークンを例外にもログにも残さない", async () => {
    const captured = captureConsole();
    const failingFetch = (async (): Promise<Response> =>
      Response.json({ error_description: "Invalid IdToken." }, { status: 400 })) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await verifyLineIdToken({
        idToken: RAW_ID_TOKEN,
        loginChannelId: "2000000000",
        fetchImpl: failingFetch,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppError);
    const appError = thrown as AppError;
    logEvent("warn", "auth.failed", {
      code: appError.code,
      ...(appError.detail === undefined ? {} : { detail: appError.detail }),
    });

    const serialized = `${appError.message}|${appError.detail ?? ""}|${captured.lines.join("\n")}`;
    expect(serialized).not.toContain(RAW_ID_TOKEN);
    expect(serialized).not.toContain(RAW_LINE_USER_ID);
  });

  it("設定不備の例外にも秘密値が出ない", () => {
    const short = "s".repeat(MIN_SECRET_BYTES - 1);
    try {
      loadAppConfig({
        APP_ENV: "development",
        LINE_ENV_PROFILE: JSON.stringify({
          env: "development",
          liffId: "2000000000-abcd1234",
          loginChannelId: "2000000000",
        }),
        PEPPER: `1:${short}`,
        SESSION_KEYS: `k1:${"a".repeat(MIN_SECRET_BYTES)}`,
        CRON_SECRETS: "b".repeat(MIN_SECRET_BYTES),
      });
      throw new Error("expected loadAppConfig to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
    }
  });
});

function listFiles(dir: string, out: string[] = [], limit = 4000): string[] {
  if (!existsSync(dir) || out.length >= limit) return out;
  for (const entry of readdirSync(dir)) {
    if (out.length >= limit) break;
    const full = path.join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      listFiles(full, out, limit);
    } else if (stats.size < 8 * 1024 * 1024) {
      out.push(full);
    }
  }
  return out;
}

describe("リポジトリとビルド成果物に秘密値の形が出ない（check_041）", () => {
  /** `.env.example` のローカル雛形の値。実値ではないが、同じ形が成果物に出たら混入の証拠になる。 */
  const templateSecrets = (() => {
    const raw = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
    return [...raw.matchAll(/^(?:PEPPER|SESSION_KEYS|CRON_SECRETS|APP_RW_PASSWORD)=(.+)$/gm)].map(
      (m) => (m[1] ?? "").trim(),
    );
  })();

  it(".env.example から検査対象の雛形値を取り出せている（空振り防止）", () => {
    expect(templateSecrets.length).toBeGreaterThanOrEqual(4);
    for (const secret of templateSecrets) {
      expect(secret.length).toBeGreaterThan(8);
    }
  });

  it("src/ に LINE の生 userId の形が 1 件も無い", () => {
    const offenders = listFiles(path.join(REPO_ROOT, "src")).filter((file) =>
      /U[0-9a-f]{32}/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it("src/ に service role キー・接続文字列がハードコードされていない", () => {
    // コメント（`//` と `/* */`）は除いてから見る。task_011 の client.ts は、
    // `?user=` による迂回の実測記録として接続文字列**の例**をコメントに書いている。
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

    const offenders = listFiles(path.join(REPO_ROOT, "src")).filter((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      return (
        /SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*["']/.test(code) ||
        /postgres(?:ql)?:\/\/[^\s"']*:[^\s"']+@/.test(code)
      );
    });
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it("ビルド成果物（.next/static / .open-next）に雛形の秘密値が出ない", () => {
    const artifactDirs = [path.join(REPO_ROOT, ".next/static"), path.join(REPO_ROOT, ".open-next")];
    const present = artifactDirs.filter((dir) => existsSync(dir));
    const offenders: string[] = [];

    for (const dir of present) {
      for (const file of listFiles(dir)) {
        let content: string;
        try {
          content = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        for (const secret of templateSecrets) {
          if (secret.length >= 12 && content.includes(secret)) {
            offenders.push(`${path.relative(REPO_ROOT, file)} contains a template secret`);
          }
        }
        if (/U[0-9a-f]{32}/.test(content)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} contains a raw LINE user id shape`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // ★ この検査は「いま存在する成果物」に対するものであり、最新のソースを反映しているとは限らない。
    //   ビルド直後の成果物に対する検査は CI（task_022 の secrets-grep）が担当する。
    //   ここでは、少なくとも 1 つの成果物ディレクトリを実際に走査したことを記録する。
    expect(present.length).toBeGreaterThan(0);
  });
});
