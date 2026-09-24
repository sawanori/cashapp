/**
 * `GET /api/events/:id/export.csv`（O-12）の CSV 組み立てロジックのユニットテスト。
 *
 * DB・セッションに触れる部分（Route Handler の `GET`）は統合テストの範囲とし、ここでは
 * 純粋関数（`buildCsv` / `csvField` / `contentDispositionFilename`）だけを見る。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({ env: {}, cf: undefined, ctx: undefined }),
}));

const {
  CSV_TITLE,
  DISCLAIMER_LINES,
  buildCsv,
  csvField,
  contentDispositionFilename,
} = await import("@/app/api/events/[id]/export.csv/route");

describe("csvField", () => {
  it("quotes values containing commas, quotes, or newlines", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('a"b')).toBe('"a""b"');
    expect(csvField("a\nb")).toBe('"a\nb"');
  });
});

describe("buildCsv", () => {
  it("does not contain any word banned by docs/wording-policy.md (W-RECEIPT)", () => {
    const csv = buildCsv("manual_confirm", []);
    expect(csv).not.toContain("領収書");
    expect(csv).not.toContain("インボイス");
    expect(csv).not.toContain("適格請求書");
    expect(csv).toContain(CSV_TITLE);
  });

  it("prints the fixed disclaimer lines before the header row", () => {
    const csv = buildCsv("manual_confirm", []);
    const lines = csv.split("\r\n");
    for (let i = 0; i < DISCLAIMER_LINES.length; i += 1) {
      expect(lines[i]).toBe(DISCLAIMER_LINES[i]);
    }
  });

  it("includes auto_detected / confirmation_method / fee / net columns in the header (scope O-12)", () => {
    const csv = buildCsv("manual_confirm", []);
    const headerLine = csv.split("\r\n")[DISCLAIMER_LINES.length + 1];
    expect(headerLine).toContain("自動検知");
    expect(headerLine).toContain("確認方法");
    expect(headerLine).toContain("手数料");
    expect(headerLine).toContain("受取見込額");
  });

  it("computes fee=0 and net=amount for a paid manual_confirm row (feeModel.kind='none')", () => {
    const csv = buildCsv("manual_confirm", [
      {
        display_label: "山田太郎",
        amount_minor: 5000,
        settlement_status: "paid",
        auto_detected: false,
        confirmation_method: "manual_by_organizer",
      },
    ]);
    const lines = csv.trim().split("\r\n");
    const dataLine = lines[lines.length - 1] ?? "";
    const cols = dataLine.split(",");
    expect(cols[0]).toBe("山田太郎");
    expect(cols[1]).toBe("5000");
    expect(cols[2]).toBe("paid");
    expect(cols[3]).toBe("false");
    expect(cols[4]).toBe("manual_by_organizer");
    expect(cols[5]).toBe("0");
    expect(cols[6]).toBe("5000");
  });

  it("leaves fee/net blank for an unpaid row", () => {
    const csv = buildCsv("manual_confirm", [
      {
        display_label: null,
        amount_minor: 3000,
        settlement_status: "unpaid",
        auto_detected: false,
        confirmation_method: "manual_by_organizer",
      },
    ]);
    const lines = csv.trim().split("\r\n");
    const dataLine = lines[lines.length - 1] ?? "";
    const cols = dataLine.split(",");
    expect(cols[5]).toBe("");
    expect(cols[6]).toBe("");
  });

  it("leaves fee/net blank for an undetermined provider (not in the static capabilities table)", () => {
    const csv = buildCsv("some_future_provider", [
      {
        display_label: "参加者A",
        amount_minor: 1000,
        settlement_status: "paid",
        auto_detected: true,
        confirmation_method: "automatic",
      },
    ]);
    const lines = csv.trim().split("\r\n");
    const dataLine = lines[lines.length - 1] ?? "";
    const cols = dataLine.split(",");
    expect(cols[5]).toBe("");
    expect(cols[6]).toBe("");
  });
});

describe("contentDispositionFilename", () => {
  it("provides both an ascii fallback and a UTF-8 filename*", () => {
    const header = contentDispositionFilename("evt-123");
    expect(header).toContain('filename="receipt-record-evt-123.csv"');
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent(`${CSV_TITLE}_evt-123.csv`));
  });
});
