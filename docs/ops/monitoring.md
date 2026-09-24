# 外形監視（`/api/health` のポーリングと degraded 通知）

task_023 の scope「外形監視（無料枠）からのポーリングと通知の実測」に対応する設定手順・
候補の記録。**本書は手順と候補の記録のみであり、実際の設定・実測は未実施**
（理由は下記「未実施の理由」を参照。`docs/task-list.json` task_023 の concerns §5 に deferred
として記録済み）。

## ポーリング対象

- URL: `<デプロイ先ドメイン>/api/health`（`GET`、認証不要）
- 正常応答: HTTP 200、`{"status":"ok", ...}`
- 異常応答: HTTP 503、`{"status":"degraded", "code": "CONFIG_INVALID" | "DEGRADED"}`
  （`code` の内訳は `src/lib/health.ts` / `src/app/api/health/route.ts` を参照。詳細な degraded
  理由は応答ボディに出さない設計のため、外形監視側は「503 かどうか」だけを見ればよい）
- 推奨間隔: 5 分（`reconciliation_run` の鮮度しきい値 900 秒＝15 分より十分短く、少なくとも
  1〜2 回の取りこぼしでも検知できる間隔。§17-6 の `reconcile_staleness_seconds` 900 秒しきい値
  に対して安全マージンを取る）

## 通知経路の候補（無料枠）

| サービス | 無料枠の目安 | 通知手段 | 備考 |
|---|---|---|---|
| UptimeRobot | 50 モニター・5 分間隔まで無料 | Email / Slack Webhook / LINE Notify 等 | HTTP(s) モニターで 503 を down 扱いにできる |
| Healthchecks.io | 20 チェックまで無料（cron 監視寄り） | Email / Slack / Webhook | 本来は「時間内に ping が来ないこと」を見る用途。ポーリング型の外形監視としては UptimeRobot / Better Stack の方が素直 |
| Better Stack (旧 Better Uptime) | 10 モニターまで無料 | Email / Slack / Webhook | ステータスページも無料枠に含まれる |
| Cloudflare 自前（Workers Cron + `fetch`） | Cloudflare 契約内（追加費用なし） | 任意（メール送信サービス経由等） | 外部サービスに依存しないが、Worker 自身が落ちた場合は自己監視できない。**外形監視は監視対象と異なるインフラで動かす原則に反するため、単独では採用しない**（他の候補と併用する場合のみ可） |

**実際に選ぶサービスは、staging 環境がデプロイされ外部から到達可能な URL を持つ時点
（`task_024`「本番環境分離」以降、または `task_003` が言及する staging 固定カスタムドメイン）
で確定し、本書の「実施記録」に追記する。**

## degraded 時の通知経路

- 一次通知: 上表いずれかのサービスから運営者（NonTurn LLC）宛のメール、または Slack Webhook。
- 幹事への通知はここでは扱わない。幹事向けの要対応通知は Messaging API 経由の配達（scope）で、
  ADR-007（`docs/decisions/ADR-007-raw-userid-consent.md`）の PO 決定待ち。外形監視の degraded
  通知は**運営者向け**（サービス全体の異常）であり、個々の要対応（mismatch 等）の幹事通知とは
  別物である。
- `docs/implementation-plan.md` §17-5「キルスイッチ」との関係: `/api/health` の degraded は
  自動で `PAYMENTS_ENABLED=false` にはしない（キルスイッチの発火条件は同 §17-5 に列挙された
  8 項目のみ）。degraded は「調べる」トリガーであり、「止める」トリガーではない。

## 未実施の理由

- 外形監視サービスへの登録・Webhook 設定・実際のポーリングには、監視対象となる公開 URL
  （staging または本番のデプロイ先）が必要である。ローカルの `wrangler deploy` は
  `scripts/deny-dangerous-bash.sh`（`docs/implementation-plan.md` §16-4）が常に遮断し、
  デプロイは `.github/workflows/release.yml`（CI）経由のみ許可される。
- したがって「外形監視から通知が届くことを 1 回実測する」（task_023 の `done_definition` 第 3 項 /
  `check_114` の manual 部分）は、CI 経由のデプロイが行われたあとでなければ実行できない。
- 本タスクではこの実測を `docs/concerns/task_023.md` に deferred として記録し、代わりに
  `/api/health` の degraded 判定ロジック自体（`src/lib/health.ts`）を `tests/unit/health.test.ts`
  の合成行テストで検証した（自動化された部分の check_114 は満たす。手動実測の部分は未達）。

## 実施記録

（未実施。実施したら以下の形式で追記する: 実施日 [実測] / 選定したサービス / ポーリング間隔 /
degraded を意図的に発生させた方法 / 通知が届くまでの時間 / 通知の受信先）
