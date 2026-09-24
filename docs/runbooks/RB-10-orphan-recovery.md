# RB-10: 孤児（orphan）入金の回収

出典: `docs/implementation-plan.md` §9「attempt 無しは `orphan` として `outbox` に
`orphan_alert`」。O-9 要対応インボックスの分類の 1 つ。

## トリガー

- O-9 要対応インボックスに「孤児（試行に紐づく請求が無い）」の項目が上がっている。
- Webhook 経由で受信した `payment_event` に対応する `payment_attempt` が見つからない
  （生きた試行が既に削除・キャンセルされている、または対応する参加者が名簿から削除された後に
  入金が確定した）。

## 手順

1. 管理者が `GET /api/admin/lookup?externalRef=<external_ref>` で該当する試行・請求を照会する
   （`src/app/api/admin/lookup/route.ts`）。
2. 対応する `invoice` が見つかる場合、金額・参加者が一致するかを確認したうえで、幹事側の
   O-9 画面（`src/app/(liff)/events/[id]/inbox/page.tsx`）から手動での確認（O-8 の手動確認
   フロー）に倣って処理する。
3. 対応する `invoice` が見つからない場合（真の孤児）、入金自体は決済事業者側で成立している
   ため、幹事に対し「入金元の参加者に心当たりがあるか」を確認してもらう。運営者は資金を
   経由しないため（L1）、この時点で運営者ができるのは記録の照合までであり、実際の返金・
   受け渡しの調整は幹事と決済事業者の間で行う。
4. 対応が完了したら、`ledger_entry.kind='adjustment'` として記録が残っていることを確認する
   （§9「金額・通貨が一致しないイベントは...受領事実を `ledger_entry.kind='adjustment'` として
   記録し `needs_attention` を立てる」）。

## 人間承認が必要な操作

- 孤児入金を特定の請求に紐付け直す判断（誤った紐付けは二重計上・誤送金の原因になるため、
  管理者が `GET /api/admin/lookup` の内容を確認したうえで幹事に確認を求める）。

## 記録先

- `payment_event`（`apply_result='orphan'`）、`ledger_entry`（`kind='adjustment'`）、
  `audit_log`（`GET /api/admin/lookup` の照会自体はログに残らない読み取り専用操作。対応の
  記録は幹事側の手動確認フローの監査ログに残る）。
