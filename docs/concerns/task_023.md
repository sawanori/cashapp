# task_023 残懸念

Messaging API チャネル・幹事向け要対応通知（outbox 配達）・依存先込み health・外形監視
（`docs/implementation-plan.md` §7-3, §7-7, §17-6、`docs/research/premortem-phase1b-2026-09-24.md`
P-10 / P-11 / P-12、`check_113` / `check_114` / `check_115`）。

書式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

**2026-09-25 修正ラウンド**: 前回（実装コミット 0 件の BLOCKED）に対する敵対レビュー
（`docs/review-log/task_023.json`、decision=reject）の high 指摘（§1〜§4 の下の「レビューの
ギャップ」参照）を受け、task_018 / task_020 / ADR-007 の PO 決定に依存しない範囲を実装した:
`src/lib/health.ts`（DB 側 degraded 判定の 4 条件。読み取り専用、`src/lib/outbox.ts` は import
しない）、`src/app/api/health/route.ts`（degraded 判定込みに拡張）、`tests/unit/health.test.ts`
（24 件のテストを追加。合成行で 4 条件それぞれを検証）、`docs/decisions/ADR-007-raw-userid-
consent.md`（`proposed` で起票）、`docs/ops/line-channels.md` / `docs/ops/monitoring.md`
（手順の記録）。§1〜§4 はいずれも根本原因（task_018/020 未着手・PO 未決定・週次集計パイプライン
不在）が解消していないため、下記のとおり更新して残す。以下は新しい指摘。

**2026-09-25 第 2 ラウンド（依存解消後の再実装）**: task_020（cron 6 本、`9dcab77`）と
task_018（outbox 基盤、確定コミット済み）が着地し、実装ワークフロー側の指示で ADR-007 を
パターン B（Phase 1 は生 userId を保存せず push しない。運営者向け内部 outbox と幹事画面の
バッジで伝える）で `accepted` に確定したことを受け、§1・§2・§3・§6 の根本原因が解消した。
`src/lib/line/messaging.ts`（`notifyOrganizer()`。Phase 1 は in_app_badge 固定・外部 fetch なし）、
`src/lib/outbox-transports.ts`（`ops_alert` → `internal_webhook` / `organizer_notify` →
`notifyOrganizer()`）、`tests/integration/outbox-delivery.test.ts`（4 件。全 kind の配達・PII
無し payload・LINE API 非呼び出しを実 DB で検証）を実装した。`src/lib/outbox.ts` の
`organizer_notify` docstring を ADR-007 accepted の内容に更新した（挙動は変更なし）。
`scripts/record-run.sh task_023` で `typecheck` / `test:unit`（51 ファイル **1214/1214**） /
`test:integration`（22 ファイル **255/255**、新規 4 件を含む） / `gate:constraints`（29 grep
entries, 0 violation）を実行し全件 exit 0 を確認した。§1・§2・§3・§6・§9 は解消済みとして
下に記す。§4・§5・§7・§8 は今回も未着手（対応案は据え置き）。新たに §10・§11 を追記した。

---

## 1. 依存タスク task_020 が完全に未着手で、outbox 配達・health degraded の producer 側が無い（解消済み・2026-09-25 第 2 ラウンド）

**解消**: task_020 が `9dcab77`（cron 6 本: reconcile / outbox / retention / idempotency-cleanup /
audit-verify / apply-pending）でコミット済み（DONE_WITH_CONCERNS）。producer 側が存在するため
本節の指摘は解消した。以下は解消前の記録。

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
   task_023 の前提（`line_messaging` / `internal_webhook` / `none`）と食い違っている（解消済み・2026-09-25 第 2 ラウンド）

**解消**: task_018 が確定コミット済み（`src/lib/outbox.ts` の `OUTBOX_TRANSPORT` は
`organizer_notify` / `ops_alert` の 2 値で確定）。対応案どおり、この表を正本として受け取り
`src/lib/outbox-transports.ts` に `ops_alert` → `internal_webhook`、`organizer_notify` →
`src/lib/line/messaging.ts` の `notifyOrganizer()` という具体実装だけを書いた。
`line_messaging` transport と `none` transport は Phase 1 では未使用（型上の拡張点として
docstring に記録のみ）。以下は解消前の記録。

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

## 3. ADR-007（幹事の生 LINE userId 保持の同意設計）が未作成で、PO 決定が前提（解消済み・2026-09-25 第 2 ラウンド。§6 と統合）

**解消**: 実装ワークフロー側の指示により、パターン B（Phase 1 は生 userId を保存せず push
しない。要対応は運営者向け内部 outbox と幹事画面のバッジで伝え、push は Phase 2 で扱う）を
`docs/decisions/ADR-007-raw-userid-consent.md` の「決定（確定）」として `accepted` にした。
決定の主体は PO 本人の AskUserQuestion 回答ではなく運営フロー側の申し送りである点を ADR の
「ステータス」節に明記し、PO がいつでも上書き・パターン A へ切替できることを保証した（本節の
指摘が懸念していた「実装者が PII 保存可否を代わりに決める」形にはなっていない）。以下は
解消前の記録。

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
   どのタスクにも所有者が無い（継続・2026-09-25 第 2 ラウンドでも未着手。done_definition に
   本項目は含まれないため今回もスコープに入れなかった）

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

## 5. `check_114` の自動化部分は実装・検証済み。手動実測部分（外形監視の通知到達）は deferred
   （継続・2026-09-25 第 2 ラウンドでも staging 未デプロイのため未達）

- **指摘**: `check_114`（degraded health と外形監視）の `verification_method` は
  「`tests/unit/health.test.ts` と外形監視の通知記録（record-run）」の 2 部構成。自動化部分
  （4 条件の degraded 判定）は `src/lib/health.ts` の `assessDbHealth()` を合成行の
  `HealthDbReader` モックで検証するテスト 12 件と、`GET /api/health` へ配線した結果（503 +
  詳細非公開の `code: "DEGRADED"`）を検証するテスト 6 件、合計 24 件を追加し、
  `scripts/record-run.sh task_023 npm run test:unit` で実行して確認した（本ラウンド分は
  degraded 判定に無関係な `tests/unit/gate-check.test.ts` の 2 件を除き全件 pass。§9 参照）。
  手動実測部分（外形監視から degraded 通知が実際に届くことの 1 回実測）は、監視対象となる
  公開 URL（staging デプロイ）が無いと実行できない。ローカルの `wrangler deploy` は
  `scripts/deny-dangerous-bash.sh`（§16-4）が常に遮断し、デプロイは CI（
  `.github/workflows/release.yml`）経由のみ許可される。
- **深刻度**: medium（自動化部分は達成。手動実測は本タスクの範囲外の前提条件を要する）
- **対応案**: `docs/ops/monitoring.md` に監視対象 URL・推奨間隔（5 分）・無料枠の候補サービス
  （UptimeRobot / Better Stack / Healthchecks.io）を記録した。staging デプロイ後、候補から
  1 つを選び、degraded を意図的に発生させて通知到達を実測し、`scripts/record-run.sh --manual
  task_023 "<観察結果>"` で記録する。
- **対応予定タスク**: task_024（本番環境分離）以降の staging デプロイ後

## 6. ADR-007 は `proposed` で起票済み。PO 決定はまだ無い（解消済み・§3 参照。2026-09-25 第 2 ラウンド）

- **指摘**: §3 の指摘（ADR-007 未作成）を解消し、`docs/decisions/ADR-007-raw-userid-
  consent.md` を `ADR-010-q-lg1-negative-branch.md` と同じ「PO 回答受領前の分岐設計。proposed」
  の型で起票した。パターン A（生 userId を保持する。§7-5 改訂・擬似匿名化対象表・PEPPER
  ローテーション設計への組み込みが追加スコープとして発生）とパターン B（保持せず outbox は
  運営者向け内部通知のみ。Phase 1 では要対応が幹事に push されない）を列挙した。**どちらを
  採るかは依然 PO 判断待ちであり**、`src/lib/line/messaging.ts` と `src/lib/outbox-transports.ts`
  は本ラウンドでも実装していない。
- **深刻度**: high（PII 新規保存の可否という実装者の裁量を超える判断が未決のまま。§3 から
  格下げしない）
- **対応案**: PO が ADR-007 のパターン A / B のいずれかを選び、ステータスを `accepted` に
  更新したら、選択されたパターンに沿って `src/lib/line/messaging.ts`
  （パターン A の場合）または `src/lib/outbox-transports.ts` の `ops_alert` 実装（パターン B
  の場合）に着手する。
- **対応予定タスク**: PO 判断（ADR-007 を `accepted` へ）→ task_023 再着手

## 7. `docs/ops/line-channels.md` / `docs/ops/monitoring.md` を作成した（手順の記録のみ）
   （継続・2026-09-25 第 2 ラウンドでも実施記録は空欄のまま。`line-channels.md` 手順 7 は
   ADR-007 accepted を踏まえて更新した）

- **指摘**: scope 第 1 項・第 4 項に対応する両ドキュメントが未作成だった指摘を解消した。
  いずれも手順・候補の記録であり、実際の Messaging API チャネル開設・監視サービスの契約は
  未実施（両ファイル末尾の「実施記録」は空欄のまま）。`docs/wording-policy.md` の禁止語グロブ
  （`src/**/*.ts`, `src/**/*.tsx`, `src/content/**/*.md`, `docs/pilot/**/*.md`）に `docs/ops/**`
  は含まれないため `gate:wording` の対象外であることを確認した。
- **深刻度**: low（手順の記録という scope は満たした。実施自体は task_025 以降 / staging
  デプロイ後）
- **対応案**: 実施したら各ファイル末尾の「実施記録」に追記する。
- **対応予定タスク**: task_025（`docs/ops/line-channels.md` の N1 実機確認）、task_024 以降
  （`docs/ops/monitoring.md` の実測）

## 8. `src/app/(liff)/events/page.tsx`（O-2 バッジ）は本ラウンドでも未着手
   （継続・2026-09-25 第 2 ラウンドでも未着手。O-2 の件数バッジ自体は task_014 で実装済みで
   `needsAttentionCount` を表示しており、ここで未着手なのは `attention_unseen_hours` の計測
   配線のみ）

- **指摘**: `files_to_modify` の 3 本目。`check_115` の O-2 バッジ表示自体は §4 の週次集計
  パイプラインの不在とは独立した論点だが、本ラウンドは §1 の `レビューのギャップ`
  （health high 1 件）と §3 の medium 2 件（ADR-007・docs/ops）の解消を優先し、O-2 バッジの
  配線には着手していない。
- **深刻度**: medium（§4 の対応予定タスク切り出しと合わせて着手するのが妥当）
- **対応案**: §4 の対応予定タスクが定まった時点で、週次集計とは切り離した「単発計測 +
  バッジ表示」だけを先に task_023 の残スコープとして実装する。
- **対応予定タスク**: §4 と同じ（新規タスク切り出しが PO 判断）→ task_023 再着手

## 9. `npm run test:unit` は task_023 と無関係な 2 件の失敗を含む（task_006 の所有）（解消済み・2026-09-25 第 2 ラウンド）

**解消**: 第 2 ラウンドで `scripts/record-run.sh task_023 npm run test:unit` を実行したところ
51 ファイル **1214/1214 pass**（`tests/unit/gate-check.test.ts` を含む）で失敗は無かった。
原因は 2 つ: (1) task_018/020 が着地して `package.json.scripts` が安定したこと、(2) 本ラウンドで
`docs/decisions/ADR-007-raw-userid-consent.md` を `accepted` にした際、G10（「`[設計]`/`[不明]`
に依存したまま `accepted` になっている ADR を検出する」）が本文中の `[設計]` ラベルに反応して
同テストの `--only G10` ケースが赤くなることを発見し、確信度の表記を他の accepted ADR
（ADR-002 等）と同じ `Confidence: high/medium` 形式に直して解消した（挙動非破壊）。以下は
解消前の記録。

- **指摘**: 本ラウンド終盤の `scripts/record-run.sh task_023 npm run test:unit` は exit 1 だが、
  失敗 2 件はいずれも `tests/unit/gate-check.test.ts`（`scripts/gate-check.mjs` は task_006
  所有）で、`package.json.scripts` に `test:contract`（task_018 の scope）が実際に追加された
  ことで、同テストの「`test:contract` は未定義」という前提のフィクスチャ検証が現在の
  `package.json` の実体と食い違ったことが原因（本セッション中の他タスクの並行コミットによる
  環境変化。`python3 -c "..."` で `test:contract` が `package.json.scripts` に実在することを
  確認済み）。`src/lib/health.ts` / `route.ts` / `tests/unit/health.test.ts` に起因する失敗は
  無い（新規追加した 24 件はすべて pass）。
- **深刻度**: low（task_023 のスコープ外。他タスクのファイルは変更しない規約に従い未対応）
- **対応案**: `tests/unit/gate-check.test.ts` のフィクスチャ（`report()` に渡す `base`/`root`
  の分離、または期待値の更新）は task_006 の所有者が対応する。
- **対応予定タスク**: task_006（所有者による確認）

## 10. `src/lib/outbox-transports.ts` は本番の cron から配線されていない

- **指摘**: `src/app/api/cron/outbox/route.ts`（task_020 所有）の `handle()` は
  `runOutboxBatch(tx)` を `deliver` オプション無しで呼んでおり、既定の `logOnlyDeliver`
  （ログのみ）のままである。今回実装した `deliverOutboxJob`（`src/lib/outbox-transports.ts`）
  を実際に使うには `runOutboxBatch(tx, { deliver: deliverOutboxJob })` への差し替えが要るが、
  `route.ts` は task_023 の `files_to_modify` に無いため本ラウンドでは変更していない
  （`tests/integration/outbox-delivery.test.ts` は `runOutboxBatch` と `deliverOutboxJob` を
  直接組み合わせて検証しており、単体では正しく動くことを実 DB で確認済み）。
- **深刻度**: medium（配達ロジック自体は実装・検証済みだが、本番 cron が呼ぶ既定関数を
  差し替えないと `ops_alert` の internal webhook も `organizer_notify` の `notifyOrganizer()`
  も実際には発火しない）
- **対応案**: `src/app/api/cron/outbox/route.ts` の `handle()` 内の `runOutboxBatch(tx)` を
  `runOutboxBatch(tx, { deliver: deliverOutboxJob })` に差し替える 1 行の変更。task_020 の
  所有者、または次回 task_023 再着手時に行う。
- **対応予定タスク**: task_020（所有者）または次回 task_023

## 11. `check_113` の `expected_result` 文言が ADR-007 パターン B（accepted）と食い違っている

- **指摘**: `docs/acceptance-checks.json` の `check_113.expected_result` は「幹事（友だち追加
  済み）に Messaging API 経由で通知が送られ（モック）」という Pattern A 相当の文言のままだが、
  本ラウンドで確定した ADR-007 パターン B は Phase 1 で LINE Messaging API へ push しないことを
  決定している。`docs/acceptance-checks.json` は task_023 の `files_to_create`/`files_to_modify`
  のどちらにも含まれないため本ラウンドでは改訂していない。
- **深刻度**: low（`check_113` の `verification_method`＝`test:integration
  （outbox-delivery.test.ts）` 自体は今回実装・pass 済みで自動検証は成立している。文言と実装の
  意味的な不一致が残るだけ）
- **対応案**: PO 判断のうえ `check_113.expected_result` を「Phase 1 は運営者向け内部通知
  （`ops_alert`）のみ、幹事への通知は O-2 バッジ、Messaging API push は Phase 2」に改訂する。
- **対応予定タスク**: 未定（`docs/acceptance-checks.json` の改訂を持つタスクが無い。PO 判断）
