# task_020 の残懸念（cron: 照合・outbox・保持期間・掃除・監査検証）

形式: 指摘 / 深刻度 / 対応案 / 対応予定タスク

G5 敵対レビューは reject（gemini PASS / gpt high 6・medium 1）。修正ラウンド 1 周で
F-1（paid 再照会の二重計上）・F-3（未払い走査の先頭詰まり）・F-4（paid 走査の巡回と truncated）・
F-5（apply-pending の先頭詰まり）を直し、残り（F-2 / F-6 / F-7）は C-020-11〜13 に記録した。再レビューはしない。

## C-020-1 check_043 の「organizer_label が NULL」は現行スキーマで不可能
- 深刻度: medium。`event.organizer_label` は `text NOT NULL`（0001_init.sql:150）。
- 対応: 固定文字列 `(保持期間経過)` への置換で実装（premortem P-03 の対応案の一方）。受入基準は書き換えていない。
- 予定: 列を NULL 可にする migration（task_011 所有）か基準の是正かを PO が決める。

## C-020-2 保持期限の起点が `closed_at` ではなく代理値
- 深刻度: medium。`event` に終了時刻の列が無いため `COALESCE(collect_by_at, event_at, updated_at) + 90 days` を cron が 1 度だけ書く。
- 対応: 期日が入った行は上書きしないので後から揺れない。締切も開催日も無いイベントは更新時刻起点になる。
- 予定: `closed_at` を足す migration（task_011）＋ status 遷移時に書く経路（task_014）。

## C-020-3 audit-verify は「直近 7 日」の窓検証ではない
- 深刻度: medium。`verifyAuditChain` は id 昇順の先頭から見る関数で、窓の入口に `prev_hash` を与える口が無い。
- 対応: 全連鎖（上限 100,000 行）を検証し、超過したら 500 で落として「未検証を緑にしない」。
- 予定: 窓検証関数を `src/lib/audit.ts` に足す（task_018 所有）。

## C-020-4 監査不一致で PAYMENTS_ENABLED を自動で落とせない（P-10）
- 深刻度: medium。`feature_flag.updated_by` の CHECK が `system` / `agent` / `automation` を拒否し、自動書き込みが構造的に禁止されている。
- 対応: cron は 500 とログで検知を可視化するに留め、停止は人が行う（Phase 1 は manual_confirm のみで資金移動が無い）。
- 予定: 自動停止の可否と経路を PO が決める（task_021 / task_023 と併せて）。

## C-020-5 outbox の Phase 1 配達はログのみ
- 深刻度: low。幹事への push（Messaging API）は ADR-007 未決で、生 userId 保持の可否が決まっていない。
- 対応: 幹事が見る要対応は O-9（DB を直接読む画面）。outbox は運用者向けの検知キューとして機能する。
- 予定: task_023（ADR-007）で実配達を足す。

## C-020-6 apply-pending は ledger_dedupe_key を既定規則で復元する
- 深刻度: low。`payment_event` に dedupe_key 列が無いため `<providerKey>:<kind>:<providerEventId>` を組み立て直す。
- 対応: 独自の dedupe_key を宣言するアダプタでは webhook 経路と鍵が変わりうる（Phase 1 の出荷アダプタは該当なし）。
- 予定: 自動アダプタ追加時（task_026 / task_030）に列の追加を検討。

## C-020-7 deferred: Hyperdrive 経路での実測（A21 / P-05 / P-09）
- 深刻度: low（Phase 1 の判定には使わない）。ローカル direct 接続（app_rw）でのみ検証した。
- 対応: advisory lock とプーリングの組み合わせ、`FOR UPDATE SKIP LOCKED` の挙動を実機で確認する。
- 予定: task_035 完了後。

## C-020-8 deferred: 本番での 200 疎通
- 深刻度: low。ローカルは `wrangler dev --test-scheduled` で 6 パス各 1 回の fetch と 404（環境ガード）を確認済み。
- 対応: 本番では 200 が返ること、`reconciliation_run` の鮮度が更新されることを見る。
- 予定: task_025。

## C-020-9 `ReconcileDeps.lockKey` はテスト隔離専用の差し替え口
- 深刻度: low。並列に走るテストファイル同士が本番キーを取り合って偽陽性（`ran: false`）になるのを避けるため。
- 対応: 本番の呼び出し側（Route Handler）は指定せず既定 `RECONCILE_LOCK_KEY` を使う。
- 予定: なし（レビューで注視）。

## C-020-11 保留 Webhook の再適用で受取先 binding の突合が効かない（G5 F-2）
- 深刻度: high。`payment_event` に「受信した binding」の列が無く、`runApplyPending` は
  `external_ref` から試行の binding を引くため `expectedBindingId` を渡せない（W8 が保留経路だけ抜ける）。
- 対応案 / 予定: `payment_event` に受信 binding の列を足す migration（task_011）＋ 受信時に書く（task_018）。

## C-020-12 同じ試行への 2 回目以降の返金が poll の重複として捨てられる（G5 F-6）
- 深刻度: medium。poll の `provider_event_id` は `poll:<provider>:<ref>:<kind>` で金額を含まない。
- 対応: Phase 1 の出荷アダプタ（`manual_confirm`）は `statusQuery` を持たず走査対象外なので発現しない。
- 予定: 実事業者アダプタ（Phase 2 / task_026・task_030）で、スナップショットが累計か差分かを決めて鍵に織り込む。

## C-020-13 timeout は照会を中断しない（G5 F-7）
- 深刻度: medium。`withTimeout` は待つのをやめるだけで、打ち切った枠で次の照会が始まるため実効並列が 5 を超えうる。
- 対応案 / 予定: `StatusQuerier` に `AbortSignal` を渡す契約へ広げる（Phase 2 の実アダプタ導入時）。

## C-020-14 走査 1 の並べ替えは索引で賄えない（索引ギャップの残り）
- 深刻度: medium。`settlement_status` の等値集合に書き換えて `invoice_recon_idx` の Index Cond は効くようになったが
  （EXPLAIN 実測: `Index Scan using invoice_recon_idx`）、`ORDER BY updated_at` の Sort と `payment_attempt` の Seq Scan は残る。
- 予定: `(settlement_rank, lifecycle_state, updated_at)` 相当の索引と試行側の索引を足す migration（task_011）。

## C-020-15 巡回のために毎回 100 行を触る（F-3 / F-4 の代償）
- 深刻度: low。5 分ごとに最大 100 行の no-op UPDATE が出るため、死行が増え autovacuum が要る。
- 予定: `last_reconciled_at` 列（task_011）を足せば触らずに並べ替えられる。監視は task_022。

## C-020-10 P-08（監査ロックと照合の同時実行）の実測は未実施
- 深刻度: medium。`appendAuditLog` のグローバル advisory lock と reconcile バッチの競合は測っていない。
- 対応: 外部照会は並列 5 で先に済ませ、DB 書き込みは 1 トランザクション上で順に行う実装にしてある（ロック保持中に外部 HTTP を呼ばない）。
- 予定: `pg_stat_activity` の `wait_event='advisory'` 計測は task_022 / task_035。
