/**
 * `src/lib/payments/providers/manual-confirm.ts`（§7-6 / check_091 / check_026 / check_011）。
 *
 * done_definition / scope:
 *   - 幹事が任意 URL を登録しようとしても受け付けない（識別子しか受け取らない）
 *   - リンクはサーバー側テンプレートから組み立てられ、許可外ホストは拒否される
 *   - `autoDetect: false` / `payerIdentity: false` / `refund: 'none'`
 *   - `getPaymentStatus` / `refund` は `NotSupportedError`、`parseWebhook` は常に空
 */

import { describe, expect, it } from "vitest";

import {
  ALLOWED_DEEPLINK_HOSTS,
  MANUAL_CONFIRM_CAPABILITIES,
  RECEIVING_LINK_TEMPLATES,
  activeReceivingLinkTemplates,
  buildReceivingLink,
  createManualConfirmProvider,
  manualConfirmProvider,
  manualInstructionFor,
  type ReceivingLinkTemplate,
} from "@/lib/payments/providers/manual-confirm";
import { yen } from "@/lib/payments/money";
import {
  MANUAL_CONFIRM_DISCLAIMER,
  NotSupportedError,
  type CreateCheckoutCommand,
  type ProviderBinding,
} from "@/lib/payments/types";

function binding(overrides: Partial<ProviderBinding> = {}): ProviderBinding {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organizerUserId: "22222222-2222-4222-8222-222222222222",
    providerKey: "manual_confirm",
    status: "active",
    credentialRef: null,
    credentialFp: null,
    receivingIdentifier: "organizer-handle",
    receivingIdentifierKind: "merchant_id",
    ...overrides,
  };
}

function command(overrides: Partial<CreateCheckoutCommand> = {}): CreateCheckoutCommand {
  return {
    invoiceId: "33333333-3333-4333-8333-333333333333",
    externalRef: "iv_33333333333343338333333333333333_1",
    money: yen(3000),
    description: "会費",
    returnUrl: "https://liff.line.me/1234567890-abcdefgh/e/return?invoice=x",
    expiresAt: null,
    timeoutMs: 3000,
    ...overrides,
  };
}

/** 一次資料で確認済みのテンプレート（テスト用）。許可ホストに載っているものを使う。 */
const VERIFIED_TEMPLATE: ReceivingLinkTemplate = {
  channel: "paypay_p2p",
  host: "qr.paypay.ne.jp",
  identifierPattern: /^[A-Za-z0-9_-]{1,64}$/,
  build: (identifier) => `https://qr.paypay.ne.jp/${identifier}`,
  verified: true,
  sourceRef: "tests/unit/payments/manual-confirm.test.ts（テスト用の検証済み扱い）",
};

describe("能力宣言", () => {
  it("autoDetect は false（非自動ラベルの起点）", () => {
    expect(MANUAL_CONFIRM_CAPABILITIES.autoDetect).toBe(false);
  });

  it("payerIdentity は false 固定（制約 P9）", () => {
    expect(MANUAL_CONFIRM_CAPABILITIES.payerIdentity).toBe(false);
  });

  it("refund は none / statusQuery は false / webhook は無し", () => {
    expect(MANUAL_CONFIRM_CAPABILITIES.refund).toBe("none");
    expect(MANUAL_CONFIRM_CAPABILITIES.statusQuery).toBe(false);
    expect(MANUAL_CONFIRM_CAPABILITIES.webhook).toBe(false);
    expect(MANUAL_CONFIRM_CAPABILITIES.webhookSignature).toBe("none");
  });

  it("資格情報を預からない（credentialCustody は organizer）", () => {
    expect(MANUAL_CONFIRM_CAPABILITIES.credentialCustody).toBe("organizer");
  });

  it("手数料の文言に率・金額を書かない（W-FEE-FIXED）", () => {
    expect(MANUAL_CONFIRM_CAPABILITIES.feeModel.rateBp).toBeNull();
    expect(MANUAL_CONFIRM_CAPABILITIES.feeModel.fixedMinor).toBeNull();
    expect(MANUAL_CONFIRM_CAPABILITIES.feeModel.note).not.toMatch(/[0-9０-９]+\s*[%％]/);
  });
});

describe("受取リンク: 任意 URL を受け付けない（check_091）", () => {
  it("識別子に URL を入れてもテンプレートの書式検査で落ちる", () => {
    for (const evil of [
      "https://evil.example.com/steal",
      "http://qr.paypay.ne.jp/x",
      "qr.paypay.ne.jp/x",
      "a/b",
      "a:b",
      "javascript:alert(1)",
      "",
    ]) {
      expect(buildReceivingLink("paypay_p2p", evil, [VERIFIED_TEMPLATE])).toBeNull();
    }
  });

  it("許可ホスト外を返すテンプレートは、テンプレート側が verified でも拒否される", () => {
    const rogue: ReceivingLinkTemplate = {
      ...VERIFIED_TEMPLATE,
      host: "evil.example.com",
      build: (identifier) => `https://evil.example.com/${identifier}`,
    };
    expect(ALLOWED_DEEPLINK_HOSTS).not.toContain("evil.example.com");
    expect(activeReceivingLinkTemplates([rogue])).toHaveLength(0);
    expect(buildReceivingLink("paypay_p2p", "organizer-handle", [rogue])).toBeNull();
  });

  it("host は許可されていても build が別ホストを返すなら拒否する（二重の関所）", () => {
    const inconsistent: ReceivingLinkTemplate = {
      ...VERIFIED_TEMPLATE,
      build: () => "https://evil.example.com/x",
    };
    expect(buildReceivingLink("paypay_p2p", "organizer-handle", [inconsistent])).toBeNull();
  });

  it("https 以外は拒否する", () => {
    const insecure: ReceivingLinkTemplate = {
      ...VERIFIED_TEMPLATE,
      build: (identifier) => `http://qr.paypay.ne.jp/${identifier}`,
    };
    expect(buildReceivingLink("paypay_p2p", "organizer-handle", [insecure])).toBeNull();
  });

  it("検証済みテンプレートと正しい識別子ならリンクとホスト名が揃う", () => {
    const link = buildReceivingLink("paypay_p2p", "organizer-handle", [VERIFIED_TEMPLATE]);
    expect(link).not.toBeNull();
    expect(link?.url).toBe("https://qr.paypay.ne.jp/organizer-handle");
    expect(link?.host).toBe("qr.paypay.ne.jp");
  });

  it("既定のテンプレート表は未検証なのでリンクを出さない（推測 URL を踏ませない）", () => {
    expect(activeReceivingLinkTemplates()).toHaveLength(0);
    expect(RECEIVING_LINK_TEMPLATES.every((template) => !template.verified)).toBe(true);
    expect(buildReceivingLink("paypay_p2p", "organizer-handle")).toBeNull();
  });
});

describe("createCheckout: 決済を作らない手動案内", () => {
  it("kind は manual で automatic は false、disclaimer はリテラル固定", async () => {
    const ticket = await manualConfirmProvider.createCheckout(binding(), command());
    expect(ticket.kind).toBe("manual");
    if (ticket.kind !== "manual") throw new Error("unreachable");
    expect(ticket.instruction.automatic).toBe(false);
    expect(ticket.instruction.disclaimer).toBe(MANUAL_CONFIRM_DISCLAIMER);
    expect(ticket.externalRef).toBe(command().externalRef);
  });

  it("未検証テンプレートでは deepLink が null で、案内は幹事への確認に倒れる", async () => {
    const ticket = await manualConfirmProvider.createCheckout(binding(), command());
    if (ticket.kind !== "manual") throw new Error("unreachable");
    expect(ticket.instruction.deepLink).toBeNull();
    expect(ticket.instruction.deepLinkHost).toBeNull();
    expect(ticket.instruction.note).toContain("幹事");
  });

  it("検証済みテンプレートを渡すと deepLinkHost が案内に載る（P-5 の併記の材料）", async () => {
    const provider = createManualConfirmProvider({ templates: [VERIFIED_TEMPLATE] });
    const ticket = await provider.createCheckout(binding(), command());
    if (ticket.kind !== "manual") throw new Error("unreachable");
    expect(ticket.instruction.deepLinkHost).toBe("qr.paypay.ne.jp");
    expect(ticket.instruction.note).toContain("qr.paypay.ne.jp");
  });

  it("別の事業者の binding では作らない", async () => {
    await expect(
      manualConfirmProvider.createCheckout(binding({ providerKey: "paypay_online" }), command()),
    ).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("externalRef の書式が不正なら作らない", async () => {
    await expect(
      manualConfirmProvider.createCheckout(binding(), command({ externalRef: "iv/../x" })),
    ).rejects.toBeInstanceOf(NotSupportedError);
  });
});

describe("能力宣言どおりに落ちる（check_011 / check_026）", () => {
  it("getPaymentStatus は NotSupportedError", async () => {
    await expect(
      manualConfirmProvider.getPaymentStatus(binding(), "iv_x_1"),
    ).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("refund は NotSupportedError", async () => {
    await expect(manualConfirmProvider.refund(binding(), "iv_x_1")).rejects.toBeInstanceOf(
      NotSupportedError,
    );
  });

  it("parseWebhook は常に空（受信経路を持たない）", async () => {
    const events = await manualConfirmProvider.parseWebhook(
      binding(),
      "{}",
      new Headers(),
      ["secret"],
    );
    expect(events).toEqual([]);
  });

  it("cancelCheckout は例外にせず何もしない（中止処理を止めない）", async () => {
    await expect(manualConfirmProvider.cancelCheckout(binding(), "iv_x_1")).resolves.toBeUndefined();
  });
});

describe("manualInstructionFor: 参加者画面用", () => {
  it("現金は deepLink を持たず、幹事に直接渡す案内になる", () => {
    const instruction = manualInstructionFor("cash", binding(), [VERIFIED_TEMPLATE]);
    expect(instruction.deepLink).toBeNull();
    expect(instruction.channel).toBe("cash");
    expect(instruction.automatic).toBe(false);
  });
});
