# アーキテクチャ案 A — MVP-first / LINE内最速価値

起案日: 2026-09-24 / 起案者: シニアアーキテクト（観点A: MVP-first）
前提資料: `scratchpad/handover.md`、`scratchpad/local-context.md`、`scratchpad/research/consolidated.md`
参照記法: 統合調査の制約ID（L1〜L12 / P1〜P9 / W1〜W12 / N1〜N12 / I1〜I6）をそのまま引く。

---

## 0. この案の立ち位置（先に結論）

**本案は「Phase 1 を決済事業者に一切依存しない台帳アプリとして 2〜3週間で未認証LINEミニアプリに載せ、決済の自動検知は Phase 2 に切り離す」構成を採る。** その結果、Phase 1 が出荷された時点では引継ぎ書の中心要件「参加者の支払いを検知して自動で支払済みチェックが付く」は**満たされない**。Phase 1 の支払確認はすべて「手動確認（非自動）」であり、UI・API・CSV・状態列のすべてにそのラベルを持たせる。

そして本案をもってしても、引継ぎ書の3条件（①参加者ごとの自動検知 ②受取先＝幹事の個人PayPay ③幹事が非事業者のまま）の**同時達成はできない**。本案は Phase 2 で条件②を落とす（受取先を幹事名義の加盟店に変える）。これは調査統合レポート §7-1 の結論をそのまま受け入れた帰結であり、本案の独自の工夫で回避できるものではない。

MVP-first を採る理由は1つ。**決済事業者の go/no-go（PayPay の NG商材判定、弁護士の適法性所見）が返ってくるまで最短でも2〜6週間かかり、その間に作れて捨てずに済むものが台帳と冪等基盤しかないから**である。照会の返信を待って着手すると、幹事が何も触れない期間が1〜2カ月続く。

---

## 1. 採用する資金フローと決済事業者の候補

### 1-1. 採用する資金フロー

**候補A（幹事＝PayPayオンライン加盟店）を第一候補、候補D（幹事＝PayPal、connpass型）を第二候補とする。運営者（NonTurn LLC）は資金の受入れ・保管・引渡しに一切関与しない（L1）。**

```
参加者 ──(決済事業者のホスト画面)──> 決済事業者 ──> 幹事名義の加盟店売上 ──> 幹事の指定口座
                                        │
                                   Webhook / 照会API
                                        │
                                        v
                              本アプリ（照会と名簿反映のみ）
```

アプリは資金の経路上に存在しない。カード番号も受け取らない（L8）。返金原資も持たない（L4）。前払い専用で、幹事の立替後回収モードは実装しない（L2）。アプリ内残高・チャージ・ポイントは作らない（L3）。

### 1-2. 第一候補: PayPay オンライン加盟店（統合調査の候補A）

**選定理由（MVP-first の観点）**

1. **参加者側の摩擦が最小。** LINE内で開いたミニアプリから PayPay の決済画面へ飛ぶ導線は、日本の飲み会参加者にとって説明不要。MVP で最も落としてはいけない数値は参加者の支払完了率であり、そこに最も効く。
2. **ユーザーの当初希望（PayPayで受け取る）との距離が最も近い。** 受取先が「個人PayPay残高」から「加盟店売上→指定口座」へ変わることは説明が要るが、決済手段そのものは変わらない。受取先変更の説明コストが候補B/C/Dより小さい。
3. **加盟店審査を待たずに実装検証を始められる。** PayPay Node SDK の `env: "STAGING"` サンドボックスが使える（I6、確信度 中）。Phase 0 の照会と Phase 2 の実装を並走できる。
4. **go/no-go が照会1本で決まる。** 統合調査 §5-1 の質問1〜3（会費徴収が取扱可能商材か）の回答だけで採否が確定する。判断の待ち行列が最も短い。

**不採用にしなかったが承知しているコスト**

- 入金は月1回（月末入金、確信度 低・未検証）。**飲み会当日の立替問題は解消しない**（P6）。
- 手数料 物販3.8% / デジタルコンテンツ10%（確信度 低・未検証）。参加者への上乗せは加盟店規約（オンライン）第4条第3項に抵触する恐れがあるため禁止する（P5）。
- Webhook に署名検証の記載がない（W7）。IP許可リスト＋必ず `GET /v2/codes/payments/{merchantPaymentId}` で再照会する設計で担保する。
- 返金は「1注文1回のみ」（P7）。
- 加盟店審査 2週間〜1カ月＋利用開始まで5営業日（確信度 低・未検証）。**幹事1人ごとにこの審査が発生する**。これは本案でも消せない。

### 1-3. 第二候補: PayPal（connpass型、統合調査の候補D）

**選定理由**

1. **connpass が実運用している構造をそのまま模倣できる。**「主催者のPayPalアカウントへ即時入金、connpass手数料は無料、主催者は本人確認済みアカウントがあれば個人でも可」（一次資料あり、確信度 中）。前例があることは MVP の法務リスク説明で強い。
2. **即時着金。** 候補Aの月1回入金、候補Bの日次不可に対し、立替問題の緩和が最も大きい。
3. **幹事のオンボーディング負担が候補A/B/Cより軽い**（本人確認済みアカウント）。

**不採用理由にはしないが未確認の点**

- ビジネスアカウントが必須か、API認証情報がビジネスアカウント限定か（統合調査が help873 のフェッチに失敗、§5-5）。
- 日本の飲み会参加者の PayPal 決済への抵抗。カード入力を伴うゲスト決済に落ちると参加者側の摩擦は候補Aより大きい。

### 1-4. 第三候補以下を第一候補にしない理由

| 候補 | 不採用（第一候補にしない）理由 |
|---|---|
| B: Stripe | 技術資料は最良で local に stripe CLI もあるが、**日本固有の禁止業種「Stripe Connect 外での C2C サービス」と、PayPay×Connect の公開経路不在が同時に成り立つ可能性**が未解決（確信度 中・要再確認）。加えて SSA §1.2(a)(i)「personal, family, or household purposes」の包括禁止と §1.2(a)(ix)「ピアツーピアの送金」が独立に効く。**照会の往復が候補Aより多く、MVP-first では待ち行列が長すぎる。** カード決済が必須要件になった段階で再評価する。 |
| C: PAY.JP | 必要書類が最も軽く Webhook 仕様も明快だが、**加盟店規約本文が未取得**で個人間送金・立替精算の扱いが不明（§5-5）。候補Aが落ちたときの第三退避先として保持する。 |
| E: 楽天銀行＋電子決済等代行業 | **「非事業者の幹事が受取人のまま自動検知できる」唯一の実在経路**だが、電代業の登録（事前相談→ドラフト→事前審査→正式申請）または登録済み事業者との提携がリードタイムの塊で、MVP-first と両立しない。加えて着金ベースで即時性が劣り、振込依頼人名は参加者が書き換えられるため誤照合が起きる。**Phase 3 以降の選択肢として PaymentProvider と同じ層に `BankReconciler` を置ける余地だけ残す。** |
| F: 運営者が収納代行 | L1 を壊す。資金移動業の登録は株式会社でなければ取得できず（確信度 低・未検証）、合同会社の NonTurn LLC は組織変更が前提。MVP で選べない。 |
| G: 決済連動なし | **本案の Phase 1 そのもの。**ただし「自動チェック要件を満たした」とは説明しない（§11）。 |

### 1-5. 事業者未照会であることの明示

**上記の第一・第二候補は、いずれの決済事業者にも照会していない段階の机上の順位である。** PayPay へも PayPal へも問い合わせていない。特に次の2点は未回答であり、回答次第で第一候補は入れ替わる。

- PayPay: 飲み会・懇親会・サークルの**会費徴収がオンライン決済の取扱可能商材か**（公式に「商取引ではない寄付や募金、投げ銭（チップ）など一部NG商材もございます」とある。飲み会の会費がこれに当たるかが go/no-go の分岐点）。
- PayPal: 個人アカウントでの受取可否と API 資格。

本案の Phase 2 は、この2つの回答が揃うまで**着手しない**。Phase 0 と Phase 1 だけを先行させる。

---

## 2. 技術スタック

ローカル実測（node v22.22.0 / npm 10.9.4 / **pnpm は corepack シム破損で起動不可** / supabase CLI 2.58.5 / Vercel CLI 50.17.0 / gh CLI 認証済 / wrangler 未インストール / stripe CLI あり）を前提に選ぶ。MVP-first の原則として、**環境修復に時間を使う選択をしない**。

| 層 | 採用 | 選定理由 | 不採用と理由 |
|---|---|---|---|
| パッケージマネージャ | **npm 10.9.4** | 実測で動く唯一のもの。`package.json` に `packageManager` フィールドを書かず corepack を起動させない | pnpm（実測で破損。MVP初日に30分〜数時間を失うリスク）／yarn（未インストール） |
| フレームワーク | **Next.js 15 App Router** | Route Handler の `await request.text()` が生本文を返し、Pages Router 時代の bodyParser 無効化が不要（W6/P2 に直結）。LIFF の SPA とサーバーAPIを**1ドメインに閉じられる**ので N4（主な機能をミニアプリのエンドポイントドメイン内で完結）を構造的に満たす | Hono + Cloudflare Workers（wrangler 未インストール、Free の CPU 10ms 制限、導入コスト）／Remix・SvelteKit（LIFF 実装知見が薄い）／React Native + Expo（引継ぎ書§6の案。LINEミニアプリ配布では不要で、App Store 審査が追加のブロッカーになる） |
| ホスティング | **Vercel**（`vercel.json` に `"regions": ["hnd1"]` を初日から明記、I1） | CLI 50.17.0 実測。プレビューデプロイのURLをそのまま LIFF の開発用エンドポイントに差せる。Cron あり | Cloudflare Workers（同上）／自前VPS（運用工数） |
| Vercel プラン | **Phase 1〜2 は Hobby、Phase 3 で Pro** | Hobby の Cron は1日1回・±59分・**失敗しても再試行なし**（I2）。本案の cron は「Webhook と戻り先照会を取りこぼした分の救済」であり主経路ではないので、遅延許容24時間+59分で Phase 2 まで回せる | 最初から Pro（MVPで月$20を先払いする理由がない） |
| DB | **Supabase Postgres（Tokyo / ap-northeast-1）** | supabase CLI 2.58.5 実測。`supabase start` でローカルに同一メジャーの Postgres が立ち、統合テストで advisory lock・部分index・`on conflict do nothing returning` を**本番と同じエンジンで**検証できる（W1/W11） | Neon / PlanetScale（ローカルCLIの実測なし）／Cloudflare D1（Workers 前提、SQLite では advisory lock が無い） |
| **注意** | — | **Supabase 東京リージョンの可用性と料金は未確認**（統合調査 §5-5）。Phase 0 で確認する | — |
| ORM | **Drizzle ORM + drizzle-kit** | 生成SQLがそのまま読め、`insert ... on conflict do nothing returning`、部分ユニークインデックス、`select ... for update`、`pg_try_advisory_lock` を素直に書ける。W1/W3/W11 の実装が ORM の抽象に埋もれない | Prisma（上記をすべて `$queryRaw` に落とす必要があり、スキーマとSQLの二重管理になる。冪等処理は本案の心臓部なので抽象越しに書きたくない）／素の postgres.js（型が付かない） |
| マイグレーション | **drizzle-kit 生成のSQLを `supabase/migrations/` に配置して一本化** | 2系統のマイグレーション履歴を持たない | Supabase 宣言的スキーマ単独（Drizzle の型と乖離する） |
| 認証 | **LIFF IDトークン → サーバー側で自前JWT署名検証（ES256 + JWKS）→ 短命セッションJWT** | 検証経路は3つ公式に認められており（§3-14）、そのうち **JWKS による自前検証は外部APIへの往復がない**のでレイテンシと外部障害に強い。`aud` に LINE Login チャネルID を検証（N3） | Supabase Auth（LINE は公式ソーシャルログイン一覧に無く、Custom OAuth/OIDC は 2026-04-08 GA だが `signInWithOAuth` のリダイレクト往復が前提で LIFF 内の体験を壊す。**実際にサインインが成立するかも未検証**、§5-5）／`POST /oauth2/v2.1/verify` を毎回叩く（外部往復が支払フローのクリティカルパスに入る。**JWKS 取得失敗時のフォールバックとしては実装する**） |
| 決済SDK | **`@paypayopa/paypayopa-sdk-node` を `PayPayOnlineAdapter` の内部だけで使う** | 公式SDK。ただし PayPay 自身が「SDKのメンテナンスは限定的で、新機能はAPIレベルで直接追加される」と注記しているため、**アダプタ内部に fetch 直呼びの逃げ道を必ず持つ** | SDK をアプリ全体で直接使う（P1 のアダプタ層を無意味にする） |
| テスト | **Vitest（ユニット/統合）＋ Playwright（E2E）＋ `@line/liff-mock` ＋ PayPay STAGING ＋ supabase CLI のローカルPostgres** | §9 に詳述 | Jest（Vitest のほうが Next.js 15 / ESM と摩擦が少ない） |
| 型・Lint | TypeScript strict / ESLint (next) / Prettier | — | — |
| Webhook ローカル受信 | **Vercel プレビューデプロイのURLを直接事業者に登録**、加えて保存 fixture を投げる自前ハーネス `scripts/replay-webhook.ts` | PayPay には `stripe listen` 相当のツールが無い。fixture 再生は CI でも同じコードが使える | ngrok（追加の依存とアカウント） |

**stripe CLI がローカルにあるが、本案では使わない。** 候補Bを第一候補にしていないため。ただし `stripe trigger` / `stripe events resend` が提供する「重複・逆順・再送」のテスト体験は本案でも欲しいので、それを `scripts/replay-webhook.ts` で自前に再現する（§9）。

---

## 3. LINEミニアプリ統合

### 3-1. チャネル構成（N1: 最初に確定する。後から移せない）

```
プロバイダー: NonTurn LLC（1つだけ作る）
├─ LINEミニアプリチャネル「カシャ（仮）」
│   ├─ 内部チャネル: 開発用   → LIFF ID = LIFF_ID_DEV   / endpoint = Vercel preview URL
│   ├─ 内部チャネル: 審査用   → LIFF ID = LIFF_ID_REVIEW / endpoint = Vercel preview URL（固定alias）
│   └─ 内部チャネル: 本番用   → LIFF ID = LIFF_ID_PROD   / endpoint = 本番ドメイン
└─ （Phase 3）Messaging API チャネル「LINE公式アカウント」← 催促の代替手段
```

- **userId はプロバイダー単位で共通**なので、ミニアプリチャネルと Messaging API チャネルを**同一プロバイダー配下に置く**（N1）。Phase 3 で公式アカウントを足すときにユーザー同定が壊れないようにするため、プロバイダーは最初に1つだけ作って増やさない。
- Scope と友だち追加オプションは内部チャネルごとに変更できない（N6）。**権限設計は Phase 1 の着手前に一度で決める**。本案では Scope は `profile` と `openid` のみ要求する（`email` は要求しない。取得しないものは持たない）。
- `LINE_LOGIN_CHANNEL_ID`（IDトークンの `aud`）も内部チャネルごとに異なるため、3環境分を env で切り替える（N3）。

### 3-2. LIFF 初期化とセッション

```
[ミニアプリ起動]
  → liff.init({ liffId: process.env.NEXT_PUBLIC_LIFF_ID })
  → liff.isLoggedIn() ? : liff.login()            // 外部ブラウザから開かれた場合
  → const idToken = liff.getIDToken()
  → POST /api/auth/session { idToken }
      サーバー: JWKS(https://api.line.me/oauth2/v2.1/certs) で ES256 署名検証
                iss === "https://access.line.me"
                aud === LINE_LOGIN_CHANNEL_ID      // N3
                exp 検証、nonce は使わない（LIFF 経由のため）
                失敗時フォールバック: POST https://api.line.me/oauth2/v2.1/verify
                → app_user を line_user_id で upsert
      レスポンス: { sessionToken (HS256, exp=15min), user: { id } }
  → フロントは sessionToken を React context のメモリにだけ保持（N7）
  → 以後 Authorization: Bearer <sessionToken>
  → 401 を受けたら liff.getIDToken() から再発行（再発行に失敗したら liff.login()）
```

- **`liff.getDecodedIDToken()` / `liff.getProfile()` の結果をサーバーへ送らない**（N2）。送るのは IDトークンそのものだけ。
- セッションを cookie / localStorage に置かない（N7）。支払状態も認証状態も毎回サーバーの真実を取得する。
- **セッション方式の選定理由**: 短命JWTをメモリ保持する方式は、LIFF の WebView がバックグラウンドから復帰したときに必ず再認証が走るため「古い支払状態を見せる」事故が構造的に起きない。cookie にすると SameSite / ITP の挙動を LINE の WebView で個別に検証する工数が MVP に乗る。
- `LIFF_ID` は `NEXT_PUBLIC_` で露出してよい（公開情報）。`LINE_LOGIN_CHANNEL_ID` はサーバー専用にする（露出しても致命的ではないが、検証条件をクライアントに書かない規律のため）。

### 3-3. ルーティングと復帰

- **History API ベースのルーティング**（N5）。Next.js App Router がそのまま満たす。URLフラグメントを使わない。エンドポイントは https のみ。
- 決済画面は外部ドメイン（PayPay のホスト画面）へ出るが、**`returnUrl` を必須項目にして必ずミニアプリのパーマネントリンクへ戻す**（P4 / LINEの復帰要件）。
- 名簿管理・支払状況表示・イベント管理は**すべてミニアプリのエンドポイントドメイン内で完結**させる（N4）。外部へ出るのは決済画面だけ。

### 3-4. shareTargetPicker による配布

```
幹事が「参加者に請求を送る」を押す
  → liff.isApiAvailable('shareTargetPicker') で実行時判定（N8）
  → 利用可: liff.shareTargetPicker([ FlexMessage ])
  → 利用不可 / 送信キャンセル: QRコード表示 + URLコピー のフォールバックを必ず併設（N8）
```

**重要な設計判断: shareTargetPicker で配るのは「イベント単位の招待リンク」であり、参加者ごとの個別支払リンクではない。**

理由: shareTargetPicker は誰に届くかをアプリが制御できない（幹事が選ぶ／友だちのプライバシー設定で一部が表示されない）。個別リンクを配ると、A宛のリンクをBが開いて支払う事故が構造的に起こる。

代わりに次の流れを採る。

```
参加者がリンクを開く  https://miniapp.line.me/{LIFF_ID}?e={event.invite_token}
  → LIFF 認証で LINE userId が確定
  → サーバーが「この userId が claim 済みの participant」を探す
      あり → その invoice を表示
      なし → 未claimの名簿候補（氏名のみ）を出し、参加者が自分の行を選ぶ（claim）
             ※ 他人の支払状況は返さない（L6 / PII）
  → claim は unique(event_id, claimed_by_user_id) と unique(event_id, participant_id) で二重claimを構造的に防ぐ
  → 幹事側に「〇〇さんが自分を△△として登録しました」と表示し、幹事が confirm できる
```

- `liff.sendMessages()` は**集金導線で使えない前提**にする（トークルームから起動されたLIFFでのみ動作、それ以外は403。N9）。
- 参加者の表示名を IDトークンから取れる前提で作らない。**幹事が入力した名前を正とする**（N12）。`app_user.display_name` は null 許容。

### 3-5. 未認証ミニアプリで始める

**Phase 1・Phase 2 は未認証ミニアプリで本番リリースする。**

根拠: 機能差表で「決済システムの利用」「カスタムアクションボタン」「友だち追加誘導」「広告の掲載」は未認証でも可。日本の「その他の決済方法」（＝外部決済）は「一般のウェブページで決済を提供して処理するのと同様に実装してください」とされ、外部決済への遷移はブロックされない（§3-10）。**外部決済で完結する MVP は未認証で本番リリースできる。**

認証が必要になるトリガー（＝Phase 3 の入口）:

| 機能 | 認証必須か | 本案での扱い |
|---|---|---|
| サービスメッセージ（支払完了通知・催促） | 必須 | Phase 3。MVP は**幹事が shareTargetPicker で再送**に置く（N10） |
| LINE内検索・ホームタブ掲載 | 必須 | Phase 3。MVP は幹事が自分の輪にシェアするだけで足りる |
| Custom Path / ホーム画面ショートカット | 必須 | Phase 3 |
| アプリ内課金 | 必須（未認証では開発・審査用でのみ動作） | **使わない**。消耗型デジタルコンテンツ限定で、現実世界の会費集金には適合しない |
| ヘッダーへのアプリ名表示 | 必須 | Phase 3。MVP はドメイン名が出る |

未認証の既知の制約を MVP の仕様として受け入れる: 認証バッジなし、ヘッダーにドメイン名表示、LINE検索・ホームタブ非掲載。**未認証ミニアプリに利用者数の上限があるかは未確認**（§5-3 Q5）。Phase 0 で照会する。

### 3-6. 審査対応

- **サービス定義を「幹事が管理する精算・集金の台帳」に統一し、寄付・募金・クラウドファンディングの文脈を完全に排する**（N11）。アプリ名・説明文・スクリーンショット・利用規約・ストア文言のすべてで語彙を統制する。禁止語リストを `docs/wording-policy.md` に置き、CI の文言チェック（grep）で機械的に落とす。
- 認証審査の前に §5-3 の照会（特に Q1「禁止業種『募金、寄附、クラウドファンディング等の資金調達』に該当するか」、Q2「現実世界の役務の集金にアプリ内課金が必要か」、Q3「第三者間の集金仲介が『法令における規制への抵触の有無』でどう評価されるか」）を出す。**照会の回答を得てから認証申請する**。Phase 3 の完了条件に入れる。
- 2026年10月14日のポリシー改定（広告ネットワークの限定）は、本アプリが広告を掲載しないため影響しない見込み。ただし原文未確認（§3-10）。

---

## 4. データモデル

Postgres 前提。すべて `timestamptz`。金額は円の整数（`integer`）で保持し、小数を使わない。国内限定（L12）なので `currency` は `'JPY'` 固定だが列は持つ。

### 4-1. 認証・イベント

```sql
create table app_user (
  id            uuid primary key default gen_random_uuid(),
  line_user_id  text not null unique,            -- プロバイダー単位で一意（N1）
  display_name  text,                            -- 取れない前提（N12）。null 許容
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

**`organizer` テーブルは作らない。** 幹事と参加者は同じ LINE ユーザーであり、ロールはイベントごとに変わる（あるイベントの幹事が別のイベントの参加者になる）。独立したテーブルにすると同一人物が2行に割れ、userId での同定が壊れる。幹事であることは `event.organizer_user_id` の外部キーで表現する。

```sql
create table event (
  id                   uuid primary key default gen_random_uuid(),
  organizer_user_id    uuid not null references app_user(id),
  title                text not null check (length(title) between 1 and 100),
  event_at             timestamptz,
  default_amount_jpy   integer not null check (default_amount_jpy > 0),
  currency             char(3) not null default 'JPY' check (currency = 'JPY'),  -- L12
  collection_deadline  timestamptz,
  status               text not null default 'draft'
                       check (status in ('draft','collecting','closed','canceled')),
  invite_token         text not null unique,     -- 推測不能な乱数32byte base64url
  provider             text not null default 'manual'
                       check (provider in ('manual','paypay','paypal')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index event_organizer_idx on event (organizer_user_id, status, created_at desc);
```

`event.provider` を**イベント単位**で持つのが要点。幹事ごとに加盟店契約の有無が違うので、契約が済んでいない幹事のイベントは `manual` のまま動く。同一アプリ内で自動経路と手動経路が並存する。

### 4-2. 名簿と請求

```sql
create table participant (
  id                  uuid primary key default gen_random_uuid(),
  event_id            uuid not null references event(id) on delete cascade,
  display_name        text not null,             -- 幹事が入力した名前が正（N12）
  claimed_by_user_id  uuid references app_user(id),
  claim_status        text not null default 'unclaimed'
                      check (claim_status in ('unclaimed','claimed','confirmed')),
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint participant_name_uk unique (event_id, display_name)
);
-- 1イベント内で1人のLINEユーザーは1行しか claim できない
create unique index participant_claim_uk
  on participant (event_id, claimed_by_user_id)
  where claimed_by_user_id is not null;
create index participant_event_idx on participant (event_id, claim_status);
```

```sql
create table invoice (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references event(id) on delete cascade,
  participant_id  uuid not null references participant(id) on delete cascade,
  amount_jpy      integer not null check (amount_jpy > 0),
  currency        char(3) not null default 'JPY',
  status          text not null default 'unpaid'
                  check (status in ('unpaid','paid','refunded','void','canceled')),
  -- W3: provider 起因の遷移は rank 単調前進でしか進めない
  status_rank     smallint generated always as (
                    case status when 'unpaid' then 0
                                when 'paid' then 2
                                when 'refunded' then 3
                                else 0 end
                  ) stored,
  paid_at         timestamptz,
  settled_source  text check (settled_source in
                    ('provider_webhook','provider_poll','return_page','manual_organizer')),
  settled_ref     text,                          -- 確定した payment_attempt.provider_payment_ref
  overpaid_count  smallint not null default 0,   -- 二重払い検知カウンタ
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint invoice_participant_uk unique (event_id, participant_id)
);
create index invoice_reconcile_idx on invoice (status, updated_at) where status = 'unpaid';
create index invoice_event_idx on invoice (event_id, status);
```

**`pending` を `invoice.status` に置かない**のが本案の要点。`pending` を列に持つと `pending → unpaid`（決済失敗）で status_rank が後退し、W3 の単調性が壊れる。支払待ちは「生きている `payment_attempt` が存在するか」から導出する（`has_open_attempt`）。幹事の画面には「支払待ち（決済画面を開いています）」として導出値で出す。

`void`（幹事が請求を取り消す）と `canceled`（イベント中止）は `status = 'unpaid'` からのみ遷移可能で、**Webhook からは絶対に触らない**。`update invoice set status='void' where id=? and status='unpaid'` でガードする。

### 4-3. 決済試行と受信イベント

```sql
create table payment_attempt (
  id                    uuid primary key default gen_random_uuid(),
  invoice_id            uuid not null references invoice(id) on delete cascade,
  provider              text not null check (provider in ('manual','paypay','paypal')),
  provider_payment_ref  text not null,   -- 自前生成。merchantPaymentId に載せる。<=64, [A-Za-z0-9_-]
  provider_payment_id   text,            -- 事業者が採番したID（返ってきたら格納）
  amount_jpy            integer not null check (amount_jpy > 0),
  currency              char(3) not null,
  status                text not null default 'created'
                        check (status in ('created','redirected','authorized','completed',
                                          'failed','canceled','expired','refunded')),
  status_rank           smallint generated always as (
                          case status when 'created' then 0
                                      when 'redirected' then 1
                                      when 'authorized' then 2
                                      when 'completed' then 3
                                      when 'refunded' then 4
                                      else 3 end          -- failed/canceled/expired は終端
                        ) stored,
  is_terminal           boolean generated always as (
                          status in ('completed','failed','canceled','expired','refunded')
                        ) stored,
  checkout_url          text,
  expires_at            timestamptz,
  opened_by_user_id     uuid references app_user(id),   -- この checkout を開いたLINEユーザー
  proxy_confirmed_by    uuid references app_user(id),   -- 幹事が代理払いと確認したとき
  last_snapshot         jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint attempt_ref_uk unique (provider, provider_payment_ref)
);
create index attempt_invoice_idx on payment_attempt (invoice_id, created_at desc);
-- W9: 状態で走査する再照合用の部分index
create index attempt_open_idx on payment_attempt (created_at)
  where is_terminal = false;
```

`provider_payment_ref` の生成規則: `evt{event短縮ID}-inv{invoice短縮ID}-{ULIDの下位}`。64文字以内・`[A-Za-z0-9_-]` に収める。**イベントIDと請求IDを埋め込むことで、事業者APIが支払者を返さなくても（P9）どの請求への支払いかは一意に決まる。**

```sql
create table payment_event (
  id                  bigserial primary key,
  provider            text not null,
  event_id            text not null,   -- 事業者のイベントID。無ければ sha256(rawBody)
  event_type          text not null,
  object_ref          text not null,   -- = provider_payment_ref（W2の業務レベル冪等キー）
  payment_attempt_id  uuid references payment_attempt(id),
  signature_verified  boolean not null,
  verification_scheme text not null check (verification_scheme in ('signature','ip_allowlist','none')),
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  process_result      text check (process_result in
                        ('applied','duplicate','ignored','mismatch','signature_failed','error')),
  raw_body            text not null,   -- 生本文（再現・監査用）
  headers             jsonb,
  constraint payment_event_uk unique (provider, event_id)   -- W1
);
create index payment_event_unprocessed_idx on payment_event (received_at)
  where processed_at is null;
create index payment_event_object_idx on payment_event (provider, object_ref, event_type);
```

**W2 の扱いについて正直に書く。** 統合調査は `(data.object のID, event.type)` を鍵にした業務レベル冪等キーの併用を求めている（§3-13）。これを**ハード制約（unique index）にはしない**。部分返金が2回発生すれば同じ `(object_ref, event_type)` が正当に2回届きうるため、unique にすると正当なイベントを落とす。代わりに `payment_event_object_idx` を張り、適用前に `where provider=? and object_ref=? and event_type=? and process_result='applied'` を引いて既適用を検出する。加えて invoice の更新を**代入的冪等**（`set status='paid'` かつ `where status_rank < 2`）にしているため、仮に重複適用が起きても二重加算は起きない（§3-13 の「導けるのは性質要件まで」という限定に合わせた設計）。

### 4-4. 監査・同意・outbox

```sql
create table audit_log (
  id             bigserial primary key,
  actor_type     text not null check (actor_type in ('organizer','participant','system','provider')),
  actor_user_id  uuid references app_user(id),
  event_id       uuid references event(id),
  target_table   text not null,
  target_id      text not null,
  action         text not null,   -- invoice.mark_paid_manual / invoice.void / participant.claim ...
  before_state   jsonb,
  after_state    jsonb,
  reason         text,
  created_at     timestamptz not null default now()
);
create index audit_event_idx on audit_log (event_id, created_at desc);
create index audit_target_idx on audit_log (target_table, target_id, created_at desc);
```

**`invoice` の状態を変える書き込みは、例外なく同一トランザクション内で `audit_log` に1行書く。** 引継ぎ書§7の「更新履歴」要件。特に `mark_paid_manual`（手動確認）は監査ログ必須で、`reason` を入力必須にする。

```sql
create table consent (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app_user(id),
  event_id        uuid not null references event(id) on delete cascade,
  kind            text not null,           -- 'disclose_payment_status_to_organizer'
  policy_version  text not null,
  agreed_at       timestamptz not null default now(),
  constraint consent_uk unique (user_id, event_id, kind)
);
```

L6（支払状況を幹事に開示することへの同意）を初回導線で取る。`consent` 行が無い参加者の支払状況を幹事画面に出さない。

```sql
create table outbox (
  id            bigserial primary key,
  kind          text not null,    -- 'notify_organizer_mismatch' / 'notify_overpaid' ...
  payload       jsonb not null,
  run_after     timestamptz not null default now(),
  attempts      smallint not null default 0,
  locked_until  timestamptz,
  done_at       timestamptz,
  last_error    text,
  created_at    timestamptz not null default now()
);
create index outbox_pending_idx on outbox (run_after) where done_at is null;
```

W5: Webhook は署名検証 → 重複排除 → 状態更新 までを同期で済ませて 2xx を即返し、通知など重い処理は outbox に積んで cron で流す。

### 4-5. インデックス設計の意図（まとめ）

| index | 目的 |
|---|---|
| `app_user.line_user_id` unique | 認証の毎リクエスト参照。プロバイダー単位一意の担保 |
| `event.invite_token` unique | 参加者リンクの入口。推測不能な乱数なので列挙耐性はトークン側で担保 |
| `participant_name_uk (event_id, display_name)` | 同一イベント内の名前重複を禁止。同名は幹事が「田中(営業)」等で区別する責任 |
| `participant_claim_uk (event_id, claimed_by_user_id) where not null` | 1イベント1人1行。二重claimを構造的に防ぐ |
| `invoice_participant_uk (event_id, participant_id)` | 1参加者1請求。追加徴収（二次会）は別イベントで表現する（P8） |
| `invoice_reconcile_idx where status='unpaid'` | W9: 時刻カーソルでなく状態で走査。1回飛んでも次回で拾える |
| `attempt_ref_uk (provider, provider_payment_ref)` | Webhook から attempt を引く唯一の経路。重複発行の防止 |
| `attempt_open_idx where is_terminal=false` | 再照合の走査対象を部分indexで絞る |
| `payment_event_uk (provider, event_id)` | W1: 重複配信の一次防波堤 |
| `payment_event_object_idx` | W2: 業務レベル冪等の既適用チェック |

---

## 5. API / Webhook 設計

すべて Next.js App Router の Route Handler。**MVPでは RLS を使わず、全DBアクセスをサーバー側に閉じる**（I3）。Supabase の anon key をクライアントへ出さない。参加者側から金額・状態を書き換えられないことを、クライアントがDBに到達できないという構造で保証する。

### 5-1. エンドポイント一覧

| メソッド | パス | 認可 | 冪等 | 説明 |
|---|---|---|---|---|
| POST | `/api/auth/session` | なし（入口） | — | `{idToken}` を検証し短命セッションJWTを返す |
| GET | `/api/me` | セッション | — | 自分の `app_user` |
| POST | `/api/events` | セッション | `Idempotency-Key` | イベント作成。作成者が organizer |
| GET | `/api/events/:id` | **organizer のみ** | — | イベント詳細＋名簿＋集計 |
| PATCH | `/api/events/:id` | organizer | — | title / 締切 / status（`collecting`→`closed` 等） |
| POST | `/api/events/:id/participants` | organizer | `Idempotency-Key` | 名簿の一括追加 `{names: string[], amount?}`。invoice も同時発行 |
| PATCH | `/api/invoices/:id` | organizer | — | 金額変更。**`status='unpaid'` のときのみ**。それ以外は `AMOUNT_LOCKED` |
| POST | `/api/invoices/:id/void` | organizer | — | 請求取消。`where status='unpaid'` ガード |
| POST | `/api/invoices/:id/mark-paid-manual` | organizer | `Idempotency-Key` | **手動確認（非自動）**。`reason` 必須、`settled_source='manual_organizer'`、audit_log 必須 |
| POST | `/api/invoices/:id/unmark-paid-manual` | organizer | — | 手動確認の取り消し。**`settled_source='manual_organizer'` の行にのみ許可**。事業者由来の `paid` は取り消せない |
| GET | `/api/join/:inviteToken` | セッション | — | イベント概要＋未claimの名簿候補（**氏名のみ。他人の支払状況は返さない**） |
| POST | `/api/join/:inviteToken/claim` | セッション | 一意制約 | `{participantId}` を自分に紐づける。衝突は `CLAIM_TAKEN` |
| GET | `/api/my/invoice?event=:id` | セッション（本人の請求のみ） | — | 自分の請求1件と支払状況 |
| POST | `/api/invoices/:id/checkout` | セッション（本人の請求のみ） | 有効attempt再利用 | `payment_attempt` 作成 → `adapter.createCheckout` → `checkoutUrl` または手動指示 |
| GET | `/api/payments/:attemptId/status` | セッション（本人 or organizer） | — | **戻り先ページから1回だけ叩く**（P3）。`adapter.getPaymentStatus` を呼んで確定させる |
| POST | `/api/webhooks/:provider` | 署名 or IP許可リスト | W1/W2 | 事業者からの通知 |
| POST | `/api/cron/reconcile` | `CRON_SECRET` ヘッダ | advisory lock | 未確定 attempt の再照会 |
| POST | `/api/cron/outbox` | `CRON_SECRET` ヘッダ | advisory lock | outbox の配送 |

### 5-2. 認可モデル

- セッション必須（`/api/webhooks/*` と `/api/cron/*` を除く）。
- **organizer リソースは「取得してから判定」ではなく「WHERE 条件に入れて取得」する。**
  ```ts
  // 正: 他人のイベントは存在しないものとして 404
  const ev = await db.query.event.findFirst({
    where: and(eq(event.id, id), eq(event.organizerUserId, session.userId))
  });
  ```
- 参加者リソースは `invoice → participant.claimed_by_user_id = session.userId` を結合条件に入れる。
- 参加者は**他人の氏名以外の情報を一切取得できない**。`/api/join/:inviteToken` が返すのは未claimの候補の氏名だけで、支払状況・金額の内訳は含めない（L6）。
- `event.invite_token` は 32byte 乱数の base64url。列挙攻撃に対しては長さで守り、レート制限（IP + セッション単位、10req/min）を掛ける。

### 5-3. Webhook 処理手順（W1〜W12 の実装形）

```
POST /api/webhooks/:provider
 1. const raw = await request.text()                      // P2: 生本文。JSON.parse しない
    ボディサイズ上限 256KB（超過は 413）
 2. const v = adapter.verifyWebhook(raw, request.headers)
    失敗 → payment_event に signature_verified=false / process_result='signature_failed'
            で記録して 400（記録するが状態は一切触らない）
    ※ 署名シークレットは複数同時に試す（W12: 旧シークレットが最大24時間併存）
    ※ PayPay は署名がないため verification_scheme='ip_allowlist'（W7）
 3. const ev = adapter.parseWebhook(raw, request.headers)  // 正規化イベント
 4. insert into payment_event (...) values (...)
      on conflict (provider, event_id) do nothing returning id   // W1
    → 0行なら 200 {"result":"duplicate"} で即返す
 5. payment_attempt を (provider, provider_payment_ref = ev.objectRef) で引く
    → 無ければ process_result='ignored' で 200（自分が発行したものでない）
 6. ★ 必ず adapter.getPaymentStatus(ev.objectRef) を呼ぶ（W7 / P3）
    Webhook 本文の金額・状態を確定の根拠にしない
 7. 突合（W8）: snapshot.money.amountJpy === invoice.amount_jpy
              && snapshot.money.currency === invoice.currency
    不一致 → invoice を更新せず process_result='mismatch'、outbox に
             'notify_organizer_mismatch' を積む
 8. トランザクション:
      update payment_attempt set status=..., last_snapshot=...
        where id=? and status_rank < ?                    // W3
      if snapshot.status === 'completed':
        update invoice set status='paid', paid_at=..., settled_source='provider_webhook',
                           settled_ref=?
          where id=? and status_rank < 2                  // W3: 単調前進のみ
        更新0行 かつ 既に paid かつ settled_ref が別の attempt
          → update invoice set overpaid_count = overpaid_count + 1
             outbox に 'notify_overpaid'（返金が要る）
      insert into audit_log (actor_type='provider', ...)
      update payment_event set processed_at=now(), process_result='applied'
 9. 200 を返す（W5: 重い処理は outbox へ）
```

- `created` / `occurredAt` を順序判定にも処理済み判定にも使わない（W4）。順序は `status_rank` の単調性だけで担保する。
- Webhook ルートは CSRF 保護から除外し、ボディパーサを通さない（W6）。Next.js App Router の Route Handler は既定でボディパーサを挟まない。

### 5-4. 戻り先ページの扱い（P3）

```
決済完了 → returnUrl（ミニアプリのパーマネントリンク）へ復帰（P4 / LINEの復帰要件）
  → クライアントが GET /api/payments/:attemptId/status を「1回だけ」叩く
  → サーバーは adapter.getPaymentStatus を呼び、§5-3 の手順 6〜8 と同じ適用関数を通す
  → 以後はポーリングしない。Webhook と cron 再照合に委ねる
```

**リダイレクト到達を支払い確定の根拠にしない。** PayPay は「リダイレクトが返らない場合を公式に前提」としており、Stripe も「ランディングページに限定してフルフィルメントをトリガーできない」と明記している。到達は「照会するきっかけ」にすぎない。

### 5-5. 再照合ジョブ

```
POST /api/cron/reconcile   （Vercel Cron。Hobby: 1日1回 ±59分、失敗しても再試行なし）
 1. select pg_try_advisory_lock(hashtext('reconcile'))    // W11: 多重起動防止
    取れなければ即 200
 2. 走査（W9: 時刻カーソルでなく状態で走査）:
      select * from payment_attempt
        where is_terminal = false
          and created_at > now() - interval '7 days'      // W10: Stripe再送3日 + 余裕
        order by created_at
        limit 200
        for update skip locked                            // W11: 行ロック
 3. 各 attempt に adapter.getPaymentStatus → §5-3 の手順 6〜8 と同じ適用関数
 4. expires_at を過ぎて未確定のものは status='expired' へ
 5. advisory unlock
```

**遅延の正直な申告**: Hobby プランでは最悪 24時間 + 59分の反映遅れが起きる。かつ失敗しても再試行されない。これは救済経路であり、通常は Webhook と戻り先照会で数秒以内に確定する。分単位の再照合が要件になった時点で Vercel Pro が前提になる（I2）。

### 5-6. エラー応答

```json
{ "error": { "code": "INVOICE_ALREADY_PAID", "message": "この請求はすでに支払済みです", "details": {} } }
```

| HTTP | code | 意味 |
|---|---|---|
| 400 | `INVALID_REQUEST` | バリデーション失敗 |
| 401 | `SESSION_EXPIRED` | セッションJWT期限切れ → クライアントは IDトークンから再発行 |
| 401 | `ID_TOKEN_INVALID` | LINE IDトークンの検証失敗 |
| 403 | `NOT_ORGANIZER` / `NOT_YOUR_INVOICE` | 認可失敗 |
| 404 | `NOT_FOUND` | 他人のリソースもこれで返す（存在を漏らさない） |
| 409 | `CLAIM_TAKEN` | その名簿行は他のユーザーが claim 済み |
| 409 | `INVOICE_ALREADY_PAID` | 支払済みの請求への金額変更・void |
| 409 | `AMOUNT_LOCKED` | `status != 'unpaid'` の請求への金額変更 |
| 422 | `AMOUNT_MISMATCH` | 事業者の金額と請求額が不一致（W8） |
| 429 | `RATE_LIMITED` | レート制限 |
| 501 | `NOT_SUPPORTED` | アダプタが未対応（例: PayPay の2回目の返金、P7） |
| 502 | `PROVIDER_UNAVAILABLE` | 事業者APIの障害 |

---

## 6. PaymentProvider アダプタ IF と初期アダプタ

P1 の要求（`createCheckout` / `parseWebhook(rawBody, headers)` / `getPaymentStatus` / `refund`）を満たしつつ、統合調査が明らかにした4つの「事業者が返してくれないもの」を**型で強制**する。

```ts
// src/payments/types.ts

export type ProviderId = 'manual' | 'paypay' | 'paypal';

export type Money = { amountJpy: number; currency: 'JPY' };

/** 正規化された支払状態。事業者固有の状態名はアダプタ内で潰す */
export type NormalizedStatus =
  | 'created' | 'redirected' | 'authorized' | 'completed'
  | 'failed'  | 'canceled'   | 'expired'    | 'refunded'
  | 'unknown';

export type CheckoutRequest = {
  invoiceId: string;
  /** 自前生成。merchantPaymentId / client_reference_id に載せる。<=64, [A-Za-z0-9_-] (P9) */
  paymentRef: string;
  money: Money;
  description: string;
  /** 必須。LINEミニアプリのパーマネントリンクへ戻す (P4) */
  returnUrl: string;
  expiresAt?: Date;
};

/** 手動確認（非自動）経路。UI はこれを受け取ったら必ず非自動バッジを出す */
export type ManualInstruction = {
  readonly automatic: false;
  channel: 'paypay_p2p' | 'bank_transfer' | 'cash';
  deepLink?: string;
  note: string;
  /** 幹事の手動チェックが必要であることを画面に出す文言（ハードコードでなく型で運ぶ） */
  disclaimer: '支払いの確認は幹事が手動で行います。アプリは入金を検知しません。';
};

export type CheckoutResult =
  | { kind: 'redirect'; checkoutUrl: string; providerPaymentId?: string; expiresAt?: Date }
  | { kind: 'manual'; instruction: ManualInstruction };

export type PaymentSnapshot = {
  provider: ProviderId;
  paymentRef: string;
  providerPaymentId?: string;
  status: NormalizedStatus;
  money: Money;
  paidAt?: Date;
  /** ★ 常に null。どの事業者も支払者を返さない (P9 / §3-12)。
   *  型で null に固定し、「支払者が取れる」という誤った前提をコード上で書けなくする */
  payerIdentity: null;
  raw: unknown;
};

export type WebhookVerification =
  | { ok: true;  scheme: 'signature' | 'ip_allowlist' }
  | { ok: false; scheme: 'signature' | 'ip_allowlist' | 'none'; reason: string };

export type NormalizedWebhookEvent = {
  provider: ProviderId;
  /** 事業者のイベントID。無い事業者では sha256(rawBody) を使う (W1) */
  eventId: string;
  eventType: string;
  /** = paymentRef。業務レベル冪等キーの一部 (W2) */
  objectRef: string;
  /** ★ 常に true。Webhook 本文を確定の根拠にせず必ず再照会する (P3 / W7) */
  readonly requiresRefetch: true;
};

export type RefundResult =
  | { ok: true; refundedMoney: Money; refundRef: string }
  | { ok: false; reason: 'not_supported' | 'already_refunded' | 'provider_error'; detail: string };

export type ProviderCapabilities = {
  /** false のアダプタは「手動確認（非自動）」。UI・CSV・APIレスポンスにラベルを出す */
  automaticDetection: boolean;
  /** PayPay は false → IP許可リスト＋必ず再照会 (W7) */
  webhookSignature: boolean;
  /** PayPay は 'full_once'（1注文1回のみ, P7） */
  refund: 'none' | 'full_once' | 'full' | 'partial';
  /** ★ 全事業者 false。型レベルで固定 (P9) */
  readonly payerIdentity: false;
  /** 幹事画面の「入金予定」表示に使う (P6) */
  settlementDelay: 'instant' | 't_plus_4bd' | 'monthly' | 'n_a';
};

export interface PaymentProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;

  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;

  /** 生の本文と Headers を受け取る。アダプタの外で JSON.parse しない (P2) */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification;
  parseWebhook(rawBody: string, headers: Headers): NormalizedWebhookEvent;

  getPaymentStatus(paymentRef: string): Promise<PaymentSnapshot>;

  /** 非対応は例外を投げず ok:false / 'not_supported' で上位へ伝える (P7) */
  refund(paymentRef: string, money?: Money): Promise<RefundResult>;
}
```

### 6-1. 初期アダプタ

**Phase 1 で出荷する最初のアダプタは `ManualPayPayAdapter`（手動確認・非自動）。Phase 2 で最初の自動アダプタとして `PayPayOnlineAdapter` を入れる。**

```ts
// src/payments/manual-paypay.ts  ── Phase 1。自動検知しない
export const manualPayPayAdapter: PaymentProvider = {
  id: 'manual',
  capabilities: {
    automaticDetection: false,      // ★ 手動確認（非自動）
    webhookSignature: false,
    refund: 'none',
    payerIdentity: false,
    settlementDelay: 'n_a',
  },
  async createCheckout(req) {
    return {
      kind: 'manual',
      instruction: {
        automatic: false,
        channel: 'paypay_p2p',
        deepLink: undefined,        // 幹事が自分のPayPay受け取りリンク/QRを登録した場合のみ
        note: `${req.description} ${req.money.amountJpy}円`,
        disclaimer: '支払いの確認は幹事が手動で行います。アプリは入金を検知しません。',
      },
    };
  },
  verifyWebhook: () => ({ ok: false, scheme: 'none', reason: 'manual adapter has no webhook' }),
  parseWebhook: () => { throw new Error('manual adapter has no webhook'); },
  async getPaymentStatus(ref) {
    return { provider: 'manual', paymentRef: ref, status: 'unknown',
             money: { amountJpy: 0, currency: 'JPY' }, payerIdentity: null, raw: null };
  },
  async refund() {
    return { ok: false, reason: 'not_supported', detail: '手動経路に返金機能はありません' };
  },
};
```

```ts
// src/payments/paypay-online.ts  ── Phase 2。最初の自動アダプタ
export const payPayOnlineAdapter: PaymentProvider = {
  id: 'paypay',
  capabilities: {
    automaticDetection: true,
    webhookSignature: false,        // ★ 公開ドキュメントに署名検証の記載なし (W7)
    refund: 'full_once',            // ★ "Currently we only support 1 refund per order." (P7)
    payerIdentity: false,           // ★ 決済詳細レスポンスに支払者識別フィールドなし (P9)
    settlementDelay: 'monthly',     // ★ 月末入金 月1回（確信度 低・未検証）(P6)
  },
  // createCheckout: Web Cashier の QR/リンク生成。merchantPaymentId = req.paymentRef
  // verifyWebhook : IP許可リストのみ。ok:true でも必ず getPaymentStatus で再照会する
  // parseWebhook  : eventId が無いため sha256(rawBody) を eventId に使う
  // getPaymentStatus: GET /v2/codes/payments/{merchantPaymentId}
  // refund        : 2回目は ok:false / 'already_refunded'
  ...
};
```

`PayPalAdapter`（`PAYMENT.CAPTURE.COMPLETED`、`settlementDelay: 'instant'`、`webhookSignature: true`）は Phase 2 の退避先として同じIFで用意する。

### 6-2. 「手動確認（非自動）」ラベルの貫通

`capabilities.automaticDetection === false` または `invoice.settled_source === 'manual_organizer'` のとき、次のすべてにラベルを出す。これを**テストで強制する**（§9）。

| 面 | 表示 |
|---|---|
| 参加者の支払画面 | 「支払いの確認は幹事が手動で行います。アプリは入金を検知しません。」 |
| 幹事の名簿行 | ✅ の横に「手動確認」バッジ。事業者由来の ✅ とは別アイコン |
| 幹事の集計 | 「支払済み 2/4（うち手動確認 2件）」 |
| API レスポンス | `{ "settledSource": "manual_organizer", "automatic": false }` |
| CSV 出力 | `settled_source` 列を必ず含める |
| イベント作成時 | `provider='manual'` を選ぶ画面で「このイベントでは自動チェックは行われません」を明示し、チェックボックスで同意を取る |

---

## 7. 状態遷移

### 7-1. invoice（請求）

```
                      [幹事が請求を発行]
                              |
                              v
  (幹事が取消) <───────────  unpaid  ───────────> (イベント中止)
        |                  /     \                        |
        v                 /       \                       v
      void               /         \                  canceled
   (終端・手動のみ)      /           \              (終端・手動のみ)
                        /             \
      [事業者由来]      /               \      [手動確認（非自動）]
   Webhook / 戻り先照会 /                 \  幹事が mark-paid-manual
   / cron 再照合       /                   \  settled_source='manual_organizer'
                      v                     v
                    paid ◄──────────────────┘
                      |
                      | (事業者の返金が完了)
                      v
                  refunded
                   (終端)

  ※ 支払待ちは列で持たない。生きている payment_attempt の有無から導出する
  ※ status_rank: unpaid=0, paid=2, refunded=3。provider 由来の更新は
     `where status_rank < :new_rank` でのみ前進（W3）
  ※ void / canceled は `where status='unpaid'` ガード付きの手動操作専用。
     Webhook からは絶対に遷移させない
```

### 7-2. payment_attempt（決済試行）

```
  created ──> redirected ──> authorized ──> completed ──> refunded
     |            |              |
     +------------+--------------+──> failed / canceled / expired（終端）

  ※ 終端に落ちても invoice は unpaid のまま。参加者は新しい paymentRef で再試行できる
  ※ status_rank で単調前進。逆順配信が来ても後退しない（W3/W4）
```

### 7-3. 例外の扱い

| 例外 | 検知 | 処理 | 自動/手動 |
|---|---|---|---|
| **失敗** | Webhook `FAILED` / 再照会 | attempt を `failed` に。invoice は `unpaid` のまま。参加者に「もう一度お支払いください」 | 自動 |
| **キャンセル** | Webhook `CANCELED` / 再照会 | attempt を `canceled` に。同上 | 自動 |
| **期限切れ** | Webhook `EXPIRED` / cron が `expires_at` 超過を検出 | attempt を `expired` に。同上 | 自動 |
| **二重払い** | 同一 invoice に `completed` の attempt が2件以上 | invoice は `paid` のまま（代入的冪等で二重加算なし）。`overpaid_count` を +1 し、outbox で幹事に「返金が必要です」。返金は幹事が `adapter.refund` を起動 | 検知は自動／**返金操作は幹事の手動** |
| **返金** | `adapter.refund` の結果 + Webhook | invoice を `refunded`。`refunded` から `paid` へは戻さない。再徴収は**新しい invoice** を発行 | 半自動 |
| **PayPay で2回目の返金** | `capabilities.refund === 'full_once'` | `501 NOT_SUPPORTED`。幹事に「PayPay側での個別対応が必要」と案内 | **手動（非自動）** |
| **遅延（Webhook が来ない）** | cron 再照合（最大 24h+59min、Hobby） | 再照会して確定。参加者の戻り先照会が先に拾うのが通常 | 自動（遅延あり） |
| **代理払い** | `payment_attempt.opened_by_user_id !== participant.claimed_by_user_id` | **「代理払いの可能性」として幹事に提示するだけ。** 事業者APIは支払者を返さない（P9）ので、これは「誰がリンクを開いたか」の推定にすぎない。幹事が確認して `proxy_confirmed_by` を立てて初めて代理払いとして記録する | **検知は推定・確定は幹事の手動（非自動）** |
| **金額不一致** | W8 の突合 | invoice を更新せず `mismatch`。outbox で幹事に通知。**自動で paid にしない** | 自動検知・手動解決 |
| **署名／IP検証失敗** | `verifyWebhook` | `payment_event` に記録して 400。状態は一切触らない | 自動 |
| **イベント中止** | 幹事の操作 | `unpaid` の invoice を `canceled` に。`paid` の invoice は `refunded` へ（幹事が返金を起動）。**運営者は返金原資を持たない**（L4） | 手動 |

**代理払いについての正直な記述**: 引継ぎ書§7 は「代理払いを追える」を要件に挙げているが、統合調査 §3-12 のとおり決済事業者APIは支払者を返さない。本案が提供するのは「誰がその支払リンクを開いたか」という**推定**と、幹事の確認操作だけである。「自動で代理払いを検知した」とは画面にも仕様書にも書かない。

---

## 8. フェーズ分割

### Phase 0 — 事業者照会 / 法務ゲート（2〜6週間、Phase 1 と**並走**）

実装を止めない。照会を投げてから Phase 1 に着手する。

| # | 宛先 | 内容 | 優先 |
|---|---|---|---|
| 0-1 | **PayPay 加盟店窓口** | §5-1 Q1〜Q3（会費徴収が取扱可能商材か / イベント参加権の販売が規約の「役務」に含まれるか / 実店舗を持たない個人事業主が申し込めるか） | **最優先。この1本で第一候補の go/no-go が決まる** |
| 0-2 | PayPay 技術窓口 | §5-1 Q5〜Q6（Webhook の署名検証・IP許可リスト・リトライ仕様 / 決済詳細に支払者情報が含まれるか） | 高（W7 の設計根拠） |
| 0-3 | **弁護士** | §5-4 Q1〜Q4（特に **内閣府令1条の2第3号ニ（銀行等・資金移動業者からの委託）に乗る構成**。反証検証で新たに浮上した経路） | **最優先。L11 のゲート** |
| 0-4 | LINEヤフー | §5-3 Q1〜Q3, Q5, Q6（禁止業種該当性 / アプリ内課金の要否 / 集金仲介の審査評価 / 未認証の利用者数上限 / プラットフォーム利用料） | 中（Phase 1 の出荷可否に効く Q1・Q5 だけ先に） |
| 0-5 | PayPal | 個人アカウントでの受取可否と API 資格（§5-5） | 中（第二候補の実在確認） |
| 0-6 | Supabase | 東京リージョンの可用性と料金（§5-5） | 低（技術的な代替は効く） |

**Phase 0 の完了条件**

- PayPay から「会費徴収が取扱可能商材か」について**書面（メール可）の回答**を得ている。
- 弁護士から、§1-1 の資金フロー（運営者が資金に一切触れない）について**書面の所見**を得ている。
- LINEヤフーから、Phase 1 の未認証リリースについて禁止業種に当たらないことの回答を得ている（**得られない場合も Phase 1 の未認証リリース自体は規約上ブロックされないが、リリース後の是正リスクを負う**ことを記録する）。
- **Phase 2 の本番決済有効化は、0-1 と 0-3 が揃うまで行わない**（L11）。

### Phase 1 — 決済非依存コア（2〜3週間）

Phase 0 の回答を待たずに着手する。ここで作るものは決済事業者が変わっても捨てない。

| # | 成果物 |
|---|---|
| 1-1 | プロバイダー・チャネル作成（N1。**やり直せないので最初**）、LIFF 3環境、`vercel.json` に `hnd1`（I1） |
| 1-2 | LIFF 初期化 → IDトークンの自前JWT検証（ES256+JWKS）→ 短命セッションJWT（N2/N3/N7） |
| 1-3 | データモデル全テーブル（§4）。invoice・payment_attempt・payment_event・audit_log・consent・outbox を**この時点で全部作る** |
| 1-4 | イベント作成 / 名簿の一括追加 / 請求発行 / 金額の個別調整 |
| 1-5 | shareTargetPicker 配布 + QR/URLコピーのフォールバック（N8）、招待リンク → claim フロー |
| 1-6 | `ManualPayPayAdapter`（手動確認・非自動）＋ `mark-paid-manual` ＋ 「手動確認（非自動）」ラベルの全面貫通（§6-2） |
| 1-7 | Webhook 冪等基盤（§5-3 の手順を実装。適用関数は Phase 2 でそのまま使う）＋ cron 再照合の骨格＋ outbox |
| 1-8 | 同意取得（L6）、プライバシーポリシー（L7）、利用規約（L5 の債務消滅条項を含む）、文言統制（N11）と CI の禁止語チェック |
| 1-9 | E2E 3本（重複 / 逆順 / 署名不一致、I5）＋ 幹事フロー・参加者フローの E2E |

**Phase 1 の完了条件**

1. NonTurn 社内の実イベント1件（参加者4名以上）を、幹事1名が**サポートなしで**完走できる。
2. E2E 3本（重複・逆順・署名不一致）が緑。
3. 「手動確認（非自動）」ラベルが、参加者画面・幹事名簿・集計・APIレスポンス・CSV のすべてに出ることを自動テストが検証している。
4. **「自動チェック要件を満たした」と一切表示していないことを、文言テストで機械的に確認している。**
5. `supabase start` のローカルPostgres に対する統合テストで、同一Webhookを100並列で投げても invoice が1回しか paid にならない。

### Phase 2 — 自動アダプタ（2〜4週間。Phase 0-1 と 0-3 の回答後）

| # | 成果物 |
|---|---|
| 2-1 | `PayPayOnlineAdapter` を STAGING（`env:"STAGING"`）で完成（I6） |
| 2-2 | 戻り先1回照会（§5-4）、Webhook の本番接続、IP許可リスト（W7） |
| 2-3 | cron 再照合の本番稼働（W9/W10/W11） |
| 2-4 | 金額不一致 / 二重払い / 返金の幹事UI（§7-3） |
| 2-5 | イベント単位の provider 切替（加盟店契約済みの幹事だけ自動経路に乗る） |
| 2-6 | 退避: PayPay が NG判定なら `PayPalAdapter` へ差し替え（アダプタIFは変えない） |

**Phase 2 の完了条件**

1. STAGING で「参加者3名が別々の端末から支払い、3名とも自動で ✅ が付く」を録画付きで再現している。
2. 重複配信 / 逆順配信 / Webhook 欠損（cron のみでの確定）の3シナリオが STAGING で再現できている。
3. **本番決済の有効化は、Phase 0-1（PayPay の商材回答）と Phase 0-3（弁護士所見）の両方が揃ってからのみ行う**（L11）。揃っていなければ Phase 2 は STAGING 止まりで完了とし、Phase 1 の手動モードで運用を続ける。
4. 幹事画面に「支払済み（決済完了）」と「幹事への入金予定」が**別ステータス**で出ている（P6）。

### Phase 3 — 運用（継続）

| # | 成果物 |
|---|---|
| 3-1 | 認証ミニアプリ申請（§5-3 の照会回答を得てから）。審査 1〜2週間（未検証） |
| 3-2 | サービスメッセージによる支払完了通知（認証後）。催促は「ユーザーの操作への応答」の枠内でしか送れない前提（N10）。枠外なら Messaging API（通数課金） |
| 3-3 | Vercel Pro へ移行し cron を分単位に（I2） |
| 3-4 | CSV 出力、複数イベント横断の台帳、21名以上のイベント（PayPay グループ支払いの20名制限を超える差別化軸） |
| 3-5 | `BankReconciler`（候補E）の検討を再開するかの判断 |

**Phase 3 の完了条件**: 認証ミニアプリ取得。NonTurn 社外の幹事3名がサポートなしで完走。

---

## 9. テスト戦略

### 9-1. 最初に書く3本（I5）

Phase 1 の 1-7 と同時に、他の何よりも先に書く。引継ぎ書§7 の「重複再送で二重加算しない」「順序入れ替わり」の**証拠**になるため。

1. **重複配信**: 同一 `(provider, event_id)` の Webhook を100並列で投げる → `payment_event` は1行、`invoice.status` は `paid` 1回、`audit_log` は1行。
2. **逆順配信**: `completed` → `authorized` の順に投げる → invoice は `paid` のまま後退しない（W3）。
3. **署名／IP検証不一致**: 改竄した本文・許可外IPを投げる → 400、`payment_event.process_result='signature_failed'`、**invoice は一切変わらない**。

### 9-2. レイヤ別

| 層 | ツール | 対象 |
|---|---|---|
| ユニット | Vitest | `parseWebhook` / `verifyWebhook`（保存 fixture）、状態遷移の純粋関数、金額突合、`paymentRef` 生成規則（64文字・文字種）、IDトークン検証（固定JWKSと固定トークンのペア） |
| 統合 | Vitest + `supabase start` のローカルPostgres | §9-1 の3本、`on conflict do nothing returning` の挙動、部分indexが使われること（`explain`）、`pg_try_advisory_lock` の多重起動防止、`for update skip locked` の同時実行、claim の一意制約 |
| E2E | Playwright + `@line/liff-mock` | 幹事フロー（イベント作成→名簿→配布）、参加者フロー（リンク→claim→支払）、**「手動確認（非自動）」ラベルの表示検証**、文言テスト（禁止語が画面に出ないこと） |
| 決済サンドボックス | PayPay `env:"STAGING"`（I6） | Phase 2 の 2-1。加盟店審査前から実装検証を始められる（確信度 中） |
| Webhook 再生 | 自前 `scripts/replay-webhook.ts` | 保存 fixture を任意の順序・回数で投げる。`stripe trigger` / `stripe events resend` 相当を PayPay でも使えるようにする。CI でも同じスクリプトを使う |

### 9-3. LIFF モックの扱い（I4）

- `@line/liff-mock` を `liff.use(new LiffMockPlugin())` + `liff.init({ mock: true })` で有効化。
- **環境変数で切り替え、`await import()` の動的importにしてモック版を本番バンドルに入れない**（I4）。
- `vi.mock` は実ブラウザで効かないので Playwright では使わない。
- `shareTargetPicker` は `liff.isApiAvailable` を含めてモックし、**「利用不可」側の分岐（QRフォールバック）も必ずテストする**。

### 9-4. テストしないと決めたこと（正直に）

- LINE の実機（iOS/Android の LINE アプリ内WebView）での動作は自動テストしない。Phase 1 の完了条件1（社内実イベント1件の完走）を手動テストの代わりにする。
- 本番決済のテストは行わない。STAGING のみ。本番決済の有効化は Phase 0 のゲート後（L11）。
- 負荷試験は行わない。MVP の想定は1イベント20〜50名。

---

## 10. 費用概算（すべて未確定）

**この節の数値は一次資料の確信度が低く（統合調査の大半が「未検証」）、見積もりではない。** 事業者照会の回答で変わる。

### 10-1. 運営者（NonTurn LLC）のランニング

| 項目 | Phase 1〜2 | Phase 3 | 備考 |
|---|---|---|---|
| Vercel | ¥0（Hobby） | 約$20/月（Pro） | cron を分単位にする時点で Pro（I2） |
| Supabase | ¥0（Free） | 約$25/月（Pro） | **東京リージョンの料金は未確認**（§5-5） |
| ドメイン | 約¥2,000/年 | 同左 | — |
| LINEミニアプリ | **不明** | **不明** | プラットフォーム利用料の有無が未確認（§5-3 Q6） |
| Messaging API（Phase 3 の催促） | — | 通数課金（未確認） | サービスメッセージが公式アカウントの通数にカウントされるかも未確認 |
| 弁護士・グレーゾーン照会 | **不明（一時費用）** | — | Phase 0-3。数十万円規模になる可能性 |

### 10-2. 幹事の負担

| 項目 | 内容 | 確信度 |
|---|---|---|
| 決済手数料 | PayPay オンライン: 物販3.8% / デジタルコンテンツ10%。5,000円なら190円 or 500円。**どちらの区分になるかも未確認** | 低（未検証） |
| 加盟店審査 | 2週間〜1カ月＋利用開始まで5営業日。事業実態の証憑が要る | 低（未検証） |
| 入金時期 | 月末入金 月1回。**当日の立替は解消しない** | 低（未検証） |
| **手数料の負担者** | **幹事負担、または会費に内包**（P5: 参加者への上乗せ請求は加盟店規約に抵触する恐れ） | 低（未検証） |

### 10-3. 参加者の負担

- **上乗せなし**（P5）。参加者が払うのは幹事が設定した会費額のみ。
- 比較として、**PayPay / Kyash / LINE内PayPay の個人間送金は手数料0円**。本アプリの自動経路は構造的にコスト不利であり、手数料3.8%は「幹事が手動確認の手間を省く対価」として説明するしかない。

---

## 11. この案で満たせない要件・弱点

正直に列挙する。**この節を削ったり緩めたりして提示しない。**

1. **Phase 1 は引継ぎ書の中心要件を満たさない。** 支払確認はすべて手動であり、「参加者の支払いを検知して自動でチェックが付く」わけではない。引継ぎ書はこの縮退案を「中心要件を満たさない」と明記している。**Phase 1 を「自動チェック要件を満たした」と説明してはならない。** Phase 1 を出荷するには、これが暫定であることについてユーザーの明示的な同意が要る。
2. **引継ぎ書の3条件（自動検知 × 個人PayPay受取 × 非事業者のまま）の同時達成は、本案でも不可能。** Phase 2 で受取先を「幹事の個人PayPay残高」から「幹事名義の加盟店売上→指定口座」へ変える。これは調査統合レポート §7-1 の結論をそのまま受け入れたものであり、本案の設計で回避できるものではない。
3. **代理払いの自動検知はできない。** 決済事業者APIは支払者を返さない（P9）。本案が出せるのは「誰がリンクを開いたか」という推定と幹事の確認操作だけ。引継ぎ書§7 の「代理払いを追える」は部分的にしか満たせない。
4. **幹事1人ごとに加盟店審査（2週間〜1カ月）が発生する。** 「誰でも今日から使える」のは Phase 1 の手動モードだけ。自動チェックを使いたい幹事は全員、事業実態の証憑を出して審査を通す必要がある。**これが本案最大のプロダクトリスクであり、設計では解けない。**
5. **入金が月1回（PayPay直接契約）。飲み会当日の立替問題は解消しない。** 幹事画面で「支払済み」と「入金予定」を分けて出すが（P6）、それは説明であって解決ではない。
6. **Hobby プランの cron は1日1回・±59分・再試行なし。** Webhook が欠損した場合、最悪 24時間+59分の反映遅れが起きる。Vercel Pro への移行が必要になるが、MVP では先送りする。
7. **PayPay の Webhook に署名検証がない**（W7）。IP許可リスト＋必ず再照会で担保するが、**IP許可リストの仕様そのものが未確認**（§5-1 Q5）。回答次第では「Webhook を受け取らず cron 照会だけで運用する」縮退が必要になる。
8. **Supabase 東京リージョンの可用性と料金が未確認**（§5-5）。使えない場合、レイテンシが悪化するか DB を差し替える。
9. **LINE ログインに Supabase Auth を使わず自前JWT検証を採ったため、JWKS のキャッシュ・ローテーション・検証ロジックの保守責任を自分で負う。** 検証の実装ミスは認証バイパスに直結する。ユニットテストの固定ベクタで守るが、外部監査は受けない。
10. **2026年夏以降、LINE本体がトーク上の PayPay 送金と「グループ支払い」による割り勘を提供する。** 本アプリの中核体験がプラットフォーム本体機能になる。本案は差別化を台帳側（参加者ごとに異なる金額、21名以上、複数イベント横断、監査ログ）に置いているが、**この差別化が市場で通用するかは検証していない**。加えて `幹事Pay`（株式会社Canvi、β版 2026-05-25）が同一コンセプトで先行している。
11. **国外の参加者・幹事に対応しない**（L12）。`currency` を JPY に固定している。
12. **Phase 1 の未認証リリースについて、LINEヤフーの事前回答を待たずに出す選択肢を残している。** 規約上ブロックされないという読みに基づくが、リリース後に是正を求められるリスクを負う。
13. **Phase 0 の照会が全部 no だった場合の出口が、Phase 1 の手動モードしかない。** 候補E（銀行明細）は MVP-first と両立せず、本案は退避先として設計に組み込んでいない（`BankReconciler` を置ける層だけ残している）。

---

## 12. 最初の1手

**PayPay 加盟店窓口へ §5-1 の質問1〜3 を出す。** 回答1本で第一候補の go/no-go が決まり、これが決まらないと Phase 2 の着手可否が判定できない。同時に弁護士へ §5-4 の質問1〜4 を出す（特に内閣府令1条の2第3号ニ）。

**そのうえで、回答を待たずに Phase 1 に着手する。** Phase 1 の成果物は決済事業者が変わっても捨てずに済み、かつ幹事が最短で触れる唯一のものだから。
