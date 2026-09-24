/**
 * 名簿の 1 行（O-4）。「非自動ラベルの 8 層」の②幹事画面のバッジ（§7-6）そのもの。
 *
 * ★ `autoDetected` / `confirmationMethod` は**必須 props**にする（型をオプショナルにしない）。
 *   `docs/constraints.json` の P9 は、この 2 つの props 宣言がオプショナル型になっていないかを
 *   本ディレクトリ配下の TSX ファイルから grep で検出し、見つかれば落とす（型のゆるみが
 *   「自動検知したかのような表示」に化けるのを防ぐ）。
 *
 * ★ 状態は色＋テキスト＋アイコンの三重表現（R-UX-04 / §8-3）。色は補助であり、
 *   意味はアイコンの形と日本語ラベルが運ぶ。
 *
 * ★ `autoDetected === false` の行には**常に**「非自動」バッジを出す（`status` を問わない）。
 *   check_031: 消すとスナップショットテストが落ちる。
 *
 * ★ docs/wording-policy.md の禁止語規則を守る（許可文言は「自動照合ではありません」のみ）。
 */

import type { ReactNode } from "react";

export type RosterStatus =
  | "unpaid"
  | "pending_checkout"
  /** 参加者が「幹事が受け取ったと申告」した状態。**支払済みと同じ見た目にしない**（R-UX-02）。 */
  | "self_reported"
  | "paid"
  | "canceled";
export type ConfirmationMethod = "automatic" | "manual_by_organizer" | "mixed";

export interface InvoiceRowProps {
  readonly displayLabel: string | null;
  readonly amountMinor: number | null;
  readonly status: RosterStatus;
  readonly autoDetected: boolean;
  readonly confirmationMethod: ConfirmationMethod | null;
  readonly needsAttention?: boolean;
}

interface StatusSpec {
  readonly tone: "neutral" | "info" | "success" | "warning";
  readonly label: string;
  readonly icon: ReactNode;
}

function Dot({ className }: { readonly className: string }): ReactNode {
  return (
    <svg
      className={`invoice-row__icon ${className}`}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

const ICON_UNPAID = (
  <svg
    className="invoice-row__icon"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    aria-hidden="true"
    focusable="false"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
  </svg>
);
const ICON_PENDING = (
  <svg
    className="invoice-row__icon"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    aria-hidden="true"
    focusable="false"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" strokeOpacity="0.4" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const ICON_PAID = (
  <svg
    className="invoice-row__icon"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    aria-hidden="true"
    focusable="false"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 12.5l4.5 4.5L19 7" />
  </svg>
);
const ICON_CANCELED = (
  <svg
    className="invoice-row__icon"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    aria-hidden="true"
    focusable="false"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const ICON_SELF_REPORTED = (
  <svg
    className="invoice-row__icon"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    aria-hidden="true"
    focusable="false"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 3l9 16H3z" />
    <path d="M12 9v4" />
    <path d="M12 16.5h.01" />
  </svg>
);

const STATUS_SPECS: Readonly<Record<RosterStatus, StatusSpec>> = {
  unpaid: { tone: "neutral", label: "未払い", icon: ICON_UNPAID },
  pending_checkout: { tone: "info", label: "手続き中（確定前・催促は送れません）", icon: ICON_PENDING },
  // ★ tone も label もアイコンも `paid` と重ねない（R-UX-02 / check_087）。
  self_reported: { tone: "warning", label: "申告済み（幹事の確認待ち）", icon: ICON_SELF_REPORTED },
  paid: { tone: "success", label: "支払済み", icon: ICON_PAID },
  canceled: { tone: "neutral", label: "取消", icon: ICON_CANCELED },
};

/** `confirmationMethod` を、禁止語（自動確認の断定）を避けた日本語に変換する。 */
function confirmationSuffix(method: ConfirmationMethod | null): string | null {
  if (method === "automatic") return "自動";
  if (method === "manual_by_organizer") return "手動確認・自動照合ではありません";
  if (method === "mixed") return "自動・手動が混在";
  return null;
}

function formatYen(amountMinor: number | null): string {
  if (amountMinor === null) return "金額未設定";
  return `¥${amountMinor.toLocaleString("ja-JP")}`;
}

export function InvoiceRow({
  displayLabel,
  amountMinor,
  status,
  autoDetected,
  confirmationMethod,
  needsAttention = false,
}: InvoiceRowProps): ReactNode {
  const spec = STATUS_SPECS[status];
  const suffix = status === "paid" ? confirmationSuffix(confirmationMethod) : null;
  const statusLabel = suffix === null ? spec.label : `${spec.label}（${suffix}）`;

  return (
    <li className="invoice-row" data-tone={spec.tone} data-status={status}>
      <span className="invoice-row__label tabular">{displayLabel ?? "（表示名未設定）"}</span>
      <span className="invoice-row__amount tabular">{formatYen(amountMinor)}</span>
      <span className="invoice-row__status">
        {spec.icon}
        <span className="invoice-row__status-text">{statusLabel}</span>
      </span>
      {autoDetected ? null : (
        <span className="invoice-row__badge" data-testid="non-auto-badge">
          <Dot className="invoice-row__badge-dot" />
          手動確認（自動照合ではありません）
        </span>
      )}
      {needsAttention ? (
        <span className="invoice-row__attention" role="status">
          要対応
        </span>
      ) : null}
    </li>
  );
}

// ============================================================================
// P-3: 参加者が見る「自分の請求」の状態（§8-2 / check_087 / task_015）
// ============================================================================

/**
 * 参加者側の状態。サーバー（`src/lib/db/repositories/claims.ts` の
 * `ParticipantInvoiceState`）と同じ集合を、UI 側の語彙として再宣言している
 * （クライアントコンポーネントから `@/lib/db/**` を import できないため。制約 I3）。
 * 値がずれていないことは `tests/unit/components/ParticipantStatus.test.tsx` が検査する。
 */
export type ParticipantViewState =
  | "awaiting_approval"
  | "not_issued"
  | "unpaid"
  | "pending_checkout"
  | "self_reported"
  | "paid"
  | "expired"
  | "voided";

interface ParticipantStateSpec {
  readonly tone: "neutral" | "info" | "success" | "warning";
  readonly title: string;
  readonly body: string;
  readonly icon: ReactNode;
}

/**
 * ★ `self_reported` と `paid` は **tone・タイトル・本文・アイコンのすべてが違う**。
 *   申告は「幹事が受け取ったと申告」された記録であって入金の確定ではない（R-UX-02）。
 */
const PARTICIPANT_STATE_SPECS: Readonly<Record<ParticipantViewState, ParticipantStateSpec>> = {
  awaiting_approval: {
    tone: "info",
    title: "幹事の確認待ち",
    body: "名簿への追加を幹事が確認しています。確認されるまでお待ちください。",
    icon: ICON_PENDING,
  },
  not_issued: {
    tone: "neutral",
    title: "請求の発行待ち",
    body: "まだ請求が発行されていません。幹事の発行をお待ちください。",
    icon: ICON_UNPAID,
  },
  unpaid: {
    tone: "neutral",
    title: "未払い",
    body: "お支払いをお願いします。",
    icon: ICON_UNPAID,
  },
  pending_checkout: {
    tone: "info",
    title: "手続き中（確定前）",
    body: "お手続きの結果を確認しています。確定まで少しお待ちください。",
    icon: ICON_PENDING,
  },
  self_reported: {
    tone: "warning",
    title: "申告済み（幹事の確認待ち）",
    body: "あなたの申告を幹事が確認中です（アプリは入金を検知していません）。",
    icon: ICON_SELF_REPORTED,
  },
  paid: {
    tone: "success",
    title: "支払済み",
    body: "お支払いが記録されています。",
    icon: ICON_PAID,
  },
  expired: {
    tone: "warning",
    title: "期限切れ",
    body: "お支払いの期限を過ぎています。幹事にご連絡ください。",
    icon: ICON_CANCELED,
  },
  voided: {
    tone: "neutral",
    title: "取消済み",
    body: "この請求は取り消されました。",
    icon: ICON_CANCELED,
  },
};

export interface ParticipantStatusProps {
  readonly state: ParticipantViewState;
  readonly amountMinor: number | null;
  /** ★ オプショナルにしない（制約 P9）。 */
  readonly autoDetected: boolean;
  /** ★ オプショナルにしない（制約 P9）。 */
  readonly confirmationMethod: ConfirmationMethod | null;
}

/** P-3 の状態表示。色＋テキスト＋アイコンの三重表現（§8-3 / R-UX-04）。 */
export function ParticipantStatus({
  state,
  amountMinor,
  autoDetected,
  confirmationMethod,
}: ParticipantStatusProps): ReactNode {
  const spec = PARTICIPANT_STATE_SPECS[state];
  const suffix = state === "paid" ? confirmationSuffix(confirmationMethod) : null;

  return (
    <section className="participant-status" data-tone={spec.tone} data-state={state}>
      <p className="participant-status__amount tabular">{formatYen(amountMinor)}</p>
      <p className="participant-status__state">
        {spec.icon}
        <span className="participant-status__state-text">
          {suffix === null ? spec.title : `${spec.title}（${suffix}）`}
        </span>
      </p>
      <p className="participant-status__body">{spec.body}</p>
      {autoDetected ? null : (
        <p className="participant-status__badge" data-testid="participant-non-auto-badge">
          幹事が手動で確認します（自動照合ではありません）。
        </p>
      )}
    </section>
  );
}

export default InvoiceRow;
