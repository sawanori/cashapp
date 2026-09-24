/**
 * `src/lib/auth/csrf.ts` のユニットテストと、「JS から設定される Cookie が 0 個」の機械検査。
 *
 * acceptance-checks:
 *   - check_058: `X-CSRF-Token` 無しの POST は 403（除外ルートは対象外）。
 *   - check_075 の一部: 「JS から設定される Cookie が 0 個」。
 * 対応リスク: R-SEC-12。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { MIN_SECRET_BYTES, loadAppConfig } = await import("@/lib/config/env");
const {
  CSRF_EXEMPT_PATH_PREFIXES,
  CSRF_HEADER,
  CsrfError,
  assertCsrfToken,
  deriveCsrfToken,
  isCsrfExemptPath,
  timingSafeEqual,
} = await import("@/lib/auth/csrf");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "src");

const KEY_CURRENT = "c".repeat(MIN_SECRET_BYTES);
const KEY_PREVIOUS = "p".repeat(MIN_SECRET_BYTES);

const CONFIG = loadAppConfig({
  APP_ENV: "development",
  LINE_ENV_PROFILE: JSON.stringify({
    env: "development",
    liffId: "2000000000-abcd1234",
    loginChannelId: "2000000000",
  }),
  PEPPER: `1:${"x".repeat(MIN_SECRET_BYTES)}`,
  SESSION_KEYS: `cur:${KEY_CURRENT},prev:${KEY_PREVIOUS}`,
  CRON_SECRETS: "y".repeat(MIN_SECRET_BYTES),
});

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("deriveCsrfToken", () => {
  it("同じ jti からは同じトークン", async () => {
    const a = await deriveCsrfToken(CONFIG, "jti-1");
    const b = await deriveCsrfToken(CONFIG, "jti-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("jti が違えばトークンも違う（セッションに束縛されている）", async () => {
    expect(await deriveCsrfToken(CONFIG, "jti-1")).not.toBe(await deriveCsrfToken(CONFIG, "jti-2"));
  });

  it("kid が違えばトークンも違う（鍵ローテーションに追随する）", async () => {
    expect(await deriveCsrfToken(CONFIG, "jti-1", "cur")).not.toBe(
      await deriveCsrfToken(CONFIG, "jti-1", "prev"),
    );
  });

  it("kid を省略すると現行鍵で導出される", async () => {
    expect(await deriveCsrfToken(CONFIG, "jti-1")).toBe(
      await deriveCsrfToken(CONFIG, "jti-1", "cur"),
    );
  });

  it("未知の kid では導出できない", async () => {
    await expect(deriveCsrfToken(CONFIG, "jti-1", "two-ago")).rejects.toBeInstanceOf(CsrfError);
  });

  it("jti そのものはトークンから読み取れない", async () => {
    const token = await deriveCsrfToken(CONFIG, "jti-secret-value");
    expect(token).not.toContain("jti-secret-value");
  });
});

describe("assertCsrfToken（check_058）", () => {
  it("正しいトークンなら通る", async () => {
    const token = await deriveCsrfToken(CONFIG, "jti-1", "cur");
    await expect(assertCsrfToken(CONFIG, token, "jti-1", "cur")).resolves.toBeUndefined();
  });

  it("ヘッダが無ければ CsrfError（呼び出し側で 403）", async () => {
    await expect(assertCsrfToken(CONFIG, null, "jti-1", "cur")).rejects.toBeInstanceOf(CsrfError);
  });

  it("空文字でも CsrfError", async () => {
    await expect(assertCsrfToken(CONFIG, "", "jti-1", "cur")).rejects.toBeInstanceOf(CsrfError);
  });

  it("値が違えば CsrfError", async () => {
    await expect(assertCsrfToken(CONFIG, "not-the-token", "jti-1", "cur")).rejects.toBeInstanceOf(
      CsrfError,
    );
  });

  it("別セッションのトークンは通らない", async () => {
    const otherSessionToken = await deriveCsrfToken(CONFIG, "jti-other", "cur");
    await expect(
      assertCsrfToken(CONFIG, otherSessionToken, "jti-1", "cur"),
    ).rejects.toBeInstanceOf(CsrfError);
  });

  it("直前鍵で発行されたセッションのトークンは、その kid で検証できる", async () => {
    const token = await deriveCsrfToken(CONFIG, "jti-old", "prev");
    await expect(assertCsrfToken(CONFIG, token, "jti-old", "prev")).resolves.toBeUndefined();
    // 現行鍵で検証しようとすると通らない（束縛が効いている）。
    await expect(assertCsrfToken(CONFIG, token, "jti-old", "cur")).rejects.toBeInstanceOf(CsrfError);
  });

  it("ヘッダ名は X-CSRF-Token", () => {
    expect(CSRF_HEADER).toBe("X-CSRF-Token");
  });
});

describe("timingSafeEqual", () => {
  it("同じ文字列は true", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
  });

  it("違う文字列は false（長さ違いも含む）", () => {
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "a")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("CSRF 検証の除外ルート（制約 W6 / §9）", () => {
  it.each([
    ["/api/webhooks/paypay/abc", true],
    ["/api/cron/reconcile", true],
    ["/api/telemetry/client-error", true],
    ["/api/auth/line", true],
    ["/api/e/preview", true],
    ["/api/return/abc123", true],
    ["/api/consent", false],
    ["/api/e/claim", false],
    ["/api/events", false],
    ["/api/invoices/abc/void", false],
  ])("%s → 除外=%s", (pathname, exempt) => {
    expect(isCsrfExemptPath(pathname)).toBe(exempt);
  });

  it("Webhook と cron は必ず除外に入っている（ボディパーサ・CSRF を通さない）", () => {
    expect(CSRF_EXEMPT_PATH_PREFIXES).toContain("/api/webhooks/");
    expect(CSRF_EXEMPT_PATH_PREFIXES).toContain("/api/cron/");
  });
});

describe("JS から設定される Cookie が 0 個（check_075 / R-SEC-12）", () => {
  const sources = listSourceFiles(SRC_DIR);

  it("src/ に document.cookie の読み書きが 1 件も無い", () => {
    const offenders = sources.filter((file) => readFileSync(file, "utf8").includes("document.cookie"));
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it("Cookie を組み立てるのは src/lib/auth/session.ts だけ", () => {
    const offenders = sources
      .filter((file) => /Path=\/|Max-Age=|SameSite=/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join("/"));
    expect(offenders).toEqual(["src/lib/auth/session.ts"]);
  });

  it("set-cookie を設定するのは、その 2 つのビルダーの戻り値だけ", () => {
    const setCookieUsers = sources.filter((file) =>
      /set-cookie/i.test(readFileSync(file, "utf8")),
    );
    for (const file of setCookieUsers) {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      if (relative === "src/lib/auth/session.ts") continue;
      expect(
        /build(Session|ClearedSession)Cookie\(/.test(source),
        `${relative} sets a cookie without using the session cookie builders`,
      ).toBe(true);
    }
    // 上のループが空振りしないことを保証する（set-cookie を書く箇所は実在する）。
    expect(setCookieUsers.length).toBeGreaterThan(0);
  });

  it("CSRF トークンは Cookie に入らない（csrf.ts に Cookie 操作が無い）", () => {
    const source = readFileSync(path.join(SRC_DIR, "lib/auth/csrf.ts"), "utf8");
    expect(source).not.toMatch(/set-cookie/i);
    expect(source).not.toContain("document.cookie");
  });

  it("セッション Cookie は必ず HttpOnly（JS から読めない）", () => {
    const source = readFileSync(path.join(SRC_DIR, "lib/auth/session.ts"), "utf8");
    const builders = source.match(/return \[[\s\S]*?\]\.join\("; "\)/g) ?? [];
    expect(builders.length).toBe(2);
    for (const builder of builders) {
      expect(builder).toContain("HttpOnly");
      expect(builder).toContain("Secure");
    }
  });
});
