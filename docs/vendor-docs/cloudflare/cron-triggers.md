# Cloudflare Cron Triggers — 一次資料退避

**取得日: 2026-09-25（task_020 実施時点）。取得方法: WebFetch で developers.cloudflare.com を直接取得。
以下の引用は原文からの抜粋（英語部分は原文ママ）。原文に書かれていない事項は「[不明]」と明記し、推測で埋めない。**

出典:
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/

## 1. 設定（`wrangler.toml`）

```toml
[triggers]
crons = [ "*/3 * * * *", "0 15 1 * *" ]
```

- cron 式は **5 フィールド**（minute / hour / day-of-month / month / weekday）。
- デプロイ時、**`triggers` 配列に書かれていない既存の Cron Trigger は置き換えられて消える**
  （原文: "any previous Cron Triggers are replaced with those specified in the `triggers` array."）。
  → 本リポジトリでは `workers/cron/wrangler.toml` の `[triggers] crons` が唯一の正本。

## 2. 最小間隔

- 原文に**最小間隔の明記は無い**（例として `*/3 * * * *` が示されるのみ）。[不明]
- ただし CPU 時間の上限が「1 時間未満の間隔」と「1 時間以上の間隔」で分かれている（下記）ため、
  1 分間隔（`* * * * *`）が構文上・制限表上とも排除されてはいない。本プロジェクトの
  `/api/cron/outbox`（1 分）はこの前提に立つ。**実機での 1 分間隔の動作確認は task_025 で行う**。

## 3. 制限（Limits ページ）

| 項目 | Free | Paid |
|---|---|---|
| Number of Cron Triggers per account | 5 | 250 |
| CPU time（Cron Triggers） | 10 ms | 30 seconds (< 1 hour interval) / 15 min (>= 1 hour interval) |
| Duration（wall-clock） | 15 min | 15 min |

- **アカウント単位で 250**（Worker 単位ではない）。本プロジェクトは 6 本使う。
- Free プランの CPU 10 ms では本プロジェクトの照合バッチは成立しない → **Paid 前提**。

## 4. リトライ・同時実行

- リトライ: 原文には `controller.noRetry()` を呼ぶと `noRetry` が `true` になる、という記述があるのみで、
  **既定のリトライ回数・間隔は書かれていない**。[不明]
- 同時実行（前回の実行が終わる前に次の cron が発火するか）: **原文に記述が無い**。[不明]
  → 本プロジェクトは「重なりうる」前提で設計する。`/api/cron/reconcile` は
  `pg_try_advisory_xact_lock` を取り、取れなければ即 no-op で返す（W11 / R-OPS-08）。
  ロックは**トランザクションスコープ**なので、実行が途中で打ち切られてもロックは残らない。

## 5. ローカルでの手動発火

`wrangler dev --test-scheduled` の原文:

> "Exposes a `/cdn-cgi/local/scheduled` fetch route which will trigger a scheduled event (Cron Trigger)
> for testing during development. To simulate different cron patterns, a `cron` query parameter can be
> passed in: `/cdn-cgi/local/scheduled?cron=*+*+*+*+*`."

- パスは **`/cdn-cgi/local/scheduled`**（`__scheduled` ではない）。
- `cron` クエリは**スペースを `+` に置換**して渡す。`?format=json` / `?time=<epoch ms>` も取れる。

使用例（本リポジトリ）:

```sh
cd workers/cron && npx wrangler dev --test-scheduled --port 8788
curl 'http://127.0.0.1:8788/cdn-cgi/local/scheduled?cron=*/5+*+*+*+*'   # reconcile
```

## 6. 本プロジェクトでの適用

- cron Worker（`workers/cron/`）は状態を持たず、`[triggers] crons` の各パターンに 1:1 で対応する
  本体の `/api/cron/*` を `X-Cron-Secret`（`CRON_SECRETS` の**先頭値**）付きで 1 回だけ呼ぶ。
- 本体側は `APP_ENV !== 'production'` で**無条件 404**（§7-7）。したがってローカルの
  `--test-scheduled` では 404 が正しい応答であり、200 が返ったら環境ガードの破れである。
- cron の生存監視は cron 自身ではなく `reconciliation_run` の鮮度で外形から行う（§7-7 / task_023）。
