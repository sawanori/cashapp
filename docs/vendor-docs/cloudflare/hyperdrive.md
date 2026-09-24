# Cloudflare Hyperdrive — 一次資料退避

**取得日: 2026-09-24（本タスク task_003 実施時点）。取得方法: WebFetch 経由で developers.cloudflare.com を直接取得（要約はモデル生成だが、原文からの抜粋として扱い、疑わしい固有名詞は複数ページで裏取りした）。**

## ローカル開発（`wrangler dev`）時の接続

出典: https://developers.cloudflare.com/hyperdrive/configuration/local-development/

`wrangler dev`（デフォルトモード）では、Worker コードはローカルマシン上で動作し、
`localConnectionString` で指定した接続文字列を使って DB に直接つなぐ。**この経路では
Hyperdrive のクエリキャッシュは効かない**（Hyperdrive のインフラを経由しないため）。

設定方法は 2 通りあり、後者が推奨:

### 方法 1: `wrangler.toml` に直接書く

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "c020574a-5623-407b-be0c-cd192bab9545"   # 例。実 ID は task_035 で発行
localConnectionString = "postgres://user:password@localhost:5432/databasename"
```

必須フィールド:
- `binding` — Worker から参照するバインディング名
- `id` — Hyperdrive 設定 ID（`wrangler hyperdrive create` で発行。**未発行の間はプレースホルダ**）
- `localConnectionString` — ローカル（または任意の直接）接続文字列

### 方法 2: 環境変数（推奨。秘密値を `wrangler.toml` に書かずに済む）

```sh
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://user:password@localhost:5432/databasename"
npx wrangler dev
```

命名規則は `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING名>`。
**環境変数はファイル設定より優先される。**

## 本プロジェクトでの適用

- バインディング名は `HYPERDRIVE` に統一する。
- ローカルの参照先は `supabase start` が起動するローカル Postgres（既定ポート `54322`、
  ユーザー/パスワードとも既定 `postgres`）。実際の起動確認は task_011 の担当（本タスクは
  Supabase プロジェクト作成が non_scope）。
- `wrangler.toml` の `[[hyperdrive]]` の `id` は `id = "REPLACE_WITH_HYPERDRIVE_ID_TASK_035"` の
  プレースホルダとし、task_035 で実 ID に置き換える（task-list task_003 の指示どおり）。
- 秘密値になり得る接続文字列（パスワード込み）は `wrangler.toml` に直書きせず、方法 2 の環境変数、
  または `.dev.vars`（本番は `wrangler secret put`）で扱う方針にする。ローカル開発では
  `localConnectionString` にダミーの既定クレデンシャル（`postgres:postgres`）を使う限りは
  秘匿性の実害は小さいが、本番相当の値を `wrangler.toml` にコミットしない規律は維持する。

## 未確認・要フォローアップ

- [不明] transaction モードの advisory lock 制約（`pg_try_advisory_lock` がセッションスコープで
  Supavisor transaction モードと相性が悪い件、premortem R-OPS-08）は Hyperdrive 経由の接続
  プーリング方式とどう組み合わさるか、Hyperdrive 自体のプーリング挙動の一次資料は未取得。
  task_011 で `pg_try_advisory_xact_lock`（トランザクションスコープ）採用の前提を Hyperdrive
  接続時に再確認すること。
