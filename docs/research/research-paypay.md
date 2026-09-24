# PayPay 一次資料調査レポート

調査日: 2026-09-24 / 調査範囲: 公開されている一次資料（PayPay公式ドキュメント・規約、LINEヤフー公式リリース、LINE Developers公式ドキュメント、e-Gov法令、金融庁事務ガイドライン）のみ。
すべての evidence URL は本調査で実際にフェッチしたもの。フェッチできなかったURLは「未確認事項」に回した。

---

## 結論

**一般個人のPayPayアカウントに届く個人間送金を第三者アプリが自動検知する公開APIは、公開範囲では存在しない。** PayPay for Developers が公開している全プロダクトは加盟店決済（webpayment / qrcode / appinvoke / nativepayment / continuouspayment / preauthcapture / pendingpayment / smartpayment / miniapp）のみで、公式サイトマップ・公式SDKのどちらにも個人間送金の受領・照会APIは存在しない。したがって引継ぎ書 §4-1 の「確認できていない」という留保は正しく、より強く「公開範囲には存在しない」と言える。

**自動チェック要件を満たすには、幹事を PayPay 加盟店にするしかない。** 加盟店決済であれば `GET /v2/codes/payments/{merchantPaymentId}` による照会と Webhook（COMPLETED 等）で参加者ごとの支払いを確実に照合できる。ただし PayPay の加盟店申込は「実店舗のある法人様・個人事業主様」が対象で、事業をしていない一般個人の幹事は加盟店になれない。つまり **「受取先を個人PayPayにする」と「自動チェックする」は、PayPayの公開仕様では両立しない。**

**さらに重い制約が法令側にある。** アプリ運営者が参加者から資金を預かって個人の幹事に渡す構造（収納代行型）は、資金決済法第2条の2第1号と資金移動業者に関する内閣府令第1条の2により、受取人が非事業の個人である限り原則として「為替取引」に該当し、資金移動業の登録が必要になる。**運営者は資金の流れに一切触れてはならない**（＝資金は参加者→幹事へ決済事業者内で直接完結させ、アプリは名簿と照合だけを行う）というのが設計の絶対条件。

**LINEミニアプリ配布については、LINE側にPayPay決済は提供されていない。** LINE Pay は2025年4月30日に国内サービス終了、LINEミニアプリの公式決済手段は「アプリ内課金（デジタルコンテンツ向け・ストア課金）」のみで、それ以外は外部ドメインでのWeb決済実装になる。ただし2026年7月2日のLINEヤフー公式発表により、2026年夏以降 LINE と PayPay のアカウント連携が始まり、LINEトーク上での PayPay 残高送金・グループ支払い、および LINEミニアプリ版 PayPay が提供される。これは競合機能が公式に統合されることを意味し、本アプリの差別化の前提が変わる。

**手数料はオンラインと実店舗で大きく違う。** PayPay for Developers 直接契約のオンライン決済は物販3.8%／デジタルコンテンツ10%、入金は月末締め月1回。実店舗の1.60%／1.98%（＋早期振込0.38%）とは別物なので混同しないこと。

---

## 問いごとの回答

### Q1. 個人PayPayへの送金を第三者アプリが検知・照合できる公開API/Webhook/通知連携は存在するか

**結論: 公開範囲では存在しない。**

PayPay for Developers の公式サイトマップ（`https://developer.paypay.ne.jp/sitemap.xml`、curl で取得）に列挙されているページは以下が全てである。

```
https://developer.paypay.ne.jp
https://developer.paypay.ne.jp/products/docs
https://developer.paypay.ne.jp/products/docs/smartpayment
https://developer.paypay.ne.jp/products/docs/webpayment
https://developer.paypay.ne.jp/products/docs/qrcode
https://developer.paypay.ne.jp/products/docs/appinvoke
https://developer.paypay.ne.jp/products/docs/nativepayment
https://developer.paypay.ne.jp/products/docs/continuouspayment
https://developer.paypay.ne.jp/products/docs/preauthcapture
https://developer.paypay.ne.jp/products/docs/pendingpayment
https://developer.paypay.ne.jp/miniapp/docs
https://developer.paypay.ne.jp/webinar
https://developer.paypay.ne.jp/account/signin
https://developer.paypay.ne.jp/account/signup
```

すべて加盟店（マーチャント）向け決済プロダクトであり、個人間送金（P2P）・送金リクエスト・グループ支払いに対応するプロダクトページは1つも存在しない。

PayPay公式の Node SDK（`github.com/paypay/paypayopa-sdk-node`）に実装されているAPIも、QRコード決済系（QRCodeCreate / GetCodePaymentDetails / QRCodeDelete / PaymentCancel / PaymentRefund / GetRefundDetails / PaymentAuthCapture / PaymentAuthRevert）とネイティブペイメント系（AccountLinkQRCodeCreate / ValidateJWT / unlinkUser / CreatePayment / GetPaymentDetails）に限られ、個人間送金に関するメソッドは含まれない。

また、加盟店向けドキュメント（`https://www.paypay.ne.jp/opa/doc/v1.0/appinvoke`）は対象読者を「payment partners」「onboarded as a PayPay OPA client」と定義しており、一般個人が利用する記述はない。

→ 引継ぎ書 §4-1 は正しい。「PayPayへのリンクを開くこと」と「支払い完了をアプリが検証できること」は別問題という指摘もそのまま維持される。

### Q2. PayPay for Developers で使える決済方式・状態照会・Webhook・サンドボックス

**決済方式（公式サイトマップより）:** Web Payment、Dynamic QR Code（動的ユーザスキャン）、App Invoke、Native Payment、Continuous Payments、PreAuth & Capture、Pending Payment、Smart Payment、ミニアプリ。

**主要エンドポイント**（`https://www.paypay.ne.jp/opa/doc/v1.0/dynamicqrcode` より原文引用）:

- `POST /v2/codes` — コード（QR/決済リンク）作成
- `GET /v2/codes/payments/{merchantPaymentId}` — **決済状態照会（Get Payment Details）**
- `DELETE /v2/codes/{codeId}` / `DELETE /v2/payments/{merchantPaymentId}`
- `POST /v2/payments/capture` / `POST /v2/payments/preauthorize/revert` / `POST /v2/payments/reauthorize`
- `POST /v2/refunds` / `GET /v2/refunds/{merchantRefundId}?paymentId={paymentId}`

**サーバーURL（原文引用）:**
- Production: `https://apigw.paypay.ne.jp`
- Staging: `https://apigw.stg.paypay.ne.jp`
- Sandbox: `https://apigw.sandbox.paypay.ne.jp`

**Webhook（日本語版 `https://www.paypay.ne.jp/opa/doc/jp/v1.0/dynamicqrcode` より）:** 通知には `notification_type` フィールドが必ず含まれる。トランザクション通知の種類は `AUTHORIZED`（Create / Update）、`COMPLETED`、`CANCELED`、`EXPIRED`、`EXPIRED_USER_CONFIRMATION`、`FAILED`。別に `"notification_type":"file.created"`（突合ファイル生成通知）がある。正常終了時は「200 OKのHTTPステータスコードを返してください」。セキュリティは署名検証ではなく「PayPay IPアドレスのホワイトリスト登録を強く推奨」という方式（ドキュメントに署名検証の記載なし）。

**リダイレクト非依存の設計が公式推奨:** App Invoke ドキュメントに `"If there is no redirect from PayPay, please use Get Payment Details to check"`、Web Cashier 日本語版に「Get payment detailsを用いて決済結果を確認する様、お願いいたします。」とある。ポーリング間隔は「The polling interval should be about 2 to 3 seconds」。

**サンドボックス:** 2020年9月1日付の開発者向けお知らせ「PayPayアプリのsandbox環境を公開しました。PayPay for Developersご利用の皆様は、ダッシュボードに記載のテストユーザアカウントを利用して、PayPayアプリの開発者モードがご利用いただけます。」— つまり加盟店審査前にAPI検証を進められる。

**突合ファイル:** `transaction_*.csv`（即時決済）と `preauth_transaction_*.csv`（与信フロー）が毎日 1:30〜10:00 JST に配信される。Webhook取りこぼし時の照合手段として使える。

### Q3. 加盟店の申込資格（法人／個人事業主／一般個人）・必要書類・審査期間

**一般個人（非事業者）は申込不可。** PayPay加盟店FAQ（`https://paypay.ne.jp/store/faq/`）に「実店舗のある法人様・個人事業主様であれば、どなたでもお申込みいただけます」とあり、事業をしていない一般個人についての記載はない。PayPay加盟店規約（`https://about.paypay.ne.jp/terms/merchant/rule/store/`、現行版 2026年7月31日最終改定）第1条でも「加盟店」は「本規約を承認のうえ、PayPayの利用を申し込み、当社がこれを承諾した者」とされ、事業者であることが前提となっている。

**必要書類（`https://paypay.ne.jp/store/introduction/` 原文引用）:**
- 個人事業主: 本人確認書類1点（「運転免許証」「在留カードおよび特別永住者証明書」「個人番号カード（マイナンバーカード）」「日本国パスポート＋住所確認書類」「各種資格確認書＋住所確認書類」）、住所確認書類1点（発行から6カ月以内。「公共料金領収書（電気・ガス・水道など）」「住民票記載事項証明書」「住民票写し」）
- 法人: 本人確認書類1点＋「法人番号（法人登録した際に発行された番号13桁）」
- 共通: 「店舗の『外観』・『内観』写真（合計2枚）」

**開業届は公式の必要書類リストに載っていない。** 二次記事には「開業届が必要／不要」の記述が散見されるが、公式ページに開業届への言及はない。「開業届が必須」と設計前提に置かない。

**審査期間:**
- 実店舗: FAQ「審査は、1〜2週間程度のお時間をいただいております」／導入の流れ「審査完了から1週間程度でご利用いただけます」
- **オンライン決済**（`https://paypay.ne.jp/store-online/`）: 「申込内容に不備がなければ、2週間～1カ月ほどで審査結果がPayPayより通知されます。審査通過後、システムの都合上、利用開始まで5営業日ほどお待ちいただく」

**入金口座の名義制約:** PayPay重要事項説明書（オンライン版）に「売上金の受け取り先金融機関口座の口座名義は、PayPay加盟店の企業名（個人事業主の場合は代表者名義）と原則同一である必要がございます」。幹事が代理で他人の口座に受け取ることはできない。

### Q4. 加盟店手数料と入金サイクル

**オンライン決済（PayPay for Developers 直接契約）** — `https://paypay.ne.jp/store-online/`
- 物販: **3.8%**
- デジタルコンテンツ: **10%**
- 「無償SDKの為、固定費、運用費等はかかりません。発生する費用は決済が行われた際の決済手数料のみです。」
- 入金: 「売上金の入金サイクルは月末入金（月１回）となります。」

**実店舗** — `https://paypay.ne.jp/help-merchant/b0544/` および `https://paypay.ne.jp/store/cost/`
- PayPay・HIVEX: ライトプラン契約中 **1.60%** ／ 未契約 **1.98%**（税別）
- Alipay+: 1.98% ／ JPQR: 2.95%
- 入金: 月末締め最短翌日入金、月1回なら振込手数料「無料」
- 早期振込サービス: 「売上金額の0.38%」＋振込手数料（PayPay銀行20円／その他200円）。都度振込は申し込み不要、自動振込は申し込み要。
- PayPayマイストア ライトプラン: 初期1,980円／月額1,980円

**注意:** 決済システム利用料率ヘルプ（`https://paypay.ne.jp/help-merchant/b0054/`）は実店舗の料率しか記載していない。オンラインの3.8%/10%と実店舗の1.60%/1.98%を混同すると見積もりが2倍以上ずれる。

**規約上の手数料転嫁禁止:** PayPay加盟店規約（オンライン決済用）第4条第3項は加盟店に対し「PayPayを利用するPayPayユーザーに対し、商品等代金以外の金銭の支払いを請求すること」を禁止している。参加者に決済手数料を上乗せ請求する設計は規約抵触のおそれがあるため、手数料は幹事負担か会費に内包する設計にする。

### Q5. 送金リンク／請求／グループ支払いの仕様と、ディープリンクでの金額指定

**送金（`https://paypay.ne.jp/guide/send/`、`https://paypay.ne.jp/promo/p2p/`）:** 「手数料無料で1円単位で送ることができます」「何度でも手数料無料」。送金方法はQRコード読み取り、携帯電話番号／PayPay ID、SNS・メール経由の受け取りリンク、LINEトークルームから。送金上限は本人確認未完了で1回10万円、本人確認完了で「最大30万円まで引き上げることができます」。銀行口座への送金は PayPayマネー のみで本人確認必須。請求機能も本人確認必須。

**受け取りリンク（`https://paypay.ne.jp/help/c0189/`）:** 「受け取りリンクの有効期限は作成から4日（96時間）です。有効期限が切れると自動的に自分の残高に戻ります。」金額は送信者が作成時に確定し、受取人は金額を変更できない。パスコードは送信者が設定でき、3回間違うと辞退扱いとなり残高が戻る。**このリンクは「送る側」がアプリ内で作るもので、第三者が受取人宛に金額指定で発行する仕組みではない。**

**グループ支払い（`https://paypay.ne.jp/help/c0224/`）:** 「一つのグループに参加できる人数は20名までです」。グループ作成者は他メンバーを削除できる。金額は均等でも個別でも設定可能で、メンバーに通知が届く。**PayPayアプリ内で完結する機能で、外部アプリ・APIから作成・参照する手段の記載はない。**

**ディープリンク:** 公開されているディープリンクは加盟店APIが発行するものだけ。`POST /v2/codes` のレスポンスに `url`（Web link）と `deeplink`（PayPayアプリ起動用）が含まれ、リクエストで `redirectUrl` と `redirectType`（`WEB_LINK` / `APP_DEEP_LINK` / `WEBVIEW_IN_PAYPAY`）を指定できる。**個人間送金の画面を金額指定で開くURLスキームは、公式には公開されていない。**

### Q6. LINEアプリとPayPayの連携（2025〜2026）

**LINE Pay は国内サービス終了済み。** LINE Developers 公式（`https://developers.line.biz/ja/docs/line-mini-app/develop/payment/`）に「2025年4月30日をもって、日本国内におけるLINE Payのサービスを終了しました。」台湾・タイでは継続。LINEミニアプリで使える公式決済は「アプリ内課金」（デジタルコンテンツ向け、App Store / Google Play 課金、日本のみ）で、それ以外は「外部のドメインや外部のアプリで決済を完了した後、ユーザーがLINEミニアプリのページに戻るようにしてください。」という一般的なWeb決済実装になる。**同ドキュメントに PayPay への言及はない。**

**2026年夏以降、LINEとPayPayがアカウント連携。** LINEヤフー株式会社 公式ニュースリリース（2026年7月2日発表、`https://www.lycorp.co.jp/ja/news/release/020581/`）:
- 「「LINE」のトーク上で「PayPay残高」の送金…や「グループ支払い」の機能による割り勘が利用できるようになります」
- LINEミニアプリ版PayPayを提供予定（残高確認、送受金、取引履歴、ATMチャージ等。決済・ポイント管理機能は除く）
- PayPayアプリ上でLINEの友だちを表示し、電話番号やPayPay IDを知らなくても送受金できる
- LINEポイントはPayPayポイントへ統合

→ **本アプリが狙う「LINE上で会費を割り勘集金する」という体験は、2026年夏以降 LINE 公式機能として提供される。** 引継ぎ書 §8 の「PayPayに勝てない等は検証済み市場分析ではない」という留保は妥当だが、少なくとも「LINE×PayPayのグループ支払い」が公式に存在することは確定事実として設計に織り込む必要がある。

---

## 法令面（決定に直結するため追加調査）

### 資金決済法 第2条の2（e-Gov法令API で取得、令和8年8月12日施行版）

> 金銭債権を有する者（以下この条において「受取人」という。）からの委託…その他これらに類する方法により、当該金銭債権に係る債務者又は当該債務者からの委託…その他これに類する方法により支払を行う者（以下この条において「債務者等」という。）から弁済として資金を受け入れ、又は他の者に受け入れさせ、当該受取人又は…受取人等…に当該資金を引き渡すことによって、債務者等から受取人等に当該資金を移動させる行為…であって、次の各号のいずれかに該当するものは、為替取引に該当するものとする。
>
> 一　受取人が個人（事業として又は事業のために受取人となる場合におけるものを除く。）であることその他の内閣府令で定める要件を満たす行為（次号に該当する行為を除く。）

### 資金移動業者に関する内閣府令 第1条の2（同API、2026年6月1日施行版）

> 法第二条の二第一号に規定する内閣府令で定める要件は、受取人…が個人（事業として又は事業のために受取人となる場合におけるものを除く。）であり、かつ、次に掲げる要件のいずれかに該当することとする。

第3号は「次に掲げる要件のいずれにも該当すること」として、イ（エスクロー型でないこと）、ロ（契約成立に不可欠な関与をするプラットフォーム型でないこと）、ハ（他者からの委託による再受託でないこと）、ニ（銀行等・資金移動業者からの委託でないこと）を列挙する。**つまり、エスクローでもプラットフォーム型でも再受託でもない素朴な収納代行で、受取人が非事業の個人であるものは、為替取引に該当する。**

### 資金決済法 第37条

> 内閣総理大臣の登録を受けた者は、銀行法第四条第一項及び第四十七条第一項の規定にかかわらず、資金移動業を営むことができる。

### 金融庁 事務ガイドライン（第三分冊：金融会社関係 14 資金移動業者関係）

Ⅰ－２－１（法第2条の2の位置づけ）に「事業者の行為が為替取引に該当するかは、その事業者が行う取引内容等に応じ、最終的には個別具体的に判断することに留意する。」とあり、形式的な当てはめだけでは判断が確定しないことが明示されている。また Ⅰ－２－２－２(1) に「単に銀行等に開設した預金口座や資金移動業者に開設したアカウントに対して債務者等に送金させるのみである場合には同号に該当しないことに留意する。」とある。

**設計への直結:** 「参加者に、幹事のPayPay（＝資金移動業者のアカウント）宛に直接送金させるだけ」で、アプリ運営者が資金を一切受け入れない構造であれば、運営者は為替取引を行っていない。逆に、運営者が参加者から資金を集めて個人の幹事に渡す設計は資金移動業登録が必要になる可能性が高い。**アプリは資金に触れない。これが本プロジェクトの設計制約の第一条。**

---

## 未確認事項

1. `https://developer.paypay.ne.jp/products/docs` および各プロダクト詳細ページは完全なJavaScriptレンダリングで、WebFetch・curl のいずれでも本文が取得できなかった（返るのはタイトル「PayPay for Developers」のみ）。プロダクト一覧は公式サイトマップから確定させたが、各プロダクトの細部（Smart Payment / Pending Payment の仕様）は未確認。
2. PayPay Developers FAQ（`https://integration.paypay.ne.jp/hc/ja`）は HTTP 403 で取得できず。サンドボックスのテストユーザー数・チャージ上限（二次情報では「3ユーザー・月10万円」）は一次資料で未確認。
3. 会費・参加費が PayPay オンライン加盟店の取扱可能商材に該当するかは未確認。`https://paypay.ne.jp/store-online/` に「商取引ではない寄付や募金、投げ銭（チップ）など一部NG商材もございます」とあるが、飲み会の会費徴収がこれに当たるかの公式見解は見つからなかった。**PayPayへの直接確認が必要。**
4. PayPay加盟店ガイドライン（オンライン）は「制定：2019年4月8日／改定：2019年5月31日」という古い日付が表示され、最新版かどうか確証が持てない。禁止商材リストに寄付・投げ銭・会費の記載はなかった。
5. LINE Developers の未認証ミニアプリ仕様ページ（個人が公開できるか）は HTTP 403 で取得できず。二次情報では「日本・台湾・タイの個人でも公開できる」とされるが一次資料未確認。
6. LINEミニアプリ版PayPayが外部ミニアプリから呼び出せるAPIを提供するかは、2026年7月2日のリリース時点では言及がなく未確認。
7. PayPayミニアプリ（PayPayアプリ内のミニアプリ）の申込要件詳細。加盟店規約（ミニアプリ用）から「決済可能な加盟店はまずPayPayオンライン加盟店の承認とAPI認証情報の取得が必要」という構造は確認したが、原文の逐語引用までは取得できていない。
8. 資金決済法の当てはめは最終的に個別判断であり、本レポートは弁護士の意見ではない。実装前に金融庁・弁護士への確認を推奨する。

---

## 本アプリ設計への含意

1. **「幹事の個人PayPayで受け取る＋自動チェック」は、PayPayの公開仕様では成立しない。** 二者択一になる。(a) 自動チェックを取るなら幹事は個人事業主/法人として PayPay オンライン加盟店になる（審査2週間〜1カ月＋5営業日、手数料3.8%）。(b) 個人PayPayを維持するなら自動検知は諦め、「アプリは名簿と金額の管理＋PayPay送金への導線、確認は幹事の手動」になる。要件定義の中心だった「自動チェック」を落とすことになるので、ユーザーの判断が必要。
2. **アプリ運営者は資金の流れに絶対に入らない。** 参加者→幹事の直接決済に限定する。運営者が資金をプールして幹事に払い出す設計は資金移動業登録（第37条）が要る。これは MVP で選べる選択肢ではない。
3. **決済事業者の第一候補は「PayPay加盟店API」ではなく、幹事の事業者性の有無で分岐する。** 幹事が事業者なら PayPay for Developers は有力（Webhook＋Get Payment Details＋突合CSVの3層で照合できる）。幹事が一般個人なら、PayPayにもStripeにも適合する道はなく、「決済を伴わない集金支援アプリ」に縮退させるのが誠実。
4. **手数料は参加者に転嫁できない。** 加盟店規約第4条第3項により「商品等代金以外の金銭の支払いを請求すること」は禁止。3.8%は幹事負担か会費内包。10人×5,000円=50,000円なら幹事の手取りは約48,100円（3.8%の場合）。引継ぎ書 §4-5 の「そのまま入るとは決めつけない」は正しい。
5. **入金は月1回（オンライン）。** 「決済完了」と「幹事への入金完了」が最大1カ月ずれる。飲み会当日に幹事が立て替える構造は解消されない。これはユーザー体験上の重大な弱点なので、企画段階で明示する。
6. **照合の実装は Webhook 単独に依存しない。** 署名検証の仕組みがドキュメントに無く、IPホワイトリスト方式である以上、Webhook は補助にして `GET /v2/codes/payments/{merchantPaymentId}` による能動照会を正とし、日次の突合CSVで最終確認する三層構成にする。`merchantPaymentId` に「イベントID＋参加者ID」を埋め込めば参加者との紐付けは確実に取れる。
7. **LINEミニアプリ配布には PayPay 決済は標準で載らない。** LINEミニアプリ内から外部Webへ遷移して PayPay 決済を行い、戻ってくる実装になる（LINE公式ドキュメントが想定している形）。さらに2026年夏以降は LINE 内に公式の PayPay 送金・グループ支払いが載るため、本アプリの存在価値は「決済導線」ではなく「名簿・イベント・履歴の管理」に置く必要がある。
8. **サンドボックスは加盟店審査前に使える。** 審査で1カ月待つ間に API 実装と検証を先行できる。これはスケジュール設計上の好材料。

---

## 参照URL一覧（すべて本調査で実際にフェッチしたもの）

### PayPay 開発者向け
- https://developer.paypay.ne.jp/sitemap.xml （curl 取得。全プロダクト一覧の根拠）
- https://www.paypay.ne.jp/opa/doc/v1.0/dynamicqrcode
- https://www.paypay.ne.jp/opa/doc/jp/v1.0/dynamicqrcode
- https://www.paypay.ne.jp/opa/doc/v1.0/webcashier
- https://www.paypay.ne.jp/opa/doc/jp/v1.0/webcashier
- https://www.paypay.ne.jp/opa/doc/v1.0/appinvoke
- https://github.com/paypay/paypayopa-sdk-node
- https://paypay.ne.jp/notice-developers/20200901/paypaysandbox/

### PayPay 加盟店・料金
- https://paypay.ne.jp/store-online/
- https://paypay.ne.jp/store/introduction/
- https://paypay.ne.jp/store/faq/
- https://paypay.ne.jp/store/cost/
- https://paypay.ne.jp/help-merchant/b0544/
- https://paypay.ne.jp/help-merchant/b0054/

### PayPay 規約
- https://about.paypay.ne.jp/terms/merchant/rule/store/
- https://about.paypay.ne.jp/terms/merchant-online/rule/online/
- https://about.paypay.ne.jp/terms/merchant-online/rule/miniapp/
- https://about.paypay.ne.jp/terms/merchant-online/guideline/online/
- https://about.paypay.ne.jp/docs/terms/paypay-online-important/

### PayPay ユーザー向け機能
- https://paypay.ne.jp/guide/send/
- https://paypay.ne.jp/promo/p2p/
- https://paypay.ne.jp/help/c0189/
- https://paypay.ne.jp/help/c0224/

### LINE
- https://www.lycorp.co.jp/ja/news/release/020581/
- https://developers.line.biz/ja/docs/line-mini-app/develop/payment/index.html.md

### 法令・官公庁
- https://laws.e-gov.go.jp/api/2/law_data/421AC0000000059 （資金決済に関する法律、第2条の2・第37条）
- https://laws.e-gov.go.jp/api/2/law_data/422M60000002004 （資金移動業者に関する内閣府令、第1条の2）
- https://www.fsa.go.jp/common/law/guide/kaisya/14.pdf （金融庁 事務ガイドライン 第三分冊14 資金移動業者関係）

### 取得できなかったURL（引用していない）
- https://developer.paypay.ne.jp/products/docs および配下の各プロダクトページ（JSレンダリングのため本文取得不可）
- https://integration.paypay.ne.jp/hc/ja （HTTP 403）
- https://developers.line.biz/ja/docs/line-mini-app/discover/unverified-mini-apps/ （HTTP 403）
- https://paypay.ne.jp/help-online-merchant/B0005/ （HTTP 404）
