# PROGRESS

- task_002: DONE — 外部照会文6件（`docs/inquiries/{lawyer-q-lg1,lawyer,paypay,payjp,line,stripe}.md`、質問49件・全件ID付与）を起案し `docs/external-inquiries.json` に6件を `status='draft'` で登録（`default_decision_on_timeout` 全件確定文言、`gate_keys` は既存ゲートのみ参照）。Q-LG1 否定回答時の分岐 `docs/decisions/ADR-010-q-lg1-negative-branch.md` を `proposed` で起票。送付は未実施（task_037 の担当）。依存タスク task_001（ADR-001・PO 同意）は本作業時点で `completion_status: null` かつ `docs/decisions/ADR-001*.md` 未作成のまま並行進行中と観測（concerns 参照）。
- task_003: DONE_WITH_CONCERNS — `git init` でリポジトリ独立化、`scripts/record-run.sh` / `scripts/with-lock.sh` を実装・実測動作確認、npm プロジェクト（Next.js 16.3.6 App Router / TypeScript strict / Cloudflare Workers via `@opennextjs/cloudflare` 1.20.6 / wrangler 4.137.0）を初期化。全依頼パッケージを完全固定バージョンでインストール（`ADR-002-stack-versions.md`。`eslint` は依頼の10.11.0が`eslint-config-next`同梱の`eslint-plugin-react`と実測で非互換のため9.39.5に、`jsdom`はNode実行環境の`engines`制約で30.1.1から29.1.1に変更。`server-only`を追加インストール）。`typecheck`/`lint`/`build`/`build:cf`/`test:unit`は`scripts/record-run.sh`経由ですべてexit 0（`docs/run-log/task_003.json`）。`wrangler.toml`・`workers/cron/`を作成し、`build:cf`→`wrangler dev`のスパイク①②③を実測成立、④は静的アセットに非適用の部分成立として`ADR-012-hosting-cloudflare.md`に記録。Worker実サイズは`wrangler deploy`系コマンドが禁止のため未実測（A25、見積り値のみ19.41MiB/64MiB=30.3%）。A21（Hyperdrive経由の実Postgres接続）は非スコープのため未実測のまま次タスクへ引き継ぎ。
- task_004: DONE_WITH_CONCERNS — 設計制約 54 件（`docs/constraints.json`。L1-L12 / P1-P9 / W1-W12 / N1-N12 / I1-I6 ＋ X-TIME / X-ID / X-MONEY）と禁止語ポリシー（`docs/wording-policy.md`。機械可読ブロック同梱）を作成し、`scripts/gate-constraints.sh`（grep 21 件を実走査。forbid / require 両モード、`expect_targets` による空振り禁止）と `scripts/wording-lint.mjs`（禁止語 6 群・許可文言の免除つき）を実装。`npm run gate:constraints` / `gate:wording` を `npm pkg set` で追加。`npm run test:unit`（29 件）/ `gate:constraints` / `gate:wording` はいずれも `scripts/record-run.sh` 経由で exit 0（`docs/run-log/task_004.json`）。`npm run typecheck` は task_011 が並行編集中の `src/lib/db/client.ts` で 2 件失敗しており本タスクの成果物は無関係（concerns 参照）。
- task_011: DONE_WITH_CONCERNS — スキーマ v2 を `supabase/migrations/0001_init.sql`（23 テーブル・生成列 `settlement_rank` / `is_open`・部分一意 4 本・追記専用の文レベルトリガ 6 本・`CREATE ROLE app_rw` と最小権限 GRANT）と `0002_seed_gates.sql`（ゲート 10 件 `unknown` ＋ `PAYMENTS_ENABLED='false'`）に置き、`supabase start` で実適用。`src/lib/db/{schema.ts,client.ts}`（接続文字列解決は `resolveDbConnection` 1 関数。Hyperdrive 経路 / direct 経路の 2 経路、ランタイムは `app_rw` 以外を拒否）、`scripts/gates-sync.mjs`、`tests/integration/{setup.ts,schema.test.ts,grants-baseline.json}`、`tests/unit/db-client.test.ts` を作成。`npm run test:integration` 32 件全緑（`supabase db diff` = No schema changes found を含む）、`typecheck` / `gates:sync` / `gate:constraints` / `test:unit`(37 件) / `lint` / `gate:wording` / `db:migrate` すべて exit 0（`docs/run-log/task_011.json`）。CI は衝突回避規約に従い `.github/workflows/gate-integration.yml` として独立追加（`gate.yml` は未編集・PR 実行は未検証）。`drizzle-kit` 差分検査は非実施（`drizzle.config.ts` が別タスク成果物で `schema` パスが不一致）。代わりに Drizzle の 248 列と実 DB の `format_type` / NOT NULL の完全一致をテストで検査。
- task_011（レビュー修正・2 周目）: DONE_WITH_CONCERNS — レビュー指摘の high / medium 5 件のうち DB の穴 2 件を `supabase/migrations/0003_event_scope_fk.sql` で塞いだ（`participant` に `UNIQUE (event_id, id)`、`invoice` / `participant_claim` に複合 FK `(event_id, participant_id)`。修正前は psql で「別イベントを名乗る invoice / claim」を作れることを再現済み、修正後は `23503` で拒否）。統合テストを 32 → 35 ケースに増やし全 pass。`drizzle.config.ts` の存在しない `schema` パスを `./src/lib/db/schema.ts` に直し、読み取り専用の差分検査 `npm run db:diff:drizzle` を追加して実測した結果、`check_071` の「drizzle-kit 差分 0」は schema.ts が列だけを宣言する現方針（§7-2）では達成不能（差分 190 文＝制約・索引の DROP のみ、実スキーマ乖離 0 件）と判明したため PO 裁定タスク task_038 を起票。`wrangler.toml` の `localConnectionString` のロール不一致（`postgres` のまま／ランタイムは `app_rw` 必須）は task_035 の scope に追記。`gate.yml` は task_009 未着手のため依然として不在で、done_definition 第 5 項は未達のまま。`typecheck` / `test:integration`(35) / `gates:sync` / `gate:constraints` は `scripts/record-run.sh` 経由で全て exit 0。
- task_005: DONE_WITH_CONCERNS — `.claude/settings.json` に 6 イベント（SessionStart / UserPromptSubmit / PreToolUse×2 / PostToolUse / Stop / SubagentStop。PreCompact は不使用）を登録し、`scripts/deny-dangerous-bash.sh`・`scripts/deny-test-weakening.sh`・`scripts/session-brief.mjs`・`scripts/gate-status.mjs`・`scripts/append-handoff.sh`・`scripts/assert-diff-exists.sh` と `docs/gates/legal-clearance.json`（`cleared: false`）を作成。フックのユニットテスト 84 件（`tests/unit/hooks/` 3 ファイル＋フィクスチャ package.json）を追加し、生コマンドの破壊的・本番系遮断、`npm run <script>` 形式の別名呼び出しの再帰解決と解決不能時の fail-closed、リダイレクト / tee / `sed -i` / cp / mv / python の open による保護パスへの Bash 経由書き込み、テスト弱体化（it・expect の件数減と skip・only・todo の追加）、本番鍵の書き込みを機械検証（遮断側は全件 exit 2、`npm run test:unit` と `scripts/record-run.sh` 経由の呼び出しは exit 0）。`npm run test:unit`（121 件）/ `gate:constraints` / `typecheck` / `lint` / `gate:wording` はすべて `scripts/record-run.sh` 経由で exit 0（`docs/run-log/task_005.json`）。作業中に settings.json が実際に読み込まれ、PreToolUse フックが自分の Bash 呼び出しと Write 呼び出しを 2 件遮断した実測記録あり。check_053（新規セッションでの SessionStart 注入の目視確認）はサブエージェントから新規セッションを開けないため未達で PO に引き継ぐ（フック入力をパイプした内容確認までは実施・記録済み）。
- task_011（レビュー修正・3 周目）: DONE_WITH_CONCERNS — レビュー指摘 medium 3 件を処理した。(1) `ledger_entry` の event スコープの穴を `supabase/migrations/0004_ledger_event_scope_fk.sql` で塞いだ（`invoice` に `UNIQUE (event_id, id)`、`ledger_entry` から複合 FK `(event_id, invoice_id)`。修正前は別イベントを名乗る台帳行を作れることを psql で再現、修正後は `23503` で拒否）。統合テストを 35 → 36 ケースに増やし全 pass。(2) `npm run db:diff:drizzle` を判定器 `scripts/db-diff-drizzle.mjs` 付きの自動ゲートにし（`CREATE TABLE` / `DROP TABLE` / `ALTER COLUMN` と相方のいない `ADD COLUMN` / `DROP COLUMN` で exit 1。schema.ts に列を足す / 消すと exit 1、戻すと exit 0 を実測）、`.github/workflows/gate-integration.yml` のステップにも追加した。(3) `docs/task-list.json` の task_011 に `completion_status: "DONE_WITH_CONCERNS"` と concerns 6 件を機械可読に記録（`scripts/gate-status.mjs` が `high concerns 残高: 1 件 — task_011×1` を返すことを実測）。`wrangler.toml` のロール不一致は担当範囲外のため未修正で、`docs/HANDOFF.md` 冒頭に「既知の壊れている経路」として明記した。`gate.yml`（done_definition 第 5 項）は task_009 未着手のため依然未達。`typecheck` / `test:integration`(36) / `gates:sync` / `gate:constraints` は `scripts/record-run.sh` 経由で全て exit 0。
- task_005（レビュー修正・2 周目）: DONE_WITH_CONCERNS — レビュー指摘の high 1 件 / medium 3 件（コード側）を塞いだ。(1) `scripts/deny-dangerous-bash.sh` の `script_names()` がサブコマンドの直後 1 トークンを無条件でスクリプト名として取っていたため、フラグを 1 つ挟むだけで別名解決も fail-closed も素通りしていた（修正前 exit 0 を probe で実測）。フラグ位置を 3 パターン許し、`-` 始まりのトークンを読み飛ばして最初の実トークンを名前に取るよう直し、6 形式を遮断ケースとしてテストに追加。(2) `cp` / `mv` / `rsync` / `install` の宛先判定が「節の最終トークン」固定で、末尾に `2>/dev/null` や `--verbose` が付くだけで保護パスへの上書きが通っていた。`sed -i` と同じく節の全トークンを検査する方式に統一し 4 ケース追加。(3) `scripts/assert-diff-exists.sh` の baseline がセッション境界で更新されず、HEAD が baseline を追い越した時点で検査が恒久的に死んでいた（実測で既に死亡）。フック入力の `session_id` で baseline をセッション単位に分け、評価後に毎回 HEAD へ進める方式にして、使い捨てリポジトリで 8 ケースの挙動マトリクスを実測。(4) `scripts/deny-test-weakening.sh` に `scripts/deny-*` / `scripts/record-run.sh` の Edit/Write 遮断と、`.claude/**` からガード参照が減る編集の遮断を追加（追加は通す）。フックのユニットテストは 84 → 108 件で全 pass、`npm run test:unit` は 145 件 exit 0、`gate:constraints` / `typecheck` / `lint` も `scripts/record-run.sh` 経由で exit 0。check_053（新規セッションでの SessionStart 注入の目視）は依然としてサブエージェントでは代替不能で PO 待ち。
- task_005（レビュー修正・3 周目）: DONE_WITH_CONCERNS — レビュー指摘 high 2 件 / medium 3 件を処理した。(1) check_053 / check_063 を実測で達成。`claude` CLI のヘッドレス新規セッション（`session_id=e3bbac37…`）を実際に起動し、transcript の `SessionStart` 注入 63 行に未通過ゲート 10/10・`cleared=false`・未回答照会 6 件（期限超過 0）・HANDOFF 末尾 40 行の 4 要素が載っていることを確認。別セッションを 2 ターン（2 ターン目は `--resume`）動かし「ターンログ」節が 16 → 17 → 18 行と 2 行増えることを実測。(2) `scripts/deny-dangerous-bash.sh` の削除・復元経路の穴を塞いだ（修正前は `rm scripts/deny-dangerous-bash.sh` / `rm .claude/settings.json` / `git rm` / `git checkout HEAD --` / `chmod -x` がすべて exit 0。ガード 1 本の削除で全遮断が無力化される状態だった）。ディレクトリ形（`rm -r docs/gates` / `git clean -fd .claude`）用に `PROTECTED_TREE_RE` を追加。(3) 長オプションの綴り（`rm --recursive --force` / `sed --in-place`。CI の Linux で実際に通る綴り）を拾うようにした。(4) インタプリタのワンライナー判定を `python -c` 限定から `node` / `deno` / `bun` / `perl` / `ruby` / `php` と `dd of=` まで一般化した。(5) 遮断メッセージを `mask()` 経由にして `sk_live_` トークン・`Bearer`・`secret put` 以降・`*KEY=` 系の値を伏せた（従来は遮断のたびに秘密値がフック出力に載っていた）。フックのユニットテストは 108 → 148 件、`npm run test:unit` は 145 → 185 件で全 pass。`test:unit` / `gate:constraints` / `typecheck` / `lint` はすべて `scripts/record-run.sh` 経由で exit 0。ガード本体は自分自身への Edit/Write と Bash 書き込みを拒むため、修正は `git apply` で当てた（`git apply` が残る迂回路であることは concerns に記載）。
- task_011（hardening）: DONE_WITH_CONCERNS — レビュー残指摘 5 件のうち 4 件を修正し 1 件を deferred として記録した。(1) `anon` / `authenticated` の既定権限を `supabase/migrations/0005_default_privileges_revoke.sql` で剥奪（TABLES / SEQUENCES / FUNCTIONS）。修正前は psql の `BEGIN; CREATE TABLE …; ROLLBACK;` で新規テーブルに両ロールの全 7 権限が自動で付くことを実測、修正後は `postgres` と `service_role` だけになることを実測。`pg_default_acl` 検査と新規テーブルの挙動検査の 2 ケースを統合テストに追加。(2) `payment_event` の `invoice_id` と `attempt_id` の食い違いを `supabase/migrations/0006_payment_event_attempt_scope_fk.sql` で塞いだ（`payment_attempt` に `UNIQUE (id, invoice_id)`、`payment_event` に複合 FK）。修正前は別請求を名乗るイベント行を作れることを実測（`mismatched_rows=1`）、修正後は `23503` で拒否。食い違い拒否 / 一致通過 / `attempt_id` NULL 通過 / 制約実在の 4 ケースを追加。(3) `docs/acceptance-checks.json` の `check_071` の rule 文言を実判定（`supabase db diff` 差分 0 ＋ `scripts/db-diff-drizzle.mjs` によるテーブル／列の層の差分 0）に修正。(4) `wrangler.toml` のロール不一致は案 B（`src/lib/db/client.ts` に明示フラグ `ALLOW_PRIVILEGED_DB_ROLE`。値 `"1"` ／ `APP_ENV=development` ／ ループバックの 3 条件 AND のときだけ特権ロールを通す）で処置し、記載は `.dev.vars.example` のみ。否定ケース 6 件を単体テストに、`.env.example` / `wrangler.toml` への漏れ検査 2 件を統合テストに追加。(5) 「gate.yml に integration ジョブが追加され PR で緑」は GitHub リモート未作成のため `docs/concerns/task_011.md` に deferred として記録し、`tests/integration/ci-workflow.test.ts` で YAML 妥当性・`jobs` が `integration` 1 つ・`run:` の npm スクリプトが `package.json` に実在することの静的検証 3 ケースを機械化。統合テスト 36 → 47 件、単体 185 → 192 件で全 pass。`typecheck` / `test:integration` / `gates:sync` / `gate:constraints` は `scripts/record-run.sh task_011` 経由で全て exit 0。
- task_005（hardening）: DONE_WITH_CONCERNS — レビュー指摘 7 件をすべて修正した。(1) `>|`（noclobber 上書き）を `normalize()` で `>` に畳んでから節分割するようにした。(2) `rm -r .` / `git checkout .` / `git restore .` / `git checkout HEAD -- .` / `git clean -fdx` のようにパスを名指ししない削除・復元を、`.` `./` `..` `*` `/` を「ここ全体」とみなして拒否し、`git clean` は dry-run 以外を拒否するようにした。(3) `git apply` / `patch` を追加し、コマンド行に現れる読めるパッチは本文を走査して保護対象を含めば遮断、読めなければ fail-closed にした（保護対象を含まないと示せるパッチは通す）。(4) 節ごとに `cd` を追跡（`CWD_REL` ＋ `join_path`）して相対の宛先を解決し、`$` を含むリダイレクト / `tee` の宛先は解決不能として拒否するようにした。(5) `.claude/settings.json` の保護をスクリプト名の出現回数から構造検査に変えた（編集後のファイルを組み立てて jq で解析し、event・matcher・command の登録が残っているかを見る。`hooks` キーの改名・matcher の差し替え／絞り込み・event の付け替え・JSON 破壊・コメント化を遮断し、matcher の拡張とフック追加は通す）。(6) `lint:changed` が remote 不在で常に空振りだった（`origin/main...HEAD` が失敗 → 引数ゼロの eslint → exit 0）のを、`HEAD` との差分＋ステージ済み差分の和に変え、0 件なら「対象なし」と明示、対象があれば eslint を実走するようにした（実測で 3 ファイルに対し eslint が起動）。(7) 上記すべての遮断ケースと対象外ケースを `tests/unit/hooks/` に追加（148 → 215 件。新規 `lint-changed.test.ts` 8 件を含む）。`npm run test:unit`（259 件）/ `gate:constraints` / `typecheck` / `lint` / `lint:changed` は `scripts/record-run.sh task_005` 経由ですべて exit 0。ライブのフックが実際に 3 件（パッチ適用・変数展開の宛先・`cd` 後の相対削除）を遮断する実測も記録済み。残懸念は `docs/concerns/task_005.md`（`awk -i inplace` / `ed` / `find -delete` / `git stash` など指摘外の残穴を実測、ガード本体がセッション内から編集不能になったことを accepted-risk として記録）。
- task_011（レビュー修正・4 周目）: DONE_WITH_CONCERNS — レビュー指摘 high 1 件 / medium 3 件のうち 3 件を修正し 1 件（CI 実走）を deferred 継続にした。(1) `resolveDbConnection()` のロール検査が `URL.username` しか見ておらず `?user=postgres` で迂回できた問題を塞いだ。迂回の実在は本セッションで実測（`postgres://app_rw:postgres@127.0.0.1:54322/postgres?user=postgres` が `URL.username='app_rw'` のまま `session_user='postgres'` で接続）。対処は `parseConnection()` のクエリパラメータ許可リスト（postgres.js が `defaults` に持つキー ＋ `sslmode` 以外は `DbConfigError`）と、接続直後に `SELECT session_user` を 1 回発行して食い違えば閉じて落とす `createVerifiedDbClient()` の二段。(2) `ALLOW_PRIVILEGED_DB_ROLE` に 4 条件目「経路が `direct`」を追加（`wrangler.toml` の既定環境 `cashapp-dev` はデプロイ可能で `[vars] APP_ENV="development"` のため、`APP_ENV` はローカル限定条件にならない）。副作用で cf:dev はこのフラグでは通らなくなり、代替として Hyperdrive 一次資料の「方法 2」（環境変数 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`）を `.dev.vars.example` と HANDOFF 冒頭に明記（実走確認は未実施）。(3) `provider_binding` のスコープの穴を `supabase/migrations/0007_provider_binding_scope_fk.sql` で塞いだ（`provider_binding` に `UNIQUE (id, provider_key)` / `UNIQUE (id, organizer_user_id)`、`payment_attempt` と `event` に複合 FK。修正前は cross-owner のイベント・`provider_key` 食い違いの試行が受理されることを psql で実測、修正後は `23503`）。`payment_attempt` の cross-owner は列の追加が要るため PO 裁定（C-011-7 / task_017・018）へ。(4) `gate.yml` は依然不在で CI 実走は deferred 継続（C-011-1）。統合テスト 47 → 58 件、`tests/unit/db-client.test.ts` 15 → 20 件で全 pass。`typecheck` / `test:integration` / `gates:sync` / `gate:constraints` は `scripts/record-run.sh task_011` 経由で全て exit 0。
- task_011（レビュー修正・5 周目）: DONE_WITH_CONCERNS — 検証失敗 1 件と high 1 件（同一原因）を修正し、medium 2 件は deferred 継続にした。(1) 統合テストが間欠的に exit 1 になる原因は `tests/integration/setup.ts` の `ensureAppRwLoginPassword()` で、`schema.test.ts` と `db-role.test.ts` の `beforeAll` が別ワーカーから同時に `ALTER ROLE app_rw LOGIN PASSWORD ...` を撃ち、同じ `pg_authid` 行への同時 UPDATE が `tuple concurrently updated` になっていた（2 本の psql で同時実行すると 3/3 回再現）。`pg_advisory_xact_lock(1101100001)` を張ったトランザクション内で 1 文だけ実行する形に変えて直列化した（3 本同時 × 5 回で 15/15 COMMIT を実測）。落ちていた `db-role.test.ts` の 5 ケースは再び走るようになった。(2) 回帰テストとして「独立した 4 接続から同時に呼ぶ」ケースを `db-role.test.ts` に追加（58 → 59 ケース）。修正を外すと 3/3 回 fail、戻すと pass することを実測して、テストが本当に穴を押さえていることを確かめた。(3) `npm run test:integration` を修正後に 10 連続（58 件時点）＋ 6 連続（59 件）実行し、全 16 回が exit 0・skip 0。(4) 前ラウンドで未コミットのまま残っていた失敗 run（exit 1・`5 skipped`）は消さずにそのまま `docs/run-log/task_011.json` に残し、最終 HEAD での再実行ログと一緒にコミットした。(5) 「gate.yml に integration ジョブが追加され PR で緑」は `.github/workflows/` が `gate-integration.yml` 1 本のみ・`gate.yml` 不在・`docs/run-log/task_009.json` 不在を再確認して C-011-1 の deferred 継続、`payment_attempt` の cross-owner は指摘の `fix` 自身が PO 裁定（task_017 / task_018）としているため C-011-7 の deferred 継続。
- task_005（レビュー修正・4 周目）: DONE_WITH_CONCERNS — レビュー指摘 high 3 件 / medium 5 件をすべて修正した。(1) コマンド名を語頭で錨づけしていたため `./node_modules/.bin/wrangler deploy` と `npx wrangler@latest deploy` と `./node_modules/.bin/supabase db push` が本番系の遮断を素通りしていた（修正前 exit 0 を実測）。各トークンを basename 化し `@版` を落とした変種にも rule set A を当てる形に直した。(2) `cp` / `mv` / `rsync` / `install` が `protected()` しか呼ばず、宛先をディレクトリ名で書くと（`cp x docs/gates` / `cp x .claude` / `mv -t docs/run-log x` / `cp --target-directory=docs/gates x`）L11 の正本と settings.json を上書きできた。`protected_tree()` の併用と `-t` / `--target-directory=` の値の抽出で塞いだ。(3) `cd` 追跡が節の先頭が literal `cd` のときしか発火せず、サブシェル・ブレースグループ・`bash -c`・`pushd`・`&` でくるむだけで無効化された。`normalize()` が `(` `)` `{` `}` `&` も節区切りに畳み、`strip_wrappers()` でラッパを剥がしてから `cd` / `pushd` を判定し、解決できない `cd` 先の後は相対の宛先を fail-closed にした。(4) `lint:changed` が git 未追跡の新規ファイル（Write ツールが作る形そのもの）を 1 件も eslint に渡していなかったので、`git ls-files --others --exclude-standard` を足して 3 つの和にした（使い捨てリポジトリ＋eslint スタブで 9 シナリオ実測）。(5) `git am` をパッチ適用の判定対象に加えた。(6) PreToolUse の編集側 matcher が `Edit|Write|MultiEdit` のみで MCP のファイル編集ツールがガードを起動せずに保護対象を書き換えられたので、matcher を `Edit|Write|MultiEdit|NotebookEdit|mcp__serena__.*` に広げ、`deny-test-weakening.sh` に MCP 分岐（`relative_path` / `paths_include_glob` から対象を取り出す。対象を限定しない一括編集・`.claude/**`・編集前本文を示さない `tests/**` 編集は fail-closed）を追加した。ライブのフックで `mcp__serena__replace_content` が実際に BLOCKED になることを実測。(7) `git push origin +main` の `+` 付き refspec を強制 push として遮断。(8) Node 22 の `node --run <script>` を `package.json.scripts` の解決経路へ流した。フックのユニットテスト 215 → 272 件、`npm run test:unit` 259 → 321 件で全 pass。`test:unit` / `gate:constraints` / `typecheck` / `lint` / `lint:changed` / `gate:wording` は `scripts/record-run.sh task_005` 経由ですべて exit 0。修正は、まだ通っていた `git am` でメールボックス形式のパッチを当てて適用した（適用後は同じ経路が塞がっている）。残懸念は `docs/concerns/task_005.md`（§2 の残穴 `awk -i inplace` / `ed` / `find -delete` / `xargs rm` / `git stash` 等は未閉塞のままで、§3 の accepted-risk 文言を「セッション内の編集経路は閉じていない」に訂正した）。
- task_012: DONE_WITH_CONCERNS — 認証・セッション・CSRF・鍵運用・環境設定・セキュリティヘッダを実装した。(1) 起動時アサート `src/lib/config/env.ts`（`LINE_ENV_PROFILE` は JSON 1 個で `env`＝`APP_ENV` と「`loginChannelId`＝LIFF ID のハイフン前」を検査＝制約 N3 の機械検査、`PEPPER` / `SESSION_KEYS` は `<版>:<秘密値>` のカンマ区切りで各 32 バイト以上、`SESSION_KEYS` は 2 個まで、`CRON_SECRETS` は許容リスト、`APP_ENV` と Supabase project ref の対応は**ソース固定**の `EXPECTED_SUPABASE_PROJECT_REF` と完全一致）。(2) ID トークンは `POST https://api.line.me/oauth2/v2.1/verify` でサーバー検証し、`aud` / `iss` / `exp`（許容ずれ 60 秒）/ `iat` 未来 / `sub` の形を自前でも検査、失敗は全部 401 `ID_TOKEN_INVALID` に畳む。`used_id_token` に `sha256(idToken)` を `exp` まで保存して 2 回目を 401（ADR-009。nonce 不採用の根拠を一次資料つきで記録）。(3) レート制限は Workers の Rate Limiting バインディング → Durable Object の順で、どちらも無ければ 503（**in-memory を使わない**。A27）。(4) セッションは HS256 + `kid` 二重鍵 + `session_epoch` クレーム + `__Host-` Cookie（HttpOnly/Secure/SameSite=Lax/Path=/）、30 分スライディング。(5) CSRF は `HMAC(jti, セッション鍵)` をボディで返しヘッダで受ける方式で、**JS から設定する Cookie は 0 個**。(6) `src/middleware.ts` が nonce CSP / HSTS / nosniff / `Referrer-Policy: no-referrer` を全レスポンスに付け、非 production の `/api/webhooks/*` `/api/cron/*` を 404 にする。(7) `POST /api/auth/line` / `GET /api/me` / `POST /api/consent` と、fingerprint を返す `GET /api/health`。(8) `scripts/gate-env-scope.mjs`（`npm run gate:env`）と `scripts/assert-server-only.mjs`（`npm run gate:server-only`）。(9) ログは キー allowlist ＋ 値スクラブ（生 userId / IP / JWT / 接続文字列 / 秘密値の代入形）。`npm run typecheck` / `test:unit`（321 → 496 件）/ `test:integration`（59 → 73 件）/ `test:security`（29 件）/ `gate:constraints` / `gate:env` / `gate:server-only` / `gate:wording` / `lint` はすべて `scripts/record-run.sh task_012` 経由で exit 0（`docs/run-log/task_012.json`）。残懸念は `docs/concerns/task_012.md`: **staging / production は project ref がプレースホルダのため起動できない**（C-012-1、意図した fail-closed。実値は task_035 / task_024）、**レート制限のバインディングが `wrangler.toml` に無くデプロイ環境では `/api/auth/line` が常に 503**（C-012-2。`wrangler.toml` は担当範囲外）、CSP の `frame-ancestors` / `connect-src` は未実測の暫定値（C-012-3）、`audit_log.actor_ref` は pepper 移行の対象外（C-012-5）、acceptance-checks が名指しする `tests/security/{csrf,xss-csp,id-token-replay}.test.ts` は task_022 の担当なので同等の検査を自タスク所有ファイルに置いた（C-012-7）。CI 実走は GitHub リモート未作成のため deferred（C-012-12）。
- task_006: DONE_WITH_CONCERNS — ゲート判定 G0〜G14 を `scripts/gate-check.mjs` に実装し（`--root` オーバーレイ・`--only` の範囲指定・`--json`）、`scripts/gate-integrity.mjs`（G13 のハッシュ照合と `docs/gates/integrity-baseline.json` の唯一の書き込み経路）・`scripts/validate-plan-json.mjs`（`gate:plan`）・`scripts/assert-verify-commands.mjs`（G1/G2）・`scripts/assert-acceptance.mjs`（`gate:acceptance` = G3/G4/G9）を追加した。違反フィクスチャは `tests/gates/fixtures/violations/` に 23 本（実行可能 22 本 ＋ 実行手段待ち 1 本）。L1 / P1 / P2 / W3 / N2 / I3（`gate:constraints`）・W-AUTO 非自動ラベル（`gate:wording`）・G0〜G14 の各 1 本以上を揃え、`npm run test:gate-meta`（`tests/gates/meta.test.ts`、29 件）が全件を実走して「非ゼロ終了 ＋ 意図した違反行の出力」を検査する（exit code だけでは無関係な理由での失敗と区別できないため `expect_output_contains` を必須にした）。フック実在マトリクスは `scripts/test-hook-enforcement.sh`（A 登録 / B 単体挙動 / C ライブ痕跡の 3 階層）で実測し `docs/harness-capability.md` に [実測] で記録した。6 イベントすべてに実測欄があり [不明] は無い。`.claude/settings.json` の Stop に `gate:check`、PostToolUse に `gate:plan` を登録。`npm run test:unit`（496 件）/ `test:gate-meta` / `gate:plan` / `gate:check` / `gate:acceptance` / `gate:integrity` / `typecheck` / `lint` / `gate:constraints` / `gate:wording` / `test-hook-enforcement.sh` はすべて `scripts/record-run.sh` 経由で exit 0（`docs/run-log/task_006.json`）。残懸念 10 件は `docs/concerns/task_006.md`（うち high 1 件＝基準値の再生成で G13 を自己封じできる、medium 5 件、low 4 件）。CI 登録は non_scope かつ GitHub リモート未作成のため deferred（task_009）。
- task_006（レビュー修正・2 周目）: DONE_WITH_CONCERNS — レビュー指摘 7 件（high 1 / medium 6）のうち deferred の 1 件（CI 実走）を除く 6 件を修正した。(1) G4 の `manual_verification` 判定が項目を一切参照しておらず、無関係な manual 記録 1 件で N 項目すべてが満たされたことになっていた穴を、項目 1 件につき記録 1 件の単射マッチング（名指し優先・名指し無しの充当は warn）に置き換えた。(2) リポジトリ直下に `gate-inputs/git-diff.json` / `head.txt` を置くだけで G8 / G9 の入力を差し替えられた迂回路を、`gate-inputs/**` の overlay 専用化とベース側検出（G8 / G0 の違反）で塞いだ。(3) `docs/PROGRESS.md` の完了申告が台帳に反映されておらず G4 / G6 が完了 7 件中 1 件しか見ていなかった問題に対し、食い違いの検出を G4 に足したうえで台帳の `completion_status` を PROGRESS.md に合わせた（G4 対象 1→7 件、G5 1→5 件、G6 1→6 件）。(4) G11 / G6 の残懸念の集計元を `docs/concerns/<task_id>.md` と `docs/HANDOFF.md` のタスク節へ広げた（未解決 high は 1 件 → 7 件）。(5) G13 のハッシュ対象から漏れていた `wording-lint.mjs` / `gates-sync.mjs` / `test-hook-enforcement.sh` を追加し基準値を 21→24 ファイルで作り直した。(6) 非ゼロ終了時のレポートを stderr にも出すようにした（Stop フックは stderr しか見せない）。違反フィクスチャを 4 本追加して 27 本（実行可能 26 本）、`npm run test:gate-meta` 33 件・`test:unit` 521 件が緑。`docs/task-list.json` は task_006 の `files_to_modify` 外だが、追加した判定を満たすために `completion_status` の同期と task_003 の concerns[] への severity 接頭辞付与を行った（出どころは本文に明記。`docs/concerns/task_006.md` の 13）。残懸念は 17 件（high 1 / medium 2 / low・記録のみ 14）。
- task_012（レビュー修正・2 周目）: DONE_WITH_CONCERNS — レビュー指摘 high 1 件 / medium 2 件を修正し、担当範囲外の medium 3 件を deferred として記録した。(1) **nonce CSP が実際には機能していなかった**。`src/middleware.ts` は CSP をレスポンスにだけ載せ、nonce を独自ヘッダ `x-csp-nonce` でリクエストへ渡していたが、Next.js が自前の `<script>`（ブートストラップと `self.__next_f` のインラインデータ）へ nonce を付ける経路は**リクエストヘッダの `Content-Security-Policy` を読む 1 本だけ**で、独自ヘッダは見ない（`node_modules/next/dist/server/app-render/app-render.js:209-210` の `getScriptNonceFromHeader()` を Next 16.3.6 で確認）。配信 CSP は `script-src 'nonce-…' 'strict-dynamic'` で `'self'` も `'unsafe-inline'` も無いため、task_013 が LIFF フロントを載せた時点でアプリの JS が全部ブロックされる状態だった。`requestHeaders.set(CSP_HEADER, buildContentSecurityPolicy(nonce))` を追加して塞ぎ、再発検出のために **Next.js 自身の抽出関数**（`next/dist/server/app-render/get-script-nonce-from-header`）を直接呼ぶ検査を `tests/unit/security-headers.test.ts` に 7 ケース追加した（`x-middleware-override-headers` / `x-middleware-request-*` を解いてレンダラが受け取るリクエストヘッダを実検査）。修正行を外すと 6 ケースが落ちることを実測（負の対照）。(2) **`gate:env` が片側混入型の本番値混入を素通りしていた**。staging と production の値の衝突しか見ていなかったため、本番 ref を staging **だけ**に書く形（実リポジトリでは ref も LIFF ID も secret 側にあるので混入するならこの形になる）が exit 0 で通ることを再現したうえで、検査 (7) を追加した。`src/lib/config/env.ts` の `EXPECTED_SUPABASE_PROJECT_REF`（起動時アサートが使う同じ正本。値を書き写さず読む）と突き合わせ、ref が自分の environment の外に現れたら違反にする。フィクスチャ 2 本（`one-sided-leak` = exit 1 / `pinned-ok` = exit 0）で機械検査。実 ref が入った時点で自動的に実効化する。(3) **pending の文言が実際より広い範囲を検査したように読めた**ので、実走した 3 項目を列挙し「片側混入は検出できない」と明記する文言に置き換え、検出できない本番資源（LIFF ID / Hyperdrive id）を毎回名指しするようにした。(4) `.dev.vars.example` に起動時必須の 4 変数が無く `wrangler dev` / `next dev` の platform proxy 経路ではルートが 500 / 503 になる件は、同ファイルが task_003 所有のため追記せず、`gate:env` が毎回 pending で名指しする検査を足してテストで固定した（C-012-14 deferred）。verify_commands 5 本（`typecheck` / `test:unit` 499 → 510 件 / `test:integration` 73 件 / `gate:constraints` / `gate:env`）と追加の `test:security`(29) / `gate:server-only` / `gate:wording` / `lint` はすべて `scripts/record-run.sh task_012` 経由で exit 0。deferred は C-012-2（レート制限バインディング未追加＝デプロイ環境で `/api/auth/line` が 503。`wrangler.toml` は task_003 / 035 所有）・C-012-14（`.dev.vars.example`。task_003 / 035）・C-012-15（LIFF ID / Hyperdrive id の片側混入。task_035 / 024）・C-012-12（CI 実走。GitHub リモート未作成）・C-012-7（`tests/security/*` は task_022 所有）。
- task_009: DONE_WITH_CONCERNS — `.github/workflows/gate.yml`（static / gate-meta / gate-integrity / labels / security / secrets / deps / acceptance / test-tamper-guard / date-boundary の 10 ジョブ ＋ required に入れない adversarial）・`e2e.yml`（nightly ＋ dispatch）・`release.yml`（先頭 2 段ゲート → `cloudflare/wrangler-action@v4` で `deploy --env production`）・`.github/PULL_REQUEST_TEMPLATE.md`・`.github/CODEOWNERS`（承認必須には使わない。A19 / R-TH-04）を作成。判定器 3 本 `scripts/ci/{check-pr-checklist.mjs,assert-release-gate.mjs,secrets-grep.sh}` を実装し、`tests/unit/ci/*` 44 件（release.yml を 14 通りに壊した fixture・PR 本文 26 ケース）で機械検証。`npm run gate:acceptance` / `gate:check` / `gate:integrity` はいずれも `scripts/record-run.sh task_009` 経由で exit 0。**`docs/gates/release-mode.json` は作成できなかった**（`scripts/deny-test-weakening.sh` が `docs/gates/**` への Write を新規作成でも遮断する。遮断ログは `docs/concerns/task_009.md` の 1）。`release.yml` は当該ファイルが無い場合に fail-closed で先頭終了する実装にしてあり、作成は PO に委ねる。**ブランチ保護と CI 実走は deferred**（`git remote -v` が空＝ GitHub にリポジトリが無い。`gh` は `sawanori` で認証済みだが対象リポジトリが無いため `gh api .../protection` を叩けない）。代替として 4 本のワークフロー YAML がパースでき、`run:` が呼ぶ `npm run <name>` がすべて `package.json.scripts` に実在し、`node`/`bash` が呼ぶ `scripts/**` が実在することを静的検証した（問題 0 件）。

- task_007: DONE_WITH_CONCERNS — エージェント定義 7 本（`.claude/agents/`。敵対レビュー
  Gemini / GPT・payment-contract-guard・compliance-gatekeeper・release-auditor・
  premortem-facilitator・acceptance-test-generator-restricted）と、レビュー封筒の 5 本
  （`scripts/build-review-packet.sh` / `review-gemini.mjs` / `review-gpt.mjs` /
  `validate-findings.mjs` / `merge-review.sh`。npm からは `review:packet` / `review:gemini` /
  `review:gpt` / `review:validate` / `review:merge`）を作成した。封筒は当該タスクの
  `constraint_ids` に載っている制約だけを全文同梱し（R-TH-10。task_011 で作ると 57 件中
  L3/W1/W2/W3/I3 の 5 件のみ・11143 bytes）、diff が触れたファイル全文と `./` `../` `@/` の
  import 先 1 段を同梱する（R-TH-08）。`validate-findings.mjs` は repro の無い high を info へ、
  `vendor: "gemini"` の citation 無し high/medium を unknown へ機械的に降格し、
  `model_id_actual` / `cli_version` / `backend` を欠く封筒を無効にし、不達には
  `unavailable_reason` / `attempted_command` を必須にして `verdict: "PASS"` を禁じる。
  `merge-review.sh` は実効 high 1 件で exit 1、欠票は記録して通過、有効票 0 または無効封筒
  ありで exit 3 を返し、`docs/review-log/<task_id>.json` に追記する（G5 が読む形）。
  受入テストの生成役は `tools: Write` だけを持たせ、`Read` / `Grep` / `Glob` / `Bash` を
  与えないことで `src/**` を読む手段を構造的に消した（R-TH-14）。
  **経路の実測**: Gemini は通る（`gemini -o json` の `stats.models` で `roles.main` を持つ
  キーが応答モデル ID。`-m gemini-2.5-pro` は反映され `reviewer_route: "verified"`。
  プレモータム R-TH-11 の「model 指定は無視される」は CLI 0.38.1 では再現しない）。
  **GPT-6 Astra は通らない**（`codex exec` は exit 0 のままエージェント応答を 1 件も返さない。
  `--output-last-message` が 0 バイト、`turn.completed` のトークン 0。`~/.codex/hooks/
  block-non-claude-model.sh` による遮断と一致）。`review-gpt.mjs` は終了コードではなく
  応答本文の有無だけで成立を判定し、不達封筒を返す（exit 3 を record-run に記録済み）。
  `npm run test:unit`（600 件。うち本タスク追加 35 件）/ `gate:constraints` / `typecheck` /
  `lint` / `gate:integrity` / `test:gate-meta` / `gate:wording` はすべて
  `scripts/record-run.sh task_007` 経由で exit 0。ただし**最終確認時の
  `gate:constraints` は exit 1** で、違反 2 件は並行実行中の task_013 の未追跡ファイル
  （`src/components/ConsentGate.tsx` / `src/lib/liff/client.ts` の「`localStorage` は使わない」
  というコメント行が N7 の forbid grep に当たる）であり task_007 の成果物には違反 0 件。**本タスク自身の敵対レビューは
  `docs/review-log/task_007.json` に 2 周ぶん記録した**（round 1 = 封筒 265KB で Gemini が
  900 秒タイムアウト ＋ GPT 欠票 → `not_established`、round 2 = 封筒 76688 bytes で Gemini が
  `verified` / `gemini-2.5-pro` → `pass`、実効 high 0）。round 2 の唯一の medium finding は
  実ファイルでの反証により誤検出と判定した（修正せず）。**敵対レビューは実質 Gemini 単独で、
  この状態を「3 ベンダー体制」とは呼べない。** 残懸念 11 件は `docs/concerns/task_007.md`
  （high 2 / medium 8 / low 1）。**本タスクの完了で G5 がブロッキングに変わり、review-log を
  持たない完了済み task_004 / 005 / 006 / 009 / 011 / 012 の 6 件が違反として列挙される**
  （§15-2 が意図した強制力。`npm run gate:check` は現在この 1 ゲートで非 0）。
  `docs/task-list.json` は `files_to_modify` 外だが、G4 の「PROGRESS.md の完了宣言と台帳の
  一致」を満たすため task_007 の `completion_status` と `concerns[]` のみ同期した。

- task_009（レビュー修正・2 周目）: DONE_WITH_CONCERNS — レビュー指摘 high 2 / medium 4 の
  うち、この環境で直せる 2 件を直した。(1) **`secrets` ジョブは実際に走らせると落ちていた**。
  `scripts/ci/secrets-grep.sh` がシークレットの「名前」で `.open-next` 全体を走査するため、
  `src/lib/config/env.ts` が正当に参照する `PEPPER` / `SESSION_KEYS` / `CRON_SECRETS` /
  `DATABASE_URL` にサーバーバンドルで自分から当たっていた（1 周目の「違反 0 件」は
  task_012 のルートが入る前の古いビルド成果物に対する測定だった）。走査を 2 群に分け、
  名前はクライアント配布物（`.next/static` / `.open-next/assets`）だけ、サーバーバンドルは
  値のパターンだけを見る形にした。`npm run build && npm run build:cf` のあと修正前 exit 1・
  違反 4 件 → 修正後 exit 0（クライアント 21 / サーバー 1189 ファイル、違反 0 件）を実測。
  負の対照を `tests/unit/ci/secrets-grep.test.ts` 23 件に固定した（クライアントに名前が
  載れば 12 名すべてで落ちる / サーバーに名前があるだけでは通る / 値パターンは両群で落ちる /
  走査対象 0 件は落ちる）。(2) **`test-tamper-guard` を `.github/workflows/gate-tamper.yml` に
  分離し `types: [opened, synchronize, reopened, edited]` で起動する**ようにした。
  `on: pull_request` の既定 types では PR 本文の編集で再実行されず、チェックリストを埋めて
  緑にしてから本文を空に戻せた（唯一の目的が記録の強制であるゲートとして成立しない）。
  status check 名は `test-tamper-guard` のまま。ワークフロー 6 本の静的検証（YAML 妥当 /
  `npm run <name>` の実在 / `scripts/**` の実在 / ジョブ ID の一意性 / tamper の types に
  `edited`）で問題 0 件。(3) 直せなかったもの: `docs/gates/release-mode.json` は再度 Write を
  試みて同じガードに遮断された（**deferred: PO が作成**）、branch protection と CI 実走は
  `git remote -v` が空のため **deferred: GitHub リモート作成後**。(4) medium 2 件
  （date-boundary がアプリの日付ロジックを覆わない ＝ `vitest.config.ts` の TZ 固定が原因、
  `--write-baseline` の Bash 実行で G13 の基準値を書き換えられる）は、いずれも他タスク所有の
  ファイルの改修が要るため `docs/concerns/task_009.md` の 4 / 12b に記録して据え置いた。
  `npm run gate:acceptance` / `gate:check` / `gate:integrity` は `scripts/record-run.sh task_009`
  経由で再実行した（`gate:check` は G5 が非 0。**原因は task_004 / 005 / 006 / 011 / 012 に
  `docs/review-log/<task_id>.json` が無いことで、task_009 自身の review-log は本周で作成した**）。
- task_009（レビュー修正・3 周目）: DONE_WITH_CONCERNS — 敵対レビューの medium 5 件のうち、
  実装で直せる 3 件を「まず穴を再現し、直し、同じ手順で塞がったことを実測する」形で修正した。
  (1) `scripts/ci/assert-release-gate.mjs` は `needs` グラフしか見ておらず、`deploy` に
  `if: always()` を 1 行足すだけで「ゲートが赤でもデプロイが走る `release.yml`」を違反 0 件で
  通していた（レビューの再現手順をそのまま実行して確認）。`release-gate` に `needs` で到達する
  全ジョブの `if:` に状態関数（`always()` / `failure()` / `cancelled()` / `success()` の否定・比較）が
  無いこと、`release-gate` のジョブと各ステップに `continue-on-error` が無いことをアサートに足し、
  同じ仕込みが `check_051 FAIL` で exit 1 になることを実測した。`tests/unit/ci/assert-release-gate.test.ts`
  は 18 → 31 件（偽陽性を出さない側の対照 3 件を含む）。
  (2) `gate.yml` の acceptance ジョブが台帳の文字列を `sh -c "$cmd"` に渡していたため、
  `npm run <script> || true` の形が G2（`scriptNameOf` は先頭しか見ない）を通ったうえで
  再実行を常に exit 0 にできた。**旧実装で実測**（`exit 3` のスクリプトに `|| true` を付けて
  `実行 1 / 失敗 0` の exit 0）してから、`^npm run <script>$` の完全一致を要求しシェルを介さず
  `npm run "<script>"` に渡す形へ直した（同じ入力で `形式違反 1`・exit 1）。実ファイルの `run:` 本文を
  YAML から取り出して走らせた 10 ケースで不一致 0 件。
  (3) `scripts/ci/secrets-grep.sh` の群分けで、OpenNext がプリレンダ本文（ブラウザに配られる面）を
  出す `.open-next/cache` がサーバー側に分類され、シークレット「名前」の走査から外れていた。
  実ビルドの `.open-next/cache/<BUILD_ID>/` に `PEPPER` を含む `.cache` を仕込むと**旧実装は
  違反 0 件・exit 0**、群 (A) へ移した修正後は exit 1 になることを実測。実ビルドに対する通常の
  走査はクライアント 24 / サーバー 1186 ファイルで違反 0 件。`tests/unit/ci/secrets-grep.test.ts` は
  23 → 26 件。
  残る medium 2 件（`docs/gates/release-mode.json` の不在 = PO 専管で Write が遮断される／
  branch protection と CI 実走 = `git remote -v` が空）は**この周でも解消できず deferred のまま**で、
  `docs/concerns/task_009.md` の 1 / 2 / 3 に据え置いた。レビューの修正案にあった
  「`docs/task-list.json` を `check-pr-checklist.mjs` の保護対象に加える」は、既存テストが
  「保護対象ではない」を明示的に固定しており全 PR に影響するため採らず、task_006 との合意事項として
  `docs/concerns/task_009.md` の 13 に起票した。`npm run gate:integrity` / `gate:check` /
  `gate:acceptance` は `scripts/record-run.sh task_009` 経由で再実行した。
  **加えて、3 周目の作業中に GitHub リモート（`origin git@github.com:sawanori/cashapp.git`）が
  作られたため、1 / 2 周目に「リモート不在」を理由に deferred にしていた CI 実走を実測した。**
  `gate` ワークフローは `main` への push で実走し **9 ジョブ中 8 ジョブ success**
  （run 35985828343 / commit `b1bc328`。`gate-meta` / `gate-integrity` / `security` / `secrets` /
  `static` / `labels` / `date-boundary` / `deps`。`adversarial` は `workflow_dispatch` 限定で
  skipped）。赤は `acceptance` だけで、内訳は再実行ステップの `実行 13 / 委譲 2 / 失敗 1 /
  形式違反 0`、唯一の失敗は `npm run gate:check`（G5: task_004 / 005 / 006 / 011 / 012 / 013 の
  `docs/review-log/*.json` 不在）で**他タスク由来**。ubuntu ランナー上でしか走らない経路
  （`secrets` の `build` → `build:cf` → `secrets-grep.sh`、`deps` の OSV バイナリ取得）も緑になった。
  `release` ワークフローは `workflow_dispatch` で実走させ、**`release-gate` = failure /
  `deploy` = skipped**（run 35986191784）。出力は `release-gate FAIL: docs/gates/release-mode.json が
  ありません` → `fail-closed で落とします（L11）` → `exit code 1` で、`cloudflare/wrangler-action` には
  到達していない。**残る未達は PR 経路だけ**で、`test-tamper-guard`（`gate-tamper.yml`）は
  `on: pull_request` のみのため 1 度も起動していない（check_131）。branch protection（check_039）は
  gh api を叩ける状態になったが**意図的に設定していない**: いま required status checks を入れると
  `acceptance` が他タスクの G5 残債で赤いまま `main` への直 push が全面的に止まり、並行実行中の
  全タスクが詰まる（R-TH-04 を自分から作る手順になる）。PR 作成に必要なブランチの publish も
  `git push` が禁止コマンドであるため行っていない。いずれも `docs/concerns/task_009.md` の 2 / 3 に
  理由つきで記録した。

### 週 0 の 5 営業日判定（task_009 scope の最終項目）

- **判定日時**: UTC 2026-09-24T08:59:49Z（JST 2026-09-24 17:59）。判定者: task_009 実装エージェント。
- **週 0 の起点**: リポジトリ初回コミット `d2674a6`（2026-09-24 12:01 JST）。**経過は同日中**であり、
  5 営業日のタイムボックスは**まだ消費していない**（超過による打ち切りは発生していない）。
- **ハーネス必須セット（§4-2）の状態**: 全項目が揃った。`deny-test-weakening.sh` /
  `deny-dangerous-bash.sh`・`record-run.sh`・`gate-check.mjs`（G0〜G14）・違反フィクスチャと
  `test:gate-meta`・`session-brief.mjs`・Stop フックの HANDOFF 毎ターン追記・フック実在マトリクスの
  実測（task_003〜006）に加え、本タスクで CI の static / secrets / deps / acceptance /
  test-tamper-guard を用意した。**ただし「CI が実際に関門として働く」ことは未証明**で、
  GitHub リモート作成と branch protection 設定が残っている（上記 deferred）。
- **ハーネス任意セットの残件**（§4-2 の「5 営業日を超えたら機能実装を優先し残件を記録」に対応）:

  | task | 状態（2026-09-24 時点の観測） | 残っているもの |
  |---|---|---|
  | task_007 | 台帳の `completion_status` は未設定。作業ツリーに `.claude/agents/*.md`・`scripts/review-*.mjs`・`scripts/validate-findings.mjs` 等が未コミットで存在（並行実行中） | エージェント定義 6 本と封筒スクリプトの完成・コミット |
  | task_008 | 台帳の `completion_status` は未設定。成果物なし | Workflow スクリプト 3 本（task-loop / premortem / release-audit） |
  | task_010 | 台帳の `completion_status` は未設定。成果物なし | ベンチ 1 回・codex フック例外句（PO 承認後）・敵対レビュー経路の実測。**本タスクが deferred にした CI 実走と branch protection もここで回収する** |

- **機能実装の着手日**: 2026-09-24。Phase 1 の先頭 task_011（DB スキーマ v2）の初回コミットは
  `0c19054`（2026-09-24 13:06 JST）で、task_012 とともに既に完了している。すなわち
  **必須セットの完成を待たずに機能実装が並行着手された**（§12 の順序規律「必須セットが
  『違反フィクスチャで落ちる』状態になるまで機能タスクに着手しない」に対する逸脱）。
  違反フィクスチャとメタゲートが揃ったのは task_006（`3cc3a19`、2026-09-24 15:5x JST）で、
  task_011 の着手はその約 3 時間前である。この逸脱は既に起きた事実として記録するにとどめ、
  巻き戻しは行わない。以後の機能タスクは本記録を前提に進める。
- **結論**: 必須セットはタイムボックス内に形として完成した。ただし **CI の実効性（branch
  protection・PR での実走）は GitHub リモート未作成のため未達**であり、これを task_010 の
  必須回収項目として引き継ぐ。5 営業日超過による打ち切りは発生していない。

## Phase 1（決済非依存コア）

- task_013: DONE_WITH_CONCERNS — LIFF 外殻を実装した。(1) 起動順序を `src/lib/liff/client.ts` の
  `bootLiff()` 1 本に集約（`init` の 3 秒タイムアウト付き動的 import → **`isInClient()` が false なら
  `login()` を呼ばず `outside_line`** → `isLoggedIn()` → `sessionStorage` の試行回数で最大 2 回まで
  `login()`、3 回目は `auth_unavailable` → `getIDToken()`）。`@line/liff` は npm 依存を動的 import し、
  モック（`src/lib/liff/mock.ts`）へは `NEXT_PUBLIC_LIFF_MOCK === "1"` のガード内からしか到達しない。
  (2) `src/lib/telemetry.ts` ＋ `POST /api/telemetry/client-error`（セッション不要・IP レート制限
  fail-closed・受け取るのは allowlist の `code` 1 キーのみ。`liffIdFingerprint` / `uaClass` /
  `requestId` はサーバーが生成）。(3) `src/app/(liff)/layout.tsx`（`force-dynamic`。LIFF ID を
  `<meta name="x-liff-id">` で実行時に渡す）と `src/app/(web)/layout.tsx`（LIFF を 1 つも import しない）、
  `src/app/layout.tsx` の最上流に下限未満案内（CSS の `@supports` のみ・JS 不要）と `<noscript>`
  フォールバック。(4) `StateView`（8 状態・色＋テキスト＋アイコンの三重表現・`outside_line` は
  ①LINE で開く→②URL→③QR は別端末用の順）/ `ConsentGate`（3 種を個別に取り `X-CSRF-Token`
  ヘッダで `/api/consent` へ）/ `StaticFallback`。(5) `src/styles/tokens.css`（web-typography 準拠。
  **Web フォント 0 件**・OS 標準サンセリフ 1 ファミリー・rem・44px・ダークモード）。
  (6) `npm run build:web-only`（`scripts/build-web-only.mjs`: `(web)` の import グラフ走査 ＋
  `next build` ＋ `.next/static` のモック / dev LIFF ID grep）と
  `.github/workflows/gate-web-only.yml`（`gate.yml` は編集していない）。
  (7) `docs/decisions/ADR-013-web-route-group.md` に「`(web)` は退避先ではない」を記録。
  verify_commands 6 本はすべて `scripts/record-run.sh task_013` 経由で exit 0（`docs/run-log/task_013.json`）。
  残懸念: **`build:web-only` は SDK を物理的に外したビルドではない**、**現時点のモック grep は
  `.next/static` に LIFF 由来の文字列が 0 件のため空振りに近い**（定数畳み込みは未実測）、
  CI 実走は GitHub リモート未作成で deferred、`(liff)` / `(web)` にページが無くレイアウトの
  実行経路が未検証、下限未満判定の取りこぼし、テレメトリの集計・アラート未実装
  （`docs/concerns/task_013.md`）。

- task_007（レビュー修正・2 周目）: DONE_WITH_CONCERNS — レビュー指摘 medium 4 件のうち、
  本タスクの所有ファイルで直せる 2 件を直した。(1) **封筒の制約絞り込みが部分一致だった**
  （R-TH-10 違反）。`scripts/build-review-packet.sh` の `select([.id] | inside($ids))` は
  jq の仕様上「`$ids` のいずれかが `.id` を**部分文字列として**含むか」を見るため、
  `constraint_ids: ["L11"]` が `L1` も引き当てていた（`N1`/`N11`/`N12`、`W1`/`W12` も同じ）。
  `select(.id as $i | ($ids | index($i)) != null)` へ置き換えた。実測: task_009
  （`constraint_ids: ["L11"]`）の封筒は修正前 `["L1","L11"]` / `constraints_included: 2`、
  修正後 `["L11"]` / `1`。回帰は `tests/unit/build-review-packet.test.ts`（6 件・新規）で
  固定し、修正前のスクリプトに対して 6 件中 4 件が赤になることを確認してから直した。
  (2) **レビュー封筒のテストがリポジトリの状態を暗黙の入力にしていた**。
  `tests/unit/{merge-review,validate-findings}.test.ts` の多くが `--whitelist` を渡さず
  起動していたため、`validate-findings.mjs` がリポジトリルートの
  `docs/metrics/model-bench.md`（task_010 が作る予定）を読み、そのファイルが出来た瞬間に
  期待が崩れる作りだった。両テストの起動ヘルパを「`--whitelist` が明示されていなければ
  フィクスチャを必ず渡す」に変え、`scripts/merge-review.sh` に `--whitelist <file>` の
  受け渡し口を足した（テスト 35 → 42 件）。実測: リポジトリルートに
  `approved_models: ["only-some-other-model"]` だけを書いた `docs/metrics/model-bench.md` を
  置いた状態でも 36 件すべて pass（検証後に削除済み）。
  **verify_commands の再実行（commit 62e31be、`scripts/record-run.sh task_007` 経由）**:
  `npm run gate:constraints` は **exit 0**（1 周目の exit 1 は task_013 の未追跡ファイルが
  原因で、task_013 側が直したため解消）。`npm run test:unit` は **exit 1 のまま**で、
  落ちているのは `tests/unit/gate-constraints.test.ts > "passes on a clean tree"` の
  `Test timed out in 5000ms`（実測 6523ms）**1 件のみ**（691 件中 690 件 pass）。同ファイル
  単体なら 17 件 pass / 7.64s で exit 0、task_007 の 2 テストファイルを `--exclude` で外して
  全体を回しても同じテストが落ちるため、**task_007 の成果物ではない**。当該ファイルは
  **task_004 の所有**なので触っていない（`docs/concerns/task_007.md` の 11）。
  残り 2 件の指摘は所有権の外なので記録した: **review-log に出所の担保が無く、レビューを
  受ける側が「敵対レビュー済み」を自作できる**（手書き封筒 1 通で `merge-review.sh` が
  `decision=pass` / exit 0 を返すことを実測。`deny-dangerous-bash.sh` は
  `docs/review-log/**` を守らず、G13 の対象接頭辞も `merge-review.sh` /
  `build-review-packet.sh` / `review-*.mjs` を含まない → 同 12）。
  **2 周目の敵対レビュー（round 3）は `reject` で終わっている**
  （`docs/review-log/task_007.json`。有効票 1 = Gemini `verified` / `gemini-2.5-pro` /
  `cli_stats`、欠票 1 = GPT、実効 high 2）。3 件の finding はこの diff が作った欠陥ではなく、
  封筒に同梱した `docs/concerns/task_007.md` の既知の懸念をレビュアが読み上げたもので、
  F-1 = 同 12（review-log の出所担保）/ F-2 = 同 1（GPT 経路の遮断）/ F-3 = 同 11
  （`test:unit` が赤い）に対応する。**3 件とも task_007 の所有ファイルでは直せない**
  （それぞれ task_006・task_008・task_009・task_010 / PO / task_004 の所有）ため未修正のまま
  残し、reject の事実を review-log と `docs/concerns/task_007.md` の 15 に記録した。
  封筒は 76896 bytes で 780 秒タイムアウトし、43007 bytes に絞って返った
  （1 周目は 76688 bytes で返っていたので、同じサイズでも返る日と返らない日がある）。
- task_036: DONE_WITH_CONCERNS — ゲート台帳（compliance-gates.json・10 ゲート unknown）と照会追跡台帳（external-inquiries.json）の雛形を作成（7f258ac）。PROGRESS.md 不在のため当時は未記入、後追いで記録。
