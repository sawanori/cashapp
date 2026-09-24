# HANDOFF

## task_002（外部照会文の起案・ADR-010）

### 決まったこと

- 弁護士照会は Q-LG1（為替取引該当性）を単独先行（`docs/inquiries/lawyer-q-lg1.md`）とし、否定回答時の分岐を検討する Q-LG1-B（第3号ニの提携先候補・株式会社化の要否・`manual_confirm` の該当可否）を同便に含めた。残り14問（Q-LG2〜Q-LG16）は別便（`docs/inquiries/lawyer.md`）。
- Q-LG11（非弁該当性・催促）、Q-LG12〜LG15（クラウド例外・同意前情報・漏えい報告期限・保持期間根拠）、LINE の Q-LN7（`shareTargetPicker` 可否）、PayPay の Q-PP9〜Q-PP12（クレデンシャル預託・紛争通知・IPレンジ・Webhook URL変更）、PAY.JP の Q-PJ1〜Q-PJ7 全問は `docs/research/consolidated.md` §5 の一次質問リストに原文が無く、`docs/implementation-plan.md` §18-1 の要約行と `docs/research/premortem-risks.md`（R-LAW-02/04/05/07/08/11/15、R-PAY-07、R-SEC-11、R-LINE-06）の対応策文言から本タスクで新規に文章化した。各ファイル末尾の「確信度・レビュー状態」に明記済み。
- `docs/research/consolidated.md` §5-3 項目7（LINE 2026-10-14 ポリシー改定の影響）は `docs/implementation-plan.md` §18-1 の確定質問リストに引き継がれていないため、`line.md` からは除外した（`implementation-plan.md` を正本とする運用ルールに従う）。
- PAY.JP・Stripe には `docs/gates/compliance-gates.json` に固有の `gate_key` が定義されていない。`external-inquiries.json` の `payjp` / `stripe` エントリは `gate_keys: []` とした（同ファイルの変更は PO 専管のため本タスクでは追加していない）。
- ADR-010 は3分岐（第3号ニ提携／自社登録／`manual_confirm` 縮退継続）を列挙するのみで、いずれを採用するかは Q-LG1-B の回答後に PO が判断する前提で `proposed` のまま起票した。
- `docs/implementation-plan.md` §18-2 に「LINE 未回答なら (web) 経路で先行パイロット」という例示があるが、同 §18-4 項目15「(web) ルートグループは Phase 1 では退避先にならない（ADR-013）」と矛盾するため、`external-inquiries.json` の `line` エントリの `default_decision_on_timeout` では後者（より具体的で ADR-013 に裏付けられた制約）を優先し、(web) 退避を明示的に対象外とした。

### 未解決 / concerns

- 依存タスク task_001（G0-USER 同意・ADR-001）が本タスク作業時点で未完了と観測した。`docs/task-list.json` の task_001 `completion_status` は `null`、`docs/decisions/` に ADR-001 ファイルは存在せず、`docs/run-log/task_001.json` も存在しない（`docs/run-log/` には `task_036.json` のみ）。task_002 の成果物自体（照会文起案・ADR-010起票）は ADR-001 の内容に依存しない設計のため実施したが、task_037（送付）に進む前に task_001 の完了確認が必要。
- `docs/implementation-plan.md` §18-2 と §18-4 項目15 の矛盾（上記「決まったこと」参照）は本タスクの起案文書内では回避したが、`implementation-plan.md` 本文自体の修正は本タスクのスコープ外（files_to_modify に含まれない）。別タスクでの修正を推奨。
- ADR-010 の3分岐（提携先候補のリードタイム、運営者自身の登録要件〔NonTurn LLC が合同会社であることの影響〕）はいずれも一次資料未検証（`[不明]`）。Q-LG1-B の回答が来るまで着手しない。

### 次のアクション

- task_037（PO）: 6通の照会文を PO レビュー後に送付し、`external-inquiries.json` の `status` を `sent` に更新して `sent_at` / `no_response_deadline`（+21日）を記入する。

## task_003（プロジェクト初期化・ハーネス基盤）

### 決まったこと

- `/Users/noritakasawada/AI_P/cashapp` を `git init` で独立リポジトリ化（ホーム直下のリポジトリは未変更。`git -C /Users/noritakasawada/AI_P/cashapp rev-parse --show-toplevel` が `cashapp` を返すことを実測確認）。
- `scripts/record-run.sh`（`<task_id> <command...>` または `--manual <task_id> "<観察>"`。`docs/run-log/<task_id>.json` へ配列追記。`jq`/`git`/`date` のみ依存、タスクIDごとの mkdir 排他ロックあり）と `scripts/with-lock.sh`（`<name> <command...>`。`.locks/<name>` の mkdir 排他、最大30分待ち）を実装し、いずれも実行して正しく動くことを確認済み。
- npm プロジェクト初期化: Next.js 16.3.6（App Router / TypeScript / `src/` / `@/*` alias）、`engines.node >=22`、`.npmrc` に `ignore-scripts=true` / `save-exact=true` / `engine-strict=true`。`package.json` の scripts はすべて `npm pkg set` 経由で追加（typecheck/lint/lint:changed/build/build:cf/cf:dev/test:unit/test:e2e/test:security/test:a11y）。
- 依頼された依存を完全固定バージョンで一括インストール（詳細は `docs/decisions/ADR-002-stack-versions.md`）。**依頼リストからの3件の逸脱**: (1) `eslint` は依頼の `10.11.0` ではなく `9.39.5` — `eslint-config-next@16.3.6` 同梱の `eslint-plugin-react@7.37.5` が ESLint 10 で削除された `context.getFilename()` を呼び出しクラッシュすることを実測、ESLint 9系に固定して解消。(2) `jsdom` は依頼の `30.1.1` ではなく `29.1.1` — `30.1.1` の `engines.node` が `^22.22.2` 等を要求し本機の `v22.22.0` を満たさず `EBADENGINE` で失敗するため。(3) `server-only@0.0.1` を追加インストール — `import "server-only"` に必須の npm パッケージで、依頼リストに含まれていなかった。
- Cloudflare Workers 一次資料（Hyperdrive ローカル接続・OpenNext の wrangler.toml 必須構成・Worker サイズ上限・Cron Triggers 上限・Smart Placement）を WebFetch で取得し `docs/vendor-docs/cloudflare/{hyperdrive,opennext}.md` に取得日（2026-09-24）付きで退避（**注: `context7` MCP はこのセッションでは接続断〈CONNECTION_CLOSED〉のため、CLAUDE.md の「ライブラリドキュメントはまず context7」ルールに従えず、WebFetch＋npm レジストリの実測メタデータで代替した**）。
- `wrangler.toml`（メインアプリ Worker）と `workers/cron/wrangler.toml`（Cron Triggers 専用 Worker）・`workers/cron/index.ts` を作成。`compatibility_date="2026-09-24"`、`compatibility_flags=["nodejs_compat","global_fetch_strictly_public"]`、`[[hyperdrive]]` はプレースホルダ ID（task_035 で実 ID に置換）、`[placement] mode="smart"`、`[limits] cpu_ms=50000`（既定30,000msからの暫定引き上げ）。`env.staging` / `env.production` でバインディング分離（R-SEC-05）。
- **スパイク実測結果**（`ADR-012-hosting-cloudflare.md` に詳細）: `npm run build:cf` → `wrangler dev` で ① `GET /api/health` = 200 成立、② `request.text()` のバイト等価性（SHA-256一致）と `import "server-only"` のビルド時ブロック（`next build` exit 1）成立、③ middleware が `/`・API・404 すべてに適用される成立、④ 同じ仕組み（middleware）は `/_next/static/**` の静的アセット（ASSETS バインディング経由）には適用されない**部分成立**（task_012 での「共通ラッパ代替」再評価が必要、当初計画の想定どおりの分岐）。
- Worker の実バンドルサイズ（A25）は `wrangler deploy` / `wrangler versions upload` が本タスクの禁止コマンドのため未実測。`scripts/ci/record-worker-size.mjs` で代替の上限見積り（`.open-next/` の `assets/` 除く生合計サイズ）を `build:cf` のたびに出力し `run-log` に残す方式にした。今回の値: 19.41 MiB（64 MiB 上限の 30.3%）。
- `npm run typecheck` / `lint` / `build` / `test:unit` / `build:cf` をすべて `scripts/record-run.sh task_003 <cmd>` 経由で実行し、5件とも exit 0（`docs/run-log/task_003.json`）。`npm audit --audit-level=high` は exit 0（moderate 4件のみ、`drizzle-kit` の開発時依存 `esbuild` 経由、high/critical は0件）。`npm ls --all --parseable | grep -Ei 'paypay|payjp|stripe'` は0件（check_038）。

### 未解決 / concerns

- **[severity: medium] A21 未解決** — Hyperdrive 経由で Workers から Supabase Postgres に接続したときの `pg_try_advisory_xact_lock` 等の挙動は、実 Supabase プロジェクトが存在しない（task_003 の non_scope）ため未実測。対応案: task_011/035 で `supabase start` 後に実測すること。`wrangler.toml` の `localConnectionString` は `supabase start` の既定値（`postgres://postgres:postgres@127.0.0.1:54322/postgres`）をプレースホルダとして置いてある。
- **[severity: low] A25 は見積り値のみ** — 真の Worker バンドルサイズ（wrangler の esbuild バンドル後）は、禁止コマンド（`wrangler deploy`/`versions upload`）のため測っていない。対応案: task_035 以降、staging への実デプロイ時に真値を確認し、本 concern を解消すること。現在の見積り（19.41 MiB / 30.3%）には十分な余裕があり、緊急性は低いと判断。
- **[severity: low] スパイク④が部分成立** — middleware 経由のヘッダ付与は静的アセットに届かない。対応案: task_012 でヘッダ付与の実装方式（Cloudflare 側の Transform Rules、または `next.config.ts` の `headers()` を静的アセットにも効かせる代替）を再評価すること。当初計画（implementation-plan.md）が想定していた分岐そのものであり、新規発見のリスクではない。
- **[severity: low] eslint / jsdom のバージョンが依頼と異なる** — 上記「決まったこと」参照。いずれも実測に基づく已むを得ない変更であり ADR-002 に理由を記録済み。
- **[severity: low] context7 MCP 接続断** — CLAUDE.md の「ライブラリドキュメントはまず context7」ルールに本タスクでは従えなかった（セッション開始時から `CONNECTION_CLOSED`）。WebFetch と npm レジストリの実測メタデータで代替し、一次資料として `docs/vendor-docs/cloudflare/` に退避した。対応案: 次回以降のセッションで context7 の接続状況を確認すること。
- `test:e2e` / `test:a11y`（Playwright）は本タスクの `verify_commands` に含まれておらず未実行。`@playwright/test` のブラウザバイナリも `ignore-scripts=true` によりダウンロードされていない（`npx playwright install` は未実施）。task_022（実体追加）または先行して実行する場合はブラウザインストールが別途必要。
- 他タスク（task_002, task_036）が本タスクと並行して同一リポジトリに直接 `git commit` している（`git log` で確認済み）。ファイル範囲は衝突していない（各コミットの `git show --stat` で確認済み）が、`scripts/with-lock.sh git` 経由だったかは commit 自体からは確認できない。

### 次のアクション

- task_004以降: `scripts/with-lock.sh` / `scripts/record-run.sh` を前提に進めてよい。`.locks/` は `.gitignore` 済み。
- task_011/035: A21（Hyperdrive 経由の実 Postgres 接続）の実測。
- task_012: スパイク④（静的アセットへのセキュリティヘッダ付与）の代替方式の設計。
- task_022: `tests/e2e/smoke.spec.ts` / `tests/a11y/smoke.spec.ts` / `tests/security/smoke.test.ts` を実体に差し替え。Playwright ブラウザインストール手順もここで確立すること。

## task_004（制約・禁止語の機械可読化と grep ゲート）

### 決まったこと

- `docs/constraints.json` は 2 本の配列を持つ。`constraints`（**54 件**: `consolidated.md` §6 の 51 件 ＋ `implementation-plan.md` §7-8 の横断 3 件 X-TIME / X-ID / X-MONEY）と `gate_only_checks`（**3 件**: GC-XSS / GC-ENV-PUBLIC / GC-SERVER-ONLY）。後者はプレモータム（R-SEC-12 / R-SEC-04）由来で §6 に番号を持たないため、54 件には数えない。gate-constraints.sh は両方を同じ規則で走査する。
- エントリのスキーマは `{ id, text, confidence, source, enforcement, match_mode, grep_patterns[], globs[], exclude_globs[], allow_if_line_matches[], expect_targets }`。タスク指定の必須フィールドに加えて 3 つ拡張した: `match_mode`（`forbid` / `require`。server-only 義務や Smart Placement のような「無ければ違反」を表現するのに必要）、`exclude_globs`（「providers/ の外で決済 SDK を import しない」P1 のように除外が本質の制約に必要）、`allow_if_line_matches`（W3 の「rank ガードと同一行なら正当」を表現するのに必要）。いずれも省略可で、既定は forbid / 空。
- `enforcement` は `grep`（21 件が機械検査）/ `test`（14 件。`verified_by` に検証コマンドを書いた）/ `manual`（19 件。grep で検出できないと明記）。**全 57 エントリに `expect_targets` がある**（`enforcement` が grep 以外でも「その制約が検証可能になる時点」の宣言として置いた。対象件数の強制は grep のみ）。
- `expect_targets` の DONE 判定は **`docs/task-list.json` の `completion_status`（DONE / DONE_WITH_CONCERNS）と `docs/run-log/<task_id>.json` の両方が揃ったときだけ DONE** とする（片方だけでは DONE にしない）。現時点で `completion_status` は全タスク `null` のため、`from_task_XXX` の 6 件（P2 / P9 / W4 / W9 / W11 / X-MONEY）はすべて「defer」として exit 0 で通る。
- **I1 / I2 は Cloudflare 版に読み替えて登録した**（ADR-012）。I1 = Supabase Tokyo ＋ `wrangler.toml` の `[placement] mode = "smart"`（require モード）、I2 = `workers/cron/wrangler.toml` の `[triggers]`（require モード）。Vercel 前提の原文は各エントリの `superseded.original_text` に取得理由つきで保持し、削除していない。
- glob は限定サブセット（`**/` / `**` / `*` / `?` / `{a,b}`）のみ対応。bash 3.2（macOS 標準）で動くよう globstar・mapfile・連想配列を使わず、`git ls-files -co --exclude-standard` をファイル集合の正本にした（`node_modules` / `.next` / `.open-next` を `.gitignore` 経由で自動的に除外できるため）。`--root` を渡すと非 git ディレクトリでも `find` で走る（テストが実物のゲートを一時ツリーに対して回すため）。
- `grep_patterns` は **POSIX 拡張正規表現**（`grep -E`）で書く規約にした。`\b` / `\s` / `\d` / 先読みは BSD grep（macOS）と GNU grep（CI）で挙動が割れるため使わない。`docs/wording-policy.md` の機械可読ブロックだけは JavaScript の `RegExp`（wording-lint.mjs が Node のため）。
- `docs/wording-policy.md` は人間向けの本文と機械可読ブロック（`<!-- machine-readable:begin -->` 〜 `<!-- machine-readable:end -->` の ```json フェンス）を同居させた。wording-lint.mjs はこのブロックだけを読む。禁止語は 6 群（W-AUTO / W-DONATION / W-SUPPORT / W-RECEIPT / W-MERCHANT-GUIDE / W-FEE-FIXED）。W-MERCHANT-GUIDE（記入例・審査の通し方）は配布テンプレとパイロット資料だけが対象なので `expect_targets: from_task_025`。
- 許可文言（`allowed_phrases`）は**行内の位置で免除する**実装にした。禁止語「自動照合」の一致が許可文言「自動照合ではありません」の範囲に収まっていれば違反として数えない。計画 §7-6 のバッジ文言「幹事が手動で確認（自動照合ではありません）」がそのまま書けることをテストで確認済み。
- 検査対象: `wording-lint.mjs` は `docs/research/**` と `docs/inquiries/**` を `global_exclude_globs` で明示的に除外する（一次資料と照会文は原文のまま保持する必要があるため）。`gate-constraints.sh` は `tests/gates/fixtures/**`（task_006 の違反フィクスチャ置き場）と両ゲート自身・そのテストを除外する。
- 両ゲートの終了コード規約を揃えた: `0` 合格 / `1` 違反または空振りゲート / `2` 設定・引数エラー。違反行の出力は指定どおり `<id> <file>:<line>`（後ろに ` | 一致語 | 行の抜粋` を付ける）。

### 未解決 / concerns

- **[severity: medium] `npm run typecheck` が現在 exit 2** — `src/lib/db/client.ts(192)` の 2 件（`await` の対象が promise でない / `bigint` を `ParameterOrFragment` に渡している）。これは task_011 が本タスクと並行編集中のファイルで、task_004 の成果物（`docs/**`・`scripts/**`・`tests/unit/gate-constraints.test.ts`・`tests/unit/wording-lint.test.ts`）とは無関係。本タスクの 4 ファイルだけを `npx eslint` / `npx tsc` にかけると 0 件。対応は task_011 の担当。
- **[severity: medium] `enforcement: manual` が 19 件ある** — L4 / L5 / L7 / L9 / L10 / L11 / P5 / P8 / N1 / N4 / N6 / N10 / N12 / I6 など。これらは grep で検出できない（構造の不在・規約文の十分性・外部手続の完了）ため、ゲートは通っても制約が守られている証拠にはならない。`verified_by` に確認手段を書いたが、実際の確認は各タスクのレビューと `docs/gates/*.json` に委ねている。
- **[severity: low] W3（rank ガード無しの `='paid'`）は行単位の近似** — `status = 'paid'` と `status_rank` が同一行にあれば正当とみなす。複数行に分かれた正当な更新は誤検知になりうる。その場合は `src/lib/ledger/apply.ts` / `rank.ts`（`exclude_globs` 済み）に寄せるのが正しい対処で、`allow_if_line_matches` を広げないこと。
- **[severity: low] X-ID はディレクトリ名を見ない** — Next.js の動的セグメント `src/app/.../[joinToken]/` のようなパス自体の検査は grep（内容検査）では届かない。内容側の参照（`[joinToken]` の型注釈・`${joinToken}` を含む URL 組み立て）だけを検出している。パス名の検査は task_006 の `gate-check.mjs`（G 系）で拾うこと。
- **[severity: low] `git add -A` を使わずファイル指定でコミットした** — 共通ルールは `git add -A` を指示しているが、コミット時点で task_011 の作業中ファイル（`src/lib/**`・`supabase/**`・`tests/integration/**`・`.env.example`・`scripts/gates-sync.mjs`）が未コミットで、しかも `typecheck` を落とす状態だった。他タスクの未完成物を巻き込まないため、task_004 の成果物のみをステージした。

### 次のアクション

- task_005: `.claude/settings.json` の PreToolUse / Stop から `npm run gate:constraints` と `npm run gate:wording` を呼べる（両方とも引数なしでリポジトリルートから実行する前提。終了コードは 0/1/2）。
- task_006: `tests/gates/fixtures/violations/**` に違反フィクスチャを置くとき、`docs/constraints.json` の `global_exclude_globs` に `tests/gates/fixtures/**` が入っているため通常のゲート実行では拾われない。メタゲート（`test:gate-meta`）からは `scripts/gate-constraints.sh --root <fixture-root> --constraints docs/constraints.json` の形で対象ツリーを差し替えて回すこと（`tests/unit/gate-constraints.test.ts` の「real docs/constraints.json against a fixture tree」が同じ形の実例）。
- task_009: CI に `gate:constraints` / `gate:wording` ジョブを追加する場合、`.github/workflows/gate.yml` を直接編集せず独立ファイルで追加する規約（並行タスクの衝突回避）。必要な外部ツールは `jq` / `git` / `grep` / `sed` / `awk` / `xargs` / `node` のみ。
- task_011 / 017 / 018 / 020: 各タスクが対象ファイルを作った時点で `from_task_XXX` のゲートが自動的に有効化される（P2 → Webhook ルート、P9 / X-MONEY → `src/lib/payments/**`、W4 → 台帳と Webhook、W9 / W11 → `src/lib/reconcile.ts`、X-TIME / GC-SERVER-ONLY → `src/lib/db/**` と `supabase/migrations/**`）。`completion_status` を DONE にしたあとで対象が 0 件のままだとゲートが exit 1 になる。

## task_011（DB スキーマ v2・最小権限ロール・追記専用・統合テスト）

### 決まったこと

- **スキーマの正本は `supabase/migrations/*.sql`**。`src/lib/db/schema.ts`（Drizzle）は型とクエリ専用で、`drizzle-kit generate` / `push` は使わない。両者の乖離は統合テストが機械検査する（Drizzle 248 列 ⇔ 実 DB の `format_type` / NOT NULL を完全一致で比較。表記ゆれは `char(3)` ⇔ `character(3)` のみ正規化）。
- **追記専用は RULE ではなく文レベル（`FOR EACH STATEMENT`）の BEFORE トリガ**で実装した。行レベルだと対象 0 行の `UPDATE` / `DELETE` が黙って成功してしまい、「0 行成功は不合格」（check_013）を満たさない。文レベルなら 0 行でも `RAISE EXCEPTION`（SQLSTATE `0A000`、メッセージ `append_only_violation`）になる。`TRUNCATE` も同様に塞いだ（計 6 トリガ）。実測で確認済み。
- **RLS deny-all ＋ service role は採用しない**（implementation-plan.md §7-2 の裁定どおり）。代わりに `CREATE ROLE app_rw LOGIN` ＋ 最小権限 GRANT。`ledger_entry` / `audit_log` は `SELECT, INSERT` のみ、`compliance_gate` は `SELECT` のみ、`feature_flag` は `SELECT, INSERT, UPDATE`（DELETE なし）、他 19 テーブルは CRUD。`REVOKE CREATE ON SCHEMA public FROM app_rw` で DDL も落とした（実測: `CREATE TABLE` が `42501`）。
- Supabase の PostgREST ロール **`anon` / `authenticated` から public スキーマの権限を全部剥がした**。本アプリは PostgREST を使わずサーバー側から直接接続する（I3）。ロールが存在しない素の PostgreSQL でも落ちないよう `DO $$ ... IF EXISTS` でガードしてある。
- **`app_rw` のパスワードをマイグレーションに書かない**。本番 / staging は秘密ストアから `ALTER ROLE app_rw PASSWORD ...`（task_024 / task_035 の担当）。ローカル / CI は `tests/integration/setup.ts` がローカル専用値（既定 `app_rw_local_dev_only`、`APP_RW_PASSWORD` で上書き可）を設定する。
- **`.env.example` を 2 節に分け、機械可読マーカー（`>>> runtime ... >>>` / `<<< runtime <<<`）を入れた**。ランタイム欄には `APP_ENV` しか置かず、DB 接続文字列も service role キーも置かない（Workers は `env.HYPERDRIVE.connectionString` から受け取る）。統合テストがこのマーカーを頼りに「ランタイム欄に特権クレデンシャルが無い」ことを検査する。`DATABASE_URL` は **app_rw** の直接接続、`DATABASE_URL_MIGRATOR` は特権接続、という役割分離にした。`scripts/gates-sync.mjs` は `DATABASE_URL_MIGRATOR` → `DATABASE_URL` → ローカル既定の順で解決する。
- **接続文字列の解決は `resolveDbConnection()` 1 関数**（`src/lib/db/client.ts`）。Hyperdrive バインディングがあれば `hyperdrive`、無ければ `DATABASE_URL` の `direct`。既定でロールが `app_rw` でなければ `DbConfigError`（`allowPrivilegedRole: true` を明示したときだけ特権ロールを許す）。例外メッセージに接続文字列を入れない。`tests/unit/db-client.test.ts` が 8 ケースで検証。
- **`fetch_types: false` は使わない**。当初 Cloudflare 向けに付けたところ、`text[]` 列（`compliance_gate.required_for`）が Postgres の配列リテラル文字列のまま返り、`gates:sync` が静かに壊れることを実測した。`prepare: false` だけ残す（プーラ経由でのプリペアド再利用不可に備えた保守的設定）。
- **`supabase/config.toml`** は `studio` / `inbucket` / `storage` / `realtime` / `analytics` / `edge_runtime` を `enabled = false` にした（本アプリが使わないため起動を軽くする）。`api` と `auth` は有効のまま残した — `anon` / `authenticated` ロールを実在させて上記 REVOKE の有効性をテストで確かめるため。DB は PG 17・ポート 54322（`wrangler.toml` の `localConnectionString` と一致）。
- **CI ジョブは `.github/workflows/gate-integration.yml` として独立追加**した（`gate.yml` は task_009 の所有物なので編集していない。並行タスクの衝突回避規約）。`supabase/setup-cli@v1`（入力は `version` の 1 つだけ。一次資料 `docs/vendor-docs/supabase/ci-local-testing.md`、取得日 2026-09-24）→ `supabase start` → `db:migrate` → `test:integration` → `gates:sync`。**required status check への登録は task_009 の担当**（ジョブ名は `gate-integration / integration`）。
- **統合テストの隔離**はトランザクション方式。`withRollback()` が必ずロールバックし、失敗が想定される文は `expectFailure()` がセーブポイントで包む（例外で外側のトランザクションを巻き添えにしない）。`supabase db reset` は使っていない。
- 未知の `settlement_status` を入れると **`23502`（NOT NULL 違反）が `23514`（CHECK 違反）より先に出る**ことを実測した。生成列 `settlement_rank` の `NOT NULL` が先に評価されるため。どちらで落ちても「未知 status は入らない」は成立するので、テストは両方を許容し、別テストで `invoice_settlement_status_check` が 6 値ちょうどであることを確認している。
- `vitest.config.ts` の `include` に `tests/integration/**/*.test.ts` を追加し、`exclude` から外した（task_003 が同ファイルのコメントで task_011 の担当と明記していたもの）。**task_018 / task_019 が `tests/contract/**` / `tests/conformance/**` を同じ配列に足すときに衝突しうる**ので注意。

### 未解決 / concerns

- **[severity: medium] `.github/workflows/gate-integration.yml` は PR で未実行**。`git push` が禁止コマンドのため、CI 上での緑は本タスクでは確認していない（done_definition「gate.yml に integration ジョブが追加され PR で緑」の後半が未達）。ローカルでは同じコマンド列（`supabase start` 済みの状態で `db:migrate` → `test:integration` → `gates:sync`）が全て exit 0。task_009 が required status check を設定するときに、初回 PR での実走を確認すること。
- **[severity: medium] `drizzle-kit` による差分検査は実施していない**。`drizzle.config.ts`（task_003 の成果物・本タスクの `files_to_modify` 外）の `schema` が `./src/db/schema.ts` を指しており、実際の `src/lib/db/schema.ts` と不一致。そもそも drizzle-kit をマイグレーション生成に使わない方針（§7-2）なので `generate` を回すと台帳が二重化する。代替として「Drizzle の全 248 列 ⇔ 実 DB の型・NOT NULL 完全一致」をテストで検査した。`drizzle.config.ts` の `schema` パス修正は別タスクで行うこと。
- **[severity: medium] A21（Hyperdrive 経由の実 Postgres 接続）は依然として未実測**。本タスクで実測したのは `supabase start` のローカル直接接続まで。`pg_try_advisory_xact_lock` の挙動も直接接続でしか確認していない（`tryAdvisoryXactLock()` は実装済みだが実行経路がまだ無い）。task_035 で実 Hyperdrive に対して確認すること。
- **[severity: low] 依存タスク task_009 が未完了のまま着手した**。`.github/workflows/` は本タスク着手時点で存在せず（`docs/run-log/task_009.json` も無し）、`gate.yml` も未作成。衝突回避規約に従い独立ファイルで追加したので、task_009 の成果物とは競合しない見込み。
- **[severity: low] `supabase init` の副産物 `supabase/.gitignore` と `supabase/.temp/` が増えた**。`.gitignore` はコミットした（`.branches` / `.temp` / dotenvx 系を無視する。CLI の動作に必要）。`files_to_create` には無いが `supabase/config.toml` を作るには `supabase init` が必要だった。
- **[severity: low] `tests/unit/db-client.test.ts` は `files_to_create` に無い**。done_definition が「ユニットテストで確認」を要求しており、`client.ts` は `import "server-only"` を持つため統合テストからは読めない（`vi.mock("server-only")` が要る）。他タスクの `files_to_create` にも無いファイルなので新規作成した。
- **[severity: low] `vitest.config.ts` は `files_to_modify` に無い**が、`tests/integration/**` が `exclude` に入っていたため変更が不可避だった（task_003 が同ファイルのコメントで task_011 の担当と明記している）。
- **[severity: low] `compliance_gate.scope` は NULL 許容にした**。`docs/gates/compliance-gates.json` に `scope` フィールドが無く、同期元が存在しないため。JSON 側に足すかどうかは PO の判断（`docs/gates/**` の変更は PO 専管）。
- **[severity: low] `context7` MCP はこのセッションでも接続断**（`CONNECTION_CLOSED`）。Supabase CI の一次資料は WebFetch で取得して `docs/vendor-docs/supabase/ci-local-testing.md` に退避した。postgres.js / drizzle-orm の API 名は `node_modules` の型定義で直接確認した [実測]。

### 次のアクション

- task_009: `.github/workflows/gate.yml` の required status checks に `gate-integration / integration` を加える。
- task_014（リポジトリ関数）: `createDbClient(env)` / `tryAdvisoryXactLock(tx, key)` / `AUDIT_CHAIN_LOCK_KEY` を前提にしてよい。`invoice.settlement_rank` は生成列なのでアプリから書かない（書くと `428C9`）。
- task_024 / task_035: 本番・staging の `app_rw` パスワード投入（`ALTER ROLE app_rw PASSWORD ...`）と Hyperdrive の実 ID 差し替え、A21 の実測。
- `supabase start` は本タスクの作業中に起動したまま（`supabase stop` は禁止コマンドのため停止していない）。他タスクが `54322` のローカル Postgres をそのまま使える。

## task_011（レビュー指摘の修正・2 周目）

### 直したこと

- **`supabase/migrations/0003_event_scope_fk.sql` を追加**した。`participant` に `UNIQUE (event_id, id)` を張り、`invoice` と `participant_claim` からそれぞれ複合 FK `(event_id, participant_id) → participant (event_id, id)`（ON DELETE は既存の単独 FK と同じく RESTRICT / CASCADE）を張った。
  - 直した穴: 0001 では `event_id` と `participant_id` が**独立した 2 本の単独 FK** でしか縛られておらず、「participant が属する event」と「行が名乗る event_id」がずれていても DB が受理していた。そのため (a) `invoice_event_participant_uk UNIQUE (event_id, participant_id)` が迂回でき 1 人の participant に複数 invoice を作れ、(b) `participant_claim (event_id, line_user_ref) WHERE released_at IS NULL` の部分一意も迂回でき、同一イベント内で 1 人の LINE ユーザーが未解放 claim を複数持てた（R-PAY-03 / R-SEC-01）。**修正前に psql の BEGIN/ROLLBACK で両方とも再現済み**。修正後は同じ INSERT が `23503` で落ちる [実測]。
  - **0001 を直接編集しなかった**理由: ローカル Postgres には既に 0001 / 0002 が適用済みで、0001 を書き換えると `supabase db diff`（shadow DB はマイグレーションから再生される）が差分ありになる。整合させるには `supabase db reset` が要るが、これは並行タスクのデータを壊すため禁止コマンド。新しい 0003 なら `supabase migration up` だけで済み、素の状態から reset しても同じスキーマに着地する。
  - 統合テストに 3 ケース追加（別イベントの `event_id` を名乗る invoice は作れない / participant が属さない `event_id` での claim は拒否される / 誤った `event_id` を使っても同一イベント内の未解放 claim を 2 つ持てない）。`check_071` の「適用済みマイグレーション一覧」テストも `0003_event_scope_fk` を含むよう更新。統合テストは 32 → **35 ケース全 pass**。
- **`drizzle.config.ts` の `schema` を実在パス `./src/lib/db/schema.ts` に直した**（以前は存在しない `./src/db/schema.ts` を指しており drizzle-kit 系コマンドが一切動かなかった）。`out` は `DRIZZLE_DIFF_OUT` で上書きできる使い捨ての `node_modules/.cache/drizzle-diff/**` にした。`npm run db:diff:drizzle` を追加（introspect → generate の**読み取り専用の差分検査**。`supabase/migrations/` には何も書かず DB にも適用しない。実行のたびに `run-<epoch>` の新しいディレクトリを使う — 前回のスナップショットが残っていると次の差分が空に見えてしまうため。`rm -rf` は `scripts/deny-dangerous-bash.sh` が塞いでいるので削除はしない）。

### 未解決 / concerns（2 周目時点）

- **[severity: medium] `check_071` の drizzle-kit 側は現方針では達成不能**であることが実測で判明した。差分は **190 文**（`DROP CONSTRAINT` 127・`DROP INDEX` 34・生成列 `settlement_rank` / `is_open` の drop+add 2 組・`idempotency_key` の PK 名 1）。`CREATE TABLE` / `DROP TABLE` は 0 で、**実際のスキーマ乖離は 1 件も無い**。原因は `src/lib/db/schema.ts` が §7-2 の裁定どおり列だけを宣言し、9 unique・92 check・34 index・31 FK を書かないこと。差分を本当に 0 にするにはそれらを schema.ts に写す必要があり、§7-2 が避けようとした DDL の二重化そのものになる。PO の裁定が要るので **task_038 として起票**した。列単位の完全一致（248 列・`format_type`・NOT NULL）は既に統合テストが自動で守っている。
- **[severity: medium] `done_definition` 第 5 項「gate.yml に integration ジョブが追加され PR で緑」は依然として未達**。本セッションでも `.github/workflows/` には `gate-integration.yml` しか無く、`docs/run-log/task_009.json` も存在しない（task_009 未着手）。`gate.yml` は task_009 の `files_to_create` なので本タスクでは作らない。CI 実走は `git push` が禁止コマンドのため未検証。**`completion_status` は DONE_WITH_CONCERNS のまま据え置く**。
- **[severity: medium] `wrangler.toml` の `[[hyperdrive]] localConnectionString` がロール `postgres` のまま**で、`src/lib/db/client.ts` の `resolveDbConnection()` が `app_rw` 以外を `DbConfigError` で拒否するため、ローカルの `wrangler dev` / `npm run cf:dev` は Hyperdrive 経路で必ず失敗する。`wrangler.toml` は task_011 の `files_to_modify` 外なので編集せず、**task_035 の scope に修正項目として追記**した。静的な突合せのみで `wrangler dev` の実走確認はしていない。
- **[severity: low] `ledger_entry` にも同種の穴が残っている**。`ledger_entry` は `invoice_id` と `event_id` を独立した単独 FK で持つため、invoice の実 `event_id` と異なる `event_id` を名乗る台帳行を作れる。今回のレビュー指摘には含まれていないため修正していない（スコープ規律）。直すなら `invoice` に `UNIQUE (event_id, id)` を足して `ledger_entry` から複合 FK を張る、という今回と同型の手当てになる。PO / 次のレビューの判断待ち。
- **[severity: low] 本タスクの `files_to_modify` 外のファイルを 2 つ触った**。`drizzle.config.ts`（レビューの fix が明示的に指示）と `docs/task-list.json`（task_035 の scope に 1 行追記 ＋ task_038 を起票。同じくレビューの fix の指示）。`docs/acceptance-checks.json` は PO 専管と判断して触っていない（`check_071` の未達は本節と run-log に記録）。

### 次のアクション（2 周目時点）

- task_009: `.github/workflows/gate.yml` を作ったら required status checks に `gate-integration / integration` を加え、実 PR で緑になることを確認する。そこまで確認できて初めて task_011 を DONE にできる。
- task_038（新規・PO 裁定）: `check_071` の drizzle-kit 差分検査を「差分 0」のまま行くか「表・列レベルのみ」に定義し直すかを決める。
- task_035: `wrangler.toml` の `localConnectionString` を `app_rw` ロールに揃える（上記 concerns）。

## ターンログ（Stop フック自動追記）

各ターン終了時に scripts/append-handoff.sh が 1 行追記する。決まったこと・未解決の本文は上の各タスク節に書く。

- 2026-09-24T04:23:14Z HEAD=96503f1 決まったこと: task_011: 検証ログ（全 verify_commands exit 0 と未検証項目の手動記録） / 未解決: 未コミット 16 件: docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_011.json drizzle.config.ts package.json tests/integration/schema.test.ts .claude/ docs/gates/legal-clearance.json 
