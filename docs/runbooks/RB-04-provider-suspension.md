# RB-04: 幹事の停止（悪用対策・事業者からの指摘）

## トリガー

- 参加者からの通報（`POST /api/e/report` により `abuse_report` に記録された内容）を確認した
  結果、幹事による悪用が疑われる。
- 決済事業者から特定の幹事について規約違反・加盟店資格の指摘があった（§17-5 の条件 ③）。
- O-9 の要対応インボックスで、特定の幹事のイベントに異常な集中が見られる。

## 手順

1. 管理者（`ADMIN_ALLOWLIST` に載った GitHub アカウント）が `GET /api/admin/lookup` で
   関連する `invoice` / `payment_attempt` / `audit_log` を確認する（`display_label` は
   返らないため、対象の特定は `organizerUserId`（UUID）または `invoiceId` で行う）。
2. 管理者 1 が `POST /api/admin/suspend` に `{ action: "propose", organizerUserId }` を送り、
   `proposalId` を得る。
3. **別の管理者**が `proposalId` を受け取り、`{ action: "approve", proposalId }` を送って
   承認する。第二承認者が確保できない場合は、提案から 24 時間経過後に同一管理者が承認できる
   （A23 縮退。`src/lib/admin-auth.ts` の `approveAdminAction`）。
4. 承認が成立すると `app_user.status='suspended'` となり、`session_epoch` が進むため当該
   幹事の発行済みセッションはすべて即座に失効する。以後、自動アダプタの `resolveProvider`
   は「幹事が停止されている」ガードで新規のチェックアウトを止める
   （`src/lib/payments/registry.ts`）。**手動確認（`manual_confirm`）はこのガードを見ない
   ため、停止中でも進行中のイベントの手動確認自体は止まらない**（§7-6 の設計）。

## 人間承認が必要な操作

- 停止の提案・承認そのもの（二人承認。上記手順 2〜3）。

## 記録先

- `audit_log`（`admin.suspend.propose` / `admin.suspend.approve`）。
- 通報の原本は `abuse_report`（保持期間対象外の自由記述。premortem P-07 の既知の限界）。
