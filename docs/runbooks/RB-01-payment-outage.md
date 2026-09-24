# RB-01: 決済経路の障害対応

## トリガー

- `/api/health` が `degraded` を返し続ける（DB 疎通不良・reconcile 鮮度悪化・outbox 滞留・
  直近 Webhook 受信の途絶のいずれか）。
- `reconcile_staleness_seconds` が 900 秒を超えている（§17-6）。
- 決済事業者からの Webhook 受信が 1 時間ゼロなのに生きた決済試行（`payment_attempt.is_open`）
  が存在する。

## 手順

1. `GET /api/health` を確認し、`db` / `reconcileStalenessSec` / `outboxOldestSec` /
   `webhookLastSeenSec` のうちどの指標が異常かを特定する。
2. `GET /api/admin/gates`（管理者）で `PAYMENTS_ENABLED` の現在値と直近の変更者を確認する。
3. DB 疎通不良が原因の場合、Cloudflare Hyperdrive / Supabase 側の障害情報を確認する
   （`docs/vendor-docs/cloudflare/hyperdrive.md`）。
4. cron（`workers/cron/`）が正常に `/api/cron/reconcile` 等を呼べているかを確認する
   （task_020 の所有）。
5. Phase 1 は `manual_confirm` のみが出荷アダプタであり、決済事業者側の障害は自動アダプタが
   出荷されるまで発生しない。障害が Phase 1 で起きる場合は本アプリ側（DB・cron・Workers）の
   問題である可能性が高い。
6. 影響が新規の資金移動（`createCheckout` / `provider_binding` 作成）に限られるなら、
   Webhook 受信・照合・`refund` は止めずに様子を見る（§17-5 の原則）。影響が広範なら
   `RB-05-kill-switch.md` の手順で `PAYMENTS_ENABLED=false` を検討する。

## 人間承認が必要な操作

- `PAYMENTS_ENABLED` を書き換える操作そのもの（二人承認。`RB-05` を参照）。
- 障害の「収束」を宣言する判断（運営者代表）。

## 記録先

- `docs/incident-response.md` のレベル分類に従い、SEV1/2 は `docs/HANDOFF.md` に追記する。
- フラグ変更は `audit_log`（`admin.flag.propose` / `admin.flag.approve`）に自動記録される。
