"use client";

/**
 * O-7 配布（§8-1 / N8 / N9 / R-LINE-06 / task_016）。
 *
 * ★ 主導線は**催促文＋URL のクリップボードコピー**（N8）。`shareTargetPicker` は
 *   `isApiAvailable` が `true` のときだけ出す補助で、**それが無くても全機能が成立する**
 *   ことがこのコンポーネントの存在理由（GATE-LINE-SHARE が `unknown` のまま出荷するため）。
 *
 * ★ すべての LIFF SDK 呼び出しは呼び出し側（`src/app/(liff)/events/[id]/share/page.tsx`）が持つ。
 *   ここは props だけで完結する（`isApiAvailable` も真偽値で受け取る）。理由は 2 つ:
 *     1. テスト容易性（`isApiAvailable=false` のときコピー導線だけになることを、
 *        LIFF モジュールを一切モックせずに検査できる）。
 *     2. `docs/constraints.json` N9（禁止 API の呼び出し文字列を禁止）を
 *        このファイルに持ち込まない。picker の呼び出しは `src/lib/liff/share.ts` の担当。
 *
 * ★ `joinLink` が無い間（まだ一度もリンクを作っていない・失効した）は、コピー系導線を
 *   すべて無効化し、「リンクを作る」導線だけを出す。壊れた・空のリンクを出さない方針
 *   （`StaticFallback` / `StateView` と同じ）。
 */

import { useEffect, useState, type ReactNode } from "react";

import {
  buildExplanationText,
  buildFlexShareMessage,
  buildJoinLinkQrSvg,
  buildReminderText,
  formatDeadline,
  formatYenAmount,
  type ShareEventInfo,
} from "@/lib/share-templates";
import type { ShareTargetPickerOutcome } from "@/lib/share-outcome";

export interface ShareSheetParticipant {
  readonly id: string;
  readonly displayLabel: string | null;
  /** その参加者の請求額。未発行なら `null`（既定金額で代用する）。 */
  readonly amountMinor: number | null;
  /** 未払い（`RosterStatus === 'unpaid'`）かどうか。呼び出し側が判定して渡す。 */
  readonly unpaid: boolean;
}

export interface ShareSheetProps {
  readonly organizerLabel: string;
  readonly eventTitle: string;
  readonly collectByAt: string | null;
  /** 参加者に個別の請求額が無いときに使う既定額。 */
  readonly defaultAmountMinor: number | null;
  /** 今使える招待リンク。無ければコピー系導線は出さない。 */
  readonly joinLink: string | null;
  /** 「リンクを作る／作り直す」ボタン押下時に呼ぶ。実際の発行は呼び出し側の責務。 */
  readonly onCreateLink: () => void;
  readonly creatingLink?: boolean;
  readonly participants: readonly ShareSheetParticipant[];
  /**
   * レビュー是正 C-016-6: `participants` はカーソルページングの 1 ページ分（呼び出し側の
   * `limit=100`）で、続きがあるかどうかはこの props でしか分からない（O-4 の `nextCursor`
   * と同じ形）。省略時は「続きは無い」として扱う（＝ボタンを出さない）。
   */
  readonly hasMoreParticipants?: boolean;
  readonly loadingMoreParticipants?: boolean;
  /** 続きを読み込む。`hasMoreParticipants` が真のときだけ渡されることを期待する。 */
  readonly onLoadMoreParticipants?: () => void;
  /** `liff.isApiAvailable('shareTargetPicker')` の結果。呼び出し側が判定して渡す。 */
  readonly isApiAvailable: boolean;
  /** picker を開く。結果は戻り値で受け取り、このコンポーネントが表示する。 */
  readonly onShareViaPicker: () => Promise<ShareTargetPickerOutcome>;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 握りつぶす。下の `<code>` 表示が唯一のフォールバックになる。
  }
  return false;
}

const PICKER_OUTCOME_TEXT: Readonly<Record<ShareTargetPickerOutcome, string>> = {
  sent: "送信しました。",
  canceled: "送信をやめました。",
  unavailable: "この環境では使えませんでした。上のコピー導線をお使いください。",
  failed: "送信できませんでした。上のコピー導線をお使いください。",
};

/** コピー操作 1 回分の結果。押した要素を区別するためキーで持つ。 */
interface CopyStatus {
  readonly key: string;
  readonly copied: boolean;
}

export function ShareSheet({
  organizerLabel,
  eventTitle,
  collectByAt,
  defaultAmountMinor,
  joinLink,
  onCreateLink,
  creatingLink = false,
  participants,
  hasMoreParticipants = false,
  loadingMoreParticipants = false,
  onLoadMoreParticipants,
  isApiAvailable,
  onShareViaPicker,
}: ShareSheetProps): ReactNode {
  const [filter, setFilter] = useState<"unpaid" | "all">("unpaid");
  const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerOutcome, setPickerOutcome] = useState<ShareTargetPickerOutcome | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);

  const event: ShareEventInfo = { organizerLabel, eventTitle, collectByAt };

  useEffect(() => {
    let cancelled = false;

    async function run(): Promise<void> {
      if (joinLink === null) {
        if (!cancelled) setQrSvg(null);
        return;
      }
      try {
        const svg = await buildJoinLinkQrSvg(joinLink);
        if (!cancelled) setQrSvg(svg);
      } catch {
        if (!cancelled) setQrSvg(null);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [joinLink]);

  const runCopy = (key: string, text: string): void => {
    copyToClipboard(text)
      .then((copied) => {
        setCopyStatus({ key, copied });
      })
      .catch(() => {
        setCopyStatus({ key, copied: false });
      });
  };

  const runPicker = (): void => {
    setPickerBusy(true);
    setPickerOutcome(null);
    onShareViaPicker()
      .then((outcome) => {
        setPickerOutcome(outcome);
      })
      .catch(() => {
        setPickerOutcome("failed");
      })
      .finally(() => {
        setPickerBusy(false);
      });
  };

  const visibleParticipants = participants.filter((p) => (filter === "unpaid" ? p.unpaid : true));

  const reminderText =
    joinLink === null
      ? null
      : buildReminderText({ event, link: joinLink, amountMinor: defaultAmountMinor });
  const explanationText = joinLink === null ? null : buildExplanationText(organizerLabel, joinLink);
  const flexMessage =
    joinLink === null
      ? null
      : buildFlexShareMessage({ event, amountMinor: defaultAmountMinor, link: joinLink });

  return (
    <section aria-labelledby="share-sheet-heading" className="share-sheet">
      <h2 id="share-sheet-heading">配布</h2>

      <div className="share-sheet__link-status">
        {joinLink === null ? (
          <p>まだ配布用リンクがありません。作り直すと、これより前に配ったリンクは使えなくなります。</p>
        ) : null}
        <button
          type="button"
          className="tap-target"
          disabled={creatingLink}
          aria-busy={creatingLink}
          onClick={onCreateLink}
        >
          {joinLink === null ? "リンクを作る" : "リンクを作り直す"}
        </button>
      </div>

      {joinLink === null ? null : (
        <>
          {/* 主導線: 催促文＋URL のクリップボードコピー */}
          <div className="share-sheet__primary">
            <h3>催促文をコピーする</h3>
            <p>
              金額: {formatYenAmount(defaultAmountMinor)} ／ 支払期限: {formatDeadline(collectByAt)}
            </p>
            <p className="share-sheet__text-preview">
              <code>{reminderText}</code>
            </p>
            <button
              type="button"
              className="tap-target"
              onClick={() => {
                if (reminderText !== null) runCopy("reminder", reminderText);
              }}
            >
              催促文をコピー
            </button>
            {copyStatus?.key === "reminder" ? (
              <span role="status">{copyStatus.copied ? "コピーしました" : "コピーできませんでした。上の文章を選択してコピーしてください。"}</span>
            ) : null}
          </div>

          {/* 参加者ごとの個別リンク一覧（未払い者だけを再共有できる） */}
          <div className="share-sheet__roster">
            <h3>参加者ごとに送る</h3>
            <div className="share-sheet__filter">
              <label>
                <input
                  type="radio"
                  name="share-sheet-filter"
                  checked={filter === "unpaid"}
                  onChange={() => {
                    setFilter("unpaid");
                  }}
                />
                未払いのみ再共有
              </label>
              <label>
                <input
                  type="radio"
                  name="share-sheet-filter"
                  checked={filter === "all"}
                  onChange={() => {
                    setFilter("all");
                  }}
                />
                全員
              </label>
            </div>

            {visibleParticipants.length === 0 ? (
              <p>{filter === "unpaid" ? "未払いの参加者はいません。" : "参加者がいません。"}</p>
            ) : (
              <ul>
                {visibleParticipants.map((participant) => {
                  const text = buildReminderText({
                    event,
                    link: joinLink,
                    amountMinor: participant.amountMinor ?? defaultAmountMinor,
                    participantLabel: participant.displayLabel,
                  });
                  const key = `participant:${participant.id}`;
                  return (
                    <li key={participant.id}>
                      <span>{participant.displayLabel ?? "（表示名未設定）"}</span>
                      <button
                        type="button"
                        className="tap-target"
                        onClick={() => {
                          runCopy(key, text);
                        }}
                      >
                        コピー
                      </button>
                      {copyStatus?.key === key ? (
                        <span role="status">{copyStatus.copied ? "コピーしました" : "コピーできませんでした"}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            {/* レビュー是正 C-016-6: 101 人目以降が黙って消えないよう、続きがあることと
                読み込む手段を必ず出す（O-4「もっと見る」と同じ形）。 */}
            {hasMoreParticipants && onLoadMoreParticipants !== undefined ? (
              <button
                type="button"
                className="tap-target"
                disabled={loadingMoreParticipants}
                aria-busy={loadingMoreParticipants}
                onClick={onLoadMoreParticipants}
              >
                {loadingMoreParticipants ? "読み込み中…" : "さらに読み込む"}
              </button>
            ) : null}
          </div>

          {/* リンクを疑われた際の説明テンプレ */}
          <details className="share-sheet__explanation">
            <summary>リンクを疑われたときの説明文</summary>
            <p className="share-sheet__text-preview">
              <code>{explanationText}</code>
            </p>
            <button
              type="button"
              className="tap-target"
              onClick={() => {
                if (explanationText !== null) runCopy("explanation", explanationText);
              }}
            >
              説明文をコピー
            </button>
            {copyStatus?.key === "explanation" ? (
              <span role="status">{copyStatus.copied ? "コピーしました" : "コピーできませんでした。上の文章を選択してコピーしてください。"}</span>
            ) : null}
          </details>

          {/* QR（別端末用。同じ端末では読み取れない） */}
          <div className="share-sheet__qr">
            <h3>QR コード</h3>
            <p>別の端末から読み取るときに使います。いま見ている端末では読み取れません。</p>
            {qrSvg === null ? null : (
              // React の DOM 直接注入 API は使わない（制約 GC-XSS。R-SEC-12）。SVG 文字列は
              // `<img>` の `src` に data URI として渡すだけにとどめ、DOM へ直接注入しない。
              // data URI で毎回生成するローカル画像であり、next/image のリモート最適化は対象外。
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="share-sheet__qr-image"
                alt="配布用リンクの QR コード"
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`}
              />
            )}
          </div>

          {/* shareTargetPicker（isApiAvailable 判定つきの補助導線） */}
          {isApiAvailable ? (
            <div className="share-sheet__picker">
              <h3>LINE で直接送る（補助）</h3>
              <p className="share-sheet__text-preview">
                <code>{flexMessage?.altText}</code>
              </p>
              <button
                type="button"
                className="tap-target"
                disabled={pickerBusy}
                aria-busy={pickerBusy}
                onClick={runPicker}
              >
                LINE の友だちに送る
              </button>
              {pickerOutcome === null ? null : <span role="status">{PICKER_OUTCOME_TEXT[pickerOutcome]}</span>}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export default ShareSheet;
