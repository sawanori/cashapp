# task_012 の残懸念

認証・セッション・CSRF・鍵運用・環境設定・セキュリティヘッダ。
形式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

---

## C-012-1 [high] staging / production はいまの状態では**起動できない**（意図した fail-closed）

**指摘**: `src/lib/config/env.ts` の `EXPECTED_SUPABASE_PROJECT_REF` は
`REPLACE_WITH_STAGING_SUPABASE_PROJECT_REF_TASK_035` /
`REPLACE_WITH_PRODUCTION_SUPABASE_PROJECT_REF_TASK_024` というプレースホルダのままである。
`APP_ENV` が `staging` / `production` のときは `SUPABASE_PROJECT_REF` が
この値と完全一致し、かつ Supabase の project ref の形（英小文字 20 文字）であることを要求するので、
実値を入れるまで staging / production は起動時に `EnvConfigError` で落ちる。

「本番以外の project ref では起動しない」（R-SEC-05）を環境変数どうしの突き合わせではなく
**ソースに固定した宣言**との突き合わせで実現しているため、実値が入るまでは両方とも落ちるのが正しい姿である。
テスト（`tests/unit/config/env.test.ts`）はこの fail-closed 自体を検査している。

**対応案**: Supabase プロジェクト作成時に実 ref をこの表へ書き込む。
書き込みはコード変更なので、レビューと commit の経路を通る（環境変数の一括投入では書き換わらない）。

**対応予定タスク**: task_035（staging）/ task_024（production）

---

## C-012-2 [high] レート制限のバインディングが `wrangler.toml` に無く、デプロイ環境では `/api/auth/line` が 503 になる

**指摘**: `src/lib/auth/rate-limit.ts` は Workers の Rate Limiting バインディング
（`AUTH_RATE_LIMITER`）か Durable Object namespace（`AUTH_RATE_LIMITER_DO`）のどちらかを要求し、
どちらも無ければ `RateLimiterUnavailableError` を投げる（ルートは 503 `RATE_LIMIT_UNAVAILABLE`）。
**アイソレート内メモリをカウンタに使わない**（A27）ためにフォールバックを持たせていない。

`wrangler.toml` は本タスクの `files_to_modify` に無く（task_003 / task_035 の所有）、
`[[ratelimits]]` の `namespace_id` も Durable Object の `migrations` も
Cloudflare アカウントが未作成で決められないため、バインディングは**追加していない**。
その結果、いまデプロイすると `/api/auth/line` は常に 503 を返す。

固定ウィンドウの Durable Object 実装（`FixedWindowRateLimiterDurableObject`）はコードとして存在し、
ユニットテストで挙動を確かめてあるが、`wrangler.toml` に束縛されていないので**動いていない**。

**対応案**: `wrangler.toml` に `[[ratelimits]] name = "AUTH_RATE_LIMITER"`（`simple.period` は
一次資料どおり 10 か 60 しか取れない。`docs/vendor-docs/cloudflare/rate-limiting.md`）を足すか、
Durable Object バインディングと `migrations` を足して `FixedWindowRateLimiterDurableObject` を輸出する。
A27（契約プランで使えるか）の実測も同時に行う。

**対応予定タスク**: task_024（本番環境構築）/ task_035（staging）

---

## C-012-3 [medium] CSP の `frame-ancestors` と `connect-src` が未実測の暫定値

**指摘**: `src/lib/security-headers.ts` は `frame-ancestors 'none'`、
`connect-src 'self' https://api.line.me` を既定にしている。
LIFF アプリが iframe に置かれる要件があるか、LIFF SDK が他のホストへ通信するかは**未実測**[不明]。
実機で不足があれば LIFF の初期化が CSP で止まる。

**対応案**: 実機（LINE アプリ内ブラウザ / 外部ブラウザ）で LIFF を動かし、CSP 違反を実測してから確定する。
緩めるときは「必要なホストだけ」に限り、`script-src` は nonce と `strict-dynamic` のままにする。

**対応予定タスク**: task_013（LIFF フロント）/ task_022（セキュリティテスト）

---

## C-012-4 [medium] `__Host-` Cookie は `http://localhost` では保存されない

**指摘**: `__Host-` 接頭辞はブラウザ側で Secure を強制するため、平文 http のローカルでは
セッション Cookie が保存されない。Cookie 名を環境で変える案は「本番だけ落ちる経路」を作るので採らなかった。

**対応案**: ローカルでの画面確認は https で行う（`wrangler dev` の https オプション等）。
手順を `docs/ops/` の開発手順に書く。

**対応予定タスク**: task_013（LIFF フロント）

---

## C-012-5 [medium] `audit_log.actor_ref` は `pepper_version` 移行の対象外

**指摘**: `resolveAppUser()` は移行時に `app_user.line_user_ref` と
`participant_claim.line_user_ref` を新版へ書き換えるが、`audit_log.actor_ref` は書き換えない。
`audit_log` は追記専用で `app_rw` に UPDATE 権限が無く、トリガでも止まっている（task_011）。
したがって**旧 PEPPER を捨てると、過去の監査ログの主体を辿れなくなる**。

**対応案**: 鍵運用手順に「旧 PEPPER は監査ログの保持期間が終わるまで捨てない」を明記する。
辿る必要が出たときの手順（提示された userId を旧 PEPPER でハッシュして一致検索する）を
`docs/legal-forensics.md` に書く。

**対応予定タスク**: task_024（`docs/ops/key-rotation-drill.md`）/ task_021（`docs/legal-forensics.md`）

---

## C-012-6 [medium] ビルド成果物の秘密値 grep は「いま存在する成果物」に対するもの

**指摘**: `tests/security/log-pii.test.ts` の最後の 1 ケースは `.next/static` と `.open-next` を
走査するが、これらは task_003 のビルドで作られたもので、**本タスクのソースを反映していない**。
検査は「走査した」ことは保証するが「最新のビルドに秘密値が無い」ことは保証しない。

**対応案**: `npm run build:cf` 直後に走る CI ジョブで grep する
（`scripts/ci/secrets-grep.sh` は task_022 の `files_to_create`）。

**対応予定タスク**: task_022

---

## C-012-7 [medium] acceptance-checks の `verification_method` とテストファイル名がずれている

**指摘**: check_058 / check_072 / check_075 の `verification_method` は
`tests/security/{csrf,id-token-replay,xss-csp}.test.ts` を名指ししているが、
この 3 ファイルは **task_022 の `files_to_create`** に載っているため本タスクでは作っていない
（他タスクの成果物を先取りしない規約）。同じ性質の検査は自タスク所有のファイルに置いた:

| check | 実際に検査している場所 |
|---|---|
| check_058（CSRF 欠落で 403） | `tests/unit/auth/csrf.test.ts` |
| check_072（2 回目 401 / 429） | `tests/integration/auth.test.ts`（2 回目 401）、`tests/unit/auth/line-verify.test.ts`（429） |
| check_075（CSP/HSTS/JS Cookie 0 個） | `tests/unit/security-headers.test.ts`、`tests/unit/auth/csrf.test.ts` |

**対応案**: task_022 で 3 ファイルを作るときに、ここに挙げたケースを移すか、
`docs/acceptance-checks.json` の `verification_method` を実在のファイルへ直す。
**いま `acceptance-checks.json` を書き換えていない**（他タスクの担当範囲と evidence の整合を壊さないため）。

**対応予定タスク**: task_022

---

## C-012-8 [low] `tests/unit/security-headers.test.ts` は `files_to_create` に無い追加ファイル

**指摘**: done_definition の「全レスポンスに CSP / HSTS / Referrer-Policy が付く」と
「JS から設定される Cookie が 0 個」を自タスク所有のファイルで押さえるために、
`files_to_create` に無い `tests/unit/security-headers.test.ts` を新規作成した
（既存のどのタスクの `files_to_create` にも含まれないことを確認済み）。

**対応案**: そのままでよい。task_022 が `tests/security/xss-csp.test.ts` を作るときに統合を検討する。

**対応予定タスク**: task_022

---

## C-012-9 [medium] `/api/me` の照会が直書き SQL で、リポジトリ層を経由していない

**指摘**: `src/app/api/me/route.ts` は `event` と `participant_claim` / `invoice` を
ルートハンドラの中の SQL で直接引いている。§11-3 の設計ではリポジトリ関数
（`src/lib/db/repositories/*.ts`、`organizerUserId` を必須引数に持つ）を通すことになっている。
リポジトリは task_014 / task_015 の `files_to_create` なので、本タスクでは作らなかった。

所有者判定はセッション由来の `app_user.id` だけを使っており、リクエストボディからは取っていない
（check_006 の原則は守られている）が、認可のロジックが 2 か所に散る状態である。

**対応案**: task_014 / task_015 でリポジトリができたら、この 2 クエリをそちらへ寄せる。

**対応予定タスク**: task_014 / task_015

---

## C-012-10 [medium] セッション更新で CSRF トークンが入れ替わる（競合の窓がある）

**指摘**: `/api/me` は有効期間の半分を過ぎたセッションを再発行する（§7-4 の 30 分スライディング）。
再発行で `jti` が変わるため、それに束縛された CSRF トークンも入れ替わる。
`/api/me` の応答を受け取る前に投げられた POST が古い CSRF トークンを持っていると 403 になる。

**対応案**: クライアントの共通フェッチラッパで、`CSRF_INVALID` を受けたら `/api/me` を
1 回だけ引き直して再送する（401 を 1 回だけ静かに再認証するのと同じ機構を共有する。§7-4）。

**対応予定タスク**: task_013（LIFF フロントの共通フェッチラッパ）

---

## C-012-11 [low] `gate:env` の「期待名の突き合わせ」は `docs/ops/env-baseline.json` 待ち

**指摘**: `docs/ops/env-baseline.json` は **task_035 の `files_to_create`** なので本タスクでは作っていない。
無い間、`scripts/gate-env-scope.mjs` はその節を `pending` として出力し exit 0 のままにする。
いま実走しているのは「staging と production が値を共有していないこと」「秘密値が `[vars]` に無いこと」
「service role キーがランタイムに無いこと」「必須の秘密値の名前が雛形にあること」
「ソース固定の Supabase project ref が自分の environment の外に出ていないこと（検査 (7)）」の 5 つである。

**対応案**: task_035 が `env-baseline.json` を作る際、`runtimes` と `production_only_values` を
`scripts/gate-env-scope.mjs` の `checkBaseline()` が読む形（同ファイルの doc コメントに記載）で書く。

**対応予定タスク**: task_035

---

## C-012-12 [low, deferred] CI 実走は未実施（GitHub リモート未作成）

**指摘**: `npm run gate:env` / `npm run gate:server-only` を GitHub Actions の
required status checks に載せる作業は行っていない。GitHub リモートが未作成で実走できないため。
task_012 の done_definition に CI 項目は無い。

**対応案**: **deferred: GitHub リモート作成後に実施**。
`.github/workflows/gate-*.yml` への追加は task_009（CI 骨格）/ task_024（本番環境）で行う。

**対応予定タスク**: task_009 / task_024

---

## C-012-13 [low] LINE verify のエラー時 HTTP ステータスが一次資料に無い

**指摘**: `docs/vendor-docs/line/verify.md` §1 のとおり、LINE の一次資料は
`POST /oauth2/v2.1/verify` のエラー時ステータスコードを明示していない [不明]。

**対応案**: 実装は「2xx 以外はすべて検証失敗」としてステータスコードにも `error_description` の
文言にも依存していない。追加対応は不要だが、LINE 側の仕様が明示されたら
`docs/vendor-docs/line/verify.md` を取り直す。

**対応予定タスク**: なし（記録のみ）

---

## C-012-14 [medium, deferred] `.dev.vars.example` に起動時必須の 4 変数が無い

**指摘**: `LINE_ENV_PROFILE` / `PEPPER` / `SESSION_KEYS` / `CRON_SECRETS` の雛形は
`.env.example` にしか書いていない。しかし `wrangler dev`（`npm run cf:dev`）と
`next dev`（`initOpenNextCloudflareForDev` の platform proxy）が読むのは **`.dev.vars`** であって
`.env` / `.env.local` ではない。ルートハンドラは `getCloudflareContext().env` から
`loadAppConfig()` を呼ぶため、`.dev.vars.example` をコピーしただけの開発者は
`/api/auth/line`・`/api/me`・`/api/consent` が 500、`/api/health` が 503 になる。

`.dev.vars.example` は **task_003 の所有ファイル**で task_012 の `files_to_modify` に無いため、
本タスクでは追記していない（他タスクの成果物を書き換えない規約）。

**いま打った手**: `scripts/gate-env-scope.mjs` の検査 (5) を分けて、
「名前がどこかの雛形にある」（従来どおり violation 判定）と
「ランタイム経路の雛形＝`.dev.vars.example` にある」（**pending** として毎回出力）を別々に報告するようにした。
`npm run gate:env` の出力に
`.dev.vars.example に無い必須秘密値: LINE_ENV_PROFILE, PEPPER, SESSION_KEYS, CRON_SECRETS` が毎回出る。
`tests/unit/config/env.test.ts` がこの pending 行の存在を検査している。

**対応案**: **deferred: task_003 / task_035 の担当範囲で `.dev.vars.example` に
ローカル用ダミー値を追記する**。追記されれば gate:env の pending は自動で消え、
`ok .dev.vars.example carries every startup-required secret name` に変わる。

**対応予定タスク**: task_003 / task_035

---

## C-012-15 [medium] `gate:env` の片側混入検出は Supabase project ref だけで、LIFF ID / Hyperdrive id は未カバー

**指摘**: 「本番の値が staging に混入していないこと」の検出には 2 つの形がある。

| 形 | 例 | 捕まえる検査 |
|---|---|---|
| 衝突型 | staging と production に同じリテラル | 検査 (3)（値の共有） |
| 片側混入型 | 本番の ref を **staging だけ**に書く | 「その値が本番専用だ」という環境から独立した宣言が要る |

修正前は検査 (3) しか無く、片側混入型を素通りさせていた（レビュー指摘 medium）。
実リポジトリでは `SUPABASE_PROJECT_REF` も LIFF ID も `wrangler.toml` に現れず secret 側にあるため、
混入が起きるならまさに片側混入型になる。

**いま打った手**: 検査 (7) を追加し、`src/lib/config/env.ts` の
`EXPECTED_SUPABASE_PROJECT_REF`（起動時アサートが使う**同じ正本**。値を書き写さず読む）と
`wrangler.toml` を突き合わせて、ref が自分の environment の外に現れたら violation にした。
フィクスチャ 2 本（`one-sided-leak` = 非 0 / `pinned-ok` = 0）で機械検査している。
ref がプレースホルダのあいだは検出できないので、その旨を pending として必ず出力する
（修正前の `(the runtime/staging/production leak checks above still ran)` は実際より広い範囲を
検査したように読めたので、実走した 3 項目を列挙する文言に置き換えた）。

**残る穴**: 本番 LIFF ID と本番 Hyperdrive id にはソース固定の宣言が無いので、
片側混入を検出できない。gate:env は
`片側混入を検出できない本番資源が残っている: production LIFF ID / production Hyperdrive id`
を pending として毎回出力する。

**対応案**: task_035 が `docs/ops/env-baseline.json` の `production_only_values` に
本番 LIFF ID / Hyperdrive id を入れる（`checkBaseline()` が既に読む形）。
入った時点でこの pending 行は自動で消える。

**対応予定タスク**: task_035 / task_024

---

## C-012-16 [記録] CSP はレスポンスとリクエストの**両方**に載せる必要がある（消さないこと）

**指摘**: `src/middleware.ts` は CSP をレスポンスヘッダと**リクエストヘッダの両方**に設定する。
一見すると重複だが、リクエスト側は削れない。
Next.js が自前の `<script>`（ブートストラップと `self.__next_f` のインラインデータ）に nonce を付ける経路は
**リクエストヘッダの `Content-Security-Policy` を読む 1 本だけ**で、
`x-csp-nonce` のような独自ヘッダは見ない
（`node_modules/next/dist/server/app-render/app-render.js:209-210` が
`headers['content-security-policy']` から `getScriptNonceFromHeader()` を呼ぶ。Next 16.3.6 で確認）。

リクエスト側を落とすと、配信される CSP は `script-src 'nonce-…' 'strict-dynamic'`
（`'self'` も `'unsafe-inline'` も無い）なのに出力される script に nonce が付かず、
ブラウザがアプリの JS を**全部**ブロックする。プレースホルダの `page.tsx` しか無いうちは無症状で、
task_013 が LIFF フロントを載せた瞬間に画面が hydration しない形で出る。

**いま打った手**: `requestHeaders.set(CSP_HEADER, buildContentSecurityPolicy(nonce))` を追加し、
`tests/unit/security-headers.test.ts` に検査を 7 ケース足した。
ヘッダ文字列の自前比較では再発を検出できないので、**Next.js 自身の抽出関数**
（`next/dist/server/app-render/get-script-nonce-from-header`）を直接呼び、
middleware がリクエスト側へ載せた CSP から nonce が取り出せること・
レスポンス側の CSP と一致することを検査する。
修正行を外すと 6 ケースが落ちることを実測で確認した（負の対照）。

**対応案**: 触らない。`next/dist/...` への deep import が壊れたら、それ自体が
Next 側の nonce 伝播経路が変わった合図なので、伝播を取り直してからテストを直すこと。

**対応予定タスク**: なし（記録のみ。実機での CSP 実測は C-012-3 のとおり task_013 / task_022）
