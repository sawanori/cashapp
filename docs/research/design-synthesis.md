# 最終設計ブリーフ — 幹事向け会費集金アプリ（LINEミニアプリ）

作成日: 2026-09-24 / 作成: 設計統合者
入力: `handover.md`（引継ぎ書）, `local-context.md`, `research/consolidated.md`, `design/arch-A.md` / `arch-B.md` / `arch-C.md`, `design/team-T1.md` / `team-T2.md`, 審査員3名の講評と移植指示
骨格: **アーキ = arch-C（台帳が製品・決済事業者はプラグイン）／ チーム = team-T2（品質ゲート駆動）**
本書は `docs/implementation-plan.md`（15節）・`docs/task-list.json`・`docs/acceptance-checks.json` の素材である。

---

## 0. 本書の読み方と、根拠の格付け

### 0-1. 検証ラベル（全文書で必須。T1 §0-1 を全社規約として採用）

| ラベル | 意味 |
|---|---|
| **[実測]** | 本プロジェクトの誰かが実際にコマンドを実行して確認した |
| **[文書]** | 既存ファイル・一次資料を読んで確認した |
| **[設計]** | 本書の提案。未実装・未検証 |
| **[不明]** | 確認できていない。着手前に確認が必要 |

ADR・HANDOFF・レビュー出力・run-log・task-list.json の各主張にこのラベルを必須フィールドとして持たせる。**[設計] または [不明] に依存した決定は ADR の `status` を `proposed` 止まりにし、`accepted` にしない。**

### 0-2. 本書自身の正直な申告

- **決済事業者への照会は1件も行っていない。** PayPay・PAY.JP・PayPal・Stripe・LINEヤフー・弁護士のいずれからも回答を得ていない。本書の「第一候補」は照会の順序であって採用の確定ではない。
- **本書の起案者は一次資料を1件も再取得していない。** 引用はすべて `consolidated.md` からの転記であり、`consolidated.md` 自身も「統合者は再フェッチしていない」と申告している。URL の再確認は Phase 0 の最初の作業に含める。
- **`consolidated.md` は decision_critical 82件のうち18件のみ3レンズ反証検証を通し、64件を未検証のまま除外したと申告している。** PayPay 加盟店資格・手数料3.8%・月末入金・Stripe Connect×PayPay の記載差・資金移動業登録の株式会社要件などが確信度「低」のまま残る。
- **リポジトリ `/Users/noritakasawada/AI_P/cashapp` は空（コミット0・ファイル0・docs 無し）** [実測: local-context.md]。本書に出る npm スクリプト・スクリプトファイル・エージェント定義はすべて **これから作るもの**であり、現時点で実在するコマンドは1本もない。

### 0-3. 本書が最優先で守る禁止事項（引継ぎ書 §4-1 / §9 / consolidated.md §7-3）

1. 自己申告やスクリーンショットを「検証済み入金」として扱わない。
2. **手動確認版を作って「自動チェック要件を満たした」と説明しない。** 本書は §5-4 と §9-4 でこれを CI 必須チェックとして機械強制する。
3. 名称だけを「参加費」に変えて、実態が個人間の立替精算のまま決済事業者を通さない。
4. 「Connect を使えば運営者は資金を預からないから資金移動関連の法的検討は不要」と結論づけない。

---

## 1. 確定した設計判断

以下は**着手してよい決定**である。ただし §1-1 の「ユーザー同意事項」と §10 の「照会待ち」が未解決の間は、Phase 2（本番決済）へ進まない。

### 1-1. 資金フロー（確定・ただしユーザーの明示同意が前提）

```
参加者 ──支払──▶ 決済事業者（幹事名義の加盟店アカウント）──入金──▶ 幹事の銀行口座
                      │
                      └─Webhook / 照会API─▶ 本アプリ（台帳に記録するだけ。資金には触れない）
```

- **L1: 運営者（NonTurn LLC）の口座・決済アカウントを資金が一切経由しない。**
- **L2: 前払い専用。** 立替精算モード（幹事が立て替えてから回収）を実装しない。
- **L3: アプリ内残高・チャージ・ポイント・ウォレットを作らない。**
- **L4: 返金原資を運営者が保持しない。** 返金は決済事業者の返金機能を通す。
- **L9: PayFac 型（運営者が幹事をサブ加盟店として審査・契約する）を採らない。**

**★ ユーザー同意が必要な変更点（Phase 0 のゲート G0-USER）**

引継ぎ書の当初希望「受取先＝幹事の個人PayPay」は**維持できない**。`consolidated.md` §7-1 のとおり「参加者ごとの自動検知」「受取先が個人PayPay」「幹事が非事業者のまま」の3条件は同時に満たせない。本設計は**条件3（幹事が非事業者のまま）を落とす**。幹事は決済事業者の加盟店審査（PayPay オンラインで2週間〜1カ月＋利用開始5営業日、事業実態の証憑。確信度 低・未検証）を通る必要がある。

- 同意が得られた場合 → 本書のフル構成へ進む。
- **同意が得られない場合の出口（arch-A から移植）** → `manual_confirm` アダプタ単独構成（＝名簿＋PayPay個人間送金導線＋幹事の手動確認）で運用を継続する。この構成は Phase 1 の成果物でそのまま動く。**ただしこれを「自動チェック要件を満たした」と説明してはならない**（§11-1）。

### 1-2. 決済事業者の候補順序（確定＝照会の順序。採用の確定ではない）

| 順位 | 事業者 | `provider_key` | 採る理由 | 落ちる条件 |
|---|---|---|---|---|
| 第一 | PayPay オンライン加盟店 | `paypay_online` | 受取先が当初希望に最も近い。`GET /v2/codes/payments/{merchantPaymentId}` と Webhook が公式ドキュメントに実在 [文書]。`merchantPaymentId` は64文字・`[a-zA-Z0-9_-]` なので請求IDを埋め込める [文書]。**Sandbox（`env:"STAGING"`）が加盟店審査前から使える**ので照会待ち中に実装検証できる（確信度 中） | 「商取引ではない寄付や募金、投げ銭」に**会費徴収が当たる**と回答された場合（§10 Q-PP1）。**照会1本で決まる** |
| 第二 | PAY.JP | `payjp` | 必要書類が最軽量（開業届が無くても確定申告書控え・個人事業税納付証明書で代替可、確信度 中）。`X-Payjp-Webhook-Token` による検証手段が明示されている [文書] ので PayPay の署名検証欠如（W7）を補完できる。カード決済なので PayPay と手段が重ならず、同一イベントで2アダプタ並列運用の価値がある | 加盟店規約本文（未取得）で個人間送金・立替精算が除外されていた場合 |
| 第三 | PayPal（connpass 型） | `paypal` | 「運営者が資金を持たず主催者アカウントへ即時入金」の実運用前例。`capabilities.payerIdentity` が true になる可能性が唯一ある | ビジネスアカウント要否と API 資格が未確認（一次資料の取得に失敗） |
| 保留 | Stripe | — | 規約が三重（SSA 1.2(a)(i) の personal/family/household 包括禁止／禁止業種「ピアツーピアの送金」／日本固有「Stripe Connect 外での C2C サービス」）。かつ「日本では Connect 必須」と「PayPay は Connect 非対応」が同時に成り立つ可能性がある。**照会が最も重く回答が最も遅い見込み。技術資料が充実していることは採用理由にならない** | — |
| Phase 3 | 楽天銀行＋電子決済等代行業（候補E） | `bank_rakuten` | **「幹事が非事業者のまま自動検知できる」唯一の実在経路。** 本設計は `ingestion_source='bank'` / `confidence='bank_matched'` で**スキーマ変更なしに後から載せられる**（§2-2 の設計上の性質3） | 電代業登録または登録済み事業者との提携のリードタイムが読めない |
| 不採用 | 収納代行（候補F） | — | L1 違反 | — |

**Stripe CLI がローカルに存在する [実測] ことを理由に Stripe を繰り上げない。** 重複・逆順・署名不一致の再現は自作 ProviderConformanceKit（§9-2）で事業者非依存に行う。

### 1-3. 技術スタック（確定）

| 層 | 採用 | 根拠 | 不採用 |
|---|---|---|---|
| パッケージマネージャ | **npm 10.9.4** | pnpm は corepack シム破損で起動不可 [実測]。**pnpm 復旧を初期タスクの前提条件にしない**。フックで `pnpm` コマンド自体を遮断する（§8-4） | pnpm / yarn |
| フレームワーク | **Next.js 15 App Router / TypeScript** | Route Handler の `await request.text()` が生本文を返し、署名検証要件（W6/P2）を追加設定なしで満たす [文書] | SvelteKit / Remix |
| ホスティング | **Vercel（`vercel.json` に `"regions": ["hnd1"]` を最初から明記）／Pro プラン** | 既定 `iad1` だと日本レイテンシと Supabase Tokyo 往復が悪化（I1）。**Hobby は cron が1日1回・±59分（I2）で照合遅延が許容できないため Pro が必須**。$20/月を費用に計上 | Cloudflare Workers（wrangler 未インストール [実測]、Free の HTTP CPU 10ms に照合ジョブが収まらない） |
| DB | **Supabase Postgres（Tokyo / ap-northeast-1）** | supabase CLI 2.58.5 [実測] でローカル Postgres を統合テストに流用できる。台帳の整合性を DB 制約（生成列・部分一意インデックス・CHECK・`FOR UPDATE`・advisory lock）で担保する方針に Postgres が必須 | PlanetScale / Turso |
| ORM | **Drizzle ORM** | マイグレーションが生 SQL として読める。`insert ... on conflict do nothing returning` / `select ... for update` / 生成列をそのまま書ける | Prisma（冪等性が ORM の抽象に隠れる） |
| 認証 | **LINE IDトークンをサーバー検証 → 自前セッション JWT（HS256）を HttpOnly / Secure / SameSite=Lax Cookie で発行**。状態変更系に CSRF ダブルサブミットトークン | §1-5 | Supabase Auth Custom OIDC（`signInWithOAuth` のリダイレクト往復が LIFF 内で体験を壊す。LINE で成立する公式事例が無い＝未確認依存を認証の中心に置かない） |
| DBアクセス | **全アクセスをサーバー側 Route Handler 経由（I3）。加えて全テーブルで `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` をポリシー無し（deny-all）で有効化し、service role のみが通る構成にする** | I3 を満たしつつ、anon/authenticated キーが万一漏れても素通しにならない多層防御。**ポリシーを書くコストはゼロで、審査員が3案共通の欠陥として挙げた「RLS 不在」に答える** | RLS + anon key 直アクセス（自前JWTを Supabase signing key で発行する追加工程が要り MVP の攻撃面を増やす） |
| 決済SDK | **アダプタ内に閉じる**。PayPay は公式 Node SDK、PAY.JP は公式 Node ライブラリ。SDK が塞ぐエンドポイントは `fetch` 直叩き＋自前型で実装してよい | SDK の型・例外をアダプタ境界の外に出さない（P1）。PayPay 公式 SDK は README 記載13メソッドに対し実装27メソッド [文書] で、README を仕様書として扱えない | 各 SDK をアプリ全体で直接使う |
| テスト | Vitest / supabase CLI のローカル Postgres / Playwright + `@line/liff-mock` / 自作 ProviderConformanceKit | §9 | Jest / Testcontainers |
| CI | GitHub Actions（gh CLI 認証済み [実測]） | §8-6 | — |

### 1-4. LINEミニアプリ統合方式（確定）

**チャネル構成（Phase 1 着手時に一度で確定し、後から変えない）**

```
プロバイダー: NonTurn LLC（1つ。userId はプロバイダー単位で共通なので分割不可・後から移動不可 N1）
 ├─ LINEミニアプリチャネル（内部に 開発用 / 審査用 / 本番用 の3チャネル、各々 別 LIFF ID・別エンドポイントURL）
 └─ Messaging API チャネル（Phase 3 の催促用。同一プロバイダー配下に必須）
```

- Scope は `profile` + `openid` のみ。内部チャネル間で変更できない（N6）ので Phase 1 で一度で決める。
- `LIFF_ID_DEV` / `LIFF_ID_REVIEW` / `LIFF_ID_PROD` の3系統を環境変数で切り替える。
- **Phase 1・Phase 2 は未認証ミニアプリで本番リリースする。** 決済（その他の決済方法＝外部決済）・友だち追加誘導・カスタムアクションボタンは未認証で可 [文書]。認証審査（1〜2週間、確信度 低）を Phase 1 のクリティカルパスから外す。認証が要るのはサービスメッセージ・LINE内検索/ホームタブ・Custom Path・ホーム画面ショートカット・ヘッダーのアプリ名表示で、これらは Phase 3 の入口に置く。
- **催促はサービスメッセージで送れない前提**（N10）。Phase 1〜2 の催促は「幹事が未払い者一覧を `shareTargetPicker` で手動シェア」。
- **名簿・請求・台帳はミニアプリのエンドポイントドメイン内で完結**させ、外部ドメインへ出るのは決済画面だけ（N4）。決済完了後の `returnUrl` はミニアプリのパーマネントリンクに固定（P4）。`createCheckout` の `returnUrl` は型上も必須（§5-1）。
- SPA ルーティングは History API ベース。エンドポイントURLは https のみ・フラグメント不可（N5）。
- **サービス定義を「幹事が管理する精算・集金の台帳」に統一**（N11）。「支援」「応援」「投げ銭」「カンパ」「寄付」「募金」「クラウドファンディング」を用語辞書レベルで禁止し、`docs/wording-policy.md` に置いて **CI の禁止語 grep（`npm run gate:wording`）で機械的に落とす**（arch-A から移植）。

### 1-5. 認証・セッション（確定・arch-B から移植）

```
ブラウザ（LIFF）                          サーバー（Next.js Route Handler）
 liff.init({ liffId })
 liff.isLoggedIn() ? : liff.login()
 const idToken = liff.getIDToken()
        │  POST /api/auth/line  { idToken }
        ├──────────────────────────────▶ ① POST https://api.line.me/oauth2/v2.1/verify
        │                                    { id_token, client_id: LINE_LOGIN_CHANNEL_ID }   ← N3
        │                                 ② sub / aud / exp / nonce を検証
        │                                 ③ line_user_ref = HMAC-SHA256(sub, PEPPER) に変換（生の sub は保存しない）
        │                                 ④ app_user を upsert
        │                                 ⑤ セッションJWT（HS256/30分スライディング）を
        │                                    HttpOnly / Secure / SameSite=Lax / Path=/ Cookie で発行
        │                                 ⑥ CSRF トークンを別 Cookie（非HttpOnly）＋レスポンスで返す
        ◀──────────────────────────────┘
 以後の API 呼び出しは Cookie のみ。状態変更系は X-CSRF-Token ヘッダ必須。期限切れ時に再取得
```

- **`SameSite=None` ではなく `SameSite=Lax` を使う。** 決済事業者からの復帰は**トップレベル GET ナビゲーション**なので Lax で通る（arch-B の根拠）。None は CSRF 面を不要に広げる。
- `liff.getDecodedIDToken()` / `liff.getProfile()` の結果をサーバーへ送らない（N2）。フロントから送られたユーザーIDを信用して支払済みフラグを立てない。
- 検証経路は公式に3つある（verify エンドポイント／自前 JWT 署名検証 ES256+JWKS／アクセストークン経路）[文書]。**MVP は verify エンドポイント一択**にして実装を1本に絞る。
- 支払状態・認証状態を localStorage に持たせない（N7）。画面表示のたびにサーバーの台帳を取りに行く。
- 参加者の表示名は IDトークンから取れる前提で作らない（N12）。**幹事が入力した名前を正**とする。

### 1-6. 最小PII（確定・arch-B から移植）

| 項目 | 扱い |
|---|---|
| LINE userId | **生値を保存しない。** `line_user_ref = HMAC-SHA256(sub, PEPPER)`（bytea）のみ。PEPPER は環境変数（Phase 3 で KMS）。Messaging API が必要になる Phase 3 で初めて、別途の同意を取ったうえで生値の保存を追加する |
| 表示名 | LINE プロフィール名を保存しない。幹事が入力した `participant.display_label` を正とする。イベント単位のスコープで他イベントへ持ち越さない |
| プロフィール画像 / メール / 電話 / 住所 | **収集しない。フォーム自体を作らない** |
| 決済事業者へ渡す情報 | 金額・通貨・`external_ref`・`returnUrl` のみ。氏名・LINE ID・メールは渡さない |
| Webhook 生本文 | `webhook_delivery.raw_body` に保存、**保持14日**。以後は本文を落とし `body_sha256` とパース済みの必要フィールドのみ残す |
| 監査ログ | ID・enum・金額・タイムスタンプのみ。**自由入力文字列を入れない**（CHECK で検査）。IPは `source_ip_hash`（HMAC）で保存し生IPを残さない |
| 保持期間 | **イベント終了日+90日で `participant.display_label` を NULL 化（擬似匿名化）**。請求・支払・監査は金額とIDのみで7年保持（会計証憑。**期間は要弁護士確認**） |

### 1-7. 資格情報のカストディ（確定＋未決の法務論点あり）

**決定:** `provider_binding.credential_ref` は**外部シークレットストアのキー名のみ**を保持し、値を DB に入れない。運用規律は arch-B から移植する。

1. 復号・参照は**決済API呼び出し直前のメモリ内のみ**。ログ出力禁止。**例外メッセージにも出さない**（例外を握り潰して独自メッセージに詰め替える）。
2. 追跡は `credential_fp`（sha256 の先頭16hex）のみをログに出す。
3. CI に「ログ出力を grep して資格情報・生の userId・生IP が出ていないことを確認する」テストを必須で入れる。
4. 適切な外部シークレットストアが確保できない場合のフォールバックは、B の封筒暗号化（AES-256-GCM、DEK は `provider_binding` ごと、KEK は環境変数→Phase 3 で KMS）。**どちらを採っても §10 の `GATE-CRED-CUSTODY` が Phase 2 をブロックする。**

**★未決の法務論点（隠さず ADR に立てる）:** PayPay には Stripe Connect OAuth / PayPal Partner Referrals に相当する「接続」機構が公開ドキュメント上に存在しない。したがって運営者が**幹事の加盟店 API キー／シークレットを預かる**ことになる。これは「運営者は資金に触れないが、幹事の決済アカウントを操作しうる鍵は持つ」状態であり、**これが『資金の受入れへの関与』と評価されるかは `consolidated.md` §5-4 Q7 が未解決**。加えて決済事業者の加盟店規約が通常禁じる「認証情報の第三者開示・預託」に抵触する公算がある。**この項目は現在の照会リストに入っていないので、§10 に新規追加した。**

---

## 2. データモデル

設計方針: **`invoice.settlement_status` は誰も直接 UPDATE しない。** 支払いの事実は `payment_event`（外部由来・冪等）と `ledger_entry`（追記専用）にだけ書き、`invoice` の状態はその射影として単調に前進する。決済事業者を差し替えても、照合経路を増やしても、台帳の真実は1箇所にとどまる。

### 2-1. 状態モデル（審査員が指摘した3案共通のランク欠陥を解消した形）

**2軸に分ける。** 1軸にすると arch-A（void→paid が通る）・arch-B（決済画面を開くと永久にキャンセルできない）・arch-C（void した請求が refunded に進めない）の欠陥が必ずどれか出る。

**軸1: `settlement_status` / `settlement_rank`（単調前進のみ。生成列）**

```
rank  settlement_status  意味
  0   unpaid             未払い
 10   authorized         与信のみ（PayPay の AUTHORIZED）
 40   paid               支払い成立（★ 幹事画面の「支払済み」はここだけ）
 60   refund_pending     返金処理中
 70   refunded           返金完了
 80   charged_back       チャージバック / 紛争
```

**軸2: `lifecycle_state`（`active` | `void`）と `settled_at`**

- `void` = 幹事が請求を取り消した。**`settlement_rank < 40` かつ `lifecycle_state='active'` のときだけ遷移可。Webhook からは絶対に触らない。**
- `settled_at` = 幹事口座への入金確認（P6）。**ランクの梯子に入れない**。入金確認と返金は直交する事象なので、同一軸に置くと「入金確認済みの請求を返金できない」が起きる。

**不変条件（DB とコードの両方で守る）**

- `UPDATE invoice ... WHERE settlement_rank < $newRank` — **前進のみ。例外規則を作らない（一本で済む）**（W3）。
- `settlement_rank` は `GENERATED ALWAYS AS (...) STORED` で `settlement_status` から導く。**status と rank の乖離を構造的に不可能にする**（arch-A から移植）。AI エージェントが片方だけ更新する事故が消える。
- **`awaiting_payment` / `pending` を `invoice` の列に持たない。**「支払待ち」は「生きている `payment_attempt` が存在するか」から導出する（arch-A から移植）。列に持つと決済失敗時に後退が必要になり、単調性が壊れる。
- `canceled` / `expired` / `failed` は `payment_attempt` にだけ記録し、`invoice` の状態を動かさない。
- `occurred_at`（事業者側の時刻）を順序判定に使わない（W4）。
- **取消済み請求への遅延入金**（`lifecycle_state='void'` に `succeeded` が届く）: `settlement_rank` は正しく `paid` へ前進させ、`lifecycle_state='void'` は維持し、`needs_attention=true` を立てて `outbox` に `paid_after_void` アラートを積む。**握り潰さない（A の欠陥）し、返金経路も塞がない（C の欠陥）。** 幹事画面に「取り消した請求に入金があります。返金が必要です」を出す。

### 2-2. テーブル定義

```sql
-- ============ 主体 ============
CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_user_ref  bytea NOT NULL UNIQUE,              -- HMAC-SHA256(sub, PEPPER)。生の sub は保存しない
  status         text  NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  tos_accepted_at     timestamptz,
  privacy_consent_at  timestamptz,                   -- L6: 支払状況の幹事開示への同意
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- organizer テーブルは作らない。幹事と参加者は同じ LINE ユーザーで、ロールはイベントごとに変わる
-- （あるイベントの幹事が別イベントの参加者になる）。分けると同一人物が2行に割れる。

-- 幹事の決済事業者アカウント紐付け。資格情報の「値」は保持しない（§1-7）
CREATE TABLE provider_binding (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  provider_key      text NOT NULL,                   -- 'paypay_online' | 'payjp' | 'manual_confirm' | ...
  credential_ref    text,                            -- 外部シークレットストアのキー名。値は入れない
  credential_fp     text,                            -- sha256 先頭16hex。ログ追跡用
  capabilities      jsonb NOT NULL,                  -- アダプタ宣言のスナップショット
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','active','suspended','revoked')),
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organizer_user_id, provider_key)
);

-- ============ イベント・名簿 ============
CREATE TABLE event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_user_id  uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  event_at           timestamptz,
  currency           char(3) NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),  -- L12 国内限定
  default_amount_minor integer CHECK (default_amount_minor > 0),
  collect_by         date,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','collecting','closed','canceled')),
  join_token_hash    bytea NOT NULL UNIQUE,          -- 招待トークンは生で保存しない（定数時間比較）
  provider_key       text NOT NULL DEFAULT 'manual_confirm',  -- イベント単位で事業者を持つ
  provider_binding_id uuid REFERENCES provider_binding(id),
  retention_due_at   timestamptz,                    -- 擬似匿名化の期日（終了+90日）
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_organizer_idx  ON event (organizer_user_id, status, created_at DESC);
CREATE INDEX event_retention_idx  ON event (retention_due_at) WHERE retention_due_at IS NOT NULL;
-- provider_key をイベント単位に持つのが要点（arch-A から移植）。加盟店契約が済んでいない幹事の
-- イベントは manual_confirm のまま動き、同一アプリ内で自動経路と手動経路が並存する。

CREATE TABLE participant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  display_label   text,                              -- 幹事が入力。終了+90日で NULL 化
  line_user_ref   bytea,                             -- self-claim で束縛。未claimなら NULL
  claim_status    text NOT NULL DEFAULT 'unclaimed'
                  CHECK (claim_status IN ('unclaimed','claimed','confirmed')),
  claimed_at      timestamptz,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- 1イベント内で1人の LINE ユーザーは1行しか claim できない（二重claimを構造で防ぐ）
CREATE UNIQUE INDEX participant_claim_uk ON participant (event_id, line_user_ref)
  WHERE line_user_ref IS NOT NULL;
CREATE INDEX participant_event_idx ON participant (event_id, claim_status);

-- ============ 請求（中心エンティティ） ============
CREATE TABLE invoice (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  participant_id    uuid NOT NULL REFERENCES participant(id) ON DELETE CASCADE,
  amount_minor      integer NOT NULL CHECK (amount_minor > 0),
  currency          char(3) NOT NULL DEFAULT 'JPY',

  settlement_status text NOT NULL DEFAULT 'unpaid' CHECK (settlement_status IN
                    ('unpaid','authorized','paid','refund_pending','refunded','charged_back')),
  -- ★ 生成列。status と rank の乖離を構造的に不可能にする
  settlement_rank   smallint GENERATED ALWAYS AS (
                      CASE settlement_status
                        WHEN 'unpaid'         THEN 0
                        WHEN 'authorized'     THEN 10
                        WHEN 'paid'           THEN 40
                        WHEN 'refund_pending' THEN 60
                        WHEN 'refunded'       THEN 70
                        WHEN 'charged_back'   THEN 80
                      END) STORED,
  -- ★ 取消は独立軸。単調ランクと衝突させない
  lifecycle_state   text NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active','void')),
  voided_at         timestamptz,
  needs_attention   boolean NOT NULL DEFAULT false,  -- 二重払い / 取消後入金 / 金額不一致

  -- ★ 非自動ラベルの根拠。false = 自動検知ではない
  auto_detected     boolean NOT NULL DEFAULT false,
  confirmation_method text NOT NULL DEFAULT 'manual_by_organizer'
                      CHECK (confirmation_method IN ('automatic','manual_by_organizer')),

  paid_at           timestamptz,
  settled_at        timestamptz,                     -- 幹事口座への入金確認（P6。ランクに入れない）
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, participant_id)
);
CREATE INDEX invoice_event_idx   ON invoice (event_id, settlement_status);
-- 照合は「時刻カーソル」ではなく「状態」で走査する（W9）
CREATE INDEX invoice_recon_idx   ON invoice (settlement_status, updated_at)
  WHERE settlement_rank < 40 AND lifecycle_state = 'active';
CREATE INDEX invoice_attention_idx ON invoice (event_id) WHERE needs_attention;

-- ============ 決済試行 ============
CREATE TABLE payment_attempt (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          uuid NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  provider_key        text NOT NULL,
  provider_binding_id uuid REFERENCES provider_binding(id),
  external_ref        text NOT NULL,                 -- merchantPaymentId 等。invoice_id を埋め込む
  provider_payment_id text,                          -- 事業者採番ID（返ってきたら格納）
  amount_minor        integer NOT NULL CHECK (amount_minor > 0),
  currency            char(3) NOT NULL,
  status              text NOT NULL DEFAULT 'created' CHECK (status IN
                      ('created','redirected','authorized','succeeded','failed','canceled','expired','refunded')),
  is_open             boolean GENERATED ALWAYS AS (
                        status IN ('created','redirected','authorized')) STORED,
  checkout_url        text,
  expires_at          timestamptz,
  -- ★ 代理払いの「入力シグナル」。自動検知ではない（§5-3 の注意書きを必ず併読）
  opened_by_user_ref  bytea,                         -- このチェックアウトを開いた LINE ユーザー
  last_snapshot       jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_key, external_ref)
);
CREATE INDEX attempt_invoice_idx ON payment_attempt (invoice_id, created_at DESC);
CREATE INDEX attempt_open_idx    ON payment_attempt (expires_at) WHERE is_open;
-- external_ref の生成規則: 'iv_' || replace(invoice_id::text,'-','') || '_' || attempt_seq
-- 64文字・[A-Za-z0-9_-] に収める。事業者が支払者を返さなくても（P9）どの請求への支払いかは一意に決まる。

-- ============ 外部由来イベント（冪等の入口） ============
CREATE TABLE payment_event (
  id                bigserial PRIMARY KEY,
  provider_key      text NOT NULL,
  -- W1: 事業者のイベントID。持たない事業者は 'sha256:'||sha256(raw_body) を入れる（NULL にしない）
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,                   -- 事業者側の生の種別名
  kind              text NOT NULL CHECK (kind IN
                    ('authorized','succeeded','failed','canceled','expired','refunded','unknown')),
  external_ref      text NOT NULL,
  -- W2: 業務レベルの観測キー。★ UNIQUE にしない（理由は下のコメント）
  business_idem_key text NOT NULL,
  invoice_id        uuid REFERENCES invoice(id),
  attempt_id        uuid REFERENCES payment_attempt(id),
  amount_minor      integer,
  currency          char(3),
  occurred_at       timestamptz,                     -- 順序判定には使わない（W4）
  received_at       timestamptz NOT NULL DEFAULT now(),
  ingestion_source  text NOT NULL CHECK (ingestion_source IN ('webhook','poll','manual','bank')),
  trust             text NOT NULL CHECK (trust IN ('verified','reverified','unverified','attested')),
  apply_result      text CHECK (apply_result IN
                    ('applied','duplicate','ignored','mismatch','orphan','signature_failed','error')),
  processed_at      timestamptz,
  raw               jsonb NOT NULL,
  CONSTRAINT payment_event_w1_uk UNIQUE (provider_key, provider_event_id)   -- W1（ハード制約）
);
CREATE INDEX payment_event_business_idx
  ON payment_event (provider_key, external_ref, kind, apply_result);
CREATE INDEX payment_event_invoice_idx ON payment_event (invoice_id, received_at);
CREATE INDEX payment_event_unprocessed_idx ON payment_event (received_at) WHERE processed_at IS NULL;
```

> **★ `business_idem_key` を UNIQUE にしない理由（審査員3名中2名が致命的欠陥として指摘した箇所）**
> arch-C は `UNIQUE(provider_key, business_idem_key)` かつ `businessIdemKey = ${charge.id}:${event.type}` としており、同時に PAY.JP の `capabilities.refund` を `'partial'` と宣言していた。**同一 charge への2回目の部分返金は同じキーを生むため、正当なイベントが DB 制約で黙って落ち、返金が台帳に載らない。** arch-B の `UNIQUE(provider, object_id, event_type, observed_status)` も同じ罠を踏んでいる。
> 本設計は代わりに **(a) W1 の `(provider_key, provider_event_id)` をハード制約にし、イベントIDを持たない事業者には `sha256(raw_body)` を入れてバイト同一の再送を確実に弾く**、**(b) 二重計上の防止は `ledger_entry.dedupe_key` の一意制約で行う（下記）**、**(c) `invoice` の更新を代入的冪等（`SET settlement_status='paid' WHERE settlement_rank < 40`）にする** の3段で達成する。`business_idem_key` は観測・デバッグ用の非一意インデックスとしてのみ残す。
> `consolidated.md` §3-13 が「導けるのは冪等な処理と後退しない更新規律という性質要件まで」と限定していることに、この形が最も正確に整合する。

```sql
-- ============ 台帳（追記専用。UPDATE/DELETE を権限で禁止） ============
CREATE TABLE ledger_entry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES invoice(id),
  event_id          uuid NOT NULL REFERENCES event(id),
  direction         text NOT NULL CHECK (direction IN ('credit','debit')),
  kind              text NOT NULL CHECK (kind IN
                    ('payment','refund','overpay','proxy_payment','adjustment','writeoff')),
  amount_minor      integer NOT NULL CHECK (amount_minor > 0),
  currency          char(3) NOT NULL,
  -- 信頼度。候補E（銀行明細）を後から足すときもこの列でそのまま表現できる
  confidence        text NOT NULL CHECK (confidence IN
                    ('provider_verified','provider_polled','bank_matched','organizer_attested')),
  -- ★ 二重計上の唯一の防波堤。payment は 'pay:<external_ref>'、
  --   refund は 'refund:<provider_refund_id>'（無い事業者は 'refund:<external_ref>:<amount>:<occurred_at>'）
  dedupe_key        text NOT NULL,
  source_payment_event_id bigint REFERENCES payment_event(id),
  recorded_by       text NOT NULL,                   -- 'system' | 'organizer:<uuid>'
  memo              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_dedupe_uk  ON ledger_entry (invoice_id, dedupe_key);
CREATE INDEX ledger_invoice_idx       ON ledger_entry (invoice_id, created_at);
CREATE INDEX ledger_event_idx         ON ledger_entry (event_id, created_at);
REVOKE UPDATE, DELETE ON ledger_entry FROM app_rw;   -- 権限で追記専用にする
CREATE RULE ledger_no_update AS ON UPDATE TO ledger_entry DO INSTEAD NOTHING;
CREATE RULE ledger_no_delete AS ON DELETE TO ledger_entry DO INSTEAD NOTHING;

-- ============ 手動確認（自動ではない経路の証跡） ============
CREATE TABLE manual_attestation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES invoice(id),
  organizer_user_id uuid NOT NULL REFERENCES app_user(id),
  method            text NOT NULL CHECK (method IN ('paypay_p2p','cash','bank_transfer','other')),
  reason            text NOT NULL,                   -- 必須。空文字を禁止（CHECK）
  evidence_note     text,                            -- 自由記述のみ。画像は保存しない（§11-5）
  attested_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(reason)) > 0)
);

-- ============ 監査ログ（append-only + ハッシュ連鎖） ============
CREATE TABLE audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_type     text NOT NULL CHECK (actor_type IN
                 ('organizer','participant','system','webhook','admin')),
  actor_ref      bytea,                              -- line_user_ref か admin_id。生の userId は入れない
  action         text NOT NULL,
  target_type    text NOT NULL,
  target_id      text NOT NULL,
  before_rank    smallint,
  after_rank     smallint,
  amount_minor   integer,
  provider_key   text,
  external_ref   text,
  request_id     text NOT NULL,
  source_ip_hash bytea,                              -- HMAC。生IPは保存しない
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb, -- 自由入力文字列を入れない（CHECK で検査）
  prev_hash      bytea,
  row_hash       bytea NOT NULL
);
CREATE INDEX audit_target_idx ON audit_log (target_type, target_id, occurred_at DESC);
CREATE INDEX audit_action_idx ON audit_log (action, occurred_at DESC);
CREATE RULE audit_no_update AS ON UPDATE TO audit_log DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_log DO INSTEAD NOTHING;

-- ============ ゲート・フラグ（実行時キルスイッチ。arch-B から移植） ============
CREATE TABLE compliance_gate (
  gate_key      text PRIMARY KEY,
  scope         text NOT NULL,                       -- provider:paypay_online | platform:line | legal | user
  required_for  text[] NOT NULL,                     -- ['phase1'] / ['phase2'] ...
  status        text NOT NULL DEFAULT 'unknown'
                CHECK (status IN ('unknown','inquired','passed','failed','n/a')),
  inquired_at   timestamptz,
  decided_at    timestamptz,
  decided_by    text,
  evidence_uri  text,                                -- 回答メール/書面の保管先
  confidence    text CHECK (confidence IN ('measured','documented','designed','unknown')),
  note          text
);

CREATE TABLE feature_flag (
  key           text PRIMARY KEY,                    -- PAYMENTS_ENABLED / PROVIDER_PAYPAY_ONLINE_MODE ...
  value         text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NOT NULL
);

-- ============ 非同期・突合・受信ログ ============
CREATE TABLE outbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,                       -- notify_organizer | mismatch_alert | paid_after_void | refund_task
  payload       jsonb NOT NULL,
  run_after     timestamptz NOT NULL DEFAULT now(),
  attempts      smallint NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  done_at       timestamptz,
  last_error    text
);
CREATE INDEX outbox_pending_idx ON outbox (run_after) WHERE done_at IS NULL;

CREATE TABLE webhook_delivery (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key  text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  sig_ok        boolean NOT NULL,
  http_status   smallint NOT NULL,
  body_sha256   text NOT NULL,
  raw_body      text,                                -- 14日で NULL 化（保持期間 cron）
  headers       jsonb,
  source_ip_hash bytea
);
CREATE INDEX webhook_delivery_retention_idx ON webhook_delivery (received_at) WHERE raw_body IS NOT NULL;

CREATE TABLE reconciliation_run (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  scanned       integer NOT NULL DEFAULT 0,
  advanced      integer NOT NULL DEFAULT 0,
  mismatches    integer NOT NULL DEFAULT 0,
  note          text
);

CREATE TABLE idempotency_key (
  key           text PRIMARY KEY,                    -- クライアント提供の Idempotency-Key
  user_ref      bytea NOT NULL,
  endpoint      text NOT NULL,
  request_hash  text NOT NULL,
  response_body jsonb,
  status_code   smallint,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

**全テーブル共通:** `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` をポリシー無し（deny-all）で適用し、service role のみ通す（§1-3）。

### 2-3. この設計が持つ拡張性の性質

1. `provider_key` は文字列で、テーブル構造に事業者名が焼き付いていない。事業者追加は `provider_binding` 行＋アダプタ実装だけで済み、マイグレーションを伴わない。
2. `payment_event.ingestion_source` と `ledger_entry.confidence` が分離している。Webhook 由来・照会由来・銀行明細由来・幹事の手動申告が、同じ台帳の上に**信頼度のラベル付きで**共存する。
3. 候補E（楽天銀行＋電代業）を後から足すとき、`ingestion_source='bank'` / `confidence='bank_matched'` を使うだけで**テーブル追加ゼロ**で載る。`consolidated.md` が唯一「非事業者のまま自動検知できる」とした経路を、投機的実装なしに残せる唯一の構造。
4. `invoice.auto_detected` / `confirmation_method` が持ち回られ、API・画面・CSV のすべてで露出する（§5-4）。

---

## 3. API / Webhook 一覧

### 3-1. エンドポイント

| メソッド | パス | 認可 | 冪等 | 入力 | 出力 | 主なエラー |
|---|---|---|---|---|---|---|
| POST | `/api/auth/line` | なし（IDトークン検証） | — | `{ idToken }` | セッション Cookie + CSRF トークン | 401 `ID_TOKEN_INVALID` |
| GET | `/api/me` | セッション | — | — | `{ userRef, events[], claimedInvoices[] }` | 401 |
| POST | `/api/events` | セッション | `Idempotency-Key` 必須 | `{ title, eventAt?, defaultAmountMinor, collectBy? }` | `{ event, joinToken }`（joinToken は**このレスポンスでのみ返す**） | 400 / 409 `IDEMPOTENCY_CONFLICT` |
| GET | `/api/events/:id` | **当該 organizer のみ**（SQL の WHERE に `organizer_user_id` を必ず含める） | — | — | 名簿＋台帳サマリ（自動確認 n / 手動確認 m の内訳を必ず含む） | 403 `FORBIDDEN` / 404 |
| PATCH | `/api/events/:id` | 当該 organizer | `Idempotency-Key` | `{ title?, collectBy?, status? }` | event | 403 / 409 |
| POST | `/api/events/:id/participants` | 当該 organizer | `Idempotency-Key` | `{ participants: [{displayLabel, amountMinor?}] }` 一括可 | participants[] | 400 / 403 |
| DELETE | `/api/events/:id/participants/:pid` | 当該 organizer | — | — | 204 | 409（請求が `settlement_rank >= 40` なら削除不可） |
| POST | `/api/events/:id/invoices` | 当該 organizer | `Idempotency-Key` | `{ items:[{participantId, amountMinor}] }` | invoices[] | 400 / 403 |
| POST | `/api/invoices/:id/void` | 当該 organizer | `Idempotency-Key` | `{ reason }` | invoice | **409 `VOID_NOT_ALLOWED`（`settlement_rank >= 40`）** |
| POST | `/api/invoices/:id/manual-attest` | 当該 organizer | `Idempotency-Key` | `{ method, reason(必須), evidenceNote? }` | invoice（`autoDetected:false` を必ず含む） | 400（reason 空）/ 403 |
| POST | `/api/invoices/:id/refund` | 当該 organizer | `Idempotency-Key` | `{ amountMinor? }` | refund ticket | **409 `NOT_SUPPORTED`** / 409 `GATE_NOT_PASSED` |
| GET | `/api/e/:joinToken` | **セッション必須**（トークン保持だけでは認可しない） | — | — | イベント概要＋**未claimの名簿候補（氏名のみ）**。他人の金額・支払状況は返さない | 401 / 404 |
| POST | `/api/e/:joinToken/claim` | セッション | `Idempotency-Key` | `{ participantId }` | claimed participant | 409 `ALREADY_CLAIMED` |
| GET | `/api/e/:joinToken/me` | セッション＋claim 済み | — | — | **自分の請求のみ**（金額・状態・支払導線） | 403 `NOT_CLAIMED` |
| POST | `/api/e/:joinToken/checkout` | セッション＋claim 済み | `Idempotency-Key` | **金額を取らない**（サーバーが invoice から読む） | `{ checkoutUrl }` または `{ manualInstruction }` | 409 `GATE_NOT_PASSED` / 409 `PROVIDER_NOT_ENABLED` |
| GET | `/api/e/:joinToken/status` | セッション＋claim 済み | — | — | 決済戻り先で**1回だけ** `getPaymentStatus` を叩いて確定（P3） | 403 |
| POST | `/api/webhooks/:providerKey` | 署名検証 or 再照会（**セッション不要・CSRF 除外**） | W1 の一意制約＋台帳 dedupe | 生本文 | 200 / 400 | 400 `SIGNATURE_INVALID` / 404 `UNKNOWN_PROVIDER` / 500（事業者にリトライさせる） |
| POST | `/api/cron/reconcile` | `CRON_SECRET` ヘッダ | advisory lock | — | 統計 | 401 |
| POST | `/api/cron/outbox` | `CRON_SECRET` | advisory lock | — | 統計 | 401 |
| POST | `/api/cron/retention` | `CRON_SECRET` | advisory lock | — | 擬似匿名化・生本文削除の件数 | 401 |
| GET | `/api/events/:id/export.csv` | 当該 organizer | — | — | **`auto_detected` / `confirmation_method` 列を必ず含む** | 403 |
| GET/POST | `/api/admin/gates` | 管理者（別セッション・IP 制限） | — | gate 更新 | compliance_gate | 403。全操作を audit_log へ |
| GET | `/api/health` | なし | — | — | `{ ok: true }` | — |

### 3-2. 認可の原則

- **所有者判定をリクエストボディから取らない。** セッションの `line_user_ref` → `app_user.id` を引き、`event.organizer_user_id` との一致を **SQL の WHERE 句に必ず含める**。アプリ層の `if` だけに頼らない。
- リポジトリ関数のシグネチャに `organizerUserId` を**必須引数**として入れ、忘れた瞬間に型エラーになるようにする。
- **参加者は自分の請求しか読めず、金額と状態を一切書けない。** `/checkout` はボディに金額を取らない。
- `joinToken` は DB にハッシュのみ保存し、照合は定数時間比較。**「トークン保持＝認可」にしない**（LINEセッションと claim 済み participant の一致を結合条件に入れる）。これが **arch-C が抱えていた IDOR（グループトークに配ったリンクを別人が開いて他人の請求を払う／覗く）の解消**である。
- 参加者一覧を幹事に見せる行為は個人情報保護法27条1項の第三者提供に当たりうる（L6）。**初回のイベント参加導線に同意取得画面を入れ、同意した事実を `audit_log` に残す**。法的構成（委託か共同利用か）は §10 の弁護士照会事項。

### 3-3. Webhook 処理手順

```
POST /api/webhooks/:providerKey
 1. const raw = await request.text()              // 生本文。JSON.parse しない（P2/W6）
 2. webhook_delivery に受信を記録（body_sha256, headers, source_ip_hash）
 3. adapter = await resolveProvider(providerKey)  // §5-2 のゲート。未通過なら 404 を返す
 4. events = await adapter.parseWebhook(raw, request.headers, secrets[])   // 複数シークレットで試行（W12）
      SignatureError → webhook_delivery.sig_ok=false, 400 SIGNATURE_INVALID
 5. for each ev:
      a. INSERT INTO payment_event (...) ON CONFLICT (provider_key, provider_event_id)
         DO NOTHING RETURNING id                  // W1。0行なら duplicate でスキップ
      b. if ev.trust === 'unverified':            // PayPay のように署名がない事業者
           snap = await adapter.getPaymentStatus(ev.externalRef)     // 必ず再照会（W7）
           矛盾 → apply_result='mismatch'、outbox に mismatch_alert、台帳に書かない
           一致 → ev.trust = 'reverified'
      c. attempt = SELECT ... FROM payment_attempt
                   WHERE provider_key=$1 AND external_ref=$2 FOR UPDATE
         無ければ apply_result='orphan'（200 を返しつつ台帳を汚さない）
      d. amount / currency / provider_binding を invoice と突合（W8）。不一致 → mismatch_alert
      e. applyToLedger(invoice, ev)               // §3-4
 6. 重い処理（幹事通知・アラート）は outbox へ。ここでは実行しない（W5）
 7. return 200                                    // 2xx を素早く返す
```

- エラー応答は常に JSON で `{ code, message, requestId }`。`code` は機械可読な固定文字列。**恒久的な失敗は 400、こちら側の一時障害は 500**（500 なら事業者がリトライしてくれる）。
- Webhook ルートは CSRF 保護とボディパーサから除外（W6）。Next.js App Router の Route Handler は既定でボディパーサを通さないので追加設定は不要 [文書]。

### 3-4. `applyToLedger`（台帳への単調適用）

```
BEGIN
  SELECT settlement_rank, lifecycle_state FROM invoice WHERE id=$1 FOR UPDATE;

  -- 1) 台帳は常に追記（状態が変わらなくても事実は残す）。dedupe_key の一意制約が二重計上を防ぐ
  INSERT INTO ledger_entry (invoice_id, event_id, direction, kind, amount_minor, currency,
                            confidence, dedupe_key, source_payment_event_id, recorded_by)
  VALUES (...) ON CONFLICT (invoice_id, dedupe_key) DO NOTHING RETURNING id;
  -- 0行 = 既に計上済み。以降の状態更新はスキップして apply_result='duplicate'

  -- 2) 失敗・キャンセル・期限切れは attempt にだけ記録し、invoice の状態を動かさない
  IF ev.kind IN ('failed','canceled','expired') THEN
     UPDATE payment_attempt SET status = ... WHERE id = $attempt;
     COMMIT; RETURN;
  END IF;

  -- 3) 前進のみ（W3）。例外規則なし
  newRank = rankOf(ev.kind);
  UPDATE invoice
     SET settlement_status = $newStatus,
         auto_detected = (auto_detected OR $isAuto),          -- true から false へは戻らない
         confirmation_method = CASE WHEN $isAuto THEN 'automatic' ELSE confirmation_method END,
         paid_at = COALESCE(paid_at, CASE WHEN $newStatus='paid' THEN now() END),
         updated_at = now()
   WHERE id = $1 AND settlement_rank < $newRank;

  -- 4) 取消済み請求への入金は握り潰さない。前進はさせ、注意フラグを立てる
  IF lifecycle_state = 'void' AND ev.kind = 'succeeded' THEN
     UPDATE invoice SET needs_attention = true WHERE id = $1;
     INSERT INTO outbox (kind, payload) VALUES ('paid_after_void', ...);
  END IF;

  -- 5) 二重払い（別 attempt の 2件目の succeeded）は overpay として追記し、状態は paid のまま
  -- 6) 監査
  INSERT INTO audit_log (..., prev_hash, row_hash) VALUES (...);
COMMIT
```

`auto_detected` は `ingestion_source='manual'` なら false のまま、それ以外なら true に**前進のみ**（一度 true になった請求が手動申告で false に戻ることはない）。

### 3-5. 再照合ジョブ（`/api/cron/reconcile`）

```
1. pg_try_advisory_lock(RECONCILE_LOCK_ID) → 取れなければ即 200（多重起動防止 W11）
2. 「状態」で走査（W9・時刻カーソルを使わない）:
     invoice WHERE settlement_rank < 40 AND lifecycle_state='active'
       AND updated_at < now() - interval '3 minutes'
       AND EXISTS (SELECT 1 FROM payment_attempt WHERE invoice_id=invoice.id AND is_open)
3. capabilities.statusQuery === false のアダプタ（manual_confirm）は走査対象から除外
4. adapter.getPaymentStatus(external_ref) の結果を ingestion_source='poll' の payment_event として
   同じ冪等経路に流す（Webhook と照会が同じ処理系に合流する）
5. expires_at 経過の attempt を 'expired' に落とす（invoice のランクは下げない）
6. reconciliation_run に scanned / advanced / mismatches を記録
```

- **未確定の保持期間は最低4日**（W10。Stripe の再送が最長3日という事実を事業者非依存の安全側の既定値として採る）。
- 「1回飛んでも次回で拾える」設計なので、cron の取りこぼし・重複起動のどちらでも壊れない。

---

## 4. 画面一覧と状態

### 4-1. 幹事側

| # | 画面 | 主な要素 | 特有の状態 |
|---|---|---|---|
| O-1 | 起動・同意 | LIFF 初期化 → IDトークン検証 → 利用規約・プライバシー同意（L6/L7） | ローディング / **LINE外アクセス**（`liff.isInClient()` false → 「LINEアプリで開いてください」＋QR） / 認証失敗 |
| O-2 | イベント一覧 | 自分が幹事のイベント、集金進捗（自動 n / 手動 m の内訳） | **空**（初回・「イベントを作る」CTA） / エラー / 再読込 |
| O-3 | イベント作成 | タイトル・開催日・既定金額・締切 | バリデーション / 二重送信抑止（`Idempotency-Key`） |
| O-4 | イベント詳細（名簿） | 参加者行（名前・金額・状態バッジ・**非自動バッジ**）、サマリ「支払済み 2/4（自動確認 1 / 手動確認 1）」、未払い人数・金額 | 空（参加者0） / 一部エラー / **要対応あり**（`needs_attention` の帯） |
| O-5 | 参加者登録 | 手入力・一括貼り付け（改行区切り） | 重複名の警告 / 上限 |
| O-6 | 請求発行 | 参加者×金額、一括・個別調整 | 既発行のスキップ |
| O-7 | 配布 | `shareTargetPicker`（Flexメッセージ）＋**QR＋URLコピーのフォールバックを必ず併設**（N8） | `liff.isApiAvailable()` false → フォールバックのみ表示 / 送信キャンセル |
| O-8 | 手動確認 | 方法（PayPay個人間送金/現金/振込/その他）・**理由必須**・メモ | **確定前に「これは自動照合ではありません」を明示するダイアログ** |
| O-9 | 要対応インボックス | 金額不一致 / 二重払い / 取消後入金 / 孤児イベント / 返金タスク | 空（0件が正常） |
| O-10 | 返金 | 返金実行 | **`capabilities.refund==='none'` → 「この決済手段はアプリからの返金に対応していません。事業者の管理画面で処理してください」** / 409 |
| O-11 | 決済事業者の接続 | `provider_binding` の作成、`credential_ref` の設定 | **ゲート未通過 → 接続ボタン自体を出さず、409 の説明文を表示** |
| O-12 | CSV エクスポート | `auto_detected` 列を必ず含む | — |
| O-13 | 設定・法務 | 規約・プライバシー・特商法表示（有料化時）・データ削除請求 | — |

### 4-2. 参加者側

| # | 画面 | 主な要素 | 特有の状態 |
|---|---|---|---|
| P-1 | 招待リンク着地 | イベント名・主催者名・「自分の名前を選ぶ」 | **LINE外アクセス** / トークン無効・期限切れ / **既に claim 済み → 自分の請求へ直行** |
| P-2 | 自己申告（claim） | 未claimの名簿候補（**氏名のみ。他人の金額・支払状況は返さない**） | 候補なし（幹事に連絡してくださいの案内） / 競合 409 `ALREADY_CLAIMED` |
| P-3 | 自分の請求 | 金額・締切・状態・支払ボタン | 支払済み / 支払待ち（生きている attempt あり） / 期限切れ＋再発行導線 / **取消済み** |
| P-4 | 支払い方法の選択 | イベントに有効なアダプタを並べる。**手動確認アダプタには「幹事が手動で確認します」を明示** | 有効なアダプタが1つもない（ゲート未通過） |
| P-5 | 決済事業者へ遷移 | 外部ドメインへ（唯一外へ出る箇所） | 遷移失敗 / ポップアップブロック |
| P-6 | 決済からの復帰 | `getPaymentStatus` を**1回だけ**叩いて確定（P3）。未確定なら「確認中」表示 | 確定 / **未確定（数分かかる場合があります＋自動更新）** / 失敗 |
| P-7 | 完了 | 領収記録・幹事への連絡導線 | — |

### 4-3. 全画面共通の状態規約

`loading` / `empty` / `error`（再試行ボタンと `requestId` 表示）/ `forbidden`（403。他人のイベント・未claim）/ `outside_line`（LIFF 外）/ `gate_blocked`（409 `GATE_NOT_PASSED`。「決済機能は現在ご利用いただけません」＋理由コード）を**すべての画面で必ず実装する**。`gate_blocked` はサーバー側の拒否が正であり、ボタンの非表示は補助に過ぎない（§5-2）。

---

## 5. PaymentProvider アダプタ IF と初期アダプタ

### 5-1. インターフェース

```ts
// src/lib/payments/types.ts

/** 事業者キーは開いた文字列型。新規追加でコア側のユニオン編集を強制しない */
export type ProviderKey = 'manual_confirm' | 'paypay_online' | 'payjp' | 'paypal' | (string & {});

export type Money = { amountMinor: number; currency: 'JPY' };

export interface ProviderCapabilities {
  /** false ⇒ この経路は自動検知ではない。UI・API・CSV に「手動確認（非自動）」を出す義務が生じる */
  autoDetect: boolean;
  webhook: boolean;
  /** 'none' の事業者は、コアが getPaymentStatus で必ず再照会する（W7） */
  webhookSignature: 'hmac' | 'token' | 'none';
  statusQuery: boolean;
  refund: 'none' | 'full_once' | 'full' | 'partial';
  /** ★ 全事業者 false を型で固定。「支払者が取れる」前提をコード上で書けなくする（P9） */
  readonly payerIdentity: false;
  /** 「決済完了」と「幹事への入金」を別に見せるための表示用注記（P6） */
  settlementLagHint: string;
}

export interface CreateCheckoutCommand {
  invoiceId: string;
  /** 事業者側の外部参照キー。invoiceId を含む一意文字列。<=64, [A-Za-z0-9_-] */
  externalRef: string;
  money: Money;
  description: string;
  /** ★ 必須。LINEミニアプリのパーマネントリンクへ戻す（P4/N4） */
  returnUrl: string;
  expiresAt?: Date;
}

/** 手動確認（非自動）経路。UI はこれを受け取ったら必ず非自動バッジを出す */
export interface ManualInstruction {
  readonly automatic: false;
  channel: 'paypay_p2p' | 'bank_transfer' | 'cash' | 'other';
  deepLink?: string;
  note: string;
  /** ★ 文字列リテラル型で運ぶ。ハードコードでも規約でもなく、型で固定する */
  disclaimer: '支払いの確認は幹事が手動で行います。アプリは入金を検知しません。';
}

export type CheckoutTicket =
  | { kind: 'redirect'; externalRef: string; checkoutUrl: string; expiresAt?: Date; raw: unknown }
  | { kind: 'manual';   externalRef: string; instruction: ManualInstruction };

export type PaymentEventKind =
  | 'authorized' | 'succeeded' | 'failed'
  | 'canceled' | 'expired' | 'refunded' | 'unknown';

export interface NormalizedEvent {
  providerKey: ProviderKey;
  /** 事業者のイベントID。持たない事業者は 'sha256:'+sha256(rawBody) をアダプタが埋める（NULL 禁止） */
  providerEventId: string;
  eventType: string;
  kind: PaymentEventKind;
  externalRef: string;
  /** 観測用の業務キー。★ 一意制約は張らない（§2-2 の注記） */
  businessIdemKey: string;
  /** 台帳の二重計上を防ぐ唯一の鍵。payment は 'pay:<externalRef>'、
   *  refund は 'refund:<providerRefundId>'（無い事業者はアダプタが安定な代替を構成する） */
  ledgerDedupeKey: string;
  money: Money | null;
  occurredAt: Date | null;
  /** 'verified' = 署名検証済 / 'unverified' = 署名なし（コアが再照会する） / 'attested' = 人が申告 */
  trust: 'verified' | 'unverified' | 'attested';
  raw: unknown;
}

export interface PaymentSnapshot {
  providerKey: ProviderKey;
  externalRef: string;
  kind: PaymentEventKind;
  money: Money | null;
  fetchedAt: Date;
  /** ★ 常に null。どの事業者も支払者を返さない（P9 / consolidated §3-12）。
   *  型で null に固定し、誤った前提をコード上で書けなくする */
  payerIdentity: null;
  raw: unknown;
}

export class SignatureError extends Error {}
export class NotSupportedError extends Error {
  constructor(readonly feature: string) { super(`not supported: ${feature}`); }
}
export class ProviderNotEnabledError extends Error {
  constructor(readonly providerKey: string, readonly gateKey: string) {
    super(`provider not enabled: ${providerKey} (gate ${gateKey})`);
  }
}

export interface PaymentProvider {
  readonly key: ProviderKey;
  readonly capabilities: ProviderCapabilities;

  createCheckout(cmd: CreateCheckoutCommand): Promise<CheckoutTicket>;

  /** raw は生文字列。アダプタの外で JSON.parse しない（P2）。
   *  secrets は複数受けてローテーションに耐える（W12） */
  parseWebhook(raw: string, headers: Headers, secrets: string[]): Promise<NormalizedEvent[]>;

  getPaymentStatus(externalRef: string): Promise<PaymentSnapshot>;

  /** 非対応は NotSupportedError。呼び出し側が 409 NOT_SUPPORTED に変換（P7） */
  refund(externalRef: string, money?: Money): Promise<NormalizedEvent>;
}
```

### 5-2. レジストリ（実行時キルスイッチ。arch-B から移植・T2 の G0 を物理化）

```ts
// src/lib/payments/registry.ts
export async function resolveProvider(key: ProviderKey): Promise<PaymentProvider> {
  if (key === 'manual_confirm') return REGISTRY.manual_confirm;

  if (await flags.get('PAYMENTS_ENABLED') !== 'true')
    throw new ProviderNotEnabledError(key, 'PAYMENTS_ENABLED');

  const gates = await requiredGatesFor(key);             // compliance_gate を読む
  const blocking = gates.find(g => g.status !== 'passed' && g.status !== 'n/a');
  if (blocking) throw new ProviderNotEnabledError(key, blocking.gate_key);

  if (await flags.get(`PROVIDER_${key.toUpperCase()}_MODE`) === 'off')
    throw new ProviderNotEnabledError(key, `PROVIDER_${key.toUpperCase()}_MODE`);

  return REGISTRY[key];
}
```

**このチェックを `createCheckout` / `refund` / Webhook 受信 / `provider_binding` 作成のすべての入口に置く。UI のボタン非表示は補助であり、サーバー側の拒否（409 `GATE_NOT_PASSED`）が正。** これが arch-C の「Phase 0 ゲートは散文の完了条件でしかなくコードを止めない」という欠陥の解消である。

### 5-3. 初期アダプタ

**Phase 1 の唯一の出荷アダプタ: `ManualConfirmAdapter`（`manual_confirm`・自動ではない）**

```ts
capabilities = {
  autoDetect: false,           // ★ ここが false であることが全ての起点
  webhook: false,
  webhookSignature: 'none',
  statusQuery: false,
  refund: 'none',
  payerIdentity: false,
  settlementLagHint: '即時（幹事のPayPay残高等に直接着金。アプリは検証しない）',
}
```

- `createCheckout` → 決済を作らない。`{ kind:'manual', instruction:{ automatic:false, channel:'paypay_p2p', deepLink: 幹事が設定した受け取りリンク, disclaimer:'支払いの確認は幹事が手動で行います。アプリは入金を検知しません。' } }` を返す。
- `parseWebhook` → 常に `[]`。`getPaymentStatus` / `refund` → `NotSupportedError`。照合ジョブは `capabilities.statusQuery === false` で走査対象から除外する。
- 台帳への記録は `POST /api/invoices/:id/manual-attest` からのみ発生し、`ingestion_source='manual'` / `trust='attested'` / `confidence='organizer_attested'` / `auto_detected=false` / `confirmation_method='manual_by_organizer'` になる。

**Phase 2 の第一自動アダプタ: `PayPayOnlineAdapter`（`paypay_online`）**

```ts
capabilities = { autoDetect:true, webhook:true, webhookSignature:'none',  // 公開文書に署名検証の記載なし
                 statusQuery:true, refund:'full_once',                     // SDK: "1 refund per order"
                 payerIdentity:false, settlementLagHint:'月1回・月末締め（未検証）' }
```

- `createCheckout` → Web Cashier。`externalRef = 'iv_' + invoiceIdHex + '_' + attemptSeq`（64文字・`[A-Za-z0-9_-]` 内）。`redirectUrl` にミニアプリのパーマネントリンク。
- `parseWebhook` → 署名がないので全イベントを `trust:'unverified'` で返し、`providerEventId = 'sha256:'+sha256(raw)` を埋める。**コアが必ず `getPaymentStatus` で再照会してから台帳に書く**（W7）。インフラ側で IP 許可リストを併用。
- `getPaymentStatus` → `GET /v2/codes/payments/{merchantPaymentId}`。戻り先ページ（1回）と照合ジョブの両方で使う。

**なぜ PayPay を第一アダプタにするか（拡張性の主理由）:** PayPay は調査した事業者の中で**能力が最も貧しい**（署名なし・支払者不明・返金1回のみ・Webhook 設定がセルフサービスでない）。最も貧しい事業者に先に IF を通せば IF が過適合せず、後から来る豊かな事業者は能力を足すだけで乗る。受取先が当初希望に最も近いこと・サンドボックスが審査前から使えることは副次的な補強理由。

**Phase 2 の第二自動アダプタ: `PayjpAdapter`（`payjp`）** — `webhookSignature:'token'`（`X-Payjp-Webhook-Token` を `secrets[]` と定数時間比較）、`refund:'partial'`（要確認）、`providerEventId` を事業者のイベントIDで埋める。**PayPay と決済手段が重ならないので同一イベントでの2アダプタ並列運用に意味があり、アダプタ層の設計が正しいかを実地で検証できる。**

### 5-4. 「自動ではない」ラベルの強制（6項目。arch-C ＋ arch-A の CI ゲート）

1. **API**: 請求を返すすべてのエンドポイントが `autoDetected: boolean` と `confirmationMethod: 'automatic'|'manual_by_organizer'` を必ず含む。省略可にしない（型で必須）。
2. **幹事画面**: `autoDetected === false` の行に「幹事が手動で確認（自動照合ではありません）」バッジを描画する。請求行コンポーネントは `autoDetected` を**必須 props** にする。
3. **CSV**: `auto_detected` 列を必ず出力する。
4. **サマリ**: 「支払済み 2/4」の内訳を「自動確認 1 / 手動確認 1」に分けて表示する。**合算値だけを見せない。**
5. **文言**: 手動確認の請求に「入金を確認しました」と書かない。「幹事が受け取ったと申告」と書く。
6. **CI 必須チェック（ここが機械強制）**:
   - `npm run gate:wording` — `docs/wording-policy.md` の禁止語（「自動チェック」「自動で確認」「入金を確認しました」＋寄付・募金・投げ銭系）を全文言ソースから grep して落とす。
   - `npm run test:unit -- label` — 幹事画面のスナップショットテストに「`autoDetected=false` の行にバッジが存在する」アサーション。**バッジが消えたら CI が落ちる。**
   - ProviderConformanceKit の C10（`autoDetect=false` のアダプタで消し込んだ請求が API レスポンスで `autoDetected:false` を返す）。

**この3本を `main` の required status checks に入れる。** 引継ぎ書が最も強く禁じた失敗（手動版を自動版と説明する）に対して、T1・T2 のどちらのハーネスも機械的な防御を持っていなかったので、ここで補う。

### 5-5. 代理払いの扱い（正直な限界つき）

- **決済事業者APIは支払者を返さない**（`payerIdentity: null` を型で固定）。したがって代理払いは**自動検知できない**。
- 弱いシグナルとして `payment_attempt.opened_by_user_ref`（そのチェックアウトを開いた LINE ユーザー）を記録し、claim 済み `participant.line_user_ref` と食い違ったときに幹事へ**「代理払いの可能性があります（確認してください）」**として提示する。
- **画面にも仕様書にも「自動で代理払いを検知した」と書かない。** これは「誰がリンクを開いたか」の推定にすぎない。確定は幹事の `manual-attest`（`ledger_entry.kind='proxy_payment'`）でのみ行う。

---

## 6. リポジトリ構成案

```
/Users/noritakasawada/AI_P/cashapp/
├── .claude/
│   ├── settings.json                      # フック（§8-4）。プロジェクト単位でオプトイン
│   ├── agents/                            # 既存エージェントの model: オーバーライド＋新規6本（§8-3）
│   │   ├── adversarial-reviewer-gemini.md
│   │   ├── adversarial-reviewer-gpt.md
│   │   ├── payment-contract-guard.md
│   │   ├── compliance-gatekeeper.md
│   │   ├── release-auditor.md
│   │   └── premortem-facilitator.md
│   └── workflows/
│       ├── task-loop.ts                   # 実装→4者並列レビュー→修正→検証（§8-5）
│       ├── premortem.ts
│       └── release-audit.ts
├── .github/
│   ├── CODEOWNERS                         # tests/** と scripts/gate-* を PO 必須レビューに
│   └── workflows/{gate.yml, e2e.yml, release.yml}
├── docs/
│   ├── implementation-plan.md             # plan スキルの15節
│   ├── task-list.json / acceptance-checks.json
│   ├── constraints.json                   # consolidated.md §6（L/P/W/N/I）の機械可読版
│   ├── wording-policy.md                  # 禁止語リスト（CI が grep する）
│   ├── PROGRESS.md / HANDOFF.md
│   ├── decisions/ADR-NNN-*.md             # confidence 欄必須。[設計]/[不明] 依存は proposed 止まり
│   ├── external-inquiries.json            # 照会トラックの状態（draft→sent→answered→superseded）
│   ├── gates/legal-clearance.json         # {cleared:false, basis:null, approved_by:null}
│   ├── run-log/<task_id>.json             # 実行コマンド・終了コード・出力
│   ├── review-log/<task_id>.md            # 封筒つきのモデル間やりとり全文
│   ├── metrics/{weekly-*.json, model-bench.md, cost-*.md}
│   ├── runbooks/RB-01..RB-08.md
│   └── vendor-docs/<provider>/<topic>.md  # 一次資料スニペット（取得日つき）
├── scripts/
│   ├── gate-constraints.sh                # L/P/W/N/I の grep 検査（PostToolUse + CI）
│   ├── gate-check.mjs                     # G1〜G9（§8-7）
│   ├── assert-acceptance.mjs              # evidence.commit == HEAD 照合
│   ├── assert-verify-commands.mjs         # verify_command が package.json.scripts に実在するか
│   ├── deny-dangerous-bash.sh             # legal-clearance.json 連動の物理遮断
│   ├── deny-test-weakening.sh             # 全テストファイル対象
│   ├── assert-diff-exists.sh              # SubagentStop
│   ├── snapshot-progress.sh               # PreCompact
│   ├── session-brief.mjs                  # SessionStart（未通過ゲート＋未回答照会を注入）
│   ├── gate-status.mjs                    # UserPromptSubmit
│   ├── build-review-packet.sh / merge-review.sh / validate-findings.mjs
│   ├── review-gemini.mjs / review-gpt.mjs
│   ├── bench-models.sh                    # 週0の実測
│   └── wording-lint.mjs
├── supabase/migrations/                   # §2 のスキーマ
├── src/
│   ├── app/
│   │   ├── (organizer)/…                  # O-1〜O-13
│   │   ├── (participant)/e/[joinToken]/…  # P-1〜P-7
│   │   └── api/
│   │       ├── auth/line/route.ts
│   │       ├── events/…                   # §3-1
│   │       ├── e/[joinToken]/…
│   │       ├── invoices/[id]/{void,manual-attest,refund}/route.ts
│   │       ├── webhooks/[providerKey]/route.ts
│   │       ├── cron/{reconcile,outbox,retention}/route.ts
│   │       ├── admin/gates/route.ts
│   │       └── health/route.ts
│   ├── lib/
│   │   ├── auth/{line-verify.ts, session.ts, csrf.ts, pepper.ts}
│   │   ├── db/{schema.ts, client.ts, repositories/*.ts}   # organizerUserId を必須引数に
│   │   ├── ledger/{apply.ts, rank.ts, dedupe.ts}
│   │   ├── payments/
│   │   │   ├── types.ts registry.ts gates.ts
│   │   │   └── providers/{manual-confirm.ts, paypay-online.ts, payjp.ts}
│   │   ├── idempotency.ts outbox.ts audit.ts secrets.ts errors.ts
│   └── components/…                       # InvoiceRow は autoDetected を必須 props に
├── tests/
│   ├── unit/ contract/ conformance/ integration/ e2e/
│   └── fixtures/<provider>/<case>.json     # 生本文＋ヘッダ
├── vercel.json                            # {"regions":["hnd1"]}
└── package.json
```

---

## 7. フェーズ分割・マイルストーン・Go/No-Go

### Phase 0 — 照会・法務・同意ゲート（コードは書かない。リポジトリ初期化とハーネス構築は並行可）

| # | やること | 完了条件 |
|---|---|---|
| 0-1 | **受取先変更へのユーザー明示同意**（§1-1） | noritaka が「受取先が幹事の個人PayPay残高ではなくなる」「幹事に加盟店審査が発生する」ことに同意。`compliance_gate('G0-USER')` に記録 |
| 0-2 | PayPay 加盟店窓口へ照会（§10 Q-PP1〜7） | **「会費徴収が取扱可能商材か」の回答を文書で得る**。NG なら第一候補を PAY.JP に差し替え |
| 0-3 | PAY.JP へ照会（規約本文取得・個人間送金/立替精算の扱い・非事業者可否・手数料率） | 規約本文を入手し、会費徴収が対象商材に含まれることを確認 |
| 0-4 | LINEヤフーへ照会（§10 Q-LN1〜3, 6） | 「幹事が管理する精算・集金の台帳」という定義で禁止業種に当たらないことの回答 |
| 0-5 | 弁護士照会（§10 Q-LG1〜4, 7 を最優先） | 内閣府令1条の2第3号の適用可否と、**Q-LG7（幹事の加盟店クレデンシャルを預かることが資金の受入れへの関与と評価されるか）**について書面の見解 |
| 0-6 | 回答を `compliance_gate` に evidence_uri 付きで記録 | 全ゲートの `status` が `unknown` から動く |

**Go/No-Go（Phase 2 へ進む条件）:** `G0-USER` が passed、**かつ** PayPay または PAY.JP のいずれか1社から肯定的回答、**かつ** 弁護士見解が「運営者が資金に触れない構成なら登録不要」の方向、**かつ** `GATE-CRED-CUSTODY` が passed または n/a。
**No-Go の場合:** `manual_confirm` 単独構成で Phase 1 の成果物を運用継続する（§1-1 の出口）。

**ゲート一覧（`compliance_gate` の初期在庫）**

| gate_key | 内容 | required_for |
|---|---|---|
| `G0-USER` | 受取先変更と加盟店審査発生への PO 明示同意 | phase1, phase2 |
| `GATE-LINE-POLICY` | 集金台帳がミニアプリポリシー上許容される | **phase1** |
| `GATE-LEGAL-PII` | 幹事への支払状況開示の法的整理と同意文言が確定 | **phase1** |
| `GATE-PP-MERCHANDISE` | 会費徴収が PayPay オンラインの取扱可能商材である | phase2 |
| `GATE-PP-ONBOARD` | 幹事が加盟店申込できる（必要書類が確定） | phase2 |
| `GATE-PP-WEBHOOK` | Webhook の署名有無・リトライ・ペイロード定義が確定 | phase2 |
| `GATE-LEGAL-FUNDS` | 本資金フローが資金移動業登録を要しないとの弁護士所見 | phase2 |
| `GATE-CRED-CUSTODY` | 幹事の加盟店資格情報を運営者が保管することの法的・契約的評価 | phase2 |

`GATE-LINE-POLICY` と `GATE-LEGAL-PII` は**決済のない Phase 1 のリリースにも必要**。名簿と支払状況の表示自体が個人情報の第三者提供論点を持つため。

### Phase 1 — 決済非依存コア（Phase 0 と並行。本設計の中核資産）

| MS | 内容 |
|---|---|
| M1-0 | **ハーネス構築を機能実装より先に置く**（§8-9）: `.claude/settings.json`、`scripts/gate-*`、`docs/constraints.json`、CI の骨格、codex フック解除（0-7） |
| M1-1 | リポジトリ初期化（npm / Next.js 15 / TS / Drizzle / Vitest）、`vercel.json` に `"regions":["hnd1"]`、CI（typecheck/lint/unit） |
| M1-2 | §2 のスキーマ全テーブル＋制約＋生成列＋インデックス。`ledger_entry` / `audit_log` の UPDATE/DELETE 禁止、全テーブル RLS deny-all |
| M1-3 | LINE IDトークン検証＋自前セッション＋CSRF（§1-5）、`line_user_ref` の HMAC 化 |
| M1-4 | イベント作成・参加者登録・請求発行・名簿表示・**招待リンク＋self-claim**・`shareTargetPicker` 配布＋QR/コピーのフォールバック |
| M1-5 | `PaymentProvider` IF ＋ `resolveProvider`（ゲート込み）＋ `ManualConfirmAdapter`（非自動ラベル6項目込み） |
| M1-6 | `applyToLedger` と冪等基盤（W1 一意制約、`ledger_dedupe_uk`、単調ランク、`audit_log` ハッシュ連鎖） |
| M1-7 | ProviderConformanceKit（§9-2）と ManualConfirm の適合テスト。Webhook ルートは**実装するが 404 を返す**（ゲート未通過） |
| M1-8 | `compliance_gate` / `feature_flag` の管理画面、保持期間 cron（擬似匿名化・生本文削除） |

**Go/No-Go（Phase 1 完了条件）**

1. 未認証ミニアプリとして本番リリースでき、幹事が名簿・請求・手動確認で1イベントを完走できる。
2. ProviderConformanceKit の「重複・逆順・署名不一致」3本が緑（`npm run test:contract`）。
3. 幹事画面に「自動確認 n / 手動確認 m」の内訳が出ている。
4. **`npm ls` に決済事業者SDKが1つも含まれていない**（依存が存在しなければ誤って本番決済を叩けない。フラグより強い最終防御。arch-B から移植）。
5. **`npm run gate:wording` が緑**で、「自動チェック要件を満たした」に類する文言がプロダクト全体に1つも無いことを機械的に確認。
6. `GATE-LINE-POLICY` と `GATE-LEGAL-PII` が `passed`。
7. IDOR テスト（他人のイベント・他人の請求への到達不能）が緑。
8. ログ出力 grep テストで資格情報・生の userId・生IP が出ていないことを確認。

### Phase 2 — 自動アダプタ（Phase 0 のゲート通過が前提）

| MS | 内容 |
|---|---|
| M2-1 | `PayPayOnlineAdapter` を STAGING サンドボックスで実装・ConformanceKit 通過（**加盟店審査の完了を待たずに着手可**） |
| M2-2 | Webhook ルート有効化＋再照会（`trust='unverified'` 経路）、`/api/cron/reconcile` |
| M2-3 | 幹事の `provider_binding` 接続フロー（`credential_ref` / 封筒暗号化）、返金、二重払い検知、入金予定（`settled_at`）表示 |
| M2-4 | PayPay 加盟店審査の通過、本番クレデンシャル接続 |
| M2-5 | `PayjpAdapter` 実装＋適合テスト＋同一イベントでの2アダプタ並列運用 |

**Go/No-Go（Phase 2 完了条件）**

1. 実際の決済1件が Webhook 経由で台帳に載り、その請求の `auto_detected=true` になる。
2. **Webhook を止めた状態で、照合ジョブだけで同じ請求が `paid` に到達する**（Webhook 依存でないことの証明）。
3. **サンドボックス一巡の後、本番で少額の実弾1件を通し、幹事の受取口座への着金までを人間が確認して運用記録に残す**（arch-B から移植。「決済完了」と「幹事への入金」が別物であることを表示設計だけでなく実測で確かめる）。
4. **キルスイッチ動作確認**: `PROVIDER_PAYPAY_ONLINE_MODE` を `off` に戻すと、既存 pending の再照合は続くが**新規 checkout が 409 `GATE_NOT_PASSED` になる**ことを実測する。
5. アダプタを1本追加したとき（M2-5）に**コア（`applyToLedger` / API / 画面）へ一切の変更が入らなかったこと**を diff で示す。これが本設計の仮説の検証。
6. `GATE-LEGAL-FUNDS` と `GATE-CRED-CUSTODY` が `passed`、`docs/gates/legal-clearance.json` の `cleared` が `true`。

### Phase 3 — 運用・拡張

| MS | 内容 |
|---|---|
| M3-1 | LINEミニアプリ認証審査の申請・通過、サービスメッセージ（支払完了通知） |
| M3-2 | 幹事向け照合ダッシュボード（mismatch / 孤児 / 二重払い / 取消後入金 / 返金タスク） |
| M3-3 | 催促導線（Messaging API またはサービスメッセージ）、複数イベント横断の台帳 |
| M3-4 | `BankReconciler`（候補E）の検討着手。電代業のリードタイム調査と提携先確保。**KEK を KMS へ** |

**Go/No-Go:** 未処理の mismatch が24時間以内に幹事へ通知され、`reconciliation_run` の直近7日で `mismatches = 0` が維持される。

---

## 8. チーム構成とハーネス

**使用モデル: Opus 5.5 / Sonnet / Gemini 3.8 Flash / GPT-6 Astla。Fable モデルは使わない。**
なお `fable-protocol` は `~/.claude/skills` 配下の**プロンプト規範スキル**でありモデルではない [文書]。その「完了前5ステップゲート」と「4値完了ステータス」は全モデル共通のプロトコルとして採用する。両者を混同しない。

### 8-1. モデル配置の原則

1. **判断の可逆性で分ける。** 取り消しが効かない判断（設計の骨格、法務、リリース可否、レビュー裁定）は Opus 5.5。取り消しが効く作業（実装、定型修正、テスト記述）は Sonnet。読み捨ての大量収集は Gemini 3.8 Flash。
2. **検出者と作者は別ベンダーにする。** Claude が書いたものを Claude が承認する経路を設計上どこにも作らない。レビューの事実主張の最終票は Gemini / GPT が持つ。根拠: `consolidated.md` の3レンズ反証検証で、Claude 系の断定が実際に複数覆っている（§3-1〜3-8）。
3. **不明なスペックに依存した配置をしない。** 4モデルの単価・レイテンシ・コンテキスト長は**すべて [不明]**（本プロジェクトで一次資料を取得していない）。配置根拠は「失敗した時の損害 × 検証コスト」に置き、**週0の `scripts/bench-models.sh` で実測するまで本節の配置は「暫定」と扱う。**

### 8-2. 役割表

| レーン | 役割 | 担当 | 停止・エスカレーション条件 |
|---|---|---|---|
| 意思決定 | PO / 最終決裁 | **[人間] noritaka** | 最終決裁者。ここで止まる |
| 意思決定 | 照会文起案・回答の構造化 | **[Opus5.5]** | 回答が「確認中」で2週間停滞 → PO へ日次エスカレーション |
| 意思決定 | 法務ゲートキーパー | **[人間] 弁護士** ＋ [Opus5.5] が事前整理 | **本番決済の有効化は弁護士確認またはグレーゾーン解消制度の回答が出るまで無条件でブロック（L11）** |
| 設計 | オーケストレーター / 実装リード | **[Opus5.5]**（Claude Code メインセッション） | コンテキスト60%超 → 成果物へ圧縮して再開。ゲート3連続失敗 → PO へ |
| 設計 | 要件分解・タスク化 | **[Opus5.5]**（`requirement-analyzer` → `task-decomposer`） | 受入基準が YES/NO 化できない → 分解し直す |
| 設計 | 技術設計・ADR | **[Opus5.5]**（`technical-designer`） | 決済事業者未確定の部分にアダプタ層以外の依存が生じたら停止 |
| 実装 | バックエンド実装 | **[Sonnet]**（`task-executor`） | タスクファイルに無い判断が必要 → `NEEDS_CONTEXT`（勝手に埋めない） |
| 実装 | LIFF / フロント実装 | **[Sonnet]**（`task-executor-frontend`、`web-typography` / `frontend-design` スキル） | 同上 |
| 実装 | 決済アダプタ・Webhook・状態機械（難所） | **[Opus5.5]**（`task-executor` に `model: opus`） | W2/W3 を満たせない設計に行き当たったら設計へ戻す |
| 実装 | 品質修正 | **[Sonnet]**（`quality-fixer`） | **テストを通すためにテストを編集しようとした瞬間に停止**し `BLOCKED` |
| 実装 | 受入テスト生成 | **[Sonnet]**（`acceptance-test-generator`） | **実装を見せない**（仕様のみ入力）。見て書いたら無効 |
| 調査 | 広域一次資料フェッチ・逐語抽出 | **[G-Flash]** | フェッチ失敗は「取得失敗」と明記。推測で埋めたら差し戻し |
| 調査 | 結論の統合 | **[Opus5.5]**（`investigator`） | 逐語引用のない主張は結論に載せない |
| 検証 | 自陣レビュー（設計適合） | **[Opus5.5]**（`code-reviewer`） | 判定に「〜はず」が入ったら差し戻し。**事実主張の反証は担当外** |
| 検証 | 敵対レビューA（規約・一次資料の裏取り） | **[G-Flash]**（`adversarial-reviewer-gemini`） | **一次資料を再フェッチせずに「規約違反なし」と書いたら無効票**。逐語引用できない制約は PASS でなく `UNKNOWN` |
| 検証 | 敵対レビューB（反例提示） | **[GPT6]**（`adversarial-reviewer-gpt`） | 具体的な入力列を書けない指摘は `severity:info` に降格 |
| 検証 | 契約ガード（P/W/N/I の機械検査） | **[Sonnet]**（`payment-contract-guard` + `gate-constraints.sh`） | 1件でも違反 → マージ不可 |
| 検証 | コンプライアンス・ゲートキーパー（L/P/N の**全件**） | **[Opus5.5]**（`compliance-gatekeeper`） | **L1〜L12 / P1〜P9 / N1〜N12 を全件チェックし1件でも fail ならリリース不可** |
| 検証 | 証拠照合（完了前5ステップゲート） | **[Opus5.5]**（`verifier` / `code-verifier`） | 「テストが走った」と「テストが通った」の混同を検出したら差し戻し |
| 運用 | リリース前監査 | **[Opus5.5] + [G-Flash] + [GPT6]**（3者独立） | **1者でも no-go なら PO 判断へ。全会一致でなければ自動リリースしない** |
| 運用 | プレモータム | **[Opus5.5]** 起案 → **[GPT6]** 反証 → **[G-Flash]** 一次資料照合 | 前回 high の未対応が3件以上 → 実装の新規着手を止める |
| 運用 | インシデント一次対応 | **[Sonnet]**（ランブック実行）→ [人間] 判断 | **資金・返金に関わる操作は人間の承認なしに実行しない** |
| 運用 | コスト監視 | **[Sonnet]**（週次） | 週次予算の120%超で Opus 呼び出しを一時停止し PO へ |

**外部人間:** 弁護士（資金決済法・フィンテック。週0着手・本番前必須）／PayPay 加盟店窓口（週0。**Q1 だけで候補Aの go/no-go が決まる**）／PAY.JP／LINEヤフー審査窓口／税理士（優先度低）／パイロット幹事3〜5名（実データを扱う前に L6 同意フローが必要）。

### 8-3. モデル別の得意・リスク・撤回条件

| モデル | 配置 | リスク | 対策 | 配置を撤回する条件 |
|---|---|---|---|---|
| **Opus 5.5** | 設計・法令読解・裁定・ゲート判定・リリース監査 | 自分の推論に自信を持ちすぎる（引継ぎ書 §4-2 が訂正した断定はこの系統）。コスト最大 | 事実主張は必ず異ベンダーの反証を通す。1タスクあたり呼び出し3回以内（設計 → レビュー判定 → 完了ゲート） | 設計レビューで異ベンダーの High finding が3スプリント連続 → 設計段階から GPT6 を同席 |
| **Sonnet** | 実装・品質修正・受入テスト生成・契約ガード・ブリッジ | **仕様の穴を質問せずに埋める**（決済事業者未確定なのに SDK を直接 import する等） | タスクファイルに「してよい/してはいけない判断」を明記。`NEEDS_CONTEXT` の規律。PostToolUse の `gate-constraints.sh` で穴埋めを構造的に潰す | `NEEDS_CONTEXT` 率が30%超 → タスク分解が粗い |
| **Gemini 3.8 Flash** | 一次資料の広域フェッチと逐語抽出、diff の一次スクリーニング、敵対レビューA | 深い法解釈は任せられない。フェッチ失敗を「存在しない」と書く危険 | 出力を「逐語引用＋URL＋取得日時＋取得成否」に固定。**引用のない主張は無効票**。統合と解釈は Opus | Gemini 単独検出 finding が2スプリント連続ゼロ → 役割が機能していない |
| **GPT-6 Astla** | 敵対レビューB（反例提示）、プレモータム反証、リリース監査の第3票 | **経路が codex CLI 1本**（codex MCP は CONNECTION_CLOSED [実測]）。日本法・PayPay・LINE の文脈知識は未検証 | 法令解釈は担当させず「この diff が制約 X に違反する**具体的な入力列**を1つ挙げよ。挙げられなければ PASS と書け」の反例提示型に限定 | 同上 |

**★ 週0 の最優先タスク: codex フックの解除（T1 の実測に基づく事実訂正）**

[実測] `ALLOW_NON_CLAUDE_MODEL=1 codex exec -m gpt-6-astra ...` は `hook: UserPromptSubmit Blocked` で起動しない。原因は `~/.codex/hooks/block-non-claude-model.sh` に、Claude 側の同名フック（`~/.claude/hooks/block-non-claude-model.sh`）が持つ `if [ "${ALLOW_NON_CLAUDE_MODEL:-0}" = "1" ]; then exit 0; fi` の例外句が**無い**こと。解除方法は (1) 同じ例外句を追加、または (2) `~/.codex/hooks.json` の `UserPromptSubmit` から当該フックを外す。

**これは設定変更なので noritaka の承認を取ってから行う。AI が勝手に変えてはならない。** 解除するまで GPT 票は `BLOCKED` として扱い、**「3ベンダー体制でレビューしている」と報告してはならない**。暫定は Gemini を反証モードに切り替えて代替し、代替を使った事実を `docs/review-log/<task_id>.md` と PR コメントに必ず記録する。

**モデル名について:** ユーザー表記は「gpt6 astla」だが、[実測] `~/.codex/config.toml` の既定モデルは `gpt-6-astra`。**実行時のモデル指定は `gpt-6-astra` を使う**（表記揺れと判断）。この判断自体を ADR に残す。

### 8-4. フック（`.claude/settings.json`。プロジェクト単位でオプトイン）

| イベント | フック | 目的 |
|---|---|---|
| `SessionStart` | `node scripts/session-brief.mjs` | **未通過ゲート（`compliance_gate`）＋未回答の外部照会（`docs/external-inquiries.json`）＋`docs/gates/legal-clearance.json`＋HANDOFF 末尾**を毎セッション注入。compact 後に「照会が未回答なのに決済事業者を決め打ちする」を直接防ぐ |
| `UserPromptSubmit` | `node scripts/gate-status.mjs` | 毎ターン、未通過 check 件数と直近の BLOCKED タスクを本文へ注入 |
| `PreToolUse(Bash)` | `bash scripts/deny-dangerous-bash.sh` | `rm -rf` / `git push -f` / `git reset --hard` / `supabase db reset` / `supabase db push` / `vercel --prod` / `sk_live_` / `--live` / `PAYPAY_ENV=PROD` / `npm publish` / **`pnpm`（破損）** を遮断。**最優先ルール: `jq -r '.cleared' docs/gates/legal-clearance.json` が `true` でない限り、決済・本番系を全て exit 2 で拒否（L11 の物理強制）** |
| `PreToolUse(Edit\|Write\|MultiEdit)` | `bash scripts/deny-test-weakening.sh` | **全テストファイル**（`tests/**`, `*.test.*`, `*.spec.*`）で `it`/`test`/`expect` を減らす編集と `.skip`/`.todo`/`.only` の追加を遮断。本番鍵の書き込みも遮断 |
| `PostToolUse(Edit\|Write\|MultiEdit)` | `npx tsc --noEmit` / `npm run lint:changed` / `bash scripts/gate-constraints.sh` / `node scripts/validate-plan-json.mjs` | **壊れたコードを次の編集に持ち越さない。** 制約違反を編集時点で落とす |
| `Stop` | `npm run test:contract` / `node scripts/gate-check.mjs` | 冪等性3本と完了ゲートを毎ターン |
| `SubagentStop` | `bash scripts/assert-diff-exists.sh` | サブエージェントの完了報告を VCS diff で検算（調査専任は差分ゼロが正常なので**警告のみ**） |
| `PreCompact` | `bash scripts/snapshot-progress.sh` | 圧縮前に `HANDOFF.md` / `PROGRESS.md` を強制永続化 |

**[不明・導入前に必ず確認]** `PreToolUse` / `SubagentStop` / `PreCompact` の実在と、`PreToolUse` が exit 2 でツール呼び出しを遮断する挙動は未検証。本プロジェクトで実在を確認できているのは `SessionStart` / `UserPromptSubmit` / `Notification`（実 settings.json [文書]）と `PostToolUse` / `Stop`（fable-protocol `references/hooks.md` [文書]）のみ。**着手時に `update-config` スキルで実挙動を確認し、使えないイベント分のゲートは CI と `Stop` フックへ寄せる。移せなかった分は「ゲート網の穴」として明示的に台帳化する。**

`scripts/gate-constraints.sh` が grep で落とす対象: **L1/L3**（`escrow` / `platform_balance` / `wallet_balance` / `user_balance` / `payout_to_organizer` / `charge_top_up` の語彙）、**P1**（`src/lib/payments/providers/` 外での決済SDK import）、**P2**（Webhook ルートでの `req.json()`）、**W1/W2**（`on conflict` と `ledgerDedupeKey` の不在）、**W3**（`settlement_rank` ガード無しの `settlement_status='paid'`）、**N2**（`getProfile()`/`getDecodedIDToken()` の結果をサーバへ送信）、**I3**（`createBrowserClient` 等のクライアント直 DB アクセス）、**非自動ラベル**（`autoDetected` を省略可にする型定義の混入）。

### 8-5. Workflow スクリプト

**[文書]** Workflow の API は `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()`。**先頭に純リテラルの `export const meta` が必須**、`Date.now()` / `Math.random()` は使用不可。
**★ 重要な事実訂正:** `opts.model` は **Claude のティア指定**であり、Gemini / GPT へは `opts.model` では到達しない。**`agentType` で Bash ラッパーエージェント（`adversarial-reviewer-gemini` / `adversarial-reviewer-gpt`）を指すことでのみ到達する。**（T1 の指摘。T2 の疑似コードはここが未定義だった）

`.claude/workflows/task-loop.ts`（1タスクの基本ループ）

```
step 0  preflight        depends_on 未完 / ADR 未決 / constraint_ids 空 → BLOCKED or NEEDS_CONTEXT
step 1  spec-first tests agentType:"acceptance-test-generator"（受入基準のみ。実装を渡さない）
                         → 書いたテストが【赤い】ことを先に確認する。緑なら仕様が既存実装に汚染されているので差し戻し
step 2  implement        agentType:"task-executor"（model: sonnet / 難所は opus）
step 3  self-quality     agentType:"quality-fixer"（テスト改変は PreToolUse が遮断）
step 4  parallel(4〜5):
          a) agentType:"code-reviewer"                 [Opus5.5]  設計適合
          b) agentType:"adversarial-reviewer-gemini"   [G-Flash]  規約・一次資料
          c) agentType:"adversarial-reviewer-gpt"      [GPT6]     反例提示
          d) agentType:"payment-contract-guard"        [Sonnet]   制約の機械検査
          e) agentType:"compliance-gatekeeper"         [Opus5.5]  ※資金フローに触れる時のみ
step 5  merge-verdict    scripts/merge-review.sh
          high 1件でも → step 6（最大3周）
          compliance-gatekeeper が BLOCKED → ループを回さず即終了。人間（弁護士）へ
          UNKNOWN が制約総数の20%超 → レビュー無効。再実行
          いずれかの reviewer_route が "unavailable" → レビュー無効。マージ不可
step 6  fix              findings の repro（反例）を【先にテストケース化してから】直す。step 4 へ戻る
step 7  final verify     agentType:"verifier" [Opus5.5]  完了前5ステップゲート
step 8  status           4値ステータスを返し docs/PROGRESS.md に1行追記
```

他2本: `premortem.ts`（**4レンズ並列**: legal / payment / platform / harness。フェーズ境界＝設計確定時・実装完了時・パイロット前・本番前に再実行し、**前回結果との差分だけを新規リスク**として扱う）、`release-audit.ts`（3者独立監査。全会一致でなければ自動リリースしない。L11 未達なら無条件 no-go）。

### 8-6. CI（GitHub Actions）

ローカルのフックは「自分で気づく」ため、CI は「通さない」ため。両方要る。

| ジョブ | 内容 |
|---|---|
| `static` | `tsc --noEmit` / `eslint --max-warnings=0` / `npm run test:unit` / `bash scripts/gate-constraints.sh` |
| `contract` | `npm run test:contract`（重複・逆順・署名不一致の3本）＋ `npm run test:conformance` |
| `labels` | **`npm run gate:wording`（禁止語 grep）＋ 非自動バッジのスナップショットアサーション**（§5-4） |
| `integration` | `supabase start` → マイグレーション → `npm run test:integration`（DB 制約が実際に効くことを実測） |
| `secrets` | `sk_live_` / `rk_live_` / `whsec_*` の混入検査 ＋ gitleaks ＋ **ログ出力 grep テスト** |
| `deps` | **`npm ls` に決済事業者SDKが含まれていないこと**（Phase 1 の間のみ有効）|
| `adversarial` | PR のみ。`build-review-packet.sh` → Gemini / GPT レビュー → `merge-review.sh`。**`continue-on-error` を使わず、経路失敗は `reviewer_route:"unavailable"` として記録し、unavailable があればレビュー無効＝マージ不可** |
| `acceptance` | `node scripts/assert-verify-commands.mjs`（verify_command が `package.json.scripts` に実在するか＝**コマンド捏造の検出**）→ `node scripts/assert-acceptance.mjs`（**`evidence.commit == HEAD` 照合＝古い実行結果の使い回しの検出**） |
| `test-tamper-guard` | `tests/**` に変更があれば PR の `contract-test-approved` ラベルを `gh pr view` で検査。無ければ exit 1（**ローカルフックを迂回したコミットをリモートで止める**） |
| `e2e`（別 workflow） | nightly ＋ リリース前のみ。Playwright + `@line/liff-mock` |

**ブランチ保護:** `main` に対し `static` / `contract` / `labels` / `secrets` / `deps` / `adversarial` / `acceptance` / `test-tamper-guard` を required status checks に設定し、直 push を禁止。`.github/CODEOWNERS` で `tests/**` と `scripts/gate-*` を PO 必須レビュー対象にする（**ゲートそのものを緩める PR を人間が見る経路を作る**）。
`release.yml` の最先頭ステップで `jq -e '.cleared == true' docs/gates/legal-clearance.json` を検証し、false なら即失敗させる（L11 の物理バインド）。

### 8-7. `docs/task-list.json` / `acceptance-checks.json` をゲートとして使う

`task-list.json` の必須フィールド: `id` / `title` / `status` / `owner_model` / `agent` / `depends_on` / **`constraint_ids`（空ならゲートで弾く）** / **`acceptance_check_ids`（必須）** / `gate_level` / `decision_dependency`（ADR 待ちなら埋める）/ `adversarial_review`（決済・法務に触れるものは `required` 固定）/ `verify_commands` / `completion_status`（4値）/ `concerns[]` / **`evidence_label`（[実測]/[文書]/[設計]/[不明]）**。

`acceptance-checks.json` の `evidence`: `{ command, exit_code, stdout_tail, commit, ran_at, by }`。

`scripts/gate-check.mjs` の判定（Stop フックと CI で同じコードを使う）

| # | ルール | 由来 |
|---|---|---|
| G1 | 全タスクに `done_definition` と `verify_commands` が非空 | T1 |
| G2 | **全 `verify_commands` が `package.json.scripts` に実在する（コマンド捏造の検出）** | T1 |
| G3 | 各 check が少なくとも1つの task から参照されている | T1 |
| G4 | **`DONE` のタスクは `docs/run-log/<task_id>.json` に全 `verify_commands` の exit 0 の記録を持つ** | T1 |
| G5 | `risk_level: high` のタスクが `DONE` なら `docs/review-log/<task_id>.md` に敵対レビュー記録がある | T1 |
| G6 | `DONE_WITH_CONCERNS` は `concerns[]` に severity と対応案が付いている | T1 |
| G7 | `tests/contract/` のファイル数が前回コミットより減っていない | T1 |
| G8 | `git diff` に `sk_live_` 等が含まれない | T1 |
| G9 | **`evidence.commit === HEAD`（古い実行結果の使い回しの検出）** | T2 |
| G10 | **`[設計]` または `[不明]` ラベルに依存する ADR の `status` が `accepted` になっていない** | 審査員の推奨 |

### 8-8. モデル間の受け渡し（封筒フォーマット）

```json
{
  "envelope_version": 1,
  "from": "claude-sonnet", "to": "gpt-6-astra",
  "purpose": "adversarial_review", "task_id": "T-014",
  "context": {
    "what_this_repo_is": "LINEミニアプリの会費集金台帳。運営者は資金に触れない（制約L1）。",
    "constraints_in_force": ["L1","L2","W1","W2","W3","W4","P2","P3","P9"],
    "known_unknowns": ["PayPayのWebhook署名検証の有無（W7）","Stripe 日本のC2C条項の射程","会費徴収がPayPayのNG商材か"]
  },
  "artifact": { "type": "git_diff", "base": "origin/main", "head": "HEAD" },
  "constraints": [ { "id":"P2", "text":"...", "source_url":"...", "fetched_at":"..." } ],
  "question": "重複・逆順・署名不一致で状態が壊れる具体的なイベント列を示せ。",
  "output_contract": { "schema":"FINDINGS",
    "rules": ["問題なしで終わらせない","推測は推測と書く","存在しないAPIメソッドを指摘に使わない",
              "逐語引用できない制約は PASS ではなく UNKNOWN"] },
  "reviewer_route": null
}
```

- **制約は ID だけでなく全文を毎回同梱する**（受け取り側にリポジトリ文脈が無い前提）。
- **受け取り側の出力も `from`/`to` を入れ替えた同じ封筒で返させ、`docs/review-log/<task_id>.md` にそのまま貼る。** `reviewer_route: "verified" | "cli-fallback" | "unavailable"` を必ず埋める。どのモデルが何を言ったか、代替経路を使ったかが後から追える。

### 8-9. 順序規律と週次リズム

**順序規律（明文化する）:** `task_001`〜`task_00N` を**ハーネス実装に固定し、機能実装より先に置く**。`gate-check.mjs` / `gate-constraints.sh` / `session-brief.mjs` / `deny-*.sh` / `constraints.json` / CI 骨格が揃うまで機能タスクに着手しない。本書のハーネスは重い（新規エージェント6本・スクリプト約15本・Workflow 3本・ゲート10段・CI 10ジョブ）ので、**この順序規律なしでは着手されないまま形骸化する。** T2 自身が「ハーネスが遅すぎて使われなくなる」を最大の静かな失敗として挙げており、本設計はその最大リスク保有者である。

**週0（着手週）にやること — 順番も含めてこの通り**

1. **codex フックの解除**（noritaka の承認を取ってから。§8-3）
2. `scripts/bench-models.sh` の実行（4モデル×3タスク、判定基準を事前固定して1回だけ）
   - B1: `consolidated.md` §6 の制約表 → `docs/constraints.json` の構造化変換（欠落セル数。合格=0）
   - B2: W2 違反を仕込んだ40行の Webhook ハンドラのバグ検出と再現入力列（合格=正解検出かつ誤検出0）
   - B3: 一次資料の逐語引用一致率（合格=逐語一致）
   - **結果が出るまで §8-2 の配置は「暫定」。** 実測でひっくり返ったら §8-3 の撤回条件に従う。
3. ハーネス実装（`task_001`〜）
4. Phase 0 の照会文起案と送付（PayPay → Stripe → 弁護士 → LINEヤフーの順）

**週次リズム（noritaka の稼働は週60〜90分想定）:** 月曜に PROGRESS / ゲート状態のレビューと当週の1手決定、随時のエスカレーション対応、金曜にメトリクス確認。**月次枠に「レビュアの健全性テスト」を入れる — 既知バグを混ぜた diff を流してレビュアの検知率を測る。** レビューが形骸化したことを、指摘がゼロになる前に検知するため。

**計測指標（`docs/metrics/weekly-<ISO週>.json`）:** レビュー差し戻し率、Gemini/GPT のユニーク検出数、`NEEDS_CONTEXT` 率、`UNKNOWN` 率、`reviewer_route` の unavailable 率、ゲート違反の検出箇所（編集時／PR／CI のどこで捕まったか）、モデル別コスト、未通過ゲート数、未回答照会の滞留日数。

### 8-10. ハーネス自体の失敗モードと対策

| # | 失敗モード | 検知 | 対策 |
|---|---|---|---|
| F1 | **幻覚API**（PayPay SDK に無いメソッド、`paypay_payments` ケイパビリティを実在扱い） | GPT 敵対レビューの重点項目。typecheck。`docs/vendor-docs/` との突合 | SDK 呼び出しをアダプタ層に閉じ込め、アダプタのテストは録画済み fixture で書く |
| F2 | **完了の過大申告** | G4（run-log に exit 0 が無い DONE は fail）＋ G9（evidence.commit == HEAD） | 4値ステータスの強制。証拠（コマンド＋終了コード）の添付をテンプレ化 |
| F3 | **テスト改変** | `deny-test-weakening.sh`（全テストファイル）＋ CI の `test-tamper-guard` ＋ G7 ＋ CODEOWNERS | 契約テスト3本は「人間ラベル承認がないと変えられない」資産にする |
| F4 | **コンテキスト喪失**（compact 後に照会未回答を忘れて決済事業者を決め打ち） | `session-brief.mjs` が毎回 `external-inquiries.json` と `legal-clearance.json` を注入 | `PreCompact` で HANDOFF 強制永続化。広いコード探索はサブエージェントに委譲して結論だけ受け取る |
| F5 | **MCP 停止** [実測: context7 / codex / figma / magic / vfx が本セッションで接続失敗] | セッション開始時の接続エラー通知 | `docs/vendor-docs/` へ取得日つきで退避。**「MCP が落ちている」と明示し、「能力が無い」と書かない** |
| F6 | **モデル不達**（GPT） | ラッパーエージェントが `reviewer_route:"unavailable"` を返す | §8-3 の設定作業。未解消の間は Gemini 反証モードで代替し review-log に明記。**3ベンダー体制と称さない** |
| F7 | **コスト暴走** | Workflow の budget、週次コスト計測 | 既定は Sonnet。Opus は設計・裁定・ゲートのみ。スクリーニングは Gemini。レビューループ上限3周 |
| F8 | **L11 の踏み越え**（本番キーで疎通テスト） | `deny-dangerous-bash.sh` の `legal-clearance.json` 連動、`release.yml` の先頭ステップ | 本番鍵はローカルに置かず CI の `environment: production` シークレットにのみ置く |
| F9 | **レビューの形骸化** | 週次の差し戻し率、**月1回の既知バグ注入テスト** | プロンプトに「問題なしで終わらせない」を入れる。2週連続ユニーク検出ゼロで配置撤回 |
| F10 | **単一人間のボトルネック** | `WAITING_HUMAN` の滞留日数 | エスカレーションを3種類に限定（破壊的操作の直前／真のスコープ変更／本人しか出せない情報）。それ以外は AI が推奨1つを出して進める |
| F11 | **確信度「低」への依存**（未検証64件が設計前提になる） | ADR の `confidence` 欄必須 ＋ G10 | 確信度「低」に依存する決定は ADR を `proposed` 止まりにし、実装ブロッカーとして task-list に載せる |
| F12 | **ハーネスが重すぎて使われなくなる** | 週次で「ゲートの平均待ち時間」を計測 | §8-9 の順序規律。ゲートが開発を止めている実感が出たら**ゲートを外すのではなく並列化・キャッシュ・段階化で速くする**（外すのは PO 判断） |

---

## 9. テスト戦略と検証コマンド案

### 9-1. 前提の明記

**リポジトリは現在空であり（コミット0・ファイル0）、以下の npm スクリプトは1本も存在しない。** すべて `task_001`（プロジェクト初期化）で `package.json` に作成する**予定**のものである。フック・CI がこれらを呼ぶのは、スクリプトを作った後に有効化する。存在しないコマンドを先に settings.json へ書かない。

| スクリプト | 内容 |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `lint:changed` | eslint（`--max-warnings=0`） |
| `npm run test:unit` | Vitest ユニット（状態遷移の直積、`rankOf()` の exhaustive check、ラベルのスナップショット） |
| `npm run test:contract` | **重複・逆順・署名不一致の3本**（I5）。Stop フックと CI の両方で走る |
| `npm run test:conformance` | ProviderConformanceKit（§9-2）。全アダプタに対して自動で回る |
| `npm run test:integration` | supabase ローカル Postgres に実マイグレーションを流し、DB 制約が実際に効くことを検証 |
| `npm run test:e2e` | Playwright + `@line/liff-mock`（nightly / リリース前） |
| `npm run test:gate` | `test:contract` + `test:conformance`（Stop フック用の軽量束） |
| `npm run gate:constraints` | `bash scripts/gate-constraints.sh` |
| `npm run gate:wording` | `node scripts/wording-lint.mjs`（禁止語 grep） |
| `npm run gate:check` | `node scripts/gate-check.mjs`（G1〜G10） |
| `npm run gate:acceptance` | `assert-verify-commands.mjs` → `assert-acceptance.mjs` |
| `npm run db:migrate` / `db:reset:local` | Drizzle マイグレーション（`db:reset` は本番向けを作らない） |
| `npm run bench:models` | `bash scripts/bench-models.sh` |

### 9-2. ProviderConformanceKit（本設計の要。全アダプタがこれを通らなければマージ不可）

アダプタを1本書いたら、キットに `key` を登録するだけで以下が自動で回る。

| ケース | 検証内容 | 根拠 |
|---|---|---|
| C1 重複配信 | 同一 Webhook を3回投げて `ledger_entry` が1件だけ | W1/W2・引継ぎ書§7 |
| C2 順序逆転 | `succeeded` → `expired` の順で投げて `paid` が維持される | W3/W4 |
| C3 署名不一致 | 改竄した本文で 400、`webhook_delivery.sig_ok=false`（`webhookSignature !== 'none'` のアダプタのみ） | W6 |
| C4 別IDの重複 | `providerEventId` が違うが `ledgerDedupeKey` が同じイベントで台帳1件 | W2 |
| **C4b 正当な2回目の部分返金** | **同一 charge への2回目の部分返金（`ledgerDedupeKey` が異なる）が落とされず台帳に2件目として載る** | **審査員が指摘した arch-B/C の致命的バグの回帰テスト** |
| C5 金額不一致 | invoice と違う金額で `mismatch_alert`、台帳に書かれない | W8 |
| C6 孤児イベント | 未知の `externalRef` で 200 を返しつつ台帳を汚さない | — |
| C7 再照会一致 | `trust='unverified'` のアダプタで再照会と Webhook が一致すれば台帳に載る | W7 |
| C8 再照会不一致 | 再照会が Webhook と矛盾したら台帳に書かない | W7 |
| C9 能力宣言の遵守 | `capabilities.refund='none'` のアダプタが `refund` で `NotSupportedError` | P7 |
| C10 非自動ラベル | `autoDetect=false` のアダプタで消し込んだ請求が API で `autoDetected:false` を返す | §5-4 |
| **C11 取消後入金** | **`lifecycle_state='void'` の請求に `succeeded` が届いたとき、rank は paid へ前進し、void は維持され、`needs_attention=true` と `paid_after_void` アラートが立つ** | §2-1 |
| **C12 ゲート未通過** | **必須ゲートが未通過のとき `createCheckout` が `ProviderNotEnabledError` → 409 になる** | §5-2 |

**Stripe CLI（`stripe trigger` / `stripe listen`）は使わない。** Stripe を採用しない以上 PayPay/PAY.JP の Webhook 再現には使えない。キットは保存済み fixture を HTTP で自前 Route Handler に投げる形で実装し、事業者非依存にする。

### 9-3. レイヤ別の方針

- **ユニット**: アダプタの `parseWebhook` は**保存済み fixture のみ**でテストする（実 API を呼ばない）。`applyToLedger` は全遷移×全イベント種別の直積。「`paid` に `expired` が届いてもランクが下がらない」を明示的に1本。
- **統合**: `supabase start` のローカル Postgres に実マイグレーションを流す。**モックした DB では冪等性の証明にならない。** `pg_try_advisory_lock` の多重起動防止を2プロセス同時起動で検証（W11）。
- **E2E**: `liff.use(new LiffMockPlugin())` + `liff.init({mock:true})` を**環境変数で切り替え、動的 import で本番バンドルに入れない**（I4）。`vi.mock` は実ブラウザで効かない。`liff.isApiAvailable()` が false のケース（フォールバックが出ること）も必ずテストする（N8）。
- **セキュリティ**: IDOR（他人の invoice / 他人のイベント）、`joinToken` の総当たり耐性、CSRF（Webhook 以外の POST）、ゲート迂回（フラグ ON でもゲート未通過なら 409）、**ログ出力を grep して資格情報・生の userId・生IP が出ていないこと**。すべて CI 必須。
- **決済サンドボックス**: PayPay は `env:"STAGING"`（審査前から使える。確信度 中。Phase 2 着手時に最初に実地確認する）。PAY.JP はテストキー。**サンドボックスで通ったことを「本番で通る」と言わない。** Phase 2 完了条件3（実弾1件）まで完了扱いにしない。
- **テストしないと決めたこと（正直に）**: 実 PayPay 加盟店審査、実 LINE 認証審査、実際の入金着金タイミング、本番負荷。いずれも Phase 2〜3 の人間の運用確認で代替する。

---

## 10. 未決事項・問い合わせ待ちと、その間の進め方

### 10-1. 照会の優先順序（`consolidated.md` 付録の順序を維持）

| 優先 | 宛先 | 主質問 | これで決まること |
|---|---|---|---|
| 1 | **PayPay 加盟店窓口** | **Q-PP1: 飲み会・懇親会・サークル活動などの会費徴収は、PayPay オンライン決済の取扱可能商材か。「商取引ではない寄付や募金、投げ銭」に該当するか** / Q-PP2: 加盟店規約の「商品もしくは権利または提供する役務」の代価にイベント参加権の販売は含まれるか / Q-PP3: 実店舗を持たない個人事業主は申し込めるか、店舗写真の代替は何か / Q-PP5: Webhook に署名検証の仕組みはあるか・登録手順・リトライ回数・ペイロード定義 / Q-PP6: 決済詳細レスポンスに支払者識別情報は含まれるか / Q-PP7: 継続課金・支払リクエストの「法人のみ」に個人事業主は含まれるか / Q-PP8: 2026年夏の LINE×PayPay 連携で外部ミニアプリから呼べる API・ディープリンクはあるか | **候補Aの go/no-go。回答1本で第一候補が決まる** |
| 2 | **PAY.JP** | 加盟店規約本文の取得、個人間送金・立替精算の扱い、非事業者可否、手数料率、返金仕様 | 第二候補の go/no-go |
| 3 | **弁護士（資金決済法）** | Q-LG1: 「他の者に受け入れさせ」の射程 / Q-LG2: 内閣府令1条の2第3号ロ「契約の成立に不可欠な関与」 / Q-LG3: 第3号ニ（銀行等・資金移動業者からの委託）に乗る構成 / Q-LG4: 第1号を規約で外しても第3号で捕捉されるか / **Q-LG7: 運営者が幹事の決済アカウントのクレデンシャルを保管・使用する行為は「資金の受入れへの関与」と評価されるか。読み取り専用権限と資金移動指図権限の分離をどう示せば足りるか** / Q-LG9: 参加者の氏名・支払状況を幹事画面に表示する行為の第三者提供該当性と同意設計 | **本番決済の有効化の必須ゲート（L11）** |
| 4 | **LINEヤフー 審査窓口** | Q-LN1: 会費の請求・支払状況管理は禁止業種「募金、寄附、クラウドファンディング等の資金調達」に該当するか / Q-LN2: 現実世界の役務（飲食会の会費）の集金にアプリ内課金は必要か / Q-LN3: 第三者間の集金仲介は認証審査基準でどう評価されるか / Q-LN5: 未認証ミニアプリに利用者数上限はあるか / Q-LN6: プラットフォーム利用料は無料か、サービスメッセージは公式アカウントの通数にカウントされるか | Phase 1 のリリース可否（`GATE-LINE-POLICY`） |
| 5 | **Stripe**（後回し） | 日本の「Connect 外での C2C サービス」条項の定義、PayPay×Connect の記載矛盾、`paypay_payments` ケイパビリティの有無、Accounts v2 の日本・individual 対応 | 候補Bの go/no-go |
| 6 | **PayPal / 楽天銀行・電代業者** | ビジネスアカウント要否と API 資格 / 「外部サービス会社」契約基準・審査要件・リードタイム・費用 | 第三候補・Phase 3 |

**★ Q-PP4「一般個人の PayPay アカウントに届いた送金を第三者アプリが API で照会する手段はあるか」も送る。** `consolidated.md` §3-1 が「非存在の証明はできていない。サイトマップは完全な索引ではない」と訂正しているため、**「公開APIでは組めない」の根拠を列挙ではなく窓口回答に置き換える**必要がある。

**★ `GATE-CRED-CUSTODY` に対応する照会（Q-PP9 / Q-PJ4）は現在の `consolidated.md` §5 の質問群に入っていない。新規追加する。** 「加盟店の API キー／シークレットを、加盟店の委託を受けた第三者（本アプリの運営者）が保管し、加盟店のために API 呼び出しを行うことは、貴社の加盟店規約上許容されますか。許容される場合、必要な手続き・契約形態・技術要件（IP 制限、権限分離、鍵のローテーション）を教えてください。」

### 10-2. 回答が返るまでの進め方

- **Phase 1（決済非依存コア）は照会と完全に並行して進める。** アダプタ層・台帳・冪等基盤・LIFF 外殻・ハーネスは、決済事業者が変わっても捨てずに済む。
- **`resolveProvider` が `manual_confirm` 以外を返さない**ので、コードが勝手に先へ行くことは構造的に起きない。UI のボタン非表示ではなくサーバー側の 409 が正。
- **Phase 1 の間、決済事業者SDKを `package.json` に一切入れない**（CI の `deps` ジョブで `npm ls` を機械検査）。依存が存在しなければ誤って本番決済を叩けない。
- PayPay の STAGING サンドボックスは加盟店審査前から使える見込み（確信度 中）なので、Q-PP1 の回答を待つ間に `PayPayOnlineAdapter` の実装検証だけは先行できる。**ただしその成果物を `main` にマージするのは Phase 0 のゲート通過後。**
- 照会の状態は `docs/external-inquiries.json`（`draft` → `sent` → `answered` → `superseded`）で管理し、`SessionStart` フックが毎回未回答一覧を注入する。

### 10-3. 費用（すべて未確定。見積もりではない）

| 項目 | 概算 | 確信度 |
|---|---|---|
| Vercel Pro | $20/月（**必須**。Hobby は cron が1日1回・±59分） | 中 |
| Supabase | $0（Free）〜$25/月（Pro）。Tokyo リージョンの可用性・料金が未確認 | 低 |
| LINEミニアプリ プラットフォーム利用料 | **不明**（Q-LN6 で照会中。無料と仮定しない） | 低 |
| ドメイン | 年 ¥2,000 前後 | 中 |
| 弁護士照会 | **不明**（数十万円規模を想定。グレーゾーン解消制度なら費用は下がるが期間が延びる） | 低 |
| 幹事の決済手数料 | PayPay オンライン物販 3.8% / デジタル10%（未検証）、PAY.JP 不明 | 低 |
| 幹事の加盟店審査期間 | PayPay 2週間〜1カ月＋利用開始5営業日 | 低 |
| 入金タイミング | PayPay 直接契約: 月1回・月末 | 低 |

**5,000円×10人＝50,000円の集金で手数料3.8%なら1,900円が幹事負担。** 対して PayPay / Kyash の個人間送金は手数料0円。**本アプリは構造的にコスト不利**であり、この差額に見合う価値（名簿・複数イベント横断・21名以上・催促・領収記録）を提供できなければ採用されない。手数料は**参加者に上乗せしない**（P5。幹事負担または会費内包）。

---

## 11. 明示的に満たせない要件と、その扱い

**これらは設計の欠落ではなく、構造的な制約または未解決の外部依存である。実装計画にもこのまま転記し、ユーザーへの説明でも省略しない。**

### 11-1. 「幹事の個人PayPayで受け取りつつ自動チェック」は実現しない

`consolidated.md` §7-1 の3条件（参加者ごとの自動検知／受取先が個人PayPay／幹事が非事業者のまま）は同時に満たせない。本設計は条件3を落とす。**ユーザーの明示同意が Phase 0 のゲート `G0-USER`。** 同意が得られない場合は `manual_confirm` 単独構成へ縮退する。

**その縮退構成を「自動チェック要件を満たした」と説明してはならない。** §5-4 の6項目（API・画面・CSV・サマリ・文言・CI ゲート）で機械的に守る。

### 11-2. 幹事の加盟店審査が最大のプロダクト摩擦であり、設計では解けない

L1（運営者が資金に触れない）と L9（PayFac 型を採らない）を守る限り、受取人は幹事自身の決済アカウントでなければならず、**審査を代行できない**。「今夜の飲み会の幹事」が2週間〜1カ月の審査と開業届相当の書類を用意するとは考えにくい。**ターゲットを「継続的な主催者（サークル・部活・教室・コミュニティ）」に寄せない限り成立しない。** これは本設計固有の欠陥ではなく、審査に付した3案すべてが自認し、誰も解いていない問題である。**本書はアーキテクチャの設計であって、「今夜の飲み会の幹事」というプロダクト前提が成立することを示したものではない。** ここは PO（noritaka）の判断事項。

### 11-3. 代理払いを自動で追えない

決済事業者APIは支払者を返さない（`payerIdentity: null` を型で固定）。引継ぎ書 §7 の「代理払いを追える」は**幹事の手動記録でしか満たせない**。`opened_by_user_ref` は弱いシグナルにすぎず、「自動で代理払いを検知した」と表示しない（§5-5）。

### 11-4. 手数料ゼロの既存機能に構造的に負ける／2026年夏以降 LINE 本体が競合する

PayPay / Kyash / LINE内PayPay の個人間送金は手数料0円。加えて LINEヤフーは2026年7月2日、**2026年夏以降に LINE のトーク上で PayPay 残高の送金と「グループ支払い」による割り勘ができる**と発表している（確信度 低・未検証だが複数レポートで一致）。**本アプリの中核体験がプラットフォーム本体機能になる。** 残る客観的な隙間は「グループトークでは同じ金額の請求のみ対応可能」という制約だけであり、これも埋められる可能性がある。差別化は送金そのものではなく台帳側（名簿・複数イベント横断・21名以上・催促・領収記録）に置くしかなく、**それが1,900円/回の価値になるかは検証されていない。**

### 11-5. 証跡としてのスクリーンショットを扱わない

`manual_attestation.evidence_note` は自由記述のみで画像を保存しない。これは「自己申告やスクリーンショットを検証済み入金として扱わない」という引継ぎ書の指示に従った結果だが、**幹事が「証拠を残したい」と考える実務ニーズには応えていない。**

### 11-6. アダプタ層の抽象化コストを先払いしている

事業者が1社に確定するなら、`PaymentProvider` IF・`resolveProvider`・`capabilities` 分岐・ProviderConformanceKit は過剰である。**この設計が正しかったかは Phase 2 の完了条件5（2本目のアダプタ追加でコアに変更が入らないこと）でしか検証できない。** それまでは投機的な投資であり、1社確定なら1〜2週間分の実装が無駄になる。

### 11-7. 未検証の事実に依存した判断が複数ある

第一候補 PayPay の選定は「オンライン決済ルートに実店舗要件がない」（確信度 中）「サンドボックスが審査前から使える」（確信度 中）「手数料3.8%・月末入金」（確信度 低）に依存している。照会で覆れば第一候補は即座に PAY.JP へ入れ替わる。**本設計は入れ替えのコストを小さくしてはいるが、入れ替えが起きないとは言っていない。**

### 11-8. ハーネス側の未検証事項

- `PreToolUse` / `SubagentStop` / `PreCompact` の実在と exit 2 の遮断挙動が **[不明]**（§8-4）。使えなかった場合にゲート網の何割が消えるかを着手時に見積もり、CI と `Stop` へ寄せる。移せない分は「穴」として明示的に台帳化する。
- Workflow の `agent()` / `parallel()` / `pipeline()` の正確なシグネチャが **[不明]**。実装前に `workflow-authoring` スキルを読む。
- **GPT-6 Astra への経路が現在ブロックされている** [実測]。解除されるまで GPT 票は `BLOCKED` として扱い、「3ベンダー体制でレビューしている」と報告しない（§8-3）。
- 4モデルの単価・レイテンシ・コンテキスト長がすべて **[不明]**。週0の `bench-models.sh` の結果が出るまで配置は「暫定」。
- `context7` MCP が接続失敗中 [実測]。ライブラリ資料は `docs/vendor-docs/` に取得日つきで退避し、復帰後に再取得して差分を確認する（週次タスク）。

---

## 付録: 実装計画（15節）への対応表

| implementation-plan.md の節 | 本書の該当箇所 |
|---|---|
| Overview | §0, §1-1 |
| Goal | §1-1（自動チェックの達成条件）, §7 の各 Go/No-Go |
| Current State | §0-2（リポジトリ空・照会ゼロ件・未検証事項） |
| Scope | §1〜§6, §7 の Phase 1/2 |
| Non-Scope | §1-2（収納代行・Stripe 保留）, §7 Phase 3, §11 |
| Assumptions | §0-1 の4値ラベル, §10-3, §11-7 |
| Architecture Impact | §1-3, §2-3, §5-1〜5-2 |
| UI Plan | §4 |
| API Plan | §3 |
| Database Plan | §2 |
| File-by-File Plan | §6 |
| Implementation Order | §7, §8-9（ハーネス先行の順序規律） |
| Verification Commands | §9-1（**現時点で1本も存在しないことを明記**） |
| Acceptance Criteria | §7 の各 Go/No-Go, §9-2 の C1〜C12, §5-4 の6項目 |
| Repair Loop | §8-5 の task-loop（最大3周）, §8-7 の G1〜G10, §8-10 |
