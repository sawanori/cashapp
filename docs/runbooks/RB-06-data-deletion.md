# RB-06: データ削除請求（擬似匿名化）への対応

## トリガー

- 利用者（幹事または参加者）から、自己に関する情報の削除請求があった
  （`src/content/privacy.md` §8 / `src/content/terms.md` 第6条）。

## 手順

1. 請求者が本人であることを確認する（LINE のトーク等、既存の連絡経路で本人確認を行う。
   本ドキュメントは確認方法そのものは定めない）。
2. 対象が「幹事として作成したイベントの表示名」か「参加者としての表示名」かを特定する。
3. 管理者が `POST /api/admin/anonymize` に `{ target: "organizer" | "participant", targetId }`
   を送る（`src/app/api/admin/anonymize/route.ts`）。
   - `target: "organizer"` → 当該幹事が作成した全イベントの `event.organizer_label` が
     固定のプレースホルダ（`(削除済み)`）に置き換わる。
   - `target: "participant"` → 当該参加者行の `participant.display_label` が `NULL` になる。
4. 請求・支払い・監査に関する記録のうち、金額と ID（氏名等を含まない部分）は削除されない
   （`ledger_entry` は追記専用テーブルであり `UPDATE` / `DELETE` が構造的にできない。
   §7-5・premortem P-07）。この点を請求者に説明する（規約・プライバシーポリシーに明記済み）。

## 人間承認が必要な操作

- 擬似匿名化の実行そのもの（管理者 1 名の操作。二人承認は不要 — scope の二人承認対象は
  `POST /api/admin/flags` と `POST /api/admin/suspend` のみ）。
- 請求者が本人であることの確認（運用上の判断）。

## 記録先

- `audit_log`（`admin.anonymize`。`detail` には `{ target, affected }` のみを記録し、
  請求理由等の自由記述は記録しない。premortem P-07 対策）。
- 請求そのもの（誰がいつ請求したか）の記録先は、本アプリの外（運営者の対応記録）とする。
  `audit_log.actor_ref` には対応した管理者の識別子（`gh:<login>`）が残るが、請求者本人の
  識別子は `target`/`targetId` としてのみ残り、請求理由は残らない。
