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

---

# 敵対レビュー（GPT-6 Astra, 2026-09-24, commit 906ba0a）への対応

封筒: `docs/review-log/task_012.json` の該当エントリ（verdict FAIL / high 1・medium 3）。
各項目は「指摘 / 再現結果 / 修正 / 残懸念」で書く。再現は**修正前の HEAD で実際にテストを走らせた**結果である。

---

## C-012-17 [high → 解消] ログイン CSRF（クロスサイトのフォーム送信で攻撃者のセッションを被害者に発行させられた）

**指摘（F-1）**: `src/app/api/auth/line/route.ts` が `Origin` も `Content-Type` も検査せず
`request.json()` を実行し、本文の追加フィールドも許容していた。攻撃者は自分の**未使用**の
ID トークンを埋めたフォームを別オリジンに置き、被害者のブラウザからトップレベル送信させられる。

```html
<form method="POST" action="https://app.example/api/auth/line" enctype="text/plain">
  <input name='{"idToken":"T_A","padding":"' value='"}'>
</form>
```

`enctype="text/plain"` のフォーム本文は `{"idToken":"T_A","padding":"="}` という**有効な JSON** になる。
ID トークンの単回使用（ADR-009）も IP レート制限も、この**初回の 1 通**は拒否しない。
セッション Cookie は `SameSite=Lax` だが、これは「送信時に付かない」規則であって
「クロスサイト経由の応答で**設定できない**」規則ではないため、被害者のブラウザには
攻撃者のアカウントのセッションが入る（ログイン CSRF / セッション固定）。

**再現結果**: 再現した。`tests/unit/auth/line-route.test.ts` を修正前の HEAD で実行すると、
上記フォームをそのまま再現したリクエストが **403 ではなく 200** を返し、応答に
セッション Cookie が付いた（`expected 200 to be 403`）。同ファイルの 14 ケース中 10 ケースが失敗。

**修正**: `src/lib/auth/request-guard.ts`（新規）を追加し、ルートの先頭で 3 枚重ねに落とす。

1. `assertSameOriginRequest()` — `Origin` があれば自サイトのオリジンと完全一致すること
   （一致しなければ 403 `CSRF_INVALID`）、`Origin` が無ければ `Sec-Fetch-Site: same-origin` があること。
   **どちらも無ければ拒否（fail-closed）**。
2. `assertJsonContentType()` — `application/json` 以外は **415**（HTML フォームは JSON を送れない）。
3. `assertOnlyKnownBodyKeys()` — 本文のキーは `idToken` だけ。未知フィールドは **400**
   （`padding` のような詰め物を通さない）。

**自サイトの決め方（環境変数を増やさなかった理由）**: 許可オリジンは `Host` ヘッダと `request.url`
から導く（`https://<host>`、ループバックのみ `http://<host>` も許可）。どちらも別サイトのページからは
偽装できない。**`https://liff.line.me` は許可しない**: あのオリジンは全 LIFF アプリの共有物で、
誰でも自分の LIFF を置けるため、許可すると別の LIFF 開発者から同じ攻撃が成立する。
LIFF アプリの実体はこのアプリ自身のエンドポイント URL で開かれるので、正規の
`fetch("/api/auth/line")`（`src/app/(liff)/**` の 5 か所。いずれも `content-type: application/json`）は
常に同一オリジンであり、この判定で落ちない。

**`Origin` が無いケースを fail-closed にした根拠**: Fetch 標準では **GET / HEAD 以外のリクエストは
`Origin` を持つ**。したがってブラウザ経由の正規 POST が `Origin` 無しで届くことはなく、
`Origin` も `Sec-Fetch-Site` も無いのは「ブラウザ以外の経路」である。
その経路を通す利益は無い（LIFF 以外からこのエンドポイントを叩く正規の利用者はいない）一方、
通せば上記の攻撃面が残る。よって拒否する。`curl` 等で疎通確認する場合は
`-H 'Sec-Fetch-Site: same-origin'` か自オリジンの `Origin` を明示すること。

**実測**: 同テスト 14 ケースが全て緑（うち正規の LIFF リクエスト 3 ケースが 200 を返し、DB まで到達することも確認）。

**残懸念**: `request.url` のスキームがプロキシで書き換わる構成では `https://<host>` 候補が効く形にしてあるが、
**Workers 以外のホスティングに移した場合は未検証**[不明]。移す場合はこのガードの実機確認が要る。

---

## C-012-18 [medium → 解消] レート制限で拒否するリクエストが先に DB へ接続していた

**指摘（F-2）**: POST ハンドラは `authenticateWithLineIdToken()` に入る前に
`createVerifiedDbClient()` を呼んでいた。この関数は接続と `SELECT session_user` を実行するため、
429 で弾くはずの乱打がそのまま DB の負荷になる。既存の「DB に到達しない」テストは
認証関数だけを呼んでおり、ルートの前処理を検査していなかった。

**再現結果**: 再現した。修正前の HEAD では、レート制限が `{success:false}` を返す設定でも
ルートは **200** を返し（＝レート制限判定自体がルート経路に無く）、`createVerifiedDbClient()` に到達していた。

**修正**: `src/lib/auth/line-verify.ts` に `authRateLimitKey()` / `enforceAuthRateLimit()` /
`singleFlightRateLimiter()` を切り出し、ルートは **DB 接続前**に `enforceAuthRateLimit()` を呼ぶ。
`authenticateWithLineIdToken()` 側の判定は**残す**（このモジュールを唯一の入口として使う
統合テストの契約を変えないため）。同じキーを 2 回判定してカウンタを二重消費しないよう、
ルートは `singleFlightRateLimiter()` で包んだものを渡す。

**実測**: `tests/unit/auth/line-route.test.ts` の 3 ケースで、(a) 429 のとき
`createVerifiedDbClient()` が 1 度も呼ばれないこと、(b) バックエンド未束縛なら 503 で同じく到達しないこと、
(c) 正常時にバックエンドの `limit()` 呼び出しが**ちょうど 1 回**であること、を実測した。

**残懸念**: `loadAppConfig()` はレート制限より前に走る（設定不備は即 500 相当にしたいため）。
これは DB にも外部にも触らない純粋な文字列検査なので負荷の観点では問題にならない。

---

## C-012-19 [medium → 解消] `gate:env` が引用符付きの TOML キーを読み飛ばしていた

**指摘（F-3）**: `scripts/gate-env-scope.mjs` の代入行の正規表現 `^([A-Za-z0-9_.-]+)\s*=\s*(.+)$` は
TOML の quoted key（`"KEY" = …` / `'KEY' = …`）に一致しない。禁止名を引用符で囲むだけで
検査 (1) を回避でき、`SUPABASE_SERVICE_ROLE_KEY` がランタイムの `vars` にあっても exit 0 になる。

**再現結果**: 再現した。`tests/unit/config/fixtures/env-scope/quoted-keys/wrangler.toml`
（`[env.staging.vars]` に `"SUPABASE_SERVICE_ROLE_KEY"` / `'ALLOW_PRIVILEGED_DB_ROLE'`、
`[env.production.vars]` に `"PEPPER"` を置いたもの）に対し、修正前は
`node scripts/gate-env-scope.mjs --root <fixture> --no-live` が **exit 0**（違反 0 件）だった。

**修正**: 代入行の正規表現を素のキー / `"…"` / `'…'` の 3 形に対応させ、キーの引用符を外して比較する。
併せて値側の `unquote()` を単一引用符（TOML のリテラル文字列）にも対応させ、
`stripTomlComment()` が基本文字列とリテラル文字列の両方を見るようにした
（`'pass#word'` のような値の `#` をコメント開始と誤認しないため）。

**実測**: 上記フィクスチャで exit 非 0 になり、3 つの違反
（`SUPABASE_SERVICE_ROLE_KEY must never be a runtime var` /
`ALLOW_PRIVILEGED_DB_ROLE must never be a runtime var` / `PEPPER is a secret`）が出る。
実リポジトリに対しては従来どおり exit 0（違反 0・pending 5）。回帰は `tests/unit/config/env.test.ts` に固定した。
`scripts/gate-env-scope.mjs` は G13（gate:integrity）の対象なので、基準値
`docs/gates/integrity-baseline.json` を同じコミットで更新した。

**残懸念**: これは「最小限の TOML 読み取り」であって完全な TOML パーサではない。
複数行文字列・インラインテーブル・ドット付きの quoted key（`a."b c" = …`）は依然として未対応である。
`wrangler.toml` でそれらを使い始めたら、このゲートは**黙って読み飛ばす**側に倒れる。
恒久対処は TOML パーサの導入（依存が増える）か、`wrangler.toml` の書き方を平易な形に限る運用規約。

---

## C-012-20 [medium → 解消（fail-closed で）] PEPPER 切替中にアカウントが分裂しうる

**指摘（F-4）**: 移行処理は旧版の参照値を**上書き**する。移行後に旧 PEPPER だけを持つ処理系へ
ログインが届くと、その処理系は既存ユーザーを発見できず**別の `app_user` を作る**。
新版の処理系は現行行を見つけた時点で戻るため、その後も 2 つのアカウントが残り、
発行されるセッションの userId が設定によって変わる。

**再現結果**: 再現した。`tests/unit/auth/pepper.test.ts`（postgres.js のタグ付きテンプレートを模した
スタブで SQL の発行順を見るもの）を修正前の HEAD で実行すると、PEPPER v1 だけを持つ処理系が
「v1 の参照値では見つからない・DB には v2 の行がある」状況で **例外を投げず `INSERT INTO app_user` を発行**した。

**採った方式**: 「旧参照値を残す」案は `app_user` / `participant_claim` のスキーマ変更
（参照値の複数保持）を要し、`supabase/migrations/**` は task_011 の所有ファイルで本修正の範囲外である。
また、旧参照値を残す方式は「旧 PEPPER で引ける期間」を延ばす＝R-SEC-09 で減らしたかった
露出面を再び広げる。したがって **旧 PEPPER 単独の処理系が新規作成に進めないようにする**方を採った。

**修正**: `resolveAppUser()` の `INSERT` 直前に
`SELECT pepper_version FROM app_user WHERE identity_scope = … AND pepper_version > <現行> LIMIT 1` を置き、
1 行でも見つかったら（＝この処理系の PEPPER 設定が DB より古い）**新規作成せず**
`CONFIG_INVALID` / 503 で落とす。既存行が現行版・旧版で見つかる経路は従来どおり通る（移行も従来どおり）。

**根拠**: 割れたアカウントは事後に自動では併合できない（移行で旧参照値が消えているため、
「同じ人だ」と示す手掛かりが DB に残らない）。一方 503 は運用で解消できる
（新しい PEPPER をその処理系へ投入して再デプロイする）。**取り返しのつかない側を避ける**。

**実測**: 同テスト 7 ケースが緑。(a) 新しい版の行があれば `CONFIG_INVALID` / 503 で `INSERT` を発行しない、
(b) 無ければ従来どおり作成する、(c) 現行版の行が見つかる経路・旧版からの移行経路は SQL の発行順が変わらない、
を実測した。実 Postgres に対する通し（`tests/integration/auth.test.ts` の check_074）も緑のまま。

**残懸念（運用手順）**: PEPPER を増やすときは
**「全処理系へ新旧そろえて投入 → デプロイ完了を確認 → ログインを流す」** の順を守ること。
ロールアウト中に旧設定のまま残っている処理系へ**新規**ユーザーのログインが当たると 503 になる
（既存ユーザーも、移行済みなら 503 になる）。これは意図した fail-closed だが、
**切替の窓ではログインが落ちうる**という運用上の制約である。
手順書への反映は `docs/ops/key-rotation-drill.md`（task_024）で行う。
なお、この検査は `app_user` に対する 1 回の索引スキャン（`identity_scope` + `pepper_version`）で、
**新規作成の経路でしか走らない**（既存ユーザーのログインには増えない）。

**対応予定タスク**: task_024（`docs/ops/key-rotation-drill.md` に切替手順を書く）

---

# 敵対レビュー 2 周目（GPT-6 Astra, 2026-09-24, review-view 648868a）への対応

上の 4 件を直したコミット（`10b4e7f` / `12fc3b9`）に対して、もう一度 G5 を回した結果。
Gemini 2.5 Pro は **PASS（指摘 0 件）**、GPT-6 Astra は **FAIL（high 1 / medium 1）**。
merge は `reject`（実効 high 1）。以下はその 2 件への対応である。

---

## C-012-21 [high → 解消] 同時の初回ログインでアカウントが分裂しうる（C-012-20 の競合版）

**指摘（2 周目 F-1）**: 「新版の存在確認と `INSERT` は直列化されていない。既存行が無い場合、
`FOR UPDATE` はこの競合を防がず、`ON CONFLICT` の対象にも `pepper_version` が含まれるため、
同じ `sub` に対する v1・v2 の行を両方作れる。作成後はそれぞれ既存行として早期 return し、
新版検出による拒否も働かない」。

C-012-20 で塞いだのは**逐次**の分裂（先に移行が起きた後に旧設定の処理系がログインを受ける）で、
**同時**の分裂（どちらもまだ行を作っておらず、互いの検査が空を返す）は残っていた。

**再現結果**: 再現した。`tests/unit/auth/pepper.test.ts` に「ロックを待っているあいだに別の
トランザクションが行を作って commit した」状況をスタブで組んだケースを足すと、修正前のコードは
**取り直しを一切行わず**（現行版の検索は 1 回だけ）そのまま作成・検査の経路へ進む。
加えて、Postgres 側の前提（同じ助言ロックを取った 2 本目のトランザクションは 1 本目が
commit するまで待つ）は、ローカルの実 DB に `app_rw` で 2 セッション繋いで実測した:
1 本目が `BEGIN; SELECT pg_advisory_xact_lock(1012070500); SELECT pg_sleep(10);` を保持している間、
2 本目の同じロック取得は `lock_timeout` で `ERROR: canceling statement due to lock timeout` になり、
1 本目の `COMMIT` 後は即座に取得できた。

**修正**: `resolveAppUser()` の**作成・移行の経路だけ**を助言ロックで直列化する。

1. 現行版の行が見つかる通常ログインは**従来どおりロックを取らない**（全ログインを直列化しない）。
2. 見つからなかったときだけ `SELECT pg_advisory_xact_lock(${APP_USER_WRITE_LOCK_KEY})` を取り、
   **現行版をもう一度引き直す**。待っているあいだに相手が作っていれば、その行を返す（作らない）。
3. その後に旧版からの移行 → 未知バージョンの検査 → `INSERT` と進む。

**鍵を「人ごと」にできない理由**: 鍵を `line_user_ref` から作ると、PEPPER が違う処理系どうしで
鍵も変わる（それが参照値の設計そのもの）ので、まさに守りたい競合を直列化できない。
生の `sub` を鍵にするのは L7（生 userId を DB へ渡さない）に反する。したがって**全体で 1 本**の
固定鍵にし、その代わりロックを取る経路を初回ログインと移行だけに絞った。

**ついでに広げた検査**: C-012-20 の検査は「自分より**新しい**版の行」だけを見ていた。
古い版を捨てた処理系（設定が `[2]` だけなのに DB に v1 の行がある）も同じように
既存行を見つけられず分裂させるので、「**自分の設定に無い版の行**」（`pepper_version <> ALL(設定の版)`）
を見る形に変えた。

**実測**: `tests/unit/auth/pepper.test.ts` 11 件が緑（ロックの位置・取り直し・非取得の 3 ケースを含む）。
実 Postgres に対する `tests/integration/auth.test.ts` 14 件も緑
（助言ロックと `<> ALL (…)::int[]` が最小権限ロール `app_rw` で実行できることの実測を兼ねる）。

**残懸念**: 助言ロックは**同じデータベース内**でしか効かない。読み書きを分ける構成
（レプリカ経由の書き込みは無いので現状は該当しない）や、DB を分けた将来の構成では成立しない。
また、このロックは新規作成・移行を全体で直列化するため、**大量の新規ユーザーが同時に来ると
そこが直列点になる**。招待リンク経由の一斉参加がどの程度の同時初回ログインを生むかは未実測 [不明]。
負荷試験は task_022。

---

## C-012-22 [medium → 解消] 引用符付きキーの Unicode エスケープで検査を回避できる

**指摘（2 周目 F-2）**: 引用符付きキーから引用符**だけ**を外し、基本文字列のエスケープを
復号していなかった。TOML の基本文字列は `\uXXXX` / `\UXXXXXXXX` を解釈するので、
`"SUPABASE_SERVICE_ROLE_\U0000004BEY"` は**キーとして** `SUPABASE_SERVICE_ROLE_KEY` に等しい。
C-012-19 で足した回帰テストはエスケープを含まないキーだけを検査していた。

**再現結果**: 再現した。`tests/unit/config/fixtures/env-scope/quoted-keys-escaped/wrangler.toml`
（`[env.staging.vars]` に `"SUPABASE_SERVICE_ROLE_\U0000004BEY"`、`[env.production.vars]` に
`"PEPPE\U00000052"`）に対し、修正前は `node scripts/gate-env-scope.mjs --root <fixture> --no-live` が
**exit 0**（違反 0 件）だった。

**修正**: `decodeTomlBasicString()` を足し、**基本文字列のキーと値の両方**を復号してから突き合わせる。
対応するエスケープは仕様の一覧そのまま（`\b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX`）で、
未知のエスケープ・範囲外のコードポイント・サロゲート値はそのまま残す（勝手に文字を落とさない）。
リテラル文字列（`'…'`）はエスケープを持たないので復号しない。

**実測**: 上記フィクスチャで exit 非 0（`SUPABASE_SERVICE_ROLE_KEY must never be a runtime var` /
`PEPPER is a secret`）。エスケープ無しのフィクスチャ（C-012-19）と実リポジトリは従来どおり
（それぞれ exit 1 / exit 0）。`tests/unit/config/env.test.ts` は 41 件が緑。

**残懸念**: C-012-19 と同じく、これは完全な TOML パーサではない。複数行文字列・インラインテーブルは
依然として未対応で、そこに書かれた禁止名は黙って読み飛ばされる
（ドット付きの quoted key は C-012-23 で塞いだ）。

---

# 敵対レビュー 3 周目（GPT-6 Astra, 2026-09-24, review-view 9002e88）への対応

2 周目の指摘を直したコミット（`d6f140f`）に対する 3 周目。
Gemini 2.5 Pro は **PASS（指摘 0 件）**、GPT-6 Astra は **FAIL（medium 2 件・high 0 件）**。
merge は **pass**（実効 high 0 / 有効票 2 / 欠票 0）。high が無いので差し戻しではないが、
2 件とも実在の穴なので同じ周で塞いだ。

---

## C-012-23 [medium → 解消] 引用符付きの表名・点区切りのキーで `gate:env` の検査を回避できる

**指摘（3 周目 F-1）**: 「表名は引用符を含む文字列のまま保持され、vars 判定は `/(^|\.)vars$/` で
行われる。そのため有効な TOML の `[env.staging."vars"]` 内では `SUPABASE_SERVICE_ROLE_KEY` を
検出しない。今回追加された復号処理は代入キーと値だけに適用され、この経路を担保しない」。

**再現結果**: 再現した。`tests/unit/config/fixtures/env-scope/quoted-tables/wrangler.toml`
（`[env.staging."vars"]` に `SUPABASE_SERVICE_ROLE_KEY`、`[env.production]` に
`vars."DATABASE_URL" = …`）に対し、**修正前の HEAD 版のスクリプト**（`git show HEAD:` で取り出して
実行）は `0 violation(s)` / exit 0 だった。

**修正**: 表名とキー列を 1 つの正規化関数 `normalizeTomlKeyPath()` に通す。
段ごとに引用符を外し、基本文字列ならエスケープも復号してから `.` で繋ぎ直す。
併せて代入行の切り出しを「先頭がキーに見える正規表現」から
**「引用符の外にある最初の `=`」**（`findTopLevelEquals()`）に変え、
`vars."NAME" = …` のような**点区切りのキー**も拾えるようにした（最後の段がキー、手前は表名に足す）。
これは C-012-19 / C-012-22 に「未対応」として残していた穴でもある。

**実測**: 同フィクスチャで exit 1 / 違反 2 件
（`SUPABASE_SERVICE_ROLE_KEY must never be a runtime var` / `DATABASE_URL is a secret …`）。
表名を正規化したので `APP_ENV of 'staging' is 'staging'` も通る（従来は pending になっていた）。
既存 3 フィクスチャと実リポジトリの判定は変わらない（`tests/unit/config/env.test.ts` 42 件が緑）。

**残懸念**: 段の中に `.` を含む引用符付きキー（`["a.b"]`）は、正規形では段の区切りと区別できない。
この用途（`vars` 表かどうか・どの environment か）では**締まる側**に倒れるので許容した。
複数行文字列とインラインテーブルは依然として未対応である。

---

## C-012-24 [medium → 解消（ただしライブ実走は未実施）] cron Worker のシークレットがライブ検査の対象外だった

**指摘（3 周目 F-2）**: 「ライブ検査は staging と production を反復するだけで、すべて `REPO_ROOT` を
作業ディレクトリとして `secret list` を実行する。cron Worker のシークレット名を取得する経路がなく、
cron 側にある `SUPABASE_SERVICE_ROLE_KEY` を検出できない」。

**再現結果**: コードを読めば明らかな欠落（照会先が 1 ランタイム分しかない）であり、**指摘のとおり**。
ただし**ライブ検査そのものは実走できていない**（`CLOUDFLARE_API_TOKEN` が無く、
Cloudflare アカウントも未作成。C-012-12）。したがって「cron 側の禁止名が検出されなかった」ことを
実データで再現したわけではない。

**修正**: ライブ検査を「ランタイム × environment」の二重ループにし、cron Worker には
`--config workers/cron/wrangler.toml` を付けて同じ照会を行う。
必須名（`REQUIRED_SECRET_NAMES`）はメインアプリの起動時アサートが要求するものなので cron には求めず、
**禁止名は両方に求める**。`workers/cron/wrangler.toml` が無い木では pending を出す。

**実測**: `-c, --config` が `wrangler secret list` に存在することを
`npx wrangler secret list --help` の出力で確認した（wrangler 4.137.0）。
`CLOUDFLARE_API_TOKEN=invalid-token-for-local-check` を与えて実行すると、
4 通り（main/staging・main/production・cron/staging・cron/production）すべてで照会が試みられ、
それぞれ「実行できなかった」note が出る（cron 側のコマンド行に `--config workers/cron/wrangler.toml`
が入っていることを出力で確認した）。

**残懸念**: 認証が通った状態での成功経路（`secret list` の JSON から名前を拾う部分）は
**cron・main とも未実走**である。これは本修正で増えた穴ではなく、C-012-12（ライブ検査の CI 接続は
task_024）と同じ制約である。実走は Cloudflare アカウント作成後に task_024 で行う。

**対応予定タスク**: task_024（ライブ検査の CI 接続と実走）
