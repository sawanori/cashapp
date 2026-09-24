/**
 * 配布導線（O-7）の文言・Flex テンプレ・QR 生成（§8-1 / §7-3 / N8 / task_016）。
 *
 * ★ 純粋関数のみを置く。LIFF SDK にも React にも依存しない
 *   （`src/lib/liff/share.ts` が picker 呼び出し、`src/components/ShareSheet.tsx` が描画を持つ）。
 *
 * ★ リンクの組み立ては既存の慣習をそのまま使う。招待トークンは**発行応答の 1 度しか**
 *   手に入らない（`docs/concerns/task_015.md` C-015-2）ので、この画面のリンクは
 *   `POST /api/events/:id/rotate-join-token` で作り直した直後の値を呼び出し側が渡す。
 *   組み立て先は `src/app/(liff)/e/me/page.tsx` の「自分に送る」と同じ形
 *   （`${permanentLink}/e?t=${joinToken}`）に揃える。
 *
 * ★ 参加者ごとの「個別リンク」は、claim トークン単位のリンクではない。claim トークンは
 *   参加者登録応答でのみ返り、ここでは再取得できない（同じ C-015-2 の制約）。したがって
 *   ここでの「個別」は **同じ招待リンク＋宛名入りの催促文** を指す。参加者は開いた後、
 *   名簿から自分を選ぶ（P-2 の名簿選択）。
 *
 * ★ `docs/wording-policy.md` の禁止語を使わない。固定文言
 *   「支払先は幹事の決済アカウントで、アプリはお金を預かりません」は O-7 の仕様どおり
 *   一字一句変えない（`PAYMENT_DISCLAIMER_TEXT`）。
 */

import QRCode from "qrcode";

// ============================================================================
// 表示整形（既存画面と同じ書式に揃える）
// ============================================================================

/** `src/app/(liff)/events/[id]/invoices/page.tsx` の `formatYen` と同じ書式。 */
export function formatYenAmount(amountMinor: number | null): string {
  if (amountMinor === null) return "未設定";
  return `¥${amountMinor.toLocaleString("ja-JP")}`;
}

/** `src/app/(liff)/e/page.tsx` の `formatDate` と同じ書式。 */
export function formatDeadline(collectByAtIso: string | null): string {
  if (collectByAtIso === null) return "未設定";
  const date = new Date(collectByAtIso);
  if (Number.isNaN(date.getTime())) return "未設定";
  return date.toLocaleDateString("ja-JP");
}

// ============================================================================
// リンク
// ============================================================================

/**
 * 招待リンクを組み立てる。`permanentLinkBase` は `liffPermanentLink(liffId)` の値
 * （`https://liff.line.me/{liffId}`）。`src/app/(liff)/e/me/page.tsx` と同じ形。
 */
export function buildJoinLink(permanentLinkBase: string, joinToken: string): string {
  return `${permanentLinkBase}/e?t=${encodeURIComponent(joinToken)}`;
}

// ============================================================================
// 催促文（主導線: クリップボードコピー）
// ============================================================================

export interface ShareEventInfo {
  readonly organizerLabel: string;
  readonly eventTitle: string;
  readonly collectByAt: string | null;
}

export interface ReminderTextParams {
  readonly event: ShareEventInfo;
  readonly link: string;
  /** 金額。参加者ごとに請求額が違う場合は呼び出し側がその参加者の額を渡す。 */
  readonly amountMinor: number | null;
  /** 個別に再共有するときの宛名。省略すると全体向けの文面になる。 */
  readonly participantLabel?: string | null;
}

/** 催促文＋URL（主導線）。コピーしてそのまま LINE のトークへ貼れる形。 */
export function buildReminderText(params: ReminderTextParams): string {
  const { event, link, amountMinor, participantLabel } = params;
  const greeting =
    participantLabel === undefined || participantLabel === null || participantLabel.trim().length === 0
      ? ""
      : `${participantLabel}さん\n\n`;
  return (
    `${greeting}${event.eventTitle} の集金のお願いです。\n` +
    `金額: ${formatYenAmount(amountMinor)}\n` +
    `支払期限: ${formatDeadline(event.collectByAt)}\n` +
    `お支払いはこちらから: ${link}\n` +
    `支払先は幹事（${event.organizerLabel}）の決済アカウントです。アプリはお金を預かりません。`
  );
}

// ============================================================================
// リンクを疑われた際の説明テンプレ
// ============================================================================

/** リンクの真正性を疑われたとき、幹事がそのままコピーして送れる説明文。 */
export function buildExplanationText(organizerLabel: string, link: string): string {
  return (
    `このリンクは会費集金アプリ「cashapp」の招待リンクです。\n` +
    `送り主は幹事の${organizerLabel}さんで、支払先も${organizerLabel}さんの決済アカウントです。` +
    `アプリの運営者はお金を預かりません。\n` +
    `不審な場合は、このリンクを送った本人（${organizerLabel}さん）に LINE のトークで直接ご確認ください。\n` +
    `リンク: ${link}`
  );
}

// ============================================================================
// Flex テンプレ（固定 5 要素。shareTargetPicker の補助導線でのみ使う）
// ============================================================================

/** O-7 で固定と定めた 5 番目の要素（一字一句変えない）。 */
export const PAYMENT_DISCLAIMER_TEXT = "支払先は幹事の決済アカウントで、アプリはお金を預かりません";

export interface FlexTextContent {
  readonly type: "text";
  readonly text: string;
  readonly weight?: "bold" | "regular";
  readonly size?: "sm" | "md" | "lg" | "xl";
  readonly wrap?: boolean;
  readonly margin?: "sm" | "md";
}

export interface FlexSeparator {
  readonly type: "separator";
}

export interface FlexButtonContent {
  readonly type: "button";
  readonly style: "primary";
  readonly action: {
    readonly type: "uri";
    readonly label: string;
    readonly uri: string;
  };
}

/**
 * 固定レイアウトの Flex バブル。`body.contents` の先頭 5 要素が O-7 の仕様どおり
 * 「幹事ラベル／イベント名／金額／締切／固定文言」の順で並ぶ（`share-templates.test.ts`
 * が数と内容を固定する）。**参加者名は受け取らない**（Flex に参加者名を含めない、O-7 の scope）。
 */
export interface FlexShareBubble {
  readonly type: "bubble";
  readonly body: {
    readonly type: "box";
    readonly layout: "vertical";
    readonly contents: readonly FlexTextContent[];
  };
  readonly footer: {
    readonly type: "box";
    readonly layout: "vertical";
    readonly contents: readonly [FlexButtonContent];
  };
}

export interface FlexShareMessage {
  readonly type: "flex";
  readonly altText: string;
  readonly contents: FlexShareBubble;
}

export interface FlexShareTemplateParams {
  readonly event: ShareEventInfo;
  readonly amountMinor: number | null;
  readonly link: string;
}

export function buildFlexShareMessage(params: FlexShareTemplateParams): FlexShareMessage {
  const { event, amountMinor, link } = params;

  const bubble: FlexShareBubble = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        // 1. 幹事ラベル
        { type: "text", text: `幹事: ${event.organizerLabel}`, size: "sm" },
        // 2. イベント名
        { type: "text", text: event.eventTitle, weight: "bold", size: "lg", wrap: true },
        // 3. 金額
        { type: "text", text: `金額: ${formatYenAmount(amountMinor)}`, margin: "md" },
        // 4. 締切
        { type: "text", text: `支払期限: ${formatDeadline(event.collectByAt)}` },
        // 5. 固定文言（一字一句変えない）
        { type: "text", text: PAYMENT_DISCLAIMER_TEXT, size: "sm", wrap: true, margin: "md" },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button",
          style: "primary",
          action: { type: "uri", label: "リンクを開く", uri: link },
        },
      ],
    },
  };

  return {
    type: "flex",
    altText: `${event.eventTitle} の集金のお願い`,
    contents: bubble,
  };
}

// ============================================================================
// QR（別端末用。同じ端末では読み取れない）
// ============================================================================

/**
 * 招待リンクの QR を SVG 文字列として生成する。
 *
 * ★ SVG を選ぶ理由: `toDataURL`（PNG）はブラウザで `<canvas>` を要求するが、
 *   SVG 生成は文字列処理だけで完結し、テスト環境（jsdom / Node）でも同じコードパスで動く。
 */
export async function buildJoinLinkQrSvg(link: string): Promise<string> {
  return QRCode.toString(link, { type: "svg", margin: 1, width: 200 });
}
