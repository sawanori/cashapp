/**
 * 共通状態ビュー（§8-3 / R-UX-04 / R-LINE-02）。
 *
 * ★ 全画面がこの 8 状態を実装する、という規約の**実体**である。
 *   画面ごとに似て非なる空表示・エラー表示を書かせないために、ここ 1 つに寄せる。
 *
 *     loading / empty / error / forbidden / outside_line / auth_unavailable / gate_blocked / degraded
 *
 * ★ **色だけで意味を運ばない**（R-UX-04）。各状態は必ず 3 つを同時に出す。
 *     ① アイコン（形が状態ごとに違う。色を落としても区別できる）
 *     ② 日本語のラベル文（読み上げ・拡大表示でも残る）
 *     ③ 色（`data-tone` 経由でトークンから引く。補助であって主たる手掛かりではない）
 *
 * ★ `outside_line` のフォールバック順序は §7-3 で決まっている:
 *     ① LINE で開くリンク → ② URL（コピーして貼る）→ ③ QR（**別端末用**）
 *   QR は同一端末では読み取れないので最後に置き、用途を明記する。
 *   QR 画像そのものの生成は配布導線（task_016）の担当で、ここでは案内だけを持つ。
 *
 *   ★ ③ だけを単独で出さない。`permanentLink` が無いときに ③ の注記だけが残ると、
 *     画面には「いま見ている端末では読み取れません」＝ **できないことしか書かれない**。
 *     ①②③ は 1 つのまとまりとして出すか、まとめて出さないかのどちらかにする
 *     （出さない場合も `outside_line` の本文「LINE アプリで開いてください」は残るので、
 *     利用者が次に何をすればよいかは画面に残る）。壊れたリンクを出さない方針は維持する。
 *
 * ★ `requestId` は不透明 ID である。ログ本文・例外メッセージをここに出さない（§8-3）。
 *
 * ★ クライアント境界を持たない（`"use client"` を書かない）。
 *   Server Component からも Client Component からも同じものを描けるようにするためで、
 *   その代わりイベントハンドラを持たない。操作が要るものは `children` で受け取る。
 */

import type { ReactNode } from "react";

export const VIEW_STATES = [
  "loading",
  "empty",
  "error",
  "forbidden",
  "outside_line",
  "auth_unavailable",
  "gate_blocked",
  "degraded",
] as const;

export type ViewState = (typeof VIEW_STATES)[number];

type Tone = "neutral" | "info" | "warning" | "danger";

interface StateSpec {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
  /** 読み上げの扱い。割り込みが要るものだけ `alert` にする。 */
  readonly live: "status" | "alert" | "none";
  readonly icon: ReactNode;
}

/* --- アイコン ---------------------------------------------------------
 * 形だけで区別できるようにする（色を落としても意味が残ること）。
 * `aria-hidden` で読み上げから外し、意味はテキスト側が担う。
 */
function Icon({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <svg
      className="state-view__icon"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const ICON_SPINNER = (
  <Icon>
    <circle cx="12" cy="12" r="9" strokeOpacity="0.3" />
    <path d="M21 12a9 9 0 0 0-9-9" />
  </Icon>
);
const ICON_EMPTY = (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18" />
  </Icon>
);
const ICON_ERROR = (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6" />
    <path d="M12 16.5h.01" />
  </Icon>
);
const ICON_FORBIDDEN = (
  <Icon>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.6 5.6l12.8 12.8" />
  </Icon>
);
const ICON_OUTSIDE = (
  <Icon>
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </Icon>
);
const ICON_KEY = (
  <Icon>
    <circle cx="8" cy="12" r="4" />
    <path d="M12 12h9" />
    <path d="M18 12v3" />
  </Icon>
);
const ICON_GATE = (
  <Icon>
    <rect x="4" y="10" width="16" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </Icon>
);
const ICON_DEGRADED = (
  <Icon>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4" />
    <path d="M12 17.5h.01" />
  </Icon>
);

/**
 * 状態ごとの固定文言。
 *
 * ★ `docs/wording-policy.md` の禁止語を使わない。とくに「自動確認の断定」群（同ポリシー §2）は
 *   Phase 1 に存在しない機能を約束する語なので、状態文言にも書かない。
 *   実際に使われていないことは `tests/unit/components/StateView.test.tsx` が検査する。
 */
const SPECS: Readonly<Record<ViewState, StateSpec>> = {
  loading: {
    tone: "neutral",
    title: "読み込み中です",
    body: "そのままお待ちください。",
    live: "status",
    icon: ICON_SPINNER,
  },
  empty: {
    tone: "neutral",
    title: "表示できるものがありません",
    body: "まだ登録がありません。",
    live: "none",
    icon: ICON_EMPTY,
  },
  error: {
    tone: "danger",
    title: "うまく表示できませんでした",
    body: "時間をおいてもう一度お試しください。",
    live: "alert",
    icon: ICON_ERROR,
  },
  forbidden: {
    tone: "danger",
    title: "この画面を開く権限がありません",
    body: "イベントの幹事にご確認ください。",
    live: "alert",
    icon: ICON_FORBIDDEN,
  },
  outside_line: {
    tone: "info",
    title: "LINE アプリで開いてください",
    body: "この画面は LINE アプリの中でのみ利用できます。",
    live: "none",
    icon: ICON_OUTSIDE,
  },
  auth_unavailable: {
    tone: "warning",
    title: "ログインを完了できませんでした",
    body: "いったん画面を閉じ、LINE アプリからもう一度開いてください。",
    live: "alert",
    icon: ICON_KEY,
  },
  gate_blocked: {
    tone: "warning",
    title: "この機能はまだ利用できません",
    body: "準備が整うまでお待ちください。",
    live: "alert",
    icon: ICON_GATE,
  },
  degraded: {
    tone: "warning",
    title: "反映に時間がかかっています",
    body: "表示が最新でない場合があります。しばらくしてから開き直してください。",
    live: "status",
    icon: ICON_DEGRADED,
  },
};

export interface StateViewProps {
  readonly state: ViewState;
  /** 問い合わせ用の不透明 ID。`error` 系のときだけ意味を持つ。 */
  readonly requestId?: string | undefined;
  /**
   * LINE で開くためのパーマネントリンク。`outside_line` / `auth_unavailable` で使う。
   * 渡されないときはリンク導線を出さない（壊れたリンクを出すより無いほうがよい）。
   */
  readonly permanentLink?: string | undefined;
  /** 固定文言の代わりに出す説明。画面固有の事情があるときだけ使う。 */
  readonly description?: string | undefined;
  /** 追加の操作（再試行ボタン等）。イベントハンドラを持つものは呼び出し側から渡す。 */
  readonly children?: ReactNode;
}

/** `live` から ARIA 属性へ。`none` のときは何も付けない。 */
function liveProps(live: StateSpec["live"]): Record<string, string> {
  if (live === "alert") return { role: "alert" };
  if (live === "status") return { role: "status", "aria-live": "polite" };
  return {};
}

export function StateView({
  state,
  requestId,
  permanentLink,
  description,
  children,
}: StateViewProps): ReactNode {
  const spec = SPECS[state];

  return (
    <section
      className="state-view"
      data-state={state}
      data-tone={spec.tone}
      {...liveProps(spec.live)}
    >
      <p className="state-view__head">
        {spec.icon}
        <strong className="state-view__title">{spec.title}</strong>
      </p>
      <p className="state-view__body">{description ?? spec.body}</p>

      {(state === "outside_line" || state === "auth_unavailable") && permanentLink !== undefined ? (
        <div className="state-view__fallback">
          {/* ① LINE で開く */}
          <p>
            <a className="tap-target state-view__action" href={permanentLink}>
              LINE アプリで開く
            </a>
          </p>
          {/* ② URL（コピーして貼る） */}
          <p className="state-view__url">
            うまく開けないときは、次の URL をコピーして LINE のトークに貼り付けてください。
            <br />
            <code>{permanentLink}</code>
          </p>
          {/* ③ QR は別端末用（同じ端末では読み取れない） */}
          <p className="state-view__note">
            QR コードは別の端末から読み取るときに使います。いま見ている端末では読み取れません。
          </p>
        </div>
      ) : null}

      {requestId === undefined ? null : (
        <p className="state-view__request-id">
          お問い合わせ番号: <code>{requestId}</code>
        </p>
      )}

      {children}
    </section>
  );
}

export default StateView;
