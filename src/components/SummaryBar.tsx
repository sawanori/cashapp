/**
 * 名簿サマリ（O-4 上部）。「非自動ラベルの 8 層」の④サマリ内訳（§7-6）。
 *
 * ★ 合算値**だけ**を表示しない（check_034）。「支払済み 2/4（自動 1 / 手動 1）」のように、
 *   内訳（自動 n / 手動 m）を必ず並記する。手数料・受取見込額の並記も同じ理由
 *   （§8-1 O-4「手数料と受取見込額を並記」）。
 *
 * ★ `confirmationMethod` が `mixed` の状態は「非自動ラベルの 8 層」⑧の表示規約に従い、
 *   単独カウントせず自動・手動の内訳にそれぞれ数えない（別枠で明示する）。
 */

import type { ReactNode } from "react";

export interface SummaryBarProps {
  readonly participantCount: number;
  readonly paidAutomaticCount: number;
  readonly paidManualCount: number;
  /** `confirmationMethod === 'mixed'` の請求数。0 のときは表示しない。 */
  readonly mixedCount?: number;
  readonly unpaidCount: number;
  /**
   * 参加者の自己申告（`payment_self_report`）待ちで、幹事の確認前の件数。
   * check_034: 支払済みと同じ見た目にせず「幹事確認待ち」として別枠に出す
   * （「非自動ラベルの 8 層」⑦。自己申告の実データ経路は task_015 の scope）。0 なら表示しない。
   */
  readonly selfReportedCount?: number;
  readonly needsAttentionCount: number;
  readonly feeMinorEstimate: number | null;
  readonly netMinorEstimate: number | null;
}

function formatYen(amountMinor: number | null): string {
  if (amountMinor === null) return "未定";
  return `¥${amountMinor.toLocaleString("ja-JP")}`;
}

export function SummaryBar({
  participantCount,
  paidAutomaticCount,
  paidManualCount,
  mixedCount = 0,
  unpaidCount,
  selfReportedCount = 0,
  needsAttentionCount,
  feeMinorEstimate,
  netMinorEstimate,
}: SummaryBarProps): ReactNode {
  const paidCount = paidAutomaticCount + paidManualCount + mixedCount;

  return (
    <section className="summary-bar" aria-label="集金サマリ">
      <p className="summary-bar__headline tabular">
        支払済み {paidCount}/{participantCount}
        <span className="summary-bar__breakdown">
          （自動 {paidAutomaticCount} / 手動 {paidManualCount}
          {mixedCount > 0 ? ` / 混在 ${mixedCount}` : ""}）
        </span>
      </p>
      <p className="summary-bar__row tabular">未払い {unpaidCount}</p>
      {selfReportedCount > 0 ? (
        <p className="summary-bar__row tabular">幹事確認待ち {selfReportedCount}</p>
      ) : null}
      {needsAttentionCount > 0 ? (
        <p className="summary-bar__attention" role="status">
          要対応 {needsAttentionCount} 件
        </p>
      ) : null}
      <p className="summary-bar__row tabular">
        手数料（推定）: {feeMinorEstimate === null ? "未定" : formatYen(feeMinorEstimate)}
      </p>
      <p className="summary-bar__row tabular">
        受取見込額（推定）: {netMinorEstimate === null ? "未定" : formatYen(netMinorEstimate)}
      </p>
      {paidAutomaticCount === 0 && mixedCount === 0 && paidManualCount > 0 ? (
        // 「非自動ラベルの 8 層」④⑤（task_017）。内訳の数字だけだと「自動 0」が読み飛ばされ、
        // 支払済みの件数が自動検知の結果に見える。Phase 1 の出荷アダプタは manual_confirm
        // だけなので、この行は通常のイベントでは常に出る。
        // G5 round1 GPT F-5 是正: `mixedCount > 0`（自動と手動が混ざった請求がある）ときは
        // 「すべて手動確認」が嘘になるので出さない（⑧ の mixed 表示規約と矛盾させない）。
        <p className="summary-bar__manual-note">
          支払済みはすべて幹事が手動で確認したものです（自動照合ではありません）。
        </p>
      ) : null}
    </section>
  );
}

export default SummaryBar;
