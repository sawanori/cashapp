# 技術実現性調査：LIFF × Next.js × Supabase/Postgres、Webhook冪等設計、Vercel/Cloudflare運用、決済テスト手段

調査日：2026-09-24（すべての一次資料は同日に WebFetch で実際に取得）
調査者：技術実現性リサーチャー（サブエージェント）
対象案件：幹事向け会費集金アプリ（LINEミニアプリ配布、参加者の支払いを自動検知して支払済みチェックを付ける）

---

## 結論

技術スタックの観点では、この案件は **Next.js (App Router) + Vercel (hnd1/東京) + Supabase を第一候補とすべき**である。理由は3点ある。第一に、Webhook を受ける Route Handler で `request.text()` により生の本文がそのまま取れることが Next.js 公式ドキュメントに明記されており、署名検証の最大の地雷（本文の再シリアライズ）を避けられる。第二に、Vercel の関数は `vercel.json` の `regions` で東京（`hnd1` = ap-northeast-1）に固定でき、Supabase の東京リージョンと同居させられる。第三に、Cloudflare Workers + Hono + D1/Neon は無料枠の CPU 10ms 制限と Postgres 接続の追加部品（Hyperdrive 等）が必要になり、1名＋AIエージェントのチームでは初期の複雑度が見合わない。Workers を選ぶべきなのは「Vercel Pro に課金せずに分単位の cron を回したい」場合に限られる。

ただし **認証の前提は引継ぎ書の想定と違う**。Supabase Auth の公式ソーシャルログイン一覧に LINE は含まれていない（Apple, Azure, Bitbucket, Discord, Facebook, Figma, GitHub, GitLab, Google, Kakao, Keycloak, LinkedIn, Notion, Slack, Spotify, Twitter, Twitch, WorkOS, Zoom）。一方で 2026年4月8日に **Custom OAuth/OIDC Providers** が発表され、任意の OIDC 準拠 IdP を `custom:` プレフィックス付きで登録できるようになった。LINE は `https://access.line.me/.well-known/openid-configuration` を公開しており（issuer `https://access.line.me`、ES256、PKCE S256 対応）、この経路で `signInWithOAuth({provider:'custom:line'})` が成立する可能性が高い。ただし **LIFF 内では `liff.getIDToken()` で既に ID トークンが手元にある**のに、Supabase の custom provider は `signInWithIdToken()` では使えない（公式ドキュメント・ブログとも `signInWithOAuth` のみを提示）。したがって LIFF アプリでは、**ID トークンをサーバーで `POST https://api.line.me/oauth2/v2.1/verify` により検証し、Supabase に自前の署名鍵をインポートして Supabase 互換 JWT を発行する**方式が、リダイレクトを1往復も挟まない唯一の現実解である。Supabase 公式は「自分で JWT を作りたい場合は秘密鍵をインポートするか共有シークレットを設定して新しい JWT 署名鍵を作成できる」と明記しており、これは準公式ではなく公式にサポートされた経路である。

**自動チェック要件（決済を検知して参加者に✅を付ける）は、決済事業者を「加盟店決済」として使う限り技術的に成立する**。Stripe は Webhook の順序保証がないこと・同一イベントが複数回届きうることを公式に明記し、イベントID による重複排除を指示している。PayPay Open Payment API は `merchantPaymentId`（加盟店側で一意に採番）をキーに `GET /v2/codes/payments/{merchantPaymentId}` で照会でき、Webhook とポーリング（2〜3秒間隔推奨）の両方が使える。つまり「請求レコード ⇔ merchantPaymentId/PaymentIntent ID」を1対1で持てば、参加者単位の照合は決済事業者の正規APIだけで完結する。**逆に言えば、幹事の個人PayPayアカウントへの個人間送金を検知する経路は、今回の調査範囲でも公開APIとして見つかっていない**（PayPay for Developers は加盟店向けAPIのみ）。

**最大の制約は決済側と配布側にある**。(1) Stripe の PayPay 概要ページは「Connect のサポート：いいえ」と明記する一方、決済手段サポート表のウォレット欄では PayPay の Connect 列が「✓ サポート対象 8」で、脚注8は「Connect を使用するには、招待をリクエストしてください」となっており、**公式資料間の矛盾は 2026-09-24 時点でも解消していない**。(2) Stripe の禁止業種一覧（最終更新 2026-09-22）は「ピアツーピアの送金」を禁止対象として掲げており、実態が個人間の立替精算ならStripeは使えない。(3) LINE MINI App の日本リージョンで LINE が提供する決済は「in-app purchase のみ」で、LINE Pay は 2025年4月30日に終了している。外部決済は「通常のWebページと同じように実装する」こととされ、**外部ドメイン／アプリでの取引完了後に LINE MINI App のページへユーザーを戻す設計が必須**である。

---

## 問いごとの回答

### 問1. Supabase Auth は LINE を OAuth/OIDC プロバイダーとしてサポートしているか

#### 1-A. 公式のビルトイン一覧に LINE は無い

- 一次資料：https://supabase.com/docs/guides/auth/social-login （2026-09-24 取得）
- 引用（プロバイダー一覧、原文）：
  > "Apple, Azure (Microsoft), Bitbucket, Discord, Facebook, Figma, GitHub, GitLab, Google, Kakao, Keycloak, LinkedIn, Notion, Slack, Spotify, Twitter, Twitch, WorkOS, Zoom"
- セルフホスト版の対応表でも同様。一次資料：https://supabase.com/docs/guides/self-hosting/self-hosted-oauth
  > "The table lists 24 providers including Apple, Azure, Bitbucket, Discord, Facebook, Figma, GitHub, GitLab, Google, Kakao, Keycloak, LinkedIn (OIDC), Notion, Slack (OIDC), Snapchat, Spotify, Twitch, Twitter, WorkOS, and Zoom" ※LINE は不在（[要約]、取得ページ本文の一覧を要約）

補足：GitHub 上に LINE をソーシャルログインとして追加する Pull Request（supabase/supabase#46920）が存在するが、**マージ済みで本番提供されているという確認は取れていない**。上記の公式ドキュメント2本に LINE が載っていない以上、「ビルトイン対応済み」と扱ってはならない。

#### 1-B. `signInWithIdToken` の対応プロバイダーは限定的

- 一次資料：https://supabase.com/docs/reference/dart/auth-signinwithidtoken
- 引用：
  > "Allows you to perform native Google, Apple, and Facebook sign in by combining it with [various packages]."
- 一次資料：https://supabase.com/docs/reference/javascript/auth-signinwithidtoken
  > "The authentication provider used should be enabled and configured"（JS リファレンスには対応プロバイダーの明示列挙が無く、例は Google のみ）

したがって **LIFF の ID トークンを `signInWithIdToken` にそのまま渡す経路は無い**。

#### 1-C. Custom OAuth/OIDC Providers（2026年4月8日GA）なら LINE を登録できる可能性が高い

- 一次資料：https://supabase.com/docs/guides/auth/custom-oauth-providers
- 引用：
  > "Custom OAuth/OIDC providers let you integrate any standards-compliant identity provider with Supabase Auth, beyond the ones Supabase supports out of the box."
  > "Supply the `issuer` URL and the discovery document, JWKS, and endpoints are resolved automatically."
  > "Free plan projects can add up to 3 custom providers. Pro plan and above have unlimited custom providers."
  > "PKCE (Proof Key for Code Exchange) is enabled by default (`pkce_enabled: true`) for all custom providers."
- 一次資料：https://supabase.com/blog/custom-oauth-oidc-providers （公開日 2026年4月8日）
  > "any standards-compliant OpenID Connect identity provider"
  > "You can add up to 3 custom providers per project. If you need more, contact support."
  ※ LINE は例として言及されていない。`signInWithIdToken` との併用可否もこのページに記載が無い。

- LINE 側の OIDC ディスカバリ文書は実在する。一次資料：https://access.line.me/.well-known/openid-configuration
- 引用（実取得したJSON）：
  ```json
  {
    "issuer": "https://access.line.me",
    "authorization_endpoint": "https://access.line.me/oauth2/v2.1/authorize",
    "token_endpoint": "https://api.line.me/oauth2/v2.1/token",
    "jwks_uri": "https://api.line.me/oauth2/v2.1/certs",
    "userinfo_endpoint": "https://api.line.me/oauth2/v2.1/userinfo",
    "response_types_supported": ["code"],
    "id_token_signing_alg_values_supported": ["ES256"],
    "code_challenge_methods_supported": ["S256"]
  }
  ```
- LINE Login の OIDC 対応。一次資料：https://developers.line.biz/en/docs/line-login/integrate-line-login/
  > "LINE Login v2.1 supports the OpenID Connect protocol and allows you to retrieve user data with ID tokens."
  > scopes: `profile`（プロフィール情報）, `openid`（ユーザーIDを含むIDトークン）, `email`（IDトークンにメールを追加）

**結論（問1）**：Supabase のビルトインに LINE は無いが、Custom OIDC Provider として `custom:line` を登録する経路は技術的に成立しうる。**ただし LIFF アプリでは推奨しない**。LIFF 内ではユーザーは既に LINE にログイン済みで ID トークンが `liff.getIDToken()` で取得できるのに、`signInWithOAuth` は LINE の認可画面へのリダイレクト往復を強制するためである（custom provider は `signInWithIdToken` では使えない）。

#### 1-D. 推奨方式：LIFF IDトークン検証 → 自前署名の Supabase 互換 JWT → RLS

これが本案件の推奨。根拠は以下の4本。

1. LINE は「LINEプラットフォームから直接取得したものでない限り、IDトークンはサーバーで検証せよ」と指示。
   - 一次資料：https://developers.line.biz/en/docs/line-login/verify-id-token/
   - 引用：
     > "Unless the ID token is obtained directly from the LINE Platform, validate the ID token on the server."
     > エンドポイント：`"https://api.line.me/oauth2/v2.1/verify"`（POST）、必須パラメータ `id_token` と `client_id`、レスポンスは `iss` `sub` `aud` `exp` `iat` `nonce` `amr` `name` `picture` `email` を含む

2. LINE は「フロントで取得したプロフィールをサーバーへ送るな、トークンを送れ」と明示。
   - 一次資料：https://developers.line.biz/en/docs/liff/using-user-profile/
   - 引用：
     > "Don't send the details of the user profile obtained with `liff.getDecodedIDToken()` and `liff.getProfile()` to the server from the LIFF app."
     > "send the ID token or access token from the LIFF app to the server. The server can safely retrieve the user's profile by sending the token sent by the LIFF app to the LINE Platform."

3. Supabase は自前の署名鍵をインポートして自分で JWT を発行することを公式に認めている。
   - 一次資料：https://supabase.com/docs/guides/auth/signing-keys
   - 引用：
     > "If you wish to make your own JWTs or have access to the private key or shared secret used by Supabase, you can create a new JWT signing key by importing a private key or setting a shared secret yourself."
     > "you can use your newly minted JWT by setting the `Authorization: Bearer <JWT>` header to all Data API requests."
   - 重要な制約（同ページ）：
     > **Important limitation:** Custom-minted JWTs cannot be used in the `apikey` header—only publishable or secret API keys are accepted there.（[要約]：自前発行JWTは `apikey` ヘッダーには使えず、`Authorization` ヘッダー専用。`apikey` には publishable / secret キーを別途渡す）

4. RLS の `auth.uid()` は JWT の `sub` クレームを読む。
   - 一次資料：https://supabase.com/docs/guides/database/postgres/row-level-security
   - 引用：
     > `auth.uid()` — "Returns the ID of the user making the request."（`sub` クレーム由来）
     > "When a request is made without an authenticated user (e.g., no access token is provided or the session has expired), `auth.uid()` returns `null`."
     > `auth.jwt()` — "Returns the JWT of the user making the request."
     > "raw_user_meta_data — modifiable by authenticated users; unsuitable for authorization" / "raw_app_meta_data — immutable by users; appropriate for storing authorization data"

**実装の骨子**：LIFF → `liff.getIDToken()` → 自前 API `/api/auth/line` → LINE の `/oauth2/v2.1/verify` で検証（`aud` = LIFF の LINE Login チャネルID、`iss` = `https://access.line.me`、`exp` を確認）→ `sub`（LINEユーザーID）で自アプリの `users` 行を upsert → その行の UUID を `sub` に入れた JWT を、Supabase にインポートした鍵で署名 → クライアントは `Authorization: Bearer <JWT>` + `apikey: <publishable key>` で Data API を叩く → RLS の `auth.uid()` が効く。

**代替（Supabase を Postgres としてのみ使う）**：RLS を使わず、すべての DB アクセスをサーバー側（Route Handler）で service role キーを使って行い、認可はアプリ層で行う。**本案件はこちらでも十分に成立する**。参加者が直接 DB を叩く必要が無く（支払い画面とチェック一覧はサーバーレンダリングで足りる）、RLS ポリシーの設計ミスによる情報漏えいリスクを構造的に消せるためである。金額・支払状態を参加者側から書き換えられないという引継ぎ書の要件（§7）を満たす最短経路でもある。第三者認証JWTの発行を最初のマイルストーンから外せる分、初期の実装量も小さい。

なお Supabase の「Third-party auth」（外部JWT発行者をそのまま受け入れる仕組み）は LINE に使えない。
- 一次資料：https://supabase.com/docs/guides/auth/third-party/overview
- 引用：対応は Clerk / Firebase Auth / Auth0 / AWS Cognito / WorkOS の5つのみ。
  > "The third-party provider must use asymmetrically signed JWTs (exposed as an OIDC Issuer Discovery URL by the third-party authentication provider)."

---

### 問2. Next.js/Vercel での Webhook 受信・タイムアウト・リージョン・Cron、および Cloudflare 案との比較

#### 2-A. raw body の取得（Next.js App Router）

- 一次資料：https://nextjs.org/docs/app/api-reference/file-conventions/route （version 16.3.6、lastUpdated 2026-04-30）
- 引用（Webhooks の節、原文コード）：
  ```ts
  export async function POST(request: Request) {
    try {
      const text = await request.text()
      // Process the webhook payload
    } catch (error) {
      return new Response(`Webhook error: ${error.message}`, { status: 400 })
    }
    return new Response('Success!', { status: 200 })
  }
  ```
  > "Notably, unlike API Routes with the Pages Router, you do not need to use `bodyParser` to use any additional configuration."

つまり App Router では `await request.text()` が生の本文そのものであり、Pages Router 時代の `export const config = { api: { bodyParser: false } }` は不要。**JSON にパースしてから再文字列化すると署名検証が壊れる**ことは Stripe も明記している。
- 一次資料：https://docs.stripe.com/webhooks
- 引用：
  > "Stripe で署名の検証を実行するには、未加工のリクエスト本文が必要です。フレームワークを使用している場合は、元の本文に手が加えられないようにする必要があります。未加工のリクエスト本文に何らかの変更が行われた場合、検証は失敗します。"

#### 2-B. 署名検証とリプレイ対策

- 一次資料：https://docs.stripe.com/webhooks
- 引用：
  > "認証を行わないと、攻撃者が偽の webhook イベントをエンドポイントに送信して、注文の処理、アカウントアクセスの許可、レコードの変更などを不正に実行される可能性があります。"
  > "次の両方の保護を使用します。— **IP の許可リスト** ... **署名の確認**"
  > "タイミング攻撃から保護するには、一定時間の文字列比較を使用して、想定される署名を受信した各署名と比較します。"
  > "Stripe のライブラリには、タイムスタンプと現在時刻の間に 5 分のデフォルトの許容範囲があります。"「許容値 `0` は使用しないでください。」
  > "ダウングレード攻撃を防ぐには、`v1` 以外のスキームをすべて無視します。"
  > "Webhook ルートを CSRF 保護から除外する"

#### 2-C. Vercel の関数タイムアウト

- 一次資料：https://vercel.com/docs/functions/limitations （last_updated: 2026-08-24）
- 引用（Fluid compute 有効時の Node.js / Bun / Python）：

  |            | Default | Maximum | Extended maximum |
  |---|---|---|---|
  | Hobby | 300s (5 minutes) | 300s (5 minutes) | - |
  | Pro | 300s (5 minutes) | 800s | 1800s (30 minutes) Beta |
  | Enterprise | 300s (5 minutes) | 800s | 1800s (30 minutes) Beta |

  > "Maximum memory | Hobby: 2 GB, Pro and Ent: 4 GB"
  > "The maximum payload size for the request body or the response body of a Vercel Function is **4.5 MB**."
  > "Regions | Runs in a single region by default (`iad1`), which you can change. Pro and Enterprise teams can set multiple regions"

Webhook ハンドラは 2xx を即返す設計にするのでタイムアウトは実質問題にならない。300秒あれば reconciliation バッチも収まる。

#### 2-D. リージョン（東京 hnd1）

- 一次資料：https://vercel.com/docs/regions （last_updated: 2026-08-11）
- 引用（Region list より該当行）：
  > `hnd1 | ap-northeast-1 | Tokyo, Japan`
  > `kix1 | ap-northeast-3 | Osaka, Japan`
- 一次資料：https://vercel.com/docs/functions/configuring-functions/region （last_updated: 2026-08-11）
- 引用：
  > "By default, Vercel Functions execute in *Washington, D.C., USA* (`iad1`) **for all new projects**"
  > ```json
  > { "$schema": "https://openapi.vercel.sh/vercel.json", "regions": ["sfo1"] }
  > ```
  > 「Limits」表：Hobby = Single region / Pro = 5 regions / Enterprise = All regions
  > "If your functions communicate with external services, choosing regions far from those services increases latency. Select only regions close to your external services."

→ `vercel.json` に `"regions": ["hnd1"]` を明記すること。Hobby でも単一リージョン指定は可能。Supabase プロジェクトも Tokyo (ap-northeast-1) で作れば、関数↔DB が同一AZ圏に収まる。

#### 2-E. Vercel Cron の制約（reconciliation ジョブの設計に直結）

- 一次資料：https://vercel.com/docs/cron-jobs/usage-and-pricing （last_updated: 2026-07-15）
- 引用：

  |  | Number of cron jobs per project | Minimum interval | Scheduling precision |
  |---|---|---|---|
  | Hobby | 100 cron jobs | Once per day | Per-hour (±59 min) |
  | Pro | 100 cron jobs | Once per minute | Per-minute |
  | Enterprise | 100 cron jobs | Once per minute | Per-minute |

  > "Hobby accounts are limited to cron jobs that run **once per day**. Cron expressions that would run more frequently will fail during deployment."
  > "a cron job configured as `0 1 * * *` (every day at 1 am) will trigger anywhere between 1:00 am and 1:59 am."

- 一次資料：https://vercel.com/docs/cron-jobs/manage-cron-jobs （last_updated: 2026-08-11）
- 引用：
  > "Vercel will not retry an invocation if a cron job fails."
  > "Cron job delivery is best effort. Most invocations run as scheduled, but occasional transient network errors can prevent a request from reaching your function."
  > "Cron delivery can also occasionally invoke the same scheduled run more than once. Because of this, cron jobs should be resilient to both missed runs and duplicate runs."
  > "Design your operations to be **idempotent** and reconciliation-based so each run can safely reprocess outstanding work since the last successful run. For example: **Good**: 'Set user status to active' (running twice has the same effect) / **Bad**: 'Increment user credit by 10' (running twice doubles the credit)"
  > "If your cron job runs longer than the interval between invocations, Vercel can trigger a second instance while the first is still running. This can lead to race conditions, duplicate processing, or data corruption."
  > CRON_SECRET による保護（原文コード）：
  ```ts
  export function GET(request: NextRequest) {
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    return Response.json({ success: true });
  }
  ```
  > "There is currently no support for `vercel dev`, `next dev`, or other framework-native local development servers."（cron のローカル実行は手動で URL を叩く）

**この案件への含意**：Hobby プランでは reconciliation が1日1回・±59分の精度でしか回せない。会費集金という性質上「支払ったのに数時間チェックが付かない」は致命的ではないが、Webhook 欠損時の救済が1日1回になる。**Pro（分単位）への課金を前提にするか、Webhook 到達を主・ポーリングを従とする画面側の即時照会（支払い完了リダイレクト時に1回だけ同期照会する）で補う**設計が必要。

#### 2-F. Cloudflare Workers + Hono + D1/Neon の同等事項

- 一次資料：https://developers.cloudflare.com/workers/platform/limits/
- 引用：
  > CPU time per HTTP request — Free: "10 ms" / Paid: "5 min (default: 30 seconds)"
  > "There is no hard limit on duration for HTTP-triggered Workers."
  > Subrequests — Free: "50/request" / Paid: "10,000 (up to 10M)"
  > Cron Triggers CPU — Free: "10 ms" / Paid: "30 seconds (< 1 hour interval)" or "15 min (>= 1 hour interval)"、wall time "15 minutes"
- 一次資料：https://developers.cloudflare.com/workers/configuration/cron-triggers/
- 引用：
  > "Cron Triggers should be exclusively managed through the Wrangler configuration file."
  > "Cron Triggers execute on UTC time."
  > ※ at-least-once / 取りこぼしに関する明示的な記述は当該ページに**無い**（Vercel と異なり保証の明文化がない）。
- 一次資料：https://hono.dev/docs/getting-started/cloudflare-workers
- 引用：
  > `npm create hono@latest my-app`（`cloudflare-workers` テンプレートを選択）
  > "You can access them in `c.env`. It will have the types if you pass the '_type definition_' for the bindings to the `Hono` as generics."
  > ```ts
  > type Bindings = { MY_BUCKET: R2Bucket; USERNAME: string }
  > const app = new Hono<{ Bindings: Bindings }>()
  > ```
  ※ `c.req.text()` / `c.req.raw` による raw body 取得の記述は当該ページには**無い**（未確認事項に回す）。

#### 2-G. 推奨（1つだけ）

**Next.js (App Router) + Vercel (`regions: ["hnd1"]`) + Supabase (Tokyo) を採用する。**

根拠：
1. Webhook の raw body 取得が Next.js 公式に `request.text()` として明記され、追加設定が不要（2-A）。Workers 側は Hono 公式ドキュメントに同等の明記が見つからず、確認コストが残る（2-F）。
2. ローカル環境に Vercel CLI 50.17.0 と Supabase CLI 2.58.5 が既に入っており、wrangler は未インストール（local-context.md 実測）。着手速度が違う。
3. Cloudflare の無料枠 CPU 10ms は JWT 署名・HMAC 検証・Postgres クエリを1リクエストに詰めると現実的に厳しく、有料化（$5/月）が事実上前提になる。Vercel Hobby は 300秒／2GB で最初の検証には十分。
4. Supabase(Postgres) を Workers から使うには Hyperdrive 等の追加部品が要り、構成要素が1つ増える。Vercel の Node ランタイムなら `supabase-js` をそのまま使える。

**Workers を選ぶべき唯一の条件**：Vercel Pro に課金せず、かつ reconciliation を分単位で回したい場合。Vercel Hobby の cron は1日1回・±59分（2-E）である一方、Workers の Cron Triggers にはプラン別の最小間隔制限が当該ドキュメントに記載されていない（3分間隔の例が提示されている）。ただしこの1点のために構成を丸ごと変える価値は無いと判断する。

---

### 問3. Webhook 冪等性の実装パターン

#### 3-A. Stripe が公式に述べている前提（設計の出発点）

- 一次資料：https://docs.stripe.com/webhooks
- 引用：
  > **順序**："Stripe は、イベントが生成された順序で配信されることを保証しません。"
  > "イベントの宛先が、特定の順序でのイベントの受信に依存しないようにしてください。スナップショットイベントは `created` を秒単位で記録するため、異なるイベントが同じタイムスタンプを共有することがあります。**イベントの順序や、イベントをすでに処理したかどうかを判断するために `created` を使用しないでください。代わりにイベント ID を追跡して、重複した配信を特定します。**"
  > "API を使用して、不足しているオブジェクトを取得することもできます。たとえば、このイベントを最初に受信した場合、`invoice.paid` の情報を使用して、invoice、charge、subscription オブジェクトを取得できます。"
  > **重複**："Webhook エンドポイントは、同じイベントを複数回受信する可能性があります。処理したイベント ID をログに記録し、すでにログに記録したイベントを処理しないようにすることで、重複するイベントの受信に対処することができます。"
  > "場合によっては、2 つの Event オブジェクトが個別に生成・送信されます。これらの重複を識別するには、`data.object` のオブジェクト ID と `event.type` を使用します。"
  > **再試行**："本番環境では、Stripe は指数バックオフを使用して最長 3 日間、送信先へのイベントの配信を試行します。Stripe はサンドボックスで作成されたイベントの配信を数時間のうちに 3 回再試行します。"
  > "以前に配信に失敗したイベントを Webhook エンドポイントに手動で再送信した場合、その結果のステータスコードが `2xx` になったとしても、Stripe の自動再試行動作は解除されません。"
  > **タイムアウト**："(タイムアウト) ERR | 宛先サーバーで Webhook リクエストに応答するのに時間がかかりすぎました。| Webhook 処理コードで複雑なロジックを延期して、成功を示すレスポンスを即時に返すようにしてください。"
  > **2xx 即返し**："エンドポイントは、タイムアウトを引き起こす可能性のある複雑なロジックが実行される前に、成功のステータスコード (`2xx`) を素早く返す必要があります。"
  > **非同期処理**："非同期キューで受信したイベントを処理するようにハンドラを設定します。... Webhook の配信が急増すると ... エンドポイントホストが対処不可能になる場合があります。"
  > **購読するイベントを絞る**："Webhook エンドポイントは、お客様の実装で必要なイベントのタイプのみを受信するように設定します。"
  > **シークレットのローテーション**："Stripe は、有効期限までシークレットキーごとに 1 つの署名を生成します。"（旧シークレットを最大24時間併存させられる＝検証側は複数シークレットで試行する実装にしておく）

#### 3-B. Vercel Cron が公式に述べている冪等性の指針

- 一次資料：https://vercel.com/docs/cron-jobs/manage-cron-jobs
- 引用：
  > "Use unique IDs to track which events you've already processed"
  > "Check state before making changes (e.g., 'if not already active, then activate')"
  > "Store results with timestamps or version numbers"
  > "Query and process all work since the last successful run to catch up after a missed invocation"
  > "Use both locks (to prevent concurrent runs) and idempotent reconciliation (to handle duplicate or missed runs safely) for the most reliable cron jobs."

#### 3-C. これらから導かれる Postgres 実装（本案件の設計案）

以下は上記一次資料の要件を Postgres に落としたもので、**実装案であり一次資料の引用ではない**。

1. **受信ログテーブル（イベントIDのユニーク制約）**
   ```sql
   create table webhook_events (
     provider     text not null,              -- 'stripe' | 'paypay' | ...
     event_id     text not null,              -- Stripe: evt_xxx / PayPay: 通知の一意キー
     event_type   text not null,
     payload      jsonb not null,
     received_at  timestamptz not null default now(),
     processed_at timestamptz,
     primary key (provider, event_id)
   );
   ```
   受信直後に `insert ... on conflict (provider, event_id) do nothing returning event_id` を実行し、**返り行が無ければ既処理として即 200 を返す**。これが「重複したイベント」対策の第一段。Stripe の「イベントIDを追跡せよ」という指示に直接対応する。

2. **請求（charge_request）を一意キーで事業者IDに結び付ける**
   - PayPay：`merchantPaymentId` をこちらで採番し、`charge_requests.provider_ref` に UNIQUE 制約で保存する。PayPay 公式は「merchantPaymentId は加盟店側で一意に管理せよ」と要求している（問4-B 参照）。
   - Stripe：`payment_intent.id` または Checkout Session の `client_reference_id` に自前の請求IDを載せる。
   - **イベント名やイベントの表示金額だけで参加者を特定してはならない**（引継ぎ書 §7）。必ず provider_ref → 請求 → 参加者の経路でたどる。

3. **状態遷移は「単調な上書き」にする（順序入れ替わり対策）**
   支払状態を `unpaid → pending → paid → refunded` の順序付き enum とし、更新は
   ```sql
   update charge_requests
      set status = $new, status_rank = $new_rank, paid_at = coalesce(paid_at, $ts)
    where id = $id and status_rank < $new_rank;
   ```
   のように**ランクが前進する時だけ更新**する。これで `payment_intent.succeeded` より先に `charge.refunded` が着いても、後から届いた古いイベントが新しい状態を巻き戻さない。「Set user status to active」型（Vercel の Good 例）に一致する。

4. **トランザクション境界**
   「受信ログの insert」と「請求の状態更新」と「支払い記録の追加」を**単一トランザクション**に入れる。ただし Stripe の「2xx を素早く返す」指示があるため、重い後続処理（LINE 通知の送信など）はトランザクション外・レスポンス後に回すか、`outbox` テーブルに積んで cron で流す。

5. **同一請求への同時処理を直列化**
   同じ `charge_request` に複数イベントが同時着弾しうるので、更新の直前に `select ... for update` で行ロックを取る（アプリ全体のグローバルロックではなく行ロックで足りる）。cron 側の多重起動防止には `pg_try_advisory_lock(<job_id>)` を使い、取れなければ即終了する（Vercel の「locks を使え」に対応）。

6. **reconciliation（再照会）ジョブ**
   - 対象：`status in ('pending')` かつ `created_at < now() - interval '5 minutes'` の請求。
   - 処理：事業者の照会APIを叩く（Stripe: `PaymentIntent` retrieve / PayPay: `GET /v2/codes/payments/{merchantPaymentId}`）。返ってきた状態を 3 の単調更新に流す。
   - Vercel の「missed runs に備えて前回成功以降の未処理をすべて処理せよ」に従い、**時刻カーソルではなく状態（pending であること）を条件に走査する**。これなら1回飛んでも次回で必ず拾える。
   - Stripe は最長3日リトライするので、reconciliation の保持期間は**最低4日**（3日＋余裕）取る。

7. **金額・通貨・宛先の再検証**
   Webhook の `amount` / `currency` / （Connect を使う場合は）受取先アカウントが、自前の請求レコードと一致することを更新前に必ず突き合わせる。一致しなければ処理せず `webhook_events.processed_at` を NULL のままにしてアラートを上げる。

---

### 問4. ローカル／ステージングでの決済テスト手段

#### 4-A. Stripe CLI

- 一次資料：https://docs.stripe.com/webhooks
- 引用：
  > "stripe listen を実行し、ローカルホストがシミュレートされたイベントを受信できるようにします。"
  > ```bash
  > stripe listen --forward-to localhost:4242/webhook
  > ```
  > "`stripe listen` コマンドは `{{WEBHOOK_SIGNING_SECRET}}` を出力します。この値をコピーして、ハンドラーを作成する際に使用します。"
  > ```output
  > Ready! Your webhook signing secret is '{{WEBHOOK_SIGNING_SECRET}}' (^C to quit)
  > ```
  > ```bash
  > stripe trigger payment_intent.succeeded
  > ```
  > Connect 用：`stripe listen --forward-connect-to localhost:4242/webhook`
  > 再送：`stripe events resend <event_id> --webhook-endpoint=<endpoint_id>`（イベント作成後最大30日）
  > "`--forward-to` 引数を `stripe listen` で使用するには、ターミナルで Stripe CLI を使用してコマンドを実行する必要があります。ワークベンチのシェルは `--forward-to` 引数をサポートしていません。"
  > "ローカルホストサーバーがあるものの、一般公開されているアクセス可能な HTTPS URL がない場合は、ngrok などのトンネリングツールを使用することで、テスト用の一般公開されるアクセス可能な HTTPS URL を一時的に生成できます。"
- 一次資料：https://docs.stripe.com/stripe-cli
- 引用：
  > "**クイックスタート**: `npm install -g @stripe/cli` で Stripe CLI をインストールし、`stripe agent setup` を実行します。"
  > "[サンドボックスを作成](https://docs.stripe.com/cli/sandbox): アカウントを設定せずに Stripe での構築を開始します。"

**含意**：`stripe trigger` で重複配信・失敗再送を再現でき、冪等性テストが CI に載せられる。ローカル環境には stripe CLI が既に存在する（local-context.md 実測）。

#### 4-B. PayPay サンドボックス

- 一次資料：https://github.com/paypay/paypayopa-sdk-node/blob/master/README.md
- 引用：
  > "Use sandbox mode (this is the default). Specify your sandbox API key and sandbox API secret, and `\"STAGING\"` as the environment name."
  > ```javascript
  > PAYPAY.Configure({ env: "STAGING", clientId: API_KEY, clientSecret: API_SECRET });
  > ```
  > `QRCodeCreate()` の `merchantPaymentId`："The unique payment transaction id provided by merchant"（64文字以下）、`codeType` は `"ORDER_QR"`
  > 状態照会：`GetCodePaymentDetails()`（QRコード決済用、`body.data.status` を返す）と `GetPaymentDetails()`（ネイティブ決済用）。返る状態値は "COMPLETED" や "AUTHORIZED" など。
  > 返金：`PaymentRefund()`（`merchantRefundId`, `paymentId`, 金額）。"Currently we only support 1 refund per order."
  > ※ Webhook の実装については当該 README に明示的な記載が**無い**。

- 一次資料：https://www.paypay.ne.jp/opa/doc/jp/v1.0/dynamicqrcode
- 引用：
  > merchantPaymentId：「unique per transaction on the merchant side」、使用可能文字 "a-z, A-Z, 0-9, -, _"、64文字上限
  > 状態照会エンドポイント：`/v2/codes/payments/{merchantPaymentId}`
  > "polling intervals of approximately 2-3 seconds"
  > 環境別エンドポイント：Sandbox `https://apigw.sandbox.paypay.ne.jp/v2/codes` / Staging `https://apigw.stg.paypay.ne.jp/v2/codes` / Production `https://apigw.paypay.ne.jp/v2/codes`
  > "the merchant can poll the payment status API or use webhook notifications to process orders"（webhook と polling は独立に使える）

- 一次資料：https://www.paypay.ne.jp/opa/doc/jp/v1.0/webcashier
- 引用：
  > "PayPayからのリダイレクトがない場合に、Get Payment Detailsを用いて決済結果を確認する様、お願いいたします"
  > "ポーリング間隔は、2〜3秒程度として下さい"

**含意**：PayPay は「リダイレクトが返らない可能性」を公式に前提としている。したがって**支払い完了画面のリダイレクトを支払い確定の根拠にしてはならず**、必ず照会API か Webhook の結果で確定させる。これは引継ぎ書 §7 の「決済事業者の確認後に反映」と完全に一致する。

#### 4-C. LIFF のローカル開発

- 一次資料：https://developers.line.biz/en/docs/liff/liff-cli/
- 引用：
  > コマンド：`init`, `serve`, `app create`, `app update`, `app list`, `app delete`, `scaffold`, `channel add`, `channel use`
  > "launches a local developement server with HTTPS"
  > "rewrites the endpoint URL of your LIFF app with the URL of the local proxy server"
  > "specify the `--inspect` option to the `serve` command" → "launches the LIFF Inspector's LIFF Inspector Server with HTTPS"
- 一次資料：https://developers.line.biz/en/docs/liff/liff-plugin/
- 引用：
  > LIFF Inspector = "a LIFF plugin to debug your LIFF app"（別PCの Chrome DevTools からデバッグ可能）
  > LIFF Mock = "a LIFF plugin to make testing your LIFF app easy." / "your LIFF app is independent of the LIFF server and the LIFF API returns mock data"
- 一次資料：https://developers.line.biz/en/docs/liff/development-guidelines/
- 引用：
  > "The URL scheme of the LIFF app and any content that is opened in the LIFF app must be **https**."
  > "During your application's test phase, limit access privileges for the LIFF app through your web app."

→ **LIFF CLI の `serve` が HTTPS ローカルサーバーとプロキシを提供するので、ngrok / Cloudflare Tunnel は必須ではない**。ただし Stripe/PayPay の Webhook を受けるには別途の公開HTTPS URL が要るので、そちらは `stripe listen --forward-to` かトンネル、またはプレビューデプロイを使う。

- LIFF API の前提。一次資料：https://developers.line.biz/en/reference/liff/
- 引用：
  > `liff.getIDToken()` — "Get the ID token of the current user obtained by the LIFF SDK. An ID token is a JSON Web Token (JWT) that contains user data. **The ID token is valid for one hour after it is issued.**"
  > "When adding a LIFF app to your channel, select the `openid` scope. You can't get the ID tokens if you don't select the scope, or the users don't grant permission."
  > `liff.getAccessToken()` — "An access token is valid for 12 hours after it is issued. However, even within this validity period, the access token may be revoked due to user actions."
  > `liff.getProfile()` — `profile` スコープが必要

**含意**：ID トークンの有効期限は1時間。自前発行する Supabase 互換 JWT の寿命はこれに縛られないが、**再ログイン導線（`liff.login()` / トークン再取得）を必ず用意する**こと。LIFF チャネルには `openid` と `profile` の両スコープを設定する。

#### 4-D. 各環境の分離方針（実装案）

| 環境 | フロント | DB | 決済 | Webhook 受口 |
|---|---|---|---|---|
| ローカル | `liff-cli serve --inspect` + `next dev` | `supabase start` | Stripe CLI (`listen`/`trigger`) / PayPay STAGING | `stripe listen --forward-to localhost:3000/api/webhooks/stripe` |
| プレビュー | Vercel Preview Deployment | Supabase ブランチまたは別プロジェクト | Stripe サンドボックス / PayPay サンドボックス | Vercel の preview URL を Webhook に登録 |
| 本番 | Vercel Production (`hnd1`) | Supabase Tokyo | 本番キー | 本番 URL |

LIFF アプリは環境ごとに別の LIFF ID（別チャネル）を切ること。`liff-cli serve` はエンドポイントURLを書き換えるので、本番用 LIFF ID に対して実行しないよう運用ルールで縛る。

---

### 問5. E2E／統合テストの現実的な構成

#### 5-A. Supabase ローカル

- 一次資料：https://supabase.com/docs/guides/local-development
- 引用：
  > "begin developing your application using local Supabase services. This includes access to a **local Postgres database, Auth, Storage, and other Supabase features.**"
  > "Safe experimentation: You can experiment with different configurations and features without affecting your production environment."
  > CLI は "both local development and CI/CD pipelines" で使える

#### 5-B. LIFF のモック

- 一次資料：https://github.com/line/liff-mock
- 引用：
  > "LIFF Mock is a LIFF Plugin that make testing your LIFF app easy."
  > インストール：`$ npm install @line/liff-mock`
  > ```js
  > import { LiffMockPlugin } from '@line/liff-mock'
  > liff.use(new LiffMockPlugin())
  > liff.init({ liffId: 'liff-xxxx', mock: true })
  > ```
  > `liff.$mock.set` — "Accepts either an object or function to update mock data." 例：`liff.$mock.set((p) => ({ ...p, getProfile: { displayName: 'Cony' } }))`
  > `liff.$mock.clear` — "Restores default mock data"

**重要な設計判断**：`vi.mock('@line/liff')` のようなビルド時モックは Playwright の実ブラウザでは効かない。**実ブラウザ E2E では `@line/liff-mock` を使い、`mock: true` を環境変数（例 `NEXT_PUBLIC_LIFF_MOCK=1`）で切り替える**。LIFF 初期化を単一モジュール（例 `lib/liff.ts`）に集約し、モック版は動的 import にして本番バンドルに含めないこと。

#### 5-C. 推奨テスト構成（実装案）

| 層 | ツール | 何を検証するか |
|---|---|---|
| 単体 | Vitest | 金額計算、状態遷移ランク、署名検証ユーティリティ、PaymentProvider アダプタの `parseWebhook` |
| 契約（Webhook） | Vitest + 保存済みペイロード fixture | 同一イベントID の二重投入で1件しか反映されない／順序逆転で巻き戻らない／署名不一致で 400 |
| 統合（DB込み） | Vitest + `supabase start` の Postgres | トランザクション境界、`on conflict do nothing`、RLS ポリシー（RLS を採る場合） |
| E2E | Playwright + `@line/liff-mock` | 幹事のイベント作成→参加者の支払い導線→Webhook 注入→一覧に✅が付く |
| 決済実機 | Stripe CLI `trigger` / PayPay サンドボックスアプリ | 実イベントでのエンドツーエンド |

テストDB分離は `supabase start` のローカルインスタンスを使い、各テストファイルの前後で `truncate` するか、テストごとにトランザクションを張って rollback する。本番・プレビューの Supabase プロジェクトをテストに使わない（Supabase 公式が "without affecting your production environment" を local の利点として挙げている通り）。

---

### 問6. PaymentProvider アダプタ設計の要点

引継ぎ書 §6 の「決済事業者の変更で名簿や画面まで作り直さなくて済む構成」に対応する。以下は設計案であり一次資料の引用ではないが、各要点は上で引用した事業者仕様に根拠を持つ。

```ts
export type ProviderId = 'stripe' | 'paypay';

export type CreateCheckoutInput = {
  chargeRequestId: string;   // 自アプリの請求ID（冪等キーの源）
  amount: number;            // 最小単位（JPY は円）
  currency: 'JPY';
  description: string;
  returnUrl: string;         // LINE MINI App のページへ戻すURL（必須・問7参照）
  idempotencyKey: string;    // 再試行しても二重に決済を作らない
};

export type CreateCheckoutResult = {
  providerRef: string;       // Stripe: pi_xxx / PayPay: merchantPaymentId
  redirectUrl: string;       // 参加者を飛ばす先
  expiresAt?: Date;
};

export type PaymentStatus =
  | 'unpaid' | 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';

export type ParsedWebhook = {
  ok: boolean;               // 署名検証の結果
  eventId: string;           // 重複排除キー（provider と複合で一意）
  eventType: string;
  providerRef: string | null;
  status: PaymentStatus | null;
  amount: number | null;
  currency: string | null;
  occurredAt: Date | null;
  raw: unknown;
};

export interface PaymentProvider {
  readonly id: ProviderId;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  parseWebhook(rawBody: string, headers: Headers): Promise<ParsedWebhook>;
  getPaymentStatus(providerRef: string): Promise<{
    status: PaymentStatus; amount: number; currency: string;
  }>;
  refund(providerRef: string, opts: {
    amount?: number; refundId: string;
  }): Promise<{ status: 'succeeded' | 'pending' | 'failed' }>;
}
```

設計上の要点と、その根拠となった一次資料：

1. **`parseWebhook` は raw 文字列と Headers を受け取り、パース済みオブジェクトを受け取らない。** Stripe が「未加工のリクエスト本文に何らかの変更が行われた場合、検証は失敗します」と明記しているため（https://docs.stripe.com/webhooks）。アダプタの外で JSON.parse してはならない。

2. **`parseWebhook` は必ず `eventId` を返す。** Stripe は「イベントIDを追跡して重複した配信を特定せよ」と指示している（同上）。PayPay 側で単一のイベントIDが取れない場合は、アダプタ内部で `${notificationType}:${merchantPaymentId}:${state}:${occurredAt}` のような合成キーを作って返す（合成キーの一意性は本アプリの責任）。

3. **`status` は provider 固有の文字列をそのまま返さず、共通 enum に正規化する。** PayPay の "COMPLETED" / "AUTHORIZED"（paypayopa-sdk-node README）と Stripe の `payment_intent.succeeded` を、上位が知らずに済むようにする。単調な状態ランク（問3-C-3）はこの共通 enum の上で定義する。

4. **`getPaymentStatus` は reconciliation とリダイレクト直後の即時確認の両方で使う。** PayPay 公式が「PayPayからのリダイレクトがない場合に、Get Payment Details を用いて決済結果を確認する様、お願いいたします」と述べているため（https://www.paypay.ne.jp/opa/doc/jp/v1.0/webcashier）。

5. **`createCheckout` に `idempotencyKey` を必須で持たせる。** ネットワーク再送で同じ請求に対して2件の決済が作られることを防ぐ。PayPay では `merchantPaymentId` がそのまま冪等キーになる（64文字・`a-zA-Z0-9-_`、https://www.paypay.ne.jp/opa/doc/jp/v1.0/dynamicqrcode）。

6. **`refund` は部分返金の可否を実装差として吸収する。** PayPay の Node SDK は "Currently we only support 1 refund per order." と明記しており、1注文1回の制約がある（https://github.com/paypay/paypayopa-sdk-node/blob/master/README.md）。Stripe の PayPay は「全額返金と一部返金に対応」「返金期間は購入後最大365日」（https://docs.stripe.com/payments/paypay）。この差はアダプタが `NotSupportedError` を投げて上位に伝える。

7. **`returnUrl` を必須にする。** LINE MINI App は「外部ドメインやアプリでの取引完了後に LINE MINI App のページへユーザーをリダイレクトする設計にしなければならない」と定めている（https://developers.line.biz/en/docs/line-mini-app/develop/payment/）。この制約はプロバイダーに依存せずアプリ全体にかかるので、インターフェースの必須項目にして忘れられないようにする。

8. **アダプタは受取先（destination）を隠さない。** Connect のようにプラットフォーム経由で他アカウントへ資金を流す構成を採る場合、`createCheckout` に受取先を明示的に渡し、`parseWebhook` の結果と突き合わせる。引継ぎ書 §7 の「対象請求・受取先・金額・通貨・成功状態を確認」に対応。ただし PayPay の Connect 利用可否は未解決（下記 問7）。

---

### 問7. 決済事業者と配布形態の制約（[S1]〜[S9] 再確認の結果）

#### 7-A. [S1] Stripe 禁止業種：ピアツーピア送金は禁止（再確認済み・現在も有効）

- 一次資料：https://stripe.com/legal/restricted-businesses （**Page Last Updated: 2026-09-22**）
- 引用：
  > 禁止業種（金融商品・サービス）："ピアツーピアの送金"
  > 制限付き（サードパーティーエージェントサービス）："決済ファシリテーションおよびアグリゲーション (自社で提供しなかった商品やサービスの決済売上金を 1 社または複数のサードパーティーの売り手の代理として受け取る行為も含む)"
  > 制限付き："クラウドファンディングプラットフォーム"

→ 引継ぎ書 §4-2 の指摘は正しい。**「幹事が友人から立替金を回収する」という実態のまま Stripe を使う構成は、禁止業種と制限業種の両方に触れる。** 加えて「決済ファシリテーションおよびアグリゲーション」の記載は、プラットフォームが第三者の売り手の代わりに売上を受け取る構成（＝Connect の典型的な使い方）が制限対象に含まれることを示しており、「Connect を使えば法的検討が不要」という過去の説明は成り立たない。

#### 7-B. [S2][S3] Stripe の PayPay × Connect：公式資料の矛盾は未解消

- 一次資料A：https://docs.stripe.com/payments/paypay
- 引用：
  > "**Connect のサポート** — いいえ"
  > "継続課金 — No" / "手動キャプチャーのサポート — いいえ" / "不審請求の申し立てのサポート — いいえ"
  > "最小請求額は 50 JPY です。最大請求額は 1,000,000 JPY です。"
  > "返金期間は、購入後最大 365 日です。PayPay の決済の返金は即時に完了します。"
  > "暗号資産取引所とウォレット" は PayPay で禁止

- 一次資料B：https://docs.stripe.com/payments/payment-methods/payment-method-support
- 引用（「ウォレットサポート対象のプロダクト」表の PayPay 行）：
  > `[PayPay] | Connect: ✓ サポート対象 8 | Checkout: ✓ サポート対象 1,2,3 | Payment Links: ✓ サポート対象 | Payment Element: ✓ サポート対象 | Express Checkout Element: - サポート対象外 | Mobile Payment Element: ✓ サポート対象 | サブスクリプション: - サポート対象外`
  > 脚注8："Connect を使用するには、[招待をリクエスト](https://support.stripe.com/contact/email?topic=payment_apis)してください。"
- 引用（Wallets API サポート表の PayPay 行）：
  > `[PayPay] | paypay | PaymentIntents: ✓ サポート対象 | SetupIntents: - サポート対象外 | 手動キャプチャー: - サポート対象外 | 今後の使用のための設定: - サポート対象外 | リダイレクトの要求: あり`

→ **2026-09-24 時点でも、概要ページ（Connect いいえ）と決済手段サポート表（Connect ✓＋招待制）は食い違ったままである。** 引継ぎ書 §4-3 の指摘は今も有効。どちらが正なのかを Stripe に直接確認するまで、「Stripe Connect で PayPay を使い、幹事を受取人にできる」を実装前提にしてはならない。なお「リダイレクトの要求：あり」は、LINE MINI App の「取引完了後にミニアプリへ戻す」要件（7-C）と組み合わせて設計する必要があることを意味する。

#### 7-C. LINE MINI App の決済制約（新規発見・decision critical）

- 一次資料：https://developers.line.biz/en/docs/line-mini-app/develop/payment/
- 引用：
  > **Japan**: In-app purchase only（LINE Pay は 2025年4月30日に終了）
  > Taiwan & Thailand: LINE Pay available
  > "To offer other payment methods other than those mentioned above in your LINE MINI App, implement them as you would on ordinary web pages."
  > "You must design the process so that users are redirected to your LINE MINI App page after completing a transaction on an external domain or app."

- 一次資料：https://developers.line.biz/en/docs/line-mini-app/discover/introduction/
- 引用：
  > "LINE MINI App is a web application that runs on LINE. LINE MINI App enables users to enjoy services without installing a separate native app."
  > 未認証（Unverified）：作成直後から使えるが機能制限あり。ヘッダーにアプリ名とエンドポイントのドメイン名が表示される。
  > 認証済み（Verified）：審査通過でバッジ付与。ホーム画面ショートカット、カスタムパス、チャネル同意の簡略化などが解放される。
  > 配布経路（ホームタブ、LINE検索、LINE公式アカウント）は認証済みアプリのみ。

→ **配布（decision critical）**：未認証ミニアプリは即座に作れるが、LINE 内での発見経路（検索・ホームタブ）は使えず、ヘッダーにドメインが露出する。会費集金は「幹事が URL を配る」使い方なので、**未認証のままでも中心要件は満たせる**。ただし「LINE MINI App Policy の下で許可された顧客に開発が開かれている」との記述があり、**誰でも無条件に公開できるとは限らない**点は要確認（未確認事項へ）。

→ **決済（decision critical）**：日本では LINE が提供する決済手段は in-app purchase のみ。**PayPay や Stripe は「通常のWebページと同じ」外部決済として実装し、完了後にミニアプリへ戻す**。この「戻す」導線が切れると自動チェックの体験が破綻するため、PaymentProvider の `returnUrl` は必須（問6-7）。かつ PayPay 公式が「リダイレクトが返らない場合がある」と明言しているので、**戻り先ページでは必ず `getPaymentStatus` を1回叩いて状態を確定させる**こと。

---

## 未確認事項

1. **Supabase の Custom OIDC Provider に LINE を登録して、実際に LINE Login が成立するか。** ディスカバリ文書の存在（ES256、S256）と Supabase の「任意の OIDC 準拠 IdP」という記述からは成立が見込めるが、LINE の `aud`／`nonce` の扱いや、Supabase が要求するメール取得（`email_optional` 設定）との相性は実機で試すまで確定しない。実際に登録した公式事例は見つけられなかった。
2. **`signInWithIdToken` が custom provider に対応するか。** 公式ドキュメント（https://supabase.com/docs/guides/auth/custom-oauth-providers）とブログ（https://supabase.com/blog/custom-oauth-oidc-providers）のどちらも `signInWithOAuth` しか示しておらず、対応する／しないの明示的な記述を一次資料で確認できなかった。「非対応」と断定できる一次資料も無い。
3. **Supabase に LINE がビルトイン追加されたか。** PR（supabase/supabase#46920）の存在は検索結果で見たが、そのページ自体を取得しておらず、マージ状態も本番反映も未確認。公式ドキュメント2本には不在。
4. **PayPay の Webhook の詳細仕様（署名検証の有無、リトライ回数、ペイロードのフィールド定義、通知先URLの登録方法）。** `https://www.paypay.ne.jp/opa/doc/jp/v1.0/webhook` は 404、`user_notification` ページはユーザーへのプッシュ通知の話で加盟店向け Webhook ではなかった。dynamicqrcode / webcashier ページから「Webhook が存在し、ポーリングと独立に使える」ことまでは確認したが、**署名検証ができるかは未確認**。署名が無い場合、Webhook を信用せず必ず `getPaymentStatus` で再照会する設計が必須になる。
5. **PayPay 加盟店審査で、個人（法人格を持たない幹事）が受取人になれるか。** 二次記事では「個人・法人とも申込可能」とあるが、一次資料を取得できていない。受取先の可否を左右する最重要論点なので、法務／規約担当の調査結果を待つ。
6. **Hono（Cloudflare Workers）での raw body 取得方法。** `c.req.text()` / `c.req.raw` の記述を公式 Getting Started ページに見つけられなかった。Workers 案を採る場合は Hono の API リファレンスで別途確認が必要。
7. **Cloudflare Cron Triggers の最小間隔とプラン差、実行保証（at-least-once か）。** 公式ページに明示がなく、3分間隔の例が示されているのみ。
8. **LINE MINI App の「LINE MINI App Policy の下で許可された顧客」の具体的条件。** 個人開発者や小規模法人が無条件で公開できるかは introduction ページの記述からは判断できない。
9. **Stripe の PayPay × Connect の真の可否。** 7-B の通り公式資料が矛盾しており、Stripe への直接問い合わせでしか解決しない。
10. **Supabase 東京リージョンの可用性・料金。** 本調査では未確認（Vercel 側の `hnd1` は確認済み）。

---

## 本アプリ設計への含意

1. **認証は「LIFF ID トークンをサーバー検証 → 自前 JWT」を第一候補にする。** Supabase の Custom OIDC 経由 LINE Login は成立しうるが、LIFF 内でリダイレクト往復を強制する点で体験が劣る。まず MVP では **RLS を使わずサーバー側で認可する**（Supabase を Postgres として使う）構成で始め、参加者に直接 DB アクセスさせる必要が出た段階で自前 JWT + RLS へ移行する。これなら初期の実装量が最小で、かつ「参加者側から金額・状態を書き換えられない」という要件を構造的に保証できる。

2. **Webhook ハンドラは3層に分ける。** (a) `request.text()` → 署名検証 → 400 か 2xx を即返す層、(b) `webhook_events` への `on conflict do nothing` で重複を弾く層、(c) 単調な状態遷移で請求を更新する層。(a) と (b) は 200 を返す前に済ませ、通知送信など重い処理は outbox に積む。Stripe の「2xx を素早く返せ」と「イベントIDで重複排除せよ」の両方を同時に満たすための構造である。

3. **リダイレクトを支払い確定の根拠にしない。** PayPay が「リダイレクトが返らない場合がある」と公式に述べており、LINE MINI App は「外部決済完了後にミニアプリへ戻せ」と要求している。戻り先ページで `getPaymentStatus` を1回叩いて確定させ、その後は Webhook と reconciliation に任せる。

4. **reconciliation は時刻カーソルではなく状態で走査する。** Vercel Cron は取りこぼしと重複の両方が起こりうると公式に明記しているため、「前回実行時刻以降」ではなく「status = pending の請求すべて」を毎回舐める。Stripe の再試行が最長3日であることから、pending の保持期間は最低4日取る。

5. **Vercel のプラン選択が reconciliation の精度を決める。** Hobby は cron が1日1回・±59分。Webhook が届かなかった支払いの救済が最大24時間遅れる。分単位の救済が要るなら Pro が前提になる。これはコスト見積もりに直接効く判断材料である。

6. **リージョンは最初から `hnd1` に固定する。** `vercel.json` に `"regions": ["hnd1"]` を書き、Supabase も Tokyo を選ぶ。デフォルトの `iad1`（バージニア）のままだと日本のユーザーに対して往復レイテンシが乗り続ける。

7. **PaymentProvider アダプタは「差し替え可能性」より先に「検証可能性」を満たす形にする。** `parseWebhook(rawBody, headers)` という署名にすることで、署名検証をアダプタの内部に閉じ込め、raw body を壊さない契約をコンパイル時に強制できる。抽象化のための抽象化ではなく、Stripe 公式の「本文を加工するな」という要求を型で守る設計である。

8. **テストは「重複・逆順・署名不一致」の3本を最初に書く。** `stripe trigger` と保存済み fixture で再現でき、これが通っていれば引継ぎ書 §7 の「重複再送で二重加算しない」「順序入れ替わり」の要件に対する証拠になる。E2E は `@line/liff-mock` を使い、`vi.mock` に頼らない（実ブラウザで効かないため）。

9. **決済事業者の選定は技術ではなく規約と審査で決まる。** 技術的には Stripe も PayPay 直接も同等に実装可能で、アダプタで吸収できる。決め手になるのは (a) Stripe の P2P 送金禁止に触れないビジネスモデルを組めるか、(b) PayPay の加盟店審査で個人幹事が受取人になれるか、(c) Stripe の PayPay × Connect の矛盾がどちらに解決するか、の3点である。**これらが解決するまで、どちらか一方に決め打ちした実装を始めてはならない。** アダプタ層を最初から入れておく理由がここにある。

10. **LINE MINI App は未認証でも中心要件を満たせる。** 幹事が URL を配る使い方なので、LINE 検索やホームタブへの露出は必須ではない。認証審査を待たずに MVP を出せる可能性が高いが、「LINE MINI App Policy の下で許可された顧客」の条件だけは着手前に確認すること。

---

## 参照URL一覧（すべて 2026-09-24 に WebFetch で実取得）

### Supabase
- https://supabase.com/docs/guides/auth/social-login
- https://supabase.com/docs/guides/self-hosting/self-hosted-oauth
- https://supabase.com/docs/guides/auth/third-party/overview
- https://supabase.com/docs/guides/auth/custom-oauth-providers
- https://supabase.com/blog/custom-oauth-oidc-providers
- https://supabase.com/docs/guides/auth/signing-keys
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/local-development
- https://supabase.com/docs/reference/javascript/auth-signinwithidtoken
- https://supabase.com/docs/reference/dart/auth-signinwithidtoken

### LINE / LIFF / LINE MINI App
- https://developers.line.biz/en/docs/line-login/verify-id-token/
- https://developers.line.biz/en/docs/line-login/integrate-line-login/
- https://developers.line.biz/en/docs/liff/using-user-profile/
- https://developers.line.biz/en/docs/liff/development-guidelines/
- https://developers.line.biz/en/docs/liff/liff-cli/
- https://developers.line.biz/en/docs/liff/liff-plugin/
- https://developers.line.biz/en/reference/liff/
- https://developers.line.biz/en/docs/line-mini-app/discover/introduction/
- https://developers.line.biz/en/docs/line-mini-app/develop/payment/
- https://access.line.me/.well-known/openid-configuration
- https://github.com/line/liff-mock

### Next.js / Vercel
- https://nextjs.org/docs/app/api-reference/file-conventions/route
- https://vercel.com/docs/functions/limitations
- https://vercel.com/docs/functions/configuring-functions/region
- https://vercel.com/docs/regions
- https://vercel.com/docs/cron-jobs/usage-and-pricing
- https://vercel.com/docs/cron-jobs/manage-cron-jobs

### Cloudflare / Hono
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://hono.dev/docs/getting-started/cloudflare-workers

### Stripe
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/stripe-cli
- https://docs.stripe.com/payments/paypay
- https://docs.stripe.com/payments/payment-methods/payment-method-support
- https://stripe.com/legal/restricted-businesses

### PayPay
- https://www.paypay.ne.jp/opa/doc/jp/v1.0/dynamicqrcode
- https://www.paypay.ne.jp/opa/doc/jp/v1.0/webcashier
- https://www.paypay.ne.jp/opa/doc/jp/v1.0/user_notification
- https://github.com/paypay/paypayopa-sdk-node/blob/master/README.md

### 取得できなかったURL（引用に使っていない）
- https://www.paypay.ne.jp/opa/doc/jp/v1.0/webhook — HTTP 404
- https://supabase.com/docs/guides/auth/social-login/auth-custom-oidc — HTTP 404
- https://developer.paypay.ne.jp/products/docs/webpayment — 見出しのみ返り本文を取得できず
