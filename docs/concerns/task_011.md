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

---

## C-011-1 — CI の実走（PR で緑・required status check 登録）

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
- **緩和**: フラグは次の 3 条件が**すべて**成立するときだけ効く。
  1. `ALLOW_PRIVILEGED_DB_ROLE` が厳密に文字列 `"1"`
  2. `APP_ENV` が厳密に `"development"`（`wrangler.toml` の staging / production の
     `[vars]` は `"staging"` / `"production"` なので届かない）
  3. 接続先ホストがループバック（`127.0.0.1` / `localhost` / `::1` / `[::1]`）
  条件を 1 つずつ欠けさせた否定ケースを `tests/unit/db-client.test.ts` に 6 件追加した。
  さらに統合テストで「`.env.example` にこの名前が無い」「`.dev.vars.example` にあり、
  かつ既定ではコメントアウトされている」「`wrangler.toml` にこの名前が無い」を機械検査する。
- **残余リスク**: `.dev.vars` は開発者の手元ファイルなので、開発者が
  `APP_ENV=development` のままリモートの DB を指した場合は……ループバック判定で止まる。
  止まらないのは「ローカルの `supabase start` に特権ロールで入る」場合だけで、これは
  ローカル DB に対する既存の権限と等価。
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
  - `supabase/migrations/0005` / `0006` — `0001` を直接書き換えると適用済みローカル DB と
    shadow DB がずれ、整合に禁止コマンド（`supabase db reset`）が要るため追加マイグレーションにした
    （0003 / 0004 と同じ判断）
- **触っていない**: `wrangler.toml`（task_003 / task_035 の所有）、
  `.github/workflows/gate.yml`（task_009 の所有）、`.claude/settings.json`、
  `docs/task-list.json`（並行タスクとの書き込み衝突回避）。
