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

export type RosterStatus = "unpaid" | "pending_checkout" | "paid" | "canceled";
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

const STATUS_SPECS: Readonly<Record<RosterStatus, StatusSpec>> = {
  unpaid: { tone: "neutral", label: "未払い", icon: ICON_UNPAID },
  pending_checkout: { tone: "info", label: "手続き中（確定前・催促は送れません）", icon: ICON_PENDING },
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

export default InvoiceRow;
