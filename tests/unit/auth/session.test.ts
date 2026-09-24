/**
 * `src/lib/auth/session.ts` のユニットテスト。
 *
 * acceptance-checks check_073:
 *   「直前の kid で署名したセッションは検証される（2 世代前は 401）。
 *     session_epoch を進めると当該ユーザーの全セッションが即 401」
 * 対応リスク: R-SEC-10。
 */

import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { MIN_SECRET_BYTES, loadAppConfig } = await import("@/lib/config/env");
const {
  SESSION_AUDIENCE,
  SESSION_COOKIE_NAME,
  SESSION_ISSUER,
  SESSION_TTL_SECONDS,
  SessionError,
  assertSessionEpoch,
  buildClearedSessionCookie,
  buildSessionCookie,
  issueSession,
  readSessionCookie,
  shouldRefreshSession,
  verifySession,
} = await import("@/lib/auth/session");

const KEY_CURRENT = "c".repeat(MIN_SECRET_BYTES);
const KEY_PREVIOUS = "p".repeat(MIN_SECRET_BYTES);
const KEY_TWO_AGO = "o".repeat(MIN_SECRET_BYTES);
const USER_ID = "11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-09-24T00:00:00Z");

function configWith(sessionKeys: string) {
  return loadAppConfig({
    APP_ENV: "development",
    LINE_ENV_PROFILE: JSON.stringify({
      env: "development",
      liffId: "2000000000-abcd1234",
      loginChannelId: "2000000000",
    }),
    PEPPER: `1:${"x".repeat(MIN_SECRET_BYTES)}`,
    SESSION_KEYS: sessionKeys,
    CRON_SECRETS: "y".repeat(MIN_SECRET_BYTES),
  });
}

/** 現行 1 鍵だけの設定（＝鍵を回す前）。 */
const CONFIG_ONE_KEY = configWith(`prev:${KEY_PREVIOUS}`);
/** 鍵を 1 回回した後の設定（現行 = cur、直前 = prev）。 */
const CONFIG_TWO_KEYS = configWith(`cur:${KEY_CURRENT},prev:${KEY_PREVIOUS}`);

describe("issueSession / verifySession", () => {
  it("発行したセッションは検証でき、クレームが往復する", async () => {
    const issued = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 3, now: NOW });
    const claims = await verifySession(CONFIG_TWO_KEYS, issued.token, { now: NOW });

    expect(claims.userId).toBe(USER_ID);
    expect(claims.epoch).toBe(3);
    expect(claims.jti).toBe(issued.jti);
    expect(claims.kid).toBe("cur");
    expect(claims.expiresAt.getTime() - claims.issuedAt.getTime()).toBe(SESSION_TTL_SECONDS * 1000);
  });

  it("現行鍵（先頭）で署名される", async () => {
    const issued = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 1, now: NOW });
    expect(issued.kid).toBe("cur");
    const header = JSON.parse(
      Buffer.from(issued.token.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as { alg: string; kid: string };
    expect(header.alg).toBe("HS256");
    expect(header.kid).toBe("cur");
  });

  it("jti は発行ごとに変わる", async () => {
    const a = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 1, now: NOW });
    const b = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 1, now: NOW });
    expect(a.jti).not.toBe(b.jti);
  });
});

describe("kid の二重運用（check_073）", () => {
  it("直前の kid で署名されたセッションは検証される", async () => {
    // 鍵を回す前に発行 → 回した後の設定で検証。
    const issuedBeforeRotation = await issueSession(CONFIG_ONE_KEY, {
      userId: USER_ID,
      epoch: 1,
      now: NOW,
    });
    expect(issuedBeforeRotation.kid).toBe("prev");

    const claims = await verifySession(CONFIG_TWO_KEYS, issuedBeforeRotation.token, { now: NOW });
    expect(claims.kid).toBe("prev");
    expect(claims.userId).toBe(USER_ID);
  });

  it("2 世代前の kid は検証できない（設定に鍵が無い）", async () => {
    const twoAgoToken = await new SignJWT({ epoch: 1 })
      .setProtectedHeader({ alg: "HS256", kid: "two-ago", typ: "JWT" })
      .setIssuer(SESSION_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setSubject(USER_ID)
      .setJti("deadbeef")
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + SESSION_TTL_SECONDS)
      .sign(new TextEncoder().encode(KEY_TWO_AGO));

    await expect(verifySession(CONFIG_TWO_KEYS, twoAgoToken, { now: NOW })).rejects.toBeInstanceOf(
      SessionError,
    );
  });

  it("kid は合っていても別の鍵で署名されていれば落ちる", async () => {
    const forged = await new SignJWT({ epoch: 1 })
      .setProtectedHeader({ alg: "HS256", kid: "cur", typ: "JWT" })
      .setIssuer(SESSION_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setSubject(USER_ID)
      .setJti("deadbeef")
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + SESSION_TTL_SECONDS)
      .sign(new TextEncoder().encode(KEY_TWO_AGO));

    await expect(verifySession(CONFIG_TWO_KEYS, forged, { now: NOW })).rejects.toBeInstanceOf(
      SessionError,
    );
  });

  it("kid の無いトークンは落ちる（alg の取り違えを許さない）", async () => {
    const noKid = await new SignJWT({ epoch: 1 })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(SESSION_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setSubject(USER_ID)
      .setJti("deadbeef")
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + SESSION_TTL_SECONDS)
      .sign(new TextEncoder().encode(KEY_CURRENT));

    await expect(verifySession(CONFIG_TWO_KEYS, noKid, { now: NOW })).rejects.toBeInstanceOf(
      SessionError,
    );
  });
});

describe("verifySession — 落ちる条件", () => {
  it("空文字は落ちる", async () => {
    await expect(verifySession(CONFIG_TWO_KEYS, "", { now: NOW })).rejects.toBeInstanceOf(
      SessionError,
    );
  });

  it("JWT の形をしていなければ落ちる", async () => {
    await expect(verifySession(CONFIG_TWO_KEYS, "not-a-jwt", { now: NOW })).rejects.toBeInstanceOf(
      SessionError,
    );
  });

  it("署名部分を改竄すると落ちる", async () => {
    const issued = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 1, now: NOW });
    const [header, payload] = issued.token.split(".");
    await expect(
      verifySession(CONFIG_TWO_KEYS, `${header}.${payload}.AAAAAAAAAAAAAAAAAAAAAA`, { now: NOW }),
    ).rejects.toBeInstanceOf(SessionError);
  });

  it("期限切れは落ちる（許容ずれを超えたところから）", async () => {
    const issued = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 1, now: NOW });
    const wellAfter = new Date(NOW.getTime() + (SESSION_TTL_SECONDS + 120) * 1000);
    await expect(
      verifySession(CONFIG_TWO_KEYS, issued.token, { now: wellAfter }),
    ).rejects.toBeInstanceOf(SessionError);
  });

  it("有効期限内なら通る", async () => {
    const issued = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 1, now: NOW });
    const inWindow = new Date(NOW.getTime() + (SESSION_TTL_SECONDS - 60) * 1000);
    await expect(verifySession(CONFIG_TWO_KEYS, issued.token, { now: inWindow })).resolves.toBeDefined();
  });

  it("epoch クレームが無いトークンは落ちる", async () => {
    const noEpoch = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: "cur", typ: "JWT" })
      .setIssuer(SESSION_ISSUER)
      .setAudience(SESSION_AUDIENCE)
      .setSubject(USER_ID)
      .setJti("deadbeef")
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + SESSION_TTL_SECONDS)
      .sign(new TextEncoder().encode(KEY_CURRENT));

    await expect(verifySession(CONFIG_TWO_KEYS, noEpoch, { now: NOW })).rejects.toBeInstanceOf(
      SessionError,
    );
  });

  it("失敗の理由（jose の内部メッセージ）を外に出さない", async () => {
    try {
      await verifySession(CONFIG_TWO_KEYS, "not-a-jwt", { now: NOW });
      throw new Error("expected verifySession to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as Error).message).not.toMatch(/JWSInvalid|Compact JWS|signature verification/i);
    }
  });
});

describe("assertSessionEpoch（check_073: session_epoch による即時失効）", () => {
  it("DB の現在値と一致していれば通る", async () => {
    const issued = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 5, now: NOW });
    const claims = await verifySession(CONFIG_TWO_KEYS, issued.token, { now: NOW });
    expect(() => assertSessionEpoch(claims, 5)).not.toThrow();
  });

  it("epoch を 1 進めると、期限内でも既存セッションが無効になる", async () => {
    const issued = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 5, now: NOW });
    const claims = await verifySession(CONFIG_TWO_KEYS, issued.token, { now: NOW });
    expect(() => assertSessionEpoch(claims, 6)).toThrow(SessionError);
  });

  it("epoch を戻したトークン（古い値）も通らない", async () => {
    const issued = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 4, now: NOW });
    const claims = await verifySession(CONFIG_TWO_KEYS, issued.token, { now: NOW });
    expect(() => assertSessionEpoch(claims, 5)).toThrow(SessionError);
  });
});

describe("shouldRefreshSession（30 分スライディング / §7-4）", () => {
  it("発行直後は更新しない", async () => {
    const issued = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 1, now: NOW });
    const claims = await verifySession(CONFIG_TWO_KEYS, issued.token, { now: NOW });
    expect(shouldRefreshSession(claims, NOW)).toBe(false);
  });

  it("有効期間の半分を過ぎたら更新する", async () => {
    const issued = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 1, now: NOW });
    const claims = await verifySession(CONFIG_TWO_KEYS, issued.token, { now: NOW });
    const justBefore = new Date(NOW.getTime() + (SESSION_TTL_SECONDS / 2 - 1) * 1000);
    const justAfter = new Date(NOW.getTime() + (SESSION_TTL_SECONDS / 2 + 1) * 1000);

    expect(shouldRefreshSession(claims, justBefore)).toBe(false);
    expect(shouldRefreshSession(claims, justAfter)).toBe(true);
  });

  it("更新すると jti が変わる（CSRF トークンも入れ替わる）", async () => {
    const first = await issueSession(CONFIG_TWO_KEYS, { userId: USER_ID, epoch: 1, now: NOW });
    const later = new Date(NOW.getTime() + (SESSION_TTL_SECONDS / 2 + 60) * 1000);
    const refreshed = await issueSession(CONFIG_TWO_KEYS, {
      userId: USER_ID,
      epoch: 1,
      now: later,
    });

    expect(refreshed.jti).not.toBe(first.jti);
    expect(refreshed.expiresAt.getTime()).toBeGreaterThan(first.expiresAt.getTime());
  });
});

describe("Cookie（__Host- 接頭辞と属性）", () => {
  it("名前は __Host- 接頭辞を持つ", () => {
    expect(SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
  });

  it("HttpOnly / Secure / SameSite=Lax / Path=/ が付き、Domain は付かない", () => {
    const cookie = buildSessionCookie("token-value");
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=token-value`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    // __Host- 接頭辞は Domain 属性を許さない。
    expect(cookie).not.toContain("Domain=");
  });

  it("消去用 Cookie は Max-Age=0", () => {
    const cookie = buildClearedSessionCookie();
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });

  it("Cookie ヘッダからセッションを取り出せる", () => {
    expect(readSessionCookie(`other=1; ${SESSION_COOKIE_NAME}=abc; more=2`)).toBe("abc");
    expect(readSessionCookie("other=1")).toBeUndefined();
    expect(readSessionCookie(null)).toBeUndefined();
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=`)).toBeUndefined();
  });

  it("名前が似ているだけの Cookie は拾わない", () => {
    expect(readSessionCookie(`__Host-session-other=abc`)).toBeUndefined();
    expect(readSessionCookie(`session=abc`)).toBeUndefined();
  });
});
