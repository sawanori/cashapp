# アーキテクチャ案 C — 「台帳が製品、決済事業者はプラグイン」

起案日: 2026-09-24 / 起案: シニアアーキテクト（観点: Extensibility-first）
入力: 引継ぎ書、ローカル環境メモ、調査統合レポート（consolidated.md）
本案は独立起案であり、案A・案Bは参照していない。

---

## 0. この案の一行要約と、外さない前提

**中核資産を「決済事業者に一切依存しない請求台帳（ledger）と照合（reconciliation）」に置き、決済事業者はいつでも差し替え・並列運用できるアダプタとして外付けする。第一の自動アダプタは PayPay オンライン加盟店、第二は PAY.JP、加えて「自動ではない」と明示ラベルの付く手動確認アダプタを同じ台帳上に載せる。**

この案が外さない前提（consolidated.md §6 の制約条件に直結）:

- 資金は運営者（NonTurn LLC）の口座・決済アカウントを**一切経由しない**（L1）。参加者 → 決済事業者 → 幹事名義アカウント。アプリは照会と台帳反映のみ。
- 前払い専用（L2）。立替精算モードは実装しない。
- アプリ内残高・チャージ・ポイントを作らない（L3）。返金原資を運営者が持たない（L4）。
- 決済事業者は**まだ一社も照会していない**。本書の「第一候補・第二候補」は、照会が通った場合に採る順序であって、採用の確定ではない（§1-4）。
- 「自動チェックできない経路」を自動チェックできたと説明しない。手動確認アダプタは UI・API・台帳のすべてで `autoDetect=false` を持ち回る（§6-4）。

---

## 1. 採用する資金フローと決済事業者の第一候補・第二候補

### 1-1. 採用する資金フロー: 候補A/C/D型（幹事名義の決済アカウントが受取人、運営者は資金に触れない）

consolidated.md §2 の候補表のうち **A（PayPayオンライン加盟店）/ C（PAY.JP）/ D（PayPal）が共有する構造**を採る。すなわち:

```
参加者 ──支払──▶ 決済事業者（幹事名義の加盟店アカウント）──入金──▶ 幹事の銀行口座
                      │
                      └─Webhook / 照会API─▶ 本アプリ（台帳に記録するだけ・資金には触れない）
```

この構造を選ぶ理由は3つある。

1. **法務の最重要軸（運営者が資金に触れるか）を、設計ではなく構造で外せる。** 資金決済法2条の2柱書の「弁済として資金を受け入れ、又は他の者に受け入れさせ…引き渡す」の射程は弁護士照会事項（§5-4 Q1）として未確定だが、少なくとも運営者が受入れ・保管・引渡しのいずれも行わない構成は、候補F（収納代行）と比べて論点が1段階浅い。
2. **connpass / Doorkeeper という実運用の前例がある。** connpass は主催者の PayPal アカウントへ即時入金・自社手数料0円、Doorkeeper は主催者の Stripe アカウントへ直接入金。同一構造が日本で稼働している。
3. **アダプタ差し替えを前提にしたとき、この構造だけが事業者中立である。** 「運営者が集金して幹事へ送る」構造にすると、事業者ごとに送金側の実装（Connect の destination charge、KOMOJU のプラットフォーム機能など）が必要になり、アダプタ層が肥大化して差し替えコストが跳ね上がる。受取人を常に幹事にしておけば、アダプタが負う責務は「チェックアウトを作る・結果を正規化する」の2つに縮む。

**受取先が「幹事の個人PayPay残高」ではなくなる点は、引継ぎ書の当初希望からの変更である。** consolidated.md §7-1 のとおり「参加者ごとの自動検知」「受取先が個人PayPay」「幹事が非事業者のまま」の3条件は同時に満たせない。本案は条件3（非事業者のまま）を落とす。この変更はユーザーの明示同意事項であり、同意が得られない場合は §6-4 の手動確認アダプタ単独構成（＝自動チェックなし）へ縮退する。

### 1-2. 第一候補: PayPay オンライン加盟店（`paypay_online`）

**条件付き根拠（すべて consolidated.md 由来。統合者も本起案者も一次資料を再取得していない）:**

- `GET /v2/codes/payments/{merchantPaymentId}` による能動照会と、AUTHORIZED / COMPLETED / CANCELED / EXPIRED / EXPIRED_USER_CONFIRMATION / FAILED の Webhook が公式ドキュメントに実在（確信度 高）。
- `merchantPaymentId` は最大64文字・`[a-zA-Z0-9_-]` なので、`invoice_id` をそのまま外部参照キーに埋め込める（確信度 高）。これは「誰が払ったか」を決済事業者が返さない（§1-2 末尾参照）問題への唯一の回避策であり、第一候補の要件を満たす。
- Sandbox（`apigw.sandbox.paypay.ne.jp` / SDK の `env: "STAGING"`）が加盟店審査の前から使える（確信度 中）。**照会の回答を待つ間に実装検証を進められる唯一の事業者。**
- オンライン決済ルートには実店舗要件の記載がなく、加盟店規約の「加盟店」定義にも事業者要件が条文化されていない（確信度 中、反証検証済み）。
- 受取先として当初希望（PayPay）に最も近く、ユーザーへの説明コストが最も低い。

**未確認・go/no-go を左右する点:**

- 「商取引ではない寄付や募金、投げ銭（チップ）など一部NG商材」に**飲み会の会費徴収が当たるか**（§5-1 Q1・Q2）。これが NG なら第一候補は即座に脱落する。**照会1本で決まる。**
- Webhook に署名検証があるか（§5-1 Q5）。公開ドキュメントに記載がない。→ アダプタは `webhookSignature: 'none'` を宣言し、コアが必ず `getPaymentStatus` で再照会する設計にする（§6-3）。
- 決済詳細レスポンスに支払者識別フィールドがない（確信度 高、反証検証済み）。→ 参加者ごとに個別の `merchantPaymentId` を発行する以外の本人特定手段はない。代理払いは検知不能（§7-6）。
- 入金は月1回・月末（確信度 低・未検証）。審査2週間〜1カ月＋利用開始5営業日（確信度 低・未検証）。

### 1-3. 第二候補: PAY.JP（`payjp`）

**条件付き根拠:**

- 個人事業主も法人と同様に審査可。開業届がなければ確定申告書の控えや個人事業税納付証明書で代替可（確信度 中）。**調査した事業者の中で必要書類が最も軽い。** KOMOJU は非事業者を明示的に排除、Square は開業届または代替書類、Stripe は「何を売っているか」が審査対象。
- Webhook は `X-Payjp-Webhook-Token` ヘッダ付き、3分間隔で最大3回リトライ、`charge.succeeded` イベント（確信度 中）。**PayPay と異なり検証手段が明示されているので、`webhookSignature: 'token'` を宣言できる。**
- 国内事業者でカード決済を担う。PayPay（残高・QR中心）と決済手段が重ならず、**同一イベントで2アダプタを並列運用する価値がある**（参加者が手段を選べる）。これはアダプタ層の設計が正しいかを実地で検証する最良のテストケースでもある。

**未確認:**

- 加盟店規約本文が未取得。**個人間送金・立替精算の扱いが不明**（§5-5）。採用前に規約本文の取得と照会が要る。
- 手数料率が未確認。

### 1-4. 意図的に第三候補以降へ落とすもの

| 事業者 | 落とす理由 |
|---|---|
| **Stripe** | 規約が三重（SSA 1.2(a)(i) の personal/family/household 包括禁止・禁止業種「ピアツーピアの送金」・日本固有「Stripe Connect 外での C2C サービス」）。かつ「日本では Connect 必須」と「PayPay は Connect 非対応」が同時に成り立つ可能性がある（確信度 中）。**照会が最も重く、回答が最も遅い見込み。** 技術資料の充実は事実だが、それは採用理由にならない。 |
| **PayPal**（connpass 型） | 構造の前例としては最良だが、ビジネスアカウント要否と API 資格が未確認（一次資料の取得に失敗）。第三候補として温存し、PayPay/PAY.JP の両方が照会で落ちた場合の退避先にする。 |
| **楽天銀行＋電代業（候補E）** | 「幹事が非事業者のまま自動検知できる」唯一の経路だが、電子決済等代行業の登録または登録済み事業者との提携が前提でリードタイムが読めない。**本案ではアダプタ層と同じ抽象（`SettlementSource`）に載る設計だけ用意し、Phase 3 以降**（§8）。 |
| **収納代行（候補F）** | L1 違反。初期スコープ外。 |

**重ねて明記する。決済事業者への照会は1件も行っていない。** PayPay・PAY.JP・PayPal・Stripe のいずれからも回答を得ていないので、本節の順序は「照会の順序」であって「採用の順序」ではない。Phase 0（§8）を通過しない限り、どのアダプタも本番クレデンシャルを持たない。

---

## 2. 技術スタック

ローカル実測（node v22.22.0 / npm 10.9.4 / **pnpm は corepack シム破損で起動不可** / supabase CLI 2.58.5 / Vercel CLI 50.17.0 / gh 認証済 / **wrangler 未インストール** / stripe CLI あり）を前提に選ぶ。

| 層 | 採用 | 理由 | 不採用にしたもの |
|---|---|---|---|
| パッケージマネージャ | **npm 10.9.4** | 実測で動くのは npm のみ。pnpm 復旧を初期タスクの前提条件に置かない | pnpm（corepack シム破損。復旧は Phase 1 の任意タスクに落とす）、yarn（未検証） |
| フレームワーク | **Next.js 15 App Router / TypeScript** | Route Handler の `await request.text()` が生本文を返す（W2 の署名検証要件を追加設定なしで満たす）。LIFF は SPA で動かすので App Router のクライアントコンポーネント境界で足りる | SvelteKit / Remix（Vercel との統合実績で劣る、チームの既存知見なし） |
| ホスティング | **Vercel（`vercel.json` に `"regions": ["hnd1"]` を最初から明記）** | CLI 実測済み。既定 `iad1` のままだと日本のレイテンシと Supabase Tokyo との往復が悪化（I1） | Cloudflare Workers（wrangler 未インストール、HTTPリクエストあたりCPU時間が Free 10ms。照合ジョブが収まらない）、自前 VPS（運用要員なし） |
| DB | **Supabase Postgres（Tokyo / ap-northeast-1）** | supabase CLI 実測済みでローカル Postgres を統合テストに流用できる。台帳の整合性を DB 制約（部分一意インデックス・CHECK・`for update`・advisory lock）で担保する方針に Postgres が必須 | PlanetScale（外部キー制約の扱い）、Turso/SQLite（advisory lock と JSONB） |
| ORM | **Drizzle ORM** | 台帳の整合性を DB 制約で保証する方針なので、マイグレーションが生 SQL として読めることが要件。部分一意インデックス・`insert ... on conflict do nothing returning`・`select ... for update` をそのまま書ける | Prisma（生成クライアント経由で `on conflict do nothing returning` を書きにくく、台帳の冪等性が ORM の抽象に隠れる）、生 pg（型安全性を捨てる理由がない） |
| 認証 | **LINE IDトークンをサーバー検証 → 自前セッション（httpOnly Cookie / HS256 JWT）** | §3 で詳述。Supabase Auth を使わない | Supabase Auth Custom OIDC Provider（2026-04-08 GA だが `signInWithOAuth` のリダイレクト往復が前提で LIFF の中では体験が壊れる。custom provider での LINE サインイン成立の公式事例が無い＝§5-5 の未確認事項。MVP で未検証経路を持ち込まない） |
| DBアクセス | **全アクセスをサーバー側 Route Handler 経由。MVP では RLS を使わない**（I3） | 参加者側から金額・状態を書き換えられないことを構造で保証する最短経路。ブラウザに DB クレデンシャルを一切渡さない | RLS + anon key 直アクセス（自前 JWT を Supabase の signing key で発行する追加工程が要り、MVP の攻撃面を増やす） |
| 決済SDK | **アダプタ内に閉じる。PayPay は公式 Node SDK（`paypayopa-sdk-node`）、PAY.JP は公式 Node ライブラリ** | SDK の型・例外はアダプタ境界を越えさせない（§6）。PayPay 公式 SDK は README 記載13メソッドに対し実装27メソッドで、README を仕様書として扱わない | 各 SDK をアプリ全体で直接使う（差し替え不能になる。本案の否定） |
| 決済SDK の逃げ道 | PayPay SDK が塞ぐエンドポイントは **`fetch` 直叩き＋自前型**で実装してよい | 公式 README に「SDK のメンテナンスは限定的で、新機能は API レベルで直接追加される」と PayPay 自身の注記がある | SDK 未対応を理由に機能を諦める |
| テスト | **Vitest（ユニット）/ supabase CLI のローカル Postgres（統合）/ Playwright + `@line/liff-mock`（E2E）/ 自作 ProviderConformanceKit** | §9 で詳述 | Jest（ESM 周りの設定コスト）、Testcontainers（supabase CLI が既にあるので二重） |
| CI | GitHub Actions（gh CLI 認証済み） | typecheck / lint / unit / integration / ProviderConformanceKit を PR ゲートに | — |

**Stripe CLI の位置づけ（重要）:** ローカルに stripe CLI があるが、**Stripe を採用しない以上、`stripe trigger` は PayPay/PAY.JP アダプタのテストには使えない。** 重複・逆順・署名不一致の再現は §9 の自作 ProviderConformanceKit で事業者非依存に行う。Stripe CLI の存在を理由に Stripe を第一候補に繰り上げない。

---

## 3. LINEミニアプリ統合

### 3-1. チャネル構成（最初に確定し、後から変えない）

```
プロバイダー: NonTurn LLC（1つ。userId はプロバイダー単位で共通なので分割不可・後から移動不可）
 ├─ LINEミニアプリチャネル（内部に 開発用 / 審査用 / 本番用 の3チャネル、各々 別 LIFF ID・別エンドポイントURL）
 └─ Messaging API チャネル（LINE公式アカウント。Phase 3 の催促用。同一プロバイダー配下に必須）
```

- Scope と友だち追加オプションは内部チャネル間で変更できない（N6）。**権限設計は Phase 1 着手時に一度で決める**: `profile` + `openid`。それ以上は要求しない。
- `LIFF_ID` は環境変数 3系統（`LIFF_ID_DEV` / `LIFF_ID_REVIEW` / `LIFF_ID_PROD`）で切り替える。

### 3-2. LIFF 初期化とセッション

```
ブラウザ（LIFF）                          サーバー（Next.js Route Handler）
 liff.init({ liffId })
 liff.isLoggedIn() ? : liff.login()
 const idToken = liff.getIDToken()
        │  POST /api/auth/line  { idToken }
        ├──────────────────────────────▶ ① POST https://api.line.me/oauth2/v2.1/verify
        │                                    { id_token, client_id: LINE_LOGIN_CHANNEL_ID }
        │                                 ② レスポンスの sub / aud / exp / nonce を検証
        │                                 ③ organizer or participant を upsert（sub を line_user_id に）
        │                                 ④ 自前セッションJWT（HS256, 30分）を httpOnly / Secure /
        │                                    SameSite=None Cookie で発行
        ◀──────────────────────────────┘
 以後の API 呼び出しは Cookie のみ。期限切れ時に liff.getIDToken() から再取得
```

- **`liff.getDecodedIDToken()` / `liff.getProfile()` の結果をサーバーへ送らない**（N2）。フロントから送られたユーザーIDを信用して支払済みフラグを立てない。
- `client_id` は **LINE Login チャネルID**。LIFF ID でも Messaging API チャネルIDでもない（N3）。
- 検証経路は公式に3つある（verify エンドポイント / 自前 JWT 署名検証 ES256+JWKS / アクセストークン経路）。**MVP は verify エンドポイント一択**にして実装を1本に絞る。JWKS キャッシュの自前管理は Phase 3 の最適化候補。
- セッションは Cookie に置くが、**支払状態・認証状態を localStorage に持たせない**（N7）。画面表示のたびにサーバーの台帳を取りに行く。
- 参加者の表示名は **IDトークンから取れる前提で作らない**（N12）。`participant.display_name` は幹事が入力した値を正とし、LINEプロフィール名は取得できたら補助表示に使うだけ。

### 3-3. 参加者への支払いリンク配布（`shareTargetPicker` 主導線＋必須フォールバック）

```
幹事が「参加者に送る」を押す
 ├─ liff.isApiAvailable('shareTargetPicker') === true
 │    → liff.shareTargetPicker([Flex Message: イベント名 / 金額 / 「支払う」ボタン(参加者別URL)])
 │      ※ 友だちのプライバシー設定で一部の友だちが表示されないため、これ単独に依存しない（N8）
 ├─ フォールバック1: 参加者別URLの一括コピー（改行区切りテキスト）
 ├─ フォールバック2: イベント参加用URLのQRコード表示（対面で読ませる）
 └─ フォールバック3: イベント参加用URL（参加者が自分で名前を選ぶ画面へ）
```

- `liff.sendMessages()` は集金導線で使えない前提（N9。トークルームから起動された LIFF でのみ動作、それ以外は403）。実装しない。
- 参加者別URLは `invite_token`（128bit ランダム、推測不能）を含む。**`invoice_id` を URL に露出させない。**
- 外部ドメインへ出るのは決済画面だけ。名簿・支払状況・イベント管理は**ミニアプリのエンドポイントドメイン内で完結**させる（N4）。
- 決済完了後の `returnUrl` は**ミニアプリのパーマネントリンク**に固定（P4）。`createCheckout` の `returnUrl` は型上も必須項目にする（§6）。
- SPA ルーティングは History API ベース、エンドポイントURLは https のみ・フラグメント不可（N5）。

### 3-4. 未認証ミニアプリで始める

**Phase 1・Phase 2 は未認証ミニアプリで本番リリースする。** 根拠と対価:

| | 未認証で可 | 認証済が要る |
|---|---|---|
| 決済（外部決済） | ✅（日本は「その他の決済方法」のみ実質使える） | — |
| 友だち追加誘導 / カスタムアクションボタン | ✅ | — |
| 名簿・請求・台帳の全機能 | ✅ | — |
| 運営主体 | 日本の個人も可 | 日本の法人番号がある組織 or 個人事業主（NonTurn LLC は可） |
| サービスメッセージ（支払完了通知・催促） | ❌ | ✅ |
| LINE内検索・ホームタブ掲載 | ❌ | ✅ |
| Custom Path / ホーム画面ショートカット / ヘッダーへのアプリ名表示 | ❌ | ✅ |
| アプリ内課金 | 開発・審査用でのみ動作 | ✅（消耗型デジタルコンテンツ限定。本アプリでは使わない） |

未認証で始める理由は、**認証審査（1〜2週間、確信度 低）を Phase 1 のクリティカルパスから外せる**こと。認証審査は Phase 3 の入口に置き、その時点で必要になるのはサービスメッセージ（支払完了通知・催促）と流入（LINE内検索・ホームタブ）だけである。

### 3-5. 審査対応

- **サービス定義を「幹事が管理する精算・集金の台帳」に統一する**（N11）。ポリシー禁止業種「募金、寄附、クラウドファンディング等の資金調達」および禁止事項「チャリティまたは募金として寄付金を収集する目的の内容」の文脈を、画面文言・ストア説明・スクリーンショットのすべてから排除する。「支援」「応援」「投げ銭」「カンパ」という語を用語辞書レベルで禁止し、CI の文言 lint でブロックする。
- 催促は**サービスメッセージで送れない前提**で設計する（N10）。Phase 1〜2 の催促は「幹事が未払い者一覧を `shareTargetPicker` で手動シェア」。Phase 3 で Messaging API（通数課金）または認証審査＋サービスメッセージを検討する。
- 認証審査申請の前に §5-3 の照会（特に Q1「会費徴収は禁止業種に当たるか」、Q2「現実世界の役務の集金にアプリ内課金が要るか」、Q3「第三者間の集金仲介が法令抵触の有無でどう評価されるか」）を LINEヤフーへ出す。**照会の回答を得ずに認証審査を申請しない。**

---

## 4. データモデル

設計方針: **`invoice.status` は誰も直接 UPDATE しない。** 支払いの事実は `payment_event`（外部由来・冪等）と `ledger_entry`（追記専用）にだけ書き、`invoice.status` / `status_rank` はその射影として単調に前進する。これにより、決済事業者を差し替えても・照合経路を増やしても、台帳の真実は1箇所にとどまる。

### 4-1. テーブル定義

```sql
-- 幹事
organizer(
  id              uuid PRIMARY KEY,
  line_user_id    text NOT NULL UNIQUE,      -- IDトークン検証済みの sub のみ
  display_name    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
)

-- 幹事が保有する決済事業者アカウントの紐付け。クレデンシャル実体は保持せず参照のみ
provider_binding(
  id              uuid PRIMARY KEY,
  organizer_id    uuid NOT NULL REFERENCES organizer(id),
  provider_key    text NOT NULL,             -- 'paypay_online' | 'payjp' | 'manual_confirm'
  credential_ref  text,                      -- 外部シークレットストアのキー名。値は入れない
  capabilities    jsonb NOT NULL,            -- アダプタが宣言した ProviderCapabilities のスナップショット
  status          text NOT NULL,             -- 'pending' | 'active' | 'suspended'
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organizer_id, provider_key)
)

-- 集金イベント
event(
  id                  uuid PRIMARY KEY,
  organizer_id        uuid NOT NULL REFERENCES organizer(id),
  title               text NOT NULL,
  currency            char(3) NOT NULL DEFAULT 'JPY',
  status              text NOT NULL,         -- 'draft'|'collecting'|'closed'|'canceled'
  collect_by          date,
  default_amount_minor integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (currency = 'JPY')                   -- L12: 初期スコープは国内限定
)

-- 参加者（LINEアカウントとの紐付けは任意。幹事が名前だけ登録した状態を正とする N12）
participant(
  id            uuid PRIMARY KEY,
  event_id      uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  display_name  text NOT NULL,               -- 幹事が入力した名前が正
  line_user_id  text,                        -- 参加者が自分で開いたときに紐付く
  invite_token  text NOT NULL UNIQUE,        -- 128bit ランダム。URL に載るのはこれだけ
  created_at    timestamptz NOT NULL DEFAULT now()
)
CREATE UNIQUE INDEX participant_event_line_uniq
  ON participant(event_id, line_user_id) WHERE line_user_id IS NOT NULL;
-- ↑ 同一イベントで同一LINEユーザーが二重登録されるのを防ぐ。イベント間で名簿が混ざらないことは event_id で担保

-- 請求（1参加者1請求。中心エンティティ）
invoice(
  id                  uuid PRIMARY KEY,
  event_id            uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  participant_id      uuid NOT NULL REFERENCES participant(id) ON DELETE CASCADE,
  amount_minor        integer NOT NULL CHECK (amount_minor > 0),
  currency            char(3) NOT NULL DEFAULT 'JPY',
  status              text NOT NULL,         -- §7 の状態名
  status_rank         smallint NOT NULL,     -- §7 のランク。単調前進のみ
  auto_detected       boolean NOT NULL DEFAULT false,  -- false = 自動検知ではない（UI バッジの根拠）
  paid_at             timestamptz,
  settled_at          timestamptz,           -- 幹事口座への入金確認。paid_at とは別（P6）
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, participant_id)
)
CREATE INDEX invoice_event_status ON invoice(event_id, status);
CREATE INDEX invoice_recon_scan   ON invoice(status, updated_at) WHERE status_rank < 40;
-- ↑ 照合ジョブは「時刻カーソル」ではなく「状態」で走査する（W9）

-- 支払い試行（1請求に複数。事業者を跨いで並列に持てる）
payment_attempt(
  id                  uuid PRIMARY KEY,
  invoice_id          uuid NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  provider_key        text NOT NULL,
  provider_binding_id uuid REFERENCES provider_binding(id),
  external_ref        text NOT NULL,         -- merchantPaymentId / charge id。invoice_id を埋め込む
  amount_minor        integer NOT NULL,
  currency            char(3) NOT NULL,
  status              text NOT NULL,         -- 'created'|'redirected'|'succeeded'|'failed'|'expired'|'canceled'
  checkout_url        text,
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_key, external_ref)        -- 事業者を跨いだ external_ref 衝突を防ぐ
)
CREATE INDEX payment_attempt_sweep ON payment_attempt(status, expires_at) WHERE status IN ('created','redirected');

-- 外部由来の支払イベント（冪等の要）
payment_event(
  id                  uuid PRIMARY KEY,
  provider_key        text NOT NULL,
  provider_event_id   text,                  -- 事業者のイベントID。無い事業者は NULL
  business_idem_key   text NOT NULL,         -- (対象オブジェクトID + イベント種別) の複合キー（W2）
  invoice_id          uuid REFERENCES invoice(id),
  attempt_id          uuid REFERENCES payment_attempt(id),
  kind                text NOT NULL,         -- 'authorized'|'succeeded'|'failed'|'canceled'|'expired'|'refunded'|'unknown'
  amount_minor        integer,
  currency            char(3),
  occurred_at         timestamptz,           -- 事業者側の発生時刻（順序判定には使わない W4）
  received_at         timestamptz NOT NULL DEFAULT now(),
  ingestion_source    text NOT NULL,         -- 'webhook'|'poll'|'manual'|'bank'
  trust               text NOT NULL,         -- 'verified'|'reverified'|'unverified'|'attested'
  raw                 jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
)
CREATE UNIQUE INDEX payment_event_provider_evt
  ON payment_event(provider_key, provider_event_id) WHERE provider_event_id IS NOT NULL;  -- W1
CREATE UNIQUE INDEX payment_event_business_idem
  ON payment_event(provider_key, business_idem_key);                                      -- W2
CREATE INDEX payment_event_invoice ON payment_event(invoice_id, received_at);

-- 台帳（追記専用。UPDATE / DELETE を権限で禁止）
ledger_entry(
  id                    uuid PRIMARY KEY,
  invoice_id            uuid NOT NULL REFERENCES invoice(id),
  event_id              uuid NOT NULL REFERENCES event(id),
  direction             text NOT NULL,       -- 'credit'（参加者→幹事）|'debit'（返金）
  kind                  text NOT NULL,       -- 'payment'|'refund'|'overpay'|'proxy_payment'|'adjustment'|'writeoff'
  amount_minor          integer NOT NULL,
  currency              char(3) NOT NULL,
  confidence            text NOT NULL,       -- 'provider_verified'|'provider_polled'|'bank_matched'|'organizer_attested'
  source_payment_event_id uuid REFERENCES payment_event(id),
  recorded_by           text NOT NULL,       -- 'system'|'organizer:<uuid>'
  memo                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
)
CREATE INDEX ledger_entry_invoice ON ledger_entry(invoice_id, created_at);
CREATE INDEX ledger_entry_event   ON ledger_entry(event_id, created_at);

-- 手動確認（自動ではない経路の記録。証跡を残す）
manual_attestation(
  id            uuid PRIMARY KEY,
  invoice_id    uuid NOT NULL REFERENCES invoice(id),
  organizer_id  uuid NOT NULL REFERENCES organizer(id),
  method        text NOT NULL,               -- 'paypay_p2p'|'cash'|'bank_transfer'|'other'
  evidence_note text,                        -- 自由記述。スクリーンショットは保存しない（§11）
  attested_at   timestamptz NOT NULL DEFAULT now()
)

-- Webhook 受信の生ログ（7日保持。署名検証失敗も残す）
webhook_delivery(
  id            uuid PRIMARY KEY,
  provider_key  text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  sig_ok        boolean NOT NULL,
  http_status   smallint NOT NULL,
  body_sha256   text NOT NULL,
  headers       jsonb,
  source_ip     inet
)

-- 後続処理キュー（Webhook から重い処理を外す W5）
outbox(
  id            uuid PRIMARY KEY,
  kind          text NOT NULL,               -- 'notify_organizer'|'refund_task'|'mismatch_alert'
  payload       jsonb NOT NULL,
  run_after     timestamptz NOT NULL DEFAULT now(),
  attempts      smallint NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  done_at       timestamptz,
  last_error    text
)
CREATE INDEX outbox_pending ON outbox(run_after) WHERE done_at IS NULL;

-- 監査ログ（全書き込みAPIが通る）
audit_log(
  id            bigserial PRIMARY KEY,
  actor_type    text NOT NULL,               -- 'organizer'|'participant'|'system'|'webhook'
  actor_id      text,
  action        text NOT NULL,
  target_table  text NOT NULL,
  target_id     text NOT NULL,
  before        jsonb,
  after         jsonb,
  request_id    text,
  at            timestamptz NOT NULL DEFAULT now()
)
CREATE INDEX audit_log_target ON audit_log(target_table, target_id, at DESC);

-- 照合ジョブの実行記録
reconciliation_run(
  id            uuid PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  scanned       integer NOT NULL DEFAULT 0,
  repaired      integer NOT NULL DEFAULT 0,
  mismatches    integer NOT NULL DEFAULT 0,
  note          text
)
```

### 4-2. この設計が拡張性のために持っている性質

1. **`provider_key` は文字列で、テーブル構造に事業者名が焼き付いていない。** 新しい事業者の追加は `provider_binding` 行とアダプタ実装だけで済み、マイグレーションを伴わない。
2. **`payment_event.ingestion_source` と `ledger_entry.confidence` が分離している。** Webhook 由来・照会由来・銀行明細由来・幹事の手動申告が、同じ台帳の上に**信頼度のラベル付きで**共存する。候補E（銀行明細）を後から足すとき、テーブルを増やさず `ingestion_source='bank'` / `confidence='bank_matched'` を使えばよい。
3. **`invoice.auto_detected` が持ち回られる。** 手動確認アダプタで消し込んだ請求は `auto_detected=false` のまま。API レスポンス・幹事画面・CSV 出力のすべてでこのフラグが露出し、「自動検知した」と誤って表示することを構造的に防ぐ。
4. **`payment_event` に二重の一意制約がある。** `(provider_key, provider_event_id)` は W1、`(provider_key, business_idem_key)` は W2。Stripe が「同一事象に対し2つの Event オブジェクトを生成することがある」と明記しているとおり、イベントIDだけでは不十分。

---

## 5. API / Webhook 設計

### 5-1. エンドポイント一覧

| メソッド | パス | 認可 | 冪等 | 備考 |
|---|---|---|---|---|
| POST | `/api/auth/line` | なし（IDトークン検証） | — | §3-2。セッションCookie発行 |
| POST | `/api/events` | organizer セッション | `Idempotency-Key` ヘッダ必須 | イベント作成 |
| GET | `/api/events/:id` | 当該 organizer のみ | — | 名簿＋台帳サマリ |
| POST | `/api/events/:id/participants` | 当該 organizer のみ | `Idempotency-Key` | 一括登録可 |
| POST | `/api/events/:id/invoices` | 当該 organizer のみ | `Idempotency-Key` | 参加者×金額で請求発行 |
| GET | `/api/invite/:inviteToken` | 認可なし（トークン保持が認可） | — | 参加者が見る支払い画面。**他人のPIIを返さない**（自分の名前・金額・イベント名のみ） |
| POST | `/api/invite/:inviteToken/checkout` | トークン保持＋LINEセッション | `Idempotency-Key` | アダプタの `createCheckout` を呼ぶ。参加者は金額を指定できない（サーバーが invoice から取る） |
| GET | `/api/invite/:inviteToken/status` | トークン保持 | — | 決済戻り先で1回だけ `getPaymentStatus` を叩いて確定（P3） |
| POST | `/api/invoices/:id/manual-attest` | 当該 organizer のみ | `Idempotency-Key` | **手動確認（非自動）**。`auto_detected` は false のまま |
| POST | `/api/invoices/:id/refund` | 当該 organizer のみ | `Idempotency-Key` | アダプタの `refund`。非対応は 409 `NOT_SUPPORTED` |
| POST | `/api/webhooks/:providerKey` | 署名検証 or 再照会 | `(provider_key, event_id)` + 業務冪等キー | §5-3 |
| POST | `/api/cron/reconcile` | `CRON_SECRET` ヘッダ | advisory lock | §5-4 |
| POST | `/api/cron/outbox` | `CRON_SECRET` ヘッダ | advisory lock | outbox ドレイン |
| GET | `/api/events/:id/export.csv` | 当該 organizer のみ | — | `auto_detected` 列を必ず含める |

### 5-2. 認可の原則

- **参加者は自分の請求しか読めず、金額と状態は一切書けない。** `POST /api/invite/:token/checkout` はリクエストボディに金額を取らない。サーバーが `invoice.amount_minor` を読んでアダプタに渡す。
- **幹事は自分のイベントしか読めない。** すべての読み取りクエリに `organizer_id = session.organizer_id` を強制する。ORM のリポジトリ関数のシグネチャに `organizerId` を必須引数として入れ、忘れた瞬間に型エラーになるようにする。
- **参加者一覧を幹事に見せる行為は個人情報保護法27条1項の第三者提供に当たりうる**（L6）。初回のイベント参加導線に同意取得画面を入れ、同意した事実を `audit_log` に残す。同意の法的構成（委託か共同利用か）は §5-4 Q9 の弁護士照会事項。

### 5-3. Webhook 処理（同期区間は最小、2xx を速く返す W5）

```
POST /api/webhooks/:providerKey
 1. const raw = await request.text()             // 生本文。JSON.parse しない（P2/W6）
 2. adapter = registry.get(providerKey)          // 未登録 provider は 404
 3. result = adapter.parseWebhook(raw, request.headers)
      ├─ SignatureError            → webhook_delivery に sig_ok=false で記録し 400
      └─ NormalizedEvent[]（各要素に trust: 'verified' | 'unverified'）
 4. for each ev:
      a. INSERT INTO payment_event (provider_key, provider_event_id, business_idem_key, ...)
         ON CONFLICT DO NOTHING RETURNING id
         → 0行なら既処理。スキップ（W1/W2）
      b. if ev.trust === 'unverified':            // PayPay のように署名がない事業者
           snap = await adapter.getPaymentStatus(ev.externalRef)   // 必ず再照会（W7）
           if snap が ev と矛盾 → outbox に mismatch_alert を積み、台帳には書かない
           else ev.trust = 'reverified'
      c. attempt = SELECT ... FROM payment_attempt
                   WHERE provider_key = $1 AND external_ref = $2 FOR UPDATE
         → 見つからなければ「孤児イベント」。payment_event は残し mismatch_alert
      d. amount / currency / 受取先 を invoice と突合（W8）。不一致なら台帳に書かず mismatch_alert
      e. applyToLedger(invoice, ev)              // §5-5
 5. 重い処理（LINE通知・幹事アラート）は outbox へ。ここでは実行しない
 6. return 200
```

- **エラー応答は常に JSON で `{ code, message, requestId }`。** `code` は機械可読な固定文字列（`SIGNATURE_INVALID` / `UNKNOWN_PROVIDER` / `AMOUNT_MISMATCH` / `NOT_SUPPORTED` / `IDEMPOTENCY_CONFLICT`）。事業者側のリトライ挙動を制御するため、**恒久的な失敗は 400、こちら側の一時障害は 500** を返す（500 なら事業者がリトライしてくれる）。
- 署名シークレットのローテーションに備え、**複数シークレットで検証を試行**する（W12）。アダプタの `parseWebhook` は `secrets: string[]` を受け取れる形にする。
- Webhook ルートは CSRF 保護とボディパーサから除外（W6）。Next.js App Router の Route Handler は既定でボディパーサを通さないので追加設定は不要。

### 5-4. 再照合ジョブ（`/api/cron/reconcile`）

```
1. pg_try_advisory_lock(RECONCILE_LOCK_ID) → 取れなければ即 200（多重起動防止 W11）
2. 対象は「状態」で走査する（W9）: invoice_recon_scan インデックス
     WHERE status_rank < 40 AND updated_at < now() - interval '3 minutes'
     AND EXISTS (該当 invoice に status IN ('created','redirected') の payment_attempt)
3. 各 attempt に対し adapter.getPaymentStatus(external_ref)
4. 結果を ingestion_source='poll' の payment_event として同じ冪等経路に流す
     → Webhook と照会が同じ処理系に合流する。二重に届いても business_idem_key で弾かれる
5. expires_at を過ぎた attempt を 'expired' に落とす（invoice の rank は下げない）
6. reconciliation_run に scanned / repaired / mismatches を記録
```

- **`pending` の保持期間は最低4日**（W10）。Stripe の再送が最長3日という事実を、事業者非依存の安全側の既定値として採る。
- Vercel Hobby は cron が1日1回・±59分（I2）。**本アプリの照合遅延許容度は「決済から数分」なので Vercel Pro が前提。** これは §10 の費用に計上する。
- 「1回飛んでも次回で拾える」設計なので、cron の取りこぼし・重複起動のどちらでも壊れない。

### 5-5. `applyToLedger`（台帳への単調適用）

```
BEGIN
  SELECT status_rank FROM invoice WHERE id = $1 FOR UPDATE;
  newRank = rankOf(ev.kind);
  -- キャンセル/失効は rank < 40（未払）のときだけ適用。paid を巻き戻さない
  if (ev.kind in ('canceled','expired','failed') && currentRank >= 40) → 記録のみ、状態変更なし
  -- 前進のみ
  UPDATE invoice SET status = $new, status_rank = $newRank, auto_detected = $auto, updated_at = now()
    WHERE id = $1 AND status_rank < $newRank;
  -- 台帳は常に追記（状態が変わらなくても事実は残す）
  INSERT INTO ledger_entry (...) VALUES (...);
  INSERT INTO audit_log (...) VALUES (...);
COMMIT
```

`auto_detected` は `ev.ingestion_source` が `'manual'` なら false のまま、それ以外なら true に**前進のみ**（一度 true になった請求が手動申告で false に戻ることはない）。

---

## 6. PaymentProvider アダプタIF と初期アダプタ

### 6-1. インターフェース

```ts
// ── 事業者キーは開いた文字列型。新規追加でユニオンの編集を強制しない ──
export type ProviderKey = 'paypay_online' | 'payjp' | 'manual_confirm' | (string & {});

export interface ProviderCapabilities {
  /** false ⇒ この経路は自動検知ではない。UI・API・CSV に「手動確認（非自動）」を出す義務が生じる */
  autoDetect: boolean;
  webhook: boolean;
  /** 'none' の事業者は、コアが getPaymentStatus で必ず再照会する（W7） */
  webhookSignature: 'hmac' | 'token' | 'none';
  statusQuery: boolean;
  refund: 'none' | 'full_once' | 'full' | 'partial';
  /** 決済応答に支払者を識別する値が載るか。false なら代理払いは検知できない */
  payerIdentity: boolean;
  /** 表示用の入金タイミング注記。「決済完了」と「幹事への入金」を別に見せるため（P6） */
  settlementLagHint: string;
}

export interface CreateCheckoutCommand {
  invoiceId: string;
  /** 事業者側の外部参照キーに埋め込む値。invoiceId を含む一意文字列 */
  externalRef: string;
  amountMinor: number;
  currency: 'JPY';
  description: string;
  /** 必須。LINEミニアプリのパーマネントリンクへ戻す（P4/N4） */
  returnUrl: string;
  expiresAt?: Date;
}

export interface CheckoutTicket {
  externalRef: string;
  checkoutUrl: string;
  expiresAt?: Date;
  /** 事業者固有の追加情報。コアは中身を解釈しない */
  raw: unknown;
}

export type PaymentEventKind =
  | 'authorized' | 'succeeded' | 'failed'
  | 'canceled' | 'expired' | 'refunded' | 'unknown';

export interface NormalizedEvent {
  providerKey: ProviderKey;
  /** 事業者のイベントID。持たない事業者は null */
  providerEventId: string | null;
  /** (対象オブジェクトID + 種別) で作る業務冪等キー。必須（W2） */
  businessIdemKey: string;
  externalRef: string;
  kind: PaymentEventKind;
  amountMinor: number | null;
  currency: string | null;
  occurredAt: Date | null;
  /** 'verified' = 署名検証済 / 'unverified' = 署名なし（コアが再照会する） / 'attested' = 人が申告した */
  trust: 'verified' | 'unverified' | 'attested';
  raw: unknown;
}

export interface PaymentSnapshot {
  externalRef: string;
  kind: PaymentEventKind;
  amountMinor: number | null;
  currency: string | null;
  fetchedAt: Date;
  raw: unknown;
}

export class SignatureError extends Error {}
export class NotSupportedError extends Error {
  constructor(readonly feature: string) { super(`not supported: ${feature}`); }
}

export interface PaymentProvider {
  readonly key: ProviderKey;
  readonly capabilities: ProviderCapabilities;

  createCheckout(cmd: CreateCheckoutCommand): Promise<CheckoutTicket>;

  /** raw は生文字列。アダプタの外で JSON.parse しない（P2）。secrets は複数受けてローテーションに耐える（W12） */
  parseWebhook(raw: string, headers: Headers, secrets: string[]): Promise<NormalizedEvent[]>;

  getPaymentStatus(externalRef: string): Promise<PaymentSnapshot>;

  /** 非対応は NotSupportedError を投げる。呼び出し側は 409 NOT_SUPPORTED に変換（P7） */
  refund(externalRef: string, amountMinor?: number): Promise<NormalizedEvent>;
}
```

**この IF が拡張性のために持っている性質:**

- **能力宣言（`capabilities`）が実行時の値であり、型ではない。** 照合スケジューラ・UI・CSV 出力は `capabilities` を読んで振る舞いを変える。新しい事業者が「署名なし・返金不可・支払者不明」でも、コードを分岐で汚さずに受け入れられる。
- **`trust` がイベントに乗る。** 署名検証の有無という事業者差を、コアの1本の分岐（`unverified` なら再照会）に閉じ込められる。
- **`refund` の `NotSupportedError` を型ではなく例外にした。** PayPay の「1注文1回のみ」のような部分的制約は `capabilities.refund = 'full_once'` で事前に UI を抑制しつつ、競合で2回目が来たら例外で止める二段構えにする。
- **`ProviderKey` が `(string & {})` を含む開いた型。** アダプタの追加でコア側のユニオン型を編集する必要がない。

### 6-2. 第一アダプタ: `PayPayOnlineAdapter`（`paypay_online`・自動）

```ts
capabilities = {
  autoDetect: true,
  webhook: true,
  webhookSignature: 'none',      // 公開ドキュメントに署名検証の記載なし（§5-1 Q5 で照会中）
  statusQuery: true,
  refund: 'full_once',           // 公式 Node SDK: "Currently we only support 1 refund per order."
  payerIdentity: false,          // 決済詳細レスポンスに支払者識別フィールドなし
  settlementLagHint: '月1回・月末締め（未検証）',
}
```

- `createCheckout` → Web Cashier（`QRCodeCreate` 相当）。`merchantPaymentId = "iv_" + invoiceId + "_" + attemptSeq`（最大64文字・`[a-zA-Z0-9_-]` の制約内に収まる）。`redirectUrl` に LINEミニアプリのパーマネントリンク。
- `parseWebhook` → 署名がないので全イベントを `trust: 'unverified'` で返す。**コアが必ず `getPaymentStatus` で再照会してから台帳に書く**（W7）。加えてインフラ側で IP 許可リストを併用する。
- `getPaymentStatus` → `GET /v2/codes/payments/{merchantPaymentId}`。リダイレクトが返らない場合を PayPay 自身が公式に前提としており、戻り先ページで1回叩く運用（P3）と照合ジョブの両方で使う。ポーリング間隔は2〜3秒。
- `businessIdemKey = ${merchantPaymentId}:${status}`。イベントIDを持たない前提で設計する。

**なぜこれを第一アダプタにするのか（拡張性の観点からの主理由）:** PayPay は調査した事業者の中で**能力が最も貧しい**（署名なし・支払者不明・返金1回のみ・Webhook 設定がセルフサービスでない）。最も貧しい事業者に対して先に IF を通せば、IF がその事業者の都合に過適合することがなく、後から来る豊かな事業者は能力を足すだけで乗る。逆順（豊かな事業者から作る）にすると、署名検証を前提にしたコアを後から剥がす作業が発生する。受取先が当初希望に最も近いこと・サンドボックスが審査前から使えることは、この判断を補強する副次的な理由である。

### 6-3. 第二アダプタ: `PayjpAdapter`（`payjp`・自動）

```ts
capabilities = {
  autoDetect: true,
  webhook: true,
  webhookSignature: 'token',     // X-Payjp-Webhook-Token
  statusQuery: true,
  refund: 'partial',             // 要確認（規約本文未取得）
  payerIdentity: false,
  settlementLagHint: '未確認',
}
```

- `createCheckout` → PAY.JP のホスト画面へ遷移させる（L8: カード番号をアプリのサーバが受け取らない）。`metadata.invoice_id` と `external_ref` を載せる。
- `parseWebhook` → `X-Payjp-Webhook-Token` を `secrets` 配列と定数時間比較。一致しなければ `SignatureError`。一致すれば `trust: 'verified'`。
- `businessIdemKey = ${charge.id}:${event.type}`。PAY.JP はイベントIDも持つので `providerEventId` も埋める（二重の一意制約が両方効く）。
- リトライは3分間隔で最大3回。**Stripe の3日と比べて猶予が短い**ので、PAY.JP を使うイベントでは照合ジョブの走査間隔を短くする（capabilities に基づく調整ではなくアダプタごとの `reconcileHintSeconds` を将来足す余地を残す）。

**第二アダプタを PAY.JP にする理由:** 決済手段が PayPay と重ならない（カード vs 残高・QR）ので、**同一イベントで2アダプタを並列運用する**構成が意味を持ち、アダプタ層の設計が正しいかを実地で検証できる。加えて必要書類が最も軽く、幹事のオンボーディング摩擦（§11 の最大の弱点）を最小化できる可能性がある。

### 6-4. 手動確認アダプタ: `ManualConfirmAdapter`（`manual_confirm`・**自動ではない**）

```ts
capabilities = {
  autoDetect: false,             // ★ ここが false であることが全ての起点
  webhook: false,
  webhookSignature: 'none',
  statusQuery: false,
  refund: 'none',
  payerIdentity: false,
  settlementLagHint: '即時（幹事のPayPay残高等に直接着金）',
}
```

- `createCheckout` → 決済は作らない。**PayPay の個人間送金（送る・受け取る）等への導線URLと、「支払ったら幹事に伝えてください」という文言を持つ `CheckoutTicket` を返す。** `checkoutUrl` は幹事が設定した受け取りリンク等をそのまま使う。
- `parseWebhook` → 常に `[]` を返す。
- `getPaymentStatus` → `NotSupportedError('statusQuery')`。**照合ジョブはこのアダプタを走査対象から除外する**（`capabilities.statusQuery === false` で判定）。
- `refund` → `NotSupportedError('refund')`。
- 台帳への記録は `POST /api/invoices/:id/manual-attest` からのみ発生し、`ingestion_source='manual'` / `trust='attested'` / `ledger_entry.confidence='organizer_attested'` / `invoice.auto_detected=false` になる。

**「自動ではない」ラベルの強制（設計上の義務）:**

1. **API**: 請求を返すすべてのエンドポイントが `autoDetected: boolean` と `confirmationMethod: 'automatic' | 'manual_by_organizer'` を必ず含む。省略可にしない。
2. **幹事画面**: `autoDetected === false` の請求には「幹事が手動で確認（自動照合ではありません）」バッジを描画する。バッジの描画を省略できないよう、請求行コンポーネントは `autoDetected` を必須 props にする。
3. **CSV**: `auto_detected` 列を必ず出力する。
4. **サマリ**: 「支払済み 2/4」の内訳を「自動確認 1 / 手動確認 1」に分けて表示する。合算した数字だけを見せない。
5. **文言**: 手動確認の請求に対して「入金を確認しました」と書かない。「幹事が受け取ったと申告」と書く。
6. **CI ゲート**: 幹事画面のスナップショットテストに「`autoDetected=false` の行にバッジが存在する」アサーションを入れ、消えたら CI が落ちる。

**引継ぎ書が「手動チェック版を作って自動チェック要件を満たしたと説明してはならない」と明記している点を、本案は上記6項目で構造的に守る。** `ManualConfirmAdapter` は Phase 1 の出荷物だが、これは「中心要件の達成」ではなく「決済事業者の照会が返らない期間に台帳を実運用で検証するための足場」である。

### 6-5. 将来のアダプタ枠（実装しない、設計だけ残す）

- `BankReconciler`（候補E・楽天銀行＋電代業）: `PaymentProvider` ではなく `SettlementSource` という別 IF で `ingestion_source='bank'` / `confidence='bank_matched'` の `payment_event` を生成する。**振込依頼人名は参加者が書き換えられるため誤照合が起きる**ので、照合信頼度スコアと幹事の承認/却下 UI が必須。台帳側は既にこれを受け入れられる。
- `PayPalAdapter`（候補D）: connpass 型の退避先。`capabilities.payerIdentity` が true になる可能性が唯一ある事業者。

---

## 7. 状態遷移図と例外

### 7-1. invoice の状態とランク

```
 rank  状態              意味
   0   draft             請求が下書き
  10   issued            請求発行済・支払い導線未生成
  20   awaiting_payment  payment_attempt 生成済（checkout_url 発行）
  30   authorized        与信のみ（PayPay の AUTHORIZED）
  40   paid              支払い成立（★ 幹事画面の「支払済み」はここ）
  50   settled           幹事口座への入金を確認（P6。paid とは別物）
  60   refund_pending    返金処理中
  70   refunded          返金完了
  80   charged_back      チャージバック/紛争
  90   void              幹事が請求を取り消し（rank < 40 のときのみ可）
```

### 7-2. 遷移図（テキスト）

```
                        [幹事が請求発行]
  draft(0) ─────────────────────────────▶ issued(10)
                                              │
                        [参加者が支払いを開始]│ createCheckout 成功
                                              ▼
                                      awaiting_payment(20)
                                       │    │         │
             provider: AUTHORIZED ─────┘    │         └───── expired / canceled / failed
                        │                   │                       │
                        ▼                   │                       ▼
                 authorized(30)             │            awaiting_payment(20) に留まる
                        │                   │            （attempt のみ 'expired'。請求は未払のまま）
       provider: COMPLETED / succeeded      │                       │
                        └───────────────────┴───────────────────────┘
                                            │ ★ ここだけが「支払済みチェック」を立てる
                                            ▼
                                         paid(40)
                                         │      │
     入金明細で幹事口座着金を確認 ────────┘      │ 幹事が返金を実行
                     │                           ▼
                     ▼                    refund_pending(60) ──▶ refunded(70)
                 settled(50)
                                         paid(40) ──[紛争]──▶ charged_back(80)

  issued(10) / awaiting_payment(20) ──[幹事が取り消し]──▶ void(90)
  ※ rank >= 40 の請求は void にできない（返金経路を通す）
```

**不変条件（DB とコードの両方で守る）:**

- `UPDATE invoice ... WHERE status_rank < $newRank` — ランクは前進のみ（W3）。
- `canceled` / `expired` / `failed` は `status_rank >= 40` の請求に**適用しない**（記録は残すが状態は動かさない）。Webhook の順序逆転で「支払済み → 期限切れ」に巻き戻る事故を構造的に消す。
- `occurred_at`（事業者側の時刻）を順序判定に使わない（W4）。

### 7-3. 例外の扱い

| 例外 | 検知 | 台帳の処理 | 幹事に見えるもの |
|---|---|---|---|
| **失敗** | `kind='failed'` | `ledger_entry` は作らない。`payment_event` のみ残す | 「支払いに失敗しました（未払い）」。請求は `awaiting_payment` のまま、再試行可 |
| **キャンセル** | `kind='canceled'` | 同上。`payment_attempt.status='canceled'` | 同上 |
| **期限切れ** | `expires_at` 経過 or `kind='expired'` | 同上。`payment_attempt.status='expired'` | 「支払いリンクの期限が切れました」＋再発行ボタン |
| **二重払い** | 同一 invoice に `kind='succeeded'` が2件（別 `businessIdemKey`） | 2件目は `ledger_entry(kind='overpay')` として追記。`invoice.status` は `paid` のまま動かさない | 「二重に支払われています（超過 5,000円）」＋返金タスクを outbox 経由で通知。**自動返金はしない**（幹事の判断） |
| **返金** | 幹事が `POST /api/invoices/:id/refund` | `refund_pending` → 事業者イベントで `refunded`。`ledger_entry(direction='debit', kind='refund')` | 「返金済み」。返金原資は運営者が持たない（L4） |
| **返金非対応** | `capabilities.refund === 'none'` or `NotSupportedError` | 台帳に `kind='adjustment'` を幹事が手動で記録できる導線のみ | 「この決済手段はアプリからの返金に対応していません。事業者の管理画面で処理してください」 |
| **遅延通知** | Webhook が数時間〜数日後に到着 | 通常経路と同じ。`business_idem_key` で冪等。`pending` の保持期間は最低4日（W10） | 遅れて「支払済み」に変わる。幹事には変更履歴（`audit_log`）を出す |
| **代理払い**（他人の分を誰かが払う） | **検知できない**（`capabilities.payerIdentity === false`） | 幹事が `manual-attest` で「B さんの分は A さんが支払った」を記録。`ledger_entry(kind='proxy_payment', memo)` | 「代理払い（幹事が記録）」バッジ。**自動照合ではないと明示** |
| **金額不一致** | Webhook の `amount` が invoice と違う（W8） | 台帳に書かない。`outbox` に `mismatch_alert` | 「確認が必要な入金があります」＋詳細 |
| **孤児イベント**（対応する attempt が無い） | `payment_attempt` が見つからない | `payment_event` のみ保存 | 運用アラート（幹事には出さない） |
| **署名不一致** | `SignatureError` | `webhook_delivery(sig_ok=false)` のみ | 運用アラート |

---

## 8. フェーズ分割とマイルストーン

### Phase 0 — 事業者照会・法務ゲート（コードを書かない。並行してリポジトリ初期化は可）

| やること | 完了条件 |
|---|---|
| PayPay 加盟店窓口へ照会（§5-1 Q1〜Q7） | **「飲み会・イベントの会費徴収が取扱可能商材か」の回答を文書で得る**。NG なら第一候補を PAY.JP に差し替える |
| PAY.JP へ照会（加盟店規約本文の取得、個人間送金・立替精算の扱い、非事業者可否、手数料率） | 規約本文を入手し、会費徴収が対象商材に含まれることを確認 |
| LINEヤフーへ照会（§5-3 Q1〜Q3, Q6） | 「幹事が管理する精算・集金の台帳」という定義で禁止業種に当たらないことの回答、プラットフォーム利用料の有無 |
| 弁護士照会（§5-4 Q1〜Q4 を最優先） | **内閣府令1条の2第3号の適用可否**について書面の見解を得る。特に「運営者が資金の受入れ・引渡しに一切関与しない構成が2条の2柱書の射程外か」 |
| 受取先変更の同意取得 | ユーザー（noritaka）が「受取先が幹事の個人PayPay残高ではなくなる」ことに明示同意 |

**Phase 0 の完了条件（ゲート）: 上記5件のうち、PayPay または PAY.JP のいずれか1社から肯定的な回答があり、かつ弁護士見解が「運営者が資金に触れない構成なら登録不要」の方向であること。** この2つが揃わない限り Phase 2 へ進まない。Phase 1 は Phase 0 と**並行して着手できる**（決済に一切依存しないため）。

### Phase 1 — 決済非依存コア（Phase 0 と並行。ここが本案の中核資産）

| マイルストーン | 内容 |
|---|---|
| M1-1 | リポジトリ初期化（npm / Next.js 15 / TypeScript / Drizzle / Vitest）、`vercel.json` に `"regions": ["hnd1"]`、CI（typecheck / lint / test） |
| M1-2 | §4 のスキーマ全テーブル＋制約＋インデックスをマイグレーションで作成。`ledger_entry` の UPDATE/DELETE を権限で禁止 |
| M1-3 | LINE IDトークン検証＋自前セッション（§3-2）。未認証ミニアプリの開発用チャネルで動作確認 |
| M1-4 | イベント作成・参加者登録・請求発行・名簿表示・`shareTargetPicker` 配布（§3-3） |
| M1-5 | `PaymentProvider` IF と `ProviderRegistry`、`ManualConfirmAdapter`（自動ではないラベル6項目込み） |
| M1-6 | `applyToLedger` と冪等基盤（`payment_event` の二重一意制約、単調ランク更新、`audit_log`） |
| M1-7 | ProviderConformanceKit（§9）と、それを使った ManualConfirm の適合テスト |

**Phase 1 の完了条件:** 未認証ミニアプリとして本番リリースでき、幹事が名簿・請求・手動確認で1イベントを完走できる。かつ **ProviderConformanceKit の「重複・逆順・署名不一致」3本が緑**。かつ幹事画面に「自動確認 n / 手動確認 m」の内訳が出ている。

### Phase 2 — 自動アダプタ

| マイルストーン | 内容 |
|---|---|
| M2-1 | `PayPayOnlineAdapter` を STAGING サンドボックスで実装・ProviderConformanceKit 通過（**加盟店審査の完了を待たずに着手可**） |
| M2-2 | Webhook エンドポイント＋再照会（`trust='unverified'` 経路）、`/api/cron/reconcile` |
| M2-3 | PayPay 加盟店審査の通過、`provider_binding` の本番クレデンシャル接続、1件の実決済（少額）で end-to-end 検証 |
| M2-4 | `PayjpAdapter` 実装＋適合テスト＋同一イベントでの PayPay/PAY.JP 並列運用 |

**Phase 2 の完了条件:** 実際の決済1件が Webhook 経由で台帳に載り、その請求の `auto_detected=true` になること。**さらに、Webhook を止めた状態で照合ジョブだけで同じ請求が `paid` に到達すること**（Webhook 依存でないことの証明）。加えて、アダプタを1本追加したときに**コア（`applyToLedger` / API / 画面）に一切変更が入らなかったこと**を diff で示す。これが本案の設計仮説の検証である。

### Phase 3 — 運用

| マイルストーン | 内容 |
|---|---|
| M3-1 | LINEミニアプリ認証審査の申請・通過、サービスメッセージ（支払完了通知） |
| M3-2 | 幹事向け照合ダッシュボード（mismatch / 孤児イベント / 二重払い / 返金タスク） |
| M3-3 | 催促導線（Messaging API またはサービスメッセージ）、複数イベント横断の台帳 |
| M3-4 | `BankReconciler`（候補E）の検討着手。電代業のリードタイム調査と提携先確保 |

**Phase 3 の完了条件:** 未処理の mismatch が24時間以内に幹事へ通知され、`reconciliation_run` の直近7日で `mismatches = 0` が維持されること。

---

## 9. テスト戦略

### 9-1. ユニット（Vitest）

- **アダプタの `parseWebhook` は保存済み fixture のみでテストする。** 実 API を呼ばない。fixture は `fixtures/<provider>/<case>.json`（生本文＋ヘッダ）として保存し、署名付きの事業者は署名も含めて保存する。
- `applyToLedger` の状態遷移を**全遷移×全イベント種別の直積**でテストする。特に「`paid` に `expired` が届いても rank が下がらない」を明示的に1本書く。
- `rankOf()` の網羅性を型で保証する（`PaymentEventKind` の全ケースに対する `switch` の exhaustive check）。

### 9-2. ProviderConformanceKit（自作・本案の要）

**すべてのアダプタが通らなければマージできない共通テストスイート。** アダプタを1本書いたら、このキットに `key` を登録するだけで以下が自動で回る。

| ケース | 検証内容 | 根拠 |
|---|---|---|
| C1 重複配信 | 同一 Webhook を3回投げて `ledger_entry` が1件だけ | W1/W2・引継ぎ書§7「重複再送で二重加算しない」 |
| C2 順序逆転 | `succeeded` → `expired` の順で投げて `paid` が維持される | W3/W4・引継ぎ書§7「順序入れ替わり」 |
| C3 署名不一致 | 改竄した本文で 400、`webhook_delivery.sig_ok=false` | W6・`webhookSignature !== 'none'` のアダプタのみ実行 |
| C4 別IDの重複 | `providerEventId` が違うが `businessIdemKey` が同じイベントで1件 | W2 |
| C5 金額不一致 | invoice と違う金額で `mismatch_alert`、台帳に書かれない | W8 |
| C6 孤児イベント | 未知の `externalRef` で 200 を返しつつ台帳を汚さない | — |
| C7 再照会一致 | `trust='unverified'` のアダプタで、再照会と Webhook が一致すれば台帳に載る | W7 |
| C8 再照会不一致 | 再照会が Webhook と矛盾したら台帳に書かない | W7 |
| C9 能力宣言の遵守 | `capabilities.refund='none'` のアダプタが `refund` で `NotSupportedError` を投げる | P7 |
| C10 非自動ラベル | `autoDetect=false` のアダプタで消し込んだ請求が API レスポンスで `autoDetected: false` を返す | §6-4 |

**Stripe CLI（`stripe trigger` / `stripe listen`）は使わない。** Stripe を採用しないので、PayPay/PAY.JP の Webhook 再現には使えない。キットは保存済み fixture を HTTP で自前 Route Handler に投げる形で実装し、事業者非依存にする。

### 9-3. 統合（supabase CLI のローカル Postgres）

- `supabase start` で立てたローカル Postgres に対して実マイグレーションを流し、DB 制約（部分一意インデックス・CHECK・`for update`）が実際に効くことを検証する。**モックした DB では冪等性の証明にならない。**
- `pg_try_advisory_lock` による cron の多重起動防止を、2プロセス同時起動で検証する（W11）。

### 9-4. E2E（Playwright + `@line/liff-mock`）

- `liff.use(new LiffMockPlugin())` + `liff.init({ mock: true })` を**環境変数で切り替え、動的 import で本番バンドルに入れない**（I4）。`vi.mock` は実ブラウザで効かないので使わない。
- シナリオ: 幹事がイベント作成 → 4人登録 → `shareTargetPicker` 配布（モック）→ 参加者が支払い画面を開く → 決済事業者のサンドボックスへ遷移 → 戻り先で `getPaymentStatus` 1回 → 名簿に「支払済み」が付く。
- `shareTargetPicker` は `liff.isApiAvailable()` が false のケース（フォールバックが出ること）も必ずテストする（N8）。

### 9-5. 決済サンドボックス

- **PayPay**: SDK の `env: "STAGING"`（`apigw.sandbox.paypay.ne.jp`）。**加盟店審査の前から使える**ので Phase 2 の M2-1 を Phase 0 と並行できる（確信度 中。Phase 2 着手時に実際に使えるか最初に確認する）。
- **PAY.JP**: テストキー。
- サンドボックスで通ったことを「本番で通る」と言わない。M2-3（実決済1件）が完了するまで Phase 2 は完了扱いにしない。

---

## 10. 費用概算（すべて未確定）

**以下はすべて未確定である。事業者照会が1件も返っておらず、料金ページの一次資料も本起案者は再取得していない。契約前に必ず各社の最新料金を確認すること。**

### 10-1. 運営者（NonTurn LLC）の固定費

| 項目 | 概算 | 確信度 | 備考 |
|---|---|---|---|
| Vercel Pro | $20/月 | 中 | **必須。** Hobby は cron が1日1回・±59分で照合遅延が許容できない（I2） |
| Supabase | $0（Free）〜 $25/月（Pro） | 低 | Tokyo リージョンの可用性と料金が未確認（§5-5）。Free で始め、行数と接続数で Pro へ |
| LINEミニアプリ プラットフォーム利用料 | **不明** | 低 | §5-3 Q6 で照会中。無料と仮定しない |
| Messaging API（Phase 3 の催促） | 通数課金 | 低 | サービスメッセージが月間メッセージ通数にカウントされるかも未確認 |
| ドメイン | 年 ¥2,000 前後 | 中 | — |
| 弁護士照会（Phase 0） | **不明（数十万円規模を想定）** | 低 | グレーゾーン解消制度を使えば費用は下がるが期間が延びる |

**Phase 1 の運用コストは月 $20〜$45 程度＋法務費用**、というのが現時点の見立てである。

### 10-2. 幹事の負担

| 項目 | 概算 | 確信度 |
|---|---|---|
| 決済手数料（PayPay オンライン直接契約・物販） | 3.8% | 低（未検証） |
| 決済手数料（PAY.JP） | **不明** | 低 |
| 加盟店審査の所要期間 | PayPay: 2週間〜1カ月＋利用開始5営業日 | 低（未検証） |
| 必要書類 | PAY.JP: 開業届 or 確定申告書控え等 / PayPay: 本人確認＋住所確認書類 | 中 |
| 入金までの待ち時間 | PayPay 直接契約: 月1回・月末 | 低（未検証） |

**5,000円×10人＝50,000円の集金で、手数料 3.8% なら 1,900円が幹事負担。** 対して PayPay / Kyash の個人間送金は手数料0円。**本アプリは構造的にコスト不利**であり、この差額に見合う価値（名簿・自動照合・複数イベント横断・21名以上）を提供できなければ採用されない。

### 10-3. 参加者の負担

- **金銭的負担はゼロにする。** 手数料を参加者に上乗せ請求しない（P5。PayPay 加盟店規約（オンライン）第4条第3項が「商品等代金以外の金銭の支払いを請求すること」を禁止しているとの記録があるため。確信度 低・未検証だが、安全側に倒す）。手数料は幹事負担または会費内包。
- **操作負担**: LINE から支払いリンクを開く → 決済事業者の画面で支払う → ミニアプリに戻る。アプリのインストールは不要。
- **注意**: 決済事業者によってはアカウント作成が要る（PAY.JP のカード決済は不要、PayPay はアプリが必要）。参加者側のアカウント保有率が実際の完了率を決めるので、**イベント単位で複数アダプタを並列に出せる設計**（§6-3）が効く。

---

## 11. この案で満たせない要件・弱点（正直に）

1. **当初の中心要件を、当初の受取先のままでは満たせない。** 「幹事の個人PayPay残高で受け取りつつ自動チェック」は本案では実現しない。条件3（幹事が非事業者のまま）を落としている。これは本案固有の欠陥ではなく、consolidated.md §7-1 が示した構造的制約だが、**本案はそれを解決していない**。

2. **幹事が加盟店審査を通る必要があり、これがプロダクトの最大の摩擦である。** L1（運営者が資金に触れない）と L9（PayFac 型を採らない）を守る限り、受取人は幹事自身の決済アカウントでなければならず、審査を代行できない。「飲み会の幹事」が2週間〜1カ月の審査と開業届相当の書類を用意するとは考えにくい。**ターゲットを「継続的な主催者（サークル・部活・教室・コミュニティ）」に寄せない限り成立しない。** 本案はこの摩擦を薄める手段を持たない。

3. **代理払いを自動で追えない。** `capabilities.payerIdentity = false` が PayPay・PAY.JP の両方で真であり、決済事業者は「どの請求が支払われたか」しか返さない。引継ぎ書§7の「代理払いを追える」という要件は、**幹事の手動記録でしか満たせない**。§7-3 の表でそう明示しているが、要件そのものは満たしていない。

4. **`ManualConfirmAdapter` を Phase 1 の出荷物にしていること自体がリスク。** 引継ぎ書は手動チェック版を「中心要件を満たさない」と明記した。本案は §6-4 の6項目でラベルを強制するが、**運用の中でラベルが形骸化する（幹事が全部手動で付けて「便利な名簿」として使う）可能性**は残る。その場合、本アプリは単なる名簿アプリになる。

5. **手数料で無料の既存機能に負ける。** PayPay / Kyash / LINE内PayPayの個人間送金は手数料0円。3.8% の差額を正当化できるのは、名簿・複数イベント横断・21名以上・催促・領収記録といった台帳側の価値だけ。**本案は台帳を厚くする設計だが、それが 1,900円/回の価値になるかは検証されていない。**

6. **2026年夏以降、LINE 本体が正面から競合する。** LINEヤフーは2026年7月2日、LINE のトーク上で PayPay 残高の送金と「グループ支払い」による割り勘ができるようになると発表している（確信度 低・未検証だが複数レポートで一致）。本アプリの中核体験がプラットフォーム本体機能になる。**残る客観的な隙間は「グループトークでは同じ金額の請求のみ対応可能」という制約だけ**であり、これは埋められる可能性がある。

7. **アダプタ層の抽象化コストを先払いしている。** 事業者が1社に確定するなら、`PaymentProvider` IF・`ProviderRegistry`・`capabilities` による分岐・ProviderConformanceKit は過剰である。**この設計が正しかったかは、Phase 2 の M2-4（2本目のアダプタ追加でコアに変更が入らないこと）でしか検証できない。** それまでは投機的な投資であり、1社確定なら 1〜2週間分の実装が無駄になる。

8. **未検証の事実に依存した判断が複数ある。** 第一候補 PayPay の選定は「オンライン決済ルートに実店舗要件がない」（確信度 中）「サンドボックスが審査前から使える」（確信度 中）「手数料 3.8%・月末入金」（確信度 低）に依存している。§5-1 の照会で覆れば、第一候補は即座に PAY.JP へ入れ替わる。**本案は入れ替えのコストを小さく設計してはいるが、入れ替えが起きないとは言っていない。**

9. **MVP で RLS を使わない（I3）ため、サービスロールキーが単一障害点になる。** 全 DB アクセスがサーバー側という構造で守っているが、Route Handler に1箇所でも `organizerId` のスコープ忘れがあれば他人の名簿が漏れる。リポジトリ関数の必須引数と `audit_log` で緩和しているが、**RLS のような多層防御はない**。

10. **証跡としてのスクリーンショットを扱わない。** `manual_attestation.evidence_note` は自由記述のみで、画像を保存しない。これは「自己申告やスクリーンショットを検証済み入金として扱わない」という引継ぎ書の指示に従った結果だが、**幹事が「証拠を残したい」と考える実務ニーズには応えていない**。

11. **本案の全根拠は consolidated.md の転記であり、本起案者は一次資料を1件も再取得していない。** URL の再確認は Phase 0 の最初の作業に含める。
