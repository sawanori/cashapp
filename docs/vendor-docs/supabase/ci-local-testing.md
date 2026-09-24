# Supabase — ローカル Postgres を使った CI（一次資料退避）

**取得日: 2026-09-24（task_011 実施時点）。取得方法: WebFetch。**

## 出典

- https://supabase.com/docs/guides/local-development/testing/overview
- https://raw.githubusercontent.com/supabase/setup-cli/main/action.yml

## GitHub Actions での CLI 導入

- アクション名は **`supabase/setup-cli@v1`**（公式ドキュメントの CI 例が使用）。
- `action.yml` が宣言する入力は **`version` ただ 1 つ**（`required: false`）。
  省略するとルートのロックファイルからバージョンを検出し、検出できなければ latest を入れる。
- ドキュメントの CI 例の実行順は `supabase start` → `supabase test db`。
  本プロジェクトは pgTAP（`supabase test db`）ではなく Vitest から実 Postgres に接続する
  方式なので、`supabase start` の後に `npm run test:integration` を走らせる。

## 本プロジェクトでの適用

- `.github/workflows/gate-integration.yml` が `supabase/setup-cli@v1` で CLI を入れ、
  `supabase start` → `npm run db:migrate` → `npm run test:integration` → `npm run gates:sync` を走らせる。
- `supabase start` は `supabase/migrations/*.sql` を適用する（本タスクで実測: 初回 start で
  `0001_init` が適用され、`supabase_migrations.schema_migrations` に記録された）[実測]。
- `supabase db diff` は shadow database（`supabase/config.toml` の `[db] shadow_port`）を使い、
  マイグレーション再生と実 DB の差分を出す。本タスクで「No schema changes found」を実測 [実測]。

## 未確認

- [不明] GitHub Actions の ubuntu ランナーで `supabase start` に必要な Docker イメージの
  取得時間とキャッシュ戦略は未計測。初回はイメージ pull が支配的になる見込み。
