/**
 * `src/lib/join-token.ts`（招待トークン・claim トークン）。
 *
 * done_definition:
 *   - ビット長 128 以上をアサートする（check_084）。
 *   - パスからトークンを読む入口が存在しないこと（入口はヘッダだけ）。
 *   - 期限・ローテーション・定数時間比較の形。
 *
 * DB を使う挙動（期限切れ 404・ローテーション後 404）は
 * `tests/integration/idor.test.ts` が実 Postgres で検証する。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { AppError } = await import("@/lib/errors");
const {
  CLAIM_TOKEN_BYTES,
  JOIN_TOKEN_BITS,
  JOIN_TOKEN_BYTES,
  JOIN_TOKEN_HEADER,
  JOIN_TOKEN_TTL_DAYS,
  generateToken,
  hashToken,
  isTokenShapeValid,
  joinTokenInvalid,
  mintClaimToken,
  mintJoinToken,
  readJoinTokenHeader,
  timingSafeEqualBytes,
} = await import("@/lib/join-token");

function decodedByteLength(token: string): number {
  return Buffer.from(token, "base64url").length;
}

describe("トークンの強度（check_084）", () => {
  it("JOIN_TOKEN_BITS が 128 以上である", () => {
    expect(JOIN_TOKEN_BITS).toBeGreaterThanOrEqual(128);
    expect(JOIN_TOKEN_BYTES * 8).toBe(JOIN_TOKEN_BITS);
  });

  it("生成したトークンを復号すると 128 ビット以上の乱数になっている", () => {
    for (let i = 0; i < 32; i += 1) {
      const token = generateToken();
      expect(decodedByteLength(token) * 8).toBeGreaterThanOrEqual(128);
    }
  });

  it("claim トークンも 128 ビット以上である", async () => {
    expect(CLAIM_TOKEN_BYTES * 8).toBeGreaterThanOrEqual(128);
    const minted = await mintClaimToken();
    expect(decodedByteLength(minted.token) * 8).toBeGreaterThanOrEqual(128);
  });

  it("128 ビット未満の長さを要求すると例外になる（弱いトークンを作らせない）", () => {
    expect(() => generateToken(8)).toThrow();
    expect(() => generateToken(0)).toThrow();
    expect(() => generateToken(15)).toThrow();
  });

  it("1000 本生成しても重複しない", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      seen.add(generateToken());
    }
    expect(seen.size).toBe(1000);
  });

  it("base64url の文字しか含まない（URL パスやヘッダで壊れない形）", () => {
    for (let i = 0; i < 32; i += 1) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("ハッシュ（生の値を保存しない）", () => {
  it("SHA-256（32 バイト）で、同じ入力からは同じ値になる", async () => {
    const token = generateToken();
    const a = await hashToken(token);
    const b = await hashToken(token);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  it("1 文字違うだけで別の値になる", async () => {
    const a = await hashToken("aaaaaaaaaaaaaaaaaaaaaa");
    const b = await hashToken("aaaaaaaaaaaaaaaaaaaaab");
    expect(a.equals(b)).toBe(false);
  });
});

describe("定数時間比較", () => {
  it("同じ内容なら true、1 バイトでも違えば false", () => {
    expect(timingSafeEqualBytes(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(true);
    expect(timingSafeEqualBytes(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 4]))).toBe(false);
  });

  it("長さが違えば false（長さの差も分岐で漏らさない）", () => {
    expect(timingSafeEqualBytes(Buffer.from([1, 2, 3]), Buffer.from([1, 2]))).toBe(false);
    expect(timingSafeEqualBytes(Buffer.from([]), Buffer.from([1]))).toBe(false);
  });

  it("null / undefined は常に false", () => {
    expect(timingSafeEqualBytes(null, Buffer.from([1]))).toBe(false);
    expect(timingSafeEqualBytes(Buffer.from([1]), undefined)).toBe(false);
    expect(timingSafeEqualBytes(null, null)).toBe(false);
  });
});

describe("形の検査", () => {
  it("base64url の 16 文字以上だけを受け付ける", () => {
    expect(isTokenShapeValid(generateToken())).toBe(true);
    expect(isTokenShapeValid("")).toBe(false);
    expect(isTokenShapeValid("short")).toBe(false);
    expect(isTokenShapeValid("aaaaaaaaaaaaaaaa/bbb")).toBe(false);
    expect(isTokenShapeValid("aaaaaaaaaaaaaaaa bbb")).toBe(false);
    expect(isTokenShapeValid("a".repeat(65))).toBe(false);
  });
});

describe("入口はヘッダだけ（制約 X-ID）", () => {
  it("ヘッダ名は X-Join-Token である", () => {
    expect(JOIN_TOKEN_HEADER).toBe("X-Join-Token");
  });

  it("ヘッダがあれば読み取れる", () => {
    const token = generateToken();
    const request = new Request("https://app.example/api/e/preview", {
      headers: { "X-Join-Token": token },
    });
    expect(readJoinTokenHeader(request)).toBe(token);
  });

  it("ヘッダが無ければ 404（存在も理由も教えない）", () => {
    const request = new Request("https://app.example/api/e/preview");
    try {
      readJoinTokenHeader(request);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as InstanceType<typeof AppError>).status).toBe(404);
      expect((error as InstanceType<typeof AppError>).code).toBe("JOIN_TOKEN_INVALID");
    }
  });

  it("形が違うヘッダも 404", () => {
    const request = new Request("https://app.example/api/e/preview", {
      headers: { "X-Join-Token": "../../etc/passwd" },
    });
    expect(() => readJoinTokenHeader(request)).toThrow(AppError);
  });

  it("クエリやパスに置かれた値は読まない（URL からは取らない）", () => {
    const token = generateToken();
    const request = new Request(`https://app.example/api/e/preview?t=${token}`);
    // クエリに載っていてもヘッダが無ければ 404。
    expect(() => readJoinTokenHeader(request)).toThrow(AppError);
  });
});

describe("発行（期限つき）", () => {
  it("mintJoinToken は now + TTL の期限を持つ", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const minted = await mintJoinToken(now);
    expect(minted.expiresAt.getTime() - now.getTime()).toBe(
      JOIN_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(isTokenShapeValid(minted.token)).toBe(true);
    expect(minted.hash.equals(await hashToken(minted.token))).toBe(true);
  });

  it("joinTokenInvalid は 404 で、詳細を応答本文に出さない", () => {
    const error = joinTokenInvalid("internal detail");
    expect(error.status).toBe(404);
    expect(error.message).not.toContain("internal detail");
  });
});
