# PayPay 個人間受取リンクの URL 形式（task_017 / ManualConfirmAdapter）

- 取得日: **未取得**（2026-09-25 時点で一次資料を取得できていない）
- 取得者: task_017 実装エージェント
- 状態: **未検証（unverified）**

## なぜこのファイルがあるか

`src/lib/payments/providers/manual-confirm.ts` は、幹事から任意 URL を受け取らず、
受取用の識別子（`provider_binding.receiving_identifier`）だけを受け取って、
**サーバー側の固定テンプレート**からリンクを組み立てる（`docs/implementation-plan.md` §7-6）。

そのテンプレートに載せる URL 形式は外部仕様であり、推測で書いてはならない
（`docs/HANDOFF.md` / タスク共通ルール「未確認の外部仕様は一次資料を退避してから使う」）。

## 現在の扱い

`RECEIVING_LINK_TEMPLATES` の `paypay_p2p` エントリは `verified: false` で登録してある。
`activeReceivingLinkTemplates()` は `verified: false` のエントリを除外するため、
**Phase 1 の既定動作では `deepLink` は常に `null`** になり、参加者画面は
「お支払い先は幹事にご確認ください」に倒れる。推測した URL を参加者に踏ませることはない。

`ALLOWED_DEEPLINK_HOSTS` に `qr.paypay.ne.jp` を置いてあるのは、許可ホスト検査そのものの
実装と回帰テストを成立させるためである。ホストの許可だけでリンクが出ることはない
（`verified` との AND 条件）。

## 有効化の手順（この資料を埋める人向け）

1. PayPay の公開資料（個人間送金の受け取りリンク／マイコードの URL 形式）を取得し、
   本ファイルに **取得日・URL・引用**を貼る。
2. `RECEIVING_LINK_TEMPLATES` の当該エントリの `build` / `host` / `identifierPattern` を
   一次資料に合わせ、`verified: true`、`sourceRef` を本ファイルのパスにする。
3. `tests/unit/payments/manual-confirm.test.ts` の「未検証テンプレートはリンクを出さない」
   ケースを、検証済みテンプレートの期待値に合わせて更新する（削除はしない）。
4. `npm run test:unit` と `npm run gate:constraints` を `scripts/record-run.sh` 経由で実行する。

## 未取得の理由

本タスクの実行環境から PayPay の公開資料へ到達できていない。推測で URL を書くより、
テンプレートを無効のまま出荷し、案内文を「幹事に確認」に倒すほうが害が小さいと判断した。
