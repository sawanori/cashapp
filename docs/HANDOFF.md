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
