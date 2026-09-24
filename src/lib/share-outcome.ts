/**
 * shareTargetPicker の結果型。
 *
 * `src/lib/liff/share.ts`（LIFF SDK を触る側）と `src/components/ShareSheet.tsx`（画面側）の両方が
 * 使う。画面側が `src/lib/liff/**` を import すると LIFF 非依存ビルド（`npm run build:web-only`）の
 * 参照禁止に当たるため、型だけをここ（LIFF に依存しない置き場）へ切り出している。
 */
export type ShareTargetPickerOutcome =
  /** 送信が成立した。 */
  | "sent"
  /** 利用者が picker を閉じた・送信をやめた。 */
  | "canceled"
  /** この環境では使えない（呼び出し前に弾いた）。 */
  | "unavailable"
  /** SDK 呼び出し自体が失敗した。 */
  | "failed";
