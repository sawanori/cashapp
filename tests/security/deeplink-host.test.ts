/**
 * 受取リンクの許可外ホスト拒否の統合テスト（check_091 / check_110 / R-SEC-14 / C27）。
 *
 * `src/lib/payments/providers/manual-confirm.ts` の `buildReceivingLink()` は
 * サーバー側テンプレートから URL を組み立て、`ALLOWED_DEEPLINK_HOSTS` の完全一致で
 * 二重に確認する。Phase 1 は `verified: false` のため既定では常に `null` を返すが、
 * ここでは「テンプレートが将来 `verified: true` になった場合でも、あるいはテンプレート
 * 自体に悪意ある `build` が混ざっても、最終防衛線（ホスト完全一致 / https 限定 /
 * userinfo・query・fragment 禁止）が破れないこと」を、独自に注入したテンプレートで検査する
 * （純粋関数・DB 不要）。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  ALLOWED_DEEPLINK_HOSTS,
  RECEIVING_LINK_TEMPLATES,
  activeReceivingLinkTemplates,
  buildReceivingLink,
} = await import("@/lib/payments/providers/manual-confirm");
type ReceivingLinkTemplate = (typeof RECEIVING_LINK_TEMPLATES)[number];

const ALLOWED_HOST = ALLOWED_DEEPLINK_HOSTS[0]!;

function verifiedTemplate(overrides: Partial<ReceivingLinkTemplate> = {}): ReceivingLinkTemplate {
  return {
    channel: "paypay_p2p",
    host: ALLOWED_HOST,
    identifierPattern: /^[A-Za-z0-9_-]{1,64}$/,
    build: (identifier) => `https://${ALLOWED_HOST}/${identifier}`,
    verified: true,
    sourceRef: "test-only",
    ...overrides,
  };
}

describe("Phase 1 の既定: 検証済みテンプレートが 0 件なので deepLink は常に null", () => {
  it("既定のテンプレート表からはリンクが 1 本も組み立てられない", () => {
    expect(activeReceivingLinkTemplates()).toEqual([]);
    expect(buildReceivingLink("paypay_p2p", "any-identifier")).toBeNull();
  });
});

describe("テンプレートが verified:true でも、許可外ホストへは組み立てられない", () => {
  it("host が ALLOWED_DEEPLINK_HOSTS に無いテンプレートは activeReceivingLinkTemplates から除外される", () => {
    const evil = verifiedTemplate({ host: "evil.example.com", build: (id) => `https://evil.example.com/${id}` });
    expect(activeReceivingLinkTemplates([evil])).toEqual([]);
    expect(buildReceivingLink("paypay_p2p", "abc123", [evil])).toBeNull();
  });

  it("テンプレートの host は許可済みでも、build() が実際には別ホストを返せば拒否する（二重の関所）", () => {
    const smuggled = verifiedTemplate({ build: () => "https://evil.example.com/x" });
    expect(buildReceivingLink("paypay_p2p", "abc123", [smuggled])).toBeNull();
  });

  it("サブドメイン（allowedhost.evil.example / evil.example.allowedhost）は完全一致でないので拒否", () => {
    for (const host of [`${ALLOWED_HOST}.evil.example`, `evil.${ALLOWED_HOST}`]) {
      const spoofed = verifiedTemplate({ build: () => `https://${host}/x` });
      expect(buildReceivingLink("paypay_p2p", "abc123", [spoofed])).toBeNull();
    }
  });
});

describe("https 以外・userinfo・query・fragment を持つ URL は拒否する", () => {
  it("http は拒否", () => {
    const insecure = verifiedTemplate({ build: (id) => `http://${ALLOWED_HOST}/${id}` });
    expect(buildReceivingLink("paypay_p2p", "abc123", [insecure])).toBeNull();
  });

  it("userinfo（user:pass@host。ブラウザ差でホスト誤認の原因になりうる）は拒否", () => {
    const withUserinfo = verifiedTemplate({
      build: (id) => `https://attacker:pw@${ALLOWED_HOST}/${id}`,
    });
    expect(buildReceivingLink("paypay_p2p", "abc123", [withUserinfo])).toBeNull();
  });

  it("クエリ・フラグメントを持ち込む識別子（?/# を混入）は拒否", () => {
    const withQuery = verifiedTemplate({ build: (id) => `https://${ALLOWED_HOST}/${id}?next=evil` });
    expect(buildReceivingLink("paypay_p2p", "abc123", [withQuery])).toBeNull();

    const withFragment = verifiedTemplate({ build: (id) => `https://${ALLOWED_HOST}/${id}#evil` });
    expect(buildReceivingLink("paypay_p2p", "abc123", [withFragment])).toBeNull();
  });

  it("build() が URL として不正な文字列を返しても例外を投げず null（fail-closed）", () => {
    const broken = verifiedTemplate({ build: () => "not a url" });
    expect(buildReceivingLink("paypay_p2p", "abc123", [broken])).toBeNull();
  });
});

describe("識別子の書式検査（DB の CHECK より狭い正規表現）", () => {
  it("識別子にパス区切り・コロン・スペースが混じると、テンプレートの正規表現で落ちる", () => {
    const template = verifiedTemplate();
    for (const identifier of ["../etc/passwd", "a/b", "a:b", "a b", ""]) {
      expect(buildReceivingLink("paypay_p2p", identifier, [template])).toBeNull();
    }
  });

  it("識別子が null または空文字なら、テンプレートを見るまでもなく null", () => {
    expect(buildReceivingLink("paypay_p2p", null)).toBeNull();
    expect(buildReceivingLink("paypay_p2p", "")).toBeNull();
  });

  it("正しい書式・許可ホスト・https・余計な要素なしなら組み立てられる（防御が過剰でないことの確認）", () => {
    const template = verifiedTemplate();
    const built = buildReceivingLink("paypay_p2p", "valid-id_123", [template]);
    expect(built).toEqual({ url: `https://${ALLOWED_HOST}/valid-id_123`, host: ALLOWED_HOST });
  });
});

describe("チャネルが一致しないテンプレートは使われない", () => {
  it("要求したチャネルに一致するテンプレートが無ければ null", () => {
    const bankOnly = verifiedTemplate({ channel: "bank_transfer" });
    expect(buildReceivingLink("paypay_p2p", "abc123", [bankOnly])).toBeNull();
  });
});
