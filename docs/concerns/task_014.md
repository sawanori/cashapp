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

## G5（敵対レビュー）round 1 の指摘と対応（解消済み）

`9d393be`（上の「本ラウンドで直した実装バグ」を含む初回実装コミット）に対して
`scripts/review-drive.sh` / `scripts/merge-review.sh` を実行した結果は
`docs/review-log/task_014.json` の `round: 1` に記録済み。**merge-review の判定は
`decision: pass`（有効票 2・欠票 0・実効 high 0）**だったため G5 のゲート自体は round 1 の
時点で通過していたが、gemini 1 件・GPT-6 Astra 9 件、計 10 件の medium 指摘が出た。
「実効 high が無い」は「直さなくてよい」ではないため、10 件全てを実際に再現してから直した
（コミットは本ラウンドの最終コミットに含む。各修正の実測・回帰テストの所在はソース中の
`敵対レビュー <vendor> F-N` コメントを参照）。

1. **[gemini F-1] `src/lib/audit.ts` の監査ハッシュがトップレベルのキー順に依存していた**。
   `detail`（jsonb）だけを `sortKeysDeep` していたが、トップレベルのオブジェクトリテラルは
   `JSON.stringify` の出力順を V8 の仕様（ES2015 以降、文字列キーの列挙順は挿入順と規定）に
   委ねていた。将来オブジェクト構築経路が増えても前提が壊れたことに気づけない、という指摘を
   受け、`computeRowHash` の入力全体を `sortKeysDeep` に通してから `JSON.stringify` するよう変更。
   エンジン間の列挙順の違いにも構造的に依存しなくなった。
2. **[GPT F-1] 並行リクエストで幹事あたりのイベント数・イベントあたりの参加者数の上限を
   超えられた**。COUNT と INSERT の間に排他制御が無く、異なる冪等キーの並行リクエストが同じ
   残り枠を読めた（静的追跡による指摘）。`createEvent` / `createParticipants` それぞれに
   event 単位／organizer 単位のブロッキング advisory xact lock（`EVENT_CREATE_LOCK_NAMESPACE` /
   `PARTICIPANT_CREATE_LOCK_NAMESPACE`）を追加し、COUNT の前に取得するよう変更。回帰は
   `tests/integration/events.test.ts` の「並行リクエストでも...上限を超えない」2 本
   （実際に並行 INSERT を発行して上限超過が起きないことを実測）。
3. **[GPT F-2] `sort=label_asc` のカーソルページングで参加者が欠落し得た**。`ORDER BY` は
   `display_label ASC NULLS LAST` を使うのに、カーソルの `WHERE` は `created_at` と `id` しか
   見ておらず、表示名の順序と作成順序が食い違うと境界の行が抜けた。`WHERE` 側も
   `(COALESCE(display_label, sentinel), created_at, id)` のタプル比較に揃えて解決。回帰は
   `tests/integration/events.test.ts`「sort=label_asc のカーソルページングは...重複・欠落なく
   巡回できる」。
4. **[GPT F-3] 通信失敗後の再送で冪等キーが変わり、二重作成し得た**。送信のたびに新しい
   `Idempotency-Key` を発行していたため、サーバーでコミットが成立した直後に応答だけを失うと、
   再試行が新規キーとして扱われ `createEvent` / `createParticipants` が再実行され得た。
   `src/app/(liff)/events/new/page.tsx` と `.../participants/page.tsx` の両方で、キーを
   `useRef` に保持して失敗時は使い回し、成功時だけ使い切る（次の新規送信で新しいキーを発行）
   方式に変更。
5. **[GPT F-4] 未登録の決済手段が手数料なし・即時として表示され得た**。
   `getStaticProviderCapabilities` が見つからないとき呼び出し側が
   `DEFAULT_PROVIDER_KEY`（`manual_confirm`）へフォールバックしていたため、未確定の
   `providerKey` でも常に静的表の先頭が見つかり、「未定」への分岐が実質デッドコードだった。
   フォールバックを撤去し、呼び出し側（`events.ts` の `event.provider_key ?? DEFAULT_PROVIDER_KEY`）
   で解決してから渡す方針に変更。`estimateFeeForEvent` 自身はもうフォールバックしない。
6. **[GPT F-5] 参加者 0 名のイベントに正の受取見込額が付いていた**。`getEventSummary` が
   実際の参加者数 0 を `estimateFeeForEvent` へ `null`（＝未定）として渡していたため、
   「参加者数未定なら 1 人分」という O-3（作成前画面）向けのロジックが誤って適用されていた。
   0 は「0 人」として渡すよう修正（`null` は本当に未定の O-3 だけに残す）。回帰は
   `tests/integration/events.test.ts` の `getEventSummary の内訳（敵対レビュー GPT F-5 / F-6）`。
7. **[GPT F-6] 自動・手動が混在する支払済み請求がサマリから消えていた**。支払済み件数の
   集計が `confirmation_method IN ('automatic', 'manual_by_organizer')` しか見ておらず、
   `mixed` の請求が支払済みにも要対応にも数えられなかった。`breakdown.paidMixed` を追加して
   `EventSummary` / `SummaryBar`（`mixedCount`）まで配線し、`listParticipants` の
   `confirmationMethod` も `mixed` を通すよう変更。回帰は `tests/integration/events.test.ts`
   の `breakdown.paidMixed は常に応答に含まれ...` 他。
8. **[GPT F-7] 金額の指数表記が別の金額として保存され得た**。`Number.parseInt(raw, 10)` は
   文字列の先頭だけを読み進めるため、`"5e2"`（ブラウザの `type="number"` は妥当な値として
   受理する）が「500」ではなく「5」として静かに保存されていた。`Number()` で文字列全体を
   解釈し、非整数・非数値は `null` にする `parseDefaultAmountMinor` へ変更（"5,000" のような
   桁区切りも同じ理由で弾かれる）。回帰は新規 `tests/unit/components/EventCreateAmountParsing.test.ts`
   8 本。
9. **[GPT F-8] 期限切れの冪等キーも再利用を拒否し続けていた**。`expires_at` は予約時に保存する
   だけで、競合時に読み比べていなかったため、TTL（24h）を過ぎても既存行がある限りブロックされ
   続けた。予約 INSERT を `ON CONFLICT (...) DO UPDATE ... WHERE idempotency_key.expires_at < now`
   に変更し、期限切れの行だけを新しい予約で上書きできるようにした。回帰は
   `tests/integration/events.test.ts`「TTL（expires_at）を過ぎたキーの再利用（GPT F-8 是正）」。
10. **[GPT F-9] 「もっと見る」の連打で参加者が重複表示され得た**。`nextCursor` の state 更新が
    フェッチ完了後まで反映されないため、連打すると同じカーソルで複数回 append され得た。
    `loadingMore` state でガードし、フェッチ中はボタンも `disabled` にした。

**このラウンドの修正自体（1〜10）に対する追加の敵対レビューは、本ラウンドの最終コミット
（`41e8840`）後に `scripts/review-drive.sh` / `scripts/merge-review.sh` を round 2 として実行し、
`docs/review-log/task_014.json` に追記した。round 2 も **merge-review: pass**（有効票 2・欠票 0・
実効 high 0）。gemini 1 件・GPT-6 Astra 6 件、計 7 件の medium 指摘が出た。**実効 high が無い
時点でゲートは通過しているが、round 1 と同じ方針で指摘を評価し**、4 件（GPT F-3・F-4・F-5・F-6）
は実装バグとして再現して直し、3 件（gemini F-1・GPT F-1・F-2）は task_014 の所有ファイルの範囲外
か、より大きな設計判断を要するためこの場では直さず、それぞれ C-014-6〜8 として残した（下記）。

1. **[GPT F-3] 成功応答の本文受信に失敗すると送信ボタンが無効のまま固まる**。
   `new/page.tsx` の `submit` と `participants/page.tsx` の `register` はどちらも
   `response.json()` が外側の try/catch の外にあり、ステータスは 2xx（サーバーは既にコミット
   済み）でも本文の受信が失敗すると例外が catch されず `setSubmitting(false)` /
   `setRegistering(false)` に到達しないまま再試行できなくなっていた。この節だけ try/catch で
   包み、失敗時はボタンを再度押せる状態へ戻す。**冪等キーはここでは使い切らない**
   （null にすると再試行が新しい Idempotency-Key として扱われ二重作成し得るため）。ただし
   キーを残した再試行は `runIdempotent` の replay 経路に入り、`joinToken` / `claimToken` は
   `extra` にしか無く replay 応答には含まれない設計（このファイル冒頭の docstring）なので、
   この経路に入ると招待リンク・個別リンクの表示機会を失う。これは C-014-6 として残す
   （フルには閉じていない）。
2. **[GPT F-4] 絞り込み後に古い「もっと見る」の応答が混入する**。`loadingMore` は「もっと見る」
   の連打だけを防ぎ、取得中の絞り込み操作は妨げていなかったため、保留中の「もっと見る」応答が
   絞り込み後に遅れて届くと、新しい検索条件に一致しない行が追加され得た。`loadParticipants`
   の呼び出しごとに連番（`loadSeqRef`）を払い出し、応答が戻った時点で「自分が最後に開始した
   呼び出しか」を確認し、違えば（＝この呼び出しの後に別の `loadParticipants` が始まっていれば）
   画面へ反映しない形にした。
3. **[GPT F-5] 中止（canceled）イベントが増えると進行中のイベントが一覧から消える**。
   作成上限（`MAX_ACTIVE_EVENTS_PER_ORGANIZER`）は `status <> 'canceled'` の件数しか数えず
   canceled には上限が無い一方、`listOrganizerEvents` は canceled も含めた
   `created_at DESC LIMIT 100` に固定され、続きを取る手段が無かった。通常操作（canceled を
   積み重ねる）だけで進行中のイベントが 100 件の窓から押し出されて到達不能になり得た。
   `listOrganizerEvents` の `WHERE` に `AND e.status <> 'canceled'` を足し、非 canceled は
   `MAX_ACTIVE_EVENTS_PER_ORGANIZER`（20）が上限なので `LIMIT 100` に必ず収まるようにした。
4. **[GPT F-6] 小数の金額入力がエラーにならず「未設定」として黙って保存される**。
   `parseDefaultAmountMinor` は非整数（"3000.5" 等）も `null` を返すが、送信ボタンは
   `type="button"` でフォームの数値検証を経由しないため、未入力（意図的に空欄）と不正な入力
   （誤って端数付きの金額を書いた）を区別せず、後者も黙って「既定金額なし」として送信されて
   いた。`submit` に「非空なのに解釈できない入力なら送信を止めてエラーを示す」チェックを足した
   （`parseDefaultAmountMinor` 自身の契約は変えていない）。

---

## C-014-6 [severity: medium] 応答受信失敗後の冪等キー再送では joinToken / claimToken が失われる（G5 round2 GPT F-2 / F-3）

**指摘**: `POST /api/events` と `POST .../participants` はどちらも、成功応答の `joinToken` /
`claimToken` を `runIdempotent` の `extra`（保存しない・初回応答にだけ載せる）として返す
（意図的な設計。§9「`response_body` は許可フィールドのみ」）。サーバーがコミットした直後に
応答の受信に失敗すると（通信断・本文パース失敗）、上の「本ラウンドで直したバグ」1 で
ボタンは再度押せるようにしたが、**同じ冪等キーでの再試行は `replayed: true` の応答になり、
`extra` を含まない** ため、招待リンク・個別リンクの表示機会を恒久的に失う。イベント／参加者
自体は正しく作成されているため実害は「二重課金」のような重大なものではないが、幹事が招待を
配布できなくなる。

**対応案**: 「秘密は一度しか見せない」設計とは独立に、`extra` を紛失した場合の再表示手段
（例: 未 replay の間だけ再表示できる短命な状態を別途持つ、または `joinToken` /
`claimToken` のローテーション発行 API を足す）が要る。設計判断であり、対応予定タスクで
決める。

**対応予定タスク**: task_015（請求・claim 導線と合わせて設計）

---

## C-014-7 [severity: low] 参加者削除の TOCTOU（HAS_OPEN_ATTEMPT の判定後に payment_attempt が作られ得る。G5 round2 gemini F-1）

**指摘**: `removeParticipant` は `participant` 行を `FOR UPDATE` で確定してから
生きた `payment_attempt` の有無を確認するが、`payment_attempt` の作成（決済試行の開始）を
妨げるロックではないため、確認が通ってからコミットするまでの間に**別トランザクションが
新しい `payment_attempt`（`is_open=true`）を挿入すると**、`removed` になった参加者に
生きた決済試行が残る不整合が理論上あり得る。

**対応案**: `payment_attempt` の作成経路（checkout 開始）自体は task_014 の所有ファイルに
存在しない（task_015/017 の scope）。恒久対処は「`payment_attempt` 作成側が対象
`participant`／`invoice` に対して同じ advisory lock を取る、または `participant.status` を
確認してから挿入する」形で、`payment_attempt` 作成コードを書くタスクの責務として送る。

**対応予定タスク**: task_015 / task_017（`payment_attempt` 作成経路の実装時に、この TOCTOU を
閉じる形で作ること）

---

## C-014-8 [severity: low] `verifyAuditChain` の既定 limit（10000）を超える行の改変は既定呼び出しでは検出されない（G5 round2 GPT F-1）

**指摘**: `verifyAuditChain(sql, { limit })` は `limit`（既定 10000）件目までしか取得せず、
`limit` を省略した呼び出しは 10001 行目以降の改変があっても `ok: true` を返す（検証未完了で
あることを示す情報も無い）。`audit_log` が 10000 行を超える運用では、既定呼び出しだけに頼ると
末尾の改変を見逃し得る。

**対応案**: 本関数はモジュール docstring が明記するとおり「正式な `npm run audit:verify`
（CLI・cron・required check への登録）は task_018/020 の担当であり、本関数はその下敷きとなる
検証ロジック」という位置づけである。恒久対処（`limit` を省略時は全件をページングして走査する、
または呼び出し側に `rowsChecked` と実際の総行数を突き合わせさせて未検証分を明示する）は、その
正式な CLI/cron を作るタスクの責務として送る。

**対応予定タスク**: task_018 / task_020

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
