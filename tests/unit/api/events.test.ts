/**
 * イベント・参加者 API のユニットテスト（純粋関数部分。DB を使わない）。
 *
 * DB に触れる挙動（IDOR・冪等・論理削除・ページング・監査連鎖）は
 * `tests/integration/events.test.ts` / `tests/integration/audit-chain.test.ts` で検証する。
 * ここでは `src/lib/db/repositories/events.ts` / `participants.ts` のボディ検証関数と
 * エラーファクトリ（コード・ステータス）を検査する。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { AppError } = await import("@/lib/errors");
const {
  MAX_ACTIVE_EVENTS_PER_ORGANIZER,
  MAX_PARTICIPANTS_PER_EVENT,
  eventForbidden,
  eventNotFound,
  eventStatusConflict,
  organizerLimitExceeded,
  parseCreateEventBody,
  parseUpdateEventBody,
} = await import("@/lib/db/repositories/events");
const {
  parseCreateParticipantsBody,
  parseListParticipantsQuery,
  participantHasOpenAttempt,
  participantLimitExceeded,
  participantNotFound,
} = await import("@/lib/db/repositories/participants");

function validCreateEventBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "夏合宿",
    organizerLabel: "山田太郎",
    minorsIncluded: false,
    feeDisclosureAccepted: true,
    ...overrides,
  };
}

describe("parseCreateEventBody", () => {
  it("必須項目が揃っていれば通る", () => {
    const parsed = parseCreateEventBody(validCreateEventBody());
    expect(parsed.title).toBe("夏合宿");
    expect(parsed.organizerLabel).toBe("山田太郎");
    expect(parsed.minorsIncluded).toBe(false);
    expect(parsed.feeDisclosureAccepted).toBe(true);
    expect(parsed.allowCash).toBe(false);
    expect(parsed.venue).toBeNull();
    expect(parsed.defaultAmountMinor).toBeNull();
  });

  it("organizerLabel が空文字なら 400（task_014 done_definition）", () => {
    expect(() => parseCreateEventBody(validCreateEventBody({ organizerLabel: "" }))).toThrow(AppError);
    try {
      parseCreateEventBody(validCreateEventBody({ organizerLabel: "" }));
      expect.unreachable();
    } catch (error) {
      expect((error as InstanceType<typeof AppError>).status).toBe(400);
    }
  });

  it("organizerLabel が 40 文字を超えると 400", () => {
    expect(() =>
      parseCreateEventBody(validCreateEventBody({ organizerLabel: "あ".repeat(41) })),
    ).toThrow(AppError);
  });

  it("organizerLabel が未指定（キー自体が無い）でも 400", () => {
    const body = validCreateEventBody();
    delete body["organizerLabel"];
    expect(() => parseCreateEventBody(body)).toThrow(AppError);
  });

  it("title が空文字なら 400", () => {
    expect(() => parseCreateEventBody(validCreateEventBody({ title: "" }))).toThrow(AppError);
  });

  it("minorsIncluded が未指定（既定値に頼れない）なら 400", () => {
    const body = validCreateEventBody();
    delete body["minorsIncluded"];
    expect(() => parseCreateEventBody(body)).toThrow(AppError);
  });

  it("minorsIncluded が真偽値でなければ 400", () => {
    expect(() => parseCreateEventBody(validCreateEventBody({ minorsIncluded: "yes" }))).toThrow(AppError);
  });

  it("feeDisclosureAccepted が true でなければ作成できない（false・未指定のいずれも 400）", () => {
    expect(() =>
      parseCreateEventBody(validCreateEventBody({ feeDisclosureAccepted: false })),
    ).toThrow(AppError);
    const body = validCreateEventBody();
    delete body["feeDisclosureAccepted"];
    expect(() => parseCreateEventBody(body)).toThrow(AppError);
  });

  it("defaultAmountMinor は 1〜1,000,000 の整数のみ許容する", () => {
    expect(parseCreateEventBody(validCreateEventBody({ defaultAmountMinor: 3000 })).defaultAmountMinor).toBe(
      3000,
    );
    expect(() => parseCreateEventBody(validCreateEventBody({ defaultAmountMinor: 0 }))).toThrow(AppError);
    expect(() =>
      parseCreateEventBody(validCreateEventBody({ defaultAmountMinor: 1_000_001 })),
    ).toThrow(AppError);
    expect(() => parseCreateEventBody(validCreateEventBody({ defaultAmountMinor: 1.5 }))).toThrow(AppError);
  });

  it("eventAt / collectByAt は妥当な ISO 日付文字列のみ許容する", () => {
    const parsed = parseCreateEventBody(
      validCreateEventBody({ eventAt: "2026-10-01T00:00:00Z", collectByAt: "2026-10-05T00:00:00Z" }),
    );
    expect(parsed.eventAt).toBeInstanceOf(Date);
    expect(parsed.collectByAt).toBeInstanceOf(Date);
    expect(() => parseCreateEventBody(validCreateEventBody({ eventAt: "not-a-date" }))).toThrow(AppError);
  });

  it("venue / offering は上限を超えると 400、空文字は null 扱いにしない（空は拒否）", () => {
    expect(() =>
      parseCreateEventBody(validCreateEventBody({ venue: "x".repeat(201) })),
    ).toThrow(AppError);
    expect(() =>
      parseCreateEventBody(validCreateEventBody({ offering: "x".repeat(401) })),
    ).toThrow(AppError);
  });

  it("ボディが JSON オブジェクトでなければ 400", () => {
    expect(() => parseCreateEventBody(null)).toThrow(AppError);
    expect(() => parseCreateEventBody("string")).toThrow(AppError);
    expect(() => parseCreateEventBody([])).toThrow(AppError);
  });
});

describe("parseUpdateEventBody", () => {
  it("title / collectByAt / status のいずれかがあれば通る", () => {
    expect(parseUpdateEventBody({ title: "新タイトル" })).toEqual({ title: "新タイトル" });
    expect(parseUpdateEventBody({ status: "collecting" })).toEqual({ status: "collecting" });
  });

  it("何も指定がなければ 400", () => {
    expect(() => parseUpdateEventBody({})).toThrow(AppError);
  });

  it("未知の status は 400", () => {
    expect(() => parseUpdateEventBody({ status: "unknown" })).toThrow(AppError);
  });

  it("collectByAt に null を渡すと明示的な解除として受理する", () => {
    const parsed = parseUpdateEventBody({ collectByAt: null });
    expect(parsed.collectByAt).toBeNull();
  });
});

describe("parseCreateParticipantsBody", () => {
  it("参加者配列が空なら 400", () => {
    expect(() => parseCreateParticipantsBody({ participants: [] })).toThrow(AppError);
  });

  it("displayLabel が空・上限超過なら 400", () => {
    expect(() =>
      parseCreateParticipantsBody({ participants: [{ displayLabel: "" }] }),
    ).toThrow(AppError);
    expect(() =>
      parseCreateParticipantsBody({ participants: [{ displayLabel: "あ".repeat(41) }] }),
    ).toThrow(AppError);
  });

  it("1 リクエストあたりの件数が名簿上限を超えると 400", () => {
    const many = Array.from({ length: MAX_PARTICIPANTS_PER_EVENT + 1 }, (_, i) => ({
      displayLabel: `p${i}`,
    }));
    expect(() => parseCreateParticipantsBody({ participants: many })).toThrow(AppError);
  });

  it("正常系は trim 済みの値を返す", () => {
    const parsed = parseCreateParticipantsBody({ participants: [{ displayLabel: "  山田  " }] });
    expect(parsed.participants).toEqual([{ displayLabel: "山田" }]);
  });
});

describe("parseListParticipantsQuery", () => {
  it("既定値は filter=unpaid, sort=created_asc, limit=30", () => {
    const parsed = parseListParticipantsQuery(new URLSearchParams());
    expect(parsed.filter).toBe("unpaid");
    expect(parsed.sort).toBe("created_asc");
    expect(parsed.limit).toBe(30);
    expect(parsed.q).toBeNull();
    expect(parsed.cursor).toBeNull();
  });

  it("filter / sort に不正値を渡すと 400", () => {
    expect(() => parseListParticipantsQuery(new URLSearchParams("filter=bogus"))).toThrow(AppError);
    expect(() => parseListParticipantsQuery(new URLSearchParams("sort=bogus"))).toThrow(AppError);
  });

  it("limit は 1〜100 の整数のみ許容する", () => {
    expect(parseListParticipantsQuery(new URLSearchParams("limit=100")).limit).toBe(100);
    expect(() => parseListParticipantsQuery(new URLSearchParams("limit=0"))).toThrow(AppError);
    expect(() => parseListParticipantsQuery(new URLSearchParams("limit=101"))).toThrow(AppError);
  });

  it("q は前後の空白を除去し、空文字は null 扱いにする", () => {
    expect(parseListParticipantsQuery(new URLSearchParams("q=%20%20")).q).toBeNull();
    expect(parseListParticipantsQuery(new URLSearchParams("q=%20yamada%20")).q).toBe("yamada");
  });
});

describe("エラーファクトリのステータス・コード", () => {
  it("イベント系: 404 / 403 / 429 / 409", () => {
    expect(eventNotFound().status).toBe(404);
    expect(eventForbidden().status).toBe(403);
    expect(organizerLimitExceeded().status).toBe(429);
    expect(eventStatusConflict().status).toBe(409);
  });

  it("参加者系: 404 / 409 (HAS_OPEN_ATTEMPT) / 429", () => {
    expect(participantNotFound().status).toBe(404);
    const openAttempt = participantHasOpenAttempt();
    expect(openAttempt.status).toBe(409);
    expect(openAttempt.code).toBe("HAS_OPEN_ATTEMPT");
    expect(participantLimitExceeded().status).toBe(429);
  });

  it("上限の定数は正の整数である", () => {
    expect(MAX_ACTIVE_EVENTS_PER_ORGANIZER).toBeGreaterThan(0);
    expect(MAX_PARTICIPANTS_PER_EVENT).toBeGreaterThan(0);
  });
});
