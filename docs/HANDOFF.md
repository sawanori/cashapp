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
- **（要対応・task_006 へ）`npm run test:unit` が現在 exit 1**。落ちているのは 1 件だけで、
  `tests/unit/gate-check.test.ts > overlay の解決 > meta.json の inputs はディレクトリごと差し替えられる`。
  原因は **task_006 が作業中の未コミット `scripts/gate-check.mjs`** が G4 に
  「PROGRESS.md の完了宣言と `docs/task-list.json` の突き合わせ」を追加したことである。
  この検査は `docs/task-list.json` をオーバーレイで 1 タスク（`task_953`）に差し替える一方、
  `docs/PROGRESS.md` は `--base`（実リポジトリ）から読むため、実リポジトリが宣言している
  7 タスク（task_002 / 003 / 004 / 011 / 005 / 012 / 006）が丸ごと違反として出る。
  **task_012 の変更は無関係である**ことを 2 通りで実測した:
  (a) `progressDeclarations()` と同じ正規表現で `git show 17edb6e:docs/PROGRESS.md` と
  `git show HEAD:docs/PROGRESS.md` を解析すると、宣言 id は 7 件で**完全に同一**
  （task_012 は既に宣言済みで、追記した 2 周目の行は 2 件目なので採られない）。
  (b) 同じオーバーレイを組み立てて `gate-check.mjs` の 2 版で G4 を比べると、
  **HEAD の版（task_012 のコミット込み）は violations 0 / targets 1 で通り**、
  作業ツリーの版だけが violations 7 / targets 8 になる。
  → **task_006 へ**: このフィクスチャは `docs/PROGRESS.md` も中立化する（オーバーレイで空にするか
  `meta.json` の `absent` に入れる）必要がある。task_012 側からは触っていない。

## task_006（レビュー修正・2 周目）

### 決まったこと

- **`manual_verification` は項目 1 件につき記録 1 件（単射）で照合する**。`gate-check.mjs` の
  `matchManualVerification` が、観察文中の `manual_verification[<索引>]` か項目文字列の
  引き写しで名指しされた記録を先に確定し、残った項目に残った記録を 1 件ずつ充てる。
  名指しの無い充当は毎回 **warn** に出す。修正前は「要件を満たす manual 記録が 1 件でもあれば
  N 項目すべて満たされたことになる」判定で、docs/** のみのタスク（task_001 / 002 / 034 / 036 / 037）の
  完了根拠が実質無検査だった。反例 `g4-manual-items-uncovered`。
- **`gate-inputs/**` は overlay 専用**。`--root` がベースと異なるときだけ読む
  （`ctx.readOverlayText`）。リポジトリ直下に置いても無視され、さらに G8 と G0 が
  その存在を違反として報告する。修正前はリポジトリ直下に `gate-inputs/git-diff.json` を
  置くだけで実 `git diff` / 実 HEAD の走査を丸ごと飛ばせた。反例
  `g8-gate-inputs-planted-in-base`（runner が bash で、リポジトリを symlink で束ねた
  使い捨てのベースを組み立てる）。
- **完了申告は `docs/PROGRESS.md` と `docs/task-list.json` の両方に要る**。G4 が
  「PROGRESS.md が完了を宣言しているのに台帳の `completion_status` が null」「両者が食い違う」を
  違反として検出する。**次のタスクからは完了時に自分の行の `completion_status` を書くこと**
  （書かないと gate:check が赤くなる）。今回 task_002 / 003 / 004 / 005 / 012 / 006 の 6 件を
  PROGRESS.md の記載どおりに台帳へ写した。両方が同じ層から来ていない overlay では
  この対比は飛ばす（フィクスチャの task-list と本物の PROGRESS.md を突き合わせないため）。
- **残懸念は 3 箇所から集める**: 台帳の `concerns[]`・`docs/concerns/<task_id>.md`・
  `docs/HANDOFF.md` のタスク節（`- **[severity: …]` で始まる箇条書き）。G11 のしきい値
  （high 3 件で `in_progress` を止める）と G6 の判定が実際の記録場所を見るようになった。
  現在の未解決 high は 7 件（task_005 / task_006 / task_011）。`in_progress` が 0 件なので
  まだ止まっていないが、**次に誰かが `in_progress` を立てた時点で G11 が発火する**。
- **G13 のハッシュ対象に 3 本を追加した**: `scripts/wording-lint.mjs`・`scripts/gates-sync.mjs`・
  `scripts/test-hook-enforcement.sh`。名前が `gate-` / `deny-` / `assert-` / `validate-` の
  どの接頭辞にも当たらず対象から漏れていた。基準値は 21 → 24 ファイル。
- **Stop フックで落ちたときは stderr にも出す**。`gate-check.mjs` は非ゼロ終了時に限り
  集計行と違反行を stderr にも書く（Claude Code は非ブロッキングの非ゼロ終了で stderr だけを
  セッションに見せるため）。exit 1 のまま据え置く判断は変更していない。

### 未解決

- **（high・変化なし）G13 の自己封じ**。基準値を作れるのがエージェント自身である構図は
  変わっていない。今回の再生成では task_012 が 2 周目で書き換えた `scripts/gate-env-scope.mjs`
  （コミット `3062179`）も一緒に正になった。歯止めは基準値の差分が PR に出ることだけで、
  それを人間の関門に繋ぐのは task_009 の CODEOWNERS と `test-tamper-guard`。
- **（low）manual 記録の名指しはまだ必須ではない**。項目数ぶん記録があれば名指し無しでも
  充当する（充当のたびに warn）。`record-run.sh --manual` の観察文に索引を書く運用が
  定着したら必須へ切り替える。いま warn が出ているのは task_002 の 1 件。
- **（記録）`docs/task-list.json` は task_006 の `files_to_modify` に無い**が、追加した
  G4 の判定を満たすために `completion_status` の同期と task_003 の `concerns[]` への
  severity 接頭辞付与を行った。付与した severity の出どころは本文中に明記してある。
  詳細は `docs/concerns/task_006.md` の 13。
- **（medium・deferred・変化なし）CI 実走が未証明**。GitHub リモート未作成のため
  `gate-meta` / `acceptance` / `gate-integrity` ジョブは一度も走っていない。task_009 の担当。

## task_009（CI・PR テンプレート・test-tamper-guard・release.yml の 2 段ゲート）

### 決まったこと

- **`.github/workflows/gate.yml` は task_009 の単独所有**。他タスクが CI ジョブを足すときは
  `.github/workflows/gate-<job>.yml` として独立ファイルで追加する（既存: `gate-integration.yml`
  = task_011）。ジョブ名は `gate.yml` のジョブ ID をそのまま status check のコンテキスト名に
  使う（`name:` を別に与えていない）。
- **`gate.yml` の実装ジョブ（10 本＋1 本）**: `static`（typecheck / lint / test:unit /
  gate:constraints / assert-release-gate）・`gate-meta`・`gate-integrity`・`labels`（gate:wording）・
  `security`（test:security / gate:server-only / gate:env）・`secrets`（build → build:cf →
  `scripts/ci/secrets-grep.sh`）・`deps`（lockfile 不動 / lockfile 差分レポート / npm audit high /
  OSV v2.6.0 / 決済 SDK 不在）・`acceptance`（assert-verify-commands / gate:acceptance /
  **完了タスクの verify_commands を CI で再実行**）・`test-tamper-guard`・`date-boundary`。
  `adversarial` は**定義したが required に入れない**（R-TH-03）。`workflow_dispatch` のときだけ走り、
  レビュー経路（`scripts/review/run-adversarial.*`）が無ければ**非 0 で落ちる**（「何もせず緑」を作らない）。
- **§16-6 の表のうち未実装のジョブ**: `contract` / `a11y` / `legal` / `web-only` /
  `gate:compliance-freshness` / `waf`。対応する npm スクリプトが `package.json` に無いため
  job を書いていない（実在しないコマンドを CI に書かない）。各タスクが独立ファイルで追加する。
- **`release.yml` の先頭は `release-gate` ジョブ**。他のすべてのジョブは `needs` で
  `release-gate` に到達しなければならない。この構造は `scripts/ci/assert-release-gate.mjs` が
  YAML パースで検査する（check_051、`static` ジョブと `npm run gate:release-gate`）。
  判定は `uses` / `with` の**構造**から取る（ステップの `name:` に同じ文字列を書いても通らない）。
- **追加した npm スクリプト**: `gate:release-gate` / `gate:pr-checklist` / `gate:secrets-grep`
  （いずれも `npm pkg set` で追加）。
- **`deps` ジョブの OSV はリリースバイナリ経路**。公式が案内する再利用可能ワークフローは
  job レベルでしか呼べず §16-6 の「`deps` ジョブの中」に置けないため、v2.6.0 のバイナリを
  `osv-scanner_SHA256SUMS` で検証して使う（一次資料 `docs/vendor-docs/osv/osv-scanner.md`）。
- **`date-boundary` はユニットスイートの TZ を振れない**。`vitest.config.ts` の
  `test.env.TZ = "UTC"` がワーカー env で `process.env` に勝つことを実装で確認した。
  そのため `scripts/gate-check.mjs --json` と `scripts/gate-constraints.sh` の出力・終了コードを
  2 つの TZ で突き合わせる構成にしてある。固定が外れたら自動でユニットスイートの 2 TZ 実行に
  切り替わるステップを入れてある。
- **G13 の基準値は、後から完了するタスクが必ず `node scripts/gate-integrity.mjs --write-baseline`
  をやり直す**。`--write-baseline` は作業ツリー全体（未追跡ファイルを含む）を走査するため、
  並行タスクの未コミットファイルが焼き込まれる。本タスクのコミット時点では task_007 の
  `.claude/agents/*.md` や `scripts/review-*.mjs` が未コミットのまま基準値に入っている。
  全ハーネスタスクの完了後に、クリーンなチェックアウトで `npm run gate:integrity` が exit 0 に
  なることを 1 度確認すること。

### 未解決

- **[severity: high] `docs/gates/release-mode.json` を作成できなかった**。`scripts/deny-test-weakening.sh`
  が `docs/gates/**` への Write を**新規作成でも**遮断する（実際の遮断ログは
  `docs/concerns/task_009.md` の 1 に貼ってある）。`release.yml` はファイルが無い場合に
  fail-closed で先頭終了する実装にしてあるので、**いまリリースを起動すると落ちる**。
  → **PO が作成する**（既定値と手順は `docs/concerns/task_009.md` の 1）。
  併せて `docs/gates/README.md` の「`release-mode.json` … task_009」という記述も PO が訂正する
  （同じ理由で AI からは直せない）。
- **[severity: high] branch protection 未設定（check_039 未達）・CI 実走ゼロ（check_130 / check_131 未達）**。
  `git remote -v` は空で GitHub 上にリポジトリが無い。`gh` は `sawanori` で認証済みだが対象が無い。
  → **deferred: GitHub リモート作成後に実施**。required に入れる status checks の一覧は
  `docs/concerns/task_009.md` の 2 の表に確定済み（required approving reviews は **0**。
  `gate-integration / integration` を必ず含める。`adversarial` と `e2e` は入れない）。
  回収は task_010。
- **[severity: medium] `acceptance` ジョブは DB 依存の `verify_commands` を `gate-integration.yml` に
  委譲している**（`test:integration` / `gates:sync` / `db:migrate` / `db:diff:drizzle`）。
  委譲は黙って飛ばさずログに出し、実行 0 件なら exit 1 にしてある。両ワークフローが required に
  なって初めて「全 `verify_commands` が CI で再実行された」と言える。
- **[severity: medium] `scripts/ci/secrets-grep.sh` の `SECRET_NAMES` は手書き**。秘密値を増やす
  タスクはこの配列にも足すこと（`scripts/**` の差分なので PR のチェックリスト記入が要求される）。
  自動導出は task_035 が `.env.example` に印を入れてから。
- **[severity: medium] `test-tamper-guard` は記入内容を検証しない**。単一アカウントでは記入者と
  マージ者が同一人物であり、承認の代替ではなく**緩和事実の記録強制**である。緑を
  「レビュー済み」と読まないこと。
- task_011 へ: 本タスクで `gate.yml` ができたので、`docs/concerns/task_011.md` の
  「`gate.yml` に integration ジョブが追加され PR で緑」の**前半**（ワークフローの存在と
  required への登録方針）は解消した。**後半（PR で緑）は GitHub リモート作成後**であり、
  依然として未達である。required には `gate-integration / integration` を登録する。
- **[記録] 本タスクが `npm pkg set` で足した 3 スクリプト（`gate:release-gate` /
  `gate:pr-checklist` / `gate:secrets-grep`）は、task_007 のコミット `1f4acfd` に巻き込まれた**。
  `package.json` は複数タスクが `npm pkg set` で触る共有ファイルで、コミット時に
  意図せず他タスクの追加ぶんを含みうる（commit `597123e` と同種の事象）。履歴は書き換えない。
  以後、`git add` は自タスクのファイルを明示指定すること（`git add -A` を使わない規約の理由）。

## task_007（エージェント定義 7 本とレビュー封筒スクリプト）

### 決まったこと

- **レビュー経路の入口は 5 本**: `scripts/build-review-packet.sh`（封筒生成）→
  `scripts/review-gemini.mjs` / `scripts/review-gpt.mjs`（CLI ラッパー）→
  `scripts/validate-findings.mjs`（封筒検証・降格）→ `scripts/merge-review.sh`（判定と review-log 追記）。
  npm からは `review:packet` / `review:gemini` / `review:gpt` / `review:validate` / `review:merge`。
- **封筒は `--base` / `--head` 付きで作る**。`--base` 無しは「HEAD と作業ツリーの差分＋未追跡」を
  対象にするため、並行タスクの未コミットファイルが混ざる（実測で task_009 の `scripts/ci/*` が
  混入した）。さらに並行タスクが先にコミットすると `HEAD` は自分のコミットではなくなるので、
  `--head <自分のコミット>` も要る。task-loop（task_008）から呼ぶときは両方を必須引数として扱うこと。
- **封筒のサイズはレビューの成否に効く** [実測]。265KB の封筒（同梱 17 ファイル / diff 150KB）は
  `gemini-2.5-pro` が **900 秒で応答を返さずタイムアウト**した。76KB に絞ると同じモデルで返った。
  `--max-file-bytes`（既定 200000）/ `--max-diff-bytes`（既定 120000）で切り詰められ、
  切り詰めた事実は `artifact.truncated_files` / `diff_truncated` / `diff_bytes_total` に残る。
  **既定値のままだと大きい変更で返ってこない**ので、既定は実測で見直すこと（task_008 / 010）。
- **降格は機械で掛かる**。repro の無い `high` → `info`（R-TH-08）。`vendor: "gemini"` の
  `high` / `medium` で citation が無ければ → `unknown`（§16-2 の「引用なしは UNKNOWN」）。
  降格は握り潰しではなく `downgrades[]` として review-log に残る。
- **`merge-review.sh` の終了コード**: `0` pass / `1` 差し戻し（実効 high ≥ 1）/
  `3` レビュー不成立（有効票 0、または無効封筒あり）/ `64` usage。
  **欠票（`reviewer_route: "unavailable"`）は判定をブロックしない**が、有効票が 1 つも
  無ければ `3` になる。DONE 側で握り潰せないよう、不成立は 0 で返さない。
- **Gemini 経路は通る** [実測 2026-09-24]。`gemini -o json` の `stats.models` のうち
  `roles.main` を持つキーが応答モデル ID であり、これは自己申告ではなく CLI の出力である。
  `-m gemini-2.5-pro` は実測で反映された（`reviewer_route: "verified"`）。
  **プレモータム R-TH-11 が書いていた「model 指定は無視される」は CLI 0.38.1 では再現しない。**
  ただし `-m` 無指定だと `gemini-3-flash-preview` が main、`gemini-2.5-flash-lite` が
  utility_router になるので、**モデルは必ず明示する**。
- **GPT-6 Astra 経路は通らない** [実測 2026-09-24]。`codex exec` は **exit 0 のまま
  エージェント応答を 1 件も返さない**（`--output-last-message` が 0 バイト、
  `turn.completed` のトークン 0、イベントは thread.started / turn.started /
  item.completed(error=skills の警告) / turn.completed）。終了コードを成功の根拠にできないため、
  `review-gpt.mjs` は**応答本文の有無だけ**で成立を判定する。
- **codex の `--json` イベントに応答モデル ID は無い** [実測]。自己申告しか根拠が無いので、
  自己申告のときは `reviewer_route: "cli-fallback"` ＋ `model_id_source: "self_report"` にして
  `verified`（観測値）と区別する。
- **`acceptance-test-generator-restricted` は `tools: Write` だけを持つ**。`Read` / `Grep` /
  `Glob` / `Bash` を与えないことで `src/**` を読む手段を構造的に消してある（R-TH-14）。
  そのぶん**呼び出し側が task-list エントリ・受入基準・禁止語ポリシーを本文に貼る義務**を負う。
- **G5 の性質が変わる**。`scripts/gate-check.mjs` の G5 は「task_007 が完了状態になったら
  ブロッキング」と実装されている（§15-2 の設計どおり）。本タスクの完了で、review-log を
  持たない既存完了タスク **task_004 / 005 / 006 / 011 / 012 の 5 件が違反として列挙される**。

### 未解決

- **[severity: high] 敵対レビューは実質 1 ベンダー（Gemini 単独）**。GPT 経路の遮断解除は
  PO の承認事項で、AI は解除してはならない。欠票は review-log に残すが、
  **この状態を「3 ベンダー体制」と称さないこと**（F6 / R-TH-06）。→ task_010
- **[severity: high] G5 が 5 件の違反を出す（`npm run gate:check` が非 0 になる）**。
  これは事故ではなく計画が意図した強制力である。解消手順（封筒生成 → 2 経路 → merge）は
  `docs/concerns/task_007.md` の 3 に書いた。**欠票で敷き詰めて緑にしないこと。**
  Gemini 経路は通るので実レビューを取れる。→ 各タスク担当 / PO
- **[severity: medium] CI の `adversarial` ジョブが存在しない入口を見ている**。
  task_009 の `gate.yml` は `scripts/review/run-adversarial.{sh,mjs}` を探すが、実際の入口は
  上記 5 本でパスが違う。`gate.yml` は task_009 の単独所有なので本タスクからは触っていない。
  → task_010（task_009 と調整。どちらにしても required には入れない）
- **[severity: medium] 合格モデルのホワイトリストが無い**。`validate-findings.mjs` は
  `docs/metrics/model-bench.md` の `{"approved_models": [...]}` と照合する設計だが、
  ファイルが無いため `model_mismatch` を検出できず `model_whitelist_unconfigured` の警告だけが出る。
  → task_010
- **[severity: medium] 本タスク自身の敵対レビューは 1 票しか取れていない**。
  `docs/review-log/task_007.json` の round 1 は Gemini タイムアウト ＋ GPT 欠票で
  `not_established`、round 2（封筒 76688 bytes）で Gemini が `verified` /
  `model_id_actual: "gemini-2.5-pro"` で応答し `pass`（実効 high 0）。
  **唯一の medium finding（import 走査が `export … from` を拾えない）は誤検出**で、
  3 形式を実ファイルで走らせて反証した（修正していない）。R-TH-08 は誤検出率の集計を
  求めているが、封筒スキーマに `false_positive` フィールドが無いので、この判定は
  `docs/concerns/task_007.md` にしか残っていない。→ task_008（false_positive 台帳）/ task_010（2 票目）
- **[severity: medium] G13 の基準値は task_007 の未コミット状態で焼かれた**。task_009 が
  `--write-baseline` を走らせた時点で本タスクの 8 ファイルが未コミットのまま基準値に入った。
  コミット後の `npm run gate:integrity` は 38 ファイル / 不一致 0 で通る [実測] が、
  **全ハーネスタスク完了後にクリーンなチェックアウトで 1 度確認すること**。→ task_009 / PO
- **[severity: low] 最終 HEAD では `npm run gate:constraints` が exit 1**。違反 2 件は
  並行実行中の task_013 の未追跡ファイル（`src/components/ConsentGate.tsx:20` /
  `src/lib/liff/client.ts:15` の「`localStorage` は使わない」というコメント行が N7 の
  forbid grep に当たる）で、task_007 の成果物には違反 0 件。当該ファイルが無かった時刻の
  同コマンドは exit 0 で run-log に残っている。→ task_013（または N7 の
  `allow_if_line_matches` を持つ task_004）
- **[severity: low] `docs/task-list.json` は本タスクの `files_to_modify` 外だが触った**。
  G4 が「PROGRESS.md の完了宣言と台帳 `completion_status` の一致」を違反として見るため、
  task_007 の `completion_status` だけを同期した（task_006 と同じ扱い）。

## task_009（レビュー修正・2 周目）

### 直したこと

- **`secrets` ジョブは書いた時点では落ちる実装だった**。`scripts/ci/secrets-grep.sh` が
  シークレットの**名前**（`PEPPER` / `SESSION_KEYS` / `CRON_SECRETS` / `DATABASE_URL` …）で
  `.open-next` 全体を走査していたため、`src/lib/config/env.ts` が正当に読む名前が
  サーバーバンドルに残り、自分の実装に自分で当たっていた。走査を 2 群に分けた:
  **(A) クライアント配布物**（`.next/static` / `.open-next/assets`）＝ 名前 ＋ 値パターン、
  **(B) サーバーバンドル**（`.open-next` の assets 以外）＝ 値パターンのみ。
  実測: `npm run build && npm run build:cf` 後、修正前 exit 1・違反 4 件 → 修正後 exit 0
  （クライアント 21 / サーバー 1189 ファイル）。`tests/unit/ci/secrets-grep.test.ts` 23 件で
  両方向（クライアントに名前 → 落ちる / サーバーに名前 → 通る）を固定した。
  **教訓: ビルド成果物を見るゲートは、古い成果物に対して測ると緑に見える。**
  1 周目の「1189 ファイル走査・違反 0 件」は task_012 のルートが入る前のビルドだった。
- **`test-tamper-guard` を `.github/workflows/gate-tamper.yml` に分離した**。
  `on: pull_request` の既定 types（opened / synchronize / reopened）では**PR 本文の編集で
  再実行されない**ので、チェックリストを埋めて緑にしたあと本文を空に戻してマージできた。
  記録の強制だけが目的のゲートとしては成立しないため、`types: [opened, synchronize,
  reopened, edited]` で起動する独立ワークフローにした。status check 名は
  `test-tamper-guard` のまま（branch protection の表は変更不要）。
  `gate.yml` は既定 types のまま（全ジョブを本文編集のたびに回さない）。

### 未解決 / concerns

- **[severity: high] `docs/gates/release-mode.json` は依然として無い**。本周でもう一度
  Write を試み、同じ文面で遮断された（`docs/gates/** は PO 専管…`）。`release.yml` は
  fail-closed（ファイルが無ければ `release-gate` が先頭で exit 1）なので、いまリリースを
  起動すると必ず落ちる。**deferred: PO が既定値
  `{schema_version:1, payments_enabled:false, provider_keys:["manual_confirm"], basis:null,
  approved_by:null}` で作成し、`node scripts/gate-integrity.mjs --write-baseline` を実行する。**
  → PO
- **[severity: high] branch protection と CI 実走は未実施**（`git remote -v` が空）。
  required に入れる status check の確定表は `docs/concerns/task_009.md` の 2。
  **`secrets` ジョブの偽陽性を直した今なら required に入れられる**（偽陽性のまま required に
  すると最初の PR からマージ不能になり、R-TH-04 の「回避として branch protection ごと解除」に
  直行する）。→ task_010 / PO
- **[severity: medium] `date-boundary` はアプリの日付ロジックを 1 行も見ていない**。
  `vitest.config.ts` の `test.env.TZ = "UTC"` がホストの `TZ` に勝つため、ユニットスイートを
  2 TZ で振れない。代替の 2 TZ 比較は `gate-check.mjs` / `gate-constraints.sh` という
  ハーネス側の判定器が対象で、`src/lib` の X-TIME / 5 営業日判定 / JST 境界には触れない。
  恒久対処は `vitest.config.ts` の `env.TZ` を `process.env.TZ ?? "UTC"` にすること
  （本タスクの `files_to_modify` 外）。`gate.yml` には固定が外れたら自動で 2 TZ 実行に
  切り替わるステップが入っている。→ task_022 または task_038
- **[severity: medium] G13 の基準値は `node scripts/gate-integrity.mjs --write-baseline` の
  Bash 実行で AI から書き換えられる**。`docs/gates/**` は Edit / Write 禁止だが、
  `deny-dangerous-bash.sh` はリダイレクト・tee・cp/mv・`sed -i`・インタプリタのワンライナー
  しか見ないので、保護対象へ書き込む「正規スクリプトの実行」は素通りする。
  「ガード or テスト or ワークフローを改変 → 基準値を焼き直す」の 2 手で G13 は迂回できる。
  → task_038（`--write-baseline` を PO 専用にする / ガードに列挙する）
- **[severity: medium] `npm run gate:check` は G5 で非 0 のまま**。
  `docs/review-log/<task_id>.json` が無い完了済みタスクが残っているため。
  本周で task_009 のぶんは作った。残りは各タスクの担当周が作る。→ task_004 / 005 / 006 / 011 / 012

## task_009（レビュー修正・3 周目）

### 直したこと

- **`release.yml` のゲートは `if: always()` の 1 行で無効化できた。**
  `scripts/ci/assert-release-gate.mjs` は `needs` グラフの到達性しか見ておらず、
  `deploy` に `needs: [release-gate]` を残したまま `if: always()` を足した `release.yml` を
  「違反 0 件」で通した（レビューの再現手順をそのまま実行して確認）。
  **`needs` は `if:` に状態関数を書くと既定の「先行が落ちたら走らない」が置き換わる。**
  `release-gate` に `needs` で到達する全ジョブの `if:` に `always()` / `failure()` /
  `cancelled()` / `success()` の否定・比較が無いこと、`release-gate` のジョブと各ステップに
  `continue-on-error` が無いこと（ジョブ単位のそれは結論を success に変えて `needs` を
  満たしてしまう）をアサートに足した。テストは 18 → 31 件。
  **教訓: 「依存グラフが正しい」と「落ちたら止まる」は別の主張で、前者だけ検査しても関門にならない。**
- **`acceptance` の再実行は台帳の文字列を `sh -c` に渡していた。**
  `scripts/gate-check.mjs` の `scriptNameOf` は先頭の `npm run <name>` しか見ないので、
  `npm run gate:check || true` は G2 を「実在スクリプト」として通り、そのまま `sh -c` に
  渡されて再実行が常に exit 0 になった（旧実装で実測: `exit 3` のスクリプト＋`|| true` で
  `実行 1 / 失敗 0` の exit 0）。F2（完了の過大申告）に対する唯一の対策が無音で外せた。
  再実行ループを `^npm run <script>$` の完全一致に縛り、シェルを介さず
  `npm run "<script>"` の引数として渡す形に変えた（一致しない値は実行せず `形式違反` で落とす）。
  **`docs/task-list.json` は `test-tamper-guard` の保護対象でも G13 のハッシュ対象でもない**ので、
  台帳を経由した細工は記録も残らない。台帳自体を保護対象にするかは task_006 との合意事項
  （`docs/concerns/task_009.md` の 13）。
- **`.open-next/cache` はサーバー側ではなくブラウザ配布面である。**
  OpenNext はプリレンダ済みページのレスポンス本文（`{"type":"app", … "html":"<!DOCTYPE html>…`）を
  `.open-next/cache/<BUILD_ID>/*.cache` に出す。2 周目の群分けでここがサーバー側に入り、
  シークレット「名前」の走査から外れていた（値パターン 5 種に当たらない `PEPPER` /
  `SESSION_KEYS` / `CRON_SECRETS` / `APP_RW_PASSWORD` の実値はレンダリング結果に載っても緑）。
  群 (A) へ移し、群 (B) の除外名を `CLIENT_DIRS=(assets cache)` として 1 か所で管理した。
  **今後 OpenNext がブラウザ配布面の出力先を増やしたら、この 2 か所を必ず同時に直すこと。**

### 実測で埋まったこと（GitHub リモートが出来た）

- 3 周目の作業中に `origin git@github.com:sawanori/cashapp.git`（public・default `main`）が
  作られ、`gate` / `gate-integration` / `gate-web-only` が実走を始めた。
  **1 / 2 周目の「CI を一度も実走していない」はもう正しくない。**
- `gate`（run 35985828343 / commit `b1bc328`・push トリガ）: **9 ジョブ中 8 ジョブ success**。
  赤は `acceptance` だけで、内訳は `実行 13 / 委譲 2 / 失敗 1 / 形式違反 0`、
  唯一の失敗は `npm run gate:check`（G5 の他タスク残債）。
  `secrets` ジョブは ubuntu ランナー上の実ビルドに対して success。
- `release`（run 35986191784 / `workflow_dispatch`）: **`release-gate` = failure /
  `deploy` = skipped**。`release-gate FAIL: docs/gates/release-mode.json がありません` →
  `fail-closed で落とします（L11）` → exit 1。`cloudflare/wrangler-action` には到達していない。

### 未解決 / concerns（3 周目時点）

- **[severity: high] `docs/gates/release-mode.json` は依然として無い**（PO 専管で Write が遮断される）。
  3 周目に `release.yml` を実走させて「無い状態では必ず落ちる」ことは実機で確認した。
  裏を返せば**PO がこれを作るまで本番デプロイは 1 度も成功しない**。→ PO
- **[severity: high] branch protection は未設定。理由が変わった。**
  リモートが出来て `gh api` は叩ける（現在 404 `Branch not protected`）が、
  **いま required status checks ＋ 直 push 禁止を入れると、まだ push されていない
  10 コミットが `main` に入れられなくなる**。`origin/main` は `b1bc328` で止まっており、
  ローカル `main`（`1937645`）との差は 10 コミット。しかも `b1bc328` 時点の `gate` は
  `acceptance` が赤（G5: `docs/review-log/*.json` 不在）で、**その赤を消す修正が
  まさにその未 push の 10 コミットの中にある**（ローカルでは `npm run gate:check` が exit 0）。
  保護を先に入れると、修正を運び込む経路ごと塞がり、R-TH-04（回避のために保護ごと解除）を
  自分から作る手順になる。**`origin/main` がローカル `main` まで進み、その commit で
  `gate` が緑になったことを確認してから**設定すること。
  確定表は `docs/concerns/task_009.md` の 2。→ task_010 / PO
- **[severity: high] PR 経路だけが未実測**。`test-tamper-guard` は `gate-tamper.yml` の
  `on: pull_request` のみで起動するので、PR が 1 本も無い現在 1 度も走っていない
  （`gh run list --workflow gate-tamper.yml` は 0 件）。check_131 はここが埋まるまで未達。
  PR を作るにはブランチの publish が要るが `git push` は本ハーネスの禁止コマンドなので、
  `gh api` でのブランチ作成も趣旨に反すると判断して行っていない。→ task_010 / PO
- **[severity: medium] check_130 は部分達成**。「ファイル不在 → fail-closed」は実測できたが、
  「`payments_enabled=false` で (a) 段を通る」「`true` かつ `cleared=false` で先頭で落ちる」の
  2 通りは `release-mode.json` を作れないため未実測。→ PO（作成）→ task_010（実測）
- **[severity: medium] `docs/task-list.json` は無記録で書き換えられる**。
  `check-pr-checklist.mjs` の保護対象にも G13 にも入っていない。3 周目で acceptance 側の
  コマンド注入は塞いだが、台帳そのものの改変検知は無い。→ task_006 との合意事項（同 13）
- 2 周目からの持ち越し（`date-boundary` がアプリの日付ロジックを見ていない / G13 の基準値が
  `--write-baseline` の Bash 実行で書き換えられる / `secrets` の値パターンが 5 種しか無い）は
  そのまま残る。→ task_022 / task_038

## task_013（LIFF 外殻・起動順序・ループ防止・テレメトリ・静的フォールバック・ルートグループ）

### 決まったこと

- **LIFF の起動順序は `src/lib/liff/client.ts` の `bootLiff()` 1 本に集約した。**
  `init`（3 秒タイムアウト付きの動的 import）→ **`isInClient()` が false なら `login()` を呼ばず
  `outside_line`** → `isLoggedIn()` → 試行回数を見て `login()` か `auth_unavailable` → `getIDToken()`。
  画面側はこの関数の戻り値 `state` だけで分岐する。**別の場所で `liff.login()` を直接呼ばないこと。**
- **ログイン試行回数の読み方を確定した。** 計画 §7-3 の「sessionStorage の試行回数 2 回で打ち切り」を
  「`login()` を呼ぶのは最大 2 回、3 回目は `auth_unavailable`」と解釈した（`MAX_LOGIN_ATTEMPTS = 2`）。
  プレモータム R-LINE-02 の「2 回目以降の login を打ち切り」（＝ login は 1 回）とは 1 回ぶん違う。
  計画本文を優先した。`tests/unit/liff/client.test.ts` がこの数え方を固定している。
- **LIFF ID はビルドに焼き込まず、実行時に `<meta name="x-liff-id">` で渡す。**
  `(liff)/layout.tsx`（`force-dynamic`）がサーバー側で `loadAppConfig()` から読んで埋め、
  クライアントは `readLiffIdFromDocument()` でだけ読む。`NEXT_PUBLIC_LIFF_ID` のような
  公開ビルド変数は**作らない**（R-LINE-04）。
- **テレメトリでクライアントから受け取るのは `code` 1 キーだけ**にした。
  `liffIdFingerprint` / `uaClass` / `requestId` はサーバーが自分で作る。コードは allowlist
  （`CLIENT_ERROR_CODES` の 4 値）で、それ以外は 400。自由入力欄を 1 つも作らない。
- **`(web)` は退避先ではない**ことを `docs/decisions/ADR-013-web-route-group.md` に記録した
  （proposed）。Phase 1 の `(web)` は静的法務ページと管理者画面だけで、集金導線の LINE 非依存版は
  作らない。**`build:web-only` の緑を「LINE を外しても大丈夫」と言い換えないこと。**
- **CI ジョブは `.github/workflows/gate-web-only.yml` として独立ファイルで足した。**
  `gate.yml`（task_009 所有）は編集していない。required status checks への
  `gate-web-only / web-only` の登録は task_009 側で行う。
- **Web フォントを 1 つも読み込まない**方針を `src/styles/tokens.css` に固定した（web-typography 準拠）。
  ファミリーは OS 標準の UI サンセリフ 1 系統のみ。金額は同じファミリーのまま `tabular-nums` で揃える。
  Google Fonts を足す変更はこの方針の改訂を伴う。

### 未解決（詳細は docs/concerns/task_013.md）

- **[severity: high] `build:web-only` は SDK を物理的に外したビルドではない。**
  import グラフの静的走査＋バンドル grep での代替。物理的に外すには `next.config.ts` か
  `tsconfig.json` の改変が要り、どちらも本タスクの files_to_modify の外。→ task_022
- **[severity: high] いまのモック混入 grep は空振りに近い。**
  どのページも `bootLiff()` を呼んでいないので `.next/static` に LIFF 由来の文字列が 1 件も無い
  （実測）。`process.env.NEXT_PUBLIC_LIFF_MOCK` の定数畳み込みが Turbopack の本番ビルドで
  効くかは**未実測**。最初の `(liff)` ページが入った直後に再実測すること。→ task_014 / task_022
- **[severity: medium] `gate-web-only` ワークフローは 1 度も実走していない**（GitHub リモート未作成）。
  静的検証のみ（`tests/unit/ci/web-only-workflow.test.ts`）。→ deferred: リモート作成後
- **[severity: medium] `(liff)` / `(web)` にページが無いので、両レイアウトが実行される経路は未検証。**
  `resolveLiffId()` の実 Workers 環境での動作、設定不正時のフォールバック分岐はいずれも未実測。
  → task_014 / task_015 / task_022
- **[severity: medium] サポート下限未満の `@supports` 判定は取りこぼす。** 下限値自体も暫定。
  `.browserslistrc` / `tokens.css` / `docs/supported-browsers.md` は 3 点セットで更新すること。→ T-P1-23
- **[severity: medium] テレメトリは記録するだけで集計もアラートも無い。** レート制限バインディングが
  未束縛なので、staging / production では現状 fail-closed の 503 になる。→ task_023 / 035 / 024

## task_007（レビュー修正・2 周目）

### 直したこと

- **封筒の制約絞り込みが部分一致だった**（R-TH-10 違反）。`scripts/build-review-packet.sh` の
  `select([.id] | inside($ids))` は jq の仕様上「`$ids` のいずれかが `.id` を**部分文字列として**
  含むか」を見るため、`constraint_ids: ["L11"]` が `L1` も引き当てていた（`N1`/`N11`/`N12`、
  `W1`/`W12` も同じ）。`select(.id as $i | ($ids | index($i)) != null)` へ置き換えた。
  実測: task_009（`constraint_ids: ["L11"]`）の封筒は修正前 `["L1","L11"]` /
  `constraints_included: 2`、修正後 `["L11"]` / `1`。
- **レビュー封筒のテストがリポジトリの状態を暗黙の入力にしていた。**
  `tests/unit/{merge-review,validate-findings}.test.ts` の多くのケースが `--whitelist` を
  渡さずに起動していたため、`validate-findings.mjs` がリポジトリルートの
  `docs/metrics/model-bench.md`（task_010 が作る予定）を読んでいた。そのファイルが
  出来た瞬間に中身次第で `counts_as_vote` の期待が崩れる。両テストの起動ヘルパを
  「`--whitelist` が明示されていなければフィクスチャを必ず渡す」に変え、
  `scripts/merge-review.sh` に `--whitelist <file>` の受け渡し口を足した。
  実測: リポジトリルートに `approved_models: ["only-some-other-model"]` だけを書いた
  `docs/metrics/model-bench.md` を置いた状態でも 36 件すべて pass（検証後に削除済み）。
- **回帰テスト `tests/unit/build-review-packet.test.ts`（6 件）を追加した。**
  task_007 の `files_to_create` には無いが、1 点目の回帰を固定する先が他に無い
  （他タスクの所有物でもない）。修正前のスクリプトに対しては 6 件中 4 件が赤になることを
  確認してから直している。

### 未解決 / concerns（2 周目時点）

- **[severity: medium] `npm run test:unit` は最終 HEAD でも exit 1。** 落ちているのは
  `tests/unit/gate-constraints.test.ts > "passes on a clean tree"` の
  `Test timed out in 5000ms`（実測 6523ms）**1 件だけ**で、691 件中 690 件は pass。
  同ファイル単体なら 17 件 pass / 7.64s で exit 0、task_007 の 2 テストファイルを
  `--exclude` で外して全体を回しても同じテストが落ちる。原因は全 25 ファイル並列時の
  5 秒既定タイムアウト超過であり **task_007 の成果物ではない**。当該ファイルは
  **task_004 の所有**なので触っていない。直すなら当該 `it()` に明示 timeout を与えること
  （`vitest.config.ts` のグローバル `testTimeout` は他の遅いテストまで一律に緩めるので採らない）。
  → task_004
- **[severity: medium] review-log には出所の担保が無く、レビューを受ける側が
  「敵対レビュー済み」を自作できる。** 手書き封筒 1 通で
  `bash scripts/merge-review.sh task_099 ...` が `decision=pass` / exit 0 を返すことを実測した。
  `scripts/deny-dangerous-bash.sh` は `docs/review-log/**` を守っておらず（exit 0）、
  G13 の対象定義（`scripts/gate-` / `deny-` / `assert-` / `validate-` 接頭辞 ＋ `scripts/ci`）は
  `merge-review.sh` / `build-review-packet.sh` / `review-*.mjs` を含まない。
  **「review-log があること」を「敵対レビューを受けたこと」の証明として扱わない。**
  → task_008（review-log を書く経路）/ task_010（封筒スキーマ）
- **[解消] `npm run gate:constraints` は exit 0 に戻った**（22 grep エントリ / 違反 0 件）。
  1 周目の exit 1 は task_013 の未追跡ファイルのコメント行が原因で、task_013 側が直した。
- **[severity: high] 2 周目の敵対レビュー（round 3）は `reject` で終わっている。**
  有効票 1（Gemini `verified` / `gemini-2.5-pro` / `model_id_source: cli_stats` /
  `cli_version: 0.38.1`）・欠票 1（GPT）・実効 high 2。`docs/review-log/task_007.json` の
  round 3 に記録した。3 件の finding はこの diff が作った欠陥ではなく、封筒に同梱した
  `docs/concerns/task_007.md` の既知の懸念の読み上げで、F-1 = 同 12 / F-2 = 同 1 /
  F-3 = 同 11 に対応する。**3 件とも task_007 の所有ファイルでは直せない**ため未修正のまま
  残した。→ task_004（F-3）/ task_006・task_008・task_009・task_010（F-1）/ PO（F-2）
- **[severity: medium] 封筒は同じサイズでも返る日と返らない日がある。** round 3 では
  76896 bytes が 780 秒でタイムアウトし、43007 bytes に絞って返った。1 周目 round 2 の
  76688 bytes は返っていた。`--max-diff-bytes` の既定 120000 は明らかに大きい。→ task_008 / task_010
- 1 周目からの残懸念（GPT-6 Astra 経路の遮断、G5 のブロッキング化、ホワイトリスト未設定、
  封筒サイズ、CI の adversarial ジョブの入口不一致）は `docs/concerns/task_007.md` のまま。

### 次のアクション（2 周目時点）

1. task_004 が `tests/unit/gate-constraints.test.ts` の当該 `it()` に明示 timeout を与える。
   これが直るまで **CI の acceptance ジョブ（verify_commands の再実行）は落ちる**。
2. task_008 / task_010 が review-log の出所担保（`docs/concerns/task_007.md` の 12）を決める。
   最低でも G13 の `patterns` に `scripts/review-` と `merge-review.sh` /
   `build-review-packet.sh` を足すのは安い。
3. GPT-6 Astra 経路は PO 承認待ち（task_010）。開通するまで「3 ベンダー体制」と称さない。

## task_013（レビュー修正・2 周目）

### 決まったこと

- **`NEXT_PUBLIC_LIFF_MOCK` は「未設定にする」のではなく「`0` を設定する」。**
  1 周目のコード・ADR・懸念が共通して依拠していた「本番ビルドでは未設定だから分岐ごと落ちる」は
  **実測で偽**だった。Next.js の `getNextPublicEnvironmentVariables()`
  （`node_modules/next/dist/lib/static-env.js`）は `for (const key in process.env)` で
  **存在するキーだけ**を define に変換するので、未設定だと定数畳み込みが起きず、
  `await import("./mock")` が到達可能なまま `@line/liff-mock` がクライアントチャンクに載る。
  複製リポジトリに `bootLiff()` を呼ぶ page を置いた実測: 未設定 → `.next/static` に
  `liff-mock` / `LiffMockPlugin` が **2 ファイル**、`NEXT_PUBLIC_LIFF_MOCK=0` → **0 ファイル**
  （`isInClient` はどちらも 2 チャンクに存在するので、後者は「SDK ごと無い」のではない）。
  → `scripts/build-web-only.mjs` の `delete` を `= "0"` に変え、`package.json` の
  `build` / `build:cf` にも `NEXT_PUBLIC_LIFF_MOCK=${NEXT_PUBLIC_LIFF_MOCK:-0}` を前置した。
  **この 2 か所から変数定義を外さないこと。** 外すと `npm run build:web-only` が検査 (0) で落ち、
  `tests/unit/ci/web-only-workflow.test.ts` も落ちる（Next 側の前提そのものも毎回読み直す）。
- **`build:web-only` は「`(web)` の到達範囲」ではなく「禁止側の全走査」で ADR-013 決定 1 を守る。**
  1 周目の起点は `src/app/(web)/**` ＋ `src/app/layout.tsx` の 4 ファイルだけで、
  ルートグループに属さない `src/app/page.tsx`（唯一の実ページ）と `src/middleware.ts` が
  検査から漏れていた。いまは `src/` を全走査して
  「`src/lib/liff/**` と `src/app/(liff)/**` 以外は LIFF を参照しない」ことを直接確かめる
  （走査数 4 → 26 ファイル、import グラフも 4 → 24 ファイル）。
  複製で `src/app/page.tsx` / `src/middleware.ts` に LIFF import を足すと exit 1 になることを実測。
- **静的フォールバックの再試行は既定で常に出す。** 遷移先はアプリの入口 `/`。
  `href=""`（現在の URL）にしないのは、`a[href]` を link ロールへ対応づける規則が
  href の非空を条件にしている実装があるため（`aria-query` の `constraints:["set"]`）。
  現在の URL へ戻したいときは呼び出し側が `retryHref` を渡す。
- **LINE パーマネントリンクは `https://liff.line.me/{liffId}`。**
  出どころはインストール済み `@line/liff` 2.31.0 の同梱物
  （`@liff/permanent-link` の `createUrl` と `@liff/consts` の `PERMANENT_LINK_ORIGIN`）で、
  `docs/vendor-docs/line/liff-sdk.md` §4 に退避した。SDK の `createUrl()` は `init` 成功後に
  しか使えないため、**SDK が落ちたときの導線には使えない**。`liffPermanentLink()` を使うこと。

### 未解決（詳細は docs/concerns/task_013.md）

- **[severity: medium] `(liff)/layout.tsx` の `sdk_unavailable` では「LINE アプリで開く」を出せない。**
  この分岐が出るのは LIFF ID そのものが解決できないときなので、リンクの材料が無い。
  check_078 の 3 導線が実画面で揃うのは、`bootLiff()` の結果を画面が受ける task_014 以降。
  そこで `liffPermanentLink()` と現在の URL を渡すこと（C-013-9）。
- **[severity: medium] `gate-web-only` は push では緑だが、PR と 2 周目修正版はまだ通っていない。**
  作業中に GitHub リモートが作成され、`gate-web-only / web-only` は 2 回とも success
  （run 35985828331 / b1bc328、35984699932 / 62e31be。どちらも `push` イベント）。
  ただし**走ったのは `delete env[...]` のままの 1 周目のスクリプト**であり、
  2 周目の修正コミットは未 push（`git push` は禁止コマンド）。`pull_request` での緑も無い。
  branch protection は `404 Branch not protected` で、required status checks も未登録（task_009）。
  この項目が残る限り task_013 を「完全達成」として扱わない（C-013-3）。
- **[severity: medium] check_079 と R-LINE-04 はまだ「達成」ではない。**
  本リポジトリの `.next/static` には LIFF 由来の文字列が 1 つも無く、
  SDK が載った状態での grep は 1 度も走っていない（C-013-4）。→ task_014 で再実測。
- **`npm run test:unit` は本タスクの最終状態でも exit 1。** 落ちるのは
  `tests/unit/gate-constraints.test.ts` の 1〜2 件のみで、原因は既知の 5 秒タイムアウト
  （上の「task_004 が当該 `it()` に明示 timeout を与える」）。単独実行では 17/17 緑（7.89 秒）、
  フルスイートでも `--testTimeout=30000` なら **720/720 緑**。本タスクの 5 ファイル
  （liff / components / telemetry / ci）は常に緑。→ task_004

## task_007（レビュー修正・3 周目 — BLOCKED へ訂正）

### 決まったこと

- **task_007 の完了ステータスを `DONE_WITH_CONCERNS` から `BLOCKED` へ訂正した。**
  敵対レビューは round 1 = `not_established` / round 2 = `pass` / round 3 = `reject`
  （実効 high 2）で 3 周を消化済み。`docs/implementation-plan.md` §15-3 step 5 の
  「3 周後も high が残れば BLOCKED で PO 裁定（`DONE_WITH_CONCERNS` で通すことを禁止）」と
  `check_066` の expected_result に反する状態のまま完了扱いにしていたため。
  `docs/task-list.json` の `completion_status` と `docs/PROGRESS.md` の宣言 2 か所を
  そろえた（`npm run gate:check` の G4 は「台帳との食い違い 0 件」）。
- **PO 裁定に上げる**: F-2 = GPT-6 Astra 経路の遮断解除（`~/.codex/hooks/
  block-non-claude-model.sh`）。§16-1 の 4 / F13 により **AI は解除してはならない**。
  これが解けるまで敵対レビューは Gemini 単独であり「3 ベンダー体制」とは呼べない。
- **所有タスクへ起票**: F-1 = review-log の出所担保 → task_006（`deny-dangerous-bash.sh`）/
  task_009（`docs/gates/integrity-baseline.json` の対象接頭辞）/ task_008・task_010（封筒スキーマ）。
  F-3 = `tests/unit/gate-constraints.test.ts` の 5 秒タイムアウト → **task_004**。
- **F-1 のうち task_007 の所有ファイルで閉じられる部分は実装した**:
  `scripts/merge-review.sh` にベンダー独立性の判定を入れた。`--author-vendor`
  （既定 `claude`）と同じ `vendor` の封筒は `classification: "self_review"` として
  記録し、**有効票から外す**（§16-1 の 2「検出者と作者は別ベンダー」）。
  summary に `vendors` / `author_vendor` / `self_reviews` を出す。
  **自己レビューの実効 high は差し戻しに数える** — 票にしないことと指摘を無視することは別。
  実測: 同じ自作封筒 1 通に対し HEAD `48f3061` は `pass` / exit 0、修正後は
  `not_established` / exit 3。`--author-vendor none` で従来動作に戻せる。
- `docs/review-log/README.md` に「`vendor: "claude"` は自己レビューであり敵対レビューの
  票にならない」を明記した。**「review-log がある」ことを「敵対レビューを受けた」ことの
  証明として扱わない**（封筒の改竄防止はまだ無い）。
- `docs/task-list.json` の末尾改行を戻した（commit `0a060bf` が削っていた）。
  同コミットが task_001 / task_013 のエントリも巻き込んでいた件は
  `docs/concerns/task_007.md` の 18 で報告を訂正した（内容は各所有タスクの宣言と一致する
  ため revert はしない）。**共有台帳は自タスクのエントリだけを変更してステージする。**

### 未解決

- **task_007 は BLOCKED。PO 裁定待ち。** 解除条件は、所有タスク側で F-1 / F-2 が
  解消してから 4 周目の敵対レビューを回して `pass` を取り直すこと。
- **副作用**: `scripts/gate-check.mjs` の G5 は「task_007 が DONE 系になるまで warn」
  という実装なので、**BLOCKED にすると G5 は warn へ戻る** [実測]。§15-2 の文言どおりの
  帰結だが、review-log を持たない完了済みタスク（task_005 / 006 / 011 / 012）が当面
  ブロックされない。**意図した緩和ではない。** → 4 周目で DONE 系に戻れば再び効く。
- **`npm run test:unit` は exit 1 のまま**。落ちるのは task_004 所有の
  `tests/unit/gate-constraints.test.ts` の 3 件のみで、いずれも
  `Test timed out in 5000ms`。`--testTimeout=30000` を付ければ **727/727 緑**
  （task_007 起因の失敗 0 件）。**CI の acceptance ジョブは verify_commands を再実行する
  ので、直るまでそこで落ちる。** → task_004
- **ベンダー独立性は「作者が自分の名前で自分を通す」経路を塞いだだけ**で、
  「他人の名前を騙る」経路（手書きの `vendor: "gemini"` 封筒）は塞いでいない。
  `docs/review-log/**` は `deny-dangerous-bash.sh` の保護対象外で、G13 の対象接頭辞も
  `merge-review.sh` / `build-review-packet.sh` / `review-*.mjs` を含まない。
  → task_006 / task_008 / task_009 / task_010
- **GitHub リモートは作成済み**（`origin git@github.com:sawanori/cashapp.git` [実測]）だが
  **`git push` は本ハーネスの禁止コマンド**なので、`adversarial` ジョブの追加と実走は
  引き続き deferred（理由が「リモート不在」から「push は人手の操作」へ変わった）。
  → PO / task_009 / task_010
- `scripts/merge-review.sh` のエラー経路のメッセージが bash 3.2 で
  `f…: unbound variable` になり exit 64 が exit 1 になる [実測]。正常系は影響なし。
  今回の指摘範囲外のため未修正（`docs/concerns/task_007.md` の 19）。

## task_013（レビュー修正・3 周目）

### 直したこと

- **`liff.init()` にも 3 秒タイムアウトを掛けた**。2 周目までは SDK の動的 import
  （`loadLiff()`）だけが `withTimeout()` に包まれ、`liff.init()` は素の `await` だった。
  `init()` は LINE のサーバーへ LIFF アプリ設定を取りに行く**ネットワーク処理**なので、
  電波が悪い場面では reject もせず settle しない。その経路では `bootLiff()` が永久に解決せず、
  `sdk_unavailable` も `init_failed` も返らないまま画面が loading のまま残る
  ＝ R-LINE-03 が防ぎたい白画面になっていた。時間切れは reject と同じ `init_failed` ＋
  テレメトリ `liff_init_failed` にした（タイムアウト専用コードは足していない。
  画面の分岐も監視で数える単位も「init が成立しなかった」で同じだからである）。
- **`NEXT_PUBLIC_LIFF_MOCK` は「定義されていること」ではなく「`0` に固定されていること」を見る。**
  2 周目は `package.json` を `NEXT_PUBLIC_LIFF_MOCK=${NEXT_PUBLIC_LIFF_MOCK:-0}` と
  外部値を尊重する形にし、`checkProductionBuildEnv()` も `includes("NEXT_PUBLIC_LIFF_MOCK=")`
  しか見ていなかった。この組み合わせでは、デプロイ環境に `NEXT_PUBLIC_LIFF_MOCK=1` を置くだけで
  ゲートもテストも緑のまま `@line/liff-mock` が本番バンドルに載る。右辺を `0` リテラルに固定し、
  ゲートも右辺まで検査する形に強めた。**モックを有効にしたビルドが要る場合は本番ビルド経路を
  書き換えない** — Playwright の `webServer` は `npx next dev` なので `.env.local` で足りる。
- **`StateView` の ①②③ は 1 つのまとまり。** `permanentLink` が無いとき ③ の QR 注記だけが
  残ると、画面には「いま見ている端末では読み取れません」＝**できないことしか書かれない**。
  リンクが無いときは ③ も描かない（本文「LINE アプリで開いてください」は残る）。
  `permanentLink` を型で必須化する案は採っていない。呼び出し側（task_014）が LIFF ID を
  解決できない場面があり、その場合に渡せる値が無いためである。

### 実測で埋まったこと

- `gate-web-only` は **2 周目の修正版で緑**（run 35989181733 / head `d722cc4` / job `web-only` /
  event push）。`git merge-base --is-ancestor 4d22062 d722cc4` が真であることを確認した。
  2 周目に「走ったのは 1 周目のスクリプト」と書いた状態は解消している。
- ゲートの非空振り: fixture の木に `scripts/build-web-only.mjs` を複製して spawn し、
  `=1` / `${NEXT_PUBLIC_LIFF_MOCK:-0}` / 未定義で exit 1、`=0` で exit 0 を確認
  （`tests/unit/ci/web-only-workflow.test.ts`）。
- `init` タイムアウトの非空振り: 修正を一時的に素の `await` へ戻すと、新しいテストが
  `Error: Test timed out in 5000ms` で落ちる（＝ `bootLiff()` が解決しない）ことを確認して戻した。

### 未解決（詳細は docs/concerns/task_013.md）

- `pull_request` イベントでの `gate-web-only` 緑と、3 周目の修正の CI 実走は未了。
  `git push` は本プロジェクトの禁止コマンドなので、このエージェントからは実走させられない。
  required status check への `gate-web-only / web-only` の登録は task_009 が「いまは入れない」と
  判断済みで、解消時期はその判断に従う。→ C-013-3 / task_009 / PO
- **配信される実物への grep が CI に無い。** `gate-web-only` が grep するのは
  `build:web-only` が自前で `NEXT_PUBLIC_LIFF_MOCK=0` を渡して作った別ビルドで、
  実際にデプロイされる `npm run build:cf`（OpenNext 成果物）は誰も grep していない。
  `.github/workflows/release.yml` は task_009 所有のため本タスクでは足していない。
  → C-013-11 / task_009 / task_022
- `npm run test:unit` は **exit 1 のまま**。落ちるのは `tests/unit/gate-constraints.test.ts` の
  2 件で、どちらも `Error: Test timed out in 5000ms`（アサーション失敗ではない）。
  `npx vitest run tests/unit --testTimeout=30000` なら 26 ファイル **734/734 緑**。
  本タスクは当該ファイル・`scripts/gate-constraints.sh`・`docs/constraints.json` を
  1 行も触っていない（最終更新 `7ba8eae` / task_004）。→ C-013-12 / task_004

## task_009（レビュー修正・4 周目）

### 直したこと

- **[high] acceptance の再実行ループが、標準入力を読むコマンド 1 本で後続を全部飛ばしていた。**
  一覧を `done < <(jq …)` でループの標準入力として流し込んでいたため、
  `npm` スクリプトが標準入力を読むと残りの一覧を食い尽くし、**後続の `verify_commands` が
  実行されないまま「失敗 0 / exit 0」で緑**になった。スキップした旨の出力すら出ない。
  実測: 台帳が `["npm run aaa-eats-stdin","npm run zzz-should-fail"]`
  （前者 `cat > /dev/null`、後者 `exit 7`）のとき、
  旧実装は `実行 1 / 委譲 0 / 失敗 0` で **EXIT=0**。`aaa-eats-stdin` を外すと
  同じ `zzz-should-fail` が `FAIL` / EXIT=1 になる。つまり**台帳に 1 行足すだけで
  F2（完了の過大申告）の最終防衛線が無音で外せた**。
  一覧の読み出しを fd 3 に逃がし（`while IFS= read -r cmd <&3; … done 3< <(jq …)`）、
  再実行の子プロセスの標準入力を `npm run "$name" < /dev/null` で塞いだ。
  同じ fixture で修正後は `実行 1 / 失敗 1` / EXIT=1。
  あわせて「対象 0 件」の判定を `RAN + SKIPPED` ではなく**読めた行数 `TOTAL`** に変えた
  （全件が形式違反のときに「台帳の読み取りが壊れている」と誤記していた）。
- **[medium] `release.yml` の (a) 段の `PAYMENTS_ENABLED` 検証が空振りだった。**
  走査対象 5 ファイル（`wrangler.toml` / `workers/cron/wrangler.toml` / `next.config.ts` /
  `open-next.config.ts` / `.env.example`）のどれにも `PAYMENTS_ENABLED` という文字列が無く、
  `true` を探す `grep` は構造上 1 件も当たらないまま常に通っていた。
  「`true` の不在」ではなく「**`false` の明示が 1 件以上あること**」を要求する形に変え、
  走査対象にフラグの正本（`supabase/migrations/*.sql` の `feature_flag` seed）を加えた。
  旧実装はフラグ不在の fixture で EXIT=0、修正後は
  `走査対象のどこにも PAYMENTS_ENABLED=false の明示がありません` / EXIT=1。
- **[medium] `release-gate` の 2 段ゲート本体（シェル）に自動テストが 1 本も無かった。**
  `assert-release-gate.mjs` は `run:` 本文の文字列と構造しか見ておらず、分岐の判定は無検証。
  acceptance 側と同じ手法（実 YAML から `run:` 本文を取り出して一時ディレクトリで `bash` に
  食わせる）で `tests/unit/ci/release-gate-shell.test.ts` を新設した。
  `docs/gates/` は fixture のディレクトリ名に置換するので、PO 専管の `docs/gates/**` には
  一切書き込まない。`npm ci` / `npm ls` も fixture 読みに置換し、
  **置換が空振りしたらテストが即座に落ちる**ようにした。31 件。
- **branch protection を設定した（check_039 達成）。** 3 周目に書いた解除条件
  （`origin/main` がローカル `main` まで進み、その commit で `gate` が緑）が満たされた。

### 実測で埋まったこと

| 実測 | 結果 |
|---|---|
| `git rev-parse origin/main` / ローカル `main` | どちらも `d722cc4`。`git rev-list --count origin/main..HEAD` = **0**（3 周目は `b1bc328` / 10） |
| `gate` run 35989181608（`d722cc4`） | ワークフロー全体 **success**。9 ジョブ中 8 success ＋ `adversarial` skipped |
| `gate-integration` run 35989181611 / `gate-web-only` run 35989181733 | どちらも success |
| `gh api -X PUT …/branches/main/protection` の読み戻し | required 11 件（`static` / `gate-meta` / `gate-integrity` / `secrets` / `deps` / `acceptance` / `test-tamper-guard` / `date-boundary` / `labels` / `security` / `integration`）・`approvals: 0`・`strict: false`・`force_push: false`・`deletions: false`・**`enforce_admins: false`** |
| 実台帳（16 本）を修正後のループに食わせた dry-run | `実行 14 / 委譲 2 / 失敗 0 / 形式違反 0`。形の縛りに引っかかる既存エントリは 0 件 |

### 未解決 / concerns（4 周目時点）

- **`enforce_admins` は false のまま**。管理者（唯一の push 者）は required status checks と
  PR 必須を迂回して `main` に直接 push できる。理由: required の `acceptance` は
  `gate:check` を再実行するので、G5 が FAIL になれば `main` が赤になる。G5 は
  「task_007 が DONE になるまで warn」であり、DONE の瞬間に FAIL へ転じうる。
  さらに 4 周目の実測では、ローカルの G5 が `ok` なのは
  **task_005 / 006 / 011 / 012 の `docs/review-log/*.json` 4 本が未追跡で
  ワーキングツリーに存在するから**で（`git status --short docs/review-log/` が `??` 4 件）、
  CI がチェックアウトする commit にはまだ入っていない。
  `enforce_admins: true` でこれが FAIL に振れると、実装エージェントが `git push` できない
  本ハーネスでは `main` が凍結し R-TH-04 を自作することになる。
  **解除条件**: (1) `docs/review-log/` の 4 本が commit 済み、(2) `gate:check` の G5 が `ok` で
  task_007 が DONE、(3) `main` の `gate` が success。→ task_010
- **PR 経路（check_131）は deferred のまま**。`test-tamper-guard` は `on: pull_request` のみで、
  PR が 1 本も無いため 1 度も起動していない（`gh run list --workflow gate-tamper.yml` /
  `gh pr list --state all` はいずれも 0 件）。PR を作るにはリモートへの publish が要り、
  `git push` は本ハーネスの禁止コマンドである（`gh api` でのブランチ作成も同じ趣旨に当たる
  と判断した）。4 周目で required に入れたので、PR が 1 本立てば必ず起動する。→ PO / task_010
- **`docs/gates/release-mode.json` は依然として存在しない**（`deny-test-weakening.sh` が
  `docs/gates/**` への Write を無条件に遮断する）。check_130 の 2 通りは GitHub 上では未実測。
  ただし判定そのものは `tests/unit/ci/release-gate-shell.test.ts` の 31 ケースで固定した。→ PO
- **(a) 段の `PAYMENTS_ENABLED` 検査は依然としてテキストの `grep`** であり、実行時に
  アプリが読む値そのものではない。migration や設定のコメントに `PAYMENTS_ENABLED = true` と
  書くだけで赤になる（fail-closed 側なので安全だが偽陽性）。本番 DB の `feature_flag` が
  seed 以降に UPDATE されていても検出できない。恒久対処は決済タスクで
  「本番 DB の `feature_flag` を読む」判定を足し、`release-gate` から呼ぶこと。→ task_022 系

## task_007（レビュー修正・4 周目 — BLOCKED のまま）

**決まったこと**

- **封筒の宛先（`task_id`）を照合するようにした**。`scripts/merge-review.sh` は封筒の
  `task_id` と畳み先の `task_id` を比べていなかったため、**他タスクで正規に取得した封筒を
  そのまま渡すだけで** 任意のタスクに `decision: pass` / exit 0 を作れた。改竄も偽造も要らない。
  実測（負の対照つき）: `task_id: "task_009"` の正規形式の封筒 1 通を task_007 へ畳むと、
  修正前は `pass … 有効票=1 投票ベンダー=gemini` / **exit 0**、修正後は
  `not_established … 有効票=0 … 宛先違い=1` / **exit 3**。封筒の `task_id` を `task_007` に
  直せば exit 0 に戻る。不一致は `classification: "task_mismatch"` として記録し、
  有効票にも欠票にも**実効 high にも**数えない（別の diff に対する指摘だから）。
- **作者自身の懸念台帳をレビュー対象から外した**。`scripts/build-review-packet.sh` は
  diff が触れた全ファイルの全文を同梱していたので、`docs/concerns/<task_id>.md` が必ず
  封筒に入り、**レビュアは作者が書いた既知懸念を読み上げるだけで high を作れた**。
  懸念を誠実に記録するほど差し戻しやすくなるため 3 周ループが構造的に収束しない
  （round 3 の finding 3 件はすべて `docs/concerns/task_007.md` の既存項目と 1 対 1 対応）。
  `docs/concerns/**` / `docs/HANDOFF.md` / `docs/PROGRESS.md` を `artifact.diff`（pathspec 除外）と
  `artifact.files` の両方から外し、**中身は同梱せず**パス・バイト数・理由だけを
  `artifact.excluded_paths` と `self_declared_concerns`（`content_included: false`）に残す。
  `reply_format.finding` に `duplicate_of` とルール 2 本を足した。
  実測: 同じ範囲（`--base HEAD~1 --head HEAD`）で `artifact.files` 14 → 11 本、
  payload **479,449 → 151,359 bytes**、diff 中の自己申告ハンク 3 → 0 本。
- テストは減らしていない。`tests/unit/merge-review.test.ts` 20 → 25 件、
  `tests/unit/build-review-packet.test.ts` 6 → 11 件（後者は実 git リポジトリの
  フィクスチャを作り、`SENTINEL_*` の本文が封筒の生テキストのどこにも出ないことを固定した）。

**未解決**

- **task_007 は BLOCKED のまま**。§15-3 step 5 の「3 周後も high が残れば PO 裁定」に該当し、
  未修正の実効 high 2 件は F-2（GPT 経路の遮断解除 = PO 承認事項。AI は解除しない）と
  F-1 の残り（封筒そのものの改竄防止 = task_006 / 008 / 009 / 010）である。→ PO
- **G5 はエントリの `task_id` も `classification` も見ない**。宛先違いで exit 3 に終わった
  周回でも、review-log に残ったエントリだけで G5 は充足する。`scripts/gate-check.mjs` は
  task_006 の所有なので本タスクでは触っていない。→ task_006
- **`npm run test:unit` はフレーキー**。同一 HEAD で連続 2 回走らせ、1 回目 exit 0
  （790/790 pass）、2 回目 exit 1（`tests/unit/gate-constraints.test.ts` の 2 件が
  `Test timed out in 5000ms`）。原因は task_004 所有ファイルの 5 秒タイムアウトで
  task_007 側に直せる箇所は無い。CI の acceptance は verify_commands を再実行するため、
  当該 `it()` に明示 timeout が入るまで赤になり得る。→ task_004
- 自己申告のパス集合（`docs/concerns/**` / `HANDOFF.md` / `PROGRESS.md`）は
  `build-review-packet.sh` 内の固定リストである。台帳を別の場所に書けばこの扱いから外れる。
  パス集合の正本化は封筒スキーマ側で決めること。→ task_008 / task_010

## task_008（Workflow スクリプト 3 本: task-loop / premortem / release-audit）

### 決まったこと

- **3 本は `.claude/workflows/*.ts` に置いたが、中身は素の JavaScript である**。Workflow スクリプトは
  TypeScript ではなく、型注釈・interface・generics はパースに失敗する（`workflow-authoring` スキル）。
  拡張子が `.ts` なのはタスク台帳の `files_to_create` がそう定めているためで、型は書けない。
  `tsc` は `.claude/**` を拾わない（`include: ["**/*.ts"]` はドットディレクトリを辿らない。
  `npx tsc --noEmit --listFiles | grep -c 'cashapp/.claude'` = 0 で実測）。**ESLint は拾う**
  （flat config の既定 ignore は `node_modules` と `.git` だけ。`eslint .` の JSON 出力に
  `/.claude/` のファイルが 1 件出ることで実測）ので、`npm run lint` は通る形で書いてある。
- **`Date.now()` / `new Date()` / `Math.random()` は使えない**（resume が壊れるため呼ぶと throw する）。
  `premortem.ts` の出力ファイル名に使う日付は `args.date`、無ければ `date -u +%Y-%m-%d` を
  1 回だけ叩くエージェントから取る。テスト（`workflow-scripts.test.ts`）がこの 3 つの不在を機械検査する。
- **スクリプトからファイルシステムを触れない**。だから台帳の読み書き・run-log への記録・
  `docs/premortem/<date>.json` の書き出しは、すべて Bash を持つエージェント側の仕事として
  プロンプトに書いてある。スクリプト本体がやるのは制御フローと判定だけである。
- **`task-loop.ts` のステータス決定点は 1 か所だけにした**。`highRemaining > 0` を最初に評価し、
  実効 high が残っている限り `terminal` が何であれ `BLOCKED` を返す。§15-3 step 5 の
  「3 周後も high が残れば BLOCKED（`DONE_WITH_CONCERNS` で通すことを禁止）」は、
  task_007 で実際に `DONE_WITH_CONCERNS` で閉じられ後から訂正された経緯があるため、
  規則をプロンプトではなくスクリプトの分岐順序に埋めてある。
- **欠票は「票の無効」ではなく「投票が届かなかった事実」として周ごとに残す**。
  `reviewer_route !== "ok"` のレーンは `abstentions[]` に `attempted_command` と
  `unreachable_reason` つきで積み、有効票ベンダーからは外す。作者ベンダー（`claude`）は
  有効票に数えないが、そこが出した high は差し戻しに数える（task_007 の merge-review と同じ規律）。
- **`release-audit.ts` は判定を票数ではなく成立条件 6 項目で出す**。5 項目は
  `release-auditor.md` のもの、6 項目めは計画書 §15-3 の「`cleared=false` なら無条件 no-go」である
  （`release-auditor.md` の条件 4 と食い違う。C-008-3 で PO 裁定へ）。
  材料が読めない・UNKNOWN 票があるときは go でも no-go でもなく `UNKNOWN` を返す。
- **検証は Workflow ランタイムではなくテストで行った**。ランタイムと同じラップ
  （本体を `AsyncFunction` にして `agent` / `parallel` / `pipeline` / `phase` / `log` / `args` /
  `budget` / `workflow` を注入）でスクリプト本体を実際に走らせる 41 件
  （`tests/unit/workflows/workflow-scripts.test.ts`）。判定ロジックには手を入れず、
  エージェントの応答だけを差し替えている。非空振りの対照も取った（PROGRESS.md 参照）。

### 未解決

- **[severity: medium] 3 本とも Workflow ツールで 1 度も起動していない**。本セッションのツール一覧に
  `Workflow` が無く、`ToolSearch` の `select:Workflow` も `No matching deferred tools found` を返した。
  runId も journal も無い。**再開時はまず `dryRun: true` で 3 本を回し、runId を
  `scripts/record-run.sh --manual task_008` で記録すること**（`dryRun` を付けないと
  task-loop は実際にファイルを書き換えるエージェントを起動する）。→ C-008-1
- **[severity: medium] `agentType` / `model` の解決が未検証**。`.claude/agents/` の 6 本を
  `agentType` で参照し、`model` には `"opus"` / `"sonnet"`（同ディレクトリの frontmatter と同じ値）を
  渡している。ランタイムがこれをどう解決するかは実走していない。→ C-008-2
- **[severity: medium] `.claude/workflows/**` は G13 の対象領域**。3 本を足した時点で
  `npm run gate:integrity` が exit 1（G13 追加 3 件）になったので `--write-baseline` で
  再生成した（43 ファイル / 不一致 0）。**この先 `.claude/workflows/` を 1 行でも直したら
  同じ再生成が要る。** 洗浄リスクそのものは task_038。→ C-008-4
- **[severity: low] `docs/premortem/*.json` に形式ゲートが無い**。7 項目の欠けた item が混ざっても
  落ちない。作るなら「対象 0 件のまま合格するゲート」にしないこと（R-TH-01）。→ C-008-9
- task_007 から送られた「封筒の自己申告パス集合の正本化 → task_008 / task_010」は
  task_008 の scope にも `files_to_create` にも無いため触っていない。→ task_010（C-008-8）

## task_008（レビュー修正・6 周目）

### 決まったこと

- **実効 high は周をまたいで持ち越す**。`task-loop.ts` は `highRemaining = roundHigh.length` で
  毎周上書きしていたため、high を出したレビュア経路が最終周で不達（欠票）になるとその high が消え、
  誰も直していないのに `DONE` で閉じていた（修正前の HEAD をランタイム同形のラップで走らせた実測:
  `status: "DONE"` / `effective_high_remaining: 0`）。未解消 high を `unresolvedHigh` に貯め、
  **その周に有効票（`reviewer_route === "ok"`）を返したレーンが挙げなくなった分だけ**落とす。
  欠票したレーンは自分の過去の high を落とせない。同一性キーは `reviewer + id`（id が無ければ
  `reviewer + file + summary`）。修正後は同じ応答表で `BLOCKED` / `effective_high_remaining: 1`。
- **有効票を返した独立ベンダーが 0 件の周は DONE 系で閉じない**。`votingVendors.length === 0` の周は
  「監査されていない周」であり、high 0 件で打ち切るときに `BLOCKED` にする。欠票を「指摘なし」と
  読み替えないための歯止め（F6 / R-TH-06）。返り値に `audited_rounds` / `unresolved_high` /
  各周の `audited` / `carried_high` / `unresolved_high_after` を出すようにした。
- **`release-audit.ts` の成立条件 1 は独立ベンダー 2 件**（`independentGoVendors.length >= 2`）。
  作者 claude ＋ 独立 1 件の計 2 票で go になる緩い読みは fail-open なので採らない。
  副作用として、gemini / gpt のどちらかが不達だと PO が不達を承認しても go に到達できない。
  「独立」の定義の一本化は C-008-10（ADR 待ち。C-008-3 と同じ ADR にまとめてよい）。

### 未解決

- **[severity: medium] `done_definition` 第 1 項はまだ deferred**。6 周目のセッションでも
  `ToolSearch select:Workflow` は `No matching deferred tools found`。runId は 1 つも無い。
  **Workflow ツールを持つセッションで `dryRun: true` の 3 本を回すまで DONE へ昇格させない。** → C-008-1
- **[severity: medium] 成立条件 1 の解釈**。fail-closed 側で固定したが、独立レーンが 2 本しか無い
  現状では成立条件 3（不達の PO 承認）が独立ベンダーの不達では効かない。→ C-008-10
- `.claude/workflows/*.ts` を 2 本直したので G13 基準値を `--write-baseline` で再生成した
  （差分は当該 2 エントリと timestamp のみ）。**この先も同ディレクトリを直すたびに要る。** → C-008-4

## task_008（レビュー修正・7 周目）

レビューの high 1 / medium 2。**実装で直したのは 2 件**、残る 1 件（Workflow ツール不在）は deferred のまま。

### 決まったこと

- **独立性の会計に封筒の自己申告 `vendor` を使わない**。`task-loop.ts` / `release-audit.ts` は
  レーン定数 `lane.vendor`（`code-reviewer` / `release-auditor` = `"claude"`）を、レビュアが返した
  `env.vendor` / `res.vendor` で上書きしてから `AUTHOR_VENDOR` 判定していた。作者ベンダーのレーンが
  封筒に `vendor: "gemini"` と書くだけで独立票に化けられる（修正前 HEAD 3bdf5d4 で
  `task-loop` = `DONE` / `voting_vendors=["gemini"]`、`release-audit` = `go` /
  `independent_go_vendors=["gemini","gpt"]` を実測）。**数える値は常にレーン定数**とし、
  自己申告は「レーン定数と一致するか」の照合にだけ使う。
- **票として数える封筒の 3 条件**（`reviewer_route === "ok"` に加えて）:
  ①`vendor` がレーン定数と一致 ②`model_id_actual` が非空 ③`findings` が配列
  （`release-audit.ts` は ③ の代わりに `verdict` が `go` / `no-go` / `UNKNOWN` のいずれか）。
  満たさない封筒は `reviewer_route: "invalid_envelope"` の欠票（`abstentions`）へ落とし、
  理由を `reason` に残す。これは `scripts/validate-findings.mjs` / `scripts/review-gpt.mjs` /
  `.claude/agents/adversarial-reviewer-gemini.md` が既に採っている規律（§16-2 / R-TH-11）に揃えたもの。
  レビュア向けプロンプトにも同じ 3 条件を明記した。
- **G13 基準値は他タスクの未コミット差分を焼き込まない形で書く**。今周は別タスクが G13 対象の
  スクリプトを未コミットで編集中だったので、`git ls-files` + `tar` で作業ツリーの追跡ファイルを
  退避先へ複製し、**当該ファイルだけ `git show HEAD:` の内容へ戻した木**を `--root` に、
  リポジトリを `--base` に渡して `--write-baseline` した。task_004 / task_012 が同じ手を取っている。
  差分は `.claude/workflows/*.ts` の 2 エントリと timestamp のみ（実測）。退避対象は周回中に
  変わっており（HEAD `ffe9f01` 時点は `scripts/gate-env-scope.mjs` 1 件、最終コミット時点
  HEAD `12fc3b9` は `scripts/gate-constraints.sh` / `scripts/wording-lint.mjs` の 2 件＝task_004）。

### 未解決

- **[severity: medium] `done_definition` 第 1 項はまだ deferred**。7 周目のセッションでも
  `ToolSearch select:Workflow` は `No matching deferred tools found`。runId は 1 つも無い。
  **Workflow ツールを持つセッションで `dryRun: true` の 3 本を回すまで DONE へ昇格させない。** → C-008-1
- **[severity: low] `npm run gate:check` は G13 のみ不合格（exit 1）**。最終コミット時点の出どころは
  **task_004 が未コミットで編集中の `scripts/gate-constraints.sh` / `scripts/wording-lint.mjs` の 2 件**で、
  task_008 の変更ではない。**所有タスクがコミット時に基準値を再生成すれば解消する**。
  task_007 が 4 周目に「G13 は task_009 の未コミット差分」と記録したのと同じ扱い。
- **[severity: low] 共有台帳はファイル単位で他タスクに取り込まれる**。本周の
  `docs/task-list.json` / `docs/PROGRESS.md` への追記は、並行していた task_012 のコミット
  `10b4e7f` が先に取り込んだ（当人が共有ファイルを明示 `git add` した副作用）。内容は失われていないが、
  **「自分の追記が自分のコミットに入る」とは限らない**。完了報告では commit SHA ではなく
  ファイルの最終内容を根拠にすること。
- **[severity: low] 持ち越し high の同一性キーは `reviewer + id`（`id` が無ければ
  `reviewer + file + summary`）のまま**。同じ指摘を毎周わずかに違う文言で返すレビュアがいると
  別件として積み上がり、逆に `id` を付けないレビュアが要約を変えただけでも持ち越しが切れる。
  封筒スキーマ側で finding の `id` を必須化するのが筋で、これは task_010 の担当。

## task_013（レビュー修正・4 周目）

GPT-6 Astra の敵対レビュー（high 1 / medium 2）。**再現 2 件・非再現 1 件**。

### 決まったこと

- **[high F-1] ストレージが使えない環境でも打ち切る（fail-closed）**。`storage` が `null`／
  読み書きが例外の場合、`readAttempts` が毎回 0 を返し `writeAttempts` が何も残さないため、
  未ログインで戻り続けると 3 回目以降も `login()` が呼ばれていた（HEAD で再現。
  `expected 1 to be 2` ほか 3 件赤）。`src/lib/liff/client.ts` にモジュール内の退避カウンタ
  `memoryAttempts` を置き、「`null`／`getItem` が throw／値が壊れている／読めたが未記録」の
  いずれでも 0 ではなく退避先を返す形にした。`setItem` が成功した回だけ退避先を使わない。
  **既存の「`storage: null` でも起動を止めない」テストは弱めていない**（初回は従来どおり
  `redirecting_to_login`）。→ 残懸念は C-013-13
- **[medium F-2] HEAD では再現しない**。封筒は 2 周目の `4d22062` の木に対して組まれており、
  3 周目の `455e594` で `liff.init()` も `withTimeout()` に包み済み。4 周目は封筒の repro を
  **既定のタイムアウト**でなぞるテストを足して pass を実測し、素の `await` に戻すと
  `Test timed out in 5000ms` で落ちる（空振りでない）ことも確認した。→ C-013-14
- **[medium F-3] 本文は上限までしか読まない／レート制限は本文より前**。
  `Content-Length` の無い chunked 本文では `request.text()` が読み終えるまで上限を検査しないため、
  256 バイト上限が受信量を一切制限していなかった（HEAD で再現。4096 バイトを全部読んでいた）。
  `readBoundedBody()` を追加してチャンクごとに読み、超えた時点で `reader.cancel()` して 400。
  レート制限の判定を本文読み込みより前へ移した（バックエンドが無いときは
  `request.bodyUsed === false` のまま 503）。→ C-013-15

### 未解決

- **[severity: medium] F-1 の修正が効くのはページ 1 回分**。`login()` はページ遷移を起こすので、
  `sessionStorage` がまったく使えない端末では復帰時に退避カウンタも 0 に戻る。
  再読み込みをまたいで数えるには回数を URL（`redirectUri` のクエリ）へ持ち出す必要があり、
  それは `(liff)` 画面側（task_014）の設計判断。→ C-013-13
- **[severity: medium] `npm run test:unit` は exit 1**。最終 HEAD での実測では赤は
  `tests/unit/gate-constraints.test.ts` の `Error: Test timed out in 5000ms` だけで
  （947/958 pass・単独実行は 30/30 緑）、既知の C-013-12（task_004 の担当）である。
  作業中は並行編集中の他タスクの未コミットファイル起因の赤も混ざり、実行ごとに顔ぶれが
  変わった（5 → 22 → 11 件）。**task_013 所有テストの赤は一度も出ていない**
  （`tests/unit/liff` / `telemetry.test.ts` / `components` で 101/101 緑）。

### 2 巡目（1 巡目の修正に対する敵対レビューを受けて）

- **gemini と GPT-6 Astra が独立に同じ high を挙げた**（merge-review: `reject` / 有効票 2 /
  実効 high 2）。1 巡目の `readAttempts` が**保存値を退避先より優先**していたため、
  `getItem` は成功するが `setItem` が落ちるストレージ（quota 超過）では保存値 `"1"` を読み続け、
  退避カウンタがいくら増えても打ち切りに到達しない。**再読み込みをまたがなくても起きる**。
  `Math.max(memoryAttempts, readStoredAttempts(storage))` に直した。→ C-013-16
- gemini の medium も塞いだ。`readBoundedBody` の非ストリーム経路が `request.text()` で
  読み切ってから測っており、ストリーム側の上限を迂回していた。`body === null`（本文なし）だけ
  `text()` を使い、**本文はあるのに読み取り機が無い**場合は読まずに 400（fail-closed）。→ C-013-17
- **教訓**: 1 巡目に足した「読めるが書けない」テストは `getItem` が常に `null` を返す形だったので、
  「古い値が読める」経路を踏んでいなかった。ストレージの故障モードは
  「読めない」「書けない」「古い値が読める」の 3 つに分けて書くこと。

### 3 巡目

- **GPT-6 Astra が high をもう 1 件**（merge-review: `reject` / 有効票 2 / 実効 high 1）。
  2 巡目の `writeAttempts` は `setItem` が成功した回に退避先を更新せず `return` していたため、
  **2 回保存できた後にストレージが落ちる**と保存値も退避先も 0 になり 3 回目の `login()` が通る。
  退避先を `WeakMap<AttemptStorage, number>`（＋ `storage === null` 用の変数 1 本）にし、
  `setItem` の成否に関わらず必ず更新・減らさない（`Math.max`）形にした。→ C-013-18
- 置き場をキーにしたのは、本番の置き場が `globalThis.sessionStorage` ＝ ページごとに 1 つの
  固定オブジェクトだからである。**モジュール変数 1 本にすると別の置き場を使う呼び出しにまで
  数が漏れる**（テストどうしの独立性も壊れる）。
- gemini の medium（`readBoundedBody` の `body === null` の枝がまだ `text()` を呼ぶ）は、
  実 `Request` では起きない（実測済み）が枝ごと消した。→ C-013-17 の追補
- **verify_commands 6 本すべて exit 0**（`typecheck` / `lint` / `test:unit` 37 ファイル 971/971 /
  `build` / `build:web-only` / `gate:constraints`）。上の「未解決」に書いた `test:unit` の赤は
  この周の最後の再実行で解消している（並行タスクの未コミットファイルが落ち着いたため）。
- **教訓（ストレージの故障モードは 4 つ）**: 「置き場が無い」「読めない」「書けない」
  「古い値が読める」に加えて **「途中で使えなくなる」**。3 巡とも同じ関数の別の穴だった。

### 4 巡目 — **この周は BLOCKED で閉じる**

- gemini は **PASS（finding 0 件）**、GPT-6 Astra が **high をさらに 1 件**
  （merge-review: `reject` / 有効票 2 / 実効 high 1）。3 巡目の `WeakMap<AttemptStorage, number>`
  は退避先を**置き場オブジェクトごと**に持つため、`defaultStorage()` が
  `sessionStorage` への参照失敗で `null` に転じると、参照できていた間の数（2）と
  `null` 側の数（0）が別勘定になり 3 回目の `login()` が通る。→ C-013-19
- 退避先のキーを**スコープ**に変えた。`deps.storage` 未指定の経路（本番）は
  `defaultStorage()` の戻り値が何であれ常に同じ `DEFAULT_STORAGE_SCOPE` で数える。
  **カウンタが属する単位は置き場オブジェクトではなくページである。**
  注入された置き場だけ従来どおり置き場ごとに分ける（本番経路には影響しない）。
- **この 4 巡目の修正は敵対レビューに掛けていない。** reject 後の再実行が指示された
  上限（2 回）に達したためである。`docs/review-log/task_013.json` の最後の記録は
  1 つ前のコミット `2d3db98` に対する `reject`（実効 high 1）なので、
  §15-3 step 5「3 周後も high が残れば BLOCKED」に該当する。
  **次の周の最初の仕事は、C-013-19 の修正をレビューに掛け直すこと。**
- **ストレージの故障モードは 5 つある**（4 巡かけて 1 つずつ出てきた）:
  ①置き場が無い ②読み書きが例外 ③読めるが書けない（古い値が読める）
  ④書けていたのに途中で落ちる ⑤**既定の置き場の取得自体が途中で落ちる**。
  この種の「退避先」を書くときは最初から 5 つ全部をテストに並べること。

### 5 巡目（メインセッションが回した最終レビューを受けて）

- 4 巡目修正（`2b44ea3`）へのレビューは gemini **PASS（finding 0）**、
  GPT-6 Astra が high 1 / medium 2 で reject。**4 巡目の懸案（C-013-19）は再提起されず**、
  代わりに 3 件の別経路が出た。3 件とも再現 → 修正 → 実測まで済ませた。
- **[high] 保存値を読んだだけの回が退避先に残らない**。`readAttempts` が読んだ値を書き戻して
  いなかったため、新しいページで保存値 `2` を読んで打ち切る回（`writeAttempts` を通らない回）の
  あとに `sessionStorage` の取得が落ちると 0 に戻る。読み取り時も
  `writeMemoryAttempts`（`Math.max`）で同期するようにした。→ C-013-20
  **故障モードは 6 つ目がある**: ⑥保存値を読んだだけで書き込みが起きない回。
- **[medium] `liff.login()` の例外**が `bootLiff` を reject させ、「例外を投げない」契約を破っていた。
  `try` で包み `auth_unavailable` ＋ 新コード `login_call_failed` を返す。
  打ち切り（`login_loop_aborted`）とコードを分けたのは監視で数える単位が違うため。→ C-013-21
- **[medium] `build:web-only` の env 検査が本文 grep だった**。シェルの `VAR=値 コマンド` は
  そのコマンド 1 つにしか効かないので、`NEXT_PUBLIC_LIFF_MOCK=0 echo prepare && next build` が
  合格していた（実測 exit 0）。`&&` / `||` / `;` で区切って実ビルドコマンドを探し、
  その直前の代入か先行する `export` に `=0` があることを要求する形にした。→ C-013-22
- **`docs/PROGRESS.md` の先頭宣言行を BLOCKED に更新した**。`gate:check` の G4 は
  task ごとに**最初の**宣言行だけを台帳と突き合わせる（`progressDeclarations` が
  `if (!out.has(...))` で最初を採る）ため、周回の途中で状態が変わったら
  **最初の行のトークンを直す**必要がある。本文は初回のまま残し、更新した旨を行内に明記した。
  `npm run gate:acceptance` は違反 0 件（warn 2 件は task_002 / task_036 のもの）。

## task_012（レビュー修正・2 周目）

GPT-6 Astra の敵対レビュー（high 1 / medium 3）。**4 件すべて HEAD で再現してから塞いだ**（非再現 0 件）。

### 決まったこと

- **[high F-1] `POST /api/auth/line` はクロスサイトからの送信を 403 で落とす**。`Origin` も
  `Content-Type` も見ていなかったため、`enctype="text/plain"` のフォーム（本文が有効な JSON に
  なる）で攻撃者の未使用 ID トークンを被害者のブラウザから送らせると、被害者に**攻撃者の**
  セッションが発行された（ログイン CSRF / セッション固定。HEAD で再現: 403 を期待したところ
  200 ＋ Cookie 発行、新規テスト 14 件中 10 件が赤）。`src/lib/auth/request-guard.ts` を新設し、
  ルート先頭で ①`Origin` が自サイトと完全一致（無ければ `Sec-Fetch-Site: same-origin`、
  どちらも無ければ **fail-closed で 403**）②`application/json` 以外は 415 ③本文の未知フィールドは
  400、の 3 枚重ねにした。自サイトは `Host` と `request.url` から導き、**環境変数を増やしていない**。
  **`https://liff.line.me` は許可しない**（全 LIFF アプリの共有オリジンで、誰でも自分の LIFF を
  置けるため、許可すると別の LIFF 開発者から同じ攻撃が成立する）。→ C-012-17
- **[medium F-2] レート制限は DB へ接続する前に判定する**。HEAD ではルート経路に判定自体が無く、
  `{success:false}` でも 200 を返して `createVerifiedDbClient()`（接続＋`SELECT session_user`）に
  到達していた。`enforceAuthRateLimit()` / `singleFlightRateLimiter()` を `line-verify.ts` に切り出し、
  ルートは DB 接続前に判定する。`authenticateWithLineIdToken()` 側の判定は**残した**（統合テストが
  この関数を唯一の入口として使うため）ので、同じキーの 2 回目がバックエンドのカウンタを二重に
  消費しないようラップして渡す。429 / 503 で `createVerifiedDbClient()` に到達しないこと、正常時に
  `limit()` がちょうど 1 回であることをルートハンドラ経由で実測。→ C-012-18
- **[medium F-3] `gate:env` は引用符付き TOML キーも拾う**。`"SUPABASE_SERVICE_ROLE_KEY" = "…"` と
  囲むだけで検査 (1) を回避できた（フィクスチャで exit 0 を再現）。代入行の正規表現を
  素 / `"…"` / `'…'` の 3 形に対応させ、`unquote()` と `stripTomlComment()` もリテラル文字列
  （単一引用符）に対応させた。→ C-012-19
- **[medium F-4] 旧 PEPPER 単独の処理系は新規作成に進めない（fail-closed）**。移行は旧参照値を
  上書きするため、移行後に旧 PEPPER だけを持つ処理系へログインが届くと既存ユーザーを見つけられず
  別の `app_user` を作っていた（HEAD で再現: 例外を投げずに `INSERT INTO app_user` が出る）。
  旧参照値を残す案はスキーマ変更（`supabase/migrations/**` = task_011 の所有）を要し、かつ
  「旧 PEPPER で引ける期間」を延ばすので採らず、`INSERT` 直前に「自分より新しい `pepper_version`
  の行」を探して 1 行でもあれば `CONFIG_INVALID` / 503 で落とす形にした。**割れたアカウントは
  事後に併合できない（旧参照値が消えている）が、503 は運用で解消できる**。→ C-012-20

### 未解決

- **[severity: medium] PEPPER 切替の窓ではログインが落ちうる**。新しい PEPPER をまだ持たない
  処理系に新規ログイン（および移行済みユーザーのログイン）が当たると 503 になる。
  「全処理系へ新旧そろえて投入 → デプロイ完了を確認 → ログインを流す」の順を守ること。
  手順書への反映は task_024（`docs/ops/key-rotation-drill.md`）。→ C-012-20
- **[severity: medium] `gate-env-scope.mjs` の TOML 読み取りは依然として最小実装**。複数行文字列・
  インラインテーブル・ドット付きの quoted key は黙って読み飛ばす。→ C-012-19
- **[severity: medium] `npm run test:unit` は exit 1**。赤は `tests/unit/gate-constraints.test.ts` の
  `Test timed out in 5000ms` 2〜3 件だけで、既知の C-013-12 と同じ（アサーション失敗ではない）。
  同じスイートを `npx vitest run tests/unit --testTimeout=30000` で走らせると
  **37 ファイル 955/955 緑・exit 0**。task_012 所有テストの赤は 0 件。
- **[severity: medium] `npm run test:integration` も exit 1**。赤 3 件はいずれも他タスクの
  **未追跡**ファイル（`tests/integration/events.test.ts` / `tests/integration/audit-chain.test.ts`）内で、
  追跡済み 4 ファイル（`auth` / `schema` / `db-role` / `ci-workflow`）は 73/73 緑。
- **[severity: low] G13 基準値の競合**。`scripts/gate-env-scope.mjs` を変えたので基準値を再生成したが、
  同時刻に別タスク（task_008）も `.claude/workflows/*.ts` を編集中で、互いに相手の未コミット分を
  焼き込まないよう overlay を使っている。**後からコミットする側が再生成し直すこと**
  （いまの基準値は HEAD + 本コミットの `gate-env-scope.mjs` に一致する）。

## task_014（イベント・参加者 API と幹事画面）

### 決まったこと

- **作業ツリーには着手前から本タスクの成果物 24 ファイル全てが前回セッションの中断分として
  存在していた**。`docs/run-log/task_014.json` の最古の記録は `typecheck` 失敗・`test:unit`
  1 件失敗（無関係な workflow-scripts.test.ts）だけで、`test:integration` は一度も走っていなかった。
  今回それを引き継ぎ、初めて `test:integration` を最後まで通した。
- **`src/lib/idempotency.ts` の `runIdempotent` を書き換えた（P-01 是正）**。予約
  （`idempotency_key` の `in_flight`）・`handler`（業務書き込み）・`done` 更新を、呼び出し側が
  開いた**同一トランザクション**にまとめる形にした（`runIdempotent` はもう自分で `sql.begin()`
  を呼ばない。呼び出し側が `sql.begin(async (tx) => runIdempotent({ sql: tx, ... }, handler))`
  の形で `tx` を渡す）。修正前は予約と `done` 更新が別文で、`handler` 失敗時は予約だけを
  個別 DELETE していたため、業務がコミットされた後の経路で例外が起きると再送が業務処理を
  もう一度実行しうる欠陥があった。3 つの route（`POST /api/events`・`PATCH /api/events/:id`・
  `POST /api/events/:id/participants`）を書き換え済み。**この形を task_015/017 が同じ
  `runIdempotent` を使うときも踏襲すること**（`sql: dbHandle.sql` を直接渡すと型エラーになる
  よう `RunIdempotentOptions.sql` の型を `postgres.TransactionSql` にしてある）。
- **`postgres`（npm）のパラメータ型推論に、文字列を `::timestamptz` へ直接キャストすると
  ミリ秒精度へ切り詰められる罠がある**。`prepare: false` 下ではサーバーの
  `ParameterDescription` が返す推論型（`timestamptz`）ごとに組み込みシリアライザを選び直し、
  `timestamptz` は `new Date(x).toISOString()` を経由するため。`::text::timestamptz`
  （二重キャスト）で回避する。**同じ罠を今後 timestamptz カーソル/パラメータを文字列で
  扱うすべての箇所で踏む可能性がある**（`src/lib/db/repositories/participants.ts` の
  `encodeCursor` 直前の docstring に実測込みで記録した）。
- **JSONB のキー順は Postgres が正規化するため、ハッシュ計算に使う前に必ずソートする**。
  `src/lib/audit.ts` の `appendAuditLog` は `detail`（jsonb）を挿入時のキー順のまま
  ハッシュに含めていたため、読み直して再計算したハッシュが内容改変なしで不一致になっていた。
  `sortDetailKeysDeep`（`src/lib/idempotency.ts` の `sortKeysDeep` と同方針）を追加して解決。
  **jsonb 列を含む値をハッシュ化する箇所を今後追加するときは同じ対策が要る**。

### 未解決

- **[severity: medium] `event.retention_due_at` の起点（`closed_at`）を書く経路がまだ無い
  （P-03）**。`closed_at` の追加は `supabase/migrations/0001_init.sql` への変更を要し、
  task_014 の `files_to_modify` が空のため実装できない。PO が task_014 / task_020 のどちらの
  所有にするか決めるまで保留（`docs/concerns/task_014.md` の C-014-1）。
- **[severity: medium] O-2〜O-6.5 の 5 画面に e2e/a11y テストが 1 本も無い（P-11）**。
  task_022 まで機械的な WCAG 2.2 AA 確認が無い（C-014-4）。
- **[severity: low] 幹事あたりの「合計請求額」上限は意図的に未実装**。1 イベント人数・
  同時イベント数の上限は実装済み。既存コード（`events.ts`）のコメントが task_021 の
  `abuse-limits.test.ts` の所有と明記済みで、そのまま踏襲した（C-014-3）。
- **[severity: low]** 監査連鎖のグローバルブロッキングロック（P-08）は §10-1 どおりの仕様
  実装で対応不要。Hyperdrive 経由の実測（A21）は task_035 完了後に deferred（C-014-2 / C-014-5）。

## task_012（レビュー修正・3 周目）

2 周目の修正（`10b4e7f` / `12fc3b9`）に G5 を掛け直した。**Gemini 2.5 Pro は PASS（指摘 0 件）**、
**GPT-6 Astra は FAIL（high 1 / medium 1）**、merge は `reject`（実効 high 1）。2 件とも再現してから直した。

### 決まったこと

- **[high] `app_user` の作成・移行だけを助言ロックで直列化する**。2 周目に塞いだのは*逐次*の分裂
  （移行後に旧設定の処理系がログインを受ける形）だけで、**同時**の分裂が残っていた。行がまだ無い
  状態では `FOR UPDATE` は何も守らず、一意制約にも `pepper_version` が入っているため、v1 と v2 の
  処理系が同じ人の初回ログインを同時に処理すると両方が「見つからない」と判断して別々の行を作れる。
  現行版の行が見つかる**通常ログインではロックを取らない**まま、見つからなかったときだけ
  `pg_advisory_xact_lock`（固定鍵 1 本）を取り、**ロック取得後に現行版を引き直す**形にした。
  鍵を人ごとにできない理由は `line_user_ref` が PEPPER ごとに変わること（生 `sub` を鍵にするのは
  L7 違反）。Postgres 側の前提は実 DB に `app_rw` で 2 セッション繋いで実測（保持中は `lock_timeout`
  で拒否、`COMMIT` 後は即取得）。→ C-012-21
- **[high の派生] 未知バージョンの検査を両方向へ広げた**。「自分より新しい版の行」だけを見ていた
  検査を「**自分の設定に無い版の行**」（`pepper_version <> ALL(設定の版)`）に変え、古い版を捨てた
  処理系（設定が `[2]` だけなのに DB に v1 の行がある）も新規作成に進めないようにした。→ C-012-21
- **[medium] `gate:env` は基本文字列のエスケープを復号してから突き合わせる**。TOML の `"…"` は
  `\uXXXX` / `\UXXXXXXXX` を解釈するので `"SUPABASE_SERVICE_ROLE_\U0000004BEY"` はキーとして
  `SUPABASE_SERVICE_ROLE_KEY` に等しく、復号しない実装では検査を回避できた（フィクスチャで
  exit 0 を再現）。`decodeTomlBasicString()` をキーと値の両方に掛ける。未知のエスケープ・
  範囲外のコードポイント・サロゲート値はそのまま残す。→ C-012-22

### 未解決

- **[severity: low] 助言ロックは新規作成・移行の直列点になる**。通常ログインは通らないが、招待リンク
  経由で新規ユーザーが一斉に初回ログインするとそこで待つ。同時初回ログインの規模は未実測 [不明]。
  負荷試験は task_022。→ C-012-21
- **[severity: medium] `gate-env-scope.mjs` の TOML 読み取りは依然として最小実装**（複数行文字列・
  インラインテーブル・ドット付き quoted key は未対応）。→ C-012-19 / C-012-22
- **[severity: medium] PEPPER 切替の窓ではログインが落ちうる**（fail-closed の代償）。手順書は
  task_024。→ C-012-20

## task_008（レビュー修正・8 周目）

### 決まったこと

- **「PO の明示承認がある」は、承認ファイルが実在することで判定する**。`release-audit.ts` の成立条件 3 は
  `evidence.approval_file_exists` が真のときだけ `approved_unavailable_vendors` の申告を承認として数える。
  ファイルが無いのに「承認済み」と名乗る封筒は自己矛盾なので、申告を空として扱い不達を必ず未承認へ落とす。
  7 周目の「独立性の会計を自己申告から外す」と同じ規律の拡張である（判定材料は**スクリプトの手元にある事実**だけで作る）。
- **黙って捨てない**。無視した申告は返り値の `disregarded_approved_unavailable_vendors` と条件 3 の
  detail（「承認記録が無いため無視した申告: …」）に出す。材料集めのプロンプトにも
  「記録の無い承認は存在しない（判定側でも無視する）」を明記した。
- **修正前 HEAD での再現を先に取る**という 6・7 周目の手順を継続した。`git show HEAD:<path>` で
  修正前の本体を取り出し、テストと同じ `AsyncFunction` ラップで同じ応答表を流して
  `verdict: "go"` → `"no-go"` の転換を実測してから直している。
- **G13 基準値の再生成は退避した木から**。`git ls-files` + `tar` で追跡ファイルを退避先へ複製し、
  `--root <退避先> --base <repo> --write-baseline` で書く。今周は退避時点で G13 対象領域
  （`docs/gates` / `.claude` / `.github/workflows` / `scripts/ci` / `scripts/` の各接頭辞）に
  他タスクの未コミット差分が 0 件だったことを `git status --porcelain` で確認済み。

### 未解決

- **[severity: medium] `done_definition` 第 1 項（3 本が Workflow ランタイムで起動する）は 3 周連続で deferred**。
  6・7・8 周目のいずれのセッションにも `Workflow` ツールが無い（`ToolSearch select:Workflow` が
  `No matching deferred tools found`）。**Workflow ツールを持つセッション（メイン / PO）で
  3 本を `dryRun: true` で 1 回ずつ回し、runId と journal を `scripts/record-run.sh --manual task_008` で
  記録するまで task_008 を DONE へ昇格させない。** → C-008-1 / C-008-2
- **[severity: medium] 「独立」の定義と法務クリアランスの強さは ADR 待ち**（成立条件 1 を独立 2 ベンダーで
  固定していること、`cleared=false` を無条件 no-go にしていること）。緩めるのは ADR と PO の仕事。
  → C-008-3 / C-008-10
- **[severity: low] 承認ファイルの「中身」は依然として材料集めエージェントの申告のまま**。今周固めたのは
  ファイルの有無までで、`approved_by` が誰かや承認の日付・対象バージョンの照合はしていない。
  `docs/gates/release-<version>.json` のスキーマ検査を足すなら封筒スキーマ側（task_010）で。

## task_012（レビュー修正・4 周目）

3 周目の修正（`d6f140f`）への G5。**Gemini 2.5 Pro = PASS（指摘 0）/ GPT-6 Astra = medium 2 件（high 0）**、
**merge = pass**（実効 high 0 / 有効票 2 / 欠票 0）。差し戻しではないが 2 件とも実在の穴なので同じ周で塞いだ。

### 決まったこと

- **[medium] `gate:env` は表名とキー列を正規化してから判定する**。TOML は表名も引用符を取れる
  （`[env.staging."vars"]`）しキーも点で区切れる（`vars."DATABASE_URL" = …`）ので、
  「vars 表かどうか」の判定を外して禁止名の検査を丸ごと回避できた。新フィクスチャ
  `quoted-tables` に対し **HEAD 版のスクリプトを取り出して実行し 0 violation / exit 0** を実測（再現）。
  `normalizeTomlKeyPath()` と `findTopLevelEquals()` を足し、代入行の切り出しを
  「引用符の外にある最初の `=`」に変えた。2 周目に「未対応」として残していた点区切りキーの穴も
  同時に塞がった。→ C-012-23
- **[medium] ライブ検査を「ランタイム × environment」の二重ループにした**。照会先がメインアプリ
  Worker 1 本しかなく、cron Worker のシークレットに禁止名があっても検出できない構造だった。
  cron には `--config workers/cron/wrangler.toml` を付ける（`-c, --config` の存在は
  `npx wrangler secret list --help` で実測）。→ C-012-24

### 未解決

- **[severity: medium] ライブ検査の成功経路は cron・main とも未実走**。`CLOUDFLARE_API_TOKEN` が無く
  Cloudflare アカウントも未作成のため、`secret list` の JSON から名前を拾う部分は動かせていない
  （無効トークンで 4 通りの照会が試みられることまでは実測）。実走は task_024。→ C-012-24 / C-012-12
- **[severity: medium] `npm run test:integration` は exit 1**。落ちたのは他タスク（task_014）の
  `tests/integration/events.test.ts` の表示名ソート 1 件で、task_012 側の 4 ファイル（`auth` /
  `schema` / `db-role` / `ci-workflow`）は 73/73 緑。
- **[severity: low] TOML 読み取りは依然として最小実装**（複数行文字列・インラインテーブルは未対応）。
  → C-012-23

## task_012（レビュー 5 周目 — 記録のみ。指摘は直さず残した）

4 周目の修正（`c8c799f`）への G5。**Gemini 2.5 Pro = PASS（指摘 0）/ GPT-6 Astra = medium 2 件（high 0）**、
**merge = pass**（実効 high 0 / 有効票 2 / 欠票 0）。3 周目に続き **2 周連続で pass**。

### 決まったこと

- **この 2 件は直さずに残す**。理由と恒久対処は docs/concerns/task_012.md C-012-25 / C-012-26 に書いた。
  - (a) **インラインテーブル（`vars = { … }`）の中の禁止名を `gate:env` が見ない**。
    2 周目から「未対応」と明示してきた穴（最小限の TOML 読み取り）の別の顔で、
    引用符付きキー → Unicode エスケープ → 引用符付き表名 → インラインテーブル、と塞いできたが、
    **手書きの読み取りを継ぎ足すかぎり次の形が必ず残る**。恒久対処は TOML パーサの導入で、
    依存を増やす判断は `wrangler.toml` の正本を持つ task_035 / task_024 へ送る。
    それまでの緩和は「素のキー・素の表名・1 行 1 代入で書く」運用規約
    （実リポジトリの `wrangler.toml` / `workers/cron/wrangler.toml` は現にその形）。
  - (b) **`docs/ops/env-baseline.json` の `secrets` を誰も検査していない**。baseline は task_035 の
    `files_to_create` でまだ存在せず、ライブ検査も実走できていない。いま書くと
    **入力も出力も検証できないコードをゲートに足す**ことになるので、task_035 が baseline を作るときに
    検査も同時に足し、実際の `wrangler secret list` の出力で検証する。

### 未解決

- 上の (a) (b) がそのまま未解決。**深刻度はどちらも medium で、merge は 2 周連続 pass**。
- `npm run test:integration` の赤 1 件は他タスク（task_014）の `tests/integration/events.test.ts`。

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
- 2026-09-24T08:11:42Z HEAD=3062179 決まったこと: task_012(2周目): nonce CSP をリクエストヘッダにも載せ、gate:env の片側混入を検出する / 未解決: 未コミット 6 件: docs/run-log/task_006.json docs/run-log/task_012.json docs/task-list.json scripts/gate-check.mjs scripts/gate-integrity.mjs tests/gates/probe.test.ts 
- 2026-09-24T08:15:42Z HEAD=2269c91 決まったこと: task_012(2周目): 最終 HEAD での verify_commands 再実行ログと、test:unit が赤い原因の切り分け / 未解決: 未コミット 10 件: docs/run-log/task_006.json docs/task-list.json scripts/gate-check.mjs scripts/gate-integrity.mjs tests/gates/fixtures/violations/g11-high-concerns-only-in-concerns-files/ tests/gates/fixtures/violations/g4-done-without-runlog/docs/PROGRESS.md tests/gates/fixtures/violations/g4-manual-items-uncovered/ tests/gates/fixtures/violations/g4-progress-ledger-drift/ 
- 2026-09-24T08:19:42Z HEAD=2269c91 決まったこと: task_012(2周目): 最終 HEAD での verify_commands 再実行ログと、test:unit が赤い原因の切り分け / 未解決: 未コミット 14 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_012.json docs/task-list.json scripts/gate-check.mjs scripts/gate-integrity.mjs tests/gates/fixtures/violations/README.md tests/unit/gate-check.test.ts 
- 2026-09-24T08:23:42Z HEAD=564f759 決まったこと: task_006(2周目): G4 の manual 項目照合・gate-inputs の迂回路・台帳同期・残懸念の集計元・G13 の対象漏れ・Stop の出力先を直す / 未解決: 未コミット 2 件: docs/run-log/task_012.json tests/gates/probe.test.ts 
- 2026-09-24T08:27:53Z HEAD=34ec688 決まったこと: task_006(2周目): 最終 HEAD 564f759 での verify_commands 6 本の再実行ログ（全 exit 0） / 未解決: 未コミット 3 件: docs/run-log/task_006.json docs/run-log/task_012.json tests/gates/probe.test.ts 
- 2026-09-24T08:31:44Z HEAD=34ec688 決まったこと: task_006(2周目): 最終 HEAD 564f759 での verify_commands 6 本の再実行ログ（全 exit 0） / 未解決: 未コミット 4 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_012.json tests/gates/probe.test.ts 
- 2026-09-24T08:35:43Z HEAD=34ec688 決まったこと: task_006(2周目): 最終 HEAD 564f759 での verify_commands 6 本の再実行ログ（全 exit 0） / 未解決: 未コミット 5 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_012.json docs/vendor-docs/line/liff-sdk.md tests/gates/probe.test.ts 
- 2026-09-24T09:00:06Z HEAD=1f4acfd 決まったこと: task_007: エージェント定義 7 本とレビュー封筒経路（Gemini 実走 / GPT 欠票） / 未解決: 未コミット 19 件: docs/HANDOFF.md docs/PROGRESS.md docs/run-log/task_006.json docs/run-log/task_012.json docs/task-list.json .github/CODEOWNERS .github/PULL_REQUEST_TEMPLATE.md .github/workflows/e2e.yml 
- 2026-09-24T09:00:11Z HEAD=1f4acfd 決まったこと: task_007: エージェント定義 7 本とレビュー封筒経路（Gemini 実走 / GPT 欠票） / 未解決: 未コミット 19 件: docs/HANDOFF.md docs/PROGRESS.md docs/run-log/task_006.json docs/run-log/task_012.json docs/task-list.json .github/CODEOWNERS .github/PULL_REQUEST_TEMPLATE.md .github/workflows/e2e.yml 
- 2026-09-24T09:08:06Z HEAD=b2addd3 決まったこと: task_009: 最終 HEAD a261bd9 での verify_commands 3 本の再実行ログ（全 exit 0） / 未解決: 未コミット 9 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_012.json docs/task-list.json scripts/merge-review.sh docs/concerns/task_007.md docs/vendor-docs/line/liff-sdk.md 
- 2026-09-24T09:12:04Z HEAD=b2addd3 決まったこと: task_009: 最終 HEAD a261bd9 での verify_commands 3 本の再実行ログ（全 exit 0） / 未解決: 未コミット 13 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json docs/task-list.json scripts/merge-review.sh docs/concerns/task_007.md 
- 2026-09-24T09:19:38Z HEAD=b2addd3 決まったこと: task_009: 最終 HEAD a261bd9 での verify_commands 3 本の再実行ログ（全 exit 0） / 未解決: 未コミット 22 件: docs/HANDOFF.md docs/PROGRESS.md docs/review-log/README.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json docs/task-list.json 
- 2026-09-24T09:20:05Z HEAD=b2addd3 決まったこと: task_009: 最終 HEAD a261bd9 での verify_commands 3 本の再実行ログ（全 exit 0） / 未解決: 未コミット 23 件: docs/HANDOFF.md docs/PROGRESS.md docs/review-log/README.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json docs/task-list.json 
- 2026-09-24T09:24:06Z HEAD=061bf8e 決まったこと: task_007: 最終確認時の gate:check 2 ゲート不合格の出どころを記録（G5 は意図した強制力 / G13 は task_009 の未コミット差分） / 未解決: 未コミット 19 件: docs/run-log/task_006.json docs/run-log/task_009.json docs/run-log/task_012.json package.json scripts/ci/secrets-grep.sh src/app/layout.tsx docs/vendor-docs/line/liff-sdk.md scripts/build-web-only.mjs 
- 2026-09-24T09:28:04Z HEAD=061bf8e 決まったこと: task_007: 最終確認時の gate:check 2 ゲート不合格の出どころを記録（G5 は意図した強制力 / G13 は task_009 の未コミット差分） / 未解決: 未コミット 30 件: .env.example .github/workflows/gate.yml docs/HANDOFF.md docs/concerns/task_009.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json 
- 2026-09-24T09:32:06Z HEAD=061bf8e 決まったこと: task_007: 最終確認時の gate:check 2 ゲート不合格の出どころを記録（G5 は意図した強制力 / G13 は task_009 の未コミット差分） / 未解決: 未コミット 33 件: .env.example .github/workflows/gate.yml docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_009.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json 
- 2026-09-24T09:36:07Z HEAD=3fec1c5 決まったこと: task_009(2周目): secrets ジョブの偽陽性を直し、test-tamper-guard を本文編集でも再実行する / 未解決: 未コミット 7 件: docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json docs/review-log/task_009.json docs/run-log/task_013.json tests/gates/probe.test.ts 
- 2026-09-24T09:40:05Z HEAD=1da804b 決まったこと: task_013: 最終 HEAD aa7a8dc での verify_commands 6 本の実行ログ（全 exit 0）と未検証項目の手動記録 / 未解決: 未コミット 9 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json scripts/build-review-packet.sh docs/review-log/task_009.json tests/gates/probe.test.ts 
- 2026-09-24T09:44:05Z HEAD=f004da2 決まったこと: task_013: 並行実行下で他タスクのテストが不安定に落ちる観測を run-log に記録 / 未解決: 未コミット 15 件: docs/HANDOFF.md docs/concerns/task_007.md docs/concerns/task_009.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json docs/run-log/task_013.json 
- 2026-09-24T09:48:06Z HEAD=62e31be 決まったこと: task_007(2周目): 封筒の制約絞り込みを完全一致にし、レビュー封筒テストをリポジトリ状態から切り離す / 未解決: 未コミット 7 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json docs/run-log/task_013.json tests/gates/probe.test.ts 
- 2026-09-24T09:56:06Z HEAD=62e31be 決まったこと: task_007(2周目): 封筒の制約絞り込みを完全一致にし、レビュー封筒テストをリポジトリ状態から切り離す / 未解決: 未コミット 7 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json docs/run-log/task_013.json tests/gates/probe.test.ts 
- 2026-09-24T09:58:33Z HEAD=62e31be 決まったこと: task_007(2周目): 封筒の制約絞り込みを完全一致にし、レビュー封筒テストをリポジトリ状態から切り離す / 未解決: 未コミット 7 件: docs/HANDOFF.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json docs/run-log/task_013.json tests/gates/probe.test.ts 
- 2026-09-24T10:01:19Z HEAD=62e31be 決まったこと: task_007(2周目): 封筒の制約絞り込みを完全一致にし、レビュー封筒テストをリポジトリ状態から切り離す / 未解決: 未コミット 13 件: docs/HANDOFF.md docs/PROGRESS.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json docs/run-log/task_013.json docs/task-list.json 
- 2026-09-24T10:24:52Z HEAD=48f3061 決まったこと: task_009(3周目): HANDOFF に 3 周目の直したこと・実測・残件を記録 / 未解決: 未コミット 25 件: .env.example .github/workflows/gate-web-only.yml docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_013.md docs/decisions/ADR-013-web-route-group.md docs/run-log/task_006.json docs/run-log/task_007.json 
- 2026-09-24T10:25:24Z HEAD=48f3061 決まったこと: task_009(3周目): HANDOFF に 3 周目の直したこと・実測・残件を記録 / 未解決: 未コミット 25 件: .env.example .github/workflows/gate-web-only.yml docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_013.md docs/decisions/ADR-013-web-route-group.md docs/run-log/task_006.json docs/run-log/task_007.json 
- 2026-09-24T10:32:05Z HEAD=c1cd588 決まったこと: task_013(2周目): 最終 HEAD f77ac63 での build:web-only / typecheck / gate:constraints の再実行ログ（全 exit 0） / 未解決: 未コミット 13 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_007.md docs/review-log/README.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_012.json docs/task-list.json 
- 2026-09-24T10:35:25Z HEAD=e03a539 決まったこと: G5: task_004 / task_013 の敵対レビュー記録を実経路で作成 / 未解決: 未コミット 13 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_007.md docs/concerns/task_009.md docs/review-log/README.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_012.json 
- 2026-09-24T10:37:41Z HEAD=077a74c 決まったこと: task_009(3周目): 最終 HEAD f3a378c での verify_commands 3 本の再実行ログ（全 exit 0） / 未解決: 未コミット 11 件: docs/PROGRESS.md docs/concerns/task_007.md docs/review-log/README.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_012.json docs/run-log/task_013.json docs/task-list.json 
- 2026-09-24T10:44:32Z HEAD=8066980 決まったこと: task_007(3周目): 完了ステータスを BLOCKED へ訂正し、封筒のベンダー独立性を実装する / 未解決: 未コミット 8 件: docs/HANDOFF.md docs/PROGRESS.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json docs/run-log/task_013.json tests/gates/probe.test.ts 
- 2026-09-24T10:46:57Z HEAD=d722cc4 決まったこと: task_007(3周目): 最終 HEAD 8066980 での verify_commands 再実行ログ / 未解決: 未コミット 10 件: docs/HANDOFF.md docs/PROGRESS.md docs/run-log/task_006.json docs/run-log/task_009.json docs/run-log/task_012.json docs/run-log/task_013.json scripts/build-web-only.mjs src/lib/liff/client.ts 
- 2026-09-24T10:49:31Z HEAD=d722cc4 決まったこと: task_007(3周目): 最終 HEAD 8066980 での verify_commands 再実行ログ / 未解決: 未コミット 14 件: docs/HANDOFF.md docs/PROGRESS.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json docs/run-log/task_012.json docs/run-log/task_013.json package.json 
- 2026-09-24T10:57:22Z HEAD=d722cc4 決まったこと: task_007(3周目): 最終 HEAD 8066980 での verify_commands 再実行ログ / 未解決: 未コミット 19 件: .github/workflows/gate.yml .github/workflows/release.yml docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_013.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_009.json 
- 2026-09-24T11:13:55Z HEAD=8abccdd 決まったこと: task_013(3周目): 最終 HEAD 455e594 での verify_commands 再実行ログと実測 2 件の記録 / 未解決: 未コミット 24 件: .github/workflows/gate.yml .github/workflows/release.yml docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_007.md docs/concerns/task_009.md docs/review-log/README.md docs/run-log/task_006.json 
- 2026-09-24T11:14:46Z HEAD=8abccdd 決まったこと: task_013(3周目): 最終 HEAD 455e594 での verify_commands 再実行ログと実測 2 件の記録 / 未解決: 未コミット 24 件: .github/workflows/gate.yml .github/workflows/release.yml docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_007.md docs/concerns/task_009.md docs/review-log/README.md docs/run-log/task_006.json 
- 2026-09-24T11:16:33Z HEAD=a52ff2b 決まったこと: task_009(4周目): G13 基準値の再生成（gate.yml / release.yml / gate-web-only.yml） / 未解決: 未コミット 15 件: docs/concerns/task_007.md docs/review-log/README.md docs/run-log/task_006.json docs/run-log/task_007.json docs/run-log/task_012.json docs/run-log/task_013.json scripts/build-review-packet.sh scripts/merge-review.sh 
- 2026-09-24T12:06:41Z HEAD=8ecf3be 決まったこと: task_005: 残穴 §2（敵対レビュー F-BASH-01 high）の 5 周目修正案を docs/proposals に起票 / 未解決: 未コミット 1 件: tests/gates/probe.test.ts 
- 2026-09-24T12:19:23Z HEAD=dfc6f72 決まったこと: concerns: 陳腐化した high 2 件を実測つきで解消（task_011 の CI 実走・task_007 の G5 記録欠落） / 未解決: 未コミット 11 件: docs/HANDOFF.md .claude/workflows/ docs/premortem/ docs/run-log/task_008.json src/app/api/events/ src/lib/audit.ts src/lib/db/repositories/ src/lib/idempotency.ts 
- 2026-09-24T12:20:08Z HEAD=dfc6f72 決まったこと: concerns: 陳腐化した high 2 件を実測つきで解消（task_011 の CI 実走・task_007 の G5 記録欠落） / 未解決: 未コミット 12 件: docs/HANDOFF.md .claude/workflows/ docs/concerns/task_008.md docs/premortem/ docs/run-log/task_008.json src/app/api/events/ src/lib/audit.ts src/lib/db/repositories/ 
- 2026-09-24T12:21:08Z HEAD=dfc6f72 決まったこと: concerns: 陳腐化した high 2 件を実測つきで解消（task_011 の CI 実走・task_007 の G5 記録欠落） / 未解決: 未コミット 15 件: docs/HANDOFF.md docs/PROGRESS.md docs/task-list.json .claude/workflows/ docs/concerns/task_008.md docs/premortem/ docs/run-log/task_008.json src/app/api/events/ 
- 2026-09-24T12:23:08Z HEAD=b2538ff 決まったこと: task_008: Workflow スクリプト 3 本（task-loop / premortem / release-audit）を追加し、制御フローをランタイム同形のテストで実測する / 未解決: 未コミット 10 件: docs/run-log/task_008.json src/app/api/events/ src/components/FeeEstimate.tsx src/components/InvoiceRow.tsx src/components/SummaryBar.tsx src/lib/audit.ts src/lib/db/repositories/ src/lib/idempotency.ts 
- 2026-09-24T12:26:08Z HEAD=0b5fda5 決まったこと: task_008: 最終 HEAD b2538ff での verify_commands 再実行ログと、作業ツリーの赤 2 件の出どころの記録 / 未解決: 未コミット 11 件: docs/HANDOFF.md src/app/(liff)/events/ src/app/api/events/ src/components/FeeEstimate.tsx src/components/InvoiceRow.tsx src/components/SummaryBar.tsx src/lib/audit.ts src/lib/db/repositories/ 
- 2026-09-24T12:27:09Z HEAD=0b5fda5 決まったこと: task_008: 最終 HEAD b2538ff での verify_commands 再実行ログと、作業ツリーの赤 2 件の出どころの記録 / 未解決: 未コミット 11 件: docs/HANDOFF.md src/app/(liff)/events/ src/app/api/events/ src/components/FeeEstimate.tsx src/components/InvoiceRow.tsx src/components/SummaryBar.tsx src/lib/audit.ts src/lib/db/repositories/ 
- 2026-09-24T12:28:08Z HEAD=0b5fda5 決まったこと: task_008: 最終 HEAD b2538ff での verify_commands 再実行ログと、作業ツリーの赤 2 件の出どころの記録 / 未解決: 未コミット 12 件: docs/HANDOFF.md docs/run-log/task_008.json src/app/(liff)/events/ src/app/api/events/ src/components/FeeEstimate.tsx src/components/InvoiceRow.tsx src/components/SummaryBar.tsx src/lib/audit.ts 
- 2026-09-24T12:40:20Z HEAD=173ff40 決まったこと: premortem: Phase 1 後半の再実行（新規 12 件）を記録し、task_014〜023 の files_to_read に配線 / 未解決: 未コミット 18 件: docs/HANDOFF.md docs/run-log/task_008.json src/app/(liff)/events/ src/app/api/events/ src/components/FeeEstimate.tsx src/components/InvoiceRow.tsx src/components/SummaryBar.tsx src/lib/audit.ts 
- 2026-09-24T12:45:01Z HEAD=522d543 決まったこと: evidence: acceptance-checks.json の evidence を検証コマンドの実行結果から書く唯一の経路 scripts/record-evidence.mjs / 未解決: 未コミット 22 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/run-log/task_008.json tests/unit/workflows/workflow-scripts.test.ts docs/run-log/task_014.json src/app/(liff)/events/ src/app/api/events/ 
- 2026-09-24T12:45:14Z HEAD=522d543 決まったこと: evidence: acceptance-checks.json の evidence を検証コマンドの実行結果から書く唯一の経路 scripts/record-evidence.mjs / 未解決: 未コミット 22 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/run-log/task_008.json tests/unit/workflows/workflow-scripts.test.ts docs/run-log/task_014.json src/app/(liff)/events/ src/app/api/events/ 
- 2026-09-24T12:48:59Z HEAD=d69c84d 決まったこと: review 経路: GPT-6 Astra が通るようになった実測を反映（task_004 に GPT の票を追記・ドライバの GPT タイムアウト延長） / 未解決: 未コミット 26 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_008.md docs/gates/integrity-baseline.json docs/run-log/task_008.json docs/task-list.json 
- 2026-09-24T12:49:12Z HEAD=d69c84d 決まったこと: review 経路: GPT-6 Astra が通るようになった実測を反映（task_004 に GPT の票を追記・ドライバの GPT タイムアウト延長） / 未解決: 未コミット 26 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_008.md docs/gates/integrity-baseline.json docs/run-log/task_008.json docs/task-list.json 
- 2026-09-24T12:51:11Z HEAD=f8f0c8c 決まったこと: task_008(6周目): 最終 HEAD d9fb432 での verify_commands 再実行ログ / 未解決: 未コミット 17 件: docs/run-log/task_014.json src/app/(liff)/events/ src/app/api/events/ src/components/FeeEstimate.tsx src/components/InvoiceRow.tsx src/components/SummaryBar.tsx src/lib/audit.ts src/lib/db/repositories/ 
- 2026-09-24T12:54:00Z HEAD=6533340 決まったこと: G5: task_011 / 012 / 013 に GPT-6 Astra の票を追記（codex 経路開通後の実レビュー） / 未解決: 未コミット 20 件: docs/HANDOFF.md docs/run-log/task_008.json docs/run-log/task_014.json src/app/(liff)/events/ src/app/api/events/ src/components/FeeEstimate.tsx src/components/InvoiceRow.tsx src/components/SummaryBar.tsx 
- 2026-09-24T12:54:10Z HEAD=6533340 決まったこと: G5: task_011 / 012 / 013 に GPT-6 Astra の票を追記（codex 経路開通後の実レビュー） / 未解決: 未コミット 20 件: docs/HANDOFF.md docs/run-log/task_008.json docs/run-log/task_014.json src/app/(liff)/events/ src/app/api/events/ src/components/FeeEstimate.tsx src/components/InvoiceRow.tsx src/components/SummaryBar.tsx 
- 2026-09-24T13:00:57Z HEAD=3bdf5d4 決まったこと: harness-round2: H2-13（review-log 追記前の秘密値マスク。push protection で拒否された実測） / 未解決: 未コミット 28 件: docs/HANDOFF.md docs/constraints.json docs/run-log/task_004.json docs/run-log/task_008.json scripts/gate-constraints.sh scripts/wording-lint.mjs src/lib/liff/client.ts tests/unit/liff/client.test.ts 
- 2026-09-24T13:02:32Z HEAD=3bdf5d4 決まったこと: harness-round2: H2-13（review-log 追記前の秘密値マスク。push protection で拒否された実測） / 未解決: 未コミット 30 件: docs/HANDOFF.md docs/constraints.json docs/run-log/task_004.json docs/run-log/task_008.json scripts/gate-constraints.sh scripts/wording-lint.mjs src/lib/liff/client.ts tests/unit/config/env.test.ts 
- 2026-09-24T13:02:38Z HEAD=3bdf5d4 決まったこと: harness-round2: H2-13（review-log 追記前の秘密値マスク。push protection で拒否された実測） / 未解決: 未コミット 30 件: docs/HANDOFF.md docs/constraints.json docs/run-log/task_004.json docs/run-log/task_008.json scripts/gate-constraints.sh scripts/wording-lint.mjs src/lib/liff/client.ts tests/unit/config/env.test.ts 
- 2026-09-24T13:03:26Z HEAD=3bdf5d4 決まったこと: harness-round2: H2-13（review-log 追記前の秘密値マスク。push protection で拒否された実測） / 未解決: 未コミット 31 件: docs/HANDOFF.md docs/constraints.json docs/run-log/task_004.json docs/run-log/task_008.json scripts/gate-constraints.sh scripts/wording-lint.mjs src/lib/liff/client.ts tests/unit/config/env.test.ts 
- 2026-09-24T13:05:48Z HEAD=3bdf5d4 決まったこと: harness-round2: H2-13（review-log 追記前の秘密値マスク。push protection で拒否された実測） / 未解決: 未コミット 38 件: docs/HANDOFF.md docs/constraints.json docs/run-log/task_004.json docs/run-log/task_008.json scripts/gate-constraints.sh scripts/wording-lint.mjs src/app/api/auth/line/route.ts src/app/api/telemetry/client-error/route.ts 
- 2026-09-24T13:12:20Z HEAD=3bdf5d4 決まったこと: harness-round2: H2-13（review-log 追記前の秘密値マスク。push protection で拒否された実測） / 未解決: 未コミット 49 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_013.md docs/constraints.json docs/run-log/task_004.json docs/run-log/task_008.json 
- 2026-09-24T13:14:20Z HEAD=3bdf5d4 決まったこと: harness-round2: H2-13（review-log 追記前の秘密値マスク。push protection で拒否された実測） / 未解決: 未コミット 50 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_004.md docs/concerns/task_013.md docs/constraints.json docs/gates/integrity-baseline.json 
- 2026-09-24T13:14:56Z HEAD=26eb304 決まったこと: task_004(2周目): 敵対レビュー high 2 / medium 5 を再現してから塞ぐ（quotePath・読めた0件・パターン5件） / 未解決: 未コミット 41 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/concerns/task_013.md docs/run-log/task_008.json docs/run-log/task_012.json docs/run-log/task_013.json docs/task-list.json 
- 2026-09-24T13:15:20Z HEAD=26eb304 決まったこと: task_004(2周目): 敵対レビュー high 2 / medium 5 を再現してから塞ぐ（quotePath・読めた0件・パターン5件） / 未解決: 未コミット 42 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/concerns/task_012.md docs/concerns/task_013.md docs/run-log/task_008.json docs/run-log/task_012.json docs/run-log/task_013.json 
- 2026-09-24T13:16:21Z HEAD=26eb304 決まったこと: task_004(2周目): 敵対レビュー high 2 / medium 5 を再現してから塞ぐ（quotePath・読めた0件・パターン5件） / 未解決: 未コミット 43 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_012.md docs/concerns/task_013.md docs/run-log/task_008.json docs/run-log/task_012.json 
- 2026-09-24T13:16:37Z HEAD=26eb304 決まったこと: task_004(2周目): 敵対レビュー high 2 / medium 5 を再現してから塞ぐ（quotePath・読めた0件・パターン5件） / 未解決: 未コミット 43 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_012.md docs/concerns/task_013.md docs/run-log/task_008.json docs/run-log/task_012.json 
- 2026-09-24T13:19:21Z HEAD=ffe9f01 決まったこと: task_013(4周目): ストレージ不能時の login 打ち切りとテレメトリ本文の上限を実測つきで塞ぐ / 未解決: 未コミット 38 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/concerns/task_012.md docs/run-log/task_008.json docs/run-log/task_012.json docs/task-list.json scripts/gate-env-scope.mjs src/app/api/auth/line/route.ts 
- 2026-09-24T13:25:23Z HEAD=ffe9f01 決まったこと: task_013(4周目): ストレージ不能時の login 打ち切りとテレメトリ本文の上限を実測つきで塞ぐ / 未解決: 未コミット 48 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_008.md docs/concerns/task_012.md docs/gates/integrity-baseline.json docs/review-log/task_004.json 
- 2026-09-24T13:26:21Z HEAD=ffe9f01 決まったこと: task_013(4周目): ストレージ不能時の login 打ち切りとテレメトリ本文の上限を実測つきで塞ぐ / 未解決: 未コミット 50 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_008.md docs/concerns/task_012.md docs/concerns/task_013.md docs/constraints.json 
- 2026-09-24T13:27:24Z HEAD=10b4e7f 決まったこと: task_012(2周目): 敵対レビュー high 1 / medium 3 を再現してから塞ぐ（ログインCSRF・DB到達順・引用符キー・PEPPER分裂） / 未解決: 未コミット 37 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/concerns/task_008.md docs/concerns/task_013.md docs/constraints.json docs/review-log/task_004.json docs/review-log/task_013.json 
- 2026-09-24T13:28:21Z HEAD=10b4e7f 決まったこと: task_012(2周目): 敵対レビュー high 1 / medium 3 を再現してから塞ぐ（ログインCSRF・DB到達順・引用符キー・PEPPER分裂） / 未解決: 未コミット 38 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/concerns/task_008.md docs/concerns/task_013.md docs/constraints.json docs/review-log/task_004.json docs/review-log/task_013.json 
- 2026-09-24T13:29:22Z HEAD=12fc3b9 決まったこと: task_012(2周目): HANDOFF に決まったこと / 未解決を追記（並行タスクのターンログ行を同梱） / 未解決: 未コミット 40 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_008.md docs/concerns/task_013.md docs/constraints.json docs/review-log/task_004.json 
- 2026-09-24T13:29:59Z HEAD=12fc3b9 決まったこと: task_012(2周目): HANDOFF に決まったこと / 未解決を追記（並行タスクのターンログ行を同梱） / 未解決: 未コミット 42 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_008.md docs/concerns/task_013.md docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md 
- 2026-09-24T13:31:25Z HEAD=42e6378 決まったこと: task_013(4周目・2巡目): 保存値を優先したための打ち切り漏れと、上限を迂回する本文読みを塞ぐ / 未解決: 未コミット 35 件: .claude/workflows/release-audit.ts .claude/workflows/task-loop.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_008.md docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md docs/gates/integrity-baseline.json 
- 2026-09-24T13:33:23Z HEAD=4f6c0e9 決まったこと: task_008(7周目): 独立性の会計を封筒の自己申告から外し、形の壊れた封筒を有効票にしない / 未解決: 未コミット 28 件: docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md docs/review-log/task_004.json docs/run-log/task_008.json docs/run-log/task_012.json scripts/gate-constraints.sh scripts/wording-lint.mjs tests/unit/gate-constraints.test.ts 
- 2026-09-24T13:35:22Z HEAD=96aca7d 決まったこと: task_008(7周目): 最終 HEAD 4f6c0e9 での verify_commands 再実行ログと、赤 2 件の出どころの記録 / 未解決: 未コミット 33 件: docs/HANDOFF.md docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md docs/review-log/task_004.json docs/review-log/task_012.json docs/review-log/task_013.json docs/run-log/task_012.json scripts/gate-constraints.sh 
- 2026-09-24T13:36:24Z HEAD=96aca7d 決まったこと: task_008(7周目): 最終 HEAD 4f6c0e9 での verify_commands 再実行ログと、赤 2 件の出どころの記録 / 未解決: 未コミット 35 件: docs/HANDOFF.md docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md docs/review-log/task_004.json docs/review-log/task_012.json docs/review-log/task_013.json docs/run-log/task_012.json scripts/gate-constraints.sh 
- 2026-09-24T13:37:23Z HEAD=96aca7d 決まったこと: task_008(7周目): 最終 HEAD 4f6c0e9 での verify_commands 再実行ログと、赤 2 件の出どころの記録 / 未解決: 未コミット 41 件: docs/HANDOFF.md docs/concerns/task_004.md docs/concerns/task_013.md docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md docs/review-log/task_004.json docs/review-log/task_012.json docs/review-log/task_013.json 
- 2026-09-24T13:38:33Z HEAD=96aca7d 決まったこと: task_008(7周目): 最終 HEAD 4f6c0e9 での verify_commands 再実行ログと、赤 2 件の出どころの記録 / 未解決: 未コミット 43 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_004.md docs/concerns/task_013.md docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md docs/review-log/task_004.json docs/review-log/task_012.json 
- 2026-09-24T13:40:23Z HEAD=e4d1bd2 決まったこと: task_005: 6 周目の修正案（GPT-6 Astra の high 8 件）を docs/proposals に起票 / 未解決: 未コミット 42 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_004.md docs/concerns/task_013.md docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md docs/review-log/task_004.json docs/review-log/task_012.json 
- 2026-09-24T13:42:06Z HEAD=e4d1bd2 決まったこと: task_005: 6 周目の修正案（GPT-6 Astra の high 8 件）を docs/proposals に起票 / 未解決: 未コミット 44 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_004.md docs/concerns/task_013.md docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md docs/review-log/task_004.json docs/review-log/task_012.json 
- 2026-09-24T13:42:51Z HEAD=7697e0e 決まったこと: task_005: concerns に 6 周目案（round6 累積パッチ）への参照を追記 / 未解決: 未コミット 44 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_004.md docs/concerns/task_013.md docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md docs/review-log/task_004.json docs/review-log/task_012.json 
- 2026-09-24T13:43:24Z HEAD=2d3db98 決まったこと: task_013(4周目・3巡目): 保存できた回も退避先に残し、null body で text() を呼ばない / 未解決: 未コミット 39 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_004.md docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md docs/review-log/task_004.json docs/review-log/task_012.json docs/run-log/task_004.json 
- 2026-09-24T13:45:26Z HEAD=2d3db98 決まったこと: task_013(4周目・3巡目): 保存できた回も退避先に残し、null body で text() を呼ばない / 未解決: 未コミット 42 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_004.md docs/concerns/task_012.md docs/constraints.json docs/decisions/ADR-009-id-token-single-use.md docs/gates/integrity-baseline.json docs/review-log/task_004.json 
- 2026-09-24T13:47:24Z HEAD=9d393be 決まったこと: task_014: イベント・参加者 API と幹事画面（O-2〜O-6.5） / 未解決: 未コミット 11 件: docs/concerns/task_012.md docs/decisions/ADR-009-id-token-single-use.md docs/review-log/task_012.json docs/run-log/task_008.json docs/run-log/task_012.json scripts/gate-env-scope.mjs src/lib/auth/pepper.ts tests/unit/auth/pepper.test.ts 
- 2026-09-24T13:48:25Z HEAD=9d393be 決まったこと: task_014: イベント・参加者 API と幹事画面（O-2〜O-6.5） / 未解決: 未コミット 16 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_012.md docs/decisions/ADR-009-id-token-single-use.md docs/gates/integrity-baseline.json docs/review-log/task_012.json docs/review-log/task_013.json docs/run-log/task_008.json 
- 2026-09-24T13:50:24Z HEAD=d6f140f 決まったこと: task_012(3周目): 2 周目レビューの high 1 / medium 1 を再現してから塞ぐ（同時初回ログインの分裂・TOML エスケープ） / 未解決: 未コミット 6 件: .claude/workflows/release-audit.ts docs/review-log/task_013.json docs/run-log/task_008.json src/lib/liff/client.ts tests/unit/liff/client.test.ts tests/gates/probe.test.ts 
- 2026-09-24T13:52:25Z HEAD=3f2ea9b 決まったこと: task_012(3周目): G13 基準値を取り直す（並行タスクの再生成に自分のハッシュを巻き戻されていた） / 未解決: 未コミット 11 件: .claude/workflows/release-audit.ts docs/HANDOFF.md docs/concerns/task_013.md docs/review-log/task_013.json docs/run-log/task_008.json docs/run-log/task_012.json docs/run-log/task_013.json src/lib/liff/client.ts 
- 2026-09-24T13:54:30Z HEAD=3f2ea9b 決まったこと: task_012(3周目): G13 基準値を取り直す（並行タスクの再生成に自分のハッシュを巻き戻されていた） / 未解決: 未コミット 15 件: .claude/workflows/release-audit.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_008.md docs/concerns/task_013.md docs/gates/integrity-baseline.json docs/review-log/task_013.json docs/run-log/task_008.json 
- 2026-09-24T13:55:25Z HEAD=3f2ea9b 決まったこと: task_012(3周目): G13 基準値を取り直す（並行タスクの再生成に自分のハッシュを巻き戻されていた） / 未解決: 未コミット 17 件: .claude/workflows/release-audit.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_008.md docs/concerns/task_013.md docs/gates/integrity-baseline.json docs/review-log/task_013.json docs/run-log/task_008.json 
- 2026-09-24T13:56:26Z HEAD=2b44ea3 決まったこと: task_013(4周目・4巡目): 退避先のキーを置き場オブジェクトからページのスコープへ / 未解決: 未コミット 13 件: .claude/workflows/release-audit.ts docs/PROGRESS.md docs/concerns/task_008.md docs/gates/integrity-baseline.json docs/review-log/task_004.json docs/review-log/task_012.json docs/run-log/task_008.json docs/run-log/task_012.json 
- 2026-09-24T13:58:29Z HEAD=2b44ea3 決まったこと: task_013(4周目・4巡目): 退避先のキーを置き場オブジェクトからページのスコープへ / 未解決: 未コミット 18 件: .claude/workflows/release-audit.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_008.md docs/constraints.json docs/gates/integrity-baseline.json docs/review-log/task_004.json docs/review-log/task_012.json 
- 2026-09-24T13:58:59Z HEAD=2b44ea3 決まったこと: task_013(4周目・4巡目): 退避先のキーを置き場オブジェクトからページのスコープへ / 未解決: 未コミット 19 件: .claude/workflows/release-audit.ts docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_008.md docs/constraints.json docs/gates/integrity-baseline.json docs/review-log/task_004.json docs/review-log/task_012.json 
- 2026-09-24T14:00:26Z HEAD=3323c11 決まったこと: task_008(8周目): 不達ベンダーの「PO 承認」を、承認ファイルの実在で判定する / 未解決: 未コミット 13 件: docs/constraints.json docs/review-log/task_004.json docs/review-log/task_012.json docs/run-log/task_008.json docs/run-log/task_012.json docs/run-log/task_014.json scripts/gate-constraints.sh scripts/gate-env-scope.mjs 
- 2026-09-24T14:01:26Z HEAD=15d9987 決まったこと: task_008(8周目): 最終 HEAD 3323c11 での verify_commands 再実行ログと、G13 不一致 2 件の出どころ / 未解決: 未コミット 15 件: docs/HANDOFF.md docs/concerns/task_012.md docs/constraints.json docs/review-log/task_004.json docs/review-log/task_012.json docs/run-log/task_012.json docs/run-log/task_014.json scripts/gate-constraints.sh 
- 2026-09-24T14:04:30Z HEAD=7932d16 決まったこと: G5: task_013 の 4 巡目修正（2b44ea3）に対する最終レビューを追記（Gemini PASS / GPT high 1 で reject） / 未解決: 未コミット 18 件: docs/HANDOFF.md docs/concerns/task_012.md docs/constraints.json docs/review-log/task_004.json docs/review-log/task_012.json docs/run-log/task_008.json docs/run-log/task_012.json docs/run-log/task_014.json 
- 2026-09-24T14:06:31Z HEAD=7932d16 決まったこと: G5: task_013 の 4 巡目修正（2b44ea3）に対する最終レビューを追記（Gemini PASS / GPT high 1 で reject） / 未解決: 未コミット 24 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_004.md docs/concerns/task_012.md docs/constraints.json docs/gates/integrity-baseline.json docs/review-log/task_004.json docs/review-log/task_012.json 
- 2026-09-24T14:09:04Z HEAD=c8c799f 決まったこと: task_012(4周目): 3 周目レビューの medium 2 件（引用符付き表名・cron のライブ検査漏れ）を塞ぐ / 未解決: 未コミット 20 件: docs/HANDOFF.md docs/concerns/task_004.md docs/constraints.json docs/review-log/task_004.json docs/run-log/task_004.json docs/run-log/task_008.json docs/run-log/task_014.json docs/task-list.json 
- 2026-09-24T14:15:53Z HEAD=c8c799f 決まったこと: task_012(4周目): 3 周目レビューの medium 2 件（引用符付き表名・cron のライブ検査漏れ）を塞ぐ / 未解決: 未コミット 26 件: docs/HANDOFF.md docs/concerns/task_004.md docs/concerns/task_012.md docs/constraints.json docs/review-log/task_004.json docs/review-log/task_012.json docs/run-log/task_004.json docs/run-log/task_008.json 
- 2026-09-24T14:16:39Z HEAD=c8c799f 決まったこと: task_012(4周目): 3 周目レビューの medium 2 件（引用符付き表名・cron のライブ検査漏れ）を塞ぐ / 未解決: 未コミット 28 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_004.md docs/concerns/task_012.md docs/constraints.json docs/review-log/task_004.json docs/review-log/task_012.json docs/run-log/task_004.json 
- 2026-09-24T14:17:10Z HEAD=ea10fe7 決まったこと: task_012(5周目): 4 周目レビューの medium 2 件を「直さず残す」判断として記録する / 未解決: 未コミット 23 件: docs/concerns/task_004.md docs/concerns/task_013.md docs/constraints.json docs/review-log/task_004.json docs/run-log/task_004.json docs/run-log/task_008.json docs/run-log/task_013.json docs/run-log/task_014.json 
- 2026-09-24T14:17:37Z HEAD=ea10fe7 決まったこと: task_012(5周目): 4 周目レビューの medium 2 件を「直さず残す」判断として記録する / 未解決: 未コミット 24 件: docs/HANDOFF.md docs/concerns/task_004.md docs/concerns/task_013.md docs/constraints.json docs/review-log/task_004.json docs/run-log/task_004.json docs/run-log/task_008.json docs/run-log/task_013.json 
- 2026-09-24T14:18:35Z HEAD=46fc8bf 決まったこと: task_012(5周目): HANDOFF のターンログ行を取り込む（scripts/append-handoff.sh 経由） / 未解決: 未コミット 24 件: docs/concerns/task_004.md docs/concerns/task_013.md docs/constraints.json docs/gates/integrity-baseline.json docs/review-log/task_004.json docs/run-log/task_004.json docs/run-log/task_008.json docs/run-log/task_013.json 
- 2026-09-24T14:19:33Z HEAD=46fc8bf 決まったこと: task_012(5周目): HANDOFF のターンログ行を取り込む（scripts/append-handoff.sh 経由） / 未解決: 未コミット 26 件: docs/HANDOFF.md docs/concerns/task_004.md docs/concerns/task_013.md docs/constraints.json docs/gates/integrity-baseline.json docs/review-log/task_004.json docs/run-log/task_004.json docs/run-log/task_008.json 
- 2026-09-24T14:20:35Z HEAD=171760b 決まったこと: task_012: 直前のコミットが巻き込んだ他タスクの古い index 内容を、作業ツリーの現在の内容に戻す / 未解決: 未コミット 21 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_013.md docs/run-log/task_008.json docs/run-log/task_012.json docs/run-log/task_013.json docs/run-log/task_014.json docs/task-list.json 
- 2026-09-24T14:21:33Z HEAD=45fc8d1 決まったこと: task_004(4周目・再適用): 2 回目の G5 の実効 high 2 / medium 3 を再現してから塞ぐ / 未解決: 未コミット 22 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_013.md docs/gates/integrity-baseline.json docs/run-log/task_008.json docs/run-log/task_012.json docs/run-log/task_013.json docs/run-log/task_014.json 
- 2026-09-24T14:22:21Z HEAD=45fc8d1 決まったこと: task_004(4周目・再適用): 2 回目の G5 の実効 high 2 / medium 3 を再現してから塞ぐ / 未解決: 未コミット 22 件: docs/HANDOFF.md docs/PROGRESS.md docs/concerns/task_013.md docs/gates/integrity-baseline.json docs/run-log/task_008.json docs/run-log/task_012.json docs/run-log/task_013.json docs/run-log/task_014.json 
