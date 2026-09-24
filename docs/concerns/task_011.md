# task_011 — 残懸念（hardening 周の記録）

書式: 指摘 / 深刻度 / 対応案 / 対応予定タスク。
本ラウンドで処理した 5 指摘の結果と、そこから残った懸念だけを書く。
`docs/task-list.json` の `task_011.concerns` の記述より本ファイルが新しい
（同ファイルの concerns #2（check_071 の rule 文言）と #3（wrangler.toml の
`localConnectionString`）は本ラウンドで処置済み。並行タスクとの書き込み衝突を
避けるため task-list.json 側は書き換えていない）。

---

## 処理結果の一覧（本ラウンドの 5 指摘）

| # | 指摘 | 結果 |
|---|---|---|
| 1 | anon / authenticated の権限剥奪が既存テーブルにしか効かない | **修正**（`0005_default_privileges_revoke.sql`。遮断テスト 2 件追加） |
| 2 | payment_event の invoice_id と attempt_id の独立 FK による食い違い | **修正**（`0006_payment_event_attempt_scope_fk.sql`。遮断／通過テスト 4 件追加） |
| 3 | check_071 の rule 文言と実判定の不一致 | **修正**（`docs/acceptance-checks.json` の `rule` を差し替え） |
| 4 | wrangler.toml の `localConnectionString` が `resolveDbConnection()` に拒否される | **修正**（案 B: 明示フラグ `ALLOW_PRIVILEGED_DB_ROLE`。単体テスト 6 件追加） |
| 5 | 「gate.yml に integration ジョブが追加され PR で緑」 | **deferred**（下記 C-011-1。静的検証のみ実施） |

## 処理結果の一覧（2 周目レビューの 4 指摘）

| # | 深刻度 | 指摘 | 結果 |
|---|---|---|---|
| 1 | high | `?user=postgres` を足すだけで `resolveDbConnection()` のロール検査を迂回できる | **修正**（`client.ts`: クエリパラメータ許可リスト＋`createVerifiedDbClient()` の実ロール検査。単体 5 → 20 ケース、統合に `db-role.test.ts` 5 ケース追加） |
| 2 | medium | `payment_attempt.provider_binding_id` / `event.provider_binding_id` の cross-owner・provider_key 食い違い | **一部修正**（`0007_provider_binding_scope_fk.sql`。event の両方と payment_attempt の provider_key を閉塞。payment_attempt の cross-owner は下記 C-011-7 で PO 裁定へ） |
| 3 | medium | `ALLOW_PRIVILEGED_DB_ROLE` の `APP_ENV === "development"` はローカル限定条件になっていない | **修正**（4 条件目として「経路が direct」を追加。Hyperdrive 経路では常に拒否。C-011-4 を更新） |
| 4 | medium | 「gate.yml に integration ジョブが追加され PR で緑」が未達 | **deferred 継続**（C-011-1。指摘自身が「現環境では修正不能のため deferred で正しい」としている） |

## 処理結果の一覧（3 周目レビューの 4 指摘 ＋ 検証失敗 1 件）

| # | 深刻度 | 指摘 | 結果 |
|---|---|---|---|
| 0 | （検証失敗） | `npm run test:integration` が exit 1（`tuple concurrently updated` で `db-role.test.ts` が 5 skipped） | **修正**（下記 #1 と同一原因） |
| 1 | high | `ensureAppRwLoginPassword()` の `ALTER ROLE` が並列ワーカーから同時に走り、統合テストが間欠的に落ちる | **修正**（`tests/integration/setup.ts` をアドバイザリロックで直列化。回帰テスト 1 件追加、58 → 59 ケース） |
| 2 | medium | 最終 HEAD の失敗 run が run-log に未コミットのまま放置されている | **修正**（失敗 run を消さずにそのまま残し、修正後の最終 HEAD での再実行ログと一緒にコミットした） |
| 3 | medium | 「gate.yml に integration ジョブが追加され PR で緑」が未達 | **deferred 継続**（C-011-1。`.github/workflows/` は `gate-integration.yml` 1 本のみ・`gate.yml` 不在・`docs/run-log/task_009.json` 不在を本ラウンドでも再確認） |
| 4 | medium | `payment_attempt` の cross-owner が 0007 適用後も DB で塞がれていない | **deferred 継続**（C-011-7。指摘の `fix` 自身が「PO 裁定（task_017 / task_018）で (a)/(b) を選ぶ」としており、入口となる `createCheckout` は task_017 の担当で未着手） |

---

## C-011-1 — CI の実走（PR で緑・required status check 登録）

> **解消（2026-09-24、メインセッションで実測）**: GitHub リモート `sawanori/cashapp` 作成後、
> `.github/workflows/gate-integration.yml` は main への push で実走し、integration ジョブは
> success（run 35985828326、以降 e03a539 / d722cc4 / 16ec887 / 8ecf3be でも success）。main の
> ブランチ保護 required status checks に `integration` が含まれることを
> `gh api repos/sawanori/cashapp/branches/main/protection` で確認した。「実 PR での緑」は PR 運用に
> 切り替えた時点で改めて確認する（enforce_admins=false のため現在は管理者の直 push）。
> 台帳の severity は high → low に更新。

- **指摘**: done_definition 第 5 項「gate.yml に integration ジョブが追加され PR で緑」が未達。
- **深刻度**: medium
- **状態**: **deferred: GitHub リモート作成後に実施**
- **理由**: GitHub リモートが未作成（PO 判断待ち）で、`git push` は本ワークフローの禁止コマンド。
  CI を一度も実走できないため「PR で緑」「required status checks に含まれる」は原理的に証明できない。
  加えて `.github/workflows/gate.yml` は task_009 の所有物で本タスクは編集しない
  （並行タスク衝突回避の規約）。task_009 は本ラウンド時点で未着手（`gate.yml` 不在、
  `docs/run-log/task_009.json` 不在）。
- **本ラウンドで実施した静的検証**（`tests/integration/ci-workflow.test.ts`、3 ケース）:
  1. `.github/workflows/gate-integration.yml` が規約どおりの名前で実在し、`yaml` パーサで
     妥当に parse でき、`jobs` がファイル名由来の `integration` ちょうど 1 つである
  2. ステップの `run:` が呼ぶ `npm run <script>` がすべて `package.json` の scripts に実在する
     （空振り禁止つき。`test:integration` / `gates:sync` / `db:diff:drizzle` の 3 本の存在も必須にした）
  3. 運用上の禁止コマンド（`supabase stop` / `supabase db reset`）を含まない
- **2 周目レビューでの再確認（2026-09-24）**: 同じ指摘が medium で再提出され、
  レビュー自身が「現環境では修正不能のため deferred で正しい」と結論している。
  本ラウンドでも `.github/workflows/` は `gate-integration.yml` 1 本のみ、`gate.yml` は不在、
  `docs/run-log/task_009.json` も不在であることを確認した。状態は deferred のまま変わらない。
- **対応予定タスク**: task_009（`gate.yml` 作成と `gate-integration / integration` の
  required status check 登録）→ その後に実 PR で緑を確認。

---

## C-011-2 — `supabase_admin` 由来の既定権限は剥がせない

- **指摘**: `0005_default_privileges_revoke.sql` は `pg_default_acl` のうち
  grantor が `postgres`（＝マイグレーション実行ロール）のものしか剥がせない。
  `supabase_admin` が schema `public` に持つ既定権限は
  `{postgres=…,anon=arwdDxtm/supabase_admin,authenticated=arwdDxtm/supabase_admin,service_role=…}`
  のまま残る。
- **深刻度**: low
- **状態**: **accepted-risk**
- **理由**: `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` は実行ロールが
  `supabase_admin` のメンバーであることを要求するが、`postgres` はメンバーではない
  （実測: `pg_auth_members` の `postgres` の所属は
  `pg_read_all_data, pg_monitor, pg_signal_backend, pg_create_subscription, app_rw,
  authenticated, anon, service_role, authenticator, supabase_functions_admin` のみ。
  `supabase_admin` を含まない）。本アプリのテーブル・シーケンス・関数はすべて
  `postgres` が作るため、この既定権限が実際に効く場面は無い。
- **残余リスクの条件**: 将来 `supabase_admin` が schema `public` にオブジェクトを作った場合
  （Supabase の拡張機能導入などで起こりうる）、そのオブジェクトに anon / authenticated の
  全権が付く。検知は統合テストの「`public` に新しく作られたテーブルに anon / authenticated の
  権限が付かない」では拾えない（このテストは migrator = `postgres` として作るため）。
- **対応予定タスク**: task_024（本番プロジェクト構築）で、本番 Supabase の
  `pg_default_acl` を一度スナップショットし、`supabase_admin` 由来行の要否を判断する。

## C-011-3 — `service_role` の既定権限は対象外にした

- **指摘**: `0005` は指摘の文言どおり anon / authenticated だけを対象にしており、
  `service_role` の既定権限（`service_role=arwdDxtm/postgres`）は残している。
- **深刻度**: low
- **状態**: **accepted-risk**
- **理由**: `0001_init.sql` の権限節も anon / authenticated の 2 ロールのみを対象にしており、
  スコープを揃えた。`service_role` は Supabase の PostgREST 経由でのみ到達するロールで、
  本アプリは PostgREST を使わない（I3）。ランタイムが service role キーを持たないことは
  `.env.example` のランタイム欄検査（check_069）で機械的に守られている。
- **対応予定タスク**: task_024（本番の PostgREST 無効化・鍵の棚卸しと併せて判断）。

## C-011-4 — `ALLOW_PRIVILEGED_DB_ROLE` は「抜け道を増やした」こと自体が残余リスク

- **指摘**: 指摘 4 の対処として案 B（明示フラグ）を採ったため、
  `resolveDbConnection()` に `app_rw` 以外を通す経路が 1 本増えた。
- **深刻度**: low
- **状態**: **accepted-risk**
- **採った案と理由**: 案 A（ローカル用 `app_rw` パスワード付きロールを seed で用意し
  `localConnectionString` を `app_rw` に変える）は、(a) `wrangler.toml` が task_003 の
  `files_to_create` かつ task_035 の `files_to_modify` で本タスクの担当範囲外、
  (b) パスワードをマイグレーションに書かない方針（`0001_init.sql` の権限節のコメント）に反する、
  (c) `supabase/seed.sql` は `supabase db reset` でしか走らず、その `db reset` が本ワークフローの
  禁止コマンド、の 3 点で採れなかった。案 B は変更が `src/lib/db/client.ts`（本タスクの所有物）と
  `.dev.vars.example` の記載だけで閉じる。
- **緩和（2 周目レビューで 1 条件追加し 4 条件にした）**: フラグは次の 4 条件が**すべて**
  成立するときだけ効く。
  1. **経路が `direct`（= `DATABASE_URL`）。Hyperdrive 経路では常に拒否する**
  2. `ALLOW_PRIVILEGED_DB_ROLE` が厳密に文字列 `"1"`
  3. `APP_ENV` が厳密に `"development"`
  4. 接続先ホストがループバック（`127.0.0.1` / `localhost` / `::1` / `[::1]`）
  条件を 1 つずつ欠けさせた否定ケースを `tests/unit/db-client.test.ts` に持つ（同ファイルは
  15 → 20 ケース）。さらに統合テストで「`.env.example` にこの名前が無い」
  「`.dev.vars.example` にあり、かつ既定ではコメントアウトされている」
  「`wrangler.toml` にこの名前が無い」を機械検査する。
- **条件 1 を足した理由（2 周目レビュー指摘 3）**: 初回の記述は「staging / production の
  `[vars]` は別値なので届かない」としていたが、これは**既定環境を扱えていなかった**。
  `wrangler.toml` のトップレベル `[vars] APP_ENV = "development"` は
  `name = "cashapp-dev"` のデプロイ可能な既定環境の値であり、`--env` なしの
  `wrangler deploy` で実在のリモート Worker が `APP_ENV=development` で動く。
  残る唯一のローカル条件だったループバック判定も、デプロイ後の
  `env.HYPERDRIVE.connectionString` のホスト形式が一次資料に無い以上は保証にならない
  （`docs/vendor-docs/cloudflare/hyperdrive.md` に [不明] として追記した）。
  Hyperdrive バインディングはデプロイ後のランタイムにこそ存在するので、
  「経路が `direct` であること」を条件にすれば、この不明点に依存せず締められる。
- **`wrangler dev` / `npm run cf:dev` への影響**: 条件 1 により、このフラグでは
  Hyperdrive 経路は通らなくなった。ローカルで cf:dev を動かす手段は
  Hyperdrive の一次資料の「方法 2」に切り替える（環境変数
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` に `app_rw` の接続文字列を
  与える。環境変数は `wrangler.toml` の設定より優先される）。手順は
  `.dev.vars.example` に書いた。**この経路の実走確認は未実施**（`wrangler dev` を
  本セッションで起動していない）。
- **残余リスク**: `.dev.vars` は開発者の手元ファイルなので、開発者が
  `APP_ENV=development` のままリモートの DB を `DATABASE_URL` で指した場合は
  ループバック判定で止まる。止まらないのは「ローカルの `supabase start` に特権ロールで
  入る」場合だけで、これはローカル DB に対する既存の権限と等価。
- **対応予定タスク**: task_035（`localConnectionString` を `app_rw` に揃える作業が scope に
  記載済み）。それが完了すればフラグは不要になるので、その時点で削除を検討する。

## C-011-5 — `check_071` は `rule` だけ直し `verification_method` は据え置いた

- **指摘**: `docs/acceptance-checks.json` の check_071 の `verification_method` は
  `"npm run test:integration（setup で db diff）"` のままで、drizzle 側の判定器
  （`npm run db:diff:drizzle` / `scripts/db-diff-drizzle.mjs`）に触れていない。
- **深刻度**: low
- **状態**: **deferred**
- **理由**: 本タスクに与えられた許可は「acceptance-checks.json の **rule 文言**の修正」に
  限定されている。`verification_method` の書き換えは PO 専管（task_038）に残す。
- **対応予定タスク**: task_038（check_071 の裁定）。

## C-011-7 — `payment_attempt` の cross-owner はまだ DB で塞げていない

- **指摘**: `0007_provider_binding_scope_fk.sql` は `event` の cross-owner と
  provider_key 食い違い、`payment_attempt` の provider_key 食い違いを閉じたが、
  **`payment_attempt` が「別の幹事が所有するバインディング」を指す行**は、
  provider_key さえ一致していれば今も受理される。
- **深刻度**: medium
- **状態**: **deferred: PO 裁定（task_017 / task_018）**
- **実測（0007 適用後・BEGIN/ROLLBACK 内）**: 幹事 O1 のイベント→請求に対して、
  O2 所有の `provider_binding`（`provider_key='paypay'`）を指し、`provider_key='paypay'` を
  名乗る `payment_attempt` を INSERT → `INSERT 0 1` で受理。
  `remaining_cross_owner_attempt_rows = 1`。
- **DB だけで閉じられない理由**: `payment_attempt` には `organizer_user_id` も `event_id` も
  無く、`invoice → event → organizer_user_id` の連鎖は複合 FK では届かない。閉じるには
  (a) `payment_attempt` に `event_id` を持たせて `invoice(event_id, id)`（0004 で作成済み）と
  `event(id, provider_binding_id)` の 2 本の複合 FK で縛るか、(b) 制約トリガを足すか、
  のどちらかで、いずれも `src/lib/db/schema.ts` とリポジトリ層（task_014）に波及する。
  列の追加は本ラウンドの許可範囲（レビュー指摘の修正）を超えるため PO 裁定に送る。
- **現時点の緩和**: `event` 側が cross-owner を閉じたため、「イベントに紐づく正しい
  バインディング」は DB 上で一意に決まる。残る穴は「アプリがそのイベントの
  バインディング以外を `payment_attempt` に渡した場合」に限られ、決済試行の生成は
  task_017 / task_018 の 1 経路に閉じる予定である。
- **対応予定タスク**: task_017 / task_018（決済試行の生成経路）。PO が (a)/(b) を裁定する。

## C-011-8 — 接続文字列のクエリパラメータ許可リストは実 Hyperdrive で未検証

- **指摘**: `parseConnection()` は許可リスト外のクエリパラメータを一律 `DbConfigError` に
  する。許可リストは postgres.js の `defaults`（`node_modules/postgres/cjs/src/index.js` の
  `parseOptions`）＋ `sslmode` で作った。デプロイ後の `env.HYPERDRIVE.connectionString` が
  これ以外のクエリパラメータを含んでいた場合、ランタイムが起動時に落ちる。
- **深刻度**: low
- **状態**: **accepted-risk**
- **理由**: 落ちるとしても静かな誤接続ではなく `DbConfigError` として即座に見えるため、
  「気づけない失敗」にはならない。逆に許可リストを緩めると `?user=` 型の迂回が戻る。
  Hyperdrive の一次資料には `connectionString` の形式の記載が無い（本ラウンドで
  `docs/vendor-docs/cloudflare/hyperdrive.md` に [不明] として追記）。
- **対応予定タスク**: task_035（実 Hyperdrive ID 発行後に `connectionString` を 1 回実測し、
  必要なら許可リストに追記して [実測] として vendor-docs に残す）。

## C-011-9 — 追記専用の担保はロール分離だけに乗っている（所有者は `postgres`）

- **指摘**: `ledger_entry` と `audit_log` の所有者は `postgres` である
  （実測: `SELECT tableowner FROM pg_tables …` → 両方 `postgres`）。テーブル所有者は
  `ALTER TABLE … DISABLE TRIGGER` を実行できるため、**`postgres` で接続できた時点で
  check_013 の追記専用トリガは外せる**。つまり追記専用の担保は「ランタイムが
  `postgres` になれないこと」だけに乗っている。
- **深刻度**: low（本ラウンドの修正で前提が二重化されたため）
- **状態**: **accepted-risk**
- **根拠**: `postgres` へ到達する経路は本ラウンドで 2 段に絞られた。
  (1) 接続文字列のロール検査＋クエリパラメータ許可リスト（`?user=` 迂回の封鎖）、
  (2) `createVerifiedDbClient()` の `SELECT session_user` による実ロール照合。
  加えて `.env.example` のランタイム欄に特権ロールを置かないことは check_069 が検査する。
- **将来の選択肢**: 追記専用テーブルの所有者を、ランタイムからも
  マイグレーション実行ロールからも分離した専用ロールにする（所有者だけがトリガを
  外せる構造は変わらないが、`postgres` 1 つの奪取では外せなくなる）。
  本番プロジェクトの権限設計と一体で判断するのが妥当。
- **対応予定タスク**: task_024（本番プロジェクト構築・権限の棚卸し）。

## C-011-10 — `ALTER ROLE app_rw` の直列化は 1 つのヘルパ内だけで閉じている

- **指摘**: 3 周目レビュー high の対処として `ensureAppRwLoginPassword()` を
  `pg_advisory_xact_lock(1101100001)` を張ったトランザクションで包んだが、
  アドバイザリロックは**同じ鍵を取る側にしか効かない**。将来このヘルパを経由せずに
  `ALTER ROLE app_rw ...` を撃つコード（別の統合テスト・seed・運用スクリプト）が
  増えると、同じ `tuple concurrently updated` が再発する。
- **深刻度**: low
- **状態**: **accepted-risk**
- **実測（本ラウンド）**:
  - 再現（修正前）: 2 本の psql から同時に `ALTER ROLE app_rw LOGIN PASSWORD ...` →
    **3/3 回** `ERROR: tuple concurrently updated`。
  - ロックの効果: 同じ文を `BEGIN; SELECT pg_advisory_xact_lock(1101100001); … COMMIT;` で
    包んで 3 本同時 × 5 回 → **15/15 回 COMMIT**（失敗 0）。
  - 回帰テストの妥当性: 追加した「独立した 4 接続から同時に呼ぶ」ケースは、修正を外すと
    **3/3 回 fail**（4 本中 3 本が `tuple concurrently updated` で reject）、
    修正を戻すと pass する。
  - スイート全体（回帰テスト追加前）: `npm run test:integration` を **10 連続** で実行し
    10/10 が exit 0・`Tests 58 passed (58)`・skip 0。
  - スイート全体（回帰テスト追加後）: **6 連続** で 6/6 が exit 0・`Tests 59 passed (59)`・skip 0。
  - 比較対象: レビューの実測では修正前が 5 回中 2 回 exit 1（`Tests 53 passed | 5 skipped`）。
- **緩和**: 鍵の定数と「使用箇所はこの関数だけに限る」旨を `setup.ts` のコメントに明記した。
- **対応予定タスク**: 統合テストを増やす後続タスク（task_014 以降）で `ALTER ROLE` が要る場合は
  必ずこのヘルパを経由する。

## C-011-6 — 担当範囲外のファイルに触れた

- **指摘**: 本ラウンドで task_011 の `files_to_create` / `files_to_modify` に無いファイルを
  4 つ触った。
- **深刻度**: low
- **状態**: **accepted-risk**（いずれも本ラウンドの指示が明示的に要求したもの）
- **内訳**:
  - `docs/acceptance-checks.json` — 指摘 3 が「本タスクに限り許可」と明記
  - `.dev.vars.example`（task_003 の `files_to_create`）— 指摘 4 が
    「`ALLOW_PRIVILEGED_DB_ROLE=1` は `.dev.vars.example` にのみ記載」と明記
  - `tests/integration/ci-workflow.test.ts` — 指摘 5 の静的検証の置き場。
    どのタスクの `files_to_create` にも含まれない新規ファイル
  - `supabase/migrations/0005` / `0006` / `0007` — `0001` を直接書き換えると適用済みローカル DB と
    shadow DB がずれ、整合に禁止コマンド（`supabase db reset`）が要るため追加マイグレーションにした
    （0003 / 0004 と同じ判断）
  - `docs/vendor-docs/cloudflare/hyperdrive.md`（task_003 の `files_to_create`）— 2 周目レビュー
    指摘 3 が「Hyperdrive の `connectionString` のホスト形式を一次資料で確認して
    vendor-docs に残す」と明記。既存の節を書き換えず、節を 1 つ追記しただけ
  - `tests/integration/db-role.test.ts` — 2 周目レビュー指摘 1（`?user=` 迂回）の遮断テストの
    置き場。どのタスクの `files_to_create` にも含まれない新規ファイル
- **触っていない**: `wrangler.toml`（task_003 / task_035 の所有）、
  `.github/workflows/gate.yml`（task_009 の所有）、`.claude/settings.json`、
  `docs/task-list.json`（並行タスクとの書き込み衝突回避）。
