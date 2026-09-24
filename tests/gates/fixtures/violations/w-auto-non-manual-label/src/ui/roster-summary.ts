// 違反フィクスチャ（W-AUTO）。手動確認しかできない段階で自動確認を断定している UI 文言。

export const paidRowLabel = "入金を確認しました";

export function summaryLine(paid: number, total: number): string {
  return `${paidRowLabel}（${String(paid)}/${String(total)}）`;
}
