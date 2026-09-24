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
