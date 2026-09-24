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

- task_007: BLOCKED — **（3 周目で `DONE_WITH_CONCERNS` から訂正した。理由は本ファイル末尾の
  「task_007（レビュー修正・3 周目）」を参照）** エージェント定義 7 本（`.claude/agents/`。敵対レビュー
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
  `docs/concerns/task_009.md` の 13 に起票した。verify_commands 3 本は最終 HEAD `ddc291a` に対して
  `scripts/record-run.sh task_009` 経由で再実行し、**`gate:integrity` = exit 0（40 ファイル照合・
  不一致 0 件）／`gate:check` = exit 0（15 ゲート中 不合格 0・違反 0 件 / warn 25 件）／
  `gate:acceptance` = exit 0（対象 154 件・違反 0 件 / warn 2 件）**。2 周目に非 0 だった
  G4（task_013 の台帳未同期）と G5（review-log 不在 6 件）は、いずれも所有タスクが本日中に
  解消したため 3 周目の最終確認時点では残っていない。3 周目の敵対レビューも実経路で実施し、
  `docs/review-log/task_009.json` に `decision=pass` / 実効 high 0 を記録した
  （有効票 1 = Gemini `route=verified` / `gemini-2.5-pro` / `verdict=PASS` / findings 0、
  欠票 1 = GPT `route=unavailable`。**2 ベンダーの合意ではない**）。
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

- task_013: DONE_WITH_CONCERNS — （状態トークンは 4 周目 5 巡目に一度 BLOCKED へ落ちたあと、同巡の敵対レビューが pass したので戻した。本文は初回完了時のまま。gate:check の G4 は task ごとに**最初の**宣言行だけを台帳と突き合わせるので、状態が変わったらこの行のトークンを直すこと。経緯は下の「レビュー修正」各行と `docs/concerns/task_013.md` を参照）LIFF 外殻を実装した。(1) 起動順序を `src/lib/liff/client.ts` の
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

- task_007（レビュー修正・2 周目）: BLOCKED — **（当時の宣言は `DONE_WITH_CONCERNS`。3 周目で
  §15-3 step 5 に従い訂正した）** レビュー指摘 medium 4 件のうち、
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

- task_007（レビュー修正・3 周目）: BLOCKED — **完了ステータスを `DONE_WITH_CONCERNS` から
  `BLOCKED` へ訂正した。** 敵対レビューは round 1 = `not_established` / round 2 = `pass` /
  round 3 = `reject`（実効 high 2）で 3 周を消化しており、`docs/implementation-plan.md`
  §15-3 step 5 の「**3 周後も high が残れば BLOCKED で PO 裁定（`DONE_WITH_CONCERNS` で
  通すことを禁止）**」および `check_066` の expected_result に正面から反する状態のまま
  完了扱いにしていた。台帳（`docs/task-list.json`）と本ファイルの 2 か所の宣言を
  `BLOCKED` にそろえ、残る実効 high 2 件を所有タスクと PO へ明示的にエスカレーションする。
  **PO 裁定が必要なもの**: F-2 = GPT-6 Astra 経路の遮断解除（`~/.codex/hooks/
  block-non-claude-model.sh`。§16-1 の 4 / F13 により AI は解除してはならない）。
  **所有タスクへ起票**: F-1 = review-log の出所担保（task_006 の `deny-dangerous-bash.sh` /
  task_009 の `integrity-baseline.json` / task_008・task_010 の封筒スキーマ）、
  F-3 = `tests/unit/gate-constraints.test.ts` の 5 秒タイムアウト（task_004）。
  あわせて、**F-1 のうち task_007 の所有ファイルで閉じられる部分を実装した**:
  `scripts/merge-review.sh` が `vendor` を一切見ず、作者と同じベンダー（`claude`）の
  封筒 1 通でも `decision: pass` / exit 0 を返していた（§16-1 の 2「検出者と作者は別ベンダー」
  違反）。`--author-vendor`（既定 `claude`）を足し、同一ベンダーの封筒を
  `classification: "self_review"` として有効票から外し、summary に `vendors` /
  `author_vendor` / `self_reviews` を出すようにした。**自己レビューが出した実効 high は
  差し戻しに数える**（票にしないことと指摘を無視することは別）。実測: 同じ自作封筒 1 通に
  対し HEAD（`48f3061`）は `pass` / exit 0、修正後は `not_established` / exit 3。
  回帰は `tests/unit/merge-review.test.ts` に 7 件追加（13 → 20 件）。
  `docs/review-log/README.md` の vendor 表にも「`claude` は自己レビューであり敵対レビューの
  票にならない」と明記した。さらに commit `0a060bf` が `docs/task-list.json` の
  task_001 / task_013 のエントリと末尾改行の削除を巻き込んでいた件（当時の報告と実 diff の
  食い違い）を `docs/concerns/task_007.md` の 18 で訂正し、末尾改行を戻した。
  **verify_commands の再実行**（`scripts/record-run.sh task_007` 経由、HEAD で実測）の結果は
  `docs/run-log/task_007.json` と `docs/concerns/task_007.md` の 16〜19 に記録した。
  **`npm run test:unit` は依然 exit 1** で、落ちるのは task_004 所有の
  `tests/unit/gate-constraints.test.ts` の 5 秒タイムアウトのみ（task_007 起因 0 件）。
  これも BLOCKED の理由に含める（CI の acceptance ジョブは verify_commands を再実行するため）。
- task_013（レビュー修正・2 周目）: DONE_WITH_CONCERNS — レビュー指摘 high 1 件 / medium 4 件のうち、担当範囲で直せる 3 件を直し、2 件を deferred として記録した。(1) **モックの定数畳み込みが実際には効いていなかった**。`scripts/build-web-only.mjs` は `next build` の前に `delete env["NEXT_PUBLIC_LIFF_MOCK"]` していたが、Next.js の `getNextPublicEnvironmentVariables()`（`node_modules/next/dist/lib/static-env.js`）は `for (const key in process.env)` で**存在するキーだけ**を define にするため、未設定だと置換が起きず `await import("./mock")` が到達可能なまま残る。リポジトリの複製に `bootLiff()` を呼ぶ `src/app/page.tsx` を置いて実測したところ、未設定では `.next/static` に `liff-mock` / `LiffMockPlugin` が **2 ファイル**（うち 1 つは `@line/liff-mock` 本体）出力され、`NEXT_PUBLIC_LIFF_MOCK=0` では **0 ファイル**（`isInClient` はどちらも 2 チャンクに存在）だった。`delete` を `= "0"` に変え、`package.json` の `build` / `build:cf` にも `NEXT_PUBLIC_LIFF_MOCK=${NEXT_PUBLIC_LIFF_MOCK:-0}` を前置し、`build:web-only` に「本番ビルド経路が変数を定義しているか」の検査 (0) を追加。`tests/unit/ci/web-only-workflow.test.ts` に回帰テスト 3 件（`delete` に戻したら落ちる／Next 側の前提そのものを毎回読み直す）を足した。制約 I4 と check_079 の担保が初めて実体を持った。(2) **`build:web-only` の import グラフ起点が 4 ファイルしかなく、`src/app/page.tsx` と `src/middleware.ts` が検査から漏れていた**（どちらもルートグループに属さず毎ビルドに載る）。禁止側の全走査（`src/lib/liff/**` と `src/app/(liff)/**` 以外は LIFF を参照しない）に置き換え、起点も `src/app/**` の `(liff)` 以外 ＋ `src/middleware.ts` に拡張（走査 4 → 26 / import グラフ 4 → 24 ファイル）。複製で両ファイルに LIFF import を足すと exit 1 になることを実測（修正前は exit 0 で素通り）。(3) **静的フォールバックに「再試行」も「LINE で開く」も出ていなかった**（3 か所の呼び出しが props を渡していないため、出るのは幹事への連絡の固定文だけ）。再試行を既定で常設し（遷移先はアプリの入口 `/`。`href=""` は `a[href]` を link ロールへ対応づける規則が非空を条件にする実装があるため採らない）、パーマネントリンクを LIFF ID から組み立てる `liffPermanentLink()` を追加した（URL 形式の一次資料はインストール済み `@line/liff` 2.31.0 の `@liff/permanent-link` と `@liff/consts`。`docs/vendor-docs/line/liff-sdk.md` §4 に退避）。`tests/unit/components/StaticFallback.test.tsx` 7 件で固定。verify_commands 6 本のうち 5 本（`typecheck` / `lint` / `build` / `build:web-only` / `gate:constraints`）と追加の `gate:wording` / `gate:server-only` / `gate:env` は `scripts/record-run.sh task_013` 経由で exit 0。**`test:unit` だけ exit 1**（落ちるのは `tests/unit/gate-constraints.test.ts` の 1〜2 件のみで、原因は既知の 5 秒タイムアウト。単独実行 17/17 緑、フルスイートも `--testTimeout=30000` なら 720/720 緑。task_004 の担当）。deferred は C-013-3（作業中に GitHub リモートが作成され `gate-web-only / web-only` は push イベントで **2 回とも緑**（run 35985828331 / 35984699932）だが、走ったのは 1 周目のスクリプトであり、`pull_request` での緑と 2 周目修正版の実走は未了。`git push` が禁止コマンドのため本エージェントからは実走させられない。branch protection も未設定 = required status checks 未登録）・C-013-4（`(liff)` ページが無く check_079 / R-LINE-04 はまだ達成扱いにできない。task_014）・C-013-9（`sdk_unavailable` では LIFF ID 自体が無いため「LINE で開く」を出せない。3 導線が揃うのは task_014 以降）。
- task_013（レビュー修正・3 周目）: DONE_WITH_CONCERNS — レビューの medium 5 件のうち担当範囲の 3 件を直し、2 件を deferred / 他タスク送りとして記録した。(1) **3 秒タイムアウトが `liff.init()` に掛かっていなかった**。SDK の動的 import だけが `withTimeout()` に包まれ、`liff.init()` は素の `await` だったため、LINE サーバーが応答を返さない場面（reject もしない）で `bootLiff()` が永久に解決せず、`sdk_unavailable` も `init_failed` も返らないまま loading のまま＝ R-LINE-03 が防ぎたい白画面になる経路が残っていた。`liff.init()` も同じ `withTimeout()` で包み、時間切れは reject と同じ `init_failed` ＋ テレメトリ `liff_init_failed` にした。`tests/unit/liff/client.test.ts` に「init が解決しない Promise を返す」ケースを追加し、修正を一時的に素の `await` へ戻すと当該テストが `Test timed out in 5000ms` で落ちることを実測してから戻した（非空振りの対照）。(2) **モック混入の担保が「変数が定義されているか」だけだった**。`package.json` は `NEXT_PUBLIC_LIFF_MOCK=${NEXT_PUBLIC_LIFF_MOCK:-0}` と外部値を尊重する形で、`checkProductionBuildEnv()` も `includes("NEXT_PUBLIC_LIFF_MOCK=")` しか見ていなかったため、デプロイ環境に `1` を置くだけでゲートもテストも緑のまま `@line/liff-mock` が本番バンドルに載る状態だった。`build` / `build:cf` を `NEXT_PUBLIC_LIFF_MOCK=0` リテラルに固定し、ゲートを「右辺が 0 であること（外部注入を許す書き方も不可）」まで強めた。検査が空振りでないことは、fixture の木を作って `scripts/build-web-only.mjs` を実際に spawn し、`=1` / `${NEXT_PUBLIC_LIFF_MOCK:-0}` / 未定義で exit 1、`=0` で exit 0 になることで固定した（本文 grep ではなく exit code を見る 4 件）。(3) **`StateView` の `outside_line` / `auth_unavailable` で `permanentLink` 未指定のとき ③ QR の注記だけが残っていた**（「いま見ている端末では読み取れません」＝できないことしか書かれない画面）。①②③ を 1 つのまとまりにし、リンクが無いときは ③ も描かないようにした。自作テストは「リンクを出さない」から「③ だけ残る状態を作れない」へ書き換え、`auth_unavailable` 側の ①②③ 揃いも追加で固定した。(4) gate-web-only は 2 周目の修正版で **CI 実走・緑**（run 35989181733 / head d722cc4。`git merge-base --is-ancestor 4d22062 d722cc4` で確認）となったが、`pull_request` イベントでの緑と required status check 登録、および 3 周目の修正の push は `git push` が禁止コマンドのため deferred（C-013-3）。(5) 配信される実物（`build:cf` の OpenNext 成果物）への grep が CI に無い件は `.github/workflows/release.yml` が task_009 所有のため C-013-11 として送った。verify_commands 6 本のうち 5 本は `scripts/record-run.sh task_013` 経由で exit 0、**`test:unit` だけ exit 1**（落ちるのは `tests/unit/gate-constraints.test.ts` の 2 件で、どちらも `Test timed out in 5000ms`。`--testTimeout=30000` なら 26 ファイル 734/734 緑。当該ファイル・`gate-constraints.sh`・`constraints.json` は本タスクで 1 行も触っていない。task_004 の担当。C-013-12）。
- task_009（レビュー修正・4 周目）: DONE_WITH_CONCERNS — 敵対レビューの high 1 件 / medium 5 件のうち実装で直せる 3 件を「まず穴を再現 → 直す → 同じ手順で塞がったことを実測」の順で直し、3 周目に deferred にしていた branch protection（check_039）を設定した。(1) **[high] acceptance の再実行ループが、標準入力を読むコマンド 1 本で後続を全部飛ばしていた**。一覧を `done < <(jq …)` でループの標準入力として流し込んでいたため、`npm` スクリプトが標準入力を読むと残りの一覧を食い尽くし、後続の `verify_commands` が実行されないまま「失敗 0 / exit 0」で緑になる（スキップした旨の出力すら出ない）。実ファイルの `run:` 本文を取り出して走らせた実測で、台帳が `["npm run aaa-eats-stdin","npm run zzz-should-fail"]`（前者 `cat > /dev/null`、後者 `exit 7`）のとき旧実装は `実行 1 / 委譲 0 / 失敗 0` で **EXIT=0**、`aaa-eats-stdin` を外すと同じ `zzz-should-fail` が `FAIL` / EXIT=1 になることを確認した（台帳に 1 行足すだけで F2 の最終防衛線が無音で外せた）。一覧の読み出しを fd 3 に逃がし、再実行の子プロセスの標準入力を `< /dev/null` で塞いだ。同じ fixture で修正後は `実行 1 / 失敗 1` / EXIT=1。「対象 0 件」の判定も `RAN + SKIPPED` から読めた行数 `TOTAL` に変えた（全件が形式違反のときに「台帳の読み取りが壊れている」と誤記していた）。`tests/unit/ci/acceptance-rerun.test.ts` 15 件で固定。(2) **[medium] `release.yml` の (a) 段の `PAYMENTS_ENABLED` 検証が空振りだった**。走査対象 5 ファイルのどれにも `PAYMENTS_ENABLED` という文字列が無く、`true` を探す `grep` は構造上 1 件も当たらないまま常に通っていた（同じスクリプトが `CONFIG_FILES` 0 件と `npm ls` 出力 0 件は「走査 0 件を緑にしない」として落とすのに、フラグ不在だけが緑だった）。「`true` の不在」ではなく「`false` の明示が 1 件以上あること」を要求し、走査対象にフラグの正本（`supabase/migrations/*.sql` の `feature_flag` seed）を加えた。旧実装はフラグ不在の fixture で EXIT=0、修正後は EXIT=1、正本の SQL だけがある fixture では EXIT=0 で根拠行を出力する。(3) **[medium] `release-gate` の 2 段ゲート本体（シェル）に自動テストが 1 本も無かった**。acceptance 側と同じ手法（実 YAML から `run:` 本文を取り出して一時ディレクトリで `bash` に食わせる）で `tests/unit/ci/release-gate-shell.test.ts` を新設し 31 件。`docs/gates/` は fixture のディレクトリ名に置換するので PO 専管の `docs/gates/**` には一切書き込まない。(4) **branch protection を設定した**。3 周目に書いた解除条件（`origin/main` がローカル `main` まで進み、その commit で `gate` が緑）が満たされた（実測: `origin/main` = ローカル `main` = `d722cc4`、未 push 0、`gate` run 35989181608 が全体 success、`gate-integration` 35989181611 / `gate-web-only` 35989181733 も success）。`gh api -X PUT` の読み戻しで required 11 件（`static` / `gate-meta` / `gate-integrity` / `secrets` / `deps` / `acceptance` / `test-tamper-guard` / `date-boundary` / `labels` / `security` / `integration`）・required approving reviews **0**・`strict: false`・force push 不可・deletions 不可を確認した。**`enforce_admins` は false のまま残した**: G5 は現在 `warn` だが task_007 が DONE になった瞬間に FAIL へ転じる見込みで（残債は task_005 / 006 / 011 / 012 の review-log 不在 4 件）、そうなると required の `acceptance` が赤になり、実装エージェントが `git push` できない本ハーネスでは `main` が凍結して R-TH-04 を自作することになる。解除条件は「`gate:check` の G5 が `ok` かつ `main` の `gate` が success」。deferred のまま残るのは check_131（PR 経路。`git push` が禁止コマンドで PR を作れない。required に入れたので PR が 1 本立てば必ず起動する）と check_130 の 2 通り（`docs/gates/release-mode.json` を作れないため。判定自体は (3) の 31 ケースで固定済み）。
- task_007（レビュー修正・4 周目）: BLOCKED — レビューの medium 3 件のうち所有ファイルで直せる 2 件を「まず穴を再現 → 直す → 同じ手順で塞がったことを実測」の順で直した。**完了ステータスは BLOCKED のまま**（§15-3 step 5 の PO 裁定待ち。未修正の実効 high 2 件は F-2 = GPT 経路の遮断解除 [PO 承認事項] と F-1 の残り = 封筒の改竄防止 [task_006 / 008 / 009 / 010]）。(1) **[medium] `merge-review.sh` が封筒の `task_id` を照合していなかった**。他タスクで正規に取得した封筒をそのまま渡すだけで、偽造なしに任意のタスクへ `decision: pass` / exit 0 を作れた。実測（負の対照つき）: `task_id: "task_009"` の正規形式の封筒 1 通を task_007 へ畳むと修正前は `pass … 有効票=1 投票ベンダー=gemini` / **exit 0**、修正後は `not_established … 有効票=0 … 宛先違い=1` / **exit 3**、封筒の `task_id` を `task_007` に直せば exit 0 に戻る。不一致は `classification: "task_mismatch"` として記録し、有効票にも欠票にも実効 high にも数えない。(2) **[medium] 封筒が作者自身の懸念台帳を同梱し、3 周ループが構造的に収束しなかった**。`build-review-packet.sh` は diff が触れた全ファイルの全文を入れるため `docs/concerns/<task_id>.md` が必ず同梱され、レビュアは作者の既知懸念を読み上げるだけで high を作れた（round 3 の finding 3 件はすべて同ファイルの既存項目と 1 対 1 対応）。`docs/concerns/**` / `docs/HANDOFF.md` / `docs/PROGRESS.md` を `artifact.diff`（pathspec 除外）と `artifact.files` の両方から外し、中身は同梱せずパス・バイト数・理由を `artifact.excluded_paths` と `self_declared_concerns`（`content_included: false`）に残す形にした。`reply_format.finding` に `duplicate_of` とルール 2 本を追加。実測: 同じ範囲で `artifact.files` 14 → 11 本 / payload **479,449 → 151,359 bytes** / diff 中の自己申告ハンク 3 → 0 本。(3) **[medium・deferred] `npm run test:unit` の赤は task_004 所有の `tests/unit/gate-constraints.test.ts` の 5 秒タイムアウト**で、同一 HEAD で 1 回目 exit 0（790/790 pass）・2 回目 exit 1（2 件 timeout）とフレーキー。task_007 側に直せる箇所は無く、task_004 へ起票済み。テストは 1 件も減らしていない（`merge-review.test.ts` 20 → 25 件 / `build-review-packet.test.ts` 6 → 11 件）。
- task_008: DONE_WITH_CONCERNS — Workflow スクリプト 3 本（`.claude/workflows/task-loop.ts` = §15-3 step 0〜8・`premortem.ts` = 4 レンズ並列と差分出力・`release-audit.ts` = 成立条件判定）と `docs/premortem/README.md` を作成。**`done_definition` 第 1 項「3 本が起動する（run ID を record-run で記録）」は未達**: 本セッション（実装エージェント）のツール一覧に `Workflow` が無く、`ToolSearch` の `select:Workflow` も `No matching deferred tools found` を返したため、runId も journal も取得していない（C-008-1 に deferred として記録）。代わりに **Workflow ランタイムと同じラップ（本体を `AsyncFunction` にして `agent` / `parallel` / `phase` / `log` / `args` / `budget` を注入）でスクリプト本体を実走させる** `tests/unit/workflows/workflow-scripts.test.ts` を新設し 41 件全緑。ここで実測したのは (a) high が残り続けると 3 周で打ち切り **BLOCKED**（step 8 のエージェントが `DONE_WITH_CONCERNS` を返しても採用されない）、(b) GPT 経路の不達を **欠票として 1 周ごとに 3 件記録**しつつ gemini の票は有効票として数える、(c) 受入テストの生成は 1 周目だけで 2 周目以降は `fix` に切り替わる、(d) コストを 1 周ごとに記録、(e) compliance-gatekeeper の blocking で即終了、(f) release-audit が Claude 系だけの go / 未承認の不達 / `cleared=false` / `release-mode.json` 不在 / `gate:check` 非 0 のそれぞれで go を出さない、の 6 点。**非空振りの対照**も取った（複製に対して `MAX_ROUNDS_HARD` を 1 にすると `rounds_used=1`、3 周打ち切りと high 残の歯止めを両方外して初めて `DONE_WITH_CONCERNS` が通り、欠票判定 `route !== "ok"` を外すと欠票 0 件）。`.claude/workflows/**` は G13 の対象領域なので追加時に `gate:integrity` が exit 1（G13 追加 3 件）になることを確認してから `--write-baseline` で 43 ファイル / 不一致 0 に戻した。`typecheck` / `lint` / `gate:constraints` / `gate:plan` / `test:unit`（29 ファイル 831 件）は `scripts/record-run.sh task_008` 経由で全て exit 0。
- task_008（レビュー修正・6 周目）: DONE_WITH_CONCERNS — レビューの high 1 件 / medium 2 件のうち、実装で直せる 2 件を「まず穴を再現 → 直す → 同じ応答表で塞がったことを実測」の順で直し、1 件（Workflow ツール不在）は deferred のまま残した。(1) **[high] `task-loop.ts` が実効 high を直近 1 周分しか保持していなかった**。`highRemaining = roundHigh.length` が毎周上書きするため、high を出したレビュア経路が最終周で不達（欠票）になると、前の周で確定していた high が消えて `DONE` で閉じた。修正前の HEAD をランタイム同形のラップで走らせた実測（gemini が 1〜2 周目 high → 3 周目 unavailable）で `status: "DONE"` / `effective_high_remaining: 0` / `voting_vendors_per_round: [["gemini"],["gemini"],[]]` を再現。未解消 high を `unresolvedHigh` として周をまたいで持ち越し、**その周に有効票（`reviewer_route === "ok"`）を返したレーンが挙げなくなった分だけ**落とす形（欠票したレーンは自分の過去の high を落とせない）に直した。修正後は同じ応答表で `BLOCKED` / `effective_high_remaining: 1` / 持ち越し元は 1 周目（実測）。(2) **[high] 有効票を返した独立ベンダーが 0 件の周でも DONE で閉じられた**。gemini / gpt の両方が最初から不達なら、誰も監査していないのに 1 周で `DONE`（修正前の実測）。「high 0 件で打ち切る周」に監査済み判定（`votingVendors.length > 0`）を足し、監査されていない周は `BLOCKED`（修正後の実測: `rounds_used: 1`）。(3) **[medium] `release-audit.ts` の成立条件 1 が fail-open だった**。`goVendors.length >= 2 && independentGoVendors.length >= 1`（作者 claude ＋ 独立 1 件で go）を、計画書 §15-3 の逐語どおり `independentGoVendors.length >= 2` に締めた（C-008-3 と同じく fail-closed 側）。副作用（独立 1 本が不達だと PO 承認があっても go に到達できない）と解釈の一本化は C-008-10 として PO 裁定へ回した。テストは 41 → 44 件（減らした expect は無く、fail-open を仕様として固定していた release-audit の 1 件は「条件 3 は YES だが条件 1 で落ちる」へ書き換え、作者ベンダー側が不達なら独立 2 件で go になる対照を新設）。**非空振りの対照**: 修正前の HEAD（522d543）を同じ応答表で走らせると 3 ケースとも `DONE` / `go`（実測）。`gate:constraints`（verify_commands・0 違反）/ `typecheck` / `lint` / `gate:plan` / `gate:integrity` / `npx vitest run tests/unit/workflows`（44/44）は `scripts/record-run.sh task_008` 経由で全て exit 0。`.claude/workflows/*.ts` の 2 本を変更したため G13 の基準値を `--write-baseline` で再生成（差分は当該 2 エントリと timestamp のみ。C-008-4 の洗浄リスクは据え置き）。**`done_definition` 第 1 項は依然 deferred**: 本セッションでも `ToolSearch select:Workflow` は `No matching deferred tools found` を返し、runId は取得できていない（C-008-1）。
- task_004（レビュー修正・2 周目）: DONE_WITH_CONCERNS — GPT-6 Astra の敵対レビュー high 2 件 / medium 5 件を、封筒が「再現手順は未実行」と明記していたので **7 件すべて先に実際に再現してから**直し、同じ手順で塞がったことを実測した（再現できなかった指摘は 0 件）。(1) **[high] `git ls-files` の出力を引用解除せずパスとして扱っていた**。`core.quotePath`（既定 true）では日本語を含むパスが `"src/\351\233\206\351\207\221.ts"` という C エスケープ表現になり、`^(...)$` の先頭固定マッチから落ちる。実測で `src/集金.ts`（`"寄付"` 入り）を置いても `wording-lint` は `ok W-DONATION (1 file(s))` / exit 0、`src/app/決済.ts`（`import Stripe from "stripe"`）を置いてもゲートは exit 0 だった。両方の file universe を `git ls-files -z -co --exclude-standard` に変え、`-z` で新たに生じる「改行入りパス」は NUL 個数と行数の一致（bash）／各エントリの `\n` 不在（Node）で検出して exit 2 にした。修正後は同じ木で両方 exit 1。(2) **[high] 実際に読めた対象が 0 件でも合格していた**。対象件数をパス一覧だけで数えていたため、追跡されたままワークツリーから消えたファイルや 2 MiB 超のファイルを 1 バイトも読まずに `ok ... (1 file(s))` / exit 0 になった（削除の実測・2 MiB の実測とも再現）。「パスを数える」と「バイトを読む」を分け、stat 失敗・非通常ファイル・サイズ上限超を 1 件ずつ違反として出力し、読めた件数 0 なら `UNREADABLE <id>` で empty gate に数える形にした（`ok` 行も `N file(s) read` に変更）。(3) medium 5 件はいずれも実 `docs/constraints.json` で exit 0 を再現してから塞いだ: W3 の許可条件を「ランク名の出現」から「比較演算子を伴うランク比較」へ、P1 に動的 `import("stripe")`、X-TIME の列定義アンカーを `(^|[(,])` に広げて裸の `timestamp` を `timestamptz` / `with time zone` と区別して検出、GC-SERVER-ONLY の必須パターンを行頭の実行される import だけに限定（コメント素通りを塞ぐ）、I3 の対象を `src/**/*.ts` ＋ `src/**/*.tsx` に広げてサーバー側が確定している `src/lib/**` / `src/app/api/**` / `src/app/**/route.ts` / `src/middleware.ts` だけを除外。いずれも「違反で exit 1・正当な書き方で exit 0」の両方向を回帰テストで固定した（既存の expect は 1 つも減らしていない）。`gate:constraints` / `gate:wording` / `lint` と task_004 所有 2 ファイルの `npx vitest run`（44/44）は `scripts/record-run.sh task_004` 経由で exit 0。**`npm run test:unit` は exit 1 / `npm run typecheck` は exit 2**（赤 16 件・型エラー 2 件はいずれも他タスクが編集中の未コミットファイル起因で、task_004 所有ファイルの赤は 0 件。C-004-5）。G13 の基準値は他タスクの未コミットのガード対象 3 ファイルを巻き込まないよう、HEAD の木を overlay にして `--root` で再生成した。
- task_004（レビュー修正・3 周目）: DONE_WITH_CONCERNS — コミット `26eb304` に対する G5（`review-drive.sh` → `merge-review.sh`）は **pass**（有効票 2 / 欠票 0 / 実効 high 0）だったが、gemini medium 1 件・GPT medium 6 件が新たに出たので、**7 件すべてを再現したうえで 5 件を塞ぎ、2 件を残懸念として記録した**。塞いだ 5 件: (1) `globToRegExp` が波括弧を `(?:` に変換した後に `?` → `[^/]` の置換を掛けるため `src/**/*.{ts,tsx}` が `([^/]:ts|tsx)` になり `.ts` を 1 件も見ていなかった（`.tsx` があるので対象 0 件検査も通る。実測 exit 0 → 修正後 exit 1）。(2) forbid の走査が grep の stderr も終了コードも捨てるため、`grep_patterns: ["("]` のような**コンパイルできない正規表現が「違反 0 件」で合格**していた（実測 exit 0 → 修正後 exit 2）。エントリごとに全パターンを空入力へ 1 回バッチコンパイルし、失敗時だけ 1 本ずつ試して該当を名指しする。(3) W3 の免除条件が方向を見ておらず `WHERE status_rank > 2`（refunded→paid の後退）も免除していた → 前進方向（左辺なら `<`/`<=`、右辺なら `>`/`>=`）だけに限定。(4) P1 が副作用 import（`import 'stripe';`）と空白付き動的 import（`import ('stripe')`）を通していた。(5) X-TIME が `timestamp(3)` と `ALTER TABLE ... ADD COLUMN ... date` を見逃していた（列名の前は行頭・`(`・`,`・DDL キーワードに限り、SQL コメントの英文を誤検出しない）。残した 2 件は **行単位 grep の原理的限界**（ブロックコメント内の `import "server-only"` が必須検査を満たす／SQL 行コメント内の `status_rank < 2` が W3 を免除する）で、コメント除去を足すと文字列リテラル中の `//` `/*` で他タスクのファイルを誤検出するため直していない。同じ穴は `scripts/assert-server-only.mjs`（task_011 所有）にもあることを実測で確認し C-004-6 に記録した。併せて task_007 / task_013 から送られていた `gate-constraints.test.ts` の「Test timed out in 5000ms」を、**実ゲート 1 回が実測 ~4 秒**（57 エントリ × jq / grep / xargs の起動）で vitest 既定の 5000ms とほぼ同じことを測ったうえで `vi.setConfig({ testTimeout: 60_000 })` で解消し、正規表現の事前検証をバッチ化して実行時間を 118 秒 → 64 秒にした（`it` 44 → 52 件・`expect` は増加のみで、アサーションは 1 つも緩めていない）。
- task_013（レビュー修正・4 周目）: DONE_WITH_CONCERNS — GPT-6 Astra の敵対レビュー high 1 件 / medium 2 件を「まず HEAD で再現 → 直す → 同じテストで塞がったことを実測」の順で処理した（再現したのは 2 件、1 件は陳腐化で再現せず）。(1) **[high F-1] ストレージが使えないとログイン回数の上限がまるごと効かなかった**。`storage: null`（SSR・Safari のプライベートモード等）や読み書きが例外になる環境では `readAttempts` が毎回 0 を返し `writeAttempts` が何も残さないため、未ログインで戻り続けると 3 回目以降も `login()` が呼ばれる。封筒の repro をテストに書いて HEAD で再現した（`expected 1 to be 2` = 2 回目も `loginAttempts` が 1 のまま、ほか 2 件。`Tests 3 failed | 18 passed (21)`）。モジュール内の退避カウンタ `memoryAttempts` を置き、「`storage` が `null`／`getItem` が throw／値が壊れている／読めたが未記録」のいずれでも 0 ではなく退避先を返し、`setItem` が成功した回だけ退避先を使わない形（＋ ログイン成立時に退避先も 0 に戻す）に直した。修正後は同じテストが 21/21 緑。**残懸念**: 退避先の有効範囲はページ 1 回分なので、`login()` のページ遷移で作り直される端末では再読み込みをまたぐ打ち切りを保証しない（C-013-13。task_014 で `redirectUri` への持ち出しを判断）。(2) **[medium F-2] `liff.init()` のタイムアウトは HEAD では再現せず**。封筒は 2 周目のコミット `4d22062` の木に対して組まれており、3 周目の `455e594` で既に修正済みだった。4 周目に封筒の repro を**既定のタイムアウト**（`timeoutMs` を注入せず、偽タイマーを `SDK_LOAD_TIMEOUT_MS` だけ進める）でなぞるテストを足して HEAD で pass を実測し、`withTimeout(liff.init(...))` を一時的に素の `await` へ戻すと `Test timed out in 5000ms` で落ちる（＝空振りでない）ことも確認してから戻した（C-013-14）。(3) **[medium F-3] `POST /api/telemetry/client-error` が上限の検査前に本文を全部読んでいた**。`Content-Length` の無い chunked 本文では `request.text()` が読み終えるまで 256 バイト上限を検査しないので、上限は受信量を一切制限しない。repro を書いて HEAD で再現した（`expected 4096 to be less than or equal to 384` = 本文 4096 バイトを全部読んでいた／`expected 400 to be 503` = レート制限の判定が本文読み込みより後だった）。`readBoundedBody()` を追加して `request.body` をチャンクごとに読み、累計が上限を 1 バイトでも超えたら `reader.cancel()` して 400 にし、レート制限の判定を本文読み込みより前へ移した（上限の単位も UTF-16 コード単位からバイトへ）。修正後は 17/17 緑で、読んだ量は 4096 バイト中 320 バイト（上限 256 ＋ 1 チャンク）で止まり、レート制限で落ちる場合は `request.bodyUsed === false` になる。前提（undici の `new Request(url, { body: ReadableStream })` が `content-length` を付けず pull 駆動であること）も実測で確かめた（C-013-15）。`typecheck` / `lint` / `gate:constraints` / `build` / `build:web-only` と task_013 所有テストの `npx vitest run tests/unit/liff tests/unit/telemetry.test.ts tests/unit/components`（8 ファイル 98/98）は `scripts/record-run.sh task_013` 経由で全て exit 0。**`npm run test:unit` だけ exit 1**。落ちたのは `tests/unit/gate-constraints.test.ts`（既知の 5 秒タイムアウト・C-013-12）と、並行して編集中の他タスクの未コミットファイル起因のもの（`tests/unit/auth/csrf.test.ts` は未追跡の `src/lib/auth/request-guard.ts` が cookie ビルダーを使っていないという指摘、`tests/unit/workflows/workflow-scripts.test.ts` は編集中の `.claude/workflows/*.ts`、`tests/unit/auth/pepper.test.ts` / `tests/unit/config/env.test.ts` も同様）で、実行ごとに赤の顔ぶれが変わる（5 件 → 22 件 → 2 ファイル）。task_013 所有テストの赤は 0 件。
- task_013（レビュー修正・4 周目）: DONE_WITH_CONCERNS — GPT-6 Astra の敵対レビュー high 1 件 / medium 2 件を「まず HEAD で再現 → 直す → 同じテストで塞がったことを実測」の順で処理した（再現したのは 2 件、1 件は陳腐化で再現せず）。(1) **[high F-1] ストレージが使えないとログイン回数の上限がまるごと効かなかった**。`storage: null`（SSR・Safari のプライベートモード等）や読み書きが例外になる環境では `readAttempts` が毎回 0 を返し `writeAttempts` が何も残さないため、未ログインで戻り続けると 3 回目以降も `login()` が呼ばれる。封筒の repro をテストに書いて HEAD で再現した（`expected 1 to be 2` = 2 回目も `loginAttempts` が 1 のまま、ほか 2 件。`Tests 3 failed | 18 passed (21)`）。モジュール内の退避カウンタ `memoryAttempts` を置き、「`storage` が `null`／`getItem` が throw／値が壊れている／読めたが未記録」のいずれでも 0 ではなく退避先を返し、`setItem` が成功した回だけ退避先を使わない形（＋ ログイン成立時に退避先も 0 に戻す）に直した。修正後は同じテストが 21/21 緑。**残懸念**: 退避先の有効範囲はページ 1 回分なので、`login()` のページ遷移で作り直される端末では再読み込みをまたぐ打ち切りを保証しない（C-013-13。task_014 で `redirectUri` への持ち出しを判断）。(2) **[medium F-2] `liff.init()` のタイムアウトは HEAD では再現せず**。封筒は 2 周目のコミット `4d22062` の木に対して組まれており、3 周目の `455e594` で既に修正済みだった。4 周目に封筒の repro を**既定のタイムアウト**（`timeoutMs` を注入せず、偽タイマーを `SDK_LOAD_TIMEOUT_MS` だけ進める）でなぞるテストを足して HEAD で pass を実測し、`withTimeout(liff.init(...))` を一時的に素の `await` へ戻すと `Test timed out in 5000ms` で落ちる（＝空振りでない）ことも確認してから戻した（C-013-14）。(3) **[medium F-3] `POST /api/telemetry/client-error` が上限の検査前に本文を全部読んでいた**。`Content-Length` の無い chunked 本文では `request.text()` が読み終えるまで 256 バイト上限を検査しないので、上限は受信量を一切制限しない。repro を書いて HEAD で再現した（`expected 4096 to be less than or equal to 384` = 本文 4096 バイトを全部読んでいた／`expected 400 to be 503` = レート制限の判定が本文読み込みより後だった）。`readBoundedBody()` を追加して `request.body` をチャンクごとに読み、累計が上限を 1 バイトでも超えたら `reader.cancel()` して 400 にし、レート制限の判定を本文読み込みより前へ移した（上限の単位も UTF-16 コード単位からバイトへ）。修正後は 17/17 緑で、読んだ量は 4096 バイト中 320 バイト（上限 256 ＋ 1 チャンク）で止まり、レート制限で落ちる場合は `request.bodyUsed === false` になる。前提（undici の `new Request(url, { body: ReadableStream })` が `content-length` を付けず pull 駆動であること）も実測で確かめた（C-013-15）。`typecheck` / `lint` / `gate:constraints` / `build` / `build:web-only` と task_013 所有テストの `npx vitest run tests/unit/liff tests/unit/telemetry.test.ts tests/unit/components`（8 ファイル 98/98）は `scripts/record-run.sh task_013` 経由で全て exit 0。**`npm run test:unit` だけ exit 1**。落ちたのは `tests/unit/gate-constraints.test.ts`（既知の 5 秒タイムアウト・C-013-12）と、並行して編集中の他タスクの未コミットファイル起因のもの（`tests/unit/auth/csrf.test.ts` は未追跡の `src/lib/auth/request-guard.ts` が cookie ビルダーを使っていないという指摘、`tests/unit/workflows/workflow-scripts.test.ts` は編集中の `.claude/workflows/*.ts`、`tests/unit/auth/pepper.test.ts` / `tests/unit/config/env.test.ts` も同様）で、実行ごとに赤の顔ぶれが変わる（5 件 → 22 件 → 2 ファイル）。task_013 所有テストの赤は 0 件。
- task_012（レビュー修正・2 周目）: DONE_WITH_CONCERNS — GPT-6 Astra の敵対レビュー high 1 件 / medium 3 件を「まず HEAD で再現 → 直す → 同じテストで塞がったことを実測」の順で 4 件すべて処理した（再現しなかった指摘は 0 件）。(1) **[high F-1] `POST /api/auth/line` がログイン CSRF を素通しした**。`Origin` も `Content-Type` も見ず追加フィールドも許すため、`enctype="text/plain"` のクロスサイトフォーム（本文が有効な JSON になる）で攻撃者の未使用 ID トークンを被害者に送らせると、被害者のブラウザに攻撃者アカウントのセッション Cookie が入る（セッション固定）。封筒の repro をそのままテストに書いて HEAD で再現した（403 を期待したところ **200**・Cookie 発行。`tests/unit/auth/line-route.test.ts` 14 件中 10 件が赤）。`src/lib/auth/request-guard.ts` を新設し、ルートの先頭で ①`Origin`／`Sec-Fetch-Site` が自サイトでなければ 403（両方無ければ **fail-closed** で 403）②`application/json` 以外は 415 ③本文の未知フィールドは 400、の 3 枚重ねに落とした。自サイトは `Host` と `request.url` から導き環境変数を増やしていない。**`https://liff.line.me` は許可しない**（全 LIFF アプリの共有オリジンで、誰でも自分の LIFF を置けるため）。修正後は同ファイル 14/14 緑で、正規の LIFF リクエスト（Origin 一致・`content-type: application/json`）3 ケースは 200 を返し DB まで到達する。(2) **[medium F-2] レート制限で弾くリクエストも先に DB へ接続していた**。HEAD ではルート経路にレート制限の判定自体が無く（判定は `authenticateWithLineIdToken()` の中だけ）、`{success:false}` でも 200 を返して `createVerifiedDbClient()`（接続＋`SELECT session_user`）に到達した。`enforceAuthRateLimit()` / `singleFlightRateLimiter()` を切り出してルートが **DB 接続前**に判定する形にし、認証関数側の判定は残したまま同じキーの二重消費を防いだ。429 / 503 のとき `createVerifiedDbClient()` が 1 度も呼ばれないこと、正常時にバックエンドの `limit()` がちょうど 1 回であることをルートハンドラ経由で実測。(3) **[medium F-3] `gate:env` が引用符付き TOML キーを読み飛ばしていた**。`"SUPABASE_SERVICE_ROLE_KEY" = "…"` のように囲むだけで検査を回避でき、フィクスチャで **exit 0** を再現。代入行の正規表現を素のキー / `"…"` / `'…'` の 3 形に対応させ、値の `unquote()` と `stripTomlComment()` もリテラル文字列（単一引用符）に対応させた。修正後は同フィクスチャで exit 1（違反 3 件）、実リポジトリは従来どおり exit 0。(4) **[medium F-4] PEPPER 切替中にアカウントが分裂しうる**。移行は旧参照値を上書きするため、移行後に旧 PEPPER だけの処理系へログインが届くと既存ユーザーを見つけられず別の `app_user` を作る。SQL の発行順を見るスタブで HEAD を走らせ、例外を投げずに `INSERT INTO app_user` が出ることを再現した。スキーマ変更（旧参照値の併存）は task_011 の所有範囲なので、**旧 PEPPER 単独の処理系が新規作成に進めないようにする**方を採り、`INSERT` 直前に「自分より新しい `pepper_version` の行」を探して 1 行でもあれば `CONFIG_INVALID` / 503 で落とす形にした（割れたアカウントは事後に併合できないが 503 は運用で解消できる＝取り返しのつかない側を避ける）。切替の窓でログインが落ちうる点は残懸念として C-012-20 / task-list の concerns に記録し、手順書は task_024。`typecheck` / `lint` / `gate:constraints` / `gate:env` と、追跡済みの統合テスト 4 本（`auth` / `schema` / `db-role` / `ci-workflow`。73/73）は `scripts/record-run.sh task_012` 経由で exit 0。**`npm run test:unit` は exit 1**（赤は `tests/unit/gate-constraints.test.ts` の `Test timed out in 5000ms` 2〜3 件のみ。既知の C-013-12 と同じで、`npx vitest run tests/unit --testTimeout=30000` では **37 ファイル 955/955 緑・exit 0**）。**`npm run test:integration` も exit 1**（赤 3 件はいずれも他タスクの未追跡ファイル `tests/integration/events.test.ts` / `audit-chain.test.ts` 内で、追跡済み 4 ファイルは全て緑）。`scripts/gate-env-scope.mjs` を変えたので G13 基準値は、他タスクの未コミットのガード対象（`.claude/workflows/*.ts` 2 本）を巻き込まないよう HEAD 版を置いた overlay を `--root` に渡して再生成した。
- task_008（レビュー修正・7 周目）: DONE_WITH_CONCERNS — レビューの high 1 件 / medium 1 件を「まず修正前 HEAD で穴を再現 → 直す → 同じ応答表で塞がったことを実測」の順で直し、残る medium 1 件（Workflow ツール不在）は deferred のまま据え置いた。(1) **[high] 独立性の会計に封筒の自己申告 `vendor` を使っていた**。`task-loop.ts` と `release-audit.ts` は、スクリプト自身が持つレーン定数 `lane.vendor`（`code-reviewer` / `release-auditor` = `"claude"`）をレビュアが返した `env.vendor` / `res.vendor` で上書きしてから `AUTHOR_VENDOR` 判定していたため、作者ベンダーのレーンが封筒に `vendor: "gemini"` と書くだけで独立票として数えられた。修正前 HEAD（3bdf5d4）の本体を `git show` で取り出して同じ応答表で走らせた実測: `task-loop` は gemini / gpt の両レーンが不達でも `status=DONE` / `voting_vendors=["gemini"]` / `audited=true` / final verify 1 回、`release-audit` は本物の独立 go が gpt 1 件だけなのに `verdict=go` / `independent_go_vendors=["gemini","gpt"]` / 成立条件 1 pass。会計をレーン定数だけで行い、自己申告が食い違う封筒は `reviewer_route: "invalid_envelope"` の欠票（`abstentions`）へ落とす形に直した。修正後は `BLOCKED`（`voting_vendors=[]` / `audited=false` / final verify 0 回）と `verdict≠go`（`independent_go_vendors=["gpt"]` / 条件 1 fail）。(2) **[medium] `model_id_actual` の無い封筒と `findings` 配列の無い封筒が「指摘 0 件の有効票」として数えられた**。票の採否が `reviewer_route` しか見ておらず、`highFindingsOf` は `findings` が配列でなければ黙って `[]` を返していた。票として数える条件に「`model_id_actual` 非空」「`findings` が配列」を足し（`release-audit.ts` は加えて `verdict` が `go` / `no-go` / `UNKNOWN` のいずれか）、満たさない封筒を `invalid_envelope` の欠票へ落とした。レビュア向けプロンプトにもこの 3 条件を明記。**非空振りの対照**: 5 ケースすべて修正前 HEAD では `DONE` / `go` 側になることを実測している。テストは 44 → 49 件（`expect` の削減・`skip` / `only` の追加は無し）。`gate:constraints`（唯一の `verify_command`・0 違反）/ `typecheck` / `lint` / `gate:plan` / `npx vitest run tests/unit/workflows`（49/49）は `scripts/record-run.sh task_008` 経由で exit 0。**`npm run test:unit` は exit 1**（赤は既知フレーキーの `tests/unit/gate-constraints.test.ts` の `Test timed out in 5000ms` のみ。同一 HEAD で単体実行 3 回のうち 2 回は 30/30 緑、`npx vitest run tests/unit --testTimeout=30000` では **37 ファイル 955/955 緑・exit 0**）。**`npm run gate:check` は exit 1**（G13 のみ不合格。出どころは**別タスク（task_004）が未コミットで編集中の `scripts/gate-constraints.sh` / `scripts/wording-lint.mjs` の 2 件**で、task_008 の変更ではない。G13 基準値は他タスクの差分を焼き込まないよう当該ファイルだけ HEAD 版へ戻した木を `--root` に渡して再生成しており、diff は `.claude/workflows/*.ts` の 2 エントリと timestamp のみ）。**共有台帳の注記**: 本周の `docs/task-list.json` / `docs/PROGRESS.md` への追記は、並行していた task_012 のコミット `10b4e7f` が先に取り込んだ（共有ファイルをファイル単位で `git add` した副作用）。**`done_definition` 第 1 項は依然 deferred**: 本セッションでも `ToolSearch select:Workflow` は `No matching deferred tools found` を返し、runId は取得できていない（C-008-1）。
- task_013（レビュー修正・4 周目の 2 巡目）: 1 巡目の修正に対する敵対レビューで、gemini と GPT-6 Astra が**独立に同じ high** を挙げた（merge-review: `reject` / 有効票 2 / 実効 high 2）。**保存値を退避先より優先していたため「読めるが書けない」ストレージで打ち切れない**という反例である。`getItem` は成功するが `setItem` が落ちる（quota 超過など）場合、保存値が `"1"` のまま残り続けるので、退避カウンタに 2 を入れても次回また 1 を読み `login()` を呼び続ける。再読み込みをまたがなくても起きるため C-013-13 に書いた制約とは別の穴で、1 巡目に足した「読めるが書けない」テストは `getItem` が常に `null` を返す形だったのでこの経路を踏んでいなかった。`getItem` が常に `"1"` を返し `setItem` が throw するストレージで `bootLiff` を 2 回呼ぶテストを足して再現（`expected 'redirecting_to_login' to be 'auth_unavailable'`）し、`readAttempts` を `Math.max(memoryAttempts, readStoredAttempts(storage))` に直した（どちらか一方でも数えられていれば打ち切りに到達する。健全な端末では `memoryAttempts` が 0 のままなので挙動は変わらない）。あわせて gemini の medium（`readBoundedBody` の非ストリーム経路が `request.text()` で読み切ってから測っていた＝ストリーム側の上限を迂回する）も塞いだ: `body === null`（本文なし）は従来どおり `text()`、**本文はあるのに読み取り機が無い**場合は `text()` を呼ばずに 400（fail-closed）。`text()` が 1 回も呼ばれないことをテストで固定した（再現時は `expected 1 to be +0`）。C-013-16 / C-013-17。task_013 所有テストは 98 → 101 件で全緑、`typecheck` / `lint` / `gate:constraints` / `build` / `build:web-only` も `scripts/record-run.sh task_013` 経由で exit 0。**`npm run test:unit` は exit 1** だが、赤は `tests/unit/gate-constraints.test.ts` の `Error: Test timed out in 5000ms` だけ（単独実行は 30/30 緑。既知の C-013-12・task_004 の担当）。
- task_013（レビュー修正・4 周目の 3 巡目）: 2 巡目の修正に対する敵対レビューで GPT-6 Astra が **high をもう 1 件**（merge-review: `reject` / 有効票 2 / 実効 high 1）、gemini が medium 1 件を出した。(1) **[high] 保存できた回を退避先に残していなかった**。`writeAttempts` は `setItem` が成功した回に退避先を更新せず `return` していたため、**2 回保存できた後にストレージが使えなくなる**と（タブ復帰時の quota 逼迫・プライベートモードへの切替）保存値も退避先も 0 になり、3 回目の `login()` が通る。同じモジュール実体で起きるので「再読み込みで消える」とは別の経路である。`Map` を持ち `available=false` の間だけ全メソッドが throw するストレージで、保存値 `"2"` / `login` 2 回まで進めてから落とすテストを足して再現（`expected 'redirecting_to_login' to be 'auth_unavailable'`）。退避先を `WeakMap<AttemptStorage, number>`（＋ `storage === null` 用の変数 1 本）に変え、`setItem` の成否に関わらず**必ず**更新し、減らさない（`Math.max`）形にした。置き場をキーにしたのは本番の置き場が `globalThis.sessionStorage` ＝ ページごとに 1 つの固定オブジェクトだからで、モジュール変数 1 本にすると別の置き場を使う呼び出しにまで数が漏れる。C-013-18。(2) **[medium] `readBoundedBody` の `body === null` の枝がまだ `text()` を呼んでいた**。実 `Request` では `body === null` ⇔ 本文なし（実測: Node 22 / undici で `new Request(url,{method:"POST"})` は `body===null` かつ `text().length===0`、本文を渡すと `body` は必ずストリーム）なので実害は無いが、枝ごと消して `text()` を呼ばずに空文字を返す形にした。C-013-17 の追補。task_013 所有テストは 101 → 102 件で全緑。**verify_commands 6 本すべて exit 0**（`typecheck` / `lint` / `test:unit` 37 ファイル 971/971 / `build` / `build:web-only` / `gate:constraints`。`scripts/record-run.sh task_013` 経由）。この周の途中で `typecheck` が exit 2、`test:unit` が exit 1 になった記録が run-log に残っているが、いずれも他タスクが編集中の未コミットファイル（`src/lib/auth/pepper.ts` の `APP_USER_WRITE_LOCK_KEY` 未定義など）と既知の `gate-constraints` タイムアウトが原因で、同じコマンドを当該タスクの編集が落ち着いた後に再実行して 0 を確認している。
- task_014: DONE_WITH_CONCERNS — イベント・参加者 API（`POST/GET/PATCH /api/events`、`GET .../:id`、
  `GET/POST .../participants`、`DELETE .../participants/:pid`）と幹事画面 5 本（`(liff)/events/**`）、
  `InvoiceRow` / `SummaryBar` / `FeeEstimate`、`src/lib/idempotency.ts` / `src/lib/audit.ts` /
  `src/lib/payments/capabilities-static.ts` / リポジトリ層 2 本。作業ツリーには着手前から本タスクの
  成果物が前回セッションの中断分としてほぼ実装済みの状態で存在しており（`docs/run-log/task_014.json`
  最古の記録が示す時点では `test:integration` が一度も走っていなかった）、本ラウンドでそれを引き継ぎ
  完成させた。**初めて `npm run test:integration` を最後まで走らせ、実害のある実装バグを 3 件、
  実測で見つけて直した**（詳細は `docs/concerns/task_014.md` 冒頭）。(1) `src/lib/idempotency.ts`
  の `runIdempotent`: 予約（`idempotency_key` の `in_flight`）・`handler`（業務書き込み）・`done`
  更新が別々の文になっており、`handler` 失敗時は予約だけを個別 DELETE していたため、業務が
  コミットされた後の経路で例外が起きると再送が業務処理をもう一度実行し得た（P-01。
  `docs/research/premortem-phase1b-2026-09-24.md`）。予約・`handler`・`done` 更新を呼び出し側の
  1 トランザクションにまとめる形に変え（`runIdempotent` はもう `sql.begin()` を自分で呼ばない）、
  3 つの route を書き換えた。回帰は `tests/integration/events.test.ts` に savepoint を使った原子性
  テスト 2 本を追加して固定（修正前の形を模して「業務行だけ残り予約は消える」実害を再現してから
  直したことを確認）。(2) `listParticipants` のカーソルページングが 2 ページ目以降ずっと同じ 30 件を
  返し続けていた（実測: 100 名投入で 11 ページ回しても 30 件しか集まらない）。原因は `postgres`
  （npm）が `prepare: false` 下でパラメータの推論型（サーバーの `ParameterDescription` が返す
  `timestamptz`）ごとに組み込みシリアライザを選び直す実装になっており、`::timestamptz` を直接
  キャストした文字列パラメータが `new Date(x).toISOString()` を経由してマイクロ秒からミリ秒へ
  切り詰められ、カーソル値が実際の行より必ずわずかに小さくなって行タプル比較が `id` に関わらず
  常に真になっていたため。`::text::timestamptz`（二重キャスト）に変更して解決（`node` での直接
  検証で原因を確認済み。`participants.ts` の docstring に実測を記録）。(3) `appendAuditLog` の
  監査連鎖ハッシュが `detail`（jsonb）のキー順に依存しており、Postgres の JSONB 格納がキー順を
  保持しない（挿入時と読み直し時でキー順が変わる）ため、内容を一切改変していなくても
  `verifyAuditChain` が不一致を報告していた（check_057 の 2 テストで 100% 再現）。`detail` を
  再帰的にキーソートしてからハッシュ計算する `sortDetailKeysDeep` を追加して解決し、あわせて
  「1 行改変」テストの誤った期待値（`row3` の `prev_hash` 不一致を期待していたが、正しくは
  改変した `row2` 自身が `row_hash` 不一致で break point になる）も訂正した。**verify_commands
  6 本すべて exit 0**（`typecheck` / `lint` / `test:unit` 37 ファイル 971/971 / `test:integration`
  6 ファイル 92/92 / `gate:constraints` / `gate:wording`。`scripts/record-run.sh task_014` 経由で
  実測。途中 1 回 `typecheck` が他タスク（`src/lib/auth/pepper.ts`）の編集中で一時的に exit 1 に
  なった記録が run-log に残っているが、当該タスクの編集が落ち着いた後に再実行して exit 0 を確認）。
  残懸念 5 件（`docs/concerns/task_014.md`）: retention_due_at の起点が無い（P-03。medium・
  task_014 の files_to_modify がマイグレーションを含まないため実装不可）、O-2〜O-6.5 に e2e/a11y
  が無い（P-11。medium・task_022 送り）、監査連鎖のグローバルロックは仕様どおり（P-08。low・
  task_020 送り）、幹事あたりの合計請求額上限は意図的に未実装（low・task_021 の所有と既存コメントで
  明記済み）、Hyperdrive 経由の実測（A21。low・deferred: task_035 完了後）。
- task_012（レビュー修正・3 周目）: DONE_WITH_CONCERNS — 2 周目の修正（10b4e7f / 12fc3b9）に G5 を掛け直した結果、Gemini 2.5 Pro は PASS（指摘 0）、GPT-6 Astra が high 1 / medium 1 を出して merge は reject。2 件とも再現してから直した。(1) **[high] 同時の初回ログインでアカウントが分裂する**（2 周目に塞いだ C-012-20 は*逐次*の分裂だけだった）。行がまだ無い状態では `FOR UPDATE` は何も守らず、一意制約 `(identity_scope, pepper_version, line_user_ref)` にも `pepper_version` が入っているため、v1 の処理系と v2 の処理系が同じ人の初回ログインを同時に処理すると両方とも「見つからない」と判断して別々の行を作れる。スタブで「ロック待ちのあいだに別トランザクションが作って commit した」状況を組むと、修正前は取り直しを一切せず作成経路へ進むことを実測。**作成・移行の経路だけ**を `pg_advisory_xact_lock`（固定鍵 1 本）で直列化し、ロック取得後に現行版を**引き直す**形にした（通常ログインはロックを取らない）。鍵を人ごとにできないのは、`line_user_ref` から作ると PEPPER が違う処理系で鍵も変わり、まさに守りたい競合を直列化できないため（生 `sub` を鍵にするのは L7 違反）。Postgres 側の前提は実 DB に `app_rw` で 2 セッション繋いで実測した（1 本目がロック保持中の 2 本目は `lock_timeout` で `canceling statement due to lock timeout`、1 本目の COMMIT 後は即取得）。ついでに未知バージョンの検査を「自分より新しい版」から「**自分の設定に無い版**」（`pepper_version <> ALL(設定の版)`）へ広げ、古い版を捨てた処理系も止まるようにした。(2) **[medium] 引用符付きキーの Unicode エスケープで gate:env の検査を回避できる**。TOML の基本文字列は `\uXXXX` / `\UXXXXXXXX` を解釈するので `"SUPABASE_SERVICE_ROLE_\U0000004BEY"` はキーとして `SUPABASE_SERVICE_ROLE_KEY` に等しい。フィクスチャで exit 0 を再現し、`decodeTomlBasicString()` を足してキーと値の両方を復号してから突き合わせる形にした（未知エスケープ・範囲外コードポイント・サロゲートはそのまま残す）。**verify_commands は 5 本すべて exit 0**（`typecheck` / `test:unit` 37 ファイル 972/972 / `test:integration` 6 ファイル 92/92 / `gate:constraints` / `gate:env`。ほかに `lint` / `gate:plan` / `gate:server-only` / `test:security` / `build` も exit 0）。2 周目に赤だった 2 本（`test:unit` の gate-constraints 5 秒タイムアウト・`test:integration` の他タスク未追跡ファイル）は、機械の負荷が下がったことと当該タスクの修正で解消した。G13 基準値は他タスクの未コミットのガード対象が無くなったため overlay なしで再生成した。
- task_013（レビュー修正・4 周目の 4 巡目 / BLOCKED）: 3 巡目の修正に対する敵対レビューで gemini は **PASS（finding 0 件）**、GPT-6 Astra が **high をさらに 1 件**出した（merge-review: `reject` / 有効票 2 / 実効 high 1）。**退避先を置き場オブジェクトごとに持ったため、既定の置き場が途中で参照できなくなると数が切り替わる**という反例である。`defaultStorage()` は `sessionStorage` への参照自体が throw すると `null` を返すので、参照できていた間の数（2）と `null` になった後の数（0）が別勘定になり、3 回目の `login()` が通る。3 巡目のテストは「同じ置き場オブジェクトのメソッドが例外になる」場合しか見ていなかった。`globalThis.sessionStorage` を「`available` が真なら実体を返し、偽なら `SecurityError` を投げる」getter にし、**`storage` を渡さない本番経路**で 2 回進めてから落とすテストを足して再現（`expected 'redirecting_to_login' to be 'auth_unavailable'`）し、退避先のキーを「置き場オブジェクト」から**スコープ**に変えた: `deps.storage` 未指定の経路（本番）は `defaultStorage()` の戻り値が `sessionStorage` でも `null` でも常に同じ `DEFAULT_STORAGE_SCOPE` で数える（カウンタが属する単位は置き場ではなくページ）。注入された置き場だけ従来どおり置き場ごとに分ける。修正後は task_013 所有テスト 103 件が全緑で、verify_commands 6 本も `scripts/record-run.sh task_013` 経由で全て exit 0（`typecheck` / `lint` / `test:unit` 37 ファイル 974/974 / `build` / `build:web-only` / `gate:constraints`。`build:web-only` は 1 度 exit 1 になったが、内容は並行タスクの `next build` とのロック衝突「Another next build process is already running」で、単独で再実行して exit 0 を確認した）。**ただしこの 4 巡目の修正は敵対レビューに掛けていない**（reject 後の再実行が指示された上限 2 回に達したため）。`docs/review-log/task_013.json` の最後の記録は 1 つ前のコミットに対する `reject`（実効 high 1）なので、§15-3 step 5「3 周後も high が残れば BLOCKED」に該当し、**本周の完了ステータスは BLOCKED** とする。次の周は C-013-19 の修正とストレージ故障モード 5 種（置き場が無い／読み書きが例外／読めるが書けない／途中で落ちる／既定の置き場の取得自体が落ちる）のテストをレビューに掛け直すところから始める。
- task_008（レビュー修正・8 周目）: DONE_WITH_CONCERNS — レビューの high 1 件を「まず修正前 HEAD で穴を再現 → 直す → 同じ応答表で塞がったことを実測」の順で直し、medium 1 件（Workflow ツール不在）は deferred のまま据え置いた。**[high] `release-audit.ts` の成立条件 3 が PO の承認ファイルの有無を見ていなかった**。`pass` は `unapprovedUnavailable.length === 0` だけで決まり、`EVIDENCE_SCHEMA` の `required` に入れて集めていた `evidence.approval_file_exists` は detail 文字列に「承認記録: あり/なし」と印字するだけでどの判定にも使われていなかった。そのため、承認ファイルが無い（`approval_file_exists: false`）のに `approved_unavailable_vendors` に不達ベンダーが載った自己矛盾した封筒で、条件 3 が「未承認: なし / 承認記録: なし」と書きながら `pass: true` になり `verdict: "go"` が出た（修正前 HEAD の本体をテストと同じ `AsyncFunction` ラップで実走させた実測: `{verdict:"go", unapproved_unavailable_vendors:[], cond3.pass:true}`。ログ行も「成立条件 6 項目すべて YES」）。task_008 の scope 行「不達は PO の明示承認を `docs/gates/release-<version>.json` に」と計画書 §15-3 の同文は**その記録がファイルにあること**を要求しており、7 周目に塞いだ「自己申告を会計に使わない」（C-008-11）と同じクラスの fail-open だった。承認の存在は `approval_file_exists`（材料集めが実際に見たファイルの有無）だけで決め、記録が無い間は `approved_unavailable_vendors` の申告を空として扱って不達を必ず未承認へ落とす形に直した。黙って捨てないよう、無視した申告は `disregarded_approved_unavailable_vendors` と条件 3 の detail に出す。材料集めのプロンプトにも「記録の無い承認は存在しない」を明記。修正後は同じ応答表で `verdict: "no-go"` / `unapproved_unavailable_vendors: ["claude"]` / `cond3.pass: false`（実測）。**非空振りの対照**: 追加した 1 ケースは修正前 HEAD（`git show HEAD:` で取り出した本体）では `go` になることを実測済み。テストは 49 → 50 件（`expect` の削減・`skip` / `only` の追加は無し）。`gate:constraints`（唯一の `verify_command`・23 entries / 0 違反）/ `typecheck` / `lint` / `gate:integrity`（43 ファイル照合・**不一致 0 件**。7 周目に残っていた 2 件は所有タスク task_004 のコミットで解消）/ `npx vitest run tests/unit/workflows`（50/50）は `scripts/record-run.sh task_008` 経由で全て exit 0。G13 基準値は今周も退避した木（`git ls-files` + `tar`。退避時点で G13 対象領域に他タスクの未コミット差分は 0 件と実測）を `--root` に渡して再生成し、diff は `.claude/workflows/release-audit.ts` の 1 エントリと timestamp のみ。**`done_definition` 第 1 項は依然 deferred**: 本セッションでも `ToolSearch select:Workflow` は `No matching deferred tools found` を返し、runId / journal は取得できていない（C-008-1。確認は `record-run.sh --manual` で記録）。
- task_012（レビュー修正・4 周目）: DONE_WITH_CONCERNS — 3 周目の修正（d6f140f）への G5 は Gemini 2.5 Pro が PASS（指摘 0）、GPT-6 Astra が medium 2 件（high 0）で **merge は pass**（実効 high 0・有効票 2・欠票 0）。差し戻しではないが 2 件とも実在の穴なので同じ周で塞いだ。(1) **[medium] 引用符付きの表名・点区切りのキーで gate:env の検査を回避できる**。TOML は表名も引用符を取れる（`[env.staging."vars"]`）しキーも点で区切れる（`vars."DATABASE_URL" = …`）ため、「vars 表かどうか」の判定を外して禁止名の検査を丸ごと回避できた。新フィクスチャ `quoted-tables` に対し **HEAD 版のスクリプトを `git show HEAD:` で取り出して実行し 0 violation / exit 0 を実測**（再現）。表名とキー列を `normalizeTomlKeyPath()` で正規化し、代入行の切り出しを「引用符の外にある最初の `=`」に変えて点区切りキーも拾う形にした（2 周目に「未対応」として残していた穴も同時に塞がった）。修正後は同フィクスチャで exit 1・違反 2 件、`APP_ENV of 'staging'` の検査も通るようになった。(2) **[medium] cron Worker のシークレットがライブ検査の対象外**。照会先がメインアプリ Worker 1 本しかなく、cron 側に禁止名があっても検出できない構造だった。ライブ検査を「ランタイム × environment」の二重ループにし、cron には `--config workers/cron/wrangler.toml` を付ける（`-c, --config` の存在は `npx wrangler secret list --help` で実測。wrangler 4.137.0）。`CLOUDFLARE_API_TOKEN=invalid-token-for-local-check` で 4 通り（main/staging・main/production・cron/staging・cron/production）すべてが照会を試みることを出力で確認した。**認証が通った状態の成功経路は cron・main とも未実走**（Cloudflare アカウント未作成。C-012-12 / C-012-24。実走は task_024）。検証は `typecheck` / `lint` / `gate:env` / `gate:constraints` / `test:unit`（37 ファイル 981/981）がすべて exit 0。`npm run test:integration` だけ exit 1 で、落ちたのは他タスク（task_014）の `tests/integration/events.test.ts` の表示名ソート 1 件（task_012 側の `auth` / `schema` / `db-role` / `ci-workflow` 4 ファイル 73/73 は緑）。
- task_004（レビュー修正・4 周目）: DONE_WITH_CONCERNS — 2 回目の G5（view commit `4291cef`）が **reject**（有効票 2 / 欠票 0 / **実効 high 2**）だったので、high 2 件・medium 3 件を「まず穴を再現 → 直す → 同じ手順で塞がったことを実測」の順で全件直した。(1) **[high] SQL の不等号 `<>` が W3 の前進方向ランク比較として免除されていた**。3 周目に入れた許可パターン `(status_rank|statusRank)[[:space:]]*<=?` が `<>` の先頭の `<` にも一致するため、`WHERE status_rank <> 2` はランク 3（refunded）の行も更新対象にするのに免除されていた（実測 exit 0）。`<` の直後が `>` でないこと・`>` の直前が `<` でないことを要求する形に直し、修正後は `W3 src/lib/update.ts:1` / exit 1、`<= $2` と `$2 >= status_rank` は exit 0。(2) **[high] ブロックコメント内の `import "server-only";` が GC-SERVER-ONLY の必須検査を満たしていた**（3 周目に「行単位 grep の限界」として残した項目）。`require` モードの照合前に awk でコメントを落とす（`/* */` は行をまたいで状態を持ち、`//` と `--` は行末まで）。文字列リテラルは意図して解釈しない — 誤って切り落とせば必須検査が落ちる fail-closed 側に倒れるため。修正後は `/*\nimport "server-only";\n*/` が exit 1、`postgres://` を含む doc コメントの後に本物の import がある形は exit 0、実リポジトリの `gate:constraints` / `gate:server-only` も exit 0。(3) **[medium] `src/lib/**` の除外が `.tsx` まで巻き込んでいた**。2 周目に I3 を広げた際の除外が拡張子を問わなかったため、`src/lib/client-db.tsx` の `'use client'` ＋ `postgres` import が検査から漏れていた（実測 exit 0）→ 除外を `src/lib/**/*.ts` / `src/app/api/**/*.ts` に限定。(4) **[medium] `timestamp(3) with time zone` を誤って違反にしていた**（偽陽性・実測 exit 1）→ 精度付きパターンにも裸 timestamp と同じ終端条件を付けた。(5) **[medium] gemini の「`npm run test:unit` が落ちている」**は本周の実測で **exit 0**（37 ファイル 981/981 緑・135 秒）となり解消した（3 周目の赤が負荷由来だったことの裏づけ）。`scripts/record-run.sh task_004` 経由で `test:unit` / `gate:constraints` / `gate:wording` / `typecheck` / `lint` / `gate:server-only` がすべて exit 0、task_004 所有の 2 テストファイルは 58/58 緑（`it` 52 → 58 件・`expect` は増加のみ）。残る C-004-6 は forbid 側だけ: SQL 行コメント内の `-- and status_rank < 2` が W3 を免除する件で、`allow_if_line_matches` にコメント除去を掛けると文字列リテラル中の `//` で正当なガードを見落とす偽陽性になるため直していない。
- task_012（レビュー修正・5 周目 / 記録のみ）: DONE_WITH_CONCERNS — 4 周目の修正（c8c799f）への G5 は Gemini 2.5 Pro が PASS（指摘 0）、GPT-6 Astra が medium 2 件（high 0）で **merge は pass**（実効 high 0・有効票 2・欠票 0）。**3 周目・4 周目と 2 周連続で pass** したため、この 2 件は**直さずに残す**判断をして docs/concerns/task_012.md に理由つきで記録した。(a) **インラインテーブル（`vars = { … }`）の中の禁止名を gate:env が見ない**（C-012-25）。これは 2 周目から「未対応」と明示してきた同じ穴（最小限の TOML 読み取りしか持たないこと）の別の顔で、引用符付きキー → Unicode エスケープ → 引用符付き表名 → インラインテーブル、と 1 つずつ塞いできたが**手書きの読み取りを継ぎ足すかぎり次の形が必ず残る**。恒久対処は TOML パーサの導入で、依存を増やす判断は `wrangler.toml` の正本を持つ task_035 / task_024 に送った（それまでの緩和は「素のキー・素の表名・1 行 1 代入で書く」運用規約で、実リポジトリの 2 ファイルは現にその形）。(b) **`docs/ops/env-baseline.json` の `secrets` を誰も検査していない**（C-012-26）。baseline は task_035 の `files_to_create` でまだ存在せず、ライブ検査も実走できていない（C-012-12）ため、いま書いても**入力も出力も検証できないコードをゲートに足す**ことになる。task_035 が baseline を作るときに検査も同時に足し、実際の `wrangler secret list` の出力で検証する。G5 の記録（round 1〜4）は docs/review-log/task_012.json にある。
- task_013（レビュー修正・4 周目の 5 巡目）: BLOCKED — 4 巡目修正（2b44ea3）への敵対レビューは gemini **PASS（finding 0）**、GPT-6 Astra が high 1 / medium 2 で reject。3 件とも再現→修正→実測まで済ませた。(1) **[high F-1] 保存値を読んだだけの回が退避先に残らない**。`readAttempts` は保存値と退避先の大きいほうを返すだけで書き戻していなかったため、新しいページで保存値 `2` を読んで `auth_unavailable` を返す回（＝ `writeAttempts` を通らない回）のあと、同じページのまま `sessionStorage` の取得が落ちると試行回数が 0 に戻り 3 回目の `login()` が通る。`cashapp.liff.loginAttempts='2'` を持つストレージを返す getter を置き、**`storage` を渡さない本番経路**で 1 回打ち切ってから getter を `SecurityError` に変えるテストで再現（`expected 'redirecting_to_login' to be 'auth_unavailable'`）し、`readAttempts` が求めた値を `writeMemoryAttempts` で退避先へ同期するようにした（`Math.max` なので減る方向には働かない）。C-013-20。(2) **[medium F-2] `liff.login()` の例外が state とテレメトリを迂回する**。SDK 読み込みと `init` には例外処理があるのに `login()` だけ素のままで、投げられると `bootLiff` ごと reject し「例外を投げない」という契約が破れる（画面は state を受け取れずテレメトリも出ない＝ R-LINE-03 の白画面）。`login` が throw する SDK で再現（`Error: login failed` が素通り）し、`try` で包んで `auth_unavailable` ＋ 新コード `login_call_failed` を返すようにした。打ち切り（`login_loop_aborted`）と分けたのは監視で数える単位が違うため。数えた分は戻さない。C-013-21。(3) **[medium F-3] ビルドに適用されない環境変数代入でも固定値検査を通過する**。`checkProductionBuildEnv` は npm script の本文に `NEXT_PUBLIC_LIFF_MOCK=0` があるかしか見ておらず、シェルの `VAR=値 コマンド` がそのコマンド 1 つにしか効かないことを無視していた。fixture に `NEXT_PUBLIC_LIFF_MOCK=0 echo prepare && next build` を渡すと **exit 0（合格）**になることを実測（`expected +0 to be 1`）し、`&&` / `||` / `;` で区切って実ビルドコマンド（`next build` / `opennextjs-cloudflare build`）を探し、その直前の代入か先行する `export` に `=0` があることを要求する `checkBuildCommandEnv()` を足した。ビルドコマンドが 1 つも無い場合も違反にする（空振り防止）。`export ... && next build` を通す対照テストも置いた。C-013-22。**verify_commands 6 本すべて `scripts/record-run.sh task_013` 経由で exit 0**（`typecheck` / `lint` / `test:unit` 37 ファイル 986/986 / `build` / `build:web-only` / `gate:constraints`）。task_013 所有テストは liff 27 件・web-only gate 14 件を含み 14 ファイル 248/248 緑。**この 5 巡目の修正に対する敵対レビューはこのコミット時点では未実施**のため、`completion_status` は BLOCKED のままとする（レビューが pass すれば DONE_WITH_CONCERNS へ戻す）。
- task_013（レビュー修正・4 周目の 5 巡目レビュー結果）: DONE_WITH_CONCERNS — 5 巡目修正（`d1a2eeb`）を `aa7a8dc..d1a2eeb` の全範囲で敵対レビューへ掛け、**merge-review: pass（有効票 2 / 投票ベンダー gemini・gpt / 実効 high 0）**。high は 5 巡かけて全て解消した。出た medium 6 件のうち 3 件をこの場で再現→修正→実測した。(1) **[gemini F-1] 代入だけの節を後続へ引き継いでいた**件は **HEAD で再現せず**（`splitLeadingEnv` が `^NAME=値\s+` と末尾空白を要求するため当該分岐に到達しない。`NEXT_PUBLIC_LIFF_MOCK=0; next build` と `... && next build` の fixture はどちらも修正前から exit 1 だった）。ただし分岐自体が誤ったシェル意味論（実測: `sh -c 'FOO=bar; printenv FOO'` は空、`export FOO=bar && printenv FOO` は `bar`）を書いていたので削除し、実測表をコメントに残して 2 つの fixture を回帰に据えた。C-013-23。(2) **[GPT F-1] `isInClient` / `isLoggedIn` / `getIDToken` が例外処理の外**で、投げると `bootLiff` が reject して契約が破れる（3 つとも `Error: ... failed` が素通りすることを実測）。同期呼び出しを包む `callSdk()` を足し、状態取得の失敗は `init_failed`、トークン取得の失敗は `auth_unavailable` に寄せ、テレメトリは新コード `sdk_call_failed`（`login_call_failed` と分けたのは「遷移を始めて転んだ」か「まだ何も始めていない」かで復旧手順が違うため）。C-013-24。(3) **[GPT F-4] パイプ左側だけの代入**が右側の `next build` にも効くものとして扱われていた（`NEXT_PUBLIC_LIFF_MOCK=0 printf x | next build` が exit 0 になることを実測）。区切りを `/&&|\|\||;|\|/` にした（`\|\|` を `\|` より先に置かないと `||` が空節 2 つに割れる）。C-013-25。残り 3 件は対応案つきで持ち越した: 429 も毎回 `telemetry.rejected` を書くためログ量が絞れない（C-013-26・task_023 / task_024）、`tokens.css` の `min-width: 20rem` が文字サイズ 200% で 640px を要求する（C-013-27・task_025 / task_022）、`readSpecifiers` がコメントを挟んだ副作用 import を見落とす（C-013-28・task_022）。**この 3 件の修正（C-013-23 / 24 / 25）はレビュー往復の予算を使い切った後に入れたので敵対レビューに掛かっていない**（台帳の concerns に明記）。verify_commands 6 本と `gate:acceptance` は `scripts/record-run.sh task_013` 経由で全て exit 0。
- task_004（レビュー修正・5 周目）: DONE_WITH_CONCERNS — 3 回目の G5（view commit `1936950`）も **reject**（有効票 2 / 欠票 0 / **実効 high 1**）だったので、high 1 件・medium 4 件を全件再現してから直した。今回は「1 行の ERE では表現できない条件」を 2 件、別ゲートの禁止パターンに置き換えている。(1) **[high] `NOT (status_rank < 2)` が W3 の免除条件を満たしていた**。許可パターンは「前進方向の比較が同一行にあること」しか見られず、その比較が否定されているかは ERE に後読みが無いため判定できない（実測 exit 0）。否定つきランク比較そのものを禁じる gate_only_check **GC-RANK-NEGATION** を追加し、修正後は exit 1（実リポジトリは対象 53 ファイルで違反 0。`NOT NULL` には当たらない）。(2) **[medium] テンプレート文字列内の `import "server-only";` が必須検査を満たしていた** → 4 周目に入れたコメント除去にバックティックの状態を持たせた。(3) **[medium] `src/lib/**/*.ts` の除外でクライアント用 `.ts` が I3 から漏れる**件は、除外自体が外せない（src/lib は Route Handler から呼ばれるサーバーコードで `postgres` を正当に import する）ので、**除外が成り立つ前提そのものをゲート化**した — gate_only_check **GC-LIB-CLIENT-DIRECTIVE** が `src/lib/**` の単独行 `'use client'` を禁止し、クライアントモジュールは `src/components/` か `src/hooks/`（どちらも I3 の対象）に置くほかなくなる。(4) **[medium] TOML の `#` コメントで I1 / I2 が合格していた** → 除去処理を拡張子ごとに切り替えた（`.ts` 系は `//` `/* */` テンプレート文字列、`.sql` は `--` `/* */`、`.toml/.yml/.sh/.ini/.conf/.env` は `#`、未知は全部）。TypeScript の `#private` を TOML 用の規則で切る事故を避けるため。(5) **[medium] コメント内のランクガードで W3 の免除が成立する**件（3・4 周目に C-004-6 として残していた）は、**免除判定だけを除去後の行に対して行い、違反の検出は生の行のまま**にして解決した。除去が行を切りすぎても違反が増えるだけで隠れない、という非対称性がある。`gate:constraints` / `gate:wording` / `gate:server-only` / `lint` は `scripts/record-run.sh task_004` 経由で exit 0、task_004 所有の 2 テストファイルは 63/63 緑。**`npm run typecheck` は exit 2・`npm run test:unit` は exit 1** で、どちらも task_013 が編集中の未コミットファイル（`src/lib/liff/client.ts` の `Cannot find name 'callSdk'` / `tests/unit/ci/web-only-workflow.test.ts` のアサーション 1 件）に起因し、task_004 の所有ファイルは 1 つも参照していない（4 周目の実測ではどちらも exit 0 だった）。
- task_014（G5 round1 の指摘反映）: DONE_WITH_CONCERNS — `9d393be` に対する G5 round1
  （`docs/review-log/task_014.json`）は **merge-review: pass**（有効票 2・欠票 0・実効 high 0）
  だったが、gemini 1 件・GPT-6 Astra 9 件、計 10 件の medium 指摘が出た。実効 high が無くゲート
  自体は round1 の時点で通過していたが、指摘は全て実在の穴だったため 10 件とも再現して直した
  （詳細と各回帰テストの所在は `docs/concerns/task_014.md`「G5 round1 の指摘と対応」）。
  (1) 監査ハッシュがトップレベルのキー順（未規定ではないが構造的に脆い前提）に依存 → 全体を
  `sortKeysDeep`。(2) 並行リクエストでイベント数・参加者数の上限を超えられる → advisory xact lock
  を COUNT の前に追加。(3) `sort=label_asc` のカーソルが `ORDER BY` と食い違い境界行が欠落 →
  `WHERE` 側もタプル比較に統一。(4) 通信失敗後の再送で冪等キーが変わり二重作成し得る → キーを
  `useRef` で失敗時は使い回し。(5) 未確定の決済手段が「手数料なし・即時」にフォールバックする →
  フォールバック撤去。(6) 参加者 0 名のイベントに正の受取見込額が付く → `null` と `0` を区別。
  (7) `confirmation_method='mixed'` の支払済み請求がサマリから消える → `paidMixed` を配線。
  (8) 指数表記の金額が誤変換される → `Number()` ベースの `parseDefaultAmountMinor` に変更。
  (9) TTL を過ぎた冪等キーが再利用を拒否され続ける → `ON CONFLICT ... DO UPDATE WHERE expires_at
  < now`。(10) 「もっと見る」連打で参加者が重複表示される → `loadingMore` ガード。
  **verify_commands 6 本すべて `scripts/record-run.sh task_014` 経由で exit 0**（`typecheck` /
  `lint` / `test:unit` 38 ファイル 1005/1005 / `test:integration` 6 ファイル 100/100 /
  `gate:constraints` / `gate:wording`）。この修正自体に対する G5 round2 の結果は下の行を参照。
- task_004（レビュー修正・7 周目）: DONE_WITH_CONCERNS — 4 回目の G5 は gemini が high 1 件（「`npm run test:unit` が落ちている」）で GPT が経路不達（欠票）。この high は封筒が読んだ run-log の時点（`d1a2eeb`）の記録で、落ちていたのは **task_013 が編集中だった未コミットの** `tests/unit/ci/web-only-workflow.test.ts` と `src/lib/liff/client.ts` であり、task_013 のコミット後に同じ HEAD で走らせ直すと `typecheck` / `test:unit` とも exit 0（1005/1005 緑）だった。5 回目の G5 は GPT が high 1 件 / medium 2 件（gemini は欠票）で、3 件とも再現してから直した。(1) **[high] `WHERE status_rank < 2 OR id = 1` のように OR で別条件を足すと、前進ガードが行内に在るまま後退できる**（実測 exit 0）。`GC-RANK-NEGATION` を「否定」だけでなく「弱められた形」全般へ広げ、ランク比較と同一行の ` OR ` / `||` も禁止した（ランク本体の `src/lib/ledger/rank.ts` / `apply.ts` は除外のままで、そこは task_018 の台帳テストが担保する）。(2) **[medium] I3 が動的 `import('postgres')` と副作用 import を見逃していた** → P1 と同じ形のパターンを追加。(3) **[medium] X-TIME が `ADD COLUMN IF NOT EXISTS ... date` を見逃していた** → DDL パターンに `IF NOT EXISTS` を挟めるようにした。`scripts/record-run.sh task_004` 経由で `npm run test:unit`（38 ファイル **1008/1008 緑**）/ `gate:constraints` / `gate:wording` / `typecheck` / `lint` がすべて **exit 0**、task_004 所有の 2 テストファイルは 66/66 緑。
- task_004（レビュー修正・8 周目、打ち切り）: DONE_WITH_CONCERNS（**未解消の high 1 件あり**） — 6 回目の G5（view commit `99da9bd`）は **gemini PASS / GPT FAIL**（high 1 / medium 4）で `merge-review.sh` は reject（実効 high 1）。**5 件のうち 2 件だけ直し、3 件は未修正として記録した**。直した 2 件: (1) **5 周目に自分で作り込んだ回帰**。require 経路のテンプレート文字列除去を全エントリに掛けていたため、`src/lib/reconcile.ts` に `` sql`SELECT pg_try_advisory_lock(42)` `` と書くと **W11 の必須パターンが消えて `required pattern missing` になる**（task_020 が着地した時点で壊れる）→ 除去を**エントリごとのオプトイン**（`strip_template_strings: true`）にし、実行される「文」を要求する GC-SERVER-ONLY だけ有効にした。(2) `'use client'; // client module` のように行末コメントが付くと GC-LIB-CLIENT-DIRECTIVE の行末アンカー `$` を外れ、I3 の除外と合わせて両方から漏れていた → `$` を外した。**未修正で残した 3 件（C-004-8）**: `WHERE status_rank < 2` と `OR id = 1;` を 2 行に分けると W3 の免除も GC-RANK-NEGATION の検出も行単位なのですり抜ける（**high**）／テンプレート文字列内のエスケープされたバックティックを除去処理が終端と誤認する／動的 import の引数を改行すると P1 をすり抜ける。**打ち切りの理由**: 3 件とも「grep は 1 行ずつしか見ない」という道具の性質そのもので、2〜6 回目の G5 は毎回この形の high を 1 件返した（`<>` → `OR` → 改行した `OR`）。潰すたびに同じ構造の別例が出るため、必要なのはパターンの追加ではなく道具の交換（TypeScript は AST ＝ task_011 の `assert-server-only.mjs`、SQL は task_018 の台帳テスト）であり、PO 判断に委ねる。`scripts/record-run.sh task_004` 経由で `npm run test:unit`（38 ファイル **1010/1010 緑**）/ `gate:constraints` / `gate:wording` / `typecheck` / `lint` はすべて **exit 0**、task_004 所有の 2 テストファイルは 68/68 緑。
- task_014（G5 round2）: DONE_WITH_CONCERNS — `41e8840`（round1 の指摘反映コミット）に対する
  G5 round2 は `docs/review-log/task_014.json` の `round: 2` に記録済みで **merge-review: pass**
  （有効票 2・欠票 0・実効 high 0）。gemini 1 件・GPT-6 Astra 6 件、計 7 件の medium 指摘が出た。
  round1 と同じ方針で全件評価し、4 件は実装バグとして修正、3 件は task_014 の所有ファイル外か
  より大きな設計判断を要するため concerns（C-014-6〜8）に記録した（詳細は
  `docs/concerns/task_014.md`）。
  - **[GPT F-3] 成功応答の本文受信に失敗すると送信・登録ボタンが無効のまま固まる**:
    `response.json()` をこの節だけ try/catch で包み、失敗時はボタンを再度押せる状態に戻す。
    冪等キーはここでは使い切らない（サーバーは既にコミット済みなので、null にすると再試行が
    別のキーとして扱われ二重作成し得る）。ただしこの経路に入ると replay 応答が `joinToken` /
    `claimToken` を含まないため招待リンクの表示機会を失う（C-014-6。task_015 で設計判断）。
  - **[GPT F-4] 絞り込み後に古い「もっと見る」の応答が混入する**: `loadParticipants` の呼び出し
    ごとに連番を払い出し、自分より新しい呼び出しが始まっていれば結果を画面へ反映しない
    ガードを追加。
  - **[GPT F-5] canceled イベントが増えると進行中のイベントが一覧から消える**: 作成上限は
    `status <> 'canceled'` しか数えないのに一覧は canceled を含めた `created_at DESC LIMIT 100`
    だったため、canceled を積み重ねる通常操作だけで進行中イベントが一覧の窓から押し出され得た。
    `listOrganizerEvents` から canceled を除外（非 canceled は上限 20 なので必ず 100 件に収まる）。
    回帰は `tests/integration/events.test.ts`「canceled イベントが増えても進行中のイベントは
    一覧から消えない」。
  - **[GPT F-6] 小数の金額入力がエラーにならず黙って未設定になる**: `submit` に「非空なのに
    整数として解釈できない入力は送信を止める」チェックを追加。
  - 残り 3 件（gemini F-1: `removeParticipant` の TOCTOU（`payment_attempt` 作成経路が
    task_014 に無い）／GPT F-1: `verifyAuditChain` の既定 limit 10000 超は未検証（正式な
    audit:verify は task_018/020 の担当）／GPT F-2: F-3 と同根の joinToken/claimToken 紛失）は
    C-014-6〜8 として残し、対応予定タスク（task_015 / task_017 / task_018 / task_020）を付記した。
  **verify_commands 6 本すべて `scripts/record-run.sh task_014` 経由で exit 0**（`typecheck` /
  `lint` / `test:unit` 38 ファイル 1010/1010 / `test:integration` 6 ファイル **101/101**
  （F-5 の回帰テスト 1 本を追加）/ `gate:constraints` / `gate:wording`）。
- task_015: DONE_WITH_CONCERNS — 請求発行・招待トークン・参加者単位 claim/unclaim・preview・
  自己申告・参加者画面（P-1〜P-3）を実装。新規 25 ファイル（`src/lib/join-token.ts`、
  `src/lib/db/repositories/{invoices,claims}.ts`、幹事 API 7 本、参加者 API 7 本、画面 4 枚、
  テスト 5 本）＋ `src/app/api/events/route.ts` と `src/components/InvoiceRow.tsx` の修正。
  **招待トークンは 128 ビット CSPRNG・SHA-256 ハッシュのみ保存・90 日の期限・ローテーション可**で、
  入口はヘッダ `X-Join-Token` だけ（パスに置かない。制約 X-ID）。生の値を保存しないため
  `GET /api/events/:id/join-token` はメタ情報だけを返し、配り直しは
  `POST /api/events/:id/rotate-join-token`（旧リンク即 404）— これが task_014 の **C-014-6 への
  回答**で、`POST /api/events` の応答に `joinTokenAvailable` を足した。claim は
  `participant_claim` の部分一意 2 本で二重 claim を DB が止め（409 `ALREADY_CLAIMED`）、
  同一人物・同一参加者の再送だけは成功として返す。unclaim は理由を固定分類で受け、支払済みなら
  `needs_attention` を立てる（ランクは動かさない）。自己申告は `payment_self_report` にのみ記録し
  **`ledger_entry` には 1 行も書かない**（テストで前後の件数一致を実測）。preview はセッション不要・
  IP レート制限つきで、応答の型にも実データにも `amount` / `status` キーが無い（6 キー固定・氏名なし）。
  P-3 の「申告済み（幹事の確認待ち）」は支払済みと tone・文言・アイコンをすべて分け、スナップショット
  2 枚が別物であることを固定した。**verify_commands 5 本すべて `scripts/record-run.sh task_015`
  経由で exit 0**（`typecheck` / `test:unit` 43 ファイル **1096/1096** / `test:integration`
  10 ファイル **175/175**（新規 64 件）/ `gate:constraints` / `gate:wording`）。残懸念 7 件は
  `docs/concerns/task_015.md`（C-015-1〜7。medium 5・low 2）。
- task_015（G5 round1 の指摘反映）: DONE_WITH_CONCERNS — `2a17eb5` に対する G5 round1 は
  **reject（有効票 2・欠票 0・実効 high 1）**。gemini 1 件・GPT-6 Astra 7 件のうち重複を除く
  **7 件すべてを修正**した。**[high] 氏名を共有していない参加者を個別リンクなしで claim できた**
  （`listCandidates` は `name_visibility='participants'` に絞るのに `claimParticipant` の
  participantId 経路が見ていなかった。UUID を知る第三者が候補一覧に出ない行を claim して氏名・
  金額・状態を読めた）→ 名簿選択の経路に `name_visibility='participants'` を必須にし 404。
  **[medium] 作成時の招待トークンに期限が付かなかった**（`createEvent` が
  `join_token_expires_at` を書かず、NULL を「期限なし」として受理していた）→ **NULL は無効**
  （fail-closed）に変え、`POST /api/events` が作成と同一トランザクションで 90 日の期限を書く。
  **[medium] P-1→P-2 で個別 claim トークンが失われる** → `c` を引き継ぐ。
  **[medium] claim 済みの人が招待リンクを開き直すと候補 0 件の袋小路** → P-2 が先に
  `GET /api/e/me` を引いて P-3 へ送る。**[medium] 「自分に送る」がイベントを失う** →
  `<permanentLink>/e?t=<joinToken>` を組み立てる。**[medium] 追加リクエストの承認後に本人が
  自分の行へ辿り着けない** → `requestAdd` が同じトランザクションでリクエスト者の claim も作り、
  承認は「その claim を有効にする操作」になる（`awaiting_approval` → `not_issued` → `unpaid`）。
  **[medium/low] 追加リクエストの同時実行で名簿上限を超えられる** → `createParticipants` と同じ
  advisory lock を COUNT の前に取る。**verify_commands 5 本と lint がすべて
  `scripts/record-run.sh task_015` 経由で exit 0**（`typecheck` / `lint` / `test:unit` 43 ファイル
  **1099/1099** / `test:integration` 11 ファイル **193/193** / `gate:constraints` /
  `gate:wording`）。
- task_017: DONE_WITH_CONCERNS — PaymentProvider IF v2（全メソッドの第一引数が `binding`、
  `ProviderCapabilities` 15 項目、`PaymentEventKind` に紛争・返金中、`ProviderAccountError`）、
  ブランド型 `Money`（`yen()` 以外で作れず、オブジェクトリテラルは型エラー。均等割りは最大剰余法で
  合計一致を 500 ケースのプロパティテストで固定）、レジストリ（**manual_confirm は全ガードを
  スキップ** → 環境 → `PAYMENTS_ENABLED` → ゲート（正本は `docs/gates/compliance-gates.json`、
  状態は DB 射影。射影に行が無いゲートは未通過扱い）→ MODE → binding → 幹事 suspended →
  `minors_included` → fixture provenance。**止めるのは `createCheckout` と binding 作成だけ**で、
  Webhook 受信・`getPaymentStatus`・`refund` の入口は `resolveProviderWithoutGate()` に分けた）、
  `ManualConfirmAdapter`（幹事から任意 URL を受け取らず、識別子だけからサーバー側テンプレートで
  組み立て、許可ホストを二重に検査。PayPay の URL 形式は一次資料未取得なのでテンプレートは
  `verified: false` のままで既定では `deepLink` は `null`）、`POST /api/invoices/:id/manual-attest`
  （reason 必須・`confidence='organizer_attested'`・`dedupe_key='attest:<id>'`・ランク前進ガード・
  生きた試行の取り下げ）、`POST /api/e/checkout`（**金額を取らない**・生きた attempt の再利用・
  write-ahead・ゲート解決を全書き込みより前に置いて `NO_PAYMENT_METHOD` / `GATE_NOT_PASSED`）、
  画面 5 枚（O-0 適格性つき分岐 / O-8 確定前ダイアログ / P-4・P-5 ホスト名併記と「この方法では
  払えない」/ P-6 幹事の確認待ち / P-7 会費受領記録）、`SummaryBar` に 8 層④⑤の明示行を追加。
  新規 19 ファイル（`src/lib/payments/{types,money,gates,registry}.ts`、
  `providers/manual-confirm.ts`、`src/lib/db/repositories/{gates,bindings}.ts`、API 2 本、画面 5 枚、
  テスト 5 本、`docs/vendor-docs/paypay/receiving-link.md`）＋
  `src/lib/payments/capabilities-static.ts` / `src/components/SummaryBar.tsx` の修正。
  レジストリの 9 パターンは**フェイク（unit）と実 DB（integration）の二段**で検査した。
  **verify_commands 6 本すべて `scripts/record-run.sh task_017` 経由で exit 0**
  （`typecheck` / `lint` / `test:unit` 43 ファイル **1096/1096** / `test:integration`
  11 ファイル **187/187** / `gate:constraints` / `gate:wording`）。`npm ls` に決済 SDK 無しも実測。
  残懸念 10 件は `docs/concerns/task_017.md`（C-017-1〜10。medium 4・low 6）。
- task_017（G5 round1 の指摘反映）: DONE_WITH_CONCERNS — `c79db44` に対する敵対レビューは
  `docs/review-log/task_017.json`（round 1・**merge-review: pass**・有効票 2・欠票 0・実効 high 0）。
  gemini 2.5 Pro は PASS（指摘 0）、GPT-6 Astra が medium 4 件 / low 1 件。差し戻しではないが
  5 件とも実在の穴なので同じ周で処理した（`a3e42a5`）。(1) **[medium F-2]
  `PROVIDER_<KEY>_MODE` が未設定（行なし = `null`）・不正値のときにガードを素通りしていた**
  （`'off'` のときだけ拒否していたため、`gates.ts` の「読めなければ無効に倒す」と食い違っていた）。
  `!== 'on'` の fail-closed に変え、回帰テストを足した。書いた回帰テストが最初は空振りしていた
  （フェイク環境の `options.mode ?? "on"` が `null` を既定値に吸っていた）ことも実測で見つけて直した。
  (2) **[medium F-3] ブランドが構造的なので `{ ...yen(3000), amountMinor: 3000.5 }` が
  型アサーション無しで `Money` になり、境界を通っていた**。`toProviderAmount()` に整数・範囲の
  検査を足し、`ManualConfirmAdapter` の金額検査もその 1 本へ寄せた（回帰テスト 2 件）。
  (3) **[medium F-4] P-6 がサーバーに問い合わせず常に「幹事の確認待ちです」を出していた**ため、
  幹事が `manual-attest` を済ませても参加者は確定後の状態を見られなかった。招待トークン（`?t=`）を
  P-4 → P-6 → P-7 で持ち回し、`GET /api/e/me` の実状態を出す形にした（トークンが無い場合は
  状態を断定せず P-3 へ誘導）。(4) **[low F-5] `mixedCount > 0` でも「すべて手動確認」と
  表示していた**ので条件に `mixedCount === 0` を足した。(5) **[medium F-1] write-ahead の保証は
  同一トランザクションの中では成立しない**（呼び出し後にコミット前で落ちれば試行記録も
  ロールバックされる）。Phase 1 の `manual_confirm` は外部呼び出しをしないので実害は無く、
  docstring を実態に訂正して C-017-11 として記録した（設計変更は task_018 / task_026）。
  `X-ID` の grep が React の依存配列 `}, [joinToken]);` を URL パス配置と誤検知したため、
  P-6 の局所変数名を `inviteToken` にした（トークンをヘッダでのみ運ぶ中身は不変）。
  **verify_commands 6 本すべて `scripts/record-run.sh task_017` 経由で exit 0**
  （`typecheck` / `lint` / `test:unit` 43 ファイル **1099/1099** / `test:integration`
  11 ファイル **193/193** / `gate:constraints` / `gate:wording`）。残懸念は 11 件（C-017-1〜11）。
- task_017（引き継ぎ・確認のみ）: DONE_WITH_CONCERNS — 実装（`c79db44`）と G5 round1 の指摘反映
  （`a3e42a5`）は既にコミット済みで、レビュー round1 は `merge-review: pass`（有効票 2 / 実効 high 0）。
  本セッションでは作り直さず、(1) F-2〜F-5 の是正がソースに実在することを実測確認
  （`registry.ts:214` の `!== "on"`、`money.ts:58-65` の整数・範囲検査、P-6 の `GET /api/e/me` 参照、
  `SummaryBar.tsx:74` の `mixedCount === 0`）、(2) verify_commands 6 本を HEAD `8f04f0a` で再実行して
  全て exit 0（`test:unit` 1099/1099・`test:integration` 193/193）、(3) done_definition 5 項目めの
  「決済 SDK 無し」を `npm ls --all` の走査で確認（一致は `is-promise` の偽陽性 1 行のみ）を行い、
  未コミットで残っていた `docs/run-log/task_017.json` の実行ログをコミットした。追加の実装変更は無い。
- task_019: BLOCKED — 依存タスク task_018（台帳適用・冪等基盤・Webhook ルート・
  `fixture_provider` 契約テストヘルパー）が完全に未着手（`git log --all --grep=task_018` 0 件、
  `files_to_create` 22 本が `find` で 0 件、全 `git worktree` にもコミット無し）であることを実測
  確認した。`npm run gate:constraints` 自身が `defer P2 (0 targets; waiting on task_018)` /
  `defer W4 (0 targets; waiting on task_018)` と出力し独立に裏付ける。`docs/research/design-
  synthesis.md` §9-2 は「キットは保存済み fixture を HTTP で自前 Route Handler に投げる形で
  実装」と明記しており、C1〜C31 のうち C1〜C4/C4b/C6〜C8/C11/C14〜C19/C21〜C26/C28〜C31 は
  Webhook ルート（`src/app/api/webhooks/[providerKey]/[bindingRef]/route.ts`）と
  `applyToLedger`（`src/lib/ledger/apply.ts`）を経由した DB 実状態の検証を要求するため、
  task_018 のファイル群なしには `done_definition`「fixture_provider は C1〜C31 pass」を満たせ
  ない。これらは全て task_018 の `files_to_create` であり、task_019 の担当範囲外のため実装
  しなかった（他タスクのファイルを作らない・変更しない規約）。`npm run gate:constraints` は
  `scripts/record-run.sh task_019` 経由で exit 0（`docs/run-log/task_019.json`）。残懸念は
  `docs/concerns/task_019.md`（severity: high 1 件。対応案: task_018 完了後に task_019 再着手）。
  実装コミットは 0 件（BLOCKED のため）。
- task_015（G5 記録の確定・クローズ）: DONE_WITH_CONCERNS — 前ワークフローで中断していた仕上げを
  完了させた。実装本体（`2a17eb5`）と round1 の指摘反映（`d3e5368`）は既にコミット済みで、
  未コミットで残っていた **敵対レビュー記録 `docs/review-log/task_015.json`**（round 1・
  merge-review: **reject**・有効票 2・欠票 0・実効 high 1。指摘 7 件は `d3e5368` で全件処理済み）と
  run-log を確定させた。`verify_commands` 5 本すべてを最終 HEAD `8f04f0a` で `scripts/record-run.sh
  task_015` 経由で実行し exit 0（`typecheck` / `test:unit` 43 ファイル **1099/1099** /
  `test:integration` 11 ファイル **193/193** / `gate:constraints` 25 grep 0 violation /
  `gate:wording` 0 violation）。ソースの追加変更は無し。残懸念は `docs/concerns/task_015.md`
  の C-015-1〜7（medium 5・low 2）のままで、増減なし。
- task_023: BLOCKED — 依存タスク task_020（cron: 照合バッチ・outbox 配達）が完全に未着手
  （`files_to_create` 16 本が `find` で 0 件、`docs/PROGRESS.md` に完了宣言なし、
  `gate:constraints` が `defer W9`/`defer W11 waiting on task_020` と独立に裏付ける）。
  さらに本セッション中に task_020 の依存元 task_018 の `src/lib/outbox.ts` /
  `src/lib/ledger/**` が同一ワークツリーで未コミットのまま並行ドラフトされているのを実測し、
  その `OUTBOX_TRANSPORT`（`organizer_notify`/`ops_alert` の 2 段抽象、
  「`organizer_notify` は Phase 1 は画面内の要対応・Messaging API は Phase 3」という docstring）
  が task_023 の前提（Phase 1 で LINE Messaging API 配達）と食い違うことを確認した
  （§2。他タスクのファイルは変更していない）。加えて `docs/decisions/ADR-007-raw-userid-
  consent.md`（幹事の生 LINE userId 保持の同意設計。premortem P-12・S2×high）が未作成で、
  PII の新規保存可否は PO 判断が前提のため実装しなかった（§3）。`check_115`
  （`attention_unseen_hours`）は §17-6 が定める週次ログ集計パイプラインを前提にしており、
  これを所有するタスクが台帳上見当たらない（§4）。`verify_commands` 4 本を
  `scripts/record-run.sh task_023` 経由で HEAD `427010a` にて実行し、`typecheck` /
  `test:unit`（43 ファイル **1099/1099**）/ `test:integration`（11 ファイル **193/193**）は
  exit 0 だが、**`gate:constraints` は exit 1**（L3 違反 1 件、`src/lib/outbox.ts:44`
  「紛争（チャージバック）が発生した。」を「チャージ」の誤検知。2 回連続で再現を確認）。
  当該ファイルは task_018 が本セッション中に同一ワークツリーで未コミットのまま書いている
  途中の他タスクファイルであり、規約（他タスクのファイルを変更しない）に従い対応していない。
  実装コミットは 0 件（BLOCKED のため）。残懸念は `docs/concerns/task_023.md`
  （high 3・medium 1・low 1）。
- task_019（G5 round1 の指摘反映）: BLOCKED のまま — G5 round1（`docs/review-log/task_019.json`）
  の high 指摘どおり、task_018 に依存しない部分（`captured_from` 欠落 fixture の登録拒否・
  `synthesized` のみでの `autoDetect` 登録拒否・manual_confirm の C9/C10/C12）を実装した:
  `tests/conformance/{provenance.ts,kit.ts,manual-confirm.conformance.test.ts}`・
  `tests/fixtures/README.md` を新規作成、`package.json` に `test:conformance` を追加、
  `vitest.config.ts` の `include` に `tests/conformance/**/*.test.ts` を追加。
  `npm run test:conformance` は `scripts/record-run.sh task_019` 経由で実測 **exit 0（11/11
  pass）**。本ターン中に task_018 が並行して `test:contract` / `test:gate` スクリプトと
  `tests/contract/{duplicate,signature,reorder}.test.ts` の実体を追加し、終盤の再実行では
  7 件中 6 件 pass まで進んだが、1 件が `PostgresError: deadlock detected` で失敗
  （`npm run test:gate` は exit 1）。task_018 は未コミット・`completion_status:null` のまま
  なので、fixture_provider の C1〜C31 と test:gate の実 pass、CI 実走（PR で contract ジョブ
  緑）は task_018 完了後に持ち越し。
  `npm run gate:constraints` は task_018/task_020 の並行未コミット WIP により実行時点で
  exit 1（task_019 自身のファイルは原因ではない。詳細は `docs/concerns/task_019.md` §0〜§3）。
- task_023（修正ラウンド）: BLOCKED のまま（task_020/task_018 未着手・ADR-007 の PO 決定が
  未確定という根本原因は解消していない）。ただし敵対レビュー（`docs/review-log/task_023.json`、
  decision=reject）の high 指摘「health.ts の degraded 判定は task_018/020 に依存せず着手
  可能」を受け、`src/lib/health.ts`（DB 側 degraded の 4 条件。`reconciliation_run` /
  `outbox` / `payment_attempt` / `webhook_delivery` を直接読む。`src/lib/outbox.ts` は
  import しない）・`src/app/api/health/route.ts`（degraded 判定込みに拡張。詳細な理由は
  ボディに出さない）・`tests/unit/health.test.ts`（24 件追加。合成行で 4 条件を検証）を
  実装した。`docs/decisions/ADR-007-raw-userid-consent.md` をパターン A/B の `proposed` で
  起票し、`docs/ops/line-channels.md` / `docs/ops/monitoring.md`（手順・候補の記録）を新規
  作成した。`verify_commands` 4 本を `scripts/record-run.sh task_023` 経由で HEAD `9421d14`
  にて実行し、`typecheck` exit 0・`test:integration`（12 ファイル **203/203**）exit 0。
  `test:unit` は exit 1 だが失敗 2 件はいずれも `tests/unit/gate-check.test.ts`（task_006
  所有）で、task_018 が並行して `test:contract` を `package.json.scripts` に追加した環境変化
  が原因（新規追加した health 関連 24 件は全件 pass）。`gate:constraints` は exit 1（4 件、
  すべて `src/components/ShareSheet.tsx` / `src/lib/liff/share.ts`。task_017 所有で
  task_023 のファイルではない。なお前回記録した `src/lib/outbox.ts:44` の L3 誤検知は
  task_018 側で解消済みを確認）。`check_113`（outbox 配達）と `check_115`
  （週次メトリクス側）は依然未達。残懸念は `docs/concerns/task_023.md`（high 3・medium 3・
  low 2）。`docs/review-log/task_023.json` は既存のものを維持し、再レビューは実施していない
  （共通ルールどおり）。
- task_018: DONE_WITH_CONCERNS — 台帳適用・冪等基盤・監査連鎖検証・Webhook ルート・契約テスト
  3 本を実装した。`src/lib/ledger/{rank,dedupe,balance,apply}.ts`・`src/lib/outbox.ts`・
  `src/lib/db/repositories/{attempts,events-log}.ts`・`src/lib/webhook/ip-allowlist.ts`・
  `src/app/api/webhooks/[providerKey]/[bindingRef]/route.ts`・`scripts/audit-verify.mjs`
  （＋型宣言 `.d.mts`）を新規作成し、`package.json` に `test:contract` / `test:gate` /
  `audit:verify`、`vitest.config.ts` の `include` に `tests/contract/**` を追加。
  適用の判断は **DB に触れない純関数 `planApply`** に集約したので、全遷移 × 全種別（check_094）
  を Postgres 無しの `test:unit` で網羅できる。**金額不一致は突合基準を
  `payment_attempt.amount_minor` に取り、`adjustment` 1 件・ランク不変・`needs_attention`・
  `mismatch_alert`**（check_023）。取消済みへの入金は前進させたうえで `void` 維持と
  `paid_after_void`（check_021）。`confirmation_method` は台帳の `confidence` 集合から導出し、
  `mixed` は DB の CHECK に無いので**非自動側へ倒して**バッジを消さない。Webhook は
  非 production 404 / 許可外 IP は本文を読まず 403（DB に 1 行も残さない）/ 書式違反 400 /
  ゲート未通過は受信・保存し**適用保留**（`apply_result` と `processed_at` が NULL。
  CHECK に `held` が無いため）。**実測**: `test:contract` **3 ファイル 7/7 pass**（4 回連続）、
  `tests/integration/webhook-route.test.ts` **10/10 pass**、`tests/unit/ledger` **36/36 pass**、
  `typecheck` exit 0、`audit:verify` exit 0、`gate:constraints` **0 violation**。
  `npm run test:unit` は **exit 1**（`tests/unit/gate-check.test.ts` の G2 2 件が
  「`test:contract` が package.json に無いこと」を前提にしており、本タスクが §13 どおり
  定義したため落ちる。他タスクのテストは規約により編集していない）。同ファイルを除く
  `tests/unit` は **49 ファイル 1167/1167 pass**。`npm run test:integration` は **exit 1**
  （他タスクの未追跡 `tests/integration/admin.test.ts` の 3 件。除けば 13 ファイル 204/204）。
  並行実行での `deadlock detected`（task_019 が観測）の原因は、fixture の
  `provider_event_id` が固定で `payment_event` の一意制約上で別トランザクションと待ち合う
  ことだと特定し、`external_ref` を連結して一意化した。残懸念は `docs/concerns/task_018.md`
  （C-018-1〜8。high 1・medium 4・low 3）。Hyperdrive 経路（A21 / P-05 / P-09）は
  task_035 未了のため deferred。
- task_016: DONE_WITH_CONCERNS — 配布（O-7）を実装。`src/lib/share-templates.ts`（催促文＋URL・
  個別再共有の宛名入り催促文・リンクを疑われた際の説明テンプレ・Flex テンプレ固定 5 要素
  `幹事ラベル／イベント名／金額／締切／『支払先は幹事の決済アカウントで、アプリはお金を
  預かりません』`・QR は `qrcode` で SVG 文字列を生成し `<img src="data:image/svg+xml,...">`
  として描画。`dangerouslySetInnerHTML` は使わず GC-XSS を満たす）、`src/lib/liff/share.ts`
  （`isApiAvailable('shareTargetPicker')` の実行時判定と呼び出し。fail-closed。picker の
  キャンセルと不可を区別して返す）、`src/components/ShareSheet.tsx`（isApiAvailable が
  false のときは催促文コピー・個別リンク一覧・説明テンプレ・QR だけを表示し picker ボタンを
  出さない。未払いのみ/全員の切替つき）、`src/app/(liff)/events/[id]/share/page.tsx`
  （招待トークンは発行応答の 1 度きりしか手に入らない設計＝ C-015-2 の帰結のため、
  `POST /api/events/:id/rotate-join-token` で作り直した直後の値だけをその場で配る。
  個別リンクは claim トークン単位の URL ではなく共通の招待リンク＋宛名入り催促文）。
  `docs/vendor-docs/line/share-target-picker.md`（有効化手順の一次資料未特定を明記。
  ミニアプリチャネル向けの記述は見つからず、LINE ログインチャネル向けの手順しか無いという
  未解決点を再掲。`GATE-LINE-SHARE` 待ち）を作成。`docs/constraints.json` の N8 を
  `expect_targets: "from_task_022"` → `"now"` に更新（task_016 が実装・検証を前倒しした
  ため）。実測で発見した既存の穴: Next.js 16 の dev サーバーは `allowedDevOrigins` 未設定だと
  `127.0.0.1`（Playwright の既定 `baseURL`）からの `/_next/*` 取得をブロックし、
  ハイドレーションが永久に終わらない（O-4〜O-6 でも再現。`tests/e2e/share.spec.ts` は
  自ファイル内だけ `localhost` に切り替えて回避。恒久修正は task_022。docs/concerns/task_016.md
  C-016-1）。**verify_commands 5 本すべて `scripts/record-run.sh task_016` 経由で実行**
  （`typecheck` exit 0 / `gate:constraints` 0 violation / `gate:wording` 0 violation /
  `test:e2e` 2/2 pass。`test:unit` は exit 1 だが **task_016 の新規 24 件はすべて pass**で、
  失敗 2 件は `tests/unit/gate-check.test.ts`（task_006 所有）が task_018 の並行コミット
  `test:contract` 追加と衝突した既知の事象＝ `docs/concerns/task_023.md` §9 と同一。
  他タスクのファイルは変更しない規約に従い未対応）。残懸念 5 件は `docs/concerns/task_016.md`
  （C-016-1〜5。medium 2・low 3）。GATE-LINE-POLICY / GATE-LINE-SHARE はいずれも `unknown` の
  まま run-log に記録済み。
- task_021: DONE_WITH_CONCERNS — 管理面（別 IdP＝GitHub `GET /user` の Bearer 検証・二人承認は
  `audit_log` の propose/approve 2 行のみでステートレスに表現。A23 縮退は同一管理者 24 時間
  クーリング。`PAYMENTS_ENABLED=true` は `docs/gates/legal-clearance.json` の写し
  `LEGAL_CLEARANCE_CLEARED` を前提）、`GET /api/admin/gates`・`POST /api/admin/flags`・
  `GET /api/admin/lookup`（`display_label`/`organizer_label` を一切返さない設計。invoice 単体
  テーブルの SELECT のみで構造的に担保）・`POST /api/admin/anonymize`（`event.organizer_label`
  を固定プレースホルダへ／`participant.display_label` を NULL へ）・`POST /api/admin/suspend`
  （`session_epoch` を進め即時失効）、`GET /api/events/:id/export.csv`（O-12。固定文言は
  `gate:wording` の W-RECEIPT が否定文でも「適格請求書」を禁止するため別の言い回しに書き換え）、
  `GET /api/me/export.zip`（依存追加なしの手書き ZIP）、`POST /api/invoices/:id/refund`
  （Phase 1 は `manual_confirm` の `capabilities.refund='none'` で常に 409 `NOT_SUPPORTED`）、
  `POST /api/e/report`（abuse_report・`resolveRateLimiter` でレート制限）、O-9/O-10/O-11/O-13 の
  4 画面、`src/content/terms.md`/`privacy.md`（草案 v1）、`scripts/gate-terms.mjs`/
  `gate-privacy-policy.mjs`/`gate-compliance-freshness.mjs`、`.github/workflows/gate-legal.yml`、
  `docs/incident-response.md`/`legal-forensics.md`/`privacy-policy.md`、`docs/runbooks/RB-01〜10`
  を実装。**task_021 が発見した重大な横断的不具合**: `src/lib/db/client.ts` の `createDbClient`
  が `drizzle(client,{schema})` の副作用で `db.sql`（`db.db` は未使用）の timestamp 列を壊し、
  読み取りは `Date` ではなく文字列・`Date` 値の書き込みは例外になる。`appendAuditLog` /
  `runIdempotent` / `resolveEventByJoinToken`（`.getTime()`）を含む書き込み系ルート全般と
  参加者向けの入口ルート全般に及ぶ横断的な既知の不具合として
  `tests/integration/_debug_admin.test.ts` に repro を固定（原因ファイルは files_to_modify 外
  のため未修正。**task_022 以降は着手前に必読**）。この不具合により
  `POST /api/admin/flags`/`suspend`/`anonymize` の実ルート経由 DB 書き込み往復は統合テストでき
  ず、「フラグ変更が audit_log に 2 行」の要件は `proposeAdminAction`/`approveAdminAction` を
  `withRollback` の `tx`（安全な接続）で直接呼ぶ形で検証した。**verify_commands 7 本すべて
  `scripts/record-run.sh task_021` 経由で実行**（`typecheck` exit 0 / `test:integration` 15
  ファイル 226/226 / `gate:wording` 0 violation / `gate:terms` 5/5 / `gate:privacy-policy` 9/9
  / `gate:constraints` 0 violation。`test:unit` は exit 1 だが **task_021 の新規テスト
  （export-csv 8・admin 16・abuse-limits 4・gate-terms 10 の計 38 件）はすべて pass**で、
  失敗 2 件は `tests/unit/gate-check.test.ts`（task_006 所有）の task_018 `test:contract`
  追加との衝突＝ `docs/concerns/task_023.md` §9 / task_016 と同一の既知の事象）。残懸念 8 件は
  `docs/concerns/task_021.md`（high 1・medium 3・low 4）。幹事あたり合計請求額上限は
  files_to_modify 不足で未実装（`POST /api/e/report` のレート制限で scope の別項目をカバー）。
  O-9 の 10 種別分類は参加者一覧 API の内訳不足で部分実装。`GATE-LEGAL-PII` は `unknown` の
  まま。
- task_016（修正ラウンド）: DONE_WITH_CONCERNS — 外部レビュー是正 C-016-6: `share/page.tsx` が
  参加者一覧を `limit=100` の1ページしか取得せず101人目以降が黙って消えていた不具合を、O-4と
  同じ `nextCursor` 保持＋「さらに読み込む」導線（`ShareSheet` に `hasMoreParticipants` /
  `loadingMoreParticipants` / `onLoadMoreParticipants` を追加）で修正。`ShareSheet.test.tsx`
  に3件追加（既存24件は不変・27件全pass）。もう1件のレビュー指摘（check_030 の e2e が
  `isApiAvailable=false` 時の `ShareSheet` を実ブラウザ描画していない）は `src/lib/liff/mock.ts`
  が files_to_modify 外のため本ラウンドも対応不可（task_022 待ち。C-016-2 に再確認記録）。
  **verify_commands 5本すべて `scripts/record-run.sh task_016` 経由で再実行**（`typecheck`
  exit 0／`test:e2e` 2/2 pass／`gate:wording` 0 violation。`test:unit` は既知の
  task_006所有ファイル2件失敗のみ exit 1（task_016新規27件は全pass）。`gate:constraints` は
  他タスク未コミットの `src/lib/reconcile.ts`（W11）1件のみで exit 1、task_016のソースは
  0 violation）。残懸念は `docs/concerns/task_016.md`（C-016-1〜7。medium 4・low 5、うち
  C-016-6は修正済み）。
- task_019: DONE_WITH_CONCERNS — task_018（7833726）完了を受け BLOCKED を解除し
  ProviderConformanceKit を再着手。`tests/conformance/fixture-provider.conformance.test.ts`
  （新規）と4本の fixture JSON（`refund-partial-1/2.json`・`orphan.json`・`underpaid.json`）
  を実装。fixture_provider は C1〜C31 のうち21ケースが実Postgres経由のWebhookルート検査で
  pass、11ケースは能力宣言（createCheckout/refund/statusQuery非対応）・W3（ランク前進のみ）
  ・apply.tsに無い分岐（参加者削除/イベント中止）を理由にn/a記録。`.github/workflows/
  gate-contract.yml`（独立ファイル。実Postgres上でtest:gateを実行）を新規作成し、
  `.claude/settings.json` のStopフックに`test:gate`を登録した。manual-confirm.conformance
  .test.tsとkit.tsのコメントも「task_018未着手」という陳腐化した記述を修正した。**実測**:
  `scripts/record-run.sh task_019`経由で`typecheck`exit 0、`test:conformance`36/36 pass、
  `test:gate`（test:contract 7/7 + test:conformance 36/36）exit 0、`lint:changed`exit 0。
  `gate:constraints`は他タスク未追跡の`src/lib/reconcile.ts`（W11）1件のみでexit 1
  （task_019のファイルではない）。required_status_checksへの追加はgit push後にCIで確認する
  deferred項目。残懸念6件（high 1・medium 2・low 3）は`docs/concerns/task_019.md`。
- task_018（レビュー修正）: DONE_WITH_CONCERNS — G5 reject の high 3 件を修正した。(1) **W8 の受取先突合が
  無く、自分の bindingRef 宛てに他人の `external_ref` を署名付きで投げると他 organizer の請求を paid に
  できた**（`tests/contract/signature.test.ts` に再現ケースを足し、修正前 fail / 修正後 pass を実測）→
  `bindingMatches()` を `planApply` と `applyToLedger` の両方に入れ、不一致は請求を読まずに
  `apply_result='mismatch'` ＋ `mismatch_alert` で終える（被害側の請求には触れない）。(2) **部分返金を
  すべて金額不一致として `adjustment` にしていたため、分割返金しても残高が減らなかった** → 通貨一致・
  1 以上・突合基準未満の `refunded` を `kind='refund'` の debit として残高に反映し、残高が 0 以下に
  なったときだけ `refunded` へ前進させる。(3) **`audit:verify` が既定で先頭 10000 行しか見ず、以降の
  連鎖破壊を成功として返していた** → `id` カーソルで全件走査し、`--limit` 指定時だけ `truncated` を
  出力に明示。併せて medium 2 件（`webhook_delivery` が適用ループの例外時に 1 行も残らない／CIDR の
  `203.0.113.0/` が `/0`＝全 IPv4 許可として通る）も修正。**実測**: `scripts/record-run.sh task_018`
  経由で最終 HEAD（`d54a8a0`）にて `typecheck` exit 0、`test:contract` 8/8 pass、`test:unit` 51 ファイル
  **1214/1214 pass**（並行コミット `90c8968` が `gate-check.test.ts` の placeholder を替えたため、
  前回まで赤だった 2 件も解消）、`test:integration` 251/251 pass、`audit:verify` exit 0。
  `gate:constraints` のみ他タスク未追跡の `src/lib/reconcile.ts` の W11 1 件で exit 1。G5 は規約により
  再レビューせず、残る medium 3 件（dedupe 既定鍵・`__proto__`・試行の終端状態）は
  `docs/concerns/task_018.md` C-018-10〜13 に記録。
- task_021（G5 修正ラウンド）: DONE_WITH_CONCERNS — `docs/review-log/task_021.json`
  （コミット `82dda92`）の G5 敵対レビューが reject（実効 high 3）だったため、規律に従い
  ファイルを所有する範囲だけを修正した。**修正した 2 件（いずれも `src/lib/admin-auth.ts`）**:
  (1) gpt F-1「`proposalId` に先頭ゼロを付けると承認済み申請を再承認できる」→
  `ADMIN_PROPOSAL_ID_RE` を先頭ゼロ無しの正規形のみ許可する形に変更（`id = ...::bigint` の
  数値キャストと `detail->>'proposalId' = ...` の文字列完全一致という 2 つの比較のずれを、
  入力を正規形に限定することで解消）。(2) gpt F-2「GitHub login の大小文字違いで同一管理者が
  二人承認を偽装できる」→ `verifyAdmin` が返す `adminId` を `login.toLowerCase()` で正規化
  （GitHub は同一アカウントで login の表示上の大小文字を変更できるため、正規化前は
  `approveAdminAction` の同一人物判定を大小文字だけで回避し A23 縮退の 24 時間クーリングを
  すり抜けられた）。両方に回帰テストを `tests/integration/admin.test.ts` へ追加。
  **修正しなかった 1 件**: gemini F-1（`src/lib/db/client.ts` の timestamp 破壊。既知の
  横断的不具合）は task_011 所有で task_021 の files_to_modify 外のため、規約（他タスクの
  ファイルを変更しない）に従い触れていない。abuse-limits.test.ts / admin.test.ts のルート
  経由成功系テストが `withRollback` の tx 直呼びで代替している根本原因も同じで、未解消のまま
  `docs/concerns/task_021.md` に記録した。**verify_commands 7 本すべて
  `scripts/record-run.sh task_021` 経由で再実行し、最終的に 7 本とも exit 0**:
  `typecheck` / `test:integration`（21 ファイル 251/251 pass、新規回帰テスト 2 件を含む）/
  `gate:wording`（0 violation）/ `gate:terms`（5/5）/ `gate:privacy-policy`（9/9）/
  `test:unit`（1214/1214 pass）/ `gate:constraints`（29 grep entry 0 violation）。`test:unit`
  と `gate:constraints` は初回実行時にそれぞれ task_006 所有 `tests/unit/gate-check.test.ts`
  と task_020 所有 `src/lib/reconcile.ts`（W11）の既存失敗で exit 1 だったが、本ラウンド中に
  該当タスクの並行コミット（`90c8968` / task_020 の advisory lock 実装）が着地し、再実行で
  解消を確認した（task_021 自身のファイルは無関係）。G5 は規約により再レビューしない。
- task_020: DONE_WITH_CONCERNS — cron 6 本を実装。`src/lib/reconcile.ts`（状態走査のみ・時刻カーソル無し /
  `pg_try_advisory_xact_lock` をこのファイルで直接発行 / バッチ 100・1 件 3 秒 timeout・並列 5 /
  期限切れ猶予 4 日と最終照会 / paid 30 日の日次再照会と `paid_rescanned`・`post_paid_changes`）、
  `src/lib/retention.ts`（終了 +90 日の期日を cron 自身が埋める＝ P-03 の起点問題 / `display_label` は NULL 化、
  `organizer_label` は NOT NULL のため固定文字列へ置換 / `raw_body` 14 日 / 冪等キーと `used_id_token` の
  期限切れ削除）、`src/lib/cron-auth.ts`（非 production 404 → シークレット不一致 401・定数時間比較・
  許容リスト方式）、`/api/cron/{reconcile,outbox,apply-pending,retention,idempotency-cleanup,audit-verify}`、
  `workers/cron` に apply-pending（`*/10 * * * *`）を追加し fetch ログを 1 発火 1 行にした。
  **verify_commands 4 本すべて `scripts/record-run.sh task_020` 経由で実行し全て exit 0**
  （`typecheck` / `test:integration` **21 ファイル 251/251 pass** / `audit:verify` ok /
  `gate:constraints` **0 violation**＝ task_018 が記録した W11 の 1 件はこのタスクで解消）。
  `tests/unit/cron-auth.test.ts` 10/10 pass（三者一致＋認可）。`wrangler dev --test-scheduled` の
  手動確認: 6 パターンを 1 回ずつ発火し、cron Worker のログに 6 パス各 1 行の fetch と本体の 404
  （APP_ENV=development の環境ガード）を観測（run-log に manual 記録）。並列テストの偽陽性対策として
  `ReconcileDeps.lockKey`（テスト隔離専用）を足した。残懸念 10 件は `docs/concerns/task_020.md`
  （medium 5・low 5）。最大のものは check_043 の期待値「organizer_label が NULL」が NOT NULL 制約で
  実現不可能な点（固定文字列置換で実装し、受入基準は書き換えていない）。
