# task_013 の残懸念

LIFF 外殻・起動順序・ループ防止・テレメトリ・静的フォールバック・ルートグループ。
形式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

---

## C-013-1 [high] `build:web-only` は「SDK を物理的に外したビルド」ではない

**指摘**: 計画 §7-3 は `build:web-only` を「LINE SDK 無しでビルドが通ることの担保」と書いている。
実装した `scripts/build-web-only.mjs` が実際にやっているのは次の 4 つであり、
**`node_modules` から `@line/liff` を取り除いた状態でのビルドは行っていない**。

0. `package.json` の `build` / `build:cf` が `NEXT_PUBLIC_LIFF_MOCK` を定義していることの検査
1. `src/lib/liff/**` と `src/app/(liff)/**` 以外の `src/` 全ファイルが LIFF を参照しないことの走査
   （＋ `src/app/**` の `(liff)` 以外と `src/middleware.ts` を起点とする import グラフの走査）
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

## C-013-2 [high → 解消] 畳み込みの前提が偽だった（実測で判明・修正済み）

**当初の指摘（2026-09-24 1 周目）**: `.next/static` に LIFF 由来の文字列が 1 バイトも無く、
`process.env.NEXT_PUBLIC_LIFF_MOCK === "1"` のガードが本番ビルドで定数畳み込みされるかは未実測だった。

**実測の結果（2 周目）**: 前提は **偽**だった。`scripts/build-web-only.mjs` は `next build` の前に
`delete env["NEXT_PUBLIC_LIFF_MOCK"]` していたが、Next.js がクライアント側の
`process.env.NEXT_PUBLIC_*` を定数へ置換するのは
`node_modules/next/dist/lib/static-env.js` の `getNextPublicEnvironmentVariables()` で、
実装は `for (const key in process.env)` ＝ **存在するキーだけ** define にする。
未設定にすると define が 1 つも作られず、実行時判定が残って
`await import("./mock")` が到達可能なままチャンク化される。

リポジトリの複製（`src` ＋ `node_modules` のハードリンク）に `bootLiff()` を呼ぶ
`src/app/page.tsx` を置いて測った結果:

| ビルド時の `NEXT_PUBLIC_LIFF_MOCK` | `.next/static` の `liff-mock` / `LiffMockPlugin` | `isInClient` |
|---|---|---|
| 未設定（旧実装） | **2 ファイル**（うち 1 つは `@line/liff-mock` 本体 18KB） | 2 ファイル |
| `0`（修正後） | **0 ファイル** | 2 ファイル |

`isInClient` が両方で載っているので、後者の 0 件は「SDK ごと無い」のではなく
**モックだけが落ちている**ことを意味する。

**対応（実施済み）**:

- `scripts/build-web-only.mjs` は `delete` をやめ、`NEXT_PUBLIC_LIFF_MOCK=0` を明示的に設定して
  `next build` を起動する。
- `package.json` の `build` / `build:cf` も `NEXT_PUBLIC_LIFF_MOCK=0` を前置し、
  **配信される成果物を作る経路**でも define が必ず作られるようにした。
  （3 周目の訂正: 2 周目は `NEXT_PUBLIC_LIFF_MOCK=${NEXT_PUBLIC_LIFF_MOCK:-0}` と
  **外部の値を尊重する**形にしていたが、それだとデプロイ環境に `NEXT_PUBLIC_LIFF_MOCK=1` を
  置くだけでゲートもテストも緑のままモックが本番バンドルに載る。右辺を `0` リテラルに固定した。
  モックを有効にしたビルドが要る場合は本番ビルド経路を書き換えず、別経路を使う
  ＝ E2E は `npx next dev` で起動するので `.env.local` の `NEXT_PUBLIC_LIFF_MOCK=1` で足りる。）
- `npm run build:web-only` に検査 (0) を足し、この 2 つのスクリプトが
  `NEXT_PUBLIC_LIFF_MOCK=0` に**固定**していなければ違反にする（3 周目に「定義の有無」から強めた）。
  `tests/unit/ci/web-only-workflow.test.ts` も同じことを毎回確かめ、
  「`delete env[...]` に戻したら落ちる」形にした。あわせて 3 周目に、
  fixture の木を作って `scripts/build-web-only.mjs` を**実際に spawn** し、
  `=1` / `${NEXT_PUBLIC_LIFF_MOCK:-0}` / 未定義の 3 つで exit 1、`=0` で exit 0 になることを
  固定するテストを足した（本文 grep ではなく exit code を見る）。Next 側の前提
  （`for (const key in process.env)`）自体もテストが毎回読み直す。
- `src/lib/liff/client.ts` / `src/lib/liff/mock.ts` / `.env.example` / ADR-013 の
  「未設定なら畳み込まれる」という説明を「**`"1"` 以外の値が設定されていることが条件**」に直した。

**残っていること**: 本リポジトリの `.next/static` はまだ LIFF 由来の文字列を 1 つも含まない
（どのページも `bootLiff()` を呼んでいないため）。`build:web-only` はその状態のとき注意行を必ず出す。
最初の `(liff)` ページが入った直後に、本リポジトリ自身で同じ grep を実測し直すこと。

**対応予定タスク**: task_014（最初の `(liff)` ページでの再実測）

---

## C-013-3 [medium] CI の実走は一部だけ実施（push では緑 / PR と修正版は未実走）

**2 周目の更新（2026-09-24）**: 作業中に **GitHub リモートが作成された**
（`origin git@github.com:sawanori/cashapp.git`）。`gate-web-only` ワークフローは実際に 2 回走り、
**どちらも緑**である（`gh run list --workflow gate-web-only.yml`。`scripts/record-run.sh task_013` 経由で記録）。

| run id | head | event | 結論 | 時刻 |
|---|---|---|---|---|
| 35985828331 | b1bc328 | push (main) | success | 2026-09-24T10:12:31Z |
| 35984699932 | 62e31be | push (main) | success | 2026-09-24T10:00:40Z |

ジョブ名は `web-only` で、required status check として指定する文字列は
`gate-web-only / web-only` である（run の `jobs[].name` で確認）。

**3 周目の更新（2026-09-24T10:5x）**: 2 周目に「まだ CI を通っていない」と書いた修正版は、
その後に他タスクが main を push した際に**一緒に載って実走し、緑になった**。

| run id | head | event | 結論 | 備考 |
|---|---|---|---|---|
| 35989181733 | d722cc4 | push (main) | success（job `web-only`） | `4d22062` / `f77ac63`（2 周目の修正）を含む |

`git merge-base --is-ancestor 4d22062 d722cc4` が真であることを確認した（＝この run が検査したのは
`NEXT_PUBLIC_LIFF_MOCK=0` を設定する 2 周目のスクリプトである）。

**それでも残っていること（deferred のまま）**:

1. **`pull_request` イベントでの緑はまだ無い。** 実走した 4 回はいずれも `push` である。
   done_definition の文言は「PR で緑」。
2. **3 周目の修正（init タイムアウト・env の固定・`StateView` の ③ 単独回避）は未 push。**
   `git push` は本プロジェクトの禁止コマンドなので、このエージェントからは実走させられない。
   次に main が push されたときに `gate-web-only` が検査する。
3. **ブランチ保護が未設定。** required status checks への `gate-web-only / web-only` の登録は
   task_009 の担当で、task_009 は 3 周目に「いまは入れない」と判断している
   （`docs/concerns/task_009.md`）。したがってこの項目の解消時期は task_009 / PO の判断に従う。

**当初の指摘（1 周目）**: done_definition 第 5 項「gate.yml に web-only ジョブが追加され緑」のうち、
**実 PR での緑は未実施**である。GitHub リモートが未作成（PO 判断待ち）で、`git push` も
本プロジェクトの禁止コマンドであるため、ワークフローを 1 度も実走させていない。

実施したのは静的検証だけである（`tests/unit/ci/web-only-workflow.test.ts`）:
`.github/workflows/gate-web-only.yml` として実在すること、YAML として妥当で `jobs.web-only`
ちょうど 1 つを持つこと、ステップが呼ぶ `npm run build:web-only` が package.json に実在すること、
`gate.yml` に同名ジョブを二重定義していないこと。

なお `gate.yml` は task_009 が並行して作成中であり、本タスクは **編集していない**
（CI ジョブの追加は `gate-<job>.yml` の独立ファイルで行う規約）。
required status checks への `gate-web-only / web-only` の登録は task_009 の担当である。

**対応案**: deferred: (a) 2 周目の修正を push したうえで PR を立て、`pull_request` イベントでの
`gate-web-only` の緑を run-log に記録する。(b) task_009 側で branch protection を有効にし、
required status checks に `gate-web-only / web-only` を登録する。

**この項目が残っている限り task_013 を「完全達成」として扱わない**（`completion_status` は
deferred を含む扱いにする。台帳 `docs/task-list.json` の書き換えは台帳所有タスクの判断に委ねるため、
本タスクは台帳を編集せず、ここと `docs/PROGRESS.md` / `docs/HANDOFF.md` に残す）。
なお共通ルールどおり、これは BLOCKED の理由にはしない。

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

**その実測が済むまで check_079 と R-LINE-04 を「達成」として扱わない。**
いま機械的に言えるのは「`src/` の全走査で LIFF 参照が 2 か所に閉じている」ことと
「複製リポジトリでの実測でモックだけがバンドルから落ちる」ことであって、
本リポジトリのバンドルに実際に LIFF SDK が載った状態での grep はまだ 1 度も走っていない。

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

**指摘**: 台帳の files_to_create に無い次の 3 ファイルを追加した。

- `scripts/build-web-only.mjs` — `package.json` の `build:web-only` が呼ぶ実体。
  scope の「package.json scripts に build:web-only」を成立させるために必要で、
  他タスクの files_to_create にも `docs/task-list.json` 全体にも同名の記載は無い。
- `tests/unit/ci/web-only-workflow.test.ts` — done_definition 第 5 項の静的検証と、
  C-013-2 の畳み込み条件の回帰テスト。
  共通ルールが「ワークフロー YAML の静的検証まで行う」と定めているため、
  その検証を毎回 `npm run test:unit` で走る形に残した。
- `tests/unit/components/StaticFallback.test.tsx`（2 周目に追加）— check_078 の
  「再試行・LINE で開く・幹事への連絡」が実際に描画されることの固定（C-013-9）。

また、CI ジョブは規約どおり `.github/workflows/gate-web-only.yml` として独立ファイルで追加し、
files_to_modify に挙がっていた `.github/workflows/gate.yml` は **編集していない**
（並行タスク衝突回避の規約が gate.yml の編集を禁じているため。gate.yml は task_009 の所有物）。

**対応案**: 台帳の files_to_create / files_to_modify を実態に合わせて更新するかは、
台帳の書き換え権限を持つタスク（task_006 / 検証エージェント）の判断に委ねる。

**対応予定タスク**: task_006（gate-check・台帳同期）

---

## C-013-9 [medium] 静的フォールバックの「LINE アプリで開く」が出せない場面がある

**指摘（2 周目のレビューで発覚。一部修正済み）**: check_078 の期待は
「静的フォールバックに **再試行・LINE アプリで開く・幹事への連絡** が出て白画面にならない」だが、
1 周目の実装では `StaticFallback` を描く 3 か所（`src/app/layout.tsx` の `legacy` / `no_script`、
`src/app/(liff)/layout.tsx` の `sdk_unavailable`）が `retryHref` も `permanentLink` も渡しておらず、
**実際に出るのは「幹事への連絡」の固定文だけ**だった。

**修正済み**:

- 再試行の導線を `StaticFallback` の既定に格上げし、props を渡さなくても必ず出るようにした。
  既定の遷移先は**アプリの入口 `/`**（ラベルは「アプリを開き直す」）。
  現在の URL（`href=""`）にしなかったのは、`a[href]` を link ロールへ対応づける規則が
  href の非空を条件にしている実装があり（`aria-query` の `{name:"href", constraints:["set"]}`）、
  空文字だとスクリーンリーダーにリンクとして届かない恐れがあるためである。`#` は押しても何も起きないので使わない。
  `retryHref` を明示すればその URL を使う（クライアント側は `window.location.href` を渡せる）。
- 「LINE アプリで開く」に必要なパーマネントリンクを LIFF ID だけから組み立てる
  `liffPermanentLink()` を `src/lib/liff/client.ts` に足した。URL 形式は推測ではなく
  インストール済み `@line/liff` 2.31.0 の同梱物が一次資料である
  （`docs/vendor-docs/line/liff-sdk.md` §4。`@liff/consts` の `PERMANENT_LINK_ORIGIN` が
  `"https://liff.line.me/"`）。SDK の `liff.permanentLink.createUrl()` は `init` 成功後にしか
  使えないため、**SDK が落ちたときの導線には使えない**。そのための別経路である。

**残っている指摘**:

1. `src/app/(liff)/layout.tsx` の `sdk_unavailable` 分岐では「LINE アプリで開く」を**出せない**。
   この分岐が出るのは `resolveLiffId()` が `null` を返したとき ＝ **LIFF ID そのものが解決できない**
   ときなので、パーマネントリンクを組み立てる材料が無い。壊れたリンクを出すより無いほうがよい、
   と判断して出していない。
2. `src/app/layout.tsx` の `legacy` / `no_script` も同様に出せない
   （LIFF ID は `(liff)` グループより下でしか解決しない）。
3. 3 つ揃うのは「起動後に SDK 読み込みが 3 秒で間に合わなかった／`init` が失敗した」場面、
   すなわち `bootLiff()` の結果を画面が受けて `StaticFallback` を描くときである。
   その画面は **task_014 までまだ存在しない**。
4. ~~`StateView` の `outside_line` / `auth_unavailable` も `permanentLink` 未指定では
   ①「LINE で開く」②「URL」が消え、③ QR の注記だけが残る~~
   → **3 周目に修正済み**。①②③ を 1 つのまとまりとして扱い、`permanentLink` が無いときは
   ③ も描かない。③ だけが残ると画面には「いま見ている端末では読み取れません」＝
   **できないことしか書かれていない**状態になり、check_029 の期待（①→②→③ の順で表示）を
   満たさないため。壊れたリンクを出さない意図は維持し、本文
   「LINE アプリで開いてください」は残るので次にやることは画面に残る。
   `tests/unit/components/StateView.test.tsx` の該当テストは「リンクを出さない」から
   「①②③ のどれも出さない（③ だけ残る状態を作れない）」へ書き換えた。
   `permanentLink` を **型で必須化**する案（state ごとの判別可能ユニオン）は採っていない。
   呼び出し側（task_014）が LIFF ID を解決できない場面があり、その場合に渡せる値が無いためである。

**対応案**: task_014 の起動画面で `bootLiff()` の結果を受ける際に、
`liffPermanentLink(readLiffIdFromDocument())` を `StaticFallback` / `StateView` の
`permanentLink` に、現在の URL を `retryHref` に渡す。そこで初めて check_078 の 3 導線が実画面で揃う。
`(liff)/layout.tsx` の `sdk_unavailable`（設定不正）については、
`StateView` の `gate_blocked` 相当に寄せるか専用の理由コードを足すかを task_014 で決める。

**対応予定タスク**: task_014（最初の `(liff)` 画面）/ task_015

---

## C-013-10 [medium → 解消] `liff.init()` にタイムアウトが掛かっていなかった

**指摘（3 周目のレビューで発覚）**: 3 秒タイムアウトが SDK の動的 import にしか掛かっておらず、
`liff.init()` は素の `await` だった。`init()` は LINE のサーバーへ LIFF アプリ設定を取りに行く
**ネットワーク処理**なので、電波が悪い・応答が返らない場面では reject もせず settle しない。
その結果 `bootLiff()` が永久に解決せず、`sdk_unavailable` も `init_failed` も返らないまま
画面は loading のまま ＝ R-LINE-03 が防ぎたい白画面になる。

**対応（実施済み）**: `liff.init()` も `withTimeout()` で包み、時間切れなら `init_failed` ＋
テレメトリ `liff_init_failed` にした（reject と同じ結末。タイムアウト専用コードは足していない。
画面側の分岐も、監視で数える単位も「init が成立しなかった」で同じだからである）。
`tests/unit/liff/client.test.ts` に「`init` が解決しない Promise を返す」ケースを足し、
`timeoutMs: 20` で `init_failed` になることを固定した。

**非空振りの実測**: この修正を一時的に素の `await` へ戻して当該テストだけを走らせると、
`Error: Test timed out in 5000ms`（= `bootLiff()` が解決しない）で落ちることを確認してから戻した。

---

## C-013-11 [medium] 配信される成果物そのものへの grep が CI に無い

**指摘**: `gate-web-only` は `scripts/build-web-only.mjs` が**自前で** `NEXT_PUBLIC_LIFF_MOCK=0` を
渡して作った別ビルドを grep する。実際にデプロイされるのは `release.yml` の
`npm run build:cf`（OpenNext 成果物）であり、その成果物に対する
`@line/liff-mock` / `LiffMockPlugin` の grep ステップは**どのワークフローにも無い**
（`grep -rn "NEXT_PUBLIC_LIFF_MOCK" .github/workflows/` のヒットは `gate-web-only.yml` の
コメント 2 行のみ）。3 周目に `build` / `build:cf` を `NEXT_PUBLIC_LIFF_MOCK=0` へ固定し、
`build:web-only` とユニットテストがその固定を毎回検査する形にしたので、
「env 1 つでモックが載る」経路は塞がった。残るのは「デプロイされる実物を見ていない」ことである。

**なぜ本タスクで直さないか**: `.github/workflows/release.yml` は **task_009 の files_to_modify**
であり、本タスクの担当範囲外である（他タスクのファイルを変更しない規約）。

**対応案**: `release.yml` の `npm run build:cf` の直後に、OpenNext 成果物
（`.open-next/**` と `.next/static/**`）への `@line/liff-mock` / `LiffMockPlugin` grep ステップを
1 つ置き、ヒットしたら deploy 前に落とす。

**対応予定タスク**: task_009（release.yml の所有者）/ task_022（LINE 非依存ビルドの CI ジョブ）

---

## C-013-12 [medium] `npm run test:unit` が赤のまま（task_013 起因ではない）

**指摘**: task_013 の verify_commands の 1 本 `npm run test:unit` は exit 1 である。
落ちるのは `tests/unit/gate-constraints.test.ts` の 2 件
（`passes on a clean tree` 5295ms / `catches the real forbidden patterns` 6145ms）で、
どちらも **`Error: Test timed out in 5000ms`** ＝ アサーション失敗ではない。

**task_013 起因でないことの根拠**:

- 同じスイートを `npx vitest run tests/unit --testTimeout=30000` で走らせると
  **26 ファイル / 734 テストが全て pass**（3 周目の最終 HEAD で実測、102.53 秒）。
- 本タスクは `tests/unit/gate-constraints.test.ts` / `scripts/gate-constraints.sh` /
  `docs/constraints.json` を 1 行も触っていない（最終更新は `7ba8eae` / task_004）。
- テストを弱めない規約があるため、他タスクのテストに `testTimeout` を足すことはしていない。

**対応案**: task_004 側で当該 describe に明示的な `testTimeout`（30000 等）を与えるか、
`gate-constraints.sh` の呼び出し回数を減らす。

**対応予定タスク**: task_004

---

## C-013-13 [high → 解消] ストレージが使えないとログイン回数の上限が機能しない（GPT-6 Astra F-1）

**指摘（4 周目・敵対レビュー GPT-6 Astra / `docs/review-log/task_013.json`）**:
`storage` が `null` の場合、`readAttempts` は毎回 0 を返し `writeAttempts` は何も保存せず終了する。
読み書きが例外になる場合も同様で、未ログインで戻り続けると 3 回目以降も `login()` が呼ばれる。
同梱テストは `storage: null` での**初回起動しか**検査していなかった。

**HEAD での再現（実測）**: 封筒の repro をそのままテストに書き（`tests/unit/liff/client.test.ts` の
`describe("ストレージが使えないときも打ち切る（F-1 / fail-closed）")`）、修正前の HEAD で**再現した**。

```
× storage が null でも 3 回目の未ログインでは login を呼ばず auth_unavailable
  AssertionError: expected 1 to be 2   ← 2 回目も loginAttempts が 1 のまま（＝どこにも残らない）
× storage の読み書きが例外を投げても 3 回目は login を呼ばず auth_unavailable
  AssertionError: expected 'redirecting_to_login' to be 'auth_unavailable'
× storage が書けなかった回の分も数える（読めるが書けないストレージ）
  AssertionError: expected 'redirecting_to_login' to be 'auth_unavailable'
Tests  3 failed | 18 passed (21)
```

**対応（実施済み）**: `src/lib/liff/client.ts` にモジュール内の退避カウンタ `memoryAttempts` を置き、
「読めない・書けない」回はそこで数える。

- `readAttempts`: `storage === null` / `getItem` が throw / 値が壊れている / **読めたが未記録**
  のいずれでも 0 ではなく `memoryAttempts` を返す。
- `writeAttempts`: `setItem` が成功したときだけ退避先を使わない。`null` か例外なら `memoryAttempts` に入れる。
- `clearAttempts`: ログイン成立時に `memoryAttempts` も 0 に戻す（次の障害を独立に数えるため）。

修正後は同じテストが 21/21 緑（`npx vitest run tests/unit/liff/client.test.ts`）。

**残っていること（この項目の実質的な残懸念）**: 退避先の有効範囲は
**このページ（タブの 1 回の読み込み）だけ**である。`login()` はページ遷移を起こすので、
`sessionStorage` がまったく使えない端末では、復帰時にモジュールごと作り直されて退避先も 0 に戻る。
したがってこの修正が確実に効くのは「同じページの中で `bootLiff()` が繰り返し呼ばれる」経路
（再試行ボタン、React の再マウント、StrictMode の二重実行）である。
再読み込みをまたいで数え続けるには、回数をページの外＝ URL（`login({ redirectUri })` のクエリ）
などに持ち出す必要があり、それは `(liff)` 画面側の設計（task_014）を巻き込む。
**いまの実装は「数えられないなら数えない」から「数えられる範囲では必ず打ち切る」への前進であって、
ストレージ不能端末での完全な保証ではない。**

**対応案**: task_014 の起動画面で `bootLiff()` を呼ぶときに、`sessionStorage` が使えない環境に限って
試行回数を `redirectUri` のクエリに載せて往復させるかを決める（URL に載る値なので、
載せてよいのは回数だけ・識別子は載せない）。

**対応予定タスク**: task_014（最初の `(liff)` 画面）

---

## C-013-14 [medium → HEAD では再現せず] `liff.init()` のタイムアウト（GPT-6 Astra F-2）

**指摘**: タイムアウトが `loadLiff()` にしか掛かっておらず、`liff.init()` が応答しないと
`bootLiff` が pending のままでテレメトリも静的フォールバックも起きない。

**再現結果: 再現せず。** 封筒は **2 周目のコミット `4d22062`** の木に対して組まれており
（`docs/review-log/task_013.json` の `commit` フィールド）、この指摘は **3 周目の `455e594`
「`liff.init` のタイムアウト」で既に修正済み**である（本ファイル C-013-10）。

4 周目に、封筒の repro を**既定のタイムアウト**（`timeoutMs` を注入しない）でなぞるテストを
追加して実測した。封筒の「3100 ミリ秒待つ」は偽タイマーを `SDK_LOAD_TIMEOUT_MS` だけ進める形に
置き換えている（見ている点は同じ＝ `init` にも既定の 3 秒が掛かっているか）。

- `tests/unit/liff/client.test.ts` の
  `it("既定のタイムアウトは init にも掛かる（F-2 の repro を timeoutMs 未指定でなぞる）")`
- HEAD で **pass**（`init_failed` ＋ テレメトリ `liff_init_failed`、`login` は未呼出）。

**非空振りの実測**: `bootLiff` の `withTimeout(liff.init(...))` を一時的に素の `await` へ戻すと、
この it は `Error: Test timed out in 5000ms` で落ちることを確認してから戻した
（`Tests 3 failed | 19 passed (22)`。巻き込まれた 2 件は既存の `timeoutMs: 20` のケースと
偽タイマーの相互作用）。つまり新しいテストは**空振りしていない**。

---

## C-013-15 [medium → 解消] 上限の検査前に任意長の本文を読み込む（GPT-6 Astra F-3）

**指摘**: `POST /api/telemetry/client-error` は `Content-Length` の無いリクエストで
`request.text()` が本文全体を読み終えるまで 256 バイト上限を検査しない。
したがってこの上限は受信量・メモリ使用量を制限しない。レート制限の判定も本文読み込みの後にある。

**HEAD での再現（実測）**: `tests/unit/telemetry.test.ts` の
`describe("Content-Length の無い本文（F-3）")` に repro を書き、修正前の HEAD で**再現した**。

```
× 上限を超えた時点で読むのをやめる（本文全体を受け取らない）
  AssertionError: expected 4096 to be less than or equal to 384   ← 本文 4096 バイトを全部読んでいた
× レート制限の判定は本文を 1 バイトも読む前に終わっている
  AssertionError: expected 400 to be 503   ← 本文読み込みの 400 がレート制限の 503 より先に出ていた
Tests  2 failed | 15 passed (17)
```

前提も実測で確かめてある。undici（Node 22）の `new Request(url, { body: ReadableStream })` は
`content-length` ヘッダを付けず（`null`）、`request.body` は pull 駆動なので、
読むのをやめればソース側の `pull` も止まる。

**対応（実施済み）**:

- `readBoundedBody(request, maxBytes)` を追加した。`request.body` を `getReader()` で
  **チャンクごとに読み**、累計が `maxBytes` を 1 バイトでも超えた時点で `reader.cancel()` して 400。
  `body` が取れない実装のためだけに `request.text()` へ退避する枝を残してある
  （そこは読み切ってからバイト長で測る）。
- `Content-Length` がある場合の早期拒否（1 バイトも読まない）はそのまま残した。自己申告なので
  **申告が無い／過少申告**の場合にストリーム側の上限が効く、という二段構えである。
- レート制限の判定（`resolveRateLimiter` ＋ `check`）を**本文読み込みより前**へ移した。
  バックエンドが無ければ本文に触れないまま fail-closed の 503 になる。
- 併せて上限の単位を UTF-16 コード単位（`raw.length`）から**バイト**に直した。

修正後は同じテストが 17/17 緑。「読んだ量」は 4096 バイト中 320 バイト（上限 256 ＋ 1 チャンク）で
止まり、レート制限で落ちる場合は `request.bodyUsed === false`（本文ストリームに触れていない）になる。

**残っていること**: `readBoundedBody` が守るのは**このハンドラが読む量**であって、
Cloudflare Workers のランタイムがリクエスト全体をどこまで受信するかではない。
実運用での上流の打ち切りは、レート制限バインディングと WAF の設定側の話であり、
それらは未束縛のままである（C-013-6 と同じく task_024 / task_035）。

**対応予定タスク**: なし（本文読み込みの範囲は解消。上流の受信制限は C-013-6 に含む）

---

## C-013-16 [high → 解消] 保存値を優先したため「読めるが書けない」ストレージで打ち切れなかった

**指摘（4 周目・2 巡目。gemini F-1 と GPT-6 Astra F-1 が独立に同じ反例を挙げた）**:
C-013-13 の修正版 `readAttempts` は、保存値が有効な整数ならそれを退避先より**優先**していた。
`getItem` は成功するが `setItem` が落ちるストレージ（quota 超過など）では保存値が `"1"` のまま
残り続けるため、`writeAttempts` が退避先に 2 を入れても次回また 1 を読み、`login()` を呼び続ける。
**再読み込みをまたがなくても起きる**ので、C-013-13 に書いた「ページ 1 回分」の制約とは別の穴である。
1 巡目に足した「読めるが書けない」テストは `getItem` が常に `null` を返す形だったので、
この経路を踏んでいなかった。

**HEAD での再現（実測）**: `getItem` が常に `"1"` を返し `setItem` が throw するストレージで
`bootLiff` を 2 回呼ぶテストを足したところ、2 回目も `redirecting_to_login` になった
（`AssertionError: expected 'redirecting_to_login' to be 'auth_unavailable'`）。

**対応（実施済み）**: `readAttempts` を
`Math.max(memoryAttempts, readStoredAttempts(storage))` に変えた。
どちらか一方でも数えられている限り打ち切りに到達する。健全な経路では `memoryAttempts` は 0 のままなので、
`sessionStorage` が正常に動く端末の挙動は変わらない。修正後は同じテストが緑
（`tests/unit/liff/client.test.ts` 23 件）。

---

## C-013-17 [medium → 解消] `readBoundedBody` の非ストリーム経路が上限を掛けずに読み切っていた

**指摘（4 周目・2 巡目。gemini F-2）**: `readBoundedBody` は `request.body` が
ストリームとして読めない場合に `await request.text()` へ退避しており、**そこだけ読み切ってから**
バイト長を測っていた。ストリーム側に入れた上限をこの枝が迂回する。

**HEAD での再現（実測）**: `getReader` を持たない本文を渡すと `text()` が 1 回呼ばれた
（`AssertionError: expected 1 to be +0`）。

**対応（実施済み）**: 枝を 2 つに割った。`request.body === null`（本文そのものが無い）は
従来どおり `text()`（結果は空文字）で、**本文はあるのに読み取り機が無い**場合は
`text()` を呼ばずに 400 で落とす（fail-closed）。`tests/unit/telemetry.test.ts` に
「`text()` は 1 回も呼ばれない」ことと「`body === null` は空文字として扱う」ことを固定した。

**3 巡目の追補（gemini F-1 medium）**: 残った `body === null` の枝も `text()` を呼んでいたため、
「仕様に反して巨大な本文を返す `text()`」を渡されると読み切る経路が復活する、という指摘があった。
実 `Request` では `body === null` ⇔ 本文が無いので起きない（実測: Node 22 / undici で
`new Request(url, { method: "POST" })` は `body === null` かつ `text().length === 0`、
本文を渡すと `body` は必ずストリームになる）が、枝そのものを消すほうが短いので
**`text()` を呼ばずに空文字を返す**形にした。テストも「`text()` が 1 回も呼ばれない」を見る。

---

## C-013-18 [high → 解消] 保存できた回を退避先に残していなかった（途中でストレージが落ちる経路）

**指摘（4 周目・3 巡目。GPT-6 Astra F-1）**: C-013-16 までの `writeAttempts` は
`setItem` が成功した回は退避先を更新せずに `return` していた。そのため
**2 回保存できた後にストレージが使えなくなる**と（タブ復帰時の quota 逼迫、プライベートモードへの
切り替え等）、`readStoredAttempts` は例外で 0、退避先も 0 のままとなり、3 回目の `login()` が通る。
同じモジュール実体の中で起きるので、C-013-13 の「ページ再読み込みで消える」とは別の経路である。

**HEAD での再現（実測）**: `Map` を持ち `available=false` の間だけ全メソッドが throw する
ストレージで、`available=true` のまま `bootLiff` を 2 回（保存値 `"2"`・`login` 2 回）呼んだ後に
`available=false` にして 3 回目を呼ぶテストを足したところ、
`AssertionError: expected 'redirecting_to_login' to be 'auth_unavailable'` で再現した。

**対応（実施済み）**: 退避先を**置き場ごとの高水位**にした。

- 退避先を `WeakMap<AttemptStorage, number>`（＋ `storage === null` 用の変数 1 本）にし、
  `writeAttempts` は **`setItem` の成否に関わらず必ず**退避先を更新する。
- 退避先は減らさない（`Math.max` で上書き）。`clearAttempts`（ログイン成立）でのみ 0 に戻す。
- 置き場をキーにしたのは、本番の置き場が `globalThis.sessionStorage` ＝ ページごとに 1 つの
  固定オブジェクトで、実質「このページのカウンタ」になるためである。モジュール変数 1 本にすると
  **別の置き場を使う呼び出しにまで数が漏れる**（テストどうしの独立性も壊れる）。

修正後は `tests/unit/liff/client.test.ts` 24 件が緑。C-013-13 に書いた
「ページ 1 回分しか効かない」という制約は**そのまま残る**（再読み込みで WeakMap ごと消える）。

---

## C-013-19 [high → 修正済み・**未レビュー**] 退避先を置き場オブジェクトごとに持ったため、既定の置き場が途中で参照できなくなると数が切り替わる

**指摘（4 周目・4 巡目。GPT-6 Astra F-1）**: C-013-18 の修正は退避先を
`WeakMap<AttemptStorage, number>` ＝ **置き場オブジェクトごと**に持った。しかし
`defaultStorage()` は `sessionStorage` への参照自体が throw すると `null` を返すため、
**参照できていた間の数（2）と `null` になった後の数（0）が別勘定**になる。
既存の置き場で 2 回記録していても、`null` 側が 0 なら 3 回目の `login()` が通る。
C-013-18 のテストは「同じ置き場オブジェクトのメソッドが例外になる」場合しか見ておらず、
この切り替えを検査していなかった。

**HEAD での再現（実測）**: `globalThis.sessionStorage` を「`available` が真なら実体を返し、
偽なら `SecurityError` を投げる」getter にし、**`storage` を渡さない本番経路**で
`bootLiff` を 2 回（保存値 `"2"`・`login` 2 回）進めてから `available=false` にして 3 回目を呼ぶ
テストを足したところ、`AssertionError: expected 'redirecting_to_login' to be 'auth_unavailable'`
で再現した。

**対応（実施済み）**: 退避先のキーを「置き場オブジェクト」から**スコープ**に変えた。

- `deps.storage` を渡さない経路（＝本番）は、`defaultStorage()` の戻り値が
  `sessionStorage` でも `null` でも常に同じ `DEFAULT_STORAGE_SCOPE` で数える。
  カウンタが属する単位は置き場オブジェクトではなく**ページ**だからである。
- 呼び出し側が置き場を注入したときだけ、その置き場ごと（`storage: null` は専用スコープ）に分ける。
  注入した側の期待に合わせるためで、本番の経路には影響しない。

修正後は `tests/unit/liff/client.test.ts` 25 件が緑（task_013 所有テスト合計 103 件）。

**この項目の扱い**: 修正は入っているが、**この修正に対する敵対レビューは回していない**。
本周の敵対レビューは指示された上限（reject 後の再実行 2 回）を使い切っており、
`docs/review-log/task_013.json` の最後の記録は 1 つ前のコミット（`2d3db98`）に対する
`reject`（実効 high 1 ＝ 本項目）である。したがって
**本周は §15-3 step 5 の「3 周後も high が残れば BLOCKED」に該当する**。
次の周で最初にやることは、この修正（およびストレージの故障モード 5 種のテスト）を
敵対レビューに掛け直すことである。

**ストレージの故障モードの一覧（4 巡かけて 1 つずつ出てきたもの。次の周はここから読むこと）**:

1. 置き場そのものが無い（`storage === null` / SSR） → C-013-13
2. 読み書きが例外になる → C-013-13
3. 読めるが書けない（古い値が読める） → C-013-16
4. 書けていたのに途中で読み書きが落ちる → C-013-18
5. **既定の置き場の取得自体が途中で落ちる**（`defaultStorage()` が `null` に転じる） → 本項目
6. **保存値を読んだだけで書き込みが起きない回がある**（打ち切り応答の回） → C-013-20

**5 巡目の追記**: 本項目の修正（スコープ固定）は 5 巡目にレビューを回して確認した。
gemini は **PASS**、GPT-6 Astra は本項目そのものは挙げず、代わりに 6 番目の故障モード
（C-013-20）を挙げた。したがって本項目は「未レビュー」ではなくなっている。

---

## C-013-20 [high → 解消] 保存値を読んだだけの回が退避先に残らない（GPT-6 Astra F-1・5 巡目）

**指摘**: `readAttempts` は保存値と退避先の大きいほうを返すだけで、読み取った保存値を
退避先へ**書き戻していなかった**。新しいページ（新しいモジュール実体）で保存値 `2` を読んで
`auth_unavailable` を返す回は `writeAttempts` を一度も通らないため、退避先は 0 のままである。
その直後、同じページのまま `sessionStorage` の取得が落ちると、保存値も退避先も読めなくなって
試行回数が 0 に戻り、3 回目の `login()` が通る。
C-013-18 / C-013-19 の修正は「書いた回」しか退避先へ残していなかったので、この経路は塞げていない。

**HEAD での再現（実測）**: `cashapp.liff.loginAttempts='2'` を持つストレージを返す
`globalThis.sessionStorage` の getter を置き、**`storage` を渡さない本番経路**で
`bootLiff` を 1 回呼んで `auth_unavailable` を確認したあと、getter を `SecurityError` に変えて
もう一度呼ぶテストを足したところ、`AssertionError: expected 'redirecting_to_login' to be
'auth_unavailable'` で再現した。

**対応（実施済み）**: `readAttempts` が求めた値を `writeMemoryAttempts(scope, attempts)` で
退避先へ同期するようにした。読み取りに副作用が入るが、`writeMemoryAttempts` は `Math.max` なので
**退避先を実際の試行回数へ近づける方向にしか働かない**（減ることはない）。
修正後は `tests/unit/liff/client.test.ts` 27 件が緑。

---

## C-013-21 [medium → 解消] `liff.login()` の例外が state とテレメトリを迂回する（GPT-6 Astra F-2・5 巡目）

**指摘**: SDK の読み込みと `liff.init()` には例外処理があるのに、`liff.login()` の呼び出しだけ
素のままだった。ここで例外が出ると `bootLiff` が reject し、
「**例外を投げない**（呼び出し側は必ず `state` で分岐できる）」というこのモジュールの契約が破れる。
画面は state を受け取れず、テレメトリも送られない ＝ R-LINE-03 が防ぎたい白画面になる。

**HEAD での再現（実測）**: `login` が `throw new Error("login failed")` する SDK を渡すと、
`bootLiff` が `Error: login failed` で reject した（テスト側に例外が素通りした）。

**対応（実施済み）**: `liff.login()` を `try` で包み、失敗したら
`auth_unavailable` ＋ 新しいテレメトリコード `login_call_failed` を返すようにした。

- コードを `login_loop_aborted` と分けたのは、前者が「こちらが数えて止めた」、
  後者が「SDK が転んだ」であり、監視で数える単位も次にやることも違うためである
  （`src/lib/telemetry.ts` の allowlist に 1 つ追加した。自由入力欄は増えていない）。
- 呼ぶ前に数えた分（`next`）は戻さない。`login()` が実際に遷移を始めてから投げた可能性があり、
  「無かったこと」にすると上限が緩むためである。

---

## C-013-22 [medium → 解消] ビルドに適用されない環境変数代入でも固定値検査を通過する（GPT-6 Astra F-3・5 巡目）

**指摘**: `scripts/build-web-only.mjs` の `checkProductionBuildEnv` は npm script の**本文に
`NEXT_PUBLIC_LIFF_MOCK=0` という文字列があるか**しか見ておらず、その代入が実際のビルドコマンドに
適用されるかを見ていなかった。シェルの `VAR=値 コマンド` は**そのコマンド 1 つ**にしか効かないので、
`NEXT_PUBLIC_LIFF_MOCK=0 echo prepare && next build` のように別コマンドへ前置した形が合格し、
実際の `next build` は環境から `1` を継承できる（＝ モックが本番バンドルに載る。制約 I4）。

**HEAD での再現（実測）**: 同梱の fixture に
`NEXT_PUBLIC_LIFF_MOCK=0 echo prepare && next build` を渡して `runGate` すると
**exit 0（合格）**になった（`AssertionError: expected +0 to be 1`）。
「ビルドコマンドが 1 つも無い」`NEXT_PUBLIC_LIFF_MOCK=0 echo nothing-to-build` も exit 0 だった。

**対応（実施済み）**: `checkBuildCommandEnv()` を足し、npm script を `&&` / `||` / `;` で区切って
**実際にビルドするコマンド**（`next build` / `opennextjs-cloudflare build`）を探し、
その直前の代入（または先行する `export`）に `NEXT_PUBLIC_LIFF_MOCK=0` があることを要求する。
ビルドコマンドが 1 つも見つからない場合も、検査が空振りしたまま通らないよう違反にする。
`export NEXT_PUBLIC_LIFF_MOCK=0 && next build` は後続にも効くので合格とする
（偽陽性を作らないための対照テストも置いた）。

**残っていること**: パイプ（`|`）・部分シェル（`( )`）・変数展開経由の組み立ては解釈しない。
本リポジトリの npm script はこの範囲で足りるが、将来それらを使う場合はこの検査をすり抜ける。
その場合は npm script の書き方を平易な形に限る運用規約を置くか、シェルパーサを入れる。
`FOO=1` と `export FOO` を 2 文に分けた形も認識しない（`export` の行に `=` が無いため）。
その場合はゲートが違反にする＝ fail-closed 側に倒れるので、通してしまう危険は無い。

---

## C-013-23 [medium → 再現せず・該当分岐は削除] 代入だけの節を後続へ引き継いでいた（gemini F-1・5 巡目）

**指摘**: `checkBuildCommandEnv` はコマンドを伴わない代入だけの節（`FOO=bar; next build` の
`FOO=bar`）を「以降の全コマンドに効く」として `exported` へ取り込んでおり、シェルの実際の挙動と
食い違う。そのため `NEXT_PUBLIC_LIFF_MOCK=0; next build` を安全と誤判定する。

**シェル挙動の実測**（`sh -c`。指摘の前提はこのとおり正しい）:

| 書き方 | 子プロセスに渡るか |
|---|---|
| `FOO=bar; printenv FOO` | **渡らない**（空） |
| `FOO=bar && printenv FOO` | **渡らない**（空） |
| `export FOO=bar && printenv FOO` | 渡る（`bar`） |
| `FOO=bar printenv FOO` | 渡る（`bar`） |

**HEAD での再現結果: 再現せず。** 指摘された分岐（`rest.length === 0` のとき `env` を
`exported` へ入れる）は **到達しない**。`splitLeadingEnv` は先頭の代入を
`^NAME=値\s+`（**後ろに空白が要る**）で削るので、`NEXT_PUBLIC_LIFF_MOCK=0` だけの節は
`trim()` 後に末尾の空白が無く、代入として切り出されずに `rest` に残る。
`rest` は `export` でも build marker でもないので、その節は何も効かせずに読み飛ばされる。
`NEXT_PUBLIC_LIFF_MOCK=0; next build` と `NEXT_PUBLIC_LIFF_MOCK=0 && next build` の
fixture を足して実測したところ、**どちらも修正前の HEAD で exit 1（違反「前置されていません」）**
になった（＝ 誤判定は起きていない）。

**対応（実施済み）**: 再現しないが、その分岐は**誤ったシェル意味論をコードに書いている**ため
削除した。パーサを少し変えれば到達しうる（＝ 将来の誤判定の種）ので、残す理由が無い。
上の実測表をコメントとして同じ場所に残し、2 つの fixture テストを回帰として据え置いた
（`tests/unit/ci/web-only-workflow.test.ts` 17 件）。

---

## C-013-24 [medium → 解消] SDK の状態取得の例外が state とテレメトリを迂回する（GPT-6 Astra F-1・5 巡目レビュー）

**指摘**: C-013-21 で `liff.login()` は `try` に入れたが、`isInClient` / `isLoggedIn` /
`getIDToken` は例外処理の外のままだった。これらが投げると、やはり `bootLiff` が reject して
契約（例外を投げない）が破れ、失敗コードも送られない。

**HEAD での再現（実測）**: 3 つそれぞれを `throw` させるテストを足したところ、
`Error: isInClient failed` / `Error: isLoggedIn failed` / `Error: getIDToken failed` が
テスト側へ素通りした（`bootLiff` が reject した）。

**対応（実施済み）**: 同期呼び出しを 1 つ包む `callSdk()` を足し、3 か所とも通した。

- `isInClient` / `isLoggedIn` の失敗 → `init_failed`（LINE 内かどうかすら分からない ＝
  SDK が使えないので静的フォールバックへ落とす）。
- `getIDToken` の失敗 → `auth_unavailable`（ログイン済みのはずなのにトークンが手に入らない）。
- テレメトリはいずれも新コード `sdk_call_failed`。`login_call_failed` と分けたのは、
  あちらが「遷移を始めようとして転んだ」、こちらが「まだ何も始めていない」であり、
  復旧手順（再読み込みで直りうるか）が違うためである。

---

## C-013-25 [medium → 解消] パイプ左側だけの代入で本番ビルド検査を通過できる（GPT-6 Astra F-4・5 巡目レビュー）

**指摘**: `checkBuildCommandEnv` の区切りに `|` が入っていないため、
`NEXT_PUBLIC_LIFF_MOCK=0 printf x | next build` の代入が右側の `next build` にも効くものとして
扱われる。実際には左の `printf` にしか掛からない。

**HEAD での再現（実測）**: その fixture で `runGate` すると **exit 0（合格）**になった
（`AssertionError: expected +0 to be 1`）。

**対応（実施済み）**: 区切りを `/&&|\|\||;|\|/` にした（`\|\|` を `\|` より先に置かないと
`||` が空節 2 つに割れるので、選択の順序に意味がある）。同じ fixture で exit 1 になることを固定した。

---

## C-013-26 [medium] レート制限を超えた要求も毎回 `telemetry.rejected` を書く（GPT-6 Astra F-2・5 巡目レビュー・未対応）

**指摘**: `POST /api/telemetry/client-error` の 429 は `catch` に入り、要求ごとに
`telemetry.rejected` を 1 行出す。受理するテレメトリ件数を絞っても、**公開エンドポイントから出る
ログ量は絞れない**（同一 IP から 1000 回叩けば 429 が 1000 行出る）。

**なぜこの周で直さないか**: 「拒否した事実を残す」ことと「ログ量を抑える」ことのどちらを採るかは
運用設計の判断であり（拒否ログを落とすと攻撃の検知材料が消える）、本周に割り当てられた
レビュー往復の予算を使い切った後に出た指摘である。

**対応案**: (a) 429 のときだけ `telemetry.rejected` を出さず、レート制限側のカウンタに任せる。
(b) 同一キーにつき一定時間で 1 行だけ出す（ログのサンプリング）。
Workers Logs の課金と検知要件を見てから決める。

**対応予定タスク**: task_023（外形監視・ログ設計）/ task_024（production のレート制限バインディング）

---

## C-013-27 [medium] 文字サイズ 200% で `body` の最小幅が 640px になる（GPT-6 Astra F-3・5 巡目レビュー・未対応）

**指摘**: `src/styles/tokens.css` の `body { min-width: 20rem }` は、ルート文字サイズが
32px になると 640px を要求する。320px 幅のビューポートで横スクロールが出る。
同ファイルが掲げる「320px で横スクロールを出さない」「文字拡大に対応する」の両立を満たさない。

**なぜこの周で直さないか**: `20rem` を `20em` / `320px` のどちらにするか、そもそも `min-width` を
外すかは、実機（LINE アプリ内 WebView）での見え方を見て決めるべきで、机上で差し替えると
別の崩れを作る。本周のレビュー往復の予算を使い切った後に出た指摘である。

**対応案**: `min-width` を `320px` の固定値にする（rem 連動をやめる）か、`min-width` 自体を外して
中身側の `min-width: 0` と `overflow-wrap` で対処する。task_025 の実機確認と同時に決める。

**対応予定タスク**: task_025（実機確認）/ task_022（a11y の E2E）

---

## C-013-28 [medium] `readSpecifiers` がコメントを挟んだ副作用 import を見落とす（GPT-6 Astra F-5・5 巡目レビュー・未対応）

**指摘**: `scripts/build-web-only.mjs` の副作用 import 検出は `import` と引用符の間に**空白しか**
認めない。`import /* sdk */ "@line/liff";` のように構文上妥当なコメントを挟むと、
全走査と import グラフの**両方**が同じ参照を見落とす。

**なぜこの周で直さないか**: 正規表現でコメントを飛ばすと別の取りこぼしを作りやすく、
本来は TypeScript の AST（`typescript` は devDependency に既にある）で読むべき箇所である。
走査を AST 化するのは本周の範囲を超える。

**対応案**: `readSpecifiers` を `ts.preProcessFile()`（TypeScript 同梱の軽量スキャナ。
コメントと文字列を正しく飛ばして import 指定子だけを返す）に置き換える。
現状の正規表現は「見落とす」方向の穴なので、AST 化まではコードレビューで補う。

**対応予定タスク**: task_022（LINE 非依存ビルドの CI ジョブ）
