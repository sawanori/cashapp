# OpenNext for Cloudflare / Worker サイズ・Cron Triggers — 一次資料退避

**取得日: 2026-09-24（本タスク task_003 実施時点）。**
**取得方法: (a) npm レジストリから `@opennextjs/cloudflare@1.20.6` の `package.json` /
型定義（`peerDependencies` 等）を直接読み取り〈最も確度が高い一次情報〉。
(b) WebFetch 経由で opennext.js.org / developers.cloudflare.com を直接取得。**

## (a) `@opennextjs/cloudflare@1.20.6` の実測メタデータ

```json
{
  "peerDependencies": {
    "next": ">=15.5.24 <16 || >=16.3.3",
    "wrangler": "^4.125.0"
  }
}
```

→ 採用した `next@16.3.6` は `>=16.3.3` を満たす。`wrangler@4.137.0` は `^4.125.0` を満たす。
（ADR-002 参照。本プロジェクトはこの実測に基づき Next.js 16.3.6 を採用した。）

CLI（`opennextjs-cloudflare`）のサブコマンド（`--help` 実測）: `build` / `preview` / `deploy` /
`upload` / `populateCache` / `migrate`。**`deploy` は禁止コマンド（wrangler deploy 相当）につき
本プロジェクトでは呼ばない。** `npm run build:cf` は `build` のみを呼ぶ。ローカル確認は
`wrangler dev`（`npm run cf:dev`）を別途叩く方針（task-list task_003 の指示に合わせた）。

## (b) `wrangler.toml` 最小構成（出典: https://opennext.js.org/cloudflare/get-started）

必須フィールド（要約。フィールド名は原文どおり）:

- `main`: `.open-next/worker.js`
- `name`: アプリ名
- `compatibility_date`: 最低 `2024-09-23` 以降
- `compatibility_flags`: `nodejs_compat` と `global_fetch_strictly_public` を含める
- `assets`: `{ directory: ".open-next/assets", binding: "ASSETS" }`
- `services`: 自己参照バインディング `WORKER_SELF_REFERENCE`（ISR 再検証などの自己 fetch に使用）

`global_fetch_strictly_public` は実在するフラグであることを
https://developers.cloudflare.com/workers/configuration/compatibility-flags/ で再確認済み
（「有効にするとグローバル `fetch()` は常にパブリックインターネット向けのリクエストとして
ルーティングされる」）。

## (b) Worker サイズ上限（出典: https://developers.cloudflare.com/workers/platform/limits/）

- Worker サイズ（uncompressed）: **64 MiB**。Free / Paid で同一。
- 「圧縮後サイズの上限は無い。カウントされるのは非圧縮のバンドルサイズのみ」との明記あり
  （デプロイ時に表示される gzip 参考値は上限判定に使われない）。
- Worker 起動時間の上限: 1 秒（Free / Paid 同一）。

→ **A25 の上限値はこれを正とする: 64 MiB（非圧縮）。run-log に記録する `.open-next` の
Worker サイズが、この 64 MiB の 80%（約 51.2 MiB）未満であることを確認する
（`docs/acceptance-checks.json` check_040）。**

## (b) Cron Triggers（出典: https://developers.cloudflare.com/workers/configuration/cron-triggers/
および platform/limits/）

- `wrangler.toml` の `[triggers] crons = [ "..." ]` に cron 式の配列を書く。
- アカウントあたりの Cron Triggers 上限: Free 5 / **Paid 250**。本プロジェクトが必要とする
  5 本（`reconcile` 5分 / `outbox` 1分 / `retention` 日次 / `idempotency-cleanup` 日次 /
  `audit-verify` 日次。§7-7）は Paid の上限に対し余裕がある。
- [不明] cron 式の最小間隔（ドキュメント上に明記が見つからなかった。実例は `*/3 * * * *`
  「3分ごと」まで確認できたが下限の明記なし）。
- [不明] スケジュール実行が失敗した場合の自動リトライ回数・バックオフの詳細
  （`controller.noRetry()` の存在は確認できたが、既定のリトライ仕様は一次資料から確認できず）。
  → 照合ジョブの冪等性（R-OPS-08 の `pg_try_advisory_xact_lock` 採用）は「リトライされても
  安全」を前提に設計されているため、リトライ回数が未確定でも安全側に倒れる設計にはなっている。
  ただし正確な挙動は task_012/018 実装時に再取得すること。

## Smart Placement（出典: https://developers.cloudflare.com/workers/configuration/smart-placement/）

```toml
[placement]
mode = "smart"
```

デプロイ後、最適化が効き始めるまで最大 15 分かかる旨の記載あり。

## `wrangler.toml` のその他フィールド構文（出典: developers.cloudflare.com/workers/wrangler/configuration/）

```toml
[limits]
cpu_ms = 100

[env.staging]
name = "my-worker-staging"

[env.staging.vars]
MY_VARIABLE = "staging variable"
```
