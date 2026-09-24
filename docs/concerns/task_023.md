# task_023 残懸念

Messaging API チャネル・幹事向け要対応通知（outbox 配達）・依存先込み health・外形監視
（`docs/implementation-plan.md` §7-3, §7-7, §17-6、`docs/research/premortem-phase1b-2026-09-24.md`
P-10 / P-11 / P-12、`check_113` / `check_114` / `check_115`）。

書式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。**実装コミットは 0 件（BLOCKED のため）。**

---

## 1. 依存タスク task_020 が完全に未着手で、outbox 配達・health degraded の producer 側が無い

- **指摘**: task_023 は `dependencies: ["task_020"]` だが、task_020（cron: 照合バッチ・outbox 配達・
  保持期間・冪等キー掃除・監査検証）は `git log --all --grep=task_020:` が 0 件（`--grep=task_020`
  単独では `4db5e7a`／`06f1d73` にヒットするが、いずれも本文中の他タスク言及であり実装コミットでは
  ないことをコミット本文で確認済み）、`files_to_create` 16 本（`src/lib/reconcile.ts` /
  `src/lib/retention.ts` / `src/lib/cron-auth.ts` / `src/app/api/cron/**/route.ts` 6 本 /
  `tests/integration/{reconcile,reconcile-load,outbox,retention,apply-pending,cleanup}.test.ts` 等）
  が実測で 0 件（`find src/lib/reconcile.ts src/lib/retention.ts src/lib/cron-auth.ts
  src/app/api/cron` はすべて not found）。`docs/PROGRESS.md` にも task_020 の完了宣言行は無い。
  `npm run gate:constraints` 自身が `defer W9 (0 targets; waiting on task_020)` /
  `defer W11 (0 targets; waiting on task_020)` と出力し独立に裏付ける。task_023 の
  `done_definition` 3 項目のうち「health.test.ts で 4 条件の degraded」が参照する
  `reconciliation_run` 鮮度・`outbox` 滞留・`open attempt` と Webhook 受信の突合は、
  DB スキーマ自体（`reconciliation_run` / `outbox` / `payment_attempt` / `webhook_delivery`）は
  既存マイグレーションに存在するため読み取りだけなら構築できるが、**実際にこれらの行を
  発生させる書き込み側（reconcile バッチ・outbox 投入・Webhook 受信）が task_018 / task_020 の
  files_to_create であり存在しない**ため、`check_113`（`mismatch / paid_after_void / orphan /
  overpay / 支払手段なし を発生させる`）と `check_115`（要対応 1 件発生後の E2E）は
  構造的に満たせない。
- **深刻度**: high（`done_definition` の中核である配達の実測と、受入基準 `check_113` /
  `check_115` が構造的に満たせない）
- **対応案**: task_020（および task_020 の依存元 task_018）を先に完了させる。health.ts の
  読み取り側（DB 疎通・`reconciliation_run` 鮮度 900 秒・`outbox` 最古 24h・open attempt と
  webhook 1h 突合）は task_020 の書き込み側と独立に着手可能なため、次回 task_023 再着手時は
  まずそこから実装し、`tests/unit/health.test.ts` に 4 条件のユニットテスト（synthetic な
  DB 行で検証）を足すところから始めるとよい。
- **対応予定タスク**: task_018 → task_020（先行）→ task_023 再着手

## 2. task_018 の outbox 基盤が同一ワークツリーで並行ドラフト中で、`kind`→配達先の抽象度が
   task_023 の前提（`line_messaging` / `internal_webhook` / `none`）と食い違っている

- **指摘**: 本セッション中に別エージェント（task_018 担当）が `src/lib/outbox.ts` と
  `src/lib/ledger/{apply,rank,balance,dedupe}.ts` を同一ワークツリーに未コミットで書き始めた
  ことを実測した（`git status --short` に `?? src/lib/outbox.ts` 等。コミットは無い＝
  `docs/PROGRESS.md` / `git log` 基準では「完了していない」ため §1 の判断を変えない）。
  中身を読むと（他タスクのファイルは変更しない規約のため read-only で確認）、`outbox.ts` は
  `OutboxTransport = "organizer_notify" | "ops_alert"` という**2 段の抽象配達先**を正本にし、
  `OUTBOX_TRANSPORT` 表で `mismatch_alert` / `orphan_alert` / `overpay_alert` /
  `paid_after_void` / `dispute_alert` を全て `"ops_alert"` に、`payment_detected` だけを
  `"organizer_notify"` に割り当てている。さらに `organizer_notify` の docstring が
  **「幹事本人への通知（Phase 3 の Messaging API / Phase 1 は画面内の要対応）」**と明記しており、
  task_023 自身の目標（「要対応が幹事に LINE 公式アカウント経由で届く」＝ Phase 1 で
  Messaging API 配達）と Phase 帰属が食い違う。task_023 の scope 文言
  「outbox の transport 実装（`line_messaging` / `internal_webhook` / `none`）」は
  `outbox.ts`（task_018 所有・`files_to_modify` ではなく前提として存在する想定）とは異なる
  語彙・異なる抽象度で設計されており、`OUTBOX_TRANSPORT` の正本が `outbox.ts` 側にある以上
  `src/lib/outbox-transports.ts` を今書くと、(a) `kind` の集合を task_018 と二重管理する、
  (b) Phase 1 で Messaging API 配達を実装した場合 task_018 の docstring（Phase 3 想定）と
  矛盾する、のどちらかになる。
- **深刻度**: high（未コミット・進行中の他タスクの設計と競合するコードを書くと、
  task_018 が着地した時点で作り直しになる。§1 と独立に単独でも着手を止める理由になる）
- **対応案**: task_018 が確定コミットされてから、`outbox.ts` の `OUTBOX_TRANSPORT` 表
  （`organizer_notify` / `ops_alert`）を正本として受け取り、task_023 は
  `organizer_notify` → 具体的な配達手段（Phase 1: O-2 バッジ実装は既に task_014 で完了済み
  ／Phase 1 で Messaging API 配達まで前倒しするかは ADR-007 の PO 決定と、`outbox.ts` の
  「Phase 3」という現在の想定を明示的に上書きする ADR 上の合意が必要）、`ops_alert` →
  `internal_webhook`（PII なし）の**具体実装だけ**を `src/lib/outbox-transports.ts` に書く
  形に scope を絞り直す。
- **対応予定タスク**: task_018（着地待ち）→ ADR-007 の PO 決定 → task_023 再着手

## 3. ADR-007（幹事の生 LINE userId 保持の同意設計）が未作成で、PO 決定が前提

- **指摘**: `docs/research/premortem-phase1b-2026-09-24.md` P-12（S2 × high）が指摘する通り、
  Messaging API の push には**生の LINE userId** が必要だが、`docs/implementation-plan.md`
  §7-5 は「生値を保存しない。`line_user_ref`（HMAC）のみ」と定めている。task_023 の
  `implementation_steps` は「ADR-007 で幹事の生 userId 保持の同意フローを先に設計」とあるが、
  ADR-007 は本セッション開始時点で未作成（`docs/decisions/ADR-007-raw-userid-consent.md` が
  存在しない）。P-12 の対応案は「(a) 生 userId を保持する、(b) 保持せず outbox は運営者向け
  内部通知だけにして幹事には O-2 バッジで気づかせる」の二択を **PO が決める**ことを明示しており、
  どちらを採るかで `src/lib/line/messaging.ts` の実装（何を受け取り何を永続化するか）が根本的に
  変わる。PII の新規保存を伴う設計判断を実装者が代わりに決めることは、G0-USER 相当の
  ガバナンス（task_001 の ADR-001 と同型）を迂回することになるため行わなかった。
- **深刻度**: high（L1 / L2 / L9 相当の PII 保存可否判断。実装者の裁量を超える）
- **対応案**: task_023 再着手前に ADR-007 を PO 判断つきで起票する（`docs/decisions/
  ADR-001-funds-flow.md` / `ADR-010-q-lg1-negative-branch.md` と同じ AskUserQuestion の型）。
  (a) を選ぶ場合は新規カラム・擬似匿名化対象表への追加・PEPPER ローテーション設計への
  組み込みが追加スコープとして発生する（§7-5 の改訂を伴うため task_023 単体には収まらない
  可能性が高い）。(b) を選ぶ場合は「Phase 1 では要対応が幹事に push されない」ことを
  縮退運転として規約・O-13 に明記する。
- **対応予定タスク**: PO 判断（ADR-007）→ task_023 再着手

## 4. `check_115`（attention_unseen_hours の計測）は週次ログ集計パイプラインを前提にしており、
   どのタスクにも所有者が無い

- **指摘**: `check_115` の `expected_result` は「発生から幹事の閲覧までの時間が **weekly
  メトリクス**に出る」で、`verification_method` は `npm run test:e2e（organizer-flow.spec.ts）`。
  `docs/implementation-plan.md` §17-6 は `attention_unseen_hours_p95` の実装先を
  「ログ集計 ＋ 週次 `docs/metrics/`」と明記しており、これは DB の 1 クエリで出せる値ではなく
  ログ集計・週次バッチという未着手のオブザーバビリティ基盤を要求する。
  `tests/e2e/organizer-flow.spec.ts` は存在せず（`tests/e2e/` には task_003 が置いた
  `smoke.spec.ts` のみ）、週次集計バッチも `docs/metrics/` ディレクトリもリポジトリに存在しない。
  `docs/task-list.json` を通覧した限り、この週次集計パイプライン自体を `files_to_create` に
  持つタスクが見当たらない（P-10「監査連鎖の不一致を検知しても、止める配線がどのタスクにも
  無い」と同型の欠落）。
- **深刻度**: medium（`check_115` は task_023 の `acceptance_check_ids` に含まれるが、
  `done_definition` 自体には「weekly メトリクス」という文言が無く、`attention_unseen_hours`
  の**計測ロジックの実装**は `done_definition` の範囲内と読める一方、**週次レポートへの出力**は
  観測基盤タスクの不在という上位の計画ギャップである）
- **対応案**: `docs/task-list.json` の次回改訂（PO 判断）で、週次ログ集計バッチと
  `docs/metrics/` 出力を専任タスクとして切り出す。task_023 は `attention_unseen_hours` の
  **単発計測（O-4 の閲覧時刻と要対応発生時刻の差分を返す API ないし内部関数）**までを
  スコープとし、週次集計と `organizer-flow.spec.ts` は当該タスクへ委譲する形に
  `done_definition` を改訂することを提案する。
- **対応予定タスク**: 未定（新規タスク切り出しが PO 判断）→ task_023 再着手
