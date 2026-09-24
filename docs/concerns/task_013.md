# task_013 の残懸念

LIFF 外殻・起動順序・ループ防止・テレメトリ・静的フォールバック・ルートグループ。
形式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

---

## C-013-1 [high] `build:web-only` は「SDK を物理的に外したビルド」ではない

**指摘**: 計画 §7-3 は `build:web-only` を「LINE SDK 無しでビルドが通ることの担保」と書いている。
実装した `scripts/build-web-only.mjs` が実際にやっているのは次の 3 つであり、
**`node_modules` から `@line/liff` を取り除いた状態でのビルドは行っていない**。

1. `src/app/(web)/**` と共有ルートレイアウトから始まる import グラフの静的走査で、
   `@line/liff` / `@line/liff-mock` / `src/lib/liff/**` に到達しないことを確かめる
2. `next build` の成功
3. `.next/static/**` のマーカー grep

物理的に外すには `node_modules` の書き換えか、ビルド専用の別ルート（tsconfig の `paths` 差し替え、
`next.config.ts` の resolve alias）が要る。前者は並行タスクと共有する `node_modules` を壊し、
後者は `next.config.ts`（task_003 所有）と `tsconfig.json` の一時改変を伴うため、
本タスクの files_to_modify の外である。

**対応案**: (a) 現状の静的走査で十分とする（`(web)` が SDK に到達しないことは機械的に言える）か、
(b) `next.config.ts` に web-only ビルド時だけ `@line/liff` を解決不能にする分岐を足すか、
どちらを採るかを PO / 実装リードが決める。(b) を採る場合は `next.config.ts` の所有権の扱いも
併せて決める必要がある。

**対応予定タスク**: task_022（E2E・LINE 非依存ビルドのテストと CI ジョブ）

---

## C-013-2 [high] 現時点でモック混入 grep は空振りに近い

**指摘**: `.next/static` に LIFF 由来の文字列が **1 バイトも無い**（実測: `grep -rl "liff" .next/static`
が 0 件）。これは「モックが除去された」からではなく、**まだどのページも `bootLiff()` を
呼んでいない**ため SDK ごとクライアントバンドルに載っていないからである。
したがって check_079 の「`.next/static` に `@line/liff-mock` が含まれない」は、
いまは真だが**証明力がほとんど無い**。

`process.env.NEXT_PUBLIC_LIFF_MOCK === "1"` のガードが Turbopack の本番ビルドで
実際に定数畳み込みされ、`await import("./mock")` のチャンクごと落ちるかは **未実測**である。

**対応案**: `(liff)` のページが `bootLiff()` を呼ぶようになった直後（task_014 の最初のコミット）に
`npm run build:web-only` を走らせ、`.next/static` に `@line/liff` が載り、かつ
`@line/liff-mock` / `LiffMockPlugin` が載らないことを run-log つきで実測する。
畳み込みが効いていなければ、`next.config.ts` の webpack/turbopack 設定で
`@line/liff-mock` を本番ビルドから除外する明示的な分岐を入れる。
`scripts/build-web-only.mjs` は、この空振り状態のときに注意行を必ず出力するようにしてある。

**対応予定タスク**: task_014（最初の `(liff)` ページ）/ task_022

---

## C-013-3 [medium] CI の実走が未実施（GitHub リモート未作成）

**指摘**: done_definition 第 5 項「gate.yml に web-only ジョブが追加され緑」のうち、
**実 PR での緑は未実施**である。GitHub リモートが未作成（PO 判断待ち）で、`git push` も
本プロジェクトの禁止コマンドであるため、ワークフローを 1 度も実走させていない。

実施したのは静的検証だけである（`tests/unit/ci/web-only-workflow.test.ts`）:
`.github/workflows/gate-web-only.yml` として実在すること、YAML として妥当で `jobs.web-only`
ちょうど 1 つを持つこと、ステップが呼ぶ `npm run build:web-only` が package.json に実在すること、
`gate.yml` に同名ジョブを二重定義していないこと。

なお `gate.yml` は task_009 が並行して作成中であり、本タスクは **編集していない**
（CI ジョブの追加は `gate-<job>.yml` の独立ファイルで行う規約）。
required status checks への `gate-web-only / web-only` の登録は task_009 の担当である。

**対応案**: deferred: GitHub リモート作成後に実施。リモート作成後、最初の PR で
`gate-web-only` ジョブが緑であることを run-log に記録する。

**対応予定タスク**: task_009（ブランチ保護・required status checks）/ PO（リモート作成の判断）

---

## C-013-4 [medium] `(liff)` / `(web)` にページが 1 つも無いので、レイアウトが実行される経路が未検証

**指摘**: 本タスクが作ったのはレイアウト 2 本だけで、`src/app/(liff)` にも `src/app/(web)` にも
`page.tsx` が無い。Next.js のルート表にも両グループは現れない（`npm run build` の出力で確認）。
そのため次が **未実測**である。

- `(liff)/layout.tsx` の `resolveLiffId()` が実際に `getCloudflareContext()` から
  `LINE_ENV_PROFILE` を読み、`<meta name="x-liff-id">` を出せるか
- 設定不正時に `StaticFallback` に落ちる分岐が実際に描画されるか
- `readLiffIdFromDocument()` が実ブラウザの DOM から値を取れるか（ユニットテストは
  `querySelector` を注入した擬似 document でしか確かめていない）

**対応案**: 最初の `(liff)` ページ（O-1 起動・同意）が入る task_014 / task_015 で、
`next dev` または `wrangler dev` に対する実測を run-log に残す。E2E（`tests/e2e/outside-line.spec.ts`）
は task_022 の担当で、そこで `liff-mock` 経由の実ブラウザ検証が入る。

**対応予定タスク**: task_014 / task_015 / task_022

---

## C-013-5 [medium] サポート下限未満の判定は取りこぼす

**指摘**: `src/styles/tokens.css` の `.legacy-browser-notice` は
`@supports (display: grid) and (gap: 1rem) and (color: var(--color-text))` を満たさない
ブラウザにだけ案内を出す。この 3 機能は Chrome 66 / Safari 12 相当で揃うため、
`.browserslistrc` の暫定下限（Android 10 / iOS 14）**以上**の端末で誤って案内が出ることは無いが、
**下限を割っていても 3 機能を満たす端末はすり抜ける**（例: Android 10 端末の古い System WebView）。

そもそも下限値そのものが暫定である。LINE アプリが要求する OS 最小バージョンの一次資料を
取得できていない（`docs/supported-browsers.md` の [不明] 項目）。

**対応案**: T-P1-23 で LINE 公式の OS 最小バージョンを取得し、それに対応する
WebView / WKWebView のエンジンバージョンで判定機能を選び直す。`.browserslistrc` と
`tokens.css` の `@supports` と `docs/supported-browsers.md` は 3 点セットで同時に更新する
（運用ルールとして同書に明記済み）。

**対応予定タスク**: T-P1-23（`docs/task-list.json` 上の対応タスクは未採番。task_025 の実機確認と同時期）

---

## C-013-6 [medium] テレメトリは記録するだけで、集計もアラートも無い

**指摘**: `POST /api/telemetry/client-error` は `logEvent("warn", "telemetry.client_error", …)` で
1 行出すだけである。R-LINE-03 の検知シグナル（「`liff_init_failed` / `SDK_LOAD_FAILED` /
`SCRIPT_ERROR` の UA クラス別件数」）を**数える仕組みは無い**。Cloudflare Workers Logs に
出てはいるが、集計・しきい値・通知が無いので「白画面が起きていることに気づく」までは到達していない。

また、レート制限のバックエンド（Workers Rate Limiting バインディング / Durable Object）は
`wrangler.toml` に未束縛であり（task_024 / task_035 の担当）、
**現状の staging / production ではこのエンドポイントは fail-closed の 503 を返す**。
ローカルは `.env.local` の `ALLOW_LOCAL_RATE_LIMIT_BYPASS=1` でのみ通る。

**対応案**: 外形監視と通知（task_023）に `telemetry.client_error` の UA クラス別件数を入れる。
レート制限バインディングは環境構築タスクで束縛する。

**対応予定タスク**: task_023（依存先込み health・外形監視）/ task_035（staging）/ task_024（production）

---

## C-013-7 [low] `ConsentGate` を呼ぶ画面がまだ無い

**指摘**: `ConsentGate` は `csrfToken` と `textVersion` を props で受ける設計にした
（`src/lib/auth/csrf.ts` は `server-only` なのでクライアントから参照できないため）。
この 2 つを渡す呼び出し側（O-1 の起動・同意画面、P-1 の招待リンク着地）はまだ存在しない。
`textVersion` の正本（規約・プライバシーポリシーの版）も task_021 まで存在しない。

**対応案**: task_015（P-1 / O-1 の画面）で呼び出し側を実装するときに、
`POST /api/auth/line` の応答ボディから受け取った CSRF トークンを渡す配線を入れる。
`textVersion` は task_021 が `src/content/terms.md` / `privacy.md` に版を持たせるまで暫定値になる。

**対応予定タスク**: task_015 / task_021

---

## C-013-8 [low] files_to_create に無いファイルを 2 つ足した

**指摘**: 台帳の files_to_create に無い次の 2 ファイルを追加した。

- `scripts/build-web-only.mjs` — `package.json` の `build:web-only` が呼ぶ実体。
  scope の「package.json scripts に build:web-only」を成立させるために必要で、
  他タスクの files_to_create にも `docs/task-list.json` 全体にも同名の記載は無い。
- `tests/unit/ci/web-only-workflow.test.ts` — done_definition 第 5 項の静的検証。
  共通ルールが「ワークフロー YAML の静的検証まで行う」と定めているため、
  その検証を毎回 `npm run test:unit` で走る形に残した。

また、CI ジョブは規約どおり `.github/workflows/gate-web-only.yml` として独立ファイルで追加し、
files_to_modify に挙がっていた `.github/workflows/gate.yml` は **編集していない**
（並行タスク衝突回避の規約が gate.yml の編集を禁じているため。gate.yml は task_009 の所有物）。

**対応案**: 台帳の files_to_create / files_to_modify を実態に合わせて更新するかは、
台帳の書き換え権限を持つタスク（task_006 / 検証エージェント）の判断に委ねる。

**対応予定タスク**: task_006（gate-check・台帳同期）
