/**
 * `shareTargetPicker` の可用性判定と呼び出し（§7-3 / N8 / N9 / GATE-LINE-SHARE / task_016）。
 *
 * ★ 補助導線であって主導線ではない。主導線は催促文＋URL のクリップボードコピー
 *   （`src/lib/share-templates.ts`）。ここは「使えるときだけ足す」機能だけを持つ。
 *
 * ★ `liff.isApiAvailable('shareTargetPicker')` の可用性は**実行時に**判定する
 *   （`GATE-LINE-SHARE` が `unknown` のまま、有効化手順の一次資料が未特定なため。
 *   `docs/vendor-docs/line/share-target-picker.md`）。ビルド時に決め打ちしない。
 *
 * ★ ここで呼ぶのは `liff.shareTargetPicker()` であって、集金導線で使えない前提にしている
 *   **別の送信系メソッド（制約 N9 が禁じているもの）ではない**（2 つは別の API で、
 *   引数の形が似ているだけ）。N9 は禁止対象のメソッド名に丸括弧が続く並びを grep で
 *   forbid しているため、このファイルではそのメソッド名を呼び出し構文の形では書かない
 *   （`docs/constraints.json` N9 を参照）。
 *
 * ★ SDK の読み込みは `src/lib/liff/client.ts` の `bootLiff()` が既に済ませている前提
 *   （このモジュールは `ready` フェーズに入ってからだけ呼ばれる）。`@line/liff` の
 *   default export はモジュールキャッシュにより単一インスタンスなので、`client.ts` が
 *   モック化・`init()` 済みの同じオブジェクトをここでも受け取れる。したがって
 *   `NEXT_PUBLIC_LIFF_MOCK` によるモック分岐はここには要らない
 *   （`./mock` を改めて import すると `LiffMockPlugin` の二重適用になるため、意図的に避ける）。
 */

import type { FlexShareMessage } from "@/lib/share-templates";

/** 呼び出し側が実際に使う面だけを写した最小の型。 */
export interface ShareLiffLike {
  isApiAvailable(apiName: string): boolean;
  shareTargetPicker(
    messages: readonly FlexShareMessage[],
    options?: { readonly isMultiple?: boolean },
  ): Promise<{ readonly status: "success" } | void>;
}

export interface ShareLiffDeps {
  /** SDK を読む関数。既定は `@line/liff` の動的 import。 */
  readonly loadLiff?: () => Promise<ShareLiffLike>;
}

async function defaultLoadShareLiff(): Promise<ShareLiffLike> {
  const sdk = await import("@line/liff");
  return sdk.default as unknown as ShareLiffLike;
}

/** SDK 呼び出しを例外を投げない形に包む（`client.ts` の `callSdk` と同じ理由）。 */
function callSdk<T>(fn: () => T): { readonly ok: true; readonly value: T } | { readonly ok: false } {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
}

/**
 * `shareTargetPicker` が今この環境で使えるか。例外や SDK 未読込は「使えない」に倒す
 * （fail-closed。補助導線を出さないほうが、壊れた補助導線を出すより安全）。
 */
export async function isShareTargetPickerAvailable(deps: ShareLiffDeps = {}): Promise<boolean> {
  const loadLiff = deps.loadLiff ?? defaultLoadShareLiff;
  let liff: ShareLiffLike;
  try {
    liff = await loadLiff();
  } catch {
    return false;
  }
  const result = callSdk(() => liff.isApiAvailable("shareTargetPicker"));
  return result.ok && result.value;
}

export type ShareTargetPickerOutcome =
  /** 送信が成立した。 */
  | "sent"
  /** 利用者が picker を閉じた・送信をやめた。 */
  | "canceled"
  /** この環境では使えない（呼び出し前に弾いた）。 */
  | "unavailable"
  /** SDK 呼び出し自体が失敗した。 */
  | "failed";

/**
 * `shareTargetPicker` を開く。呼ぶ前に必ず {@link isShareTargetPickerAvailable} で判定すること
 * （ここでも例外を投げない。呼び出し側は `ShareTargetPickerOutcome` だけで分岐できる）。
 */
export async function openShareTargetPicker(
  messages: readonly FlexShareMessage[],
  deps: ShareLiffDeps = {},
): Promise<ShareTargetPickerOutcome> {
  const loadLiff = deps.loadLiff ?? defaultLoadShareLiff;
  let liff: ShareLiffLike;
  try {
    liff = await loadLiff();
  } catch {
    return "failed";
  }

  const available = callSdk(() => liff.isApiAvailable("shareTargetPicker"));
  if (!available.ok || !available.value) {
    return "unavailable";
  }

  try {
    // LIFF Mock（`@line/liff-mock`）は成功時 `undefined` を返しうる（README §API）。
    // `void` は「キャンセルではなく完了した」ことを示す。
    const result = await liff.shareTargetPicker(messages, { isMultiple: false });
    if (result === undefined || result.status === "success") {
      return "sent";
    }
    return "canceled";
  } catch {
    // 実 SDK は picker をユーザーが閉じたときに reject する（一次資料未特定。
    // `docs/vendor-docs/line/share-target-picker.md` 参照）。区別できないので
    // 「送信されなかった」側に寄せ、失敗と混同しないよう canceled にする。
    return "canceled";
  }
}
