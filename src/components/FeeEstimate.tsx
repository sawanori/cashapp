"use client";

/**
 * 手数料提示＋同意ゲート（O-3 / task_014 scope / check_080）。
 *
 * ★ O-3（イベント作成）の時点では参加者数が確定していないため、集金総額・手数料概算・
 *   受取見込額・入金予定時期は**すべて推定**として表示する（確定値は出さない）。
 *   `docs/wording-policy.md` の `W-FEE-FIXED`（未確定手数料の確定表示）を避けるため、
 *   「手数料」の近くに具体的な率・金額・「無料」等の断定表現を置かない
 *   （`src/lib/payments/capabilities-static.ts` の `feeNote` も同方針）。
 *
 * ★ 同意チェックが入るまで送信できない（`ConsentGate` と同じ「まとめない」方針は取らない
 *   ——ここは単一の同意項目のため 1 個のチェックボックスで足りる）。
 */

import { useState, type ReactNode } from "react";

import { estimateFeeForEvent } from "@/lib/payments/capabilities-static";

export interface FeeEstimateProps {
  readonly providerKey: string;
  /** イベントの既定金額（1 人あたり）。未入力なら `null`。 */
  readonly defaultAmountMinor: number | null;
  /** 参加者数の見込み。O-3 では通常 `null`（未定）。 */
  readonly participantCountEstimate?: number | null;
  /** 同意チェックが入り、送信操作が呼べる状態になったときに呼ばれる。 */
  readonly onConfirm: () => void;
  readonly submitting?: boolean;
  readonly submitLabel?: string;
}

function formatYen(amountMinor: number | null): string {
  if (amountMinor === null) return "未定";
  return `¥${amountMinor.toLocaleString("ja-JP")}`;
}

export function FeeEstimate({
  providerKey,
  defaultAmountMinor,
  participantCountEstimate = null,
  onConfirm,
  submitting = false,
  submitLabel = "この内容でイベントを作成する",
}: FeeEstimateProps): ReactNode {
  const [accepted, setAccepted] = useState(false);

  const estimate = estimateFeeForEvent({
    providerKey,
    defaultAmountMinor,
    participantCountEstimate,
  });

  const disabled = !accepted || submitting;

  return (
    <section className="fee-estimate" aria-labelledby="fee-estimate-heading">
      <h3 id="fee-estimate-heading">集金内容の見込み（推定）</h3>

      <dl className="fee-estimate__list">
        <div className="fee-estimate__item">
          <dt>集金総額（推定）</dt>
          <dd className="tabular">{formatYen(estimate.totalMinor)}</dd>
        </div>
        <div className="fee-estimate__item">
          <dt>手数料（推定）</dt>
          <dd>{estimate.feeNote}</dd>
        </div>
        <div className="fee-estimate__item">
          <dt>受取見込額（推定）</dt>
          <dd className="tabular">{formatYen(estimate.netMinorEstimate)}</dd>
        </div>
        <div className="fee-estimate__item">
          <dt>入金予定時期（推定）</dt>
          <dd>{estimate.settlementEta}</dd>
        </div>
      </dl>

      <p className="fee-estimate__disclaimer">
        表示している数値・時期はすべて概算であり、参加者数の確定や決済手段の設定によって変わります。
      </p>

      <div className="fee-estimate__consent">
        <input
          type="checkbox"
          id="fee-estimate-accept"
          checked={accepted}
          onChange={(event) => {
            setAccepted(event.target.checked);
          }}
        />
        <label htmlFor="fee-estimate-accept">
          上記の見込み（推定）を確認し、同意します。
        </label>
      </div>

      <button
        type="button"
        className="fee-estimate__submit tap-target"
        disabled={disabled}
        aria-busy={submitting}
        onClick={() => {
          if (!disabled) onConfirm();
        }}
      >
        {submitLabel}
      </button>
    </section>
  );
}

export default FeeEstimate;
