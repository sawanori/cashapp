/**
 * `src/lib/idempotency.ts` のユニットテスト（純粋関数部分）。
 *
 * DB を介した予約・再送・越境の実挙動（`runIdempotent`）は実 Postgres が要るため
 * `tests/integration/events.test.ts` で検証する（task_014 scope の「冪等キー再送同一応答・
 * 越境 409」）。ここでは純粋関数（ハッシュ計算・ヘッダ検査・user_ref 導出・エラー整形）を検査する。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { AppError } = await import("@/lib/errors");
const {
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_TTL_HOURS,
  computeRequestHash,
  idempotencyConflict,
  idempotencyInProgress,
  idempotencyKeyRequired,
  idempotencyUserRef,
  requireIdempotencyKey,
} = await import("@/lib/idempotency");

describe("IDEMPOTENCY_HEADER / TTL", () => {
  it("ヘッダ名は Idempotency-Key で、TTL は 24 時間", () => {
    expect(IDEMPOTENCY_HEADER).toBe("Idempotency-Key");
    expect(IDEMPOTENCY_TTL_HOURS).toBe(24);
  });
});

describe("requireIdempotencyKey", () => {
  it("ヘッダが無ければ 400 IDEMPOTENCY_KEY_REQUIRED", () => {
    const request = new Request("https://example.test/api/events", { method: "POST" });
    expect(() => requireIdempotencyKey(request)).toThrow(AppError);
    try {
      requireIdempotencyKey(request);
      expect.unreachable();
    } catch (error) {
      expect((error as InstanceType<typeof AppError>).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
      expect((error as InstanceType<typeof AppError>).status).toBe(400);
    }
  });

  it("空文字・空白のみのヘッダも拒否する", () => {
    const request = new Request("https://example.test/api/events", {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: "   " },
    });
    expect(() => requireIdempotencyKey(request)).toThrow(AppError);
  });

  it("200 文字を超えるキーは拒否する", () => {
    const request = new Request("https://example.test/api/events", {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: "a".repeat(201) },
    });
    expect(() => requireIdempotencyKey(request)).toThrow(AppError);
  });

  it("前後の空白を取り除いた値を返す", () => {
    const request = new Request("https://example.test/api/events", {
      method: "POST",
      headers: { [IDEMPOTENCY_HEADER]: "  abc-123  " },
    });
    expect(requireIdempotencyKey(request)).toBe("abc-123");
  });
});

describe("computeRequestHash", () => {
  it("キー順が違っても同じ内容なら同じハッシュになる", async () => {
    const a = await computeRequestHash({ title: "t", organizerLabel: "l", minorsIncluded: false });
    const b = await computeRequestHash({ minorsIncluded: false, title: "t", organizerLabel: "l" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("内容が違えば違うハッシュになる", async () => {
    const a = await computeRequestHash({ title: "t1" });
    const b = await computeRequestHash({ title: "t2" });
    expect(a).not.toBe(b);
  });

  it("ネストしたオブジェクト・配列も正準化する", async () => {
    const a = await computeRequestHash({ participants: [{ displayLabel: "x", z: 1 }] });
    const b = await computeRequestHash({ participants: [{ z: 1, displayLabel: "x" }] });
    expect(a).toBe(b);
  });

  it("null ボディも安定してハッシュ化する", async () => {
    const a = await computeRequestHash(null);
    const b = await computeRequestHash(undefined);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("idempotencyUserRef", () => {
  it("UUID を 16 バイトの Buffer に変換する", () => {
    const ref = idempotencyUserRef("11111111-2222-3333-4444-555555555555");
    expect(ref).toBeInstanceOf(Buffer);
    expect(ref.length).toBe(16);
    expect(ref.toString("hex")).toBe("11111111222233334444555555555555");
  });

  it("同じ UUID からは常に同じ値を返す（決定的）", () => {
    const a = idempotencyUserRef("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const b = idempotencyUserRef("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(a.equals(b)).toBe(true);
  });

  it("UUID の形でない値は 400 で拒否する", () => {
    expect(() => idempotencyUserRef("not-a-uuid")).toThrow(AppError);
    try {
      idempotencyUserRef("not-a-uuid");
      expect.unreachable();
    } catch (error) {
      expect((error as InstanceType<typeof AppError>).status).toBe(400);
    }
  });
});

describe("エラー整形", () => {
  it("idempotencyConflict は 409 IDEMPOTENCY_CONFLICT", () => {
    const error = idempotencyConflict("mismatch");
    expect(error.status).toBe(409);
    expect(error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("idempotencyInProgress は 409 IDEMPOTENCY_IN_PROGRESS", () => {
    const error = idempotencyInProgress("still running");
    expect(error.status).toBe(409);
    expect(error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
  });

  it("idempotencyKeyRequired は 400 IDEMPOTENCY_KEY_REQUIRED", () => {
    const error = idempotencyKeyRequired();
    expect(error.status).toBe(400);
    expect(error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("応答ボディに秘密値・内部詳細を含まない（{ code, message, requestId } のみを想定）", () => {
    const error = idempotencyConflict("internal detail that must not leak");
    // detail はログ専用（AppError.detail）。message には出ない。
    expect(error.message).not.toContain("internal detail");
  });
});
