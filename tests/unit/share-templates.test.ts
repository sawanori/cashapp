/**
 * `src/lib/share-templates.ts`（O-7 配布の文言・Flex テンプレ・QR / task_016）。
 *
 * done_definition:
 *   - Flex テンプレが「幹事ラベル／イベント名／金額／締切／固定文言」の 5 要素を持つ。
 *   - 固定文言は一字一句「支払先は幹事の決済アカウントで、アプリはお金を預かりません」。
 *   - Flex に参加者名を含めない（関数のシグネチャ自体が参加者名を受け取らない）。
 *   - リンクの組み立てが既存の「自分に送る」（`src/app/(liff)/e/me/page.tsx`）と同じ形。
 */

import { describe, expect, it } from "vitest";

import {
  PAYMENT_DISCLAIMER_TEXT,
  buildExplanationText,
  buildFlexShareMessage,
  buildJoinLink,
  buildJoinLinkQrSvg,
  buildReminderText,
  formatDeadline,
  formatYenAmount,
} from "@/lib/share-templates";

const EVENT = {
  organizerLabel: "山田太郎",
  eventTitle: "秋の飲み会",
  collectByAt: "2026-10-10T00:00:00.000Z",
};

describe("formatYenAmount / formatDeadline", () => {
  it("null は未設定と表示する", () => {
    expect(formatYenAmount(null)).toBe("未設定");
    expect(formatDeadline(null)).toBe("未設定");
  });

  it("金額は ¥ 区切り表記になる", () => {
    expect(formatYenAmount(3000)).toBe("¥3,000");
  });
});

describe("buildJoinLink", () => {
  it("自分に送る（e/me/page.tsx）と同じ形のリンクを組み立てる", () => {
    const link = buildJoinLink("https://liff.line.me/1234567890-abcd1234", "tok_abc");
    expect(link).toBe("https://liff.line.me/1234567890-abcd1234/e?t=tok_abc");
  });

  it("トークンを URL エンコードする", () => {
    const link = buildJoinLink("https://liff.line.me/1234567890-abcd1234", "a+b/c=");
    expect(link).toContain(encodeURIComponent("a+b/c="));
    expect(link).not.toContain("a+b/c=");
  });
});

describe("buildReminderText（催促文＋URL。主導線）", () => {
  it("イベント名・金額・締切・リンク・固定の支払先説明を含む", () => {
    const link = "https://liff.line.me/xxx/e?t=tok";
    const text = buildReminderText({ event: EVENT, link, amountMinor: 3000 });
    expect(text).toContain(EVENT.eventTitle);
    expect(text).toContain("¥3,000");
    expect(text).toContain(link);
    expect(text).toContain("支払先は幹事（山田太郎）の決済アカウントです");
  });

  it("participantLabel を渡すと宛名が先頭に付く", () => {
    const text = buildReminderText({
      event: EVENT,
      link: "https://liff.line.me/xxx/e?t=tok",
      amountMinor: 3000,
      participantLabel: "鈴木",
    });
    expect(text.startsWith("鈴木さん")).toBe(true);
  });
});

describe("buildExplanationText（リンクを疑われた際の説明テンプレ）", () => {
  it("幹事名・アプリはお金を預からない旨・リンクを含む", () => {
    const link = "https://liff.line.me/xxx/e?t=tok";
    const text = buildExplanationText(EVENT.organizerLabel, link);
    expect(text).toContain(EVENT.organizerLabel);
    expect(text).toContain("お金を預かりません");
    expect(text).toContain(link);
  });
});

describe("buildFlexShareMessage（固定 5 要素。task_016 done_definition）", () => {
  const link = "https://liff.line.me/xxx/e?t=tok";
  const message = buildFlexShareMessage({ event: EVENT, amountMinor: 3000, link });
  const texts = message.contents.body.contents.map((c) => c.text);

  it("body.contents は 5 要素だけを持つ", () => {
    expect(message.contents.body.contents).toHaveLength(5);
  });

  it("1: 幹事ラベルを含む", () => {
    expect(texts[0]).toContain(EVENT.organizerLabel);
  });

  it("2: イベント名を含む", () => {
    expect(texts[1]).toContain(EVENT.eventTitle);
  });

  it("3: 金額を含む", () => {
    expect(texts[2]).toContain("¥3,000");
  });

  it("4: 締切を含む", () => {
    expect(texts[3]).toContain(formatDeadline(EVENT.collectByAt));
  });

  it("5: 固定文言を一字一句含む", () => {
    expect(texts[4]).toBe(PAYMENT_DISCLAIMER_TEXT);
    expect(PAYMENT_DISCLAIMER_TEXT).toBe("支払先は幹事の決済アカウントで、アプリはお金を預かりません");
  });

  it("参加者名を受け取らない（関数シグネチャに参加者名の引数が無い）", () => {
    // buildFlexShareMessage は event / amountMinor / link のみを受け取る。
    // 5 要素のどれにも参加者の displayLabel が混ざりようがないことを、
    // 実際に組み立てたテキストに幹事名以外の固有名詞が無いことで確認する。
    for (const text of texts) {
      expect(text).not.toContain("鈴木");
      expect(text).not.toContain("displayLabel");
    }
  });

  it("footer に uri アクション（リンクを開く）を持つ", () => {
    const action = message.contents.footer.contents[0].action;
    expect(action.type).toBe("uri");
    expect(action.uri).toBe(link);
  });
});

describe("buildJoinLinkQrSvg（QR。別端末用）", () => {
  it("<svg> を含む文字列を生成する", async () => {
    const svg = await buildJoinLinkQrSvg("https://liff.line.me/xxx/e?t=tok");
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });
});
