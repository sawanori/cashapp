# task_014 の残懸念

イベント・参加者 API と幹事画面（O-2〜O-6.5）。形式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

作業ツリーには着手前から task_014 の成果物（24 ファイル全て）がほぼ実装済みの状態で存在していた
（前回セッションの中断分。`docs/run-log/task_014.json` の最初の 5 件がその時点の記録）。本ラウンドでは
それを引き継ぎ、`npm run test:integration` を初めて最後まで走らせて 3 件の実害あるバグを実測で見つけて
直した（下記「本ラウンドで直した実装バグ」）。残懸念はそれ以外の、スコープ外または後続タスク送りの項目。

---

## 本ラウンドで直した実装バグ（参考。残懸念ではない）

1. **`src/lib/idempotency.ts` の予約解放が業務トランザクションと分離していた（P-01。
   `docs/research/premortem-phase1b-2026-09-24.md`）**。`runIdempotent` は予約の INSERT・
   `handler` の呼び出し・`done` への UPDATE を別々の文で行い、`handler` 失敗時は予約だけを
   個別 DELETE していた。呼び出し側（`POST/PATCH /api/events`、`POST .../participants`）が
   自分の `sql.begin()` の**外側**で `runIdempotent` を呼んでいたため、業務書き込みが
   コミットされた後の経路で例外が起きると、予約だけが解放され再送が業務処理をもう一度実行し得た
   （逆に Worker が両者の間で落ちると、予約が 24h 孤児化する）。予約・`handler`・`done` 更新を
   呼び出し側が開いた**同一トランザクション**にまとめる形へ変更し（`runIdempotent` はもう
   `sql.begin()` を自分で呼ばない）、3 つの API route を書き換えた。回帰は
   `tests/integration/events.test.ts`「冪等予約のトランザクション原子性（P-01 是正）」2 本で固定
   （savepoint で模した「業務行を書いた後に例外」が業務行・予約行の両方を残さないこと、
   再送が孤児に阻まれず新規実行できることを実測）。
2. **`listParticipants` のカーソルページングが 2 ページ目以降ずっと空振りしていた**（`npm run
   test:integration` を初めて最後まで走らせて発覚。100 名投入で `pages: 11`／`seen: 30` で
   スタック、実運用では無限に同じ 30 件を返し続ける）。原因は `postgres`（npm, v3系）の
   パラメータ型推論: `prepare: false` 下では「OID 未指定でパラメータを送る → サーバーの
   `ParameterDescription` で推論された型を読む → その型の組み込みシリアライザで再エンコードする」
   という経路を取り、推論結果が `timestamptz` だと組み込み `date` シリアライザ
   （`new Date(x).toISOString()`）が渡した文字列カーソル値に適用され、マイクロ秒がミリ秒へ
   切り詰められる。切り詰められたカーソル値は実際の行より必ずわずかに小さくなるため、
   `(created_at, id) > (cursor.createdAt, cursor.id)` の行タプル比較が `id` に関わらず常に真になる。
   `${cursor.createdAt}::text::timestamptz`（二重キャスト）に変更し、パラメータの推論型を
   `text`（組み込みシリアライザは恒等関数）に固定して解決。実測（`node` での直接検証。
   Postgres 側の `SELECT (${c}::timestamptz)::text` が `.929460` を `.929` に切り詰めること／
   `::text::timestamptz` なら切り詰めないこと）を `src/lib/db/repositories/participants.ts` の
   `encodeCursor` 直前の docstring に残した。回帰は既存の「100 名の名簿をカーソルページングで
   取り切れる」テスト（元々 task_014 の done_definition に含まれるが、前回セッションは
   `test:integration` を一度も実行していなかったため未検出のまま残っていた）。
3. **`appendAuditLog` の監査連鎖ハッシュが、`detail`（jsonb）のキー順に依存していた
   （check_057 の「並行 20 本」「1 行改変」の 2 テストが 100% 再現）**。Postgres の JSONB 格納は
   キー挿入順を保持しない（実測: `{"foo":"bar","n":1}` で INSERT した行を SELECT すると
   `{"n":1,"foo":"bar"}` で返る）。`computeRowHash` は `detail` をキー順そろえずに
   `JSON.stringify` していたため、挿入直後に計算したハッシュと、同じ行を読み直して
   再計算したハッシュが、内容を一切改変していなくても不一致になっていた（`detail` に 2 キー
   以上あれば発生。`appendAuditLog` の呼び出し元は task_014 の 3 route が `detail: { fields: ... }`
   / `detail: { count: ... }` を渡す形で既にこの条件に触れていた）。`src/lib/idempotency.ts` の
   `sortKeysDeep` と同じ方針の `sortDetailKeysDeep` を `audit.ts` に追加し、`computeRowHash` の
   `detail` に適用して解決。あわせて「1 行の改変」テストの期待値も訂正した（`row2` の
   `row_hash` 自体を書き換えた場合、`verifyAuditChain` は行ごとに (1) `prev_hash` の連結 (2) 自分
   自身の `row_hash` の両方を検査するため、改変した `row2` 自身が break point になるのが正しい
   実装の振る舞いであり、旧テストが期待していた「`row3` の `prev_hash` 不一致」は誤りだった）。

---

## C-014-1 [severity: medium] 保持期間（`retention_due_at`）の起点がどこにも書かれていない（P-03）

**指摘**: `docs/research/premortem-phase1b-2026-09-24.md` の P-03 が指摘するとおり、
`event.retention_due_at` は列と部分インデックスだけが存在し、値を書く経路が `src/**` に
1 つも無い（task_014 時点でも grep 0 件のまま）。対応案は「`event` に `closed_at timestamptz`
を足し、`status` 遷移時に `retention_due_at = closed_at + 90 days` を書く経路を task_014 か
task_020 のどちらの所有にするかを先に決める」だが、`closed_at` の追加は `supabase/migrations/
0001_init.sql` への変更を要し、task_014 の `files_to_modify` は空（新規マイグレーションファイルの
追加も `files_to_create` に無い）ため、本タスクの範囲では実装できない。

**対応案**: PO が task_014 と task_020 のどちらの所有にするか決める。実装自体は
「`status` が `active → closed`（または相当）へ遷移する `PATCH /api/events/:id` の経路で
`closed_at = now()`、`retention_due_at = closed_at + interval '90 days'` を書く」で小さく済む。

**対応予定タスク**: task_020（PO 裁定後）

---

## C-014-2 [severity: low] 監査連鎖のグローバル・ブロッキングロックは仕様どおり（P-08。対応は task_020）

**指摘**: `docs/implementation-plan.md` §10-1 は「監査連鎖は `id` 順で確定し、書き込み時に
`pg_advisory_xact_lock(AUDIT_CHAIN_LOCK)` で直列化する」と明記しており、`src/lib/audit.ts` の
`appendAuditLog` はこの仕様どおりに実装されている。P-08 が指摘する懸念（このロックが全書き込みの
並列度を事実上 1 にし、task_020 の reconcile バッチや Webhook 受信の同時実行下で待たされる）は、
premortem 自身が「早期検出: task_020 の `reconcile-load.test.ts`（300 件）に 20 並列書き込みの
ケースを足し `pg_stat_activity` の `wait_event='advisory'` を記録する」「対応案: 連鎖を `event_id`
単位に分割するか、ロック保持中に外部 HTTP を呼ばないことをテストで固定する」としており、検知・対応の
双方を task_020 の所有としている（`chain_key` の追加はスキーマ変更を伴い、これも task_014 の
`files_to_modify` の外）。task_014 では所有ファイルの範囲でこれ以上できることが無いため、
仕様どおりの実装であることの確認記録として残す。

**対応予定タスク**: task_020

---

## C-014-3 [severity: low] 幹事あたりの「合計請求額」上限は未実装（意図的。task_021 の所有）

**指摘**: `docs/implementation-plan.md` §8-1 の O-5 行は「上限（幹事あたりの人数・イベント数・
合計額）」を挙げ、`docs/research/premortem-risks.md` の R-LAW-10 も「幹事あたりの利用上限（1
イベントの人数、期間あたりのイベント数、**合計請求額**）」を Phase 1 スコープに含めるべきとする。
`src/lib/db/repositories/events.ts` は「1 イベントの人数」（`MAX_PARTICIPANTS_PER_EVENT=100`）と
「同時に持てるイベント数」（`MAX_ACTIVE_EVENTS_PER_ORGANIZER=20`）は実装済みだが、「合計請求額」は
未実装。同ファイルの既存コメントが「恒久的な悪用対策の総合ゲートは task_021 が
`tests/integration/abuse-limits.test.ts` で確定する。ここでは『作成そのものを止める』最小限の
歯止めとして…」と明記しており、`docs/acceptance-checks.json` の check_083 も検証方法に
`abuse-limits.test.ts`（task_014 の所有ファイルに無い）を挙げている。「合計請求額」は
`invoice`（task_015 が作る）が存在して初めて正確に算出できるため、task_014 の時点
（イベント・参加者層のみ）で厳密な実装は構造的に困難であり、この切り分けは妥当と判断し
そのまま維持した。`event.default_amount_minor × 参加者数` による**推定**上限を task_014 に
前倒しで足すことも検討したが、根拠となる具体的な閾値がどの文書にも無く、当てずっぽうの数値を
コードに固定すると task_021 の正式なゲートと衝突・重複する恐れがあるため見送った。

**対応予定タスク**: task_021（`abuse-limits.test.ts`）。閾値の具体案が要るなら PO 裁定。

---

## C-014-4 [severity: medium] O-2〜O-6.5 の画面に e2e・a11y のテストが 1 本も無い（P-11）

**指摘**: `docs/research/premortem-phase1b-2026-09-24.md` の P-11 が指摘するとおり、
task_014〜021 の `verify_commands` には `typecheck` / `lint` / `test:unit` / `test:integration`
/ `gate:*` しか無く、E2E（`tests/e2e/**`）・セキュリティ（`tests/security/**`）・a11y
（`tests/a11y/**`）は task_022 で初めて走る設計になっている（`docs/task-list.json` の正本）。
本タスクが作った 5 画面（`src/app/(liff)/events/**`）は、どの e2e/a11y spec からも今のところ
到達しない。task_014 自身の `verify_commands` にはこれらのスクリプトが含まれていないため
G2（verify_commands の実在性）には抵触しないが、実際の画面遷移・WCAG 2.2 AA 準拠は
まだ機械的に確認されていない。

**対応予定タスク**: task_022（各画面に最小 1 本の e2e/a11y を持たせる設計変更を検討するか、
task_022 到達時にまとめて確認するかは premortem の対応案どおり未決定）

---

## C-014-5 [severity: low] Hyperdrive 経由の実測（A21）は未実施

**指摘**: 本タスクの統合テストはすべて `tests/integration/setup.ts` のローカル直結（`app_rw`
ロール、`DATABASE_URL_MIGRATOR` 既定 `127.0.0.1:54322`）で行っており、Cloudflare Workers ＋
Hyperdrive 経由での実行は 1 度も無い。task_035（staging Supabase ＋ Hyperdrive）が PO 作業で
未了のため、これは deferred: task_035 完了後 に実測する。

**対応予定タスク**: task_035 完了後、task_018 以降のいずれか
