/**
 * Webhook の送信元 IP 許可リストの統合テスト（check_110 / R-SEC-11 / check_095）。
 *
 * `tests/integration/webhook-route.test.ts`（task_018 所有）が「許可外 IP は 403 で DB に
 * 1 行も残さない」を実ルート境界（`handleWebhookRequest`）で検査済みなので、ここでは
 * その入口が使う `src/lib/webhook/ip-allowlist.ts` の**判定ロジックそのもの**を、
 * 境界値・fail-closed 側を中心に網羅する（純粋関数なので DB 不要・timestamptz 不具合の
 * 影響を受けない）。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { hashSourceIp, isIpAllowed, parseIpAllowlist, sourceIpOf } = await import(
  "@/lib/webhook/ip-allowlist"
);

describe("parseIpAllowlist — 1 つでも書式が不正なら空配列（fail-closed）", () => {
  it("正しい CIDR と完全一致を解釈する", () => {
    const rules = parseIpAllowlist("203.0.113.0/24, 198.51.100.7");
    expect(rules).toEqual([
      { kind: "ipv4", network: expect.any(Number), maskBits: 24 },
      { kind: "ipv4", network: expect.any(Number), maskBits: 32 },
    ]);
  });

  it("IPv6 は完全一致のみで受け付ける", () => {
    const rules = parseIpAllowlist("2001:db8::1");
    expect(rules).toEqual([{ kind: "exact", value: "2001:db8::1" }]);
  });

  it.each([
    ["未設定", undefined],
    ["null", null],
    ["空文字", ""],
    ["カンマだけ", ",,,"],
    ["マスク欠落のスラッシュ", "203.0.113.0/"],
    ["マスクが数値でない", "203.0.113.0/abc"],
    ["マスクが範囲外（33）", "203.0.113.0/33"],
    ["IPv4 の桁が範囲外（256）", "203.0.113.256"],
    ["1 件だけ不正でも全体を空にする", "203.0.113.0/24,not-an-ip"],
  ])("%s は空配列", (_label, spec) => {
    expect(parseIpAllowlist(spec as string | undefined)).toEqual([]);
  });

  it("空文字のマスク（'203.0.113.0/'）を全許可（/0）として解釈しない（実測で発見された分岐の固定化）", () => {
    // `Number("")` は 0 になるため、書式検査を先にしないと "/0"（全 IPv4 許可）に
    // 化けてしまう。入口防御が逆向きに働く事故を回帰させない。
    const rules = parseIpAllowlist("203.0.113.0/");
    expect(rules).toEqual([]);
    expect(isIpAllowed("8.8.8.8", rules)).toBe(false);
  });
});

describe("isIpAllowed — CIDR 境界とマスク /0", () => {
  it("/24 の境界（含まれる最後の IP・含まれない次の IP）", () => {
    const rules = parseIpAllowlist("203.0.113.0/24");
    expect(isIpAllowed("203.0.113.255", rules)).toBe(true);
    expect(isIpAllowed("203.0.114.0", rules)).toBe(false);
  });

  it("/32（完全一致相当）は 1 アドレスだけ通す", () => {
    const rules = parseIpAllowlist("198.51.100.7");
    expect(isIpAllowed("198.51.100.7", rules)).toBe(true);
    expect(isIpAllowed("198.51.100.8", rules)).toBe(false);
  });

  it("/0 は全 IPv4 を通す（明示的に指定したときのみ。既定では現れない）", () => {
    const rules = parseIpAllowlist("0.0.0.0/0");
    expect(isIpAllowed("1.2.3.4", rules)).toBe(true);
    expect(isIpAllowed("255.255.255.255", rules)).toBe(true);
  });

  it("規則が空・IP が取れない・IP が空文字はすべて false（fail-closed）", () => {
    const rules = parseIpAllowlist("203.0.113.0/24");
    expect(isIpAllowed("8.8.8.8", [])).toBe(false);
    expect(isIpAllowed(null, rules)).toBe(false);
    expect(isIpAllowed(undefined, rules)).toBe(false);
    expect(isIpAllowed("", rules)).toBe(false);
    expect(isIpAllowed("not-an-ip", rules)).toBe(false);
  });

  it("IPv6 は完全一致のみ。大文字小文字は区別しない", () => {
    const rules = parseIpAllowlist("2001:DB8::1");
    expect(isIpAllowed("2001:db8::1", rules)).toBe(true);
    expect(isIpAllowed("2001:db8::2", rules)).toBe(false);
  });
});

describe("sourceIpOf — CF-Connecting-IP だけを信用する", () => {
  it("CF-Connecting-IP があればそれを使う", () => {
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.9" });
    expect(sourceIpOf(headers)).toBe("203.0.113.9");
  });

  it("X-Forwarded-For はクライアントが自由に付けられるので信用しない（CF-Connecting-IP 無しなら null）", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.0/0" });
    expect(sourceIpOf(headers)).toBeNull();
  });

  it("X-Forwarded-For で CF-Connecting-IP を偽装しても、実際の CF-Connecting-IP が優先される", () => {
    const headers = new Headers({
      "cf-connecting-ip": "203.0.113.9",
      "x-forwarded-for": "6.6.6.6",
    });
    const rules = parseIpAllowlist("203.0.113.9");
    expect(isIpAllowed(sourceIpOf(headers), rules)).toBe(true);
  });
});

describe("hashSourceIp — 生 IP をハッシュ側にしか残さない（R-SEC-02）", () => {
  it("同じ IP・同じ鍵は同じ参照値、違う IP は違う参照値、生 IP は含まれない", async () => {
    const key = "k".repeat(32);
    const a = await hashSourceIp("203.0.113.9", key);
    const b = await hashSourceIp("203.0.113.9", key);
    const c = await hashSourceIp("203.0.113.10", key);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.length).toBe(8);
    expect(a.toString("hex")).not.toContain("203");
  });
});
