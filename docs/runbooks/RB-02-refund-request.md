# RB-02: 返金請求への対応

## トリガー

- 幹事または参加者から、支払済みの会費の返金を求める連絡があった。
- O-9 要対応インボックスに返金期限が近い項目が上がっている。

## 手順

1. 幹事が `POST /api/invoices/:id/refund`（`src/app/api/invoices/[id]/refund/route.ts`）を
   O-10 画面（`src/app/(liff)/events/[id]/refund/[invoiceId]/page.tsx`）から実行する。
2. 対象請求の `provider_key` が `manual_confirm`（Phase 1 の唯一の出荷アダプタ）の場合、
   `capabilities.refund === 'none'` のため常に 409 `NOT_SUPPORTED` になる。この場合、
   アプリからの返金はできないため、幹事から参加者へ LINE のトークで直接返金してもらう
   （固定文言で案内）。
3. 自動アダプタ（Phase 2 以降）が有効な場合、`capabilities.refund` が `'full_once'` なら
   1 請求につき 1 回しか返金できない点を事前に警告してから実行する（O-10）。
4. 返金の実行結果（`ledger_entry.kind='refund'`）と監査ログ（`invoice.refund`）を確認する。

## 人間承認が必要な操作

- 返金の実行そのもの（幹事の操作）。管理者による二人承認は不要（scope の対象は
  `POST /api/admin/flags` と `POST /api/admin/suspend` のみ）。
- `capabilities.refund === 'none'` のケースで、幹事の直接返金が完了したことの確認は運用上
  幹事の自己申告に依る（アプリは検知しない）。

## 記録先

- `ledger_entry`（`kind='refund'`）、`audit_log`（`invoice.refund`）。
- アプリ外で完了した返金（`NOT_SUPPORTED` のケース）は、O-9 の要対応インボックスで幹事が
  手動確認するまで記録が残らない。台帳の外で完結した返金の記録先は現状無く、
  `docs/concerns/task_021.md` に残課題として記録している。
