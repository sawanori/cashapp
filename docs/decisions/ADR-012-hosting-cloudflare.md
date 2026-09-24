# ADR-012: ホスティングに Cloudflare Workers を採用する

- ステータス: proposed（A21 が未解決のため `accepted` にしない。G10）
- Confidence: medium（スパイク①②③は high confidence の実測。④は部分成立。A21/A24 は未実測の [不明] が残る）
- 関連: implementation-plan.md §7-2, §7-7, A20, A21, A24, A25 / task_003, task_011, task_035

## Context

`docs/research/research-tech-stack.md` の技術調査は Vercel を推奨していた。一方 PO（noritaka）は
Cloudflare Workers（Next.js を `@opennextjs/cloudflare` でデプロイ）を指示した
（implementation-plan.md §1 冒頭・§7-2）。本 ADR はこの決定の理由と、調査推奨との差分、
task_003 のスパイクで実測できた範囲・できなかった範囲を記録する。

## Decision

Cloudflare Workers（Workers Paid）を採用する。Next.js App Router を `@opennextjs/cloudflare`
でビルドし、`wrangler.toml` の named environments（`staging` / `production`）でバインディング・
シークレットを分離する（R-SEC-05）。DB は Supabase Postgres に Cloudflare Hyperdrive 経由で
接続する。cron は専用 Worker（`workers/cron/`）の Cron Triggers。

## 採用理由（PO 指示 [実測] と本タスクで確認できた根拠）

- PO の明示指示（[実測]、口頭・指示文）。
- Cron Triggers・WAF による IP 許可リスト・named environments による環境分離が Cloudflare の
  標準機能として揃っている（§7-2 の記述。ただしプラン別の WAF ルール本数・Access の無料枠は
  未検証のまま — A24、本 ADR でも未解決）。
- 本タスクのスパイクで OpenNext + Next.js 16 + Cloudflare Workers の組み合わせが実際に
  動くことを実測できた（下記スパイク結果）。

## 調査推奨（Vercel）との差分

| 観点 | Vercel（調査推奨） | Cloudflare Workers（本決定） |
|---|---|---|
| デプロイ方式 | Next.js ネイティブ | `@opennextjs/cloudflare` によるアダプテーション層が必要 |
| DB 接続 | 直接 or Vercel 側プーリング | Hyperdrive 経由（未実測 — A21） |
| cron | Vercel Cron | 専用 Worker の Cron Triggers（本タスクでスキャフォールドのみ。実配送は未検証） |
| 環境分離 | Vercel の Preview Protection（premortem R-SEC-05 の懸念元） | wrangler named environments。Preview 相当の懸念は Cloudflare でも staging の Access 保護で別途対応が要る |

Cloudflare を選ぶことで Vercel Preview 経由の本番汚染（R-SEC-05 の懸念シナリオ）そのものは
発生しない構造になるが、Cloudflare 固有の環境分離漏れ（named environments の設定ミス）は
別途あり得るため、Vercel の懸念が「解消された」のではなく「形を変えた」と扱う。

## スパイク結果（task_003、2026-09-24 実測。`npm run build:cf` → `wrangler dev`）

環境: `wrangler 4.137.0` / `workerd@1.20260921.1`（`wrangler dev` 起動ログから実測）。
`wrangler whoami` で実アカウントに認証済みであることを確認済み（`workers: write` スコープ）。
**`wrangler deploy` は本タスクの禁止コマンドのため、いかなる形（`--dry-run` 含む）でも実行していない
— 下記はすべて `wrangler dev`（ローカル実行、実デプロイなし）での観測。**

| # | 項目 | 結果 | 証拠 |
|---|---|---|---|
| ① | `GET /api/health` が 200 | **成立** [実測] | `curl http://localhost:8799/api/health` → `{"status":"ok"}` / `HTTP_STATUS:200`。`GET /` も 200（Next.js の RSC ペイロード込みで正常描画） |
| ② | Route Handler の `request.text()` がバイト等価 | **成立** [実測] | 改行・タブ・引用符・絵文字ではない多バイト文字（`ünïcödé 日本語`）・NUL バイトを含む 49 バイトのボディを POST し、サーバー側 `request.text()` → `TextEncoder` → SHA-256 のハッシュと、ローカルファイルの `shasum -a 256` が完全一致（`36588a26c5125a6aabb41331633b27dfa4505a6c303d3186cf311e4805cc7437`）。テスト後、当該 POST ハンドラと `import "server-only"` はコミットから除去済み（health route は §7-7 の対象外のため） |
| ② | `import "server-only"` がクライアントバンドル混入をビルド時に落とす | **成立** [実測] | `src/app/spike-client/page.tsx`（`"use client"`）から `server-only` 依存モジュールを import させたところ、`next build` が `Error: 'server-only' cannot be imported from a Client Component module` で **exit code 1** になることを確認。検証後、スパイク用ファイルは削除済み |
| ③ | middleware が全リクエストに適用される | **成立** [実測] | `src/middleware.ts`（`matcher: "/:path*"`）でレスポンスヘッダ `x-spike-middleware: hit` を付与し、`/`・`/api/health`・存在しないパス（404）のいずれにも同ヘッダが付くことを確認。検証後、スパイク用ファイルは削除済み |
| ④ | セキュリティヘッダが全レスポンスに付く | **部分成立** [実測] | ③と同じ仕組み（middleware）でページ・API ルートには付くが、**`/_next/static/chunks/*.js`（静的アセット、Cloudflare の `ASSETS` バインディング経由で配信）には付かない**ことを確認（middleware がスキップされる）。→ 静的アセットへのヘッダ付与は middleware では実現できず、別機構（Cloudflare 側の Transform Rules 等）が要る。task_012 で「共通ラッパ代替」として再評価すること（当初計画の想定どおり） |

### `.open-next` の Worker サイズ計測（A25）

`.open-next/worker.js`（エントリポイント、動的 import で残りを呼ぶ薄いファイル）自体は
2,278 バイトで、**実際にデプロイされる Worker サイズの指標にならない**（`wrangler deploy`/
`wrangler versions upload` の esbuild バンドル時に初めて実サイズが確定するが、いずれも
禁止コマンドのため未実測）。代替として `.open-next/`（`assets/` を除く）の生合計サイズを
上限側の見積りとして計測: **20,352,234 バイト（19.41 MiB）＝ 64 MiB 上限の 30.3%**
（`scripts/ci/record-worker-size.mjs`、`npm run build:cf` の一部として毎回出力）。
未バンドル・未 minify の生サイズのため実際の値はこれより確実に小さい。80% 閾値
（check_040）に対して十分な余裕があることは確認できたが、**真の値は未実測のまま A25 の
[不明] として残す**（task_035 以降、staging への実デプロイ時に確定させる）。

## 未解決（[不明] のまま残す）

- **A20（一部解決）**: 上記①②③は成立、④は部分成立。middleware が静的アセットに掛からない
  点は「共通ラッパ代替」の検討対象として task_012 に引き継ぐ。
- **A21（未解決）**: Hyperdrive 経由で Workers から Supabase Postgres に接続したときの
  `pg_try_advisory_xact_lock`・`FOR UPDATE`・生成列・トリガの挙動は、実 Supabase プロジェクトが
  存在しない（task_003 の non_scope）ため未実測。`wrangler.toml` の `[[hyperdrive]]` は
  `localConnectionString` に `postgres://postgres:postgres@127.0.0.1:54322/postgres`
  （`supabase start` の既定値）を置いたプレースホルダのみで、`supabase start` 自体は
  本タスクで実行していない。task_011/035 で実測すること。
- **A24（未解決）**: プラン別 WAF ルール本数、Cloudflare Access の無料枠、Smart Placement の
  効果は未検証。`wrangler.toml` に `[placement] mode = "smart"` は設定したが効果測定はしていない
  （15分程度の最適化ウィンドウがあるとの一次資料の記載あり。実デプロイ後でないと測れない）。
- **A25（未解決、上記参照）**: 真の Worker バンドルサイズは未実測。見積り値のみ。
- cron の自動リトライ挙動（失敗時のリトライ回数・バックオフ）は一次資料から確認できなかった
  （docs/vendor-docs/cloudflare/opennext.md 参照）。task_012/018 実装時に再確認すること。

## 参照した一次資料

`docs/vendor-docs/cloudflare/hyperdrive.md`、`docs/vendor-docs/cloudflare/opennext.md`
（いずれも取得日 2026-09-24）。
