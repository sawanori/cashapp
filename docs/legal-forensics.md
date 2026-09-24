# 法的照会への対応（フォレンジック手順）

最終改定日: 2026-09-25（草案 v1）

本ドキュメントは、捜査機関等からの法的な照会（開示要請）に対応する際の手順を定める。
`docs/implementation-plan.md` §7-5「最小 PII と保持」の設計（LINE の userId は逆引きできない
形でのみ保存する）を前提とした、**突合はできるが復元はできない**運用を記録する。

## 1. 前提: 保存されている識別子の性質

- `app_user.line_user_ref` は LINE の userId そのものではなく、`HMAC(pepper, userId)` の値
  （`pepper_version` 付き）である。
- `pepper`（環境変数 `PEPPER`）はアプリのサーバー環境のみが保持し、DB には保存しない。
- したがって、`line_user_ref` の値**単体**から元の LINE userId を計算で導くことはできない
  （HMAC の性質上、鍵である `pepper` を知らなければ逆算できない）。

## 2. 照会への対応方法（突合であって復元ではない）

捜査機関等から特定の LINE userId について照会を受けた場合、次の手順で**その userId に該当する
記録があるかどうか**を確認する。これは「保存された値から userId を割り出す」のではなく、
「提示された userId を同じ方法でハッシュ化し、一致する行を探す」手順である。

1. 照会で提示された LINE userId を、稼働中の `pepper`（現行バージョンおよび直前バージョン。
   `src/lib/config/env.ts` の `SESSION_KEYS` と同様に現行＋直前の 2 世代を保持する運用）で
   `HMAC(pepper, userId)` を計算する（`src/lib/auth/pepper.ts` の `computeLineUserRef` と
   同じ計算方法）。
2. 計算結果を `app_user.line_user_ref` と突合する（一致する行があれば、その `app_user.id` が
   対象の内部識別子である）。
3. 一致した `app_user.id` を起点に、`event`（幹事として作成したイベント）・
   `participant_claim`（参加者として claim した名簿行）・`invoice` 等を追跡する。

この手順により、**適切な照会に対しては該当有無を回答できる**一方で、`line_user_ref` の値の
一覧だけを見ても元の userId の集合を復元することはできない（`pepper` を知らない限り）。

## 3. 対応にあたっての留意事項

1. 照会への対応は運営者代表（PO）の判断・承認を経て行う。本ドキュメントの手順は技術的な
   突合方法を示すものであり、開示の可否そのものの法的判断を代替しない。
2. 対応内容・照会元・提供した情報の範囲は、対応記録として別途保管する（本ドキュメントには
   個別の照会内容は記載しない）。
3. `pepper` のローテーション時は、現行と直前の 2 世代までしか照合できない
   （`src/lib/config/env.ts` の `MAX_SESSION_KEYS` に相当する設計を `pepper` にも適用して
   いる）。2 世代より前の `pepper` で作られた `line_user_ref` は、再計算による突合ができなく
   なる。ローテーション手順は `docs/runbooks/RB-03-key-rotation.md` を参照する。

## 4. 監査証跡の確認

法的照会・インシデント対応の一環として監査ログを確認する場合は、`src/lib/audit.ts` の
`verifyAuditChain` に相当する検証（連鎖のハッシュ再計算による改ざん検知）を行ったうえで、
`audit_log` の該当行を確認する。`GET /api/admin/lookup?requestId=...` で `requestId` を起点に
関連する監査行を確認できる（`src/app/api/admin/lookup/route.ts`）。
