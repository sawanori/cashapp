# アーキテクチャ案 B — Risk-first（規約・法務・セキュリティのリスク最小化）

起案日: 2026-09-24 / 起案者: アーキテクト B（独立起案・他案未参照）
観点: 運営者が資金に一切触れない資金フロー／事業者照会ゲートを通過するまで決済機能を有効化しないフィーチャーフラグ／監査ログ／最小PII
前提資料: `scratchpad/handover.md`、`scratchpad/local-context.md`、`scratchpad/research/consolidated.md`（以下「調査」）

**この案を一文で。** 決済を「後から挿す部品」として設計し、決済が一切繋がっていない状態で名簿・請求・監査ログ・冪等基盤を完成させ、PayPay／LINEヤフー／弁護士の3方向の照会回答が `compliance_gate` テーブルに証跡付きで記録されるまでサーバー側で決済APIの呼び出し自体を拒否する構成にする。

> **未確定事項の扱い（重要）**
> 本案が第一候補・第二候補として挙げる決済事業者は、**いずれも事業者への照会が未実施**である。調査 §5-1〜§5-4 の質問に対する回答は1件も得られていない。したがって本案の決済事業者選定は「照会でこう答えが返れば成立する」という条件付きの仮説であり、確定仕様ではない。Phase 0 の照会結果によって第一候補は入れ替わりうる。

---

## 1. 採用する資金フローと決済事業者の第一候補・第二候補

### 1-1. 採用する資金フロー: 「幹事＝加盟店 / 運営者＝非加盟店・非資金保持」型（調査 §2 の候補 A を基本、D を代替）

```
参加者 ──(決済事業者のホスト画面で支払い)──> 決済事業者 ──(加盟店売上として)──> 幹事の受取口座
                                                │
                                                └─(Webhook / 照会API: 金額・状態・merchantPaymentId のみ)──> 本アプリ
本アプリ: 名簿・請求台帳・支払状態の反映・監査ログ。資金の受入れ・保管・引渡しには一切関与しない。
```

この形を採る理由は3つある。

1. **調査 §6-1 の L1（運営者の口座・決済アカウントを資金が経由しない）を構造的に満たす。** 運営者は加盟店ですらないので、資金決済法2条の2柱書の「弁済として資金を受け入れ」に物理的に該当しえない。残る論点は「他の者に受け入れさせ…引き渡す」の射程だけになり、弁護士照会の争点を1本に絞れる（調査 §5-4 質問1）。
2. **調査 §2 候補 F（収納代行）を初期スコープから完全に排除できる。** 資金移動業登録は株式会社要件（確信度 低・未検証）があり、合同会社である NonTurn LLC は組織変更が前提になる。ここに依存する設計は Risk-first では採らない。
3. **connpass / Doorkeeper が日本で実運用している構造と同型**（調査 §4-5）。前例のある構造をなぞることが、規約・法務の未知数を最小にする最も安い方法である。

**同時に採らないと決めたもの:**

- 候補 F（運営者が資金をプール）— 資金移動業の論点が確定的に立つ。不採用。
- 候補 E（楽天銀行 + 電子決済等代行業）— 「幹事が非事業者のまま自動検知できる」唯一の経路だが、電代業登録のリードタイムが読めず、振込依頼人名の書き換えによる誤照合という**新種のリスク**を持ち込む。Phase 3 以降の拡張候補として設計上の席（`BankReconciler`）だけ用意し、初期実装はしない。
- 候補 G（自動チェックなし）— Phase 1 の暫定形としては採る（後述の `ManualConfirmationAdapter`）が、**これをもって「自動チェック要件を満たした」とは説明しない**（調査 §7-3 の禁止事項）。

### 1-2. 第一候補: PayPay オンライン加盟店（幹事が加盟店になる）

| 項目 | 内容 |
|---|---|
| 受取先 | 幹事の加盟店売上 → 幹事が指定した受取口座 |
| 自動検知 | Webhook（COMPLETED 等）＋ `GET /v2/codes/payments/{merchantPaymentId}` の再照会（調査 §4-3） |
| 運営者の資金関与 | なし（運営者は加盟店ではない） |
| go/no-go の条件 | PayPay が「飲み会・サークル等の会費徴収」をオンライン決済の取扱可能商材と認めること（調査 §5-1 質問1〜3） |

**条件付き根拠（すべて照会前）:**

- 調査 §3-15 により、「PayPay加盟店＝実店舗のある法人・個人事業主のみ」は**実店舗QR決済ルートのFAQの記述**であり、オンライン決済ルート（`paypay.ne.jp/store-online/`）には実店舗要件の記載がなく、加盟店規約の「加盟店」定義にも実店舗要件・事業者要件が条文化されていない。つまり門前払いとは限らない（確信度 中）。
- 真の障壁は NG商材判定である。公式に「商取引ではない寄付や募金、投げ銭（チップ）など一部NG商材もございます」とされており（調査 §4-3）、会費がここに当たるかが分岐点。**照会1本で go/no-go が決まる**ため、不確実性の解消コストが最も安い。これが Risk-first で第一候補に置く決め手である。
- PayPay 加盟店規約は「加盟店が販売する商品もしくは権利または提供する役務」の代価という素直な建付けで、Stripe のような**解釈を要する規約条項の重ね合わせ**（後述）を踏まない。
- サンドボックス（`env: "STAGING"`、`apigw.sandbox.paypay.ne.jp`）が加盟店審査の前から使える（調査 §6-5 I6）ので、照会の回答待ち中に実装検証だけ進められる。

**この候補が持ち込むリスク（正直に）:**

- 入金が月末・月1回（確信度 低・未検証）。飲み会当日の立て替え問題は解消しない。
- Webhook に署名検証の記載がない（調査 §6-3 W7）。IP許可リスト＋必ず `getPaymentStatus` で再照会、という二重の防御が必須。
- `GET /v2/codes/payments/{...}` のレスポンスに支払者識別フィールドがない（調査 §3-12）。**代理払いはAPIで検知できない。**
- **幹事の加盟店 API キー／シークレットを運営者が保管する必要がある。** PayPay には Stripe Connect OAuth / PayPal Partner Referrals のような「接続」の仕組みが公開ドキュメント上に見当たらない。これは本案最大のセキュリティ債務であり §11 と §5 で扱う。

### 1-3. 第二候補: PayPal（connpass 型）

| 項目 | 内容 |
|---|---|
| 受取先 | 幹事の PayPal アカウントへ即時着金 |
| 自動検知 | `PAYMENT.CAPTURE.COMPLETED` Webhook |
| go/no-go の条件 | ビジネスアカウント要否、API 資格（調査 §5-5。**一次資料の取得に失敗しており確信度 低**） |

**条件付き根拠:** connpass が「主催者の PayPal アカウントへ即時入金、connpass 手数料は無料、主催者は本人確認済みアカウントがあれば個人でも可」で実運用している（調査 §4-5）。**即時着金である点が第一候補の最大の弱点（月末入金）を打ち消す**ため、PayPay が NG商材判定を返した場合の即座の代替として置く。ただし PayPal 側の一次資料は未取得なので、Phase 0 で照会対象に追加する。

### 1-4. 明示的に不採用とする候補

- **Stripe（調査 §2 候補 B）— 不採用（Phase 0 で保留、Phase 3 以降の再評価対象）。** 理由は規約条項が三重に重なること: (1) SSA §1.2(a)(i) の "personal, family, or household purposes" 包括禁止、(2) 禁止業種「ピアツーピアの送金」、(3) 管轄区域固有の禁止業種の日本節「Stripe Connect 外での C2C サービス」。しかも (3) が正しければ日本では Connect が必要条件になるのに、Connect × PayPay には公開された実装経路がない（調査 §3-8）。**「必要条件」と「実装不能」が同時に成り立つ可能性がある選択肢を、Risk-first の第一候補には置けない。** なお調査 §3-3 の通り「禁止業種＝事前承認の余地なし」は誤りなので、「Stripe は使えない」とは言わない。「未解決の規約衝突が最も多いので後回しにする」である。
- **PAY.JP（候補 C）— 保留。** 必要書類が最も軽く Webhook 仕様も明快だが、加盟店規約本文が未取得で個人間送金・立替精算の扱いが不明（調査 §5-5）。Phase 2 の2本目のアダプタ候補。

---

## 2. 技術スタック

ローカル実測（node v22.22.0 / npm 10.9.4 / **pnpm は corepack シム破損で起動不可** / supabase CLI 2.58.5 / Vercel CLI 50.17.0 / gh 認証済 / stripe CLI 存在 / wrangler 未インストール）を前提に選定する。

| 層 | 採用 | 選定理由 | 不採用にしたもの・理由 |
|---|---|---|---|
| パッケージマネージャ | **npm 10.9.4**（`package-lock.json`、`engines.node: ">=22 <23"`、`.npmrc` に `save-exact=true`） | 実測で唯一確実に動く。corepack の修復に着手すると Phase 1 の前に環境デバッグが挟まる | pnpm — 実測で起動不可。修復は Phase 3 の課題に落とす。yarn/bun — 導入理由がない |
| フレームワーク | **Next.js 15 App Router**（Route Handlers） | Webhook で `await request.text()` が生の本文を返し、Pages Router 時代の bodyParser 無効化設定が不要（調査 §4-6）。これは調査 §6-2 P2「raw 文字列と Headers を受け取る」を satisfy する最短経路 | Hono/Express 単体 — LIFF フロントと同居させる利点を捨てることになる。Remix/SvelteKit — raw body の扱いを再検証する手間が増える |
| ホスティング | **Vercel、`vercel.json` に `"regions": ["hnd1"]` を初回コミットから明記** | 既定が `iad1`（バージニア）なので明記しないと日本の参加者に対して無駄なレイテンシと越境（調査 §6-5 I1）。Vercel CLI 50.17.0 実測済 | Cloudflare Workers — wrangler 未インストール。Free の CPU 10ms 制限（調査 §4-6）が署名検証＋DB往復に対して危険。Phase 3 で再評価 |
| プラン | **Phase 2 から Vercel Pro 前提** | Hobby の cron は1日1回・±59分（調査 §4-6）。再照合ジョブの遅延許容度が24時間では、当日集金のユースケースで支払済み反映が間に合わない（調査 §6-5 I2） | Hobby のまま — Phase 1（決済なし）までは可 |
| DB | **Supabase Postgres（Tokyo / ap-northeast-1）** | supabase CLI 2.58.5 実測済でローカル Postgres が即立つ＝統合テストを実DBで書ける。Phase 3 で PITR が要る（監査ログの保全） | Vercel Postgres/Neon — 選定理由がない。SQLite/D1 — 監査ログの append-only 制約と行ロックを素直に書けない |
| ORM | **Drizzle ORM ＋ 手書き SQL マイグレーション** | 監査対象の制約（append-only トリガ、部分ユニークインデックス、CHECK 制約、`status_rank` の単調更新述語）を**マイグレーションファイル上で目視レビューできる**ことが Risk-first では決定的。Drizzle は生成 SQL がそのまま成果物になる | Prisma — マイグレーションが宣言駆動で、上記のような手続き的制約をエスケープハッチで書くことになり差分レビューが痛い。加えてサーバーレスでのエンジンバイナリ同梱を避けたい。Supabase の PostgREST 直叩き — 認可を DB 側に寄せる設計になり、調査 §6-5 I3（MVP は RLS を使わず全アクセスをサーバー側で）と衝突 |
| 認証 | **LIFF の IDトークン → サーバー側検証 → 自前の署名付きセッション Cookie**（HttpOnly / Secure / SameSite=Lax / 30分・スライディング）＋ 状態変更系に CSRF ダブルサブミットトークン | 調査 §6-4 N2 を最短で満たす。決済事業者からの復帰は**トップレベル GET ナビゲーション**なので SameSite=Lax で通る | Supabase Auth — 公式ソーシャルログイン一覧に LINE がなく、Custom OIDC は `signInWithOAuth` のリダイレクト往復が前提（調査 §4-6）。LIFF 内でのリダイレクト往復は復帰導線を壊すリスクがあり、しかも「LINE を Custom OIDC で登録して実際にサインインが成立するか」は未確認（調査 §5-5）。**未確認の依存を認証の中心に置かない。** NextAuth/Auth.js — 同じ理由 |
| 決済SDK | **Phase 1 は決済SDKを一切インストールしない。** Phase 2 でゲート通過したプロバイダのSDKのみ追加（第一候補なら `@paypayopa/paypayopa-sdk-node`） | 依存が存在しなければ誤って本番決済を叩くことがない。これがフィーチャーフラグより強い最終防御になる | Stripe SDK を先に入れる — stripe CLI がローカルにあるので入れたくなるが、§1-4 の通り Stripe は保留。**「テストで使えるから」を理由に未採用事業者のSDKを本番依存に入れない** |
| バリデーション | **Zod**（全リクエスト境界・全 Webhook パース後） | 型と実行時検証を1つのスキーマで持てる。Webhook の `amount`/`currency` 突合（調査 §6-3 W8）をスキーマ側に寄せられる | 手書き検証 — 抜けが出る |
| テスト | **Vitest（ユニット/統合）＋ Playwright（E2E）＋ `@line/liff-mock`** | 調査 §6-5 I4/I5 がそのままこの構成を指している | Jest — ESM と Next.js 15 の相性で手間が増える |
| 秘匿情報 | **Vercel 環境変数（暗号化・復号は明示要求時のみ）＋ 幹事の加盟店資格情報はアプリ側で封筒暗号化（AES-256-GCM、DEKはプロバイダ接続ごと、KEK は環境変数 + Phase 3 で KMS へ移行）** | 幹事の資格情報を平文で DB に置かない。復号は決済呼び出しの直前・メモリ内のみ・ログ出力禁止 | Supabase Vault のみに依存 — Phase 3 で評価。現時点で運用実績がない |
| 静的検査 | TypeScript strict、ESLint、`eslint-plugin-security`、`npm audit` を CI 必須 | — | — |
| CI | GitHub Actions（gh 認証済） | — | — |

**スタック上の Risk-first 固有ルール:**

- 決済に関わるコードは `src/payments/` 配下に隔離し、`src/app/api/webhooks/` と `src/app/api/**/checkout` 以外からの import を ESLint の `no-restricted-imports` で禁止する。
- `PAYMENTS_ENABLED !== "true"` のとき、`src/payments/registry.ts` がすべてのプロバイダ解決を `ProviderNotEnabledError` で落とす。UI の非表示は副次的手段であり、**サーバー側の拒否が正**。
- CI に「`PAYMENTS_ENABLED=true` かつ `compliance_gate` の必須ゲートが全部 `passed` でない状態では本番ビルドを失敗させる」チェックを入れる（§8 Phase 1 の完了条件）。

---

## 3. LINEミニアプリ統合

### 3-1. チャネル構成（最初に確定する。後から移せない）

```
プロバイダー: NonTurn LLC（1つだけ作る。userId はプロバイダー単位で共通 — 調査 §6-4 N1）
├── LINEミニアプリチャネル「(サービス名)」
│   ├── 内部チャネル: 開発用   → LIFF ID(dev),    エンドポイント https://dev.<domain>
│   ├── 内部チャネル: 審査用   → LIFF ID(review), エンドポイント https://review.<domain>
│   └── 内部チャネル: 本番用   → LIFF ID(prod),   エンドポイント https://<domain>
└── Messaging API チャネル（Phase 1 では未使用。同一プロバイダー配下に「先に作っておく」だけ）
```

- Scope と友だち追加オプションは内部チャネルごとに変更できない（調査 §6-4 N6）ので、**権限設計は Phase 1 の着手前に一度で決める**。最小 PII の方針から要求する scope は `openid` と `profile` のみ。`profile` も「取れたら使う」に留め、正は幹事が入力した表示ラベルにする（§3-5、調査 §6-4 N12）。
- Messaging API チャネルを先に作る理由は、後から同一プロバイダーに移せないため。Phase 1 で使わなくても席だけ確保する。

### 3-2. LIFF 初期化

```ts
// 環境ごとに LIFF ID を切り替える（調査 §6-4 N6）。ビルド時に埋め込み、実行時に上書きしない。
await liff.init({ liffId: process.env.NEXT_PUBLIC_LIFF_ID! });
if (!liff.isLoggedIn()) liff.login({ redirectUri: location.href });
const idToken = liff.getIDToken();      // ← サーバーへ送るのはこれだけ
// liff.getDecodedIDToken() / liff.getProfile() の結果をサーバーへ送ってはならない（調査 §6-4 N2）
```

- SPA ルーティングは **History API ベース**。URL フラグメント不可、エンドポイントは https のみ（調査 §6-4 N5）。
- `liff.isApiAvailable("shareTargetPicker")` を実行時に評価し、使えない場合の分岐を必ず持つ（§3-4）。
- 名簿・支払状況・イベント管理の画面はすべて自ドメイン内で完結させ、外部ドメインへ出るのは決済画面だけにする（調査 §6-4 N4）。

### 3-3. IDトークンのサーバー検証とセッション方式

採用する検証経路は **(b) IDトークンの JWT 署名を自前検証（ES256 + JWKS）** を主、**(a) `POST https://api.line.me/oauth2/v2.1/verify`** をフォールバックとする。調査 §3-14 の通り公式に認められた経路は3つあり、「必ず verify エンドポイントを経由する」という限定は正しくない。

自前検証を主にする理由は Risk-first 的には2つ。LINE API への外部往復が Webhook 処理と同じリクエスト予算を食わないこと、そして JWKS のキャッシュで**外部障害時にログインが落ちない**こと。ただし JWKS の取得失敗時は (a) に自動フォールバックし、両方失敗したら**認証を通さない**（フェイルクローズ）。

```
POST /api/session
  body: { idToken }
  1. JWT を検証: iss=https://access.line.me / aud ∈ ALLOWED_AUD（環境ごとの LINE Login チャネルID の許可リスト） /
     exp 検証 / nonce 検証 / alg=ES256 のみ許可（alg=none と HS256 混入を明示的に拒否）
     ※ 調査 §6-4 N3 の通り client_id は LINE Login チャネルID。ミニアプリの内部チャネルごとに
       別IDになるかは未確認なので、単一値ではなく許可リストで持ち、環境変数で切り替える。
  2. sub（userId）を line_user_ref = HMAC-SHA256(sub, PEPPER) に変換して保存（§4-1、最小PII）
  3. 自前セッションを発行: HttpOnly / Secure / SameSite=Lax / Path=/ / Max-Age=1800
     ペイロード: { sid, line_user_ref, iat, exp }。署名は HS256、鍵は環境変数、ローテーション可
  4. audit_log に session.created を書く（line_user_ref とリクエストIDのみ。生の userId は書かない）
```

- **支払状態・認可状態を cookie / localStorage に持たせない**（調査 §6-4 N7）。セッションは「誰か」だけを運び、「いくら・払ったか」は毎回サーバーから取る。
- セッション期限切れ時はフロントが `liff.getIDToken()` を取り直して `/api/session` を再実行する（LIFF 内なので再ログイン画面は出ない）。

### 3-4. `shareTargetPicker` による参加者への配布

**配布するのは「イベント参加リンク」であり、個別の請求リンクではない。** これは本案の意図的な設計である。個別請求リンク（capability token）をグループトークに貼ると、他人が他人の請求を開けてしまう。

```
幹事: イベント作成 → 参加者名（表示ラベル）を登録 → [LINEで招待]
  → liff.shareTargetPicker([{ type:"text", text:"<イベント名> の会費のご案内 https://<domain>/e/<join_token>" }])
  → フォールバック: QRコード表示 / URLコピー（調査 §6-4 N8。友だちのプライバシー設定で
     一部の友だちが表示されないため、フォールバックは「あれば良い」ではなく必須）
参加者: リンクを開く → LIFF 初期化 → /api/session → 名簿から自分の名前を self-claim
  → claim した時点で participant.line_user_ref に束縛（以後その人しか開けない）
  → 自分の請求だけが見える。他人の請求額・支払状況は見えない
```

- `liff.sendMessages()` は集金導線で使えない前提にする（トークルームから起動された LIFF でのみ動作、それ以外は 403。調査 §6-4 N9）。
- 未 claim の参加者名は一覧でイニシャル表示にし、claim 済みの参加者にのみフルの表示ラベルを見せる。claim は監査ログに残し、幹事は claim の付け替え（誤 claim の是正）ができる。参加者自身は付け替えできない。
- 幹事が個別に送りたい場合のみ、個別請求リンク（`/i/<invoice_access_token>`）を1対1トークへ送れる。この場合も token は1回の発行ごとに新規・失効可能。

### 3-5. 未認証ミニアプリで始める

**Phase 1・Phase 2 は未認証ミニアプリで本番リリースする。** 根拠は調査 §3-10 / §4-4: 日本の決済は「LINE Pay ❌ / アプリ内課金 ✅ / その他の決済方法 ✅」であり、外部決済（＝その他の決済方法）は未認証でも使える。アプリ内課金は実際には認証済ミニアプリでしか動かないが、本サービスは消耗型デジタルコンテンツを売らないので使わない。

認証審査が必要になるトリガー（＝ Phase 3 の入口）は、サービスメッセージ（未払い者への通知）、LINE 内検索／ホームタブ掲載、Custom Path、ホーム画面ショートカット。Phase 1・2 ではこれらを一切使わない。

**認証審査が要らないうちに本番の集金を回せる**ことは、Risk-first では大きい。審査落ちが事業停止に直結しない。

### 3-6. 審査対応（Phase 3 で必要になったとき、および Phase 0 の事前照会）

- サービス定義を「**幹事が管理する精算・集金の台帳**」に統一する。アプリ名・説明文・スクリーンショット・利用規約・プライバシーポリシーのすべてから、寄付・募金・クラウドファンディング・チップ・投げ銭の語を排除する（調査 §6-4 N11、ポリシー禁止業種「募金、寄附、クラウドファンディング等の資金調達」）。
- 「集める」より「記録する」を前面に出す。決済への遷移は台帳の一機能として位置づける。
- 調査 §5-3 の質問1〜3 を Phase 0 で LINEヤフーへ事前照会し、回答を `compliance_gate` に記録する（GATE-LINE-POLICY）。特に質問2（現実世界の役務の集金がアプリ内課金必須条項に含まれるか）は、外部決済で始める本案の前提そのものなので**回答が得られるまで本番リリースしない**。
- 外部決済からの復帰は必須要件（調査 §6-2 P4）。`createCheckout` の `returnUrl` は型上 optional にしない。

---

## 4. データモデル

Postgres。すべて `id` は UUID v7（時系列ソート可）。金額は `integer`（円、最小通貨単位）。`numeric`/`float` は使わない。

### 4-1. 最小PII の方針（テーブル設計より先に決める）

| 項目 | 扱い |
|---|---|
| LINE userId | **生値を保存しない。** `line_user_ref = HMAC-SHA256(userId, PEPPER)` のみ保存。PEPPER は環境変数（Phase 3 で KMS）。Messaging API が必要になる Phase 3 で初めて生値の取得と保存を、別途の同意を取ったうえで追加する |
| 表示名 | **LINE のプロフィール表示名は保存しない。** 幹事が入力した表示ラベル（`participant.display_label`）を正とする（調査 §6-4 N12）。イベント単位のスコープで、他イベントへ持ち越さない |
| プロフィール画像 | 保存しない。表示もしない |
| メール / 電話 / 住所 | **収集しない。** フォーム自体を作らない |
| 決済事業者へ渡す情報 | 金額・通貨・`merchantPaymentId`・`returnUrl` のみ。氏名・LINE ID・メールは渡さない |
| Webhook の生ボディ | `payment_event.raw_ciphertext` に暗号化して保存、**保持14日**。それ以降は本文を落とし `raw_sha256` とパース済みの必要フィールドだけ残す |
| 監査ログ | ID・enum・金額・タイムスタンプのみ。`display_label` 等の自由入力文字列を **入れない**（before/after は値そのものではなくハッシュと変更フラグ） |
| 保持期間 | イベント終了日 + 90日で `participant.display_label` を NULL 化（擬似匿名化）。請求・支払・監査は金額と ID のみで7年保持（会計証憑としての必要性。**期間は要弁護士確認**） |

### 4-2. テーブル

```sql
-- ============ 主体 ============
organizer (
  id                uuid PRIMARY KEY,
  line_user_ref     bytea NOT NULL UNIQUE,          -- HMAC-SHA256(userId, PEPPER)
  status            text NOT NULL DEFAULT 'active', -- active | suspended
  tos_accepted_at   timestamptz,
  privacy_consent_at timestamptz,                   -- L6: 参加者の支払状況を見ることへの同意
  created_at        timestamptz NOT NULL DEFAULT now()
)

-- 幹事の決済事業者接続。資格情報は封筒暗号化。平文カラムを持たない。
provider_account (
  id                uuid PRIMARY KEY,
  organizer_id      uuid NOT NULL REFERENCES organizer(id) ON DELETE RESTRICT,
  provider          text NOT NULL,                  -- 'manual' | 'paypay_online' | 'paypal' | ...
  status            text NOT NULL,                  -- pending | verified | disabled | revoked
  credential_ct     bytea,                          -- AES-256-GCM 暗号文（DEKで暗号化）
  credential_dek_ct bytea,                          -- KEKで暗号化した DEK
  credential_fp     text,                           -- 資格情報の指紋（sha256の先頭16hex）。ログ用
  detection_mode    text NOT NULL,                  -- 'automatic' | 'manual_only'
  connected_at      timestamptz,
  last_verified_at  timestamptz,
  UNIQUE (organizer_id, provider)
)

-- ============ イベント・名簿 ============
event (
  id                uuid PRIMARY KEY,
  organizer_id      uuid NOT NULL REFERENCES organizer(id) ON DELETE RESTRICT,
  title             text NOT NULL,
  event_date        date,
  currency          char(3) NOT NULL DEFAULT 'JPY',
  status            text NOT NULL DEFAULT 'draft',  -- draft | open | closed | canceled
  join_token_hash   bytea NOT NULL UNIQUE,          -- 招待リンクの token は生で保存しない
  payments_mode     text NOT NULL DEFAULT 'manual', -- manual | provider（ゲート未通過なら manual 固定）
  provider_account_id uuid REFERENCES provider_account(id),
  retention_due_at  timestamptz,                    -- 擬似匿名化の期日
  created_at        timestamptz NOT NULL DEFAULT now()
)
CREATE INDEX ON event (organizer_id, status);
CREATE INDEX ON event (retention_due_at) WHERE retention_due_at IS NOT NULL;

participant (
  id                uuid PRIMARY KEY,
  event_id          uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  display_label     text,                           -- 幹事が入力。90日後に NULL 化
  line_user_ref     bytea,                          -- self-claim で束縛。未claimなら NULL
  claimed_at        timestamptz,
  status            text NOT NULL DEFAULT 'active', -- active | removed
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- 同一イベント内で1人のLINEユーザーが複数の participant を claim できない
CREATE UNIQUE INDEX participant_event_user_uq
  ON participant (event_id, line_user_ref) WHERE line_user_ref IS NOT NULL;
CREATE INDEX ON participant (line_user_ref) WHERE line_user_ref IS NOT NULL;

-- ============ 請求 ============
invoice (
  id                  uuid PRIMARY KEY,
  event_id            uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  participant_id      uuid NOT NULL REFERENCES participant(id) ON DELETE CASCADE,
  amount              integer NOT NULL CHECK (amount > 0),
  currency            char(3) NOT NULL DEFAULT 'JPY',
  status              text NOT NULL DEFAULT 'draft',
  status_rank         smallint NOT NULL DEFAULT 0,  -- 単調前進（§7）
  terminal_reason     text,                         -- canceled | expired | void
  paid_at             timestamptz,
  paid_via            text,                         -- 'provider' | 'manual_organizer'（非自動）
  settled_hint_at     timestamptz,                  -- 幹事への入金予定（表示用。確定値ではない）
  access_token_hash   bytea UNIQUE,                 -- 個別請求リンク
  access_token_expires_at timestamptz,
  version             integer NOT NULL DEFAULT 0,   -- 楽観ロック
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- 1参加者1イベントにつき有効な請求は1件（取り違え・重複請求の構造的防止）
CREATE UNIQUE INDEX invoice_active_uq
  ON invoice (event_id, participant_id) WHERE status <> 'void';
CREATE INDEX invoice_reconcile_idx
  ON invoice (status_rank, updated_at) WHERE status_rank BETWEEN 20 AND 39;

-- ============ 支払い試行 ============
payment_attempt (
  id                uuid PRIMARY KEY,
  invoice_id        uuid NOT NULL REFERENCES invoice(id) ON DELETE RESTRICT,
  provider          text NOT NULL,
  provider_ref      text NOT NULL,                  -- merchantPaymentId / session_id
  idempotency_key   text NOT NULL,
  amount            integer NOT NULL,
  currency          char(3) NOT NULL,
  status            text NOT NULL,                  -- created | redirected | authorized | succeeded
                                                    -- | failed | canceled | expired | duplicate_overpay
  detection_mode    text NOT NULL,                  -- automatic | manual_only
  last_checked_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref),
  UNIQUE (invoice_id, idempotency_key)
);
CREATE INDEX ON payment_attempt (invoice_id, created_at DESC);

-- ============ 決済イベント（冪等） ============
payment_event (
  provider          text NOT NULL,
  event_id          text NOT NULL,                  -- W1: 事業者のイベントID
  object_id         text NOT NULL,                  -- W2: data.object のID
  event_type        text NOT NULL,
  provider_ref      text,
  observed_status   text,
  amount            integer,
  currency          char(3),
  raw_sha256        bytea NOT NULL,
  raw_ciphertext    bytea,                          -- 14日で NULL 化
  signature_ok      boolean NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  process_result    text,                           -- applied | ignored_duplicate | ignored_stale
                                                    -- | rejected_amount_mismatch | rejected_unknown_ref
  PRIMARY KEY (provider, event_id)
);
-- W2: event_id が別でも同一事象の重複を弾く業務レベルの冪等キー
CREATE UNIQUE INDEX payment_event_business_uq
  ON payment_event (provider, object_id, event_type, observed_status);
CREATE INDEX ON payment_event (received_at) WHERE processed_at IS NULL;

-- ============ 監査ログ（append-only） ============
audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_type    text NOT NULL,      -- organizer | participant | system | webhook | admin
  actor_ref     bytea,              -- line_user_ref か admin_id。生の userId は入れない
  action        text NOT NULL,      -- invoice.paid | invoice.manual_marked | gate.updated | ...
  target_type   text NOT NULL,
  target_id     uuid,
  before_rank   smallint,
  after_rank    smallint,
  amount        integer,
  provider      text,
  provider_ref  text,
  request_id    text NOT NULL,
  source_ip_hash bytea,             -- HMAC。生IPは保存しない
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 自由入力文字列を入れない（CHECKで検査）
  prev_hash     bytea,              -- 直前行の row_hash（改ざん検知の連鎖）
  row_hash      bytea NOT NULL
);
CREATE INDEX ON audit_log (target_type, target_id, occurred_at DESC);
CREATE INDEX ON audit_log (action, occurred_at DESC);
-- UPDATE / DELETE をトリガで拒否（アプリの権限からも REVOKE する）
CREATE RULE audit_log_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_log_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;

-- ============ ゲート・フラグ ============
compliance_gate (
  gate_key      text PRIMARY KEY,   -- GATE-PP-MERCHANDISE / GATE-LINE-POLICY / GATE-LEGAL-FUNDS ...
  scope         text NOT NULL,      -- provider:paypay_online / platform:line / legal
  required_for  text[] NOT NULL,    -- ['phase2'] など
  status        text NOT NULL DEFAULT 'unknown',  -- unknown | inquired | passed | failed | n/a
  inquired_at   timestamptz,
  decided_at    timestamptz,
  decided_by    text,
  evidence_uri  text,               -- 回答メール/書面の保管先
  note          text
);

feature_flag (
  key           text PRIMARY KEY,   -- PAYMENTS_ENABLED / PROVIDER_PAYPAY_MODE / ...
  value         text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL
);

-- ============ 非同期・突合 ============
outbox (
  id            uuid PRIMARY KEY,
  kind          text NOT NULL,      -- notify_organizer | notify_alert | recheck_payment
  payload       jsonb NOT NULL,
  available_at  timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  done_at       timestamptz
);
CREATE INDEX ON outbox (available_at) WHERE done_at IS NULL;

reconciliation_run (
  id            uuid PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  scanned       integer NOT NULL DEFAULT 0,
  advanced      integer NOT NULL DEFAULT 0,
  mismatched    integer NOT NULL DEFAULT 0,
  error         text
);
```

### 4-3. 状態列と単調ランク

`invoice.status_rank` は「後退しない」ことを DB レベルで保証する軸（調査 §6-3 W3）。

| rank | status | 意味 |
|---:|---|---|
| 0 | `draft` | 請求作成前 |
| 10 | `issued` | 請求発行済み・支払い導線未生成 |
| 15 | `canceled` / `expired` | 未払いのまま終了（rank < 40 のときだけ遷移可） |
| 20 | `checkout_pending` | 決済セッション作成済み・結果未確定 |
| 30 | `authorized` | 与信のみ成立（PayPay AUTHORIZED 等） |
| 40 | `paid` | 支払い確定（自動 or 手動確認） |
| 50 | `settled_reported` | 幹事への入金を幹事自身が確認して記録（**非自動**） |
| 60 | `refunded` | 返金確定 |

更新は常に `UPDATE invoice SET ... WHERE id = $1 AND status_rank < $newRank` の形で行う。`canceled`/`expired` だけは例外的に `AND status_rank < 40` を追加で課す（支払い済みをキャンセルで巻き戻さない）。

---

## 5. API / Webhook 設計

### 5-1. エンドポイント一覧

| メソッド | パス | 認可 | ゲート | 備考 |
|---|---|---|---|---|
| POST | `/api/session` | 公開（IDトークン必須） | — | §3-3。レート制限 10/min/IP |
| GET | `/api/me` | セッション | — | `line_user_ref` に紐づく organizer/participant を返す |
| POST | `/api/events` | organizer セッション | — | |
| GET | `/api/events/:id` | organizer かつ所有者 | — | 参加者は使えない |
| PATCH | `/api/events/:id` | organizer かつ所有者 | — | `payments_mode` の変更は `PAYMENTS_ENABLED` 必須 |
| POST | `/api/events/:id/participants` | organizer かつ所有者 | — | 一括登録。最大200件/req |
| PATCH | `/api/participants/:id` | organizer かつ所有者 | — | claim の付け替えを含む |
| POST | `/api/events/:id/invoices` | organizer かつ所有者 | — | 参加者ごとに1件、金額は個別可 |
| GET | `/api/e/:joinToken` | 公開（token）＋セッション | — | 参加リンク。self-claim 画面 |
| POST | `/api/e/:joinToken/claim` | セッション | — | `participant.line_user_ref` を束縛。以後変更不可（幹事のみ是正可） |
| GET | `/api/invoices/:id` | 当該 participant か所有 organizer | — | 参加者は自分の1件のみ |
| POST | `/api/invoices/:id/checkout` | 当該 participant | **`PAYMENTS_ENABLED` かつ provider ゲート passed** | 未通過なら 409 `gate_not_passed` |
| GET | `/api/invoices/:id/status` | 当該 participant か所有 organizer | — | 復帰時に1回だけ `getPaymentStatus`（P3）。以後は Webhook / 再照合に委ねる |
| POST | `/api/invoices/:id/manual-mark` | organizer かつ所有者 | — | **手動確認（非自動）**。`paid_via='manual_organizer'` |
| POST | `/api/invoices/:id/manual-unmark` | organizer かつ所有者 | — | 手動確認の取り消しのみ可。自動確定（`paid_via='provider'`）は取り消せない |
| POST | `/api/invoices/:id/refund` | organizer かつ所有者 | provider ゲート | アダプタが未対応なら 422 `refund_not_supported` |
| POST | `/api/webhooks/:provider` | **署名検証のみ**（セッション不要・CSRF 除外） | — | §5-3 |
| POST | `/api/cron/reconcile` | `x-vercel-cron` ＋ `CRON_SECRET` | — | §5-5 |
| POST | `/api/cron/outbox` | 同上 | — | |
| POST | `/api/cron/retention` | 同上 | — | 90日経過の擬似匿名化、14日経過の raw 本文削除 |
| GET/POST | `/api/admin/gates` | 管理者（別セッション・IP 制限） | — | `compliance_gate` の更新。全操作を audit_log へ |

### 5-2. 認可の原則

- **所有者判定はリクエストボディから取らない。** セッションの `line_user_ref` → `organizer.id` を引き、`event.organizer_id` と一致することを SQL の WHERE 句に必ず含める（アプリ層の if 文だけに頼らない）。
- 参加者は `participant.line_user_ref = session.line_user_ref` の行にしかアクセスできない。イベント全体の支払状況は organizer のみ。
- MVP では RLS を使わず、すべての DB アクセスをサーバー側 Route Handler 経由にする（調査 §6-5 I3）。Supabase の anon key をフロントに出さない。
- token（`join_token` / `access_token`）は 32byte ランダムを base64url で発行し、**DB にはハッシュのみ保存**。比較は定数時間比較。

### 5-3. Webhook 処理（`POST /api/webhooks/:provider`）

```
1. const raw = await request.text();                 // P2: 先にパースしない
2. provider = resolveProvider(params.provider)       // 未有効化なら 404（存在を漏らさない）
3. parsed = await adapter.parseWebhook(raw, request.headers, ctx)
   - 署名がある事業者: 検証失敗 → 400、audit_log に webhook.signature_failed
     - シークレットは複数併存で試行（W12。ローテーション中の24時間に落ちない）
     - タイムスタンプ許容 5分（許容値 0 を使わない）
   - 署名がない事業者（PayPay 想定）: IP 許可リストで一次判定（W7）。
     ここでは絶対に状態を進めない。必ず 5 の再照会で確定させる。
4. INSERT INTO payment_event (provider, event_id, ...) ... ON CONFLICT DO NOTHING RETURNING *
   - 行が返らなければ既処理 → 200 を即返す（W1）
   - 業務冪等キー (provider, object_id, event_type, observed_status) の一意違反でも同様（W2）
5. adapter.getPaymentStatus(provider_ref) で事業者に再照会（署名のない事業者では必須、
   署名のある事業者でも金額不一致時と AUTHORIZED→COMPLETED 遷移時は実行）
6. 突合（W8）: provider_ref → payment_attempt → invoice を引き、
   amount / currency / provider_account が一致するか検査。
   不一致 → process_result='rejected_amount_mismatch'、outbox に notify_alert、200 を返す
   （事業者にリトライさせない。人間の確認に回す）
7. SELECT ... FOR UPDATE で invoice をロックし、
   UPDATE invoice SET status_rank=$new ... WHERE id=$1 AND status_rank < $new  （W3）
8. audit_log を書く（before_rank / after_rank / amount / provider_ref / request_id）
9. 重い処理（幹事への通知など）は outbox に積むだけ（W5）
10. 2xx を返す。ここまでの目標は p95 300ms 以内
```

**エラー応答**は RFC 9457 の `application/problem+json` で統一する。

```json
{ "type": "https://<domain>/problems/gate-not-passed",
  "title": "決済機能は現在無効です", "status": 409,
  "code": "gate_not_passed", "requestId": "01J..." }
```

内部例外メッセージ・スタック・SQL・事業者の生レスポンスをクライアントへ返さない。`requestId` だけを返し、詳細はサーバーログと `audit_log` に残す。

### 5-4. 冪等

- クライアント起点の `POST /api/invoices/:id/checkout` は `Idempotency-Key` ヘッダ必須。`payment_attempt (invoice_id, idempotency_key)` のユニーク制約で二重生成を防ぎ、同一キーの再送には**同じ `provider_ref` と同じ redirect URL** を返す。
- Webhook 側は §5-3 の 4 を参照（W1 + W2 の二段）。
- 状態更新は代入的（`status_rank` の前進のみ）で、加算を一切行わない。これにより重複配信で金額が二重計上されることが構造的に起きない（調査 §3-13 の指摘に沿う）。

### 5-5. 再照合ジョブ（reconciliation）

```
POST /api/cron/reconcile（Vercel Cron。Phase 2 以降は Pro で 5分間隔）
  0. pg_try_advisory_lock(hashtext('reconcile')) — 取れなければ即終了（W11）
  1. 状態で走査（時刻カーソルを使わない。W9）:
       SELECT ... FROM invoice
       WHERE status_rank BETWEEN 20 AND 39
         AND updated_at < now() - interval '3 minutes'
         AND created_at > now() - interval '7 days'   -- 保持は最低4日（W10）に余裕を足す
       ORDER BY updated_at LIMIT 200 FOR UPDATE SKIP LOCKED
  2. 各件について adapter.getPaymentStatus(provider_ref)
  3. 単調ランク述語で前進。後退はしない
  4. 期限切れ（事業者側 EXPIRED / 自前の期限超過）は rank 15 へ（rank < 40 の条件付き）
  5. 不一致・未知の provider_ref は mismatched にカウントし outbox へ通知
  6. reconciliation_run に結果を記録。連続失敗が3回続いたら管理者へアラート
```

日次で別ジョブ（`drift-report`）を回し、「事業者側で成功しているのに台帳で未払いの件数」「台帳で支払済みなのに事業者側に記録がない件数」を集計してレポートする。ゼロでない日は人間が見る。

---

## 6. PaymentProvider アダプタ IF と初期アダプタ

### 6-1. 型定義

```ts
// src/payments/types.ts
export type Currency = "JPY";
export interface Money { readonly amount: number; readonly currency: Currency } // 円・整数

export type ProviderId =
  | "manual"          // 手動確認（非自動）
  | "paypay_online"
  | "paypal"
  | "payjp"
  | "stripe";

/** 自動検知の可否。UI・監査ログ・幹事への説明文に必ず出す。 */
export type DetectionMode =
  | "automatic"    // Webhook / 照会APIで機械的に確定できる
  | "manual_only"; // 手動確認（非自動）— アプリは支払いを検証できない

export interface ProviderCapabilities {
  readonly webhook: boolean;
  readonly webhookSignature: boolean;   // false のとき getPaymentStatus 再照会を必須にする
  readonly refund: "none" | "once_per_order" | "partial";
  readonly payerIdentity: boolean;      // 支払者をAPIが返すか（PayPay は false 想定）
  readonly settlementDelayHint: string; // 表示用。"月末・月1回（未確認）" など
}

/** 復号済みの資格情報はこの ctx の中にしか存在しない。ログ・例外メッセージへ出さない。 */
export interface ProviderContext {
  readonly providerAccountId: string;
  readonly credentials: Readonly<Record<string, string>>;
  readonly mode: "sandbox" | "live";
  readonly requestId: string;
}

export interface CreateCheckoutInput {
  readonly invoiceId: string;
  readonly providerRef: string;     // merchantPaymentId 等。アプリが採番（64文字・[a-zA-Z0-9_-]）
  readonly idempotencyKey: string;
  readonly money: Money;
  readonly returnUrl: string;       // 必須（P4: LINEミニアプリのパーマネントリンクへ戻す）
  readonly expiresAt: Date;
  readonly descriptionKey: string;  // 定型文のキー。参加者の氏名・自由入力を渡さない（最小PII）
}

export type CheckoutResult =
  | { kind: "redirect"; url: string; providerRef: string; expiresAt: Date }
  | { kind: "manual_instruction";     // 手動確認（非自動）
      instructionKey: string; deepLink?: string; providerRef: string };

export type ObservedStatus =
  | "pending" | "authorized" | "succeeded"
  | "failed" | "canceled" | "expired" | "refunded"
  | "unknown";

export interface ParsedWebhook {
  readonly signatureOk: boolean;
  readonly providerEventId: string;  // W1
  readonly objectId: string;         // W2
  readonly eventType: string;
  readonly providerRef: string | null;
  readonly observedStatus: ObservedStatus;
  readonly money: Money | null;
  readonly rawSha256: string;
  readonly requiresRequery: boolean; // 署名のない事業者では常に true
}

export interface PaymentStatusResult {
  readonly providerRef: string;
  readonly observedStatus: ObservedStatus;
  readonly money: Money | null;
  readonly payerRef: string | null;  // 取れない事業者は null（代理払いは検知できない）
  readonly checkedAt: Date;
}

export interface RefundInput {
  readonly providerRef: string;
  readonly idempotencyKey: string;
  readonly money: Money;          // 全額返金でも明示する
  readonly reasonKey: string;
}
export interface RefundResult { readonly providerRefundRef: string; readonly observedStatus: ObservedStatus }

export interface PaymentProvider {
  readonly id: ProviderId;
  readonly detectionMode: DetectionMode;
  readonly capabilities: ProviderCapabilities;

  createCheckout(input: CreateCheckoutInput, ctx: ProviderContext): Promise<CheckoutResult>;
  /** raw 文字列と Headers を受け取る。呼び出し側で JSON.parse しない（P2） */
  parseWebhook(rawBody: string, headers: Headers, ctx: ProviderContext): Promise<ParsedWebhook>;
  getPaymentStatus(providerRef: string, ctx: ProviderContext): Promise<PaymentStatusResult>;
  refund(input: RefundInput, ctx: ProviderContext): Promise<RefundResult>;
}

// 例外
export class ProviderNotEnabledError extends Error {}  // ゲート未通過・フラグOFF
export class NotSupportedError extends Error {}        // refund: "none" など（P7）
export class SignatureVerificationError extends Error {}
export class AmountMismatchError extends Error {}
```

### 6-2. レジストリ（ゲートの最終防御）

```ts
// src/payments/registry.ts
export async function resolveProvider(id: ProviderId): Promise<PaymentProvider> {
  if (id !== "manual") {
    if (flags.get("PAYMENTS_ENABLED") !== "true") throw new ProviderNotEnabledError(id);
    const gates = await requiredGatesFor(id);            // compliance_gate を読む
    if (!gates.every(g => g.status === "passed" || g.status === "n/a"))
      throw new ProviderNotEnabledError(id);
    if (flags.get(`PROVIDER_${id.toUpperCase()}_MODE`) === "off")
      throw new ProviderNotEnabledError(id);
  }
  return REGISTRY[id];
}
```

このチェックは `createCheckout` / `refund` / Webhook 登録のすべての入口に置く。UI のボタン非表示は補助であり、これが正。

### 6-3. 初期アダプタ

**初期アダプタ（Phase 1 で実装する唯一のアダプタ）: `ManualConfirmationAdapter` — 手動確認（非自動）**

```ts
export const ManualConfirmationAdapter: PaymentProvider = {
  id: "manual",
  detectionMode: "manual_only",           // ← 手動確認（非自動）
  capabilities: { webhook: false, webhookSignature: false, refund: "none",
                  payerIdentity: false, settlementDelayHint: "即時（アプリは検証しない）" },

  async createCheckout(input) {
    // 支払い手段の案内のみを返す（例: 幹事のPayPay受け取りリンク／口座情報）。
    // アプリは「支払われたこと」を一切検証しない。
    return { kind: "manual_instruction", instructionKey: "manual.transfer",
             providerRef: input.providerRef };
  },
  async parseWebhook() { throw new NotSupportedError("manual: webhook なし"); },
  async getPaymentStatus(ref) {
    // 常に unknown を返す。呼び出し側が自動で paid に進めることを構造的に不可能にする。
    return { providerRef: ref, observedStatus: "unknown", money: null,
             payerRef: null, checkedAt: new Date() };
  },
  async refund() { throw new NotSupportedError("manual: 返金は事業者外で行う"); },
};
```

このアダプタを採るときの UI 規律（引継ぎ書 §7 と調査 §7-3 の禁止事項に従う）:

- 幹事画面のバッジは「支払済み」ではなく **「支払済み（幹事が手動で確認）」** と表示する。
- 参加者の自己申告・スクリーンショットを入力として受け付けるフォームを**作らない**。確認するのは常に幹事本人であり、その操作は `audit_log` に `actor_type='organizer'` で残る。
- アプリの説明文・ヘルプ・リリースノートのどこにも「自動でチェックが付く」と書かない。

**ゲート通過後に実装する最初の自動アダプタ: `PayPayOnlineAdapter`（`detectionMode: "automatic"`, `webhookSignature: false`）。** サンドボックス（`env: "STAGING"`）で先に作り、`PROVIDER_PAYPAY_ONLINE_MODE=sandbox` で本番環境に出しても本番決済が起きない状態を先に作る。

---

## 7. 状態遷移と例外

### 7-1. 正常系（自動アダプタ）

```
 [draft 0]
    │ 幹事が請求を発行
    ▼
 [issued 10] ──(期限超過 / 幹事がキャンセル。rank<40 のときのみ)──> [canceled|expired 15]
    │ 参加者が支払いを開始（createCheckout / payment_attempt 作成）
    ▼
 [checkout_pending 20]
    │            ├─(事業者 AUTHORIZED)──> [authorized 30] ─(COMPLETED)─┐
    │            ├─(事業者 FAILED / CANCELED)──> attempt=failed、invoice は 20 のまま
    │            │   （参加者は新しい attempt を作って再試行できる）
    │            └─(EXPIRED / 期限超過)──> [expired 15]（rank<40 のときのみ）
    ▼                                                                   │
 [paid 40] <────────────────────────────────────────────────────────────┘
    │  ※ 到達経路は2つ: (a) Webhook + 再照会で確定  (b) 幹事の手動確認（非自動）
    │
    ├─(幹事が入金を確認して記録。非自動)──> [settled_reported 50]
    └─(返金確定)──> [refunded 60]
```

すべての遷移は `WHERE status_rank < :new` を伴う。Webhook が逆順で届いても `paid` が `checkout_pending` に戻ることはない。

### 7-2. 例外の扱い

| 例外 | 扱い |
|---|---|
| **失敗** | `payment_attempt.status='failed'`。invoice は前進しない。参加者に「もう一度お試しください」を表示し、新しい `provider_ref` で attempt を作り直す。同じ `provider_ref` を再利用しない |
| **キャンセル** | 事業者 CANCELED は attempt のみ canceled。幹事によるイベント/請求のキャンセルは `rank<40` のときだけ rank 15。**支払い済みをキャンセルで消さない**（返金フローへ誘導） |
| **二重払い** | 同一 invoice に対し2つ目の attempt が succeeded になった場合: invoice は `paid` のまま（代入的更新なので二重計上は起きない）。2件目の attempt を `duplicate_overpay` にし、`outbox` に `notify_alert` を積み、幹事画面に「返金が必要な重複入金があります」を出す。**返金の実行は幹事の明示操作**。運営者は返金原資を持たない（L4） |
| **返金** | `refund()` を呼べるのは organizer のみ。アダプタが `refund: "none"` / `"once_per_order"` の場合は `NotSupportedError` を 422 で上位へ（P7）。返金確定の Webhook で rank 60。**部分返金に対応しない事業者では「一部返金」UI を出さない** |
| **遅延** | 決済完了と幹事への入金は別物。幹事画面は「支払済み（決済完了）」と「入金予定」を**別カラム**で表示する（P6）。入金予定は `settlementDelayHint` による表示であり確定値ではないと注記する |
| **代理払い** | 事業者APIは支払者を返さない前提（P9）。参加者ごとに個別の `provider_ref` を発行しているので「どの請求が払われたか」は分かるが「誰が払ったか」は分からない。幹事が「A さんの分を B さんが払った」を手動で記録する `proxy_payer_note` を invoice に持ち、**監査ログに残す**。アプリが自動判定することはない |
| **署名不一致** | 400 を返し、状態を一切変えない。`audit_log` に記録し、5分間に5件以上でアラート |
| **金額不一致** | 200 を返す（事業者にリトライさせない）が状態は変えない。`process_result='rejected_amount_mismatch'`、幹事と管理者の双方にアラート |
| **未知の provider_ref** | 200＋`rejected_unknown_ref`。他の幹事の決済が誤って届いた可能性があるのでアラート |
| **イベント中止** | 幹事が一括返金を実行。全額返金できない事業者では「返金は事業者側の制約で一部できない」ことを幹事に先に提示してから実行させる |

---

## 8. フェーズ分割とマイルストーン

### Phase 0 — 事業者照会・法務ゲート（コードを書かない。Phase 1 と並行可）

| # | 作業 | 宛先 | 参照 |
|---|---|---|---|
| 0-1 | PayPay へ商材照会（会費徴収は取扱可能商材か／オンライン加盟店に非実店舗の個人事業主は申込可か／Webhook 署名の有無／支払者識別の可否） | PayPay 加盟店窓口 | 調査 §5-1 質問1〜7 |
| 0-2 | LINEヤフーへポリシー照会（集金台帳は禁止業種に当たらないか／現実世界の役務の集金にアプリ内課金必須条項が及ぶか／第三者間の集金仲介の審査評価） | LINEミニアプリ審査窓口 | 調査 §5-3 質問1〜3 |
| 0-3 | 弁護士へ照会（2条の2柱書「他の者に受け入れさせ」の射程／第3号ロ・ニ／幹事の決済アカウントへのAPIアクセスは資金の受入れへの関与か／幹事画面への支払状況表示は第三者提供か） | 資金決済法・フィンテック分野の弁護士。必要ならグレーゾーン解消制度 | 調査 §5-4 質問1〜4, 7, 9 |
| 0-4 | PayPal へ照会（ビジネスアカウント要否・API資格） | PayPal | 調査 §5-5 |
| 0-5 | 回答を `compliance_gate` に証跡URI付きで記録 | — | §4-2 |

**Phase 0 の完了条件:** 下記の必須ゲートがすべて `passed` または `n/a` で、`evidence_uri`（回答メール・書面の保管先）と `decided_at` が入っていること。1つでも `unknown` / `inquired` / `failed` が残る間は Phase 2 に進まない。

| gate_key | 内容 | 必須フェーズ |
|---|---|---|
| `GATE-PP-MERCHANDISE` | 会費徴収が PayPay オンライン決済の取扱可能商材である | phase2 |
| `GATE-PP-ONBOARD` | 幹事が加盟店申込できる（必要書類が確定している） | phase2 |
| `GATE-PP-WEBHOOK` | Webhook の署名有無・リトライ・ペイロード定義が確定している | phase2 |
| `GATE-LINE-POLICY` | 集金台帳がミニアプリポリシー上許容される | phase1 |
| `GATE-LEGAL-FUNDS` | 本資金フローが資金移動業登録を要しないとの弁護士所見がある | phase2 |
| `GATE-LEGAL-PII` | 幹事への支払状況開示の法的整理と同意文言が確定している | phase1 |
| `GATE-CRED-CUSTODY` | 幹事の加盟店資格情報を運営者が保管することの法的・契約的評価 | phase2 |

**注:** `GATE-LINE-POLICY` と `GATE-LEGAL-PII` は Phase 1（決済なし）のリリースにも必要とする。名簿と支払状況の表示自体が個人情報の第三者提供論点を持つため、決済がなくてもここは通す。

### Phase 1 — 決済非依存コア（決済を1行も呼ばない）

作るもの: LINEミニアプリ（未認証）／LIFF 初期化とIDトークン検証／自前セッション／イベント作成・名簿登録・請求発行／`shareTargetPicker` による配布と QR・URLコピーのフォールバック／参加者の self-claim／`ManualConfirmationAdapter`／幹事の手動確認 UI（非自動ラベル付き）／`audit_log` の全面適用／Webhook 冪等基盤の**骨組みだけ**（テーブル・ハンドラ・テスト。ルートは 404 を返す）／`compliance_gate` と `feature_flag` の管理画面。

**完了条件（すべて実行して結果を出す。宣言だけでは完了としない）:**

1. E2E（Playwright + `@line/liff-mock`）が green: 幹事がイベントを作り、参加者3名を登録し、`shareTargetPicker` のフォールバック経路でリンクを配り、参加者が claim して自分の請求を見て、幹事が手動で支払済みにする。
2. 参加者セッションで他人の invoice に `GET` すると 404 が返る（IDOR テスト）。
3. すべての状態変更に対応する `audit_log` 行が存在し、`row_hash` の連鎖が検証スクリプトで通る。
4. `PAYMENTS_ENABLED=true` にしたうえで必須ゲートが `passed` でない状態で `POST /api/invoices/:id/checkout` を叩くと 409 `gate_not_passed` が返る（**このテストを CI 必須にする**）。
5. `npm ls` に決済事業者SDKが1つも含まれていない。
6. `vercel.json` の `regions` が `["hnd1"]`。
7. `GATE-LINE-POLICY` と `GATE-LEGAL-PII` が `passed`。

### Phase 2 — 自動アダプタ（ゲート通過したプロバイダのみ）

作るもの: `PayPayOnlineAdapter`（サンドボックス → 本番）／Webhook ルートの有効化／再照合ジョブ／幹事の provider_account 接続フロー（封筒暗号化）／返金／二重払い検知と幹事へのアラート／入金予定カラム。

**完了条件:**

1. Phase 0 の phase2 必須ゲートがすべて `passed`。
2. 重複配信・逆順配信・署名不一致の3テストが green（調査 §6-5 I5）。逆順テストは COMPLETED → AUTHORIZED の順で流して `paid` が維持されることを確認する。
3. Webhook を1件も届かせずに再照合ジョブだけで `paid` に到達できることを確認（取りこぼし回復の証明）。
4. 金額を1円ずらした Webhook が `rejected_amount_mismatch` になり、状態が変わらないこと。
5. サンドボックスでの一連の実行後、**本番で実弾1件**（少額）を通し、幹事の受取口座への着金までを人間が確認して `compliance_gate` とは別の運用記録に残す。
6. `PROVIDER_PAYPAY_ONLINE_MODE` を `off` に戻すと、既存の pending 決済の再照合は続くが新規 checkout が 409 になること（キルスイッチの動作確認）。

### Phase 3 — 運用

認証済ミニアプリの審査申請／サービスメッセージによる支払完了通知と催促（審査通過後）／Messaging API による催促の代替／2本目のアダプタ（PayPal または PAY.JP）／複数イベント横断台帳／監査ログのエクスポートと保全（PITR、外部ストレージへの日次エクスポート）／`BankReconciler` の評価（候補E）／pnpm 環境の修復。

**完了条件:** 認証審査の結果が出ていること（合否いずれでも、合なら機能を有効化、否なら Messaging API へフォールバック）。監査ログの日次エクスポートが7日連続で成功していること。2本目のアダプタが同じ契約テストスイート（§9）を通ること。

---

## 9. テスト戦略

| 層 | 対象 | 手段 |
|---|---|---|
| ユニット | 状態遷移の単調性（`status_rank` 述語）、冪等キーの衝突判定、署名検証、金額突合、`ManualConfirmationAdapter` が常に `unknown` を返すこと、ゲート未通過で `ProviderNotEnabledError` が出ること | Vitest。DB を使わない純関数に切り出す |
| 契約テスト | **すべての `PaymentProvider` 実装が通らなければならない共通スイート。** 「`createCheckout` は同じ `idempotencyKey` で同じ `providerRef` を返す」「`parseWebhook` は改変された raw を拒否する」「`getPaymentStatus` は未知の ref に対して例外ではなく `unknown` を返す」など | Vitest。アダプタを追加するたびにこのスイートを走らせる |
| 統合 | Webhook の**重複・逆順・署名不一致**の3本（調査 §6-5 I5）。加えて、金額不一致、未知 ref、再照合による取りこぼし回復、advisory lock による多重起動防止 | Vitest ＋ `supabase start` のローカル Postgres。保存済み fixture を再生。Stripe を評価する場合は `stripe trigger` / `stripe events resend`（ローカルに stripe CLI あり） |
| セキュリティ | IDOR（他人の invoice へのアクセス）、token の総当たり耐性、CSRF（Webhook 以外の POST）、ゲート迂回（フラグ ON でもゲート未通過なら 409）、ログに資格情報・生の userId・生IPが出ていないこと（ログ出力を grep するテスト） | Vitest ＋ CI 必須 |
| E2E | 幹事フロー・参加者フロー・手動確認フロー。Phase 2 以降はサンドボックス決済を含む往復（`returnUrl` で戻ってきて `GET /api/invoices/:id/status` が1回だけ照会すること） | Playwright ＋ `@line/liff-mock`。`liff.use(new LiffMockPlugin())` + `liff.init({mock:true})` を**環境変数で切り替え、動的 import で本番バンドルに入れない**（調査 §6-5 I4）。`vi.mock` は実ブラウザで効かないので使わない |
| 決済サンドボックス | PayPay: `env: "STAGING"`（`apigw.sandbox.paypay.ne.jp`）。**加盟店審査の前から使えるので Phase 0 の照会待ち中に進める**（調査 §6-5 I6）。Stripe（評価する場合のみ）: `stripe listen --forward-to` で署名シークレット付きのローカル転送 | — |
| 手動確認経路のテスト | `ManualConfirmationAdapter` を使うイベントで、**どの API 経路からも `paid` に自動遷移しない**ことを網羅的に確認する（Webhook ルート無効、`getPaymentStatus` が `unknown`、`manual-mark` のみが唯一の到達経路） | Vitest。これは「手動版を自動版と誤認させない」ための回帰テスト |

CI のゲート: typecheck → lint → unit → contract → integration（supabase local）→ security → build。E2E は PR で選択実行、main へのマージでは必須。

---

## 10. 費用概算（すべて未確定）

**この節の数値はいずれも確定見積もりではない。** 決済手数料・入金条件は調査上「確信度 低・未検証」であり、事業者への照会前である。

| 項目 | 概算 | 確度 |
|---|---|---|
| Vercel Pro（Phase 2 以降。分単位 cron に必要） | $20/月程度 | 公表価格だが本件で未確認 |
| Supabase（Phase 1 は Free、Phase 2 以降 Pro） | $25/月程度 | 同上。東京リージョンの可用性・料金は未確認（調査 §5-5） |
| ドメイン | 年数千円 | — |
| LINEミニアプリのプラットフォーム利用料 | **不明。無料かどうか未確認**（調査 §5-3 質問6） | 未確認 |
| 弁護士照会 | **不明。** 数万〜数十万円のレンジと想定されるが見積取得前 | 未確認 |
| 決済手数料（PayPay オンライン・物販） | 3.8%（調査 §4-3、確信度 低）。会費5,000円なら190円/人 | 未検証 |
| 不審請求申し立て等 | 事業者による | 未確認 |

**幹事の負担:**

- 金銭: 決済手数料（5,000円×10人で約1,900円）。**参加者への上乗せ請求はしない設計**（P5、PayPay 加盟店規約の禁止条項の可能性。確信度 低）。会費に内包するか幹事が飲み込むかを幹事が選ぶ。
- 手間: 加盟店申込（審査2週間〜1カ月＋利用開始5営業日。未検証）と必要書類の提出。**これが本案の最大の離脱要因。**
- 時間差: 入金が月末・月1回（未検証）。当日の立て替えは解消しない。

**参加者の負担:** 0円（手数料上乗せなし）。LINE アプリ以外のインストール不要。氏名以外の個人情報の入力なし。

**比較の正直な提示:** LINE のトークから PayPay の送金・割り勘を使えば手数料0円（調査 §4-5）。本アプリは「名簿・複数イベント横断の台帳・21名以上・催促・記録」の対価として手数料を払ってもらう構造であり、送金そのものの価格競争では勝てない。この事実を幹事向けの説明に明記する。

---

## 11. この案で満たせない要件・弱点

正直に列挙する。

1. **引継ぎ書の当初希望「幹事の個人PayPayで受け取る」を満たさない。** 受取先は幹事の加盟店売上（口座）になる。調査 §7-1 の通り、「参加者ごとの自動検知」「個人PayPay受取」「幹事が非事業者のまま」の3条件を同時に満たす経路は一次資料の範囲で存在しない。本案は条件2（受取先）と条件3（非事業者のまま）の両方を落としている。**この変更にはユーザーの明示的な同意が必要であり、同意が得られなければ本案は成立しない。**
2. **幹事の加盟店資格情報を運営者が保管する構造的リスク。** PayPay には Stripe Connect OAuth のような接続の仕組みが公開ドキュメント上に見当たらないため、幹事の API キー／シークレットをアプリが預かることになる。封筒暗号化・復号のメモリ限定・ログ禁止・監査ログ化で緩和するが、**「運営者は資金に触れないが、幹事の決済アカウントを操作しうる鍵は持つ」という状態は消せない。** これが「資金の受入れへの関与」と評価されるかは調査 §5-4 質問7 の通り未解決である。読み取り専用権限が発行できるなら第一に採用するが、可否は照会前。
3. **代理払いを自動で追えない。** 事業者APIが支払者を返さない（P9）。幹事の手動記録に依存する。引継ぎ書 §7 の「代理払いを追える」は、監査ログ上の追跡までは満たすが自動検知は満たさない。
4. **入金遅延は解決しない。** 月末・月1回（未検証）。「決済完了」と「入金予定」を分けて表示することで期待値の破綻は防ぐが、当日の立て替え負担そのものは残る。
5. **Phase 0 の所要時間を自分で決められない。** 事業者・弁護士の回答待ちがクリティカルパスであり、回答が来ないと Phase 2 に入れない。Phase 1 を並行で進められるようにしてあるが、リリース日は約束できない。
6. **2026年夏以降の LINE×PayPay 連携に対する競合劣位。** LINE のトーク上で PayPay の送金と「グループ支払い」割り勘が使えるようになる（調査 §4-5、確信度 低・未検証だが複数レポートで一致）。手数料0円の本体機能に対し、本アプリは手数料3.8%。残る客観的な隙間は「グループトークでは同じ金額の請求のみ対応可能」という制約（調査 §3-7）と、名簿・複数イベント横断の台帳。**本案は決済の自動化に資源を割く設計なので、この差別化軸に対しては直接には効かない。**
7. **未認証ミニアプリで始めるため、Phase 2 までは未払い者への通知が送れない。** サービスメッセージは認証済限定かつ「ユーザーの操作への確認・応答」限定（調査 §6-4 N10）。催促は幹事が LINE で手動シェアするしかない。
8. **`ManualConfirmationAdapter` で Phase 1 をリリースする場合、その時点では引継ぎ書の中心要件を満たしていない。** 「名簿は作れるが自動チェックはまだ」という状態での公開になる。これを「自動チェックができる」と説明することは禁止（調査 §7-3）。
9. **監査ログの改ざん耐性は論理的なものに留まる。** ルールとハッシュ連鎖で UPDATE/DELETE を拒否するが、DB の管理者権限を持つ者（＝運営者本人）による改変を技術的に阻止できるわけではない。WORM ストレージへの日次エクスポート（Phase 3）で緩和するが、完全ではない。
10. **「幹事が非事業者のまま」を求めるユーザー層を初期スコープから外す。** 調査の候補E（楽天銀行＋電代業）だけがこの層に届くが、電代業登録のリードタイムと振込依頼人名の誤照合リスクを Phase 1・2 に持ち込みたくないため採らない。結果として、ターゲットは「サークル・部活・教室・コミュニティの継続的な主催者」に寄り、**「今夜の飲み会の幹事」には届かない。**
11. **Stripe を保留にしたため、クレジットカード／Apple Pay／Google Pay での集金が Phase 2 の範囲に入らない。** PayPay 単独では支払い手段が1つしかなく、PayPay を使わない参加者は手動確認経路に落ちる。
12. **pnpm 破損を修復しないまま進める。** npm で問題は出ない想定だが、将来 monorepo 化する場合に手戻りが出る可能性がある（Phase 3 の課題）。

---

## 付録: 本案が依存している未検証事実（実装着手前に再確認する）

| 依存事実 | 調査での確信度 | 再確認先 |
|---|---|---|
| PayPay オンライン決済の申込に実店舗要件がない | 中 | PayPay（§5-1 質問3） |
| 会費徴収が NG商材でない | **未照会** | PayPay（§5-1 質問1〜2） |
| PayPay Webhook の署名検証の有無 | 低 | PayPay（§5-1 質問5） |
| PayPay オンラインの手数料3.8%・月末入金 | 低 | PayPay |
| PayPay 加盟店規約（オンライン）第4条第3項の手数料上乗せ禁止 | 低 | PayPay |
| LINEミニアプリのプラットフォーム利用料 | 未確認 | LINEヤフー（§5-3 質問6） |
| 現実世界の役務の集金にアプリ内課金必須条項が及ばないこと | 未確認 | LINEヤフー（§5-3 質問2） |
| ミニアプリの内部チャネルごとに LINE Login チャネルID が異なるか（`aud` の許可リスト設計） | 未確認 | LINE 開発者ドキュメント / 実機確認 |
| Supabase 東京リージョンの可用性・料金 | 未確認 | Supabase |
| PayPal のビジネスアカウント要否・API 資格 | 低（一次資料取得失敗） | PayPal |
| 資金移動業登録の株式会社要件 | 低 | 弁護士 |
