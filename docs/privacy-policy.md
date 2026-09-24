# プライバシーポリシー実装対応表（内部向け）

最終改定日: 2026-09-25（task_021 scope）

利用者に提示するプライバシーポリシーの本文は `src/content/privacy.md` である
（`npm run gate:privacy-policy` が必須項目の存在を機械検査する）。本ドキュメントは、
その本文が満たすべき各要件が**コード上のどこで実際に担保されているか**を示す、
内部向けの対応表（クロスウォーク）である。監査・レビュー時に参照する。

| 要件 | 根拠 | `src/content/privacy.md` の節 | 実装での担保箇所 |
|---|---|---|---|
| 事業者名・住所・連絡先の掲示 | L7（個人情報保護法32条1項） | 1. 事業者情報 | `src/app/(liff)/settings/legal/page.tsx`（O-13） |
| LINE userId を生値で保存しない | §7-5 | 2. 取得する情報と取得しない情報 | `src/lib/auth/pepper.ts`（HMAC 化）、`docs/legal-forensics.md`（突合手順） |
| 参加者の表示名・幹事の表示名は終了+90日で識別性を失わせる | §7-5 | 2. 取得する情報と取得しない情報 | `event.organizer_label` / `participant.display_label`（保持期間の機械的な失効は task_020 の `/api/cron/retention` が担う）。前倒しの請求対応は `POST /api/admin/anonymize`（`src/app/api/admin/anonymize/route.ts`） |
| 画像・メール・電話・住所を取得しない | §7-5 | 2. 取得する情報と取得しない情報 | `src/lib/db/schema.ts` にこれらの列が存在しないこと自体が担保（設計上収集経路が無い） |
| 委託先の開示 | scope | 4. 第三者提供・委託先 | インフラ: Cloudflare, Inc. ／ DB: Supabase, Inc.（`docs/vendor-docs/cloudflare/**`・`docs/vendor-docs/supabase/**` に技術的な一次資料） |
| 保管国・外的環境の把握 | scope | 5. 情報の保管国・越境移転 | Supabase のプロジェクトリージョン設定（`docs/implementation-plan.md` §7-2） |
| 安全管理措置 | scope | 6. 安全管理措置 | HMAC 化（`src/lib/auth/pepper.ts`）、最小権限ロール `app_rw`（`src/lib/db/client.ts`）、TLS 経由の接続、監査ログのハッシュ連鎖（`src/lib/audit.ts`） |
| プラットフォームログの保持期間 | scope | 7. プラットフォームのログの保管期間 | Cloudflare Workers Logs / Logpush の保持設定は未確定（一次資料の取得は Phase 1 の残タスク。`docs/vendor-docs/cloudflare/` 配下に取得日つきで追加すること） |
| 開示等請求手続 | L7 | 8. 保有個人データの開示等の請求手続 | `src/app/(liff)/settings/legal/page.tsx`（連絡導線）、`GET /api/me/export.zip`（一括エクスポート）、`POST /api/admin/anonymize`（削除請求対応） |

## 未確認事項

- Cloudflare Workers Logs / Logpush の実際の保持期間は、本タスク時点で一次資料を取得できて
  いない（`docs/vendor-docs/cloudflare/` 配下に取得日つきで記録するタスクが未着手）。
  `src/content/privacy.md` §7 は「当該事業者の定める保管期間に従う」とだけ記載しており、
  数値を断定していない。一次資料取得後、本表と `privacy.md` の双方を更新すること。
