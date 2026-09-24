# プレモータム再実行: Phase 1 後半（task_014〜023）— 2026-09-24

- 実施: premortem-facilitator エージェント（opus）。フェーズ境界（前半 task_003〜013 完了・後半着手）で再実行。
- 入力: docs/implementation-plan.md §12 / §17、docs/research/premortem-risks.md（既存 86 件）、task_014〜023 の台帳、
  docs/PROGRESS.md、docs/concerns/*.md、docs/review-log/*.json。
- 結果: **新規 12 件（S1 8 件 / S2 4 件）**。既出として畳んだもの 16 件（末尾）。
- メインセッションの注記: 本文は同エージェントの報告をそのまま収録した。エージェント自身が「検証していないこと」を
  末尾で申告している（一次資料の再取得なし・test:unit / test:integration 未実行・P-04 の因果は推測）。
  各項目の「兆候」に挙がるファイル・行は同エージェントが Read で確認したもの。
- 配線: task_014〜023 の `files_to_read` に本ファイルを追加した。P-01 / P-03 / P-07 / P-08 / P-10 / P-12 は
  該当タスクの実装者・レビュアーが必ず読む。ハーネス側（P-02 / P-04 / P-05 / P-06 / P-11）は
  `docs/proposals/harness-round2.md` に PO 判断事項として起票。

## 冒頭の観測（エージェント報告）

**G11: 新規着手を停止すべき状態。** `npm run gate:check` の実測値は「未解決 severity=high concerns 34 件
（task_005, 006, 007, 009, 011, 012, 013）/ しきい値 3 件」。ゲート自体は `in_progress 0 件` を理由に `ok` を
返しているが、作業ツリーには task_014 の成果物（`src/lib/idempotency.ts`・`src/lib/audit.ts`・
`src/lib/db/repositories/**`・`src/app/api/events/**`）と task_008 の成果物（`.claude/workflows/*.ts`）が未コミットで
存在し、実体として 2 タスクが並行進行中。同時に G13 が FAIL（`.claude/workflows/{premortem,release-audit,task-loop}.ts`
が基準値に無い）。`docs/premortem/<date>.json` は 1 件も存在しないため「前回の premortem の high」は定義できず、
G11 の判定は concerns 側の実測値に依拠している。

## 新規リスク（12 件）

### P-01 冪等予約の孤児化と、曖昧な失敗時の予約解放による二重実行 — S1 × high

- **失敗の描写**: `runIdempotent` は `in_flight` の予約を独立した文でコミットし、業務トランザクションの成功後に
  `state='done'` を**別の文で**書く。Worker が CPU 上限・isolate 破棄・接続断で落ちると、イベント/請求は成立したのに
  予約は `in_flight` のまま残り、同一キーの再送は TTL の 24 時間ずっと 409 `IDEMPOTENCY_IN_PROGRESS` を返し続ける。
  逆に「業務 tx は COMMIT 済みだがその後の経路で例外」になると `catch` 節が予約を `DELETE` するため、再送が同じ
  業務処理をもう一度実行する。
- **兆候**: `src/lib/idempotency.ts`（`try` が `handler()` だけを包み、成功後の `UPDATE ... state='done'` は `try` の外／
  `catch` は無条件に `DELETE`）。task_014 の `POST /api/events`、task_015 の `POST /api/events/:id/invoices`、
  task_017 の `POST /api/e/checkout` が同じ関数を共有する。
- **早期検出**: `tests/integration/idempotency.test.ts` に 2 ケースを追加 —（a）handler が業務 tx のコミット後に throw
  する場合に業務行が 2 件にならないこと、（b）`UPDATE state='done'` を失敗させた後の再送が業務結果を復元できること。
  運用側は `SELECT count(*) FROM idempotency_key WHERE state='in_flight' AND updated_at < now() - interval '5 minutes'`
  を日次メトリクス化。
- **対応案**: 予約の `done` 遷移を業務トランザクションと同一 tx に入れる（`runIdempotent` に `tx` を渡す形に変える）。
  解放は「業務 tx が未コミットであると確認できた場合のみ」に限定し、それ以外は `in_flight` を残して stale 判定
  （例: 5 分）で再実行可能にする。
- **深刻度**: S1（過払い・二重請求に直結）× high

### P-02 受入基準の本文がどのガードにも守られていない — S1 × high

- **失敗の描写**: `docs/acceptance-checks.json` の `expected_result` / `rule` は、`deny-test-weakening.sh` が
  **`evidence` フィールドだけ**を遮断し（同スクリプト 306〜310 行）、`gate-tamper.yml` の保護パス一覧にも入らず、
  G13 の基準値（43 ファイル）にも入っていない。テストや migration を緩めるより**受入基準の文面を書き換える方が安い**
  経路が開いている。
- **兆候**: 受入基準が実装と物理的に両立しないと判明した瞬間に現れる。実例が既に存在する（P-03 の check_043）。
  G3 は「各 check が task から参照されているか」しか見ないので本文の変化を検出しない。
- **早期検出**: `docs/acceptance-checks.json` を G13 の `INTEGRITY_PATTERNS` に単一ファイルとして追加する。あるいは
  `gate-tamper.yml` の対象パスに同ファイルを足して PR チェックリストを必須にする。数値: `git log -p
  docs/acceptance-checks.json` のうち `expected_result` 行を変更したコミット数（現状 0 が期待値）。
- **対応案**: 上記いずれか。「緩めてはいけない」ではなく「緩めたら記録が残る」に倒す。
- **深刻度**: S1（F3 の主対策が受入基準側で開いている）× high

### P-03 保持期間処理が起点も期日も無く、対象列は NOT NULL — S1 × high

- **失敗の描写**: `event.retention_due_at` は列と部分インデックスだけが存在し、**`src/**` にも `docs/task-list.json`
  にも値を書く経路が 1 つも無い**（grep で 0 件）。したがって task_020 の `/api/cron/retention` は本番で永久に 0 行を
  走査して成功する。「終了 + 90 日」の起点になる列（`closed_at` 等）が `event` に無く、`event_at` / `collect_by_at` は
  どちらも NULL 可。擬似匿名化の対象と宣言されている `event.organizer_label` は `text NOT NULL`
  （`supabase/migrations/0001_init.sql:150`）で、NULL 化は制約違反になる。
- **兆候**: `docs/acceptance-checks.json` の **check_043**（`rule` が `event.retention_due_at を過去` にして cron を叩く
  ＝前提をフィクスチャが自分で作る／`expected_result` が `event.organizer_label が NULL`＝現行スキーマでは不可能）。
  task_020 の実装時にこのテストが赤くなり、実装者は「migration で NOT NULL を外す（tamper-guard が発火する）」か
  「受入基準を書き換える（P-02 により無音で通る）」かの二択を迫られる。
- **早期検出**: (1) `grep -rn "retention_due_at" src/ | wc -l` が 0 なら gate:check を落とす。(2)
  `tests/integration/retention.test.ts` を「アプリの通常導線（イベント作成→クローズ）だけを実行し、フィクスチャで
  `retention_due_at` を直接書かずに」cron が対象を 1 件以上拾うことをアサートする形に変える。(3) 保持ポリシーに名前が
  挙がる列が `is_nullable='YES'` であることを `information_schema.columns` で検査する統合テスト。
- **対応案**: `event` に `closed_at timestamptz` を足し、`status` 遷移時に `retention_due_at = closed_at + 90 days`
  を書く経路を task_014 か task_020 のどちらの所有にするかを先に決める。`organizer_label` は NOT NULL を維持したまま
  固定文字列（例 `'(削除済み)'`）へ置換する方式に改めるか、NULL 可へ変える migration を task_011 の所有として起票する。
- **深刻度**: S1（規約に書く 90 日擬似匿名化が構造的に実行されない。O-13 の削除請求も同じ列を触る）× high

### P-04 run-log が作業ツリーの汚れを記録せず、並行実装下で証拠が再現しない — S1 × high

- **失敗の描写**: `scripts/record-run.sh` は `git rev-parse HEAD` を記録するが、`git status --porcelain` を一切記録
  しない。ロックは**タスク単位**なので、別タスクのエージェントが同時に走っている間の実行がそのまま「commit X で
  exit 0」として残る。その exit 0 は、他タスクの未コミットコードがあったから緑だったのか、無くても緑だったのかを
  後から区別できない。G4 と G9 はこの記録を信用して完了を認める。
- **兆候**: `git status` に task_014 と task_008 の未追跡ファイルが同居している。PROGRESS.md には同一 HEAD で
  `test:unit` が 1 回目 exit 0 / 2 回目 exit 1 になったフレーキーが記録されており、並行負荷との関係は未検証
  （**この因果は推測**）。
- **早期検出**: `record-run.sh` に `git status --porcelain | wc -l` と、そのとき存在する他タスクのロックファイル名を
  記録フィールドとして追加する。G4 に「run-log の記録のうち `dirty_files > 0` のものは DONE の根拠にできない」を足す。
- **対応案**: 記録項目を増やすだけで判定は変えない段階から始める。その上で、`verify_commands` の最終再実行だけは
  clean tree（別 worktree でのチェックアウト）で行う運用に寄せる。
- **深刻度**: S1（証拠の完全性はこのハーネスの中核）× high

### P-05 依存順序を強制するものが無く、Hyperdrive 経路を 1 度も通らないまま Phase 1 が緑になる — S1 × high

- **失敗の描写**: task_018 の `dependencies` は `["task_017","task_035"]` だが、task_035（staging Supabase ＋ Hyperdrive
  の実測、owner `human:noritaka`）は未着手。`validate-plan-json.mjs` は依存の解決と循環しか見ず、G0〜G14 に依存完了を
  見るゲートは無い。結果、台帳・冪等・ロックの全テストが直接接続でのみ緑になり、本番経路（Workers ＋ Hyperdrive ＋
  OpenNext）は task_025 まで 1 度も実行されない。
- **兆候**: `tests/integration/setup.ts` が生の `postgres()` で直接接続する。task_014〜023 の `verify_commands` に
  workerd 上で走るものが 1 本も無い。`docs/vendor-docs/cloudflare/hyperdrive.md` の advisory lock とプーリングの
  組み合わせが [不明] のまま。
- **早期検出**: `gate-check.mjs` に G15 を足す —「`completion_status` が DONE 系のタスクは、`dependencies` の全タスクが
  DONE 系であること（human タスクは PO の明示的な bypass 記録を要求）」。加えて「`risk_ids` に R-OPS-08 を持つタスクの
  run-log に Hyperdrive 経路での実行記録が 1 件以上あること」。
- **対応案**: task_035 を人間の作業として先に切り出すか、task_018 の完了定義から「Hyperdrive 経路での実測」を
  明示的に外して BLOCKED 相当の宣言を残す。どちらを採るかを PO が決めるまで task_018 を DONE にしない。
- **深刻度**: S1 × high

### P-06 G11 は `in_progress` を名乗らない運用では発火しない — S1 × high

- **失敗の描写**: `gateG11` は「未解決 high concerns ≥ 3 **かつ** `completion_status === "in_progress"` のタスクが
  1 件以上」で初めて violation にする。エージェントは着手時に `in_progress` を書かない運用なので、しきい値をいくら
  超えても G11 は `ok` を返し続ける。R-TH-09 の先回り策そのものが空振りしている。
- **兆候**: 本日の実測 — 未解決 high 34 件 / しきい値 3 件 / in_progress 0 件 で判定は `ok`。
- **早期検出**: G11 の条件を「未コミットの差分が `files_to_create` / `files_to_modify` に一致するタスクが存在する」
  または「直近 N コミットのメッセージが参照するタスク」へ変える。
- **対応案**: `task-loop` の着手ステップで `completion_status="in_progress"` を必ず書かせ、書かずに成果物が出ている
  状態を G11 の violation として扱う。
- **深刻度**: S1（新規着手停止という最後のブレーキが構造的に効かない）× high

### P-07 人の自由記述の受け皿が保持・擬似匿名化の対象外で、1 つは物理的に消せない — S1 × medium

- **失敗の描写**: `manual_attestation.reason`（NOT NULL）・`manual_attestation.evidence_note`・
  `payment_self_report.note`・`abuse_report.reason`・`ledger_entry.memo` はいずれも自由記述の text 列で、氏名を書く
  ことが業務上自然である。保持期間の対象は `display_label` / `organizer_label` / `raw_body` の 3 つだけ。とくに
  `ledger_entry.memo` は追記専用テーブル（`GRANT SELECT, INSERT` のみ＋`forbid_mutation()` トリガ）にあり、
  **UPDATE も DELETE も物理的にできない**ため擬似匿名化の手段が存在しない。§7-5 の「監査ログは ID・enum・金額・
  タイムスタンプのみ」を機械で守るものも無い。
- **兆候**: task_017 の `POST /api/invoices/:id/manual-attest`（reason 必須）と task_015 の `unclaim`（理由必須）が
  最初の投入経路。`src/lib/audit.ts` の `detail: Record<string, unknown>` も許可キー制限が無い。
- **早期検出**: (1) 統合テストで「自由記述列に投入したテキストが retention cron 実行後に残っていない」ことを検査。
  (2) `SELECT count(*) FROM ledger_entry WHERE memo IS NOT NULL` と `audit_log` の `jsonb_object_keys(detail)` の
  分布を許可リストと突合。(3) `appendAuditLog` に `detail` キーの許可リストを実装し、許可外で例外を投げるユニットテスト。
- **対応案**: `ledger_entry.memo` を Phase 1 では**書かない**（常に NULL）と決め、テストで固定する。自由記述は UPDATE
  可能なテーブルに限定し、保持期間の対象表に列名を明記する。
- **深刻度**: S1 × medium（幹事が実際に氏名を書くかは未実測）

### P-08 監査連鎖のグローバル・ブロッキングロックが全書き込みを直列化する — S1 × medium

- **失敗の描写**: `appendAuditLog` は固定キー `AUDIT_CHAIN_LOCK_KEY = 8_314_001` に対して**ブロッキング**の
  `pg_advisory_xact_lock` を取り、コミットまで保持する。監査行はすべての書き込み経路で書かれるため、アプリ全体の
  書き込み並列度が事実上 1 になる。task_020 の reconcile（バッチ 100・並列 5・外部 HTTP 3 秒）と task_018 の
  Webhook 受信が重なると後発が待たされ、Workers の実行時間上限に当たって 500 を返す。
- **兆候**: `src/lib/audit.ts` の `appendAuditLog` 先頭のロック取得と、`src/app/api/events/route.ts` の `sql.begin`
  内での呼び出し。ローカルの逐次テストでは観測できない。
- **早期検出**: task_020 の `reconcile-load.test.ts`（300 件）に「書き込み API を 20 並列で叩く」ケースを足し、
  `pg_stat_activity` の `wait_event='advisory'` 件数と書き込み API の p95 を記録する。
- **対応案**: 連鎖を `event_id` 単位に分割して `audit_log` に `chain_key` を持たせるか、少なくともロック取得を
  トランザクションの最後に固定し「ロック保持中に外部 HTTP を呼ばない」ことをテストで固定する。
- **深刻度**: S1（Phase 2 の受信詰まりに直結）× medium

### P-09 Hyperdrive のクエリキャッシュ挙動が未確認で、ローカル経路では構造的に再現しない — S2 × medium

- **失敗の描写**: `docs/vendor-docs/cloudflare/hyperdrive.md` は「`wrangler dev` の既定モードでは Hyperdrive の
  インフラを経由しないためクエリキャッシュは効かない」と記録している。Phase 1 のすべてのテストはキャッシュが存在しない
  経路でのみ緑になる。本番でキャッシュが有効な場合、`settlement_rank` や `ledger_entry` の読み取りが古い値を返しうる。
  既定でキャッシュが有効かどうかは一次資料を再取得しておらず**断定しない**。
- **兆候**: `src/lib/db/client.ts` にキャッシュ制御に相当する指定が無い。task_035 の done_definition にもキャッシュの
  確認項目が無い。
- **早期検出**: task_035 の `hyperdrive-spike.test.ts` に read-after-write を 1 ケース足す。
- **対応案**: キャッシュの既定値を一次資料で確定してから、台帳読み取りのクエリに対しては明示的に無効化する。
  確定するまで task_018 を DONE にしない（P-05 と同じ判断）。
- **深刻度**: S2 × medium

### P-10 監査連鎖の不一致を検知しても、止める配線がどのタスクにも無い — S2 × high

- **失敗の描写**: §17-5 は「`audit:verify` の不一致」を人間の判断を待たずに `PAYMENTS_ENABLED=false` を引く条件の
  6 番目に挙げている。しかし task_020 の `/api/cron/audit-verify` は「直近 7 日を検証する」までで、不一致時に何を
  するかが書かれていない。task_023 の `health` の degraded 条件 4 つにも監査不一致は含まれない。task_021 の
  `POST /api/admin/flags` は二人承認の人間の操作であり、自動で引ける経路ではない。
- **兆候**: task_020 と task_023 の done_definition。`feature_flag` には app_rw に UPDATE が与えられているので技術的に
  可能なのに誰も使っていない。
- **早期検出**: `tests/integration/audit-verify.test.ts` に「連鎖を意図的に壊した状態で cron を実行すると
  `feature_flag.payments_enabled` が false になり、`outbox` に通知が積まれ、`audit_log` に理由が残る」を追加。
- **対応案**: §17-5 の 8 条件それぞれについて「自動 / 人間」を task-list 上で明示し、自動のものは実装タスクを持たせる。
  Phase 1 で自動化できないものは「Phase 1 では人手」と明記して縮退運転を宣言する。
- **深刻度**: S2（Phase 1 は manual_confirm のみ。Phase 2 で S1 に昇格）× high

### P-11 検証が task_022 に集中し、所有タスク完了後に出た赤を直す責任者がいない — S2 × high

- **失敗の描写**: task_014〜021 の `verify_commands` は `typecheck` / `lint` / `test:unit` / `test:integration` /
  `gate:*` のみで、E2E・セキュリティ・a11y は task_022 で初めて走る。そのとき赤が出ても、原因となった画面の所有
  タスクはすべて DONE 済みで、修正の責任者が制度上いない。
- **兆候**: `tests/unit/gate-constraints.test.ts` の 5 秒タイムアウトは task_004 の所有だが、task_007 が 4 周、
  task_013 が 3 周にわたって「task_004 の担当」と記録したまま赤のまま残っている（PROGRESS.md）。
- **早期検出**: 「`src/app/(liff)/**/page.tsx` のうち `tests/e2e/**` と `tests/a11y/**` のどの spec からも到達しない
  ページ数」を CI で数え、task ごとに 0 を要求する。あるいは task_014〜021 の `verify_commands` に `test:a11y`
  （当該ページのみ）を足す。
- **対応案**: 画面を作る各タスクに最小 1 本の a11y/E2E を持たせる。「完了済みタスク由来の赤」を引き受ける所有者を
  task-list 上で明示する。
- **深刻度**: S2 × high

### P-12 要対応通知の唯一の配達先が、幹事の生 userId 保持を要求して §7-5 と衝突する — S2 × high

- **失敗の描写**: R-OPS-01 の先回り策は「Messaging API チャネルを Phase 1 に前倒し」だが、Messaging API の push には
  **生の LINE userId** が必要で、§7-5 の「生値を保存しない。`line_user_ref`（HMAC）のみ」と衝突する。task_023 は
  「ADR-007 で先に設計」と書くが、**ADR-007 は未作成**。新設される生 userId 列は DB 内で最も価値の高い秘密になるが、
  PEPPER のローテーション設計にも 90 日の保持設計にも入っていない。
- **兆候**: task_023 の `files_to_create` に `docs/decisions/ADR-007-raw-userid-consent.md` があるが、依存元の
  task_020 には生 userId の扱いに関する記述が無い。task_021 の `POST /api/admin/anonymize` も対象列を列挙していない。
- **早期検出**: スキーマ検査で「生 LINE userId を保持する列が存在するなら、その列が擬似匿名化の対象表と
  `gate:privacy-policy` の記載対象に入っていること」を機械検査する。
- **対応案**: ADR-007 を task_023 より前に書き、(a) 生 userId を保持する、(b) 保持せず outbox は運営者向け内部通知だけ
  にして幹事には O-2 バッジで気づかせる、のどちらを採るかを PO が決める。(b) の場合は「Phase 1 では要対応が幹事に
  push されない」ことを縮退運転として明記する。
- **深刻度**: S2 × high

## 既出として除外したもの（16 件）

| 検討した失敗モード | 除外理由 |
|---|---|
| 連打で生きた attempt が 2 本できて過払い | 既存 R-PAY-02 に包含 |
| 決済画面を開いた参加者の削除で入金が orphan になる | 既存 R-PAY-03 に包含 |
| 招待リンク転送で他人が claim し、本人が到達不能になる | 既存 R-SEC-01 に包含 |
| `app_rw` の追記専用が実効を持たない | 既存 R-SEC-03 に包含 |
| 非 production から本番 DB が触れる / LIFF ID 取り違え | 既存 R-SEC-05 / R-LINE-04 に包含 |
| reconcile の全件走査・ロック残留・接続上限 | 既存 R-OPS-08 に包含 |
| cron 契約が未確認で無音停止する / health が静的 | 既存 R-OPS-07 に包含 |
| outbox に配達先が無く要対応が誰にも届かない | 既存 R-OPS-01 に包含（新規は P-12 の PII 衝突部分のみ） |
| 監査連鎖が並行 insert で分岐する | 既存 R-SEC-15 に包含（新規は P-08 の直列化の副作用のみ） |
| fixture が synthesized のみで `autoDetect` を名乗る | 既存 R-TH-07 に包含 |
| 手動確認版で参加者が二重送金する | 既存 R-UX-02 に包含 |
| 主催者名が空欄で詐欺リンクに見える | 既存 R-UX-01 に包含 |
| Phase 1 のゲート 3 件が unknown のまま機能実装が進む | R-TH-05 の再掲・状況変化あり（10 ゲートが全件 unknown） |
| 敵対レビューが Gemini 単独で成立しない | R-TH-03 の再掲・状況変化あり（task_007 BLOCKED、G5 が warn に後退） |
| concerns が積み上がって読まれない | R-TH-09 の再掲・状況変化あり（未解決 high 34 件、集計元が 8 ファイルに分散） |
| CODEOWNERS 承認が単一アカウントで成立しない | R-TH-04 の再掲・状況変化あり（branch protection 設定済み・approving reviews 0・enforce_admins false） |

既に記録済みのため新規に数えなかったもの: `docs/task-list.json` が G13 のハッシュ対象にも tamper-guard の保護対象にも
入っていない件と、G13 の基準値生成が並行タスクの未コミットファイルを焼き込む件（`docs/concerns/task_009.md`）。

## エージェントが検証していないと申告したこと

- 一次資料は 1 件も再取得していない（Hyperdrive のキャッシュ既定値、Workers の上限値、Messaging API の userId 要件は
  リポジトリ内の退避文書とコードからの読み取り）。
- P-04 の「並行実行が `test:unit` のフレーキーの原因」は推測。
- `npm run test:unit` / `test:integration` は未実行。実行したのは `npm run gate:check` の 1 本のみ。
- `docs/research/premortem-risks.md` は書き換えていない（本ファイルへの参照をメインセッションが追記した）。
