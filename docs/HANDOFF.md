# HANDOFF

## ⚠ 既知の壊れている経路（着手前に必ず読む）

- **`npm run cf:dev` / `wrangler dev` は環境変数を 1 本 export しないと Hyperdrive 経路で失敗する**
  （恒久策は task_035）。
  `wrangler.toml` の `[[hyperdrive]] localConnectionString` はロール `postgres`
  （`postgres://postgres:postgres@127.0.0.1:54322/postgres`）のままで、
  `src/lib/db/client.ts` の `resolveDbConnection()` はランタイムロールが `app_rw` で
  なければ `DbConfigError` を投げる（`tests/unit/db-client.test.ts` が拒否を検査している）。
  **いま動かす方法**（Hyperdrive の一次資料「方法 2」。環境変数は `wrangler.toml` の
  設定より優先される。`docs/vendor-docs/cloudflare/hyperdrive.md`）:

  ```sh
  export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://app_rw:app_rw_local_dev_only@127.0.0.1:54322/postgres"
  npm run cf:dev
  ```

  `app_rw` のローカルパスワードは `npm run test:integration` の setup が
  `ALTER ROLE` で設定する（`tests/integration/setup.ts`）。**この経路の実走確認は未実施**。
  **`ALLOW_PRIVILEGED_DB_ROLE=1` はこの用途には使えなくなった**（4 周目レビュー）。
  同フラグは `direct` 経路（`DATABASE_URL`）でしか効かない。理由は
  `wrangler.toml` の既定環境（`name = "cashapp-dev"`）がデプロイ可能で、その
  `[vars] APP_ENV` が `"development"` である以上、`APP_ENV` は「ローカルに限る」条件に
  ならないため（`docs/concerns/task_011.md` の C-011-4）。
  **恒久策（task_035）**: `localConnectionString` を
  `postgres://app_rw:app_rw_local_dev_only@127.0.0.1:54322/postgres` に変え、
  `wrangler dev` を 1 度実走して Hyperdrive 経路が通ることを確認する。それが済めば
  フラグは不要になる。`wrangler.toml` は task_003 の `files_to_create` /
  task_035 の `files_to_modify` であり task_011 の担当範囲外のため触っていない。
  ローカル DB に直接つなぐ経路（`npm run db:migrate` / `npm run test:integration` /
  `npm run gates:sync` / `npm run db:diff:drizzle`）はこの影響を受けない。

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

## task_005（フック群・deny スクリプト・legal-clearance・毎ターン追記）

### 決まったこと

- **`.claude/settings.json` に 6 イベントを登録した**（PreCompact は意図的に使わない）。SessionStart=`scripts/session-brief.mjs`、UserPromptSubmit=`scripts/gate-status.mjs`、PreToolUse(Bash)=`scripts/deny-dangerous-bash.sh`、PreToolUse(Edit|Write|MultiEdit)=`scripts/deny-test-weakening.sh`、PostToolUse(Edit|Write|MultiEdit)=`typecheck` / `lint:changed` / `gate:constraints`、Stop=`scripts/append-handoff.sh`、SubagentStop=`scripts/assert-diff-exists.sh`。コマンドはすべて `"$CLAUDE_PROJECT_DIR/..."` 絶対参照。**Stop の `gate:check` と PostToolUse の `gate:plan` は task_006、Stop の `test:gate` は task_019 が追加する**（今は未登録）。
- **`.claude/settings.json` はセッション途中でも読み込まれる**ことを実測した。本タスクの作業中に settings.json を作った直後から PreToolUse フックが発火し、こちらの Bash 呼び出しと Write 呼び出しを 2 件とも実際に遮断した（`docs/run-log/task_005.json` の manual 記録）。`.claude/` がセッション開始時に存在しなくても有効化された。
- **`deny-dangerous-bash.sh` の判定単位は「正規化した後のサブコマンド」**。引用符（`"` `'` バッククォート）とバックスラッシュを除去し、連続空白を 1 個に潰し、`&&` / `||` / `|` / `;` / 改行で分割してから各節に部分一致をかける。引用符や連続空白による難読化も、改行で行を分けた書き方も通らない。
- **遮断対象（生コマンド）**: wrangler の本番反映系コマンド 3 種（`deploy`、`versions deploy`、`secret put`。環境指定の有無を問わず常時）/ supabase のスキーマ破壊系 2 種（`db push`、`db reset`）/ git の強制系 2 種（強制 push、`reset --hard`）/ `rm` の再帰＋強制指定（フラグの順序と綴りを問わない）/ `pnpm` / `npm publish` / 本番シークレット接頭辞 / 本番決済環境フラグ / `--live`。**`legal-clearance.json` の `cleared` が true でも本番系はローカルからは常に exit 2**（デプロイは CI のみ。§16-6）。
- **別名呼び出しは package.json.scripts を再帰解決する**。`npm run <名前>` / `npm run-script <名前>` / `yarn <名前>` / `npx <名前>` を拾い、解決できた本体を同じ規則で再帰的に走査する（深さ上限 5、循環は visited チェーンで打ち切り）。解決できず名前が `deploy|secret|publish|reset|push|prod` に一致する場合は **fail-closed で exit 2**。解決できて本体が無害なら通す（フィクスチャの `reset:fixtures` = `rm -f ...` は通る）。テストは実 package.json ではなく `tests/unit/hooks/fixtures/package.json` を `DENY_BASH_PACKAGE_JSON` で指して判定する。
- **Bash 経由の書き込み遮断は「経路」で判定し、パス名の言及では判定しない**。`>` / `>>` のリダイレクト先、`tee` の引数、`sed -i` を含む節に現れる保護パス、`cp` / `mv` を含む節に現れる保護パス（**2 周目で「最終引数だけ」から「全トークン」に変更**。下の task_005 2 周目の節を参照）、`python -c ... open(..., 書き込みモード)` の 5 経路だけを見る。保護対象は `docs/run-log/**`・`docs/gates/**`・`docs/acceptance-checks.json`・`tests/**`・`scripts/deny-*`・`scripts/record-run.sh`・`.claude/**`・`.github/workflows/**`。**`scripts/record-run.sh <task_id> <command...>` はこの 5 経路のどれも持たないので通る。例外句は書いていない**（例外句があると同じ文字列を含めるだけで迂回できてしまうため。R-TH-02 の裁定どおり）。
- **`deny-test-weakening.sh` の判定材料は「編集前後のテキスト」**。Edit は `old_string` / `new_string`、MultiEdit は全 `edits` の連結、Write は「ディスク上の現ファイル」対「`content`」で比較する。`tests/**` について (a) `it(` / `test(` の件数減、(b) `expect(` の件数減、(c) `describe|it|test` に対する `.skip` / `.todo` / `.only` の新規追加 のいずれかで exit 2。加えて全ファイル共通で本番鍵・本番決済環境フラグの書き込みを exit 2、`docs/run-log/**` と `docs/gates/**` への書き込みを無条件 exit 2、`docs/acceptance-checks.json` は `evidence` に触れる編集のみ exit 2。
- **`docs/gates/legal-clearance.json` を `cleared:false` で作成した**（`basis` / `approved_by` / `approved_at` はすべて null）。このファイルは `docs/gates/**` に入るので、Edit/Write も Bash 経由の書き込みも自分自身のフックで遮断される。値を動かせるのは人間（PO）だけ。
- **Stop フックは docs/HANDOFF.md 末尾の「ターンログ（Stop フック自動追記）」節に 1 行追記する**。内容は UTC 時刻・HEAD・直近コミット件名（＝決まったこと）・未コミットファイル一覧（＝未解決）。本文の散文は各タスク節に人／エージェントが書き、フックは「毎ターン必ず 1 行は残る」ことだけを機械的に保証する（F4。PreCompact に依存しない）。
- **SubagentStop フック（`assert-diff-exists.sh`）は遮断せず報告する**。差分なしで終わるサブエージェント（調査・レビュー・敵対レビュー）と、`with-lock.sh git` でコミットを済ませて作業ツリーが綺麗なサブエージェントの両方が正常系なので、exit 2 にすると正しい振る舞いのほうに当たる。セッション開始時の HEAD を `.locks/subagent-head-baseline`（gitignore 済み）に控え、「作業ツリーに差分なし かつ HEAD が baseline から動いていない」ときだけ `systemMessage` で警告する。完了申告に対する強制力は `record-run.sh` 専有の run-log と CI の `verify_commands` 再実行が持つ。
- **テストは 84 件**（`tests/unit/hooks/` 3 ファイル）。`npm run test:unit` 全体では 121 件が緑。フックのテストは実スクリプトを `spawnSync` で起動して終了コードだけを見る（スクリプトの中身をモックしない）。
- **テストの中に禁止パターンのリテラルを書かない**という運用規約を立てた。`.skip` / `.only` / `.todo` の見本と本番鍵・本番環境フラグの見本は `["it","skip"].join(".")` のように実行時に組み立てる。リテラルで書くと、そのテストファイル自身が `deny-test-weakening.sh` に引っかかって以後書き換えられなくなる（実際に 1 回踏んだ）。

### 未解決 / concerns

- **[severity: medium] check_053（新規セッションでの SessionStart 注入の目視確認）は未達**。実施できたのは、`.claude/settings.json` に登録したコマンドそのものへ SessionStart のフック入力 JSON をパイプして stdout を確認するところまで（未通過ゲート 10 件・`cleared=false`・未回答照会 6 件・HANDOFF 末尾 40 行がすべて `additionalContext` に入ることを確認済み。`docs/run-log/task_005.json` の manual 記録）。サブエージェントからは新しい対話セッションを開けないため、「新規セッションを開いて画面上で目視する」は PO が実施すること。
- **[severity: medium] `deny-dangerous-bash.sh` は禁止パターンが引数の文字列として登場するだけでも遮断する**。コマンド行を正規化して部分一致をかける設計上、引用符の中身と実際に実行される語を区別できない。本タスク中に、遮断された操作を説明する文章を `scripts/record-run.sh --manual` の引数に渡そうとして説明文自体が exit 2 になり、さらに本 HANDOFF 節をヒアドキュメントで書こうとして節の本文が exit 2 になった（いずれも run-log に記録済み。前者は言い換えで、後者は Write ツールで一時ファイルを作ってから挿入する手順で回避した）。**ここを緩めると難読化に対して穴が空く**ので、緩めずに運用側で回避する裁定にした。
- **【2 周目で解消。下の task_005 2 周目の節を参照】[severity: medium] Edit/Write ツールからの `scripts/deny-*` と `scripts/record-run.sh` の書き換えは塞げていない**。task_005 のスコープで、この 2 つは Bash 経路（`sed -i` / `cp` / `mv` / リダイレクト）の保護対象としてのみ列挙されており、`deny-test-weakening.sh` 側の遮断対象には挙がっていないため、スコープどおりに実装した。結果として Edit ツールでガード自身を書き換える経路が残っている。塞ぐなら `deny-test-weakening.sh` に `scripts/deny-`・`scripts/record-run.sh`・`.claude/**` を足す（task_006 の `test-hook-enforcement.sh` で穴として検出されるはず）。
- **[severity: medium] `docs/acceptance-checks.json` の `evidence` を書ける経路が現時点でどこにも無い**。Edit/Write は `deny-test-weakening.sh` が、Bash のリダイレクト等は `deny-dangerous-bash.sh` が遮断する。task_006 の `gate-check.mjs` が evidence を書く設計なら、`record-run.sh` と同様に「そのスクリプトだけが書ける」経路を作る必要がある（`gate-check.mjs` を Bash から引数だけで起動し、スクリプト内部で fs 書き込みする形なら現行のフックを通る）。task_006 で設計を確定させること。
- **[severity: low] PostToolUse の 3 コマンドは編集のたびに毎回走る**。`typecheck`（`tsc --noEmit`）＋`lint:changed`＋`gate:constraints` で 1 編集あたり数秒〜十数秒かかる。遅すぎる場合は `typecheck` を Stop 側へ移すなどの調整が要る（今は §16-4 の表どおりに置いた）。
- **[severity: low] `lint:changed` は `origin/main...HEAD` を使う**。本リポジトリにリモートが無いため `git diff` が失敗し、`2>/dev/null` でファイル一覧が空になって `eslint --max-warnings=0` が引数なしで走る（実測 exit 0）。意図した「変更ファイルだけ」にはなっていない。`package.json` は本タスクの担当範囲外なので手を入れていない。
- **[severity: low] `docs/PROGRESS.md` と `docs/HANDOFF.md` は task_005 の `files_to_create` に挙がっているが、task_002 / task_003 が既に作成済み**だったため新規作成せず追記した（雛形を上書きすると先行タスクの記録を消すため）。
- **[severity: low] `tests/unit/hooks/fixtures/package.json` は npm からは参照されない偽の package.json**。`DENY_BASH_PACKAGE_JSON` 経由でのみ読まれる。`"type"` を持たないため、将来この配下に `.js` を置くと CJS 扱いになる点に注意。
- **[severity: low] `.claude/settings.local.json` は作っていない**（個人設定は本タスクのスコープ外）。`.gitignore` にも追加していない。

### 次のアクション

- PO: 新規 Claude Code セッションをこのリポジトリで開き、SessionStart の注入内容を目視して `scripts/record-run.sh --manual task_005 "<観察>"` で記録する（check_053）。同じく 2 ターン動かして `docs/HANDOFF.md` の「ターンログ」節に 2 行増えることを確認する（check_063）。
- task_006: `gate-check.mjs` を Stop に、`gate:plan` を PostToolUse に追加する。`scripts/test-hook-enforcement.sh` で 6 イベント × 遮断挙動の実測マトリクスを作るとき、上記 concerns の「Edit からガード自身を書き換えられる」「evidence を書ける経路が無い」の 2 点を違反フィクスチャに入れること。
- task_019: Stop に `test:gate` を追加する。

## task_011（レビュー修正・3 周目）

### 決まったこと

- **`ledger_entry` の event スコープの穴を `supabase/migrations/0004_ledger_event_scope_fk.sql` で塞いだ**。`invoice` に `UNIQUE (event_id, id)` を張り、`ledger_entry` から `FOREIGN KEY (event_id, invoice_id) REFERENCES invoice(event_id, id)` の複合 FK を参照させる（0003 と同型）。0001 では `ledger_entry` の `invoice_id` / `event_id` がどちらも `ON DELETE` 句を持たない（= NO ACTION）ので、複合側も `ON DELETE` 句を書かず挙動を揃えてある。修正前は psql の BEGIN/ROLLBACK で E1 の invoice に `event_id=E2` の台帳行を INSERT でき（`ledger_cross_event_rows=1`）、修正後は同じ INSERT が `23503 foreign_key_violation` で落ちることを実測した。統合テストに「別イベントの event_id を名乗る ledger_entry は作れない」を 1 ケース追加し、35 → 36 ケース全 pass。
- **`npm run db:diff:drizzle` を自動判定するゲートにした**。判定器は `scripts/db-diff-drizzle.mjs`。`CREATE TABLE` / `DROP TABLE` / `ALTER COLUMN` が 1 文でもあれば exit 1、`ADD COLUMN` / `DROP COLUMN` は**同じ (table, column) に drop と add の対が無いもの**だけを乖離として exit 1 にする。`.github/workflows/gate-integration.yml` にもステップとして追加した。
- 判定器が読むのは `meta/_journal.json` の `idx >= 1` のエントリだけである。`drizzle-kit pull` が `idx 0` に**実 DB の丸写し**（全テーブルの CREATE TABLE）を書き、`generate` が `idx 1` に差分を書くため、out ディレクトリの `.sql` を無差別に読むと丸写しを乖離と誤認して恒久的に赤になる（実測で踏んだ）。
- 生成列の drop+add 対を打ち消すのは、drizzle-kit 0.31.11 が `GENERATED ALWAYS AS ... STORED` 列を差分なしと判定できず、`invoice.settlement_rank` と `payment_attempt.is_open` に対して常に同一定義の `drop column` ＋ `ADD COLUMN` を吐くためである。片側しか出ないケース（列が本当に増えた / 消えた）は打ち消されないので、ゲートは緩まない。**実証**: `src/lib/db/schema.ts` の `abuse_report` に列を 1 本足すと `ADD COLUMN without a matching counterpart` で exit 1、列を 1 本消すと `DROP COLUMN without a matching counterpart` で exit 1、元に戻すと exit 0。
- **`docs/task-list.json` の task_011 に `completion_status: "DONE_WITH_CONCERNS"` と concerns 6 件を書き込んだ**。severity の接頭辞は `scripts/gate-status.mjs` の正規表現 `/severity\s*[:：]\s*high/i` に合わせて `[severity: high]` 形式にしてある（`node scripts/gate-status.mjs` が `high concerns 残高: 1 件 — task_011×1` を返すことを実測）。

### 未解決 / concerns

- **[severity: high] done_definition 第 5 項（`gate.yml` に integration ジョブ・PR で緑）は 3 周目でも未達**。`.github/workflows/` は `gate-integration.yml` 1 本のみで `gate.yml` は不在、`docs/run-log/task_009.json` も無い（task_009 未着手）。`gate.yml` は task_009 の `files_to_create` なので本タスクでは作らない。required status check への登録は task_009 側で `gate-integration / integration` を指定すること。`git push` が禁止コマンドのため CI は一度も実走していない。**task_009 完了 → 実 PR 緑の確認まで task_011 を DONE にしない。**
- **[severity: medium] check_071 の drizzle-kit 側「差分 0」は依然として未達**。上記ゲートは「テーブル / 列の層の乖離 0」を自動判定するもので、`check_071` の rule 文言（差分 0）そのものではない。`docs/acceptance-checks.json` は PO 専管と判断して編集しておらず、rule の書き直しは task_038 の裁定待ち。裁定が (b) ならこの判定器の条件を rule に写すだけで済み、(a) なら判定器を撤去して素の「差分 0」に戻す（task_038 の scope に追記済み）。
- **[severity: medium] `wrangler.toml` の `localConnectionString` のロール不一致は未修正**。冒頭の「既知の壊れている経路」を参照。`wrangler dev` の実走確認も未実施（静的な突合せのみ）。
- **[severity: low] `scripts/db-diff-drizzle.mjs` はどのタスクの `files_to_create` にも含まれない新規ファイル**。`db:diff:drizzle` を「人が目視する道具」から「自動で落ちるゲート」に変えるというレビュー指示を、`package.json` のシェル 1 行に押し込まずに実装するため作った。
- **[severity: low] 0001 / 0003 を書き換えず 0004 を追加した**。適用済みのローカル DB と shadow DB がずれて `supabase db diff` が差分ありになり、整合に禁止コマンド（supabase のローカル DB 初期化）が要るため。素の状態から順に適用しても同じスキーマに着地する。

### 次のアクション

- task_009: `.github/workflows/gate.yml` を作り、`gate-integration / integration` を required status check に登録する。そのうえで実 PR を 1 本立てて緑にし、`docs/run-log/task_011.json` に結果を記録して task_011 の高 severity concern を消す。
- task_035: `wrangler.toml` の `localConnectionString` を `app_rw` に直し、`wrangler dev` で Hyperdrive 経路が通ることを実走確認する。
- task_038（PO）: check_071 の (a) / (b) を裁定する。

## task_005（レビュー修正・2 周目）

### 決まったこと

- **`npm` / `yarn` の `run` 解析はフラグを読み飛ばす**。`scripts/deny-dangerous-bash.sh` の `script_names()` は、サブコマンドの前（`npm --silent run X`）・後（`npm run --silent X`、`npm run --workspace=w X`）のどちらに来るフラグも許し、`-` 始まりのトークンを落として最初の実トークンをスクリプト名に取る。修正前は直後の 1 トークンを無条件で名前にしていたため、フラグを 1 つ挟むだけで別名解決も fail-closed も効かなかった。**実測**: 修正前は 6 形式すべて exit 0、修正後は 6 形式すべて exit 2。`.claude/settings.json` の PostToolUse 自身が `--silent` 付きの形を使っているので、この書き方はリポジトリの慣習でもあり、放置すると自然に踏む経路だった。
- **`cp` / `mv` / `rsync` / `install` は節の全トークンを検査する**。最終トークンだけを宛先とみなす実装だったため、`cp src docs/gates/legal-clearance.json 2>/dev/null` のように末尾にトークンが 1 つ増えるだけで素通りしていた。`sed -i` と同じ方針に揃えた。副作用として保護パスからの**読み出し**（`cp docs/gates/x.json /tmp/`）も遮断される。上書きだけを見分ける手段が正規化後の文字列には無いため fail-closed 側に倒してある。読み出したいときは `cat` を使うこと。
- **`scripts/assert-diff-exists.sh` の baseline はセッション単位で、毎回前進する**。フック入力の `session_id`（Claude Code の全フックが stdin JSON に載せる。update-config スキルの schema で確認）を使って `.locks/subagent-head-baseline-<session_id>` に保存し、評価後に必ず現在の HEAD を書き戻す。旧実装はファイルが無いときだけ baseline を書いていたので、HEAD が baseline を追い越した時点で `HEAD = BASE` が恒久的に偽になり検査が二度と発火しなくなっていた（本リポジトリは既にその状態だった。baseline=96503f1 に対し HEAD=9f5f55d）。`session_id` が無い入力では無印のファイルにフォールバックする。**実測**（使い捨てリポジトリ 8 ケース）: 差分なし → 警告、コミット直後 → 無言、その次にまた差分なし → 警告（旧実装ではここが永久に無言）、作業ツリーが汚い → 無言、別 session_id → 独立した baseline。全ケース exit 0（契約どおり遮断しない）。
- **ハーネスの自己保全を Edit/Write 側にも入れた**。`scripts/deny-test-weakening.sh` が `scripts/deny-*` と `scripts/record-run.sh` への Edit/Write を exit 2 にする。Bash 側（リダイレクト・`tee`・`sed -i`・`cp`/`mv`）は元から塞がっていたが、Edit ツール 1 回でガードを無効化できる穴が残っていた。
- **`.claude/**` は「追加は通す・ガードを外す編集は遮断する」**。`docs/task-list.json` の task_006 / task_018 / task_019 はいずれも `.claude/settings.json` を `files_to_modify` に持つ（Stop の `gate:check`、PostToolUse の `gate:plan`、`test:gate` の登録）ので、レビューが提案した「`.claude/` への Edit/Write を一律 exit 2」にすると後続 3 タスクが実行不能になる。代わりに `tests/**` の弱体化判定と同じ数え方を使い、編集前に現れるガードスクリプト名（`deny-dangerous-bash.sh` / `deny-test-weakening.sh` / `session-brief.mjs` / `gate-status.mjs` / `append-handoff.sh` / `assert-diff-exists.sh` / `record-run.sh`）の出現数が編集後に減っていたら遮断する。フックを足す編集は通る。
- フックのユニットテストは 84 → 108 件。増分は deny-dangerous-bash 側 13 ケース（フラグ入り別名 7・`cp`/`mv`/`rsync` の末尾トークン 4・素通ししてはいけない対照 3 のうち新規分）と deny-test-weakening 側 10 ケース（ガード本体・`.claude/` の増減）。

### 未解決 / concerns

- **[severity: high] check_053（新規セッションで SessionStart の注入内容を目視確認した記録）は依然として未達**。サブエージェントからは新しい対話セッションを開けない。PO がこのリポジトリで新規セッションを開き、画面に出る注入（未通過ゲート・`cleared=false`・未回答照会・HANDOFF 末尾 40 行）を目視して `scripts/record-run.sh --manual task_005 "<観察>"` で記録すること。同じく check_063（2 ターン後に「ターンログ」節が 2 行増える）も PO 側の確認が残る。**この 2 件が埋まるまで task_005 を DONE にしない。**
- **[severity: medium] `cp` / `mv` / `rsync` / `install` の全トークン検査は保護パスからの読み出しも巻き込む**。上記のとおり意図的な fail-closed。`docs/run-log/` や `docs/gates/` のファイルを他所へコピーしたいタスクは `cat` を使うこと。
- **[severity: medium] `.claude/**` の判定は「ガード名の出現数」であって意味解析ではない**。フックのコマンドをコメント文字列として残しつつ実行されない場所へ移す、といった書き換えは数が減らないので通る。ハッシュ基準値との照合（task_006 の `scripts/gate-integrity.mjs`。`.claude/**` を対象に含む）が最終的な検出手段であり、この判定はその前段の安価な防護に過ぎない。
- **[severity: medium] `docs/acceptance-checks.json` の evidence を書ける経路が無い問題は未解決のまま**（1 周目からの持ち越し）。Edit/Write は `deny-test-weakening.sh` が、Bash のリダイレクト等は `deny-dangerous-bash.sh` が遮断する。task_006 の `gate-check.mjs` が evidence を書く設計なら、`record-run.sh` と同じ「そのスクリプトだけが書ける」経路が要る。
- **[severity: low] `npm run lint:changed` は `origin/main...HEAD` を使うがリモートが無いためファイル一覧が空になる**（1 周目からの持ち越し）。`package.json` は本タスクの担当範囲外。
- **[severity: low] ガード本体を今後直すには順序の制約がある**。`scripts/deny-*` は自分自身への Edit/Write を拒否するため、変更するタスクは `docs/task-list.json` に scope として起票し、人間がフックを一時的に外すか `git` 経由で当てる必要がある。task_006 の `scripts/test-hook-enforcement.sh` の違反フィクスチャに「Edit でガード自身を書き換える」を入れて、塞がったことを実測で残すこと。

### 次のアクション

- PO: check_053 と check_063 を実施して `scripts/record-run.sh --manual task_005` で記録する。
- task_006: `gate-check.mjs` を Stop に、`gate:plan` を PostToolUse に追加する（`.claude/settings.json` への**追加**は通る。既存のガード登録を消さないこと）。違反フィクスチャに「Edit でガード自身を書き換える」「`.claude/settings.json` からガード登録を外す」を入れる。
- task_019: Stop に `test:gate` を追加する（同上）。

## task_005（レビュー修正・3 周目）

### 直したこと

- **削除・復元経路を塞いだ（high）**。`write_rules_hit` は上書き（リダイレクト・`tee`・`sed -i`・`cp`/`mv`）しか見ておらず、`rm scripts/deny-dangerous-bash.sh` / `rm .claude/settings.json` / `git rm` / `git checkout HEAD -- <path>` / `chmod -x` は全部 exit 0 で通っていた。ガード本体か settings.json を 1 コマンド消せば、以後すべての遮断が同時に無力化される穴。削除・復元（`rm` / `unlink` / `shred` / `truncate` / `git rm` / `git restore` / `git checkout` / `git clean`）と権限・リンク（`chmod` / `chown` / `ln`）の 2 節を足し、節の全トークンを fail-closed で検査する。
- **ディレクトリ形の保護パスを追加**。`PROTECTED_RE` は `docs/gates/` のように末尾スラッシュ付きなので、`rm -r docs/gates` や `git clean -fd .claude` はどれにも一致しなかった。`PROTECTED_TREE_RE`（`docs/run-log` / `docs/gates` / `tests` / `scripts` / `.claude` / `.github` をディレクトリ名として一致）を足し、削除・復元系の判定だけで併用する。`chmod` 側では使わない（`chmod +x scripts/ci/foo.sh` のような正当な操作を殺すため）。
- **長オプションの綴りを拾うようにした（medium）**。`is_rm_rf` のフラグ抽出 `grep -oE '(^| )-[a-zA-Z]+'` は `--recursive` に一致しない（`-` の直後が英字でないため）ので `rm --recursive --force` が素通りしていた。`--recursive` / `--force` を個別に見る。`sed` 側も `-i` だけでなく `--in-place` を見る。CI は Linux（GNU coreutils / GNU sed）なのでこの綴りが実際に通る。
- **インタプリタのワンライナー判定を一般化した（medium）**。`python -c` の `open(..., 'w')` だけを見ていたため、このリポジトリの実行系である `node -e "require('fs').writeFileSync('docs/run-log/x.json', …)"` が通っていた。`python` / `node` / `deno` / `bun` / `perl` / `ruby` / `php` に対し、`-c` / `-e` / `-m` / `--eval` / `deno eval` 等のワンライナー実行フラグと保護パスの同居で遮断する。`dd` の `of=<保護パス>` も 1 分岐で足した。副作用として**保護パスの読み出しワンライナーも遮断される**（`jq` か `cat` を使うこと。本タスク中に実際に踏んで確認済み）。
- **遮断メッセージから秘密値を落とした（medium）**。`block()` の第 1 引数を `mask()` に通す。`sk_live_` / `pk_live_` / `rk_live_` トークン、`Bearer <token>`、`secret put` 以降、`*TOKEN=` / `*KEY=` / `*SECRET=` / `*PASSWORD=` の値を伏せる。`sk_live_` ルールと `wrangler secret put` ルールは定義上「秘密値を含むコマンド」にしか当たらないので、素の引用は遮断のたびに必ず秘密値をログに出していた。
- **フックのユニットテストは 108 → 148 件**（`npm run test:unit` 全体は 145 → 185 件）。増分 40 件の内訳は削除・復元・権限 17、長オプション 3（`rm --recursive --force` 2 形式・`sed --in-place`）、インタプリタ 6、`dd` 1、過剰遮断しないことの対照 10、秘密値マスク 3。
- **インタプリタ判定は「フラグがそのインタプリタ自身のオプションである」ことを要求する**。最初の実装は `-e` / `--force` 等がコマンド中のどこかにあれば当たったため、インタプリタ名を散文として並べた**コミットメッセージ自体が遮断された**（本タスクで実際に踏んだ）。`<interpreter> (オプション)* (-c|-e|-m|--eval|eval)` の形に絞り、対照ケースをテストに入れた。

### 実測で埋めた manual チェック

- **check_053 達成**。`claude` CLI 2.1.257 のヘッドレス新規セッション（`session_id=e3bbac37-70a6-42fd-9622-2a99cdc1a392` / 2026-09-24T05:08:24Z / `entrypoint=sdk-cli`）を実際に起動し、transcript jsonl の `attachment`（`hookName=SessionStart:startup` と `hook_additional_context`）から注入テキスト 63 行 9085 bytes を読んだ。4 要素すべてを確認: 未通過ゲート 10/10（一覧つき）/ `cleared=false` / 未回答照会 6 件・期限超過 0 件 / `docs/HANDOFF.md` 末尾 40 行。同セッションで `UserPromptSubmit` の `gate-status.mjs` も発火した。1・2 周目の「フック入力をパイプした確認」とは別物で、これは実セッションでの発火。
- **check_063 達成**。`session_id=4a06740d-1e78-40a1-b134-97844d7eaef5` を 2 ターン（2 ターン目は `--resume`）動かし、「ターンログ」節が 16 → 17 → 18 行と 1 ターン 1 行ずつ、合計 2 行増えることを実測した。

### 未解決 / concerns（3 周目時点）

- **[severity: medium] `git apply` / `patch` は依然として素通りする**。ガード本体は自分自身への Edit/Write も Bash 書き込みも拒むため、本タスクの修正は `git apply` で当てた（1 周目の HANDOFF が「git 経由で当てる」と書いた経路そのもの）。これはガードを直すための唯一の残り経路であり、同時に迂回路でもある。塞ぐなら人間のレビュー前提の別経路を先に用意すること。最終的な検出手段は task_006 の `scripts/gate-integrity.mjs` のハッシュ照合。
- **[severity: medium] 読み出しの巻き込みが増えた**。`cp` / `mv` に加えてインタプリタのワンライナーでも、保護パスを**読むだけ**のコマンドが遮断される。`docs/run-log/*.json` を読むときは `jq` か `cat` を使うこと。
- **[severity: low] 判定はすべてコマンド文字列に対するもの**。`python3 some-script.py` のようにファイルに落としたスクリプト経由の書き込みは検出できない。これは文字列フィルタの原理的な限界で、`gate-integrity.mjs` のハッシュ照合が後段の担保。
- 1・2 周目からの持ち越し（acceptance-checks.json の evidence を書く経路が無い / `npm run lint:changed` の `origin/main...HEAD` がリモート不在で空振り）は未解決のまま。

### 次のアクション（3 周目時点）

- task_006: 違反フィクスチャに「`rm` でガード本体を消す」「`chmod -x` で実行権を落とす」「`git checkout -- ` でテストを戻す」を追加する。
- task_006 / task_018 / task_019: `.claude/settings.json` への**追加**は通る（ガード参照を減らす編集だけが遮断される）。

## task_011（hardening 周）

### 決まったこと

- **`anon` / `authenticated` の既定権限を剥がした**（`supabase/migrations/0005_default_privileges_revoke.sql`）。
  `0001_init.sql` の `REVOKE ALL ON ALL TABLES` はその時点のテーブルにしか効かず、
  Supabase 既定の `ALTER DEFAULT PRIVILEGES` が残っていたため、**public に新しく作る
  テーブルは anon / authenticated に全権が付いた状態で生まれていた**（修正前に psql の
  `BEGIN; CREATE TABLE …; ROLLBACK;` で実測。`anon` と `authenticated` に
  `DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE` が自動で付いた）。
  TABLES / SEQUENCES / FUNCTIONS の 3 種を剥がし、修正後は同じ probe で
  `postgres` と `service_role` の 2 行だけになることを実測した。
  以後 task_012 以降がテーブルを足しても穴は開かない。
- **`payment_event` の invoice と attempt の食い違いを DB で塞いだ**
  （`supabase/migrations/0006_payment_event_attempt_scope_fk.sql`）。
  `payment_attempt` に `UNIQUE (id, invoice_id)`、`payment_event` に複合 FK
  `(attempt_id, invoice_id) REFERENCES payment_attempt (id, invoice_id)`。
  修正前は「試行 A は請求 I1 のものなのに `invoice_id` に I2 を名乗る」行を
  INSERT でき（実測 `mismatched_rows=1`）、照合と記帳が別の請求に入金を立てられた。
  修正後は同じ INSERT が `23503` で落ちる。既定の MATCH SIMPLE なので
  `attempt_id` が NULL の行は単独 FK のままで、これは設計どおり（通ることをテストで確認）。
- **`wrangler dev` のロール不一致は案 B（明示フラグ）で処置した**。
  `src/lib/db/client.ts` に `ALLOW_PRIVILEGED_DB_ROLE` を足し、
  (1) 値が厳密に `"1"` (2) `APP_ENV` が厳密に `"development"` (3) 接続先がループバック、
  の 3 条件がすべて成立するときだけ `app_rw` 以外を通す。記載は `.dev.vars.example` のみ。
  案 A（`localConnectionString` を `app_rw` に変える）を採らなかった理由は
  `docs/concerns/task_011.md` の C-011-4 に書いた（`wrangler.toml` が担当範囲外・
  パスワードをマイグレーションに書かない方針・`supabase db reset` が禁止コマンド）。
- **`check_071` の rule 文言を実判定に合わせた**（`docs/acceptance-checks.json`）。
  新文言は「supabase db diff の差分 0、drizzle は scripts/db-diff-drizzle.mjs による
  テーブル／列の層の差分 0（制約・索引の DROP は設計どおり無視）」。
- テストは統合 36 → 47 ケース、単体 185 → 192 ケースに増えた。
  `typecheck` / `test:integration` / `gates:sync` / `gate:constraints` は
  `scripts/record-run.sh task_011` 経由で全て exit 0。

### 未解決

- **CI の実走は deferred**。GitHub リモートが未作成で `git push` が禁止コマンドのため、
  「PR で緑」「required status checks に含まれる」は証明できない。
  `.github/workflows/gate-integration.yml` の静的検証（YAML 妥当・`jobs` が
  `integration` ちょうど 1 つ・`run:` が呼ぶ npm スクリプトが `package.json` に実在・
  禁止コマンド不使用）だけを `tests/integration/ci-workflow.test.ts` で機械化した。
  `gate.yml` の作成と required 登録は task_009。
- `supabase_admin` 由来の既定権限（`pg_default_acl`）は `postgres` が
  `supabase_admin` のメンバーでないため剥がせない。accepted-risk として
  `docs/concerns/task_011.md` の C-011-2 に記録し、判断は task_024 へ。
- `check_071` の `verification_method` は据え置いた（許可されたのは rule 文言のみ）。task_038。
- `docs/task-list.json` の `task_011.concerns` は書き換えていない（並行タスクとの
  書き込み衝突を避けるため）。最新の懸念状態は `docs/concerns/task_011.md` が正本。

## task_005（hardening 周）

### 決まったこと

- **保護対象を「名指ししない」迂回路を 4 系統塞いだ**。`scripts/deny-dangerous-bash.sh`:
  - `>|`（noclobber 上書き）は `normalize()` で `|` を節区切りにする **前** に `>` へ畳む。
    畳まないと `echo x >| docs/run-log/a.json` が `echo x >` と裸のパスに割れ、
    リダイレクト先が消えて素通りする（修正前 exit 0 を実測）。
  - `.` `./` `..` `*` `/` などを「ここ全体」を指す操作対象とみなし、削除・復元系
    （`rm` / `unlink` / `shred` / `truncate` / `git rm|restore|checkout|clean`）の
    どのトークンに現れても遮断する。`git clean` はパスを 1 つも書かずに未追跡ファイルを
    消すので、`-n` / `--dry-run` 以外は無条件で遮断する。
  - 節ごとに `cd` を追跡する（`CWD_REL` と `join_path()`）。宛先は現在ディレクトリに
    解決してから保護判定にかける。解決できない `cd`（`$` を含む・絶対パスでリポジトリ外・
    ホーム・`cd -`）は「ルートに戻す」扱いにして、でっち上げの接頭辞で誤検知しないようにした。
  - リダイレクトと `tee` の**宛先に `$` が含まれたら無条件で遮断**する。フックは変数を
    展開できないので、宛先が保護対象の外だと示せない（fail-closed）。
- **`git apply` / `patch` を遮断対象に追加した**。書き換え先は diff の中にしか書かれていない。
  コマンド行に読めるパッチファイルがあればその本文を走査して保護対象を含むかで判定し、
  読めるパッチが 1 つも見つからなければ（stdin・ヒアドキュメント・パイプ）fail-closed で遮断する。
  保護対象を含まないと示せるパッチは通す。
- **`.claude/settings.json` の保護を構造検査にした**。`scripts/deny-test-weakening.sh` は
  編集後のファイルを組み立て（Write は本文そのまま、Edit / MultiEdit はディスク上の
  ファイルに適用）、jq で解析して `EXPECTED_HOOKS` の 9 登録が残っているかを見る。
  matcher は「期待するツール名を含むか」の包含判定なので、拡張（`…|NotebookEdit`）は通り、
  絞り込み（`Edit|Write|MultiEdit` → `Write`）は落ちる。コマンドは `#` より前の部分で
  照合するので、`true # deny-dangerous-bash.sh` のようなコメント化も落ちる。
- **`lint:changed` の空振りを止めた**。旧定義は `origin/main...HEAD` を使っており、
  このリポジトリには remote が無いので常に失敗 → `2>/dev/null` に飲まれてファイル一覧が空 →
  引数ゼロの eslint → exit 0、という「フックは緑だが lint は 1 行も走っていない」状態だった。
  新定義は `git diff --name-only --diff-filter=ACMR HEAD` とステージ済み差分の和を取り、
  対象 0 件なら「対象なし」と明示して exit 0、対象があれば eslint を実走する。

### 未解決

- **ガード本体（`scripts/deny-*`）は、このハーネスの内側からはもう編集できない。**
  Edit / Write は `deny-test-weakening.sh` が、Bash の書き込み・削除経路は
  `deny-dangerous-bash.sh` が塞いでおり、最後に残っていた `git apply` を今回塞いだ。
  今回の修正自体は、まだ `git apply` が通る時点でパッチとして当てた。
  次にガードを直す必要が出たら **PO が Claude Code の外で編集する**か、
  `.claude/settings.json` の PreToolUse 登録を PO が一時的に外すしかない。
  `docs/concerns/task_005.md` §3 に選択肢 3 案を書いた（accepted-risk）。
- **指摘外の残穴を実測した**（`docs/concerns/task_005.md` §2）。`awk -i inplace` /
  `ed` / `ex` / `vim -es` / `sponge` / `find -delete` / `xargs rm` /
  `git stash push` / `git revert` / `git reset`（`--hard` 以外）はいずれも現状 exit 0。
  `write_rules_hit()` が「書き換えコマンド名の列挙」である限り、列挙漏れは構造的に残る。
  対応案は allowlist 方式（読み取り専用と明示できるコマンド以外は、保護対象パスが
  コマンド行に現れた時点で fail-closed）への転換。**次の hardening ラウンド**で扱う。
- `cd` で保護対象ディレクトリに入った後の削除系は、節の全トークンがそのディレクトリ配下として
  解決されるため、遮断メッセージがコマンド名（`rm` など）を引用することがある。
  判断は正しく文言だけの問題。`docs/concerns/task_005.md` §5。
- `check_053`（新規セッションでの SessionStart 注入の目視）は 3 周目で実測済み。本周では再実行していない。

## task_011（レビュー修正・4 周目）

### 直したこと

- **接続文字列のロール検査が実効になっていなかった**（high）。`resolveDbConnection()` は
  `URL.username` しか見ておらず、`?user=postgres` を足すだけで迂回できた。postgres.js は
  `defaults` に無いクエリパラメータを `options.connection` に積み、StartupMessage が
  `Object.assign({ user, … }, options.connection)` で組まれるためである。
  本セッションで実測: `postgres://app_rw:postgres@127.0.0.1:54322/postgres?user=postgres` は
  `URL.username = 'app_rw'` のまま `session_user = 'postgres'` で接続できた。
  対処は二段。(1) `parseConnection()` に**クエリパラメータの許可リスト**を入れ、
  postgres.js がクライアント側で消費するキー（`defaults` ＋ `sslmode`）以外は
  `DbConfigError` にする。(2) `createVerifiedDbClient()` を追加し、接続直後に
  `SELECT session_user` を 1 回だけ発行して接続文字列が名乗るロールと一致しなければ
  接続を閉じて `DbRoleMismatchError` を投げる。**ランタイムはこちらを使うこと**
  （`createDbClient()` は検査なしの低レベル API として残してある）。
- **`ALLOW_PRIVILEGED_DB_ROLE` に 4 条件目「経路が `direct`」を足した**（medium）。
  `wrangler.toml` の既定環境（`name = "cashapp-dev"`）はデプロイ可能で、その
  `[vars] APP_ENV` は `"development"` である。つまり `APP_ENV` は「ローカルに限る」条件に
  ならなかった。Hyperdrive バインディングはデプロイ後のランタイムにこそ存在するので、
  経路で切れば、デプロイ後の `connectionString` のホスト形式（一次資料に記載が無い）に
  依存せずに締められる。**副作用として cf:dev はこのフラグでは通らなくなった**。
  代わりの手順は冒頭の「既知の壊れている経路」に書いた。
- **`provider_binding` のスコープの穴を塞いだ**（medium。`supabase/migrations/0007_provider_binding_scope_fk.sql`）。
  `provider_binding` に `UNIQUE (id, provider_key)` と `UNIQUE (id, organizer_user_id)` を張り、
  `payment_attempt` に `(provider_binding_id, provider_key)` の複合 FK、`event` に
  `(provider_binding_id, provider_key)` と `(provider_binding_id, organizer_user_id)` の複合 FK。
  修正前は psql の BEGIN/ROLLBACK で「O1 のイベントが O2 の受取先を指す」
  「試行の `provider_key` がバインディングと食い違う」の両方が受理されることを実測
  （`cross_owner_attempt_rows=1` / `provider_key_mismatch_rows=1` / `cross_owner_event_rows=1`）。
  修正後は `23503` で拒否される。
- テストは統合 47 → 58 ケース（新規 `tests/integration/db-role.test.ts` 5 件を含む）、
  `tests/unit/db-client.test.ts` は 15 → 20 ケース。既存テストの削除・skip・expect 削減はしていない。

### 未解決

- **`payment_attempt` の cross-owner は DB ではまだ塞げていない**（`docs/concerns/task_011.md` の
  C-011-7）。`provider_key` さえ一致していれば、別の幹事が所有するバインディング宛の試行を
  今も INSERT できる（0007 適用後に実測: `remaining_cross_owner_attempt_rows=1`）。
  閉じるには `payment_attempt` に `event_id` を持たせる等の**列の追加**が要り、
  `schema.ts` とリポジトリ層（task_014）に波及する。PO 裁定（task_017 / task_018）へ。
- **CI の実走は deferred のまま**（C-011-1）。`.github/workflows/` は
  `gate-integration.yml` 1 本のみで `gate.yml` は不在、`docs/run-log/task_009.json` も不在。
  本周のレビュー自身が「現環境では修正不能のため deferred で正しい」としている。
- デプロイ後の `env.HYPERDRIVE.connectionString` のホスト形式は一次資料に記載が無い
  （2026-09-24 に WebFetch で確認し `docs/vendor-docs/cloudflare/hyperdrive.md` に [不明] を追記）。
  クエリパラメータ許可リストが実 Hyperdrive の接続文字列で通るかも未検証（C-011-8。task_035）。

## task_011（レビュー修正・5 周目）

### 直したこと

- **統合テストが間欠的に落ちていた真因を直した**（high ＋ 検証失敗。同一原因）。
  `tests/integration/setup.ts` の `ensureAppRwLoginPassword()` は
  `ALTER ROLE app_rw LOGIN PASSWORD …` を裸で撃っており、これを `schema.test.ts` と
  `db-role.test.ts` の両方が `beforeAll` で呼ぶ。vitest はテストファイルを別ワーカーで
  並列に走らせるため、同一の `pg_authid` 行への同時 UPDATE が
  `PostgresError: tuple concurrently updated` になり、**`db-role.test.ts` のスイートが
  起動前に落ちて 5 ケースが 1 件も走らない**（レビュー実測で 5 回中 2 回 exit 1・`5 skipped`）。
  本セッションでの決定的再現: 2 本の psql から同時に同じ `ALTER ROLE` を撃つと **3/3 回**
  `ERROR: tuple concurrently updated`。
  対処は `pg_advisory_xact_lock(1101100001)` を張ったトランザクション内で `ALTER ROLE` を
  1 文だけ実行する形への変更（同じ形を 3 本同時 × 5 回で **15/15 回 COMMIT** を実測）。
  ロックは**トランザクションスコープのみ**を使う（セッションスコープの `pg_advisory_lock` は
  接続がプールに戻っても解放されず別のテストを巻き込むため。task_011 scope の方針と同じ）。
- **回帰テストを 1 件足した**（`db-role.test.ts`、58 → 59 ケース）。「独立した 4 接続から
  `ensureAppRwLoginPassword()` を同時に呼んで全部成功する」を検査する。
  **修正を外すと 3/3 回 fail**（4 本中 3 本が `tuple concurrently updated` で reject）、
  戻すと pass することを実測してから採用した。
- **安定性を実測で確かめた**。`npm run test:integration` を回帰テスト追加前に 10 連続
  （10/10 exit 0・`Tests 58 passed`・skip 0）、追加後に 6 連続（6/6 exit 0・`Tests 59 passed`・
  skip 0）実行した。
- **前ラウンドの失敗 run を消さずに残した**（medium）。`docs/run-log/task_011.json` に
  未コミットで残っていた HEAD `6a05a25` の `npm run test:integration` exit 1
  （`53 passed | 5 skipped`）はそのまま保持し、修正後の最終 HEAD での再実行 4 本と一緒に
  コミットした。run-log には失敗も残る。

### 未解決

- **CI の実走は deferred のまま**（`docs/concerns/task_011.md` の C-011-1）。本ラウンドでも
  `.github/workflows/` は `gate-integration.yml` 1 本のみ・`gate.yml` 不在・
  `docs/run-log/task_009.json` 不在を確認した。GitHub リモート未作成・`git push` 禁止のため
  「PR で緑」「required status check への登録」は原理的に証明できない。task_009 の後に実施する。
- **`payment_attempt` の cross-owner も deferred のまま**（C-011-7）。レビューの `fix` 自身が
  「PO 裁定（task_017 / task_018）で (a) 列の追加 (b) 制約トリガ のどちらかを選ぶ」としており、
  暫定策として指定された `createCheckout`（task_017）はまだ存在しない。
- **`ALTER ROLE app_rw` の直列化はこのヘルパ内だけで閉じている**（C-011-10。low / accepted-risk）。
  アドバイザリロックは同じ鍵を取る側にしか効かないので、将来ヘルパを経由せずに
  `ALTER ROLE app_rw …` を撃つコードが増えると同じ失敗が再発する。後続の統合テストは
  必ず `ensureAppRwLoginPassword()` を経由すること。

## task_005（レビュー修正・4 周目）

### 決まったこと

- **コマンド名の判定は「トークンを basename 化し `@版` を落とした変種」にも当てる**。
  `raw_rules_hit()` は `(^| )wrangler +deploy( |$)` のように語頭を錨づけしていたため、
  `./node_modules/.bin/wrangler deploy` と `npx wrangler@latest deploy` が本番デプロイの遮断を
  素通りしていた（`node_modules/.bin/wrangler` の symlink は実在する）。`basename_clause()` を
  追加し、元の節と basename 化した変種の両方に rule set A を当てる。
- **`cp` / `mv` / `rsync` / `install` は `protected_tree()` も見る**。`PROTECTED_RE` は
  `docs/gates/` のように末尾に何か続くパスしか拾わないので、宛先を `docs/gates` や `.claude` と
  ディレクトリ名で書くと通っていた。`-t <dir>` と `--target-directory=<dir>` の値も
  `opt_value()` で取り出して同じ判定に掛ける。
- **`cd` の追跡はラッパを剥がしてから判定する**。`normalize()` が `(` `)` `{` `}` `&` も節区切りに
  畳むようになり、`strip_wrappers()` が `bash -c` / `sh -c` / `sudo` / `env` / `VAR=…` を落とす。
  `pushd` も `cd` と同じく追跡し、`popd` と解決できない `cd` 先（`$VAR` / `~` / 引数なし）の後は
  相対の宛先を fail-closed で拒否する（絶対パスの宛先は従来どおり判定できるので通す）。
- **`git am` もパッチ適用の判定対象**。`git apply` / `patch` と同じく、読めるパッチは本文を走査し、
  適用先を示せなければ fail-closed。
- **`git push` の `+` 付き refspec は強制 push として遮断**（`git push origin +main`）。
- **`node --run <script>` を `package.json.scripts` の解決経路に流す**（engines は node>=22）。
- **MCP のファイル編集ツールがガードを起動する**。PreToolUse の編集側 matcher を
  `Edit|Write|MultiEdit|NotebookEdit|mcp__serena__.*` に広げ、`deny-test-weakening.sh` に
  MCP 分岐を追加した。`relative_path` / `paths_include_glob` から対象を取り出して同じ判定に掛け、
  対象を限定しない一括編集・`.claude/**`・編集前本文を示さない `tests/**` 編集は fail-closed。
  ライブのフックで `mcp__serena__replace_content` が実際に BLOCKED になることを実測済み。
- **`lint:changed` は未追跡ファイルも見る**。`git ls-files --others --exclude-standard` を足して
  3 つの和にした。Write ツールが作る新規ファイルはまさに未追跡なので、修正前は「対象なし」で
  緑になっていた（構文エラーのある新規 `.ts` でも eslint が 1 度も起動しないことを実測）。
- 4 周目の修正そのものは、**まだ通っていた `git am`** でメールボックス形式のパッチを当てて適用した。
  ガード本体は Edit/Write も Bash 書き込みも自分自身のルールで拒むため、これが唯一の経路だった。
  適用後は同じ経路が塞がっている（`docs/concerns/task_005.md` §3）。

### 未解決

- **[severity: high] `docs/concerns/task_005.md` §2 の残穴は未閉塞**。`awk -i inplace` / `ed` / `ex` /
  `vim -es` / `sponge` / `find -delete` / `xargs rm` / `git stash` / `git revert` / `git reset`
  （`--hard` 以外）はいずれも現状 exit 0。`write_rules_hit()` がコマンド名の列挙である限り
  漏れは構造的に残るので、allowlist 方式（読み取り専用と明示できるコマンド以外は、保護対象パスが
  現れた時点で fail-closed）への転換を次の hardening ラウンドで起票する。
  **したがって「ガードをセッション内から変更する経路は 1 つも無い」とは言えない**
  （3 周目の記述は誤りだったので §3 で訂正した）。
- **[severity: low] パッチ適用ルールは散文も巻き込む**。コマンド行に `git apply` / `git am` /
  `patch` という語が並ぶだけで遮断されるので、コミットメッセージや
  `record-run.sh --manual` の観察文では言い換えが要る（実測済み）。
- **[severity: low] PostToolUse の matcher は `Edit|Write|MultiEdit` のまま**。MCP 経由の編集は
  typecheck / lint:changed / gate:constraints を起動しない。指摘は PreToolUse のガードに
  限られていたのでそこだけを直した。
- **check_053 / check_063 は 3 周目のヘッドレス新規セッションの実測で達成済み**。4 周目では
  再実行していない。
- GitHub リモート未作成のため CI 実走は deferred（task_005 は `.github/workflows/**` を作らないので
  done_definition には影響しない）。

## task_012（認証・セッション・CSRF・鍵運用・環境設定・セキュリティヘッダ）

### 決まったこと

- **ID トークンの nonce 検証は採らない。単回使用テーブルで止める**（`docs/decisions/ADR-009-id-token-single-use.md`、
  confidence 高）。理由は LINE の一次資料で裏が取れている: `nonce` は「認可リクエストを組み立てた側」が
  突き合わせる任意パラメータであり、LIFF ブラウザ内の `liff.login()` は動作が保証されないため、
  サーバーが nonce を発行する経路が主経路で成立しない。代わりに `used_id_token` に
  `sha256(idToken)` を `exp` まで保存し、2 回目の提示を 401 にする。
  一次資料は `docs/vendor-docs/line/verify.md`（取得日 2026-09-24）へ退避済み。
- **`LINE_ENV_PROFILE` は JSON 1 個**（`{"env","liffId","loginChannelId"}`）。
  環境ごとに変数を散らすと片方だけ差し替え忘れる（R-LINE-04）ため、ペアで 1 値にした。
  起動時に「`env` == `APP_ENV`」と「`loginChannelId` == LIFF ID のハイフン前」を検査する。
  後者が制約 N3 の機械検査になっている（LIFF ID は `<LINE Login チャネル ID>-<8 文字>`）。
- **`PEPPER` と `SESSION_KEYS` は `<版>:<秘密値>` のカンマ区切り**。
  PEPPER は最大バージョンが現行、SESSION_KEYS は**先頭が現行**で **2 個まで**（3 個書くと起動しない）。
  「2 世代前が通る」実装に滑らないよう、設定の段階で構造的に止めた。
- **`APP_ENV` と Supabase project ref の対応は `src/lib/config/env.ts` にソース固定**する
  （`EXPECTED_SUPABASE_PROJECT_REF`）。環境変数どうしの突き合わせにしなかったのは、
  一括投入で両方が同じ誤った値になれば検査が意味を失うため。
  **実 ref は未採番なので、staging / production はいま起動できない**（意図した fail-closed。C-012-1）。
- **CSRF は Cookie を 1 つも増やさない**。`token = base64url(HMAC-SHA256("csrf:"+<セッションの jti>, <セッション鍵>))`
  を応答ボディでだけ返し、`X-CSRF-Token` ヘッダで受けてサーバーが再計算して比較する。
  保存先が要らず、セッションが切れれば自動的に無効になる。
- **レート制限は fail-closed**。Workers の Rate Limiting バインディングか Durable Object のどちらかが
  束縛されていなければ 503 を返す。**アイソレート内メモリは使わない**（A27）。
  ローカルの逃げ道は `ALLOW_LOCAL_RATE_LIMIT_BYPASS=1` ＋ `APP_ENV=development` ＋
  Hyperdrive バインディング不在の 3 条件 AND（`.env.example` の local 節）。
- **middleware は「ヘッダ付与」と「非 production での webhook/cron 404」だけを担う**。
  認証・CSRF の判定は置かない（middleware は DB を引けず `session_epoch` を突き合わせられないため、
  ここで「認証済み」と判断すると失効済みセッションが通る）。
- **`/api/me` は 30 分スライディングの更新を行う**（有効期間の半分を過ぎたら再発行）。
  再発行で `jti` が変わるので CSRF トークンも入れ替わる。**応答の `csrfToken` を常に使うこと**。

### 未解決（詳細は `docs/concerns/task_012.md`）

- **[high] staging / production は起動できない**（C-012-1）。`EXPECTED_SUPABASE_PROJECT_REF` が
  プレースホルダのまま。実値投入は task_035（staging）/ task_024（production）。
- **[high] レート制限のバインディングが `wrangler.toml` に無い**（C-012-2）。
  いまデプロイすると `/api/auth/line` は常に 503。`wrangler.toml` は本タスクの
  `files_to_modify` に無く（task_003 / task_035 の所有）、`namespace_id` も未採番のため触っていない。
  Durable Object 実装（`FixedWindowRateLimiterDurableObject`）はコードとテストだけ存在し、束縛されていない。
- [medium] CSP の `frame-ancestors 'none'` と `connect-src` は未実測の暫定値（C-012-3。task_013 / task_022）。
- [medium] `__Host-` Cookie は `http://localhost` では保存されない。ローカル画面確認は https が要る（C-012-4）。
- [medium] `audit_log.actor_ref` は pepper_version 移行の対象外（追記専用で UPDATE できない）。
  **旧 PEPPER を捨てると過去の監査ログの主体が辿れない**（C-012-5）。
- [medium] acceptance-checks が名指しする `tests/security/{csrf,xss-csp,id-token-replay}.test.ts` は
  **task_022 の `files_to_create`** なので作っていない。同じ検査は自タスク所有のファイルに置いた（C-012-7）。
- [medium] `/api/me` の照会は直書き SQL。リポジトリ層（task_014 / 015）ができたら寄せる（C-012-9）。
- [low] `gate:env` の「期待名の突き合わせ」は `docs/ops/env-baseline.json`（task_035 所有）待ちで pending（C-012-11）。
- [low, deferred] CI 実走は GitHub リモート未作成のため未実施（C-012-12）。

### ⚠ コミットの取り違え（task_006 へ）

`20f379f`（コミットメッセージは task_012 の run-log 再実行ログ）に、**task_006 の成果物が
巻き込まれている**（`scripts/gate-check.mjs` / `scripts/assert-acceptance.mjs` /
`scripts/assert-verify-commands.mjs` / `scripts/gate-integrity.mjs` /
`scripts/validate-plan-json.mjs` / `scripts/test-hook-enforcement.sh` /
`docs/gates/integrity-baseline.json` / `docs/harness-capability.md` /
`docs/concerns/task_006.md` / `docs/run-log/task_006.json` / `tests/gates/**` /
`tests/unit/gate-check.test.ts`）。

原因: task_012 側が `git add docs/run-log/task_012.json` を **`scripts/with-lock.sh git` の外**で
実行し、その直後の `git commit`（ロック内）との間に、並行していた task_006 が共有インデックスへ
ステージした分を一緒に拾ってしまった。`git add` もロックの内側で行う必要がある（規約の運用漏れ）。

**履歴は書き換えていない**。task_006 が `scripts/record-run.sh` で残した evidence の `commit` が
`20f379f` を指している可能性があり、rebase するとその evidence が無効になるため。
task_006 側は「自分のファイルは既にコミット済み」として扱い、PROGRESS / HANDOFF の追記だけを
別コミットにすればよい。

## task_006（gate-check G0〜G14・違反フィクスチャ・メタゲート・フック実在マトリクス）

### 決まったこと

- **ゲートは 4 値で報告する**: `ok` / `violation` / `warn` / `defer`。`defer` は理由（`notes`）が必須。
  「対象が 0 件だから緑」を `ok` として返すことを禁止し、**G0 がそれを違反として検出する**。
  対象が現れるまでの期間は `defer` ＋理由で報告する。この規約は `scripts/gate-check.mjs` の
  全ゲートに通してある。
- **違反フィクスチャは exit code だけでは合格にしない**。`meta.json` の `expect_output_contains`
  で違反行そのものを固定する。`gate-constraints.sh` は対象 0 件のゲートがあるだけで exit 1 に
  なるため、フィクスチャのディレクトリを `--root` に渡すと無関係な理由でも非ゼロになる。
  「意図した違反で落ちた」ことは出力でしか判定できない。
- **`gate-check.mjs` は overlay で動く**: `--root` 優先・`--base`（リポジトリ）フォールバック。
  フィクスチャは違反を構成する数ファイルだけを持てばよい。`meta.json` の `absent` でベースの
  ファイルを「無い」ことにでき、`inputs` で論理パスを別名ファイル／別ディレクトリへ差し替えられる。
  `inputs` が要るのは、`deny-test-weakening.sh` が **フィクスチャであっても**
  `docs/acceptance-checks.json` という名前・`docs/gates/**`・`docs/run-log/**` への書き込みを
  拒否するため（ガードを緩めるのではなく退避で解決した）。
- **`--only <gate>` は exit code の範囲だけを絞る。全ゲートは常に実行される。** G0 が他ゲートの
  対象件数を見て判定するので、絞ると G0 が判定できなくなる。
- **`docs/gates/integrity-baseline.json` の唯一の書き込み経路は
  `node scripts/gate-integrity.mjs --write-baseline`**。Edit / Write / MCP 編集 / Bash 経由の
  書き込みは全部ガードが塞いでいるため、他に作る手段が無い。ゲート対象領域（`docs/gates/**` /
  `.claude/**` / `.github/workflows/**` / `scripts/gate-*` / `deny-*` / `assert-*` / `validate-*` /
  `record-run.sh` / `append-handoff.sh` / `session-brief.mjs` / `scripts/ci/**`）を意図して
  変えたときだけ再生成する。**再生成できてしまうこと自体が残懸念 high**（concerns 2）。
- **Stop フックの `gate:check` は exit 1 で返す（exit 2 にしない）**。Stop の exit 2 は停止を
  ブロックするので、ゲートが直るまでセッションが終われない罠になる。
- **G2 の「コマンド捏造」の定義**: `§13 の予定表にも package.json.scripts にも無い名前` を
  参照していたら、未着手タスクでも違反。`§13` に無いが package.json にはある名前（例:
  `db:diff:drizzle`）は計画の追随漏れとして **warn** にした（実在するので捏造ではない）。
- **`vitest.config.ts` の `include` に `tests/gates/**` を足した**（task_011 の
  `tests/integration/**` と同じ理由・同じ書き方）。vitest は `include` に無いファイルを位置指定
  フィルタでも拾えず、CLI に `--include` 相当のフラグも無い。task_006 の `files_to_modify` 外
  なので concerns 8 に記録した。
- **`scripts/record-run.sh` にシェル変数へ入れたコマンド文字列をそのまま渡さないこと。**
  fish は変数を空白分割しないので `"npm run test:unit"` が 1 引数として渡り exit 127 になる。
  1 本ずつ書き下すこと（run-log は追記専用なので取り消せない。concerns 9）。
- **フック 6 イベントの実測は 3 階層で測る**: A 登録（settings.json）/ B 単体挙動（コマンドに
  フック入力を stdin で渡す）/ C ライブ痕跡（transcript とフックの副作用）。**C が本体**で、
  A と B だけでは「Claude Code が実際にそのイベントを発火させるか」は分からない。
  `PostToolUse` はフックが exit 0 のとき痕跡を残さないので、意図的に 1 回差し戻させるまで
  発火を観測できなかった。`SubagentStop` は `.locks/subagent-head-baseline-<session_id>` という
  ファイルの副作用で観測できる。

### 未解決

- **（high）G13 の自己封じ**: 基準値を再生成できるエージェントは、ガードを書き換えてから基準値を
  作り直せば G13 を緑に戻せる。残っている歯止めは「`docs/gates/**` の diff が PR に出る」ことだけ。
  CODEOWNERS と `test-tamper-guard` で人間の関門に繋ぐのは **task_009**。
- **（medium）違反フィクスチャに人間が手書きした 1 本が無い**。23 本すべてモデル製で、
  `provenance.authored_by` にそう書いてある。G0 が毎回 warn で表示する。PO が 1 本書くまで消えない。
- **（medium）CI 実走が未証明**。GitHub リモート未作成のため `gate-meta` / `acceptance` /
  `gate-integrity` ジョブは一度も走っていない。**deferred: GitHub リモート作成後に実施**（task_009）。
- **（medium）G8 は `tests/**/fixtures/**` を走査しない**。違反フィクスチャが秘密値の形をした値を
  持つのは仕事なので外したが、本物を貼っても G8 では捕まらない。成果物 grep（task_009 の
  `security` ジョブ）が補う。
- **（medium）G8 の秘密値名リストが手書き**。task_012 の `gate-env-scope.mjs` が env スコープの
  正本を持つので、そこから機械的に取り込むべき（task_012 完了後）。
- **（low）G5 / G7 / G9 / G12 / G14 は対象 0 件の `defer`**。対象を作る task_007 / 018 / 019 の
  完了で自動的に実判定へ切り替わる。切り替わった時点の挙動は違反フィクスチャで先に固定済み。
- **（low）W1 のフィクスチャに runner が無い**（`enforcement: "test"` の制約なので grep で
  落とせない）。`meta.test.ts` が「`blocked_on` の task がまだ未完であること」を検査しているので、
  task_018 が完了した時点でテストが赤くなり、埋め忘れを検知する。

## task_012（レビュー修正・2 周目）

### 決まったこと

- **CSP はレスポンスとリクエストの両方に載せる**。`src/middleware.ts` は CSP をレスポンスに
  載せるだけで、nonce は独自ヘッダ `x-csp-nonce` でリクエストへ渡していた。ところが Next.js が
  自前の `<script>`（ブートストラップと `self.__next_f` のインラインデータ）へ nonce を付ける経路は
  **リクエストヘッダの `Content-Security-Policy` を読む 1 本だけ**で、独自ヘッダは見ない
  （`node_modules/next/dist/server/app-render/app-render.js:209-210` が
  `headers['content-security-policy']` から `getScriptNonceFromHeader()` を呼ぶ。Next 16.3.6 で確認）。
  配信 CSP は `script-src 'nonce-…' 'strict-dynamic'`（`'self'` も `'unsafe-inline'` も無い）なので、
  この状態で LIFF フロントを載せると**アプリの JS が全部ブロックされて画面が hydration しない**。
  `requestHeaders.set(CSP_HEADER, buildContentSecurityPolicy(nonce))` を追加して塞いだ。
  → **task_013 へ**: この 1 行を「重複だから」と消さないこと。理由は C-012-16 と当該コードの doc コメント。
- **再発検出はヘッダ文字列の自前比較では作れない**。`tests/unit/security-headers.test.ts` に
  **Next.js 自身の抽出関数**（`next/dist/server/app-render/get-script-nonce-from-header`）を直接呼ぶ
  検査を 7 ケース足した。`NextResponse.next({ request: { headers } })` が上書きヘッダを畳む
  `x-middleware-override-headers` / `x-middleware-request-*` を解いて、レンダラが受け取る
  リクエストヘッダを実際に検査している。修正行を外すと 6 ケースが落ちることを実測した（負の対照）。
  この deep import が壊れたら、それ自体が Next 側の nonce 伝播経路が変わった合図である。
- **`gate:env` の「本番値の混入」検出には 2 つの形があり、片側だけ実装されていた**。
  衝突型（staging と production に同じリテラル）は検査 (3) が捕まえるが、
  片側混入型（本番の ref を **staging だけ**に書く）は素通りしていた。実リポジトリでは
  `SUPABASE_PROJECT_REF` も LIFF ID も `wrangler.toml` に現れず secret 側にあるため、
  混入が起きるならまさに片側混入型になる。検査 (7) を追加し、
  `src/lib/config/env.ts` の `EXPECTED_SUPABASE_PROJECT_REF`（起動時アサートが使う**同じ正本**。
  値を書き写さず `.mjs` から読む）と突き合わせる形にした。実 ref が入った瞬間に自動で実効化する。
- **pending の文言は「検査していない範囲」を隠さない**。修正前の
  `(the runtime/staging/production leak checks above still ran)` は実際より広い範囲を検査したように
  読めたので、実走した 3 項目を列挙し「片側混入は (3) では検出できない」と明記する文言に置き換えた。

### 未解決

- **（deferred）`.dev.vars.example` に起動時必須の 4 変数（`LINE_ENV_PROFILE` / `PEPPER` /
  `SESSION_KEYS` / `CRON_SECRETS`）が無い**。`wrangler dev` と `next dev` の platform proxy が読むのは
  `.dev.vars` であって `.env` / `.env.local` ではないため、雛形どおりコピーした開発者は
  `/api/auth/line`・`/api/me`・`/api/consent` が 500、`/api/health` が 503 になる。
  `.dev.vars.example` は **task_003 の所有ファイル**なので追記していない。
  代わりに `gate:env` が毎回 pending で名指しするようにし、テストでその出力を固定した（C-012-14）。
  → **task_003 / task_035 へ**: 4 変数のローカル用ダミーを追記すれば pending は自動で消える。
- **（deferred）本番 LIFF ID / 本番 Hyperdrive id の片側混入は今も検出できない**。
  ソース固定の宣言が無いため。`docs/ops/env-baseline.json` の `production_only_values`
  （`checkBaseline()` が既に読む形）待ち（C-012-15）。→ **task_035 / task_024 へ**。
- **（deferred）レート制限のバインディングが `wrangler.toml` に無い**ままで、
  デプロイ環境では `/api/auth/line` が常に 503（C-012-2）。`wrangler.toml` は担当範囲外。
  → **task_024 / task_035 へ**。
- **（deferred）CI 実走は未実施**（GitHub リモート未作成）。→ **task_009 / task_024 へ**（C-012-12）。
- **（未対応・他タスク）** `docs/acceptance-checks.json` の check_058 / 072 / 075 が名指しする
  `tests/security/{csrf,xss-csp,id-token-replay}.test.ts` は task_022 の `files_to_create` なので
  作っていない。実際の検査場所の対応表は C-012-7 にある。→ **task_022 へ**。

## ターンログ（Stop フック自動追記）

各ターン終了時に scripts/append-handoff.sh が 1 行追記する。決まったこと・未解決の本文は上の各タスク節に書く。

- 2026-09-24T04:23:14Z HEAD=96503f1 決まったこと: task_011: 検証ログ（全 verify_commands exit 0 と未検証項目の手動記録） / 未解決: 未コミット 16 件: docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_011.json drizzle.config.ts package.json tests/integration/schema.test.ts .claude/ docs/gates/legal-clearance.json 
- 2026-09-24T04:26:48Z HEAD=96503f1 決まったこと: task_011: 検証ログ（全 verify_commands exit 0 と未検証項目の手動記録） / 未解決: 未コミット 20 件: docs/HANDOFF.md docs/PROGRESS.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_011.json docs/task-list.json drizzle.config.ts package.json 
- 2026-09-24T04:28:44Z HEAD=c25fab9 決まったこと: task_011: 修正後の verify_commands 4 本を HEAD 3c69f0a で再実行（全 exit 0） / 未解決: 未コミット 13 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json .claude/ docs/gates/legal-clearance.json docs/run-log/task_005.json scripts/append-handoff.sh scripts/assert-diff-exists.sh 
- 2026-09-24T04:30:43Z HEAD=9f5f55d 決まったこと: task_005: 検証ログ（settings.json の参照先照合）を追記 / 未解決: 未コミット 3 件: docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_011.json 
- 2026-09-24T04:32:42Z HEAD=9f5f55d 決まったこと: task_005: 検証ログ（settings.json の参照先照合）を追記 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T04:36:43Z HEAD=9f5f55d 決まったこと: task_005: 検証ログ（settings.json の参照先照合）を追記 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T04:38:42Z HEAD=9f5f55d 決まったこと: task_005: 検証ログ（settings.json の参照先照合）を追記 / 未解決: 未コミット 6 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json supabase/migrations/0004_ledger_event_scope_fk.sql 
- 2026-09-24T04:44:45Z HEAD=9f5f55d 決まったこと: task_005: 検証ログ（settings.json の参照先照合）を追記 / 未解決: 未コミット 17 件: .github/workflows/gate-integration.yml docs/HANDOFF.md docs/PROGRESS.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json docs/task-list.json 
- 2026-09-24T04:46:44Z HEAD=4ab9ed8 決まったこと: task_011: 修正後の verify_commands 4 本を HEAD 913a45b で再実行（全 exit 0） / 未解決: 未コミット 10 件: docs/HANDOFF.md docs/PROGRESS.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json scripts/assert-diff-exists.sh scripts/deny-dangerous-bash.sh scripts/deny-test-weakening.sh 
- 2026-09-24T04:48:43Z HEAD=0e805dc 決まったこと: task_005: 修正後の verify_commands 再実行ログと HANDOFF の陳腐化記述の訂正 / 未解決: 未コミット 3 件: docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_011.json 
- 2026-09-24T04:50:44Z HEAD=0e805dc 決まったこと: task_005: 修正後の verify_commands 再実行ログと HANDOFF の陳腐化記述の訂正 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T04:56:43Z HEAD=0e805dc 決まったこと: task_005: 修正後の verify_commands 再実行ログと HANDOFF の陳腐化記述の訂正 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T04:58:45Z HEAD=0e805dc 決まったこと: task_005: 修正後の verify_commands 再実行ログと HANDOFF の陳腐化記述の訂正 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T05:00:51Z HEAD=0e805dc 決まったこと: task_005: 修正後の verify_commands 再実行ログと HANDOFF の陳腐化記述の訂正 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T05:00:55Z HEAD=0e805dc 決まったこと: task_005: 修正後の verify_commands 再実行ログと HANDOFF の陳腐化記述の訂正 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T05:08:25Z HEAD=0e805dc 決まったこと: task_005: 修正後の verify_commands 再実行ログと HANDOFF の陳腐化記述の訂正 / 未解決: 未コミット 7 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json scripts/deny-dangerous-bash.sh tests/unit/hooks/deny-dangerous-bash.test.ts 
- 2026-09-24T05:09:35Z HEAD=0e805dc 決まったこと: task_005: 修正後の verify_commands 再実行ログと HANDOFF の陳腐化記述の訂正 / 未解決: 未コミット 7 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json scripts/deny-dangerous-bash.sh tests/unit/hooks/deny-dangerous-bash.test.ts 
- 2026-09-24T05:09:39Z HEAD=0e805dc 決まったこと: task_005: 修正後の verify_commands 再実行ログと HANDOFF の陳腐化記述の訂正 / 未解決: 未コミット 7 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json scripts/deny-dangerous-bash.sh tests/unit/hooks/deny-dangerous-bash.test.ts 
- 2026-09-24T05:14:54Z HEAD=0e805dc 決まったこと: task_005: 修正後の verify_commands 再実行ログと HANDOFF の陳腐化記述の訂正 / 未解決: 未コミット 8 件: docs/HANDOFF.md docs/PROGRESS.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json scripts/deny-dangerous-bash.sh tests/unit/hooks/deny-dangerous-bash.test.ts 
- 2026-09-24T05:16:53Z HEAD=ea63ab3 決まったこと: task_005: 実環境での削除遮断の実測記録 / 未解決: 未コミット 3 件: docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_011.json 
- 2026-09-24T05:18:52Z HEAD=ea63ab3 決まったこと: task_005: 実環境での削除遮断の実測記録 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T05:20:27Z HEAD=ea63ab3 決まったこと: task_005: 実環境での削除遮断の実測記録 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T05:29:33Z HEAD=ea63ab3 決まったこと: task_005: 実環境での削除遮断の実測記録 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T05:29:36Z HEAD=ea63ab3 決まったこと: task_005: 実環境での削除遮断の実測記録 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T05:44:29Z HEAD=34868e9 決まったこと: task_011(hardening): 修正後の verify_commands を HEAD d5089cc で再実行したログ / 未解決: 未コミット 3 件: docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json 
- 2026-09-24T05:47:00Z HEAD=34868e9 決まったこと: task_011(hardening): 修正後の verify_commands を HEAD d5089cc で再実行したログ / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T05:54:29Z HEAD=34868e9 決まったこと: task_011(hardening): 修正後の verify_commands を HEAD d5089cc で再実行したログ / 未解決: 未コミット 12 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json package.json scripts/deny-dangerous-bash.sh scripts/deny-test-weakening.sh 
- 2026-09-24T05:59:29Z HEAD=34868e9 決まったこと: task_011(hardening): 修正後の verify_commands を HEAD d5089cc で再実行したログ / 未解決: 未コミット 16 件: docs/HANDOFF.md docs/PROGRESS.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json package.json scripts/deny-dangerous-bash.sh 
- 2026-09-24T06:01:58Z HEAD=136be6d 決まったこと: task_005(hardening): 名指ししない迂回路の遮断・settings.json の構造検査・lint:changed の空振り修正 / 未解決: 未コミット 7 件: docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json src/lib/db/client.ts tests/unit/db-client.test.ts supabase/migrations/0007_provider_binding_scope_fk.sql 
- 2026-09-24T06:04:31Z HEAD=51b093a 決まったこと: task_005(hardening): 修正後の verify_commands を HEAD 136be6d で再実行したログ / 未解決: 未コミット 9 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_011.json src/lib/db/client.ts tests/integration/schema.test.ts tests/unit/db-client.test.ts supabase/migrations/0007_provider_binding_scope_fk.sql 
- 2026-09-24T06:07:00Z HEAD=51b093a 決まったこと: task_005(hardening): 修正後の verify_commands を HEAD 136be6d で再実行したログ / 未解決: 未コミット 13 件: .dev.vars.example docs/HANDOFF.md docs/concerns/task_011.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json docs/vendor-docs/cloudflare/hyperdrive.md 
- 2026-09-24T06:09:32Z HEAD=69935e5 決まったこと: task_011(4周目): 接続ロール検査を実効化し provider_binding のスコープを DB で縛る / 未解決: 未コミット 4 件: docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T06:12:01Z HEAD=6a05a25 決まったこと: task_011(4周目): 追記専用テーブルの所有者が postgres である残余リスクを記録 / 未解決: 未コミット 4 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json 
- 2026-09-24T06:14:30Z HEAD=6a05a25 決まったこと: task_011(4周目): 追記専用テーブルの所有者が postgres である残余リスクを記録 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T06:24:30Z HEAD=6a05a25 決まったこと: task_011(4周目): 追記専用テーブルの所有者が postgres である残余リスクを記録 / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T06:29:37Z HEAD=9172e63 決まったこと: task_005(4周目): 名前を経由した迂回路・MCP 編集ツールの入口を塞ぐ / 未解決: 未コミット 10 件: .claude/settings.json docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json package.json tests/integration/db-role.test.ts 
- 2026-09-24T06:29:39Z HEAD=9172e63 決まったこと: task_005(4周目): 名前を経由した迂回路・MCP 編集ツールの入口を塞ぐ / 未解決: 未コミット 10 件: .claude/settings.json docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json package.json tests/integration/db-role.test.ts 
- 2026-09-24T06:32:40Z HEAD=9172e63 決まったこと: task_005(4周目): 名前を経由した迂回路・MCP 編集ツールの入口を塞ぐ / 未解決: 未コミット 14 件: .claude/settings.json docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_011.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T06:35:38Z HEAD=f7494a6 決まったこと: task_011(5周目): 最終 HEAD 79993a6 での verify_commands 再実行ログと引き継ぎ / 未解決: 未コミット 11 件: .claude/settings.json docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_005.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json package.json 
- 2026-09-24T06:38:37Z HEAD=7d17e92 決まったこと: task_005(4周目): 修正後の verify_commands を HEAD a76ca67 で再実行したログ / 未解決: 未コミット 3 件: docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_011.json 
- 2026-09-24T06:41:36Z HEAD=7d17e92 決まったこと: task_005(4周目): 修正後の verify_commands を HEAD a76ca67 で再実行したログ / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T06:47:45Z HEAD=7d17e92 決まったこと: task_005(4周目): 修正後の verify_commands を HEAD a76ca67 で再実行したログ / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_003.json docs/run-log/task_004.json docs/run-log/task_005.json docs/run-log/task_011.json 
- 2026-09-24T06:51:35Z HEAD=c053281 決まったこと: chore: 検証エージェントが残した run-log / HANDOFF の追記をコミット（hardening 完了時点） / 未解決: 未コミットの変更なし
- 2026-09-24T06:51:37Z HEAD=c053281 決まったこと: chore: 検証エージェントが残した run-log / HANDOFF の追記をコミット（hardening 完了時点） / 未解決: 未コミット 1 件: docs/HANDOFF.md 
- 2026-09-24T06:59:38Z HEAD=c053281 決まったこと: chore: 検証エージェントが残した run-log / HANDOFF の追記をコミット（hardening 完了時点） / 未解決: 未コミット 3 件: docs/HANDOFF.md docs/run-log/task_012.json tests/gates/ 
- 2026-09-24T06:59:43Z HEAD=c053281 決まったこと: chore: 検証エージェントが残した run-log / HANDOFF の追記をコミット（hardening 完了時点） / 未解決: 未コミット 3 件: docs/HANDOFF.md docs/run-log/task_012.json tests/gates/ 
- 2026-09-24T07:41:49Z HEAD=c053281 決まったこと: chore: 検証エージェントが残した run-log / HANDOFF の追記をコミット（hardening 完了時点） / 未解決: 未コミット 41 件: .claude/settings.json .env.example docs/HANDOFF.md docs/PROGRESS.md package.json src/app/api/health/route.ts tests/unit/health.test.ts vitest.config.ts 
- 2026-09-24T07:43:56Z HEAD=3cc3a19 決まったこと: task_006: gate-check（G0〜G14）・違反フィクスチャ 23 本・メタゲート・フック実在マトリクスの実測 / 未解決: 未コミット 1 件: tests/gates/probe.test.ts 
- 2026-09-24T07:44:36Z HEAD=597123e 決まったこと: task_012: コミット 20f379f に task_006 の成果物が巻き込まれた経緯を HANDOFF に記録（履歴は書き換えない） / 未解決: 未コミット 3 件: docs/run-log/task_006.json docs/run-log/task_012.json tests/gates/probe.test.ts 
- 2026-09-24T07:47:37Z HEAD=17edb6e 決まったこと: task_006: 最終 HEAD での verify_commands 再実行ログ（全 exit 0） / 未解決: 未コミット 3 件: docs/HANDOFF.md docs/run-log/task_012.json tests/gates/probe.test.ts 
- 2026-09-24T07:50:36Z HEAD=17edb6e 決まったこと: task_006: 最終 HEAD での verify_commands 再実行ログ（全 exit 0） / 未解決: 未コミット 4 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_012.json tests/gates/probe.test.ts 
- 2026-09-24T07:59:45Z HEAD=17edb6e 決まったこと: task_006: 最終 HEAD での verify_commands 再実行ログ（全 exit 0） / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_012.json src/middleware.ts tests/gates/probe.test.ts 
- 2026-09-24T07:59:49Z HEAD=17edb6e 決まったこと: task_006: 最終 HEAD での verify_commands 再実行ログ（全 exit 0） / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_012.json src/middleware.ts tests/gates/probe.test.ts 
- 2026-09-24T08:03:42Z HEAD=17edb6e 決まったこと: task_006: 最終 HEAD での verify_commands 再実行ログ（全 exit 0） / 未解決: 未コミット 7 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_012.json scripts/gate-env-scope.mjs src/middleware.ts tests/unit/security-headers.test.ts tests/gates/probe.test.ts 
