# RB-05: キルスイッチ（`PAYMENTS_ENABLED` の停止）

出典: `docs/implementation-plan.md` §17-5。**止めるのは新規の資金移動だけ**。Webhook 受信・
保存・照合・`getPaymentStatus`・`refund`・`manual_confirm` は止めない。

## トリガー（即時に `PAYMENTS_ENABLED=false` を検討する条件）

1. 人間以外の actor による `gate.%` / `flag.%` の変更、または `docs/gates/*.json` と
   `compliance_gate`（DB 射影）の差分。
2. 弁護士から資金移動に関する照会（Q-LG1 等）に否定的な回答があった。
3. 決済事業者から規約違反・加盟店資格の指摘があった。
4. service role キー・`PEPPER`・セッション鍵の漏洩の疑い。
5. 非 production から本番 DB への書き込みが検知された。
6. `audit:verify`（監査連鎖の検証）で不一致が検知された。
7. 過払いまたは金額不一致で `paid` になった請求が 1 件でも発生した。
8. LINE ヤフーからポリシー違反の指摘があった。

## 手順

1. `GET /api/admin/gates` で現在の `PAYMENTS_ENABLED` の値を確認する。
2. 管理者 1 が `POST /api/admin/flags` に
   `{ action: "propose", key: "PAYMENTS_ENABLED", value: "false" }` を送る（`false` への変更に
   `legal-clearance.cleared` の前提条件は無い。前提が必要なのは `true` への変更のみ）。
3. **別の管理者**が `proposalId` を承認する（`{ action: "approve", proposalId }`）。第二承認者
   が確保できない緊急時は、提案から 24 時間を待たずに停止したい場合が想定されるため、
   トリガー ①〜⑧ のような「人間の判断を待たない」即時停止が必要な事案では、**別の管理者を
   直ちに確保して二人承認を成立させることを優先する**（A23 の 24 時間クーリングは「急いで
   単独承認する」ための抜け道ではなく、あくまで第二承認者が確保できない場合の縮退運転である）。
4. 停止後、`reconciliation_run` が引き続き動いていること（照合と受信が止まっていないこと）を
   確認する。
5. `degraded` の告知帯を用意する場合、「支払いを止めています」と「入金の記録は続いています」
   を分けて書く（§17-5）。

## 再開

**復旧（`PAYMENTS_ENABLED=true` への変更）の判断は人間（PO・noritaka）が行う。** 停止は
上記の手順で行えるが、再開の提案・承認も同じ `POST /api/admin/flags` の二人承認を経るとともに、
`value: "true"` への変更は `docs/gates/legal-clearance.json` の `cleared` が `true` であること
が前提となる（`src/lib/admin-auth.ts` の `LEGAL_CLEARANCE_CLEARED`）。

## 人間承認が必要な操作

- 停止・再開の提案と承認（二人承認）。
- 再開の最終判断（PO）。

## 記録先

- `audit_log`（`admin.flag.propose` / `admin.flag.approve`）。
- `docs/PROGRESS.md` / `docs/HANDOFF.md` に、レバー・理由・時刻を追記する（§17-5）。
