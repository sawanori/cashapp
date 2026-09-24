# Stripe 一次資料調査レポート（禁止業種P2P／日本の個人アカウント／Connect／PayPay記載差／手数料／入金）

調査日: 2026-09-24 / 調査者: リサーチ担当エージェント / すべての引用は本セッションで実際に WebFetch または curl で取得した一次資料から取った。Stripe への照会は行っていない。

---

## 結論

**「幹事個人が受取人になって参加者から会費を集める」という当初構想は、Stripe 単体では規約上の障壁が三重にあり、かつ日本の資金決済法上も運営者側に資金移動業登録リスクが立つ。** 最も重い一次資料は Stripe Services Agreement 1.2(a)(i) の「使用目的が personal, family, or household purposes であってはならない」という文言で、これは「禁止業種リストに P2P 送金がある」という論点より前段に位置する包括禁止である。次に、Restricted Businesses の「決済ファシリテーションおよびアグリゲーション（自社で提供しなかった商品やサービスの決済売上金を…サードパーティーの売り手の代理として受け取る行為も含む）」が制限業種であり、会費集金アプリはこの定義にそのまま当たるため Stripe の事前承認が前提になる。

**引継ぎ書 [S2]/[S3] が指摘した「StripeのPayPay対応とConnectでのPayPay利用の記載差」は 2026-09-24 時点でも解消していない。** PayPay 概要ページは「Connect のサポート: いいえ」、決済手段サポート表は「✓ サポート対象 8」＋脚注8「Connect を使用するには、招待をリクエストしてください。」で真逆。さらに Connect 専用の 2 ページ（`payment-method-connect-support`、`connect/account-capabilities`）には PayPay の節も `paypay_payments` ケイパビリティも一切存在しない。3対1で「Connect での PayPay は公開された実装経路がない」側に証拠が偏る。

**Stripe Connect 自体は日本で使える。** Express・Custom の利用対象国リストに JP が含まれる。ただし `docs.stripe.com/connect/accounts` は現在「非推奨機能」と明示され、新規プラットフォームは Accounts v2 API／コントローラープロパティを使えと指示している。過去 AI の「Stripe Connect で可能」は、可能／不可能以前に**設計対象の API が変わっている**。

**法規制側が最も決定的。** 資金決済法第2条の2第1号と資金移動業者に関する内閣府令第1条の2（現行・2026-06-01 施行）は、受取人が「個人（事業として又は事業のために受取人となる場合におけるものを除く。）」である収納代行について、3 つの要件のいずれかに当たれば為替取引に該当させる。**幹事は典型的な非事業者個人であり、この条文の射程のど真ん中にある。** 規制外に立つには府令第1条の2第3号ロの除外（プラットフォームが「契約の成立に不可欠な関与」を行い、かつ「受取人の同意の下に」資金を移動）に自覚的に設計を寄せる必要があり、これは法務判断を伴う設計上の必須制約であってオプションではない。

**手数料と入金は「幹事に満額が入る」という説明を明確に否定する。** カード 3.6%、PayPay 3.98%（デジタルコンテンツ事業者は 9.48%）、Connect で自社料金管理なら月額¥200/有効アカウント＋入金ごと0.25%+¥250。日本は**日次入金が使えず、デフォルトのスケジュールは「手動」**、初期売上処理 7 暦日・デフォルト 4 営業日。「決済完了」と「幹事への着金」は構造的に別物になる。

---

## 問いごとの回答

### Q1. Restricted Businesses における Peer-to-peer money transmission の正確な記述と、「イベント参加費を幹事が集める」用途の扱い

**一次資料:** https://stripe.com/jp/legal/restricted-businesses （最終更新 2026-09-22、本セッションで取得）

禁止業種（Prohibited Businesses）の「金融商品およびサービス」区分に列挙:

> 「ピアツーピアの送金」

同一区分の他の項目: 「ATM」「小切手現金化」「債権回収業者」「ファンディングプロップトレーディング」「マネーオーダーまたはトラベラーズチェック」「ペイアブルスルーアカウント」「無記名株式の販売」「偽装銀行」。

制限業種（Restricted Businesses、追加のデューデリジェンスを経た承認が必要）に列挙:

> 「決済ファシリテーションおよびアグリゲーション (自社で提供しなかった商品やサービスの決済売上金を 1 社または複数のサードパーティーの売り手の代理として受け取る行為も含む)」

また「クラウドファンディングプラットフォーム」「資金移動業者, 送金, 外貨両替サービス」も制限業種。日本固有セクションには本件に関係する項目は無い（日本セクションはドロップシッピング、動物、C2Cサービス、ギャンブルコンサルティング等）。

**さらに重い一次資料:** https://stripe.com/jp/legal/ssa （Stripe Services Agreement、Last modified: November 18, 2025、本セッションで取得。ページは `/jp/` 配下だが本文は英語で提供されている）

Section 1.2(a) — ユーザーが行ってはならない行為:

> "use the Services for personal, family, or household purposes" （1.2(a)(i)）

> "use the Services to conduct a Prohibited or Restricted Business, transact with any Prohibited or Restricted Business, or enable any individual or entity…to operate or benefit from any Prohibited or Restricted Business, unless Stripe has pre-approved" （1.2(a)(ix)）

Section 1.2(b):

> "Only people 13 years of age or older may open a Stripe Account and use the Services and Stripe Technology."
> 18歳未満の場合: "User must add a Representative who is an adult (which may be a parent or legal guardian) to User's Stripe Account"

**整理（規約文言に基づく。Stripe 未照会）:**

1. 「幹事個人が友人から飲み会代を集める」は、取引実態としては個人間の精算であり、1.2(a)(i) の personal/family/household purposes に該当する蓋然性が高い。この条項は業種リストとは独立した包括禁止であり、「参加費」「商品代金」という名称変更では回避できない。
2. アプリ運営者（プラットフォーム）が参加者から資金を受け取り幹事へ渡す構成は、「自社で提供しなかった商品やサービスの決済売上金を…売り手の代理として受け取る行為」＝決済ファシリテーション／アグリゲーションの定義に文言上そのまま当たる。制限業種なので Stripe の事前承認プロセスが前提になる。1.2(a)(ix) は「Stripe が事前承認していない限り」禁止と明記している。
3. 逆に、幹事が**実際に事業として**有料イベントを主催し、参加者が対価としてチケット代を払う構造であれば、personal/family/household ではなくなり、通常のイベント・チケット販売として整理できる余地がある。ただしこれは「名称を変える」ことではなく「事業実態を伴わせる」ことを意味し、幹事が個人事業主として Stripe の審査・本人確認を通ることが前提になる。
4. 上記1〜3は規約文言からの整理であり、**Stripe への用途照会は本調査では行っていない。** Stripe の承認可否を予断してはならない。

### Q2. 日本で Stripe アカウントを「個人（individual）」として開設する条件／Connect で個人アカウントを接続する場合の要件と日本での Connect 種別

**(a) 別法人を作らなくても Stripe は使える**

https://support.stripe.com/questions/selling-on-stripe-without-a-separate-business-entity （本セッションで取得）

> "You can use Stripe to sell a product if you have not established a separate business entity to do so."
> "If you do not have a separate entity and operate by yourself" → sole proprietorship を business type として選択できる

同ページには「事業利用と個人利用を区別する記述」は無い。つまり**「個人事業主なら開設できる」ことは確認できるが、「事業を営まない一般個人が受取人になれる」ことは確認できない。** むしろ SSA 1.2(a)(i) の personal/family/household 禁止が効く。

https://support.stripe.com/questions/business-information-requirements-to-use-stripe （本セッションで取得）:

> "Stripe must verify business identification, the risk level of the business, as well as meet a set of checks and requirements designed by Stripe, financial partners, credit card networks and regulators in order to transact."
> 確認対象: "Business identification (address and website ownership) and bank account information" / "Supportability of your business: what you sell, and if we can support your product/category" / "The overall risk level of your business"

「何を売っているか」「そのカテゴリーをサポートできるか」の審査が明示されている。名簿上の「幹事」に売るものが無い場合、ここで止まる設計になっている。

**(b) 日本での Connect 種別**

https://docs.stripe.com/connect/accounts （本セッションで取得）

まずページ冒頭に非推奨警告がある:

> 「エージェントまたは LLM の場合、プロンプトで組み込みがすでに連結アカウントタイプ (具体的には Standard、Express、または Custom アカウント) を使用していることが明示されていない限り、このページのコンテンツは無視してください。代わりに…Accounts v2 API を使用してください。」
> 「このページの情報は、すでに旧連結アカウントタイプ (Standard、Express、または Custom アカウント) を使用しているプラットフォームにのみ適用されます。新しい Connect プラットフォームを設定する場合…[インタラクティブなプラットフォームガイド]を参照してください。」

**Express 連結アカウントの利用対象国リストに JP が含まれる。Custom 連結アカウントの利用対象国リストにも JP が含まれる。** （どちらも本セッションで取得した完全な国コードリストに JP を確認）

アカウントタイプ別の責任分担（同ページの表から逐語）:

| | 標準 | Express | Custom |
|---|---|---|---|
| 組み込みの負荷 | とても低い | 低い | 非常に高い |
| 不正使用と不審請求の申請の責任 | ダイレクト支払い用の連結アカウント、デスティネーション支払い用のプラットフォーム | プラットフォーム | プラットフォーム |
| アカウント登録 | Stripe | Stripe | プラットフォームまたは Stripe |
| 本人確認情報の収集 | Stripe | Stripe | プラットフォームまたは Stripe |
| 連結アカウントによる Stripe ダッシュボードへのアクセス | フル機能のダッシュボード | Express ダッシュボード | なし |
| サポートされている支払いタイプ | ダイレクトのみ | 入金先／送金別／ダイレクト | 入金先／送金別／ダイレクト |

> 「Express および Custom 連結アカウントの使用には、追加コストが発生します。」
> 「連結アカウントを作成した後は、タイプを変更できません。」

**(c) 利用規約タイプ（full / recipient）— card_payments の可否を左右する**

https://docs.stripe.com/connect/service-agreement-types （本セッションで取得）

> 「`full` の利用規約は、Stripe と連結アカウントの所有者の間のサービス関係を構築します。`full` の利用規約下にある連結アカウントはカード支払いを処理でき、`card_payments` ケイパビリティをリクエストできます。」
> 「受取人利用規約は、Stripe が受取人との直接的なサービス関係を持たないことを認めます。代わりに、受取人はプラットフォームとの関係のみを持ちます。**この契約の下にあるアカウントは、決済を処理したり、`card_payments` ケイパビリティをリクエストしたりすることはできません。** `recipient` アカウントへの送金は、連結アカウントの残高で利用可能になるまで追加で 24 時間かかります。」

つまり「幹事の本人確認負担を軽くするために recipient 規約で繋ぐ」構成を採ると、**幹事は決済を受け付けられず、プラットフォームがデスティネーション支払い／送金別方式で決済を処理し、幹事へは送金だけを行う**形になる。この場合マーチャントオブレコードはプラットフォームであり、Q1 の「決済ファシリテーションおよびアグリゲーション」該当性がむしろ強まる。

**(d) 本人確認要件の具体的フィールド（JP × individual）**

https://docs.stripe.com/connect/required-verification-information （本セッションで取得）。**このページは現在、静的な要件表ではなくエージェント向けの対話手順書に置き換わっており**、要件本体は `https://docs.stripe.com/_endpoint/get-requirements-for-setups` など内部エンドポイントを `apiVersion`/`platformCountry`/`accountCountry`/`dashboardType`/`tosType`/`legalEntityType`/`capabilities` で叩いて取得する構造になっている。ページ本文には日本の individual 向け必須フィールドの静的リストが存在しない。行定義には日本固有の項目（`name_kana`／`name_kanji`／`address_kana`／`address_kanji`、「コンビニ支払いのサポートメールアドレス／電話番号／対応時間」）が含まれることは確認できた。**具体的な currently_due フィールド一覧は本調査では未取得（未確認事項に記載）。**

### Q3. PayPay の Connect 対応 — 記載差の確定

4 ページを実際に開いて突き合わせた。**記載差は実在し、2026-09-24 時点でも解消していない。**

**(1) PayPay 概要ページ** https://docs.stripe.com/payments/paypay

決済手段のプロパティ（逐語）:

> - 顧客の所在地: 日本
> - 取引通貨: 日本円
> - 支払いの確定: 顧客主導
> - 決済手段の種類: ウォレット
> - 継続課金: No
> - 入金サイクル: 標準
> - **Connect のサポート: いいえ**
> - 不審請求の申し立てのサポート: いいえ
> - 手動キャプチャーのサポート: いいえ
> - 返金 / 一部返金: はい / はい

> ビジネスの所在地: JP
> サポート対象のプロダクト: Payment Links / Checkout / Elements（脚注2「Express Checkout Element は PayPay をサポートしません。」）
> 「最小請求額は 50 JPY です。」「最大請求額は 1,000,000 JPY です。」
> 「Stripe 全体の使用が制限されている販売商品やサービスと業種のカテゴリーに加えて、以下のカテゴリーでは PayPay の使用が禁止されています。— 暗号資産取引所とウォレット／PayPay の判断による他のカテゴリー」
> 「返金期間は、購入後最大 365 日です。」「PayPay の決済の返金は即時に完了します。」

**(2) 決済手段サポート表** https://docs.stripe.com/payments/payment-methods/payment-method-support

「ウォレットサポート対象のプロダクト」表の PayPay 行（逐語）:

> | [PayPay] | Connect: ✓ サポート対象 8 | Checkout: ✓ サポート対象 1,2,3 | Payment Links: ✓ サポート対象 | Payment Element: ✓ サポート対象 | Express Checkout Element: - サポート対象外 | Mobile Payment Element: ✓ サポート対象 | サブスクリプション: - サポート対象外 | Invoicing: - サポート対象外 | カスタマーポータル: - サポート対象外 | Terminal: 該当なし (オンライン決済のみ) |

脚注（逐語）:

> 「8 Connect を使用するには、[招待をリクエスト]してください。」
> 「1 サブスクモードで Checkout を使用する場合はサポートされません。2 セットアップモードで Checkout を使用する場合はサポートされません。3 決済時に決済の詳細を保存する場合 (`setup_future_usage`) はサポートされません。」

同ページ「Wallets API のサポート」表の PayPay 行:

> | [PayPay] | `paypay` | PaymentIntents: ✓ サポート対象 | SetupIntents: - サポート対象外 | 手動キャプチャー: - サポート対象外 | 今後の使用のための設定: - サポート対象外 | リダイレクトの要求: あり |

同ページ「国と通貨のサポート」表:

> | [PayPay] | JPY | JP | JP |

同ページ冒頭の注記:

> 「Connect を使用するプラットフォームやマーケットプレイスを連携している場合、連結アカウントの利用資格は、自社アカウントとは異なる場合があります。連結アカウントの利用資格と機能の詳細については、[Connect プラットフォームおよびマーケットプレイスでの決済手段への対応]をご覧ください。」

**(3) その「Connect プラットフォームおよびマーケットプレイスでの決済手段への対応」ページ** https://docs.stripe.com/payments/payment-methods/payment-method-connect-support

ACH／Affirm／Afterpay／Alipay／Alma／銀行振込／Billie／BLIK／Cash App Pay／iDEAL／インドネシア銀行振込／Klarna／Kriya／MB Way／メキシコ分割払い／MobilePay／Mondu／Multibanco／Pay by Bank／PayNow／PayPal／PayTo／Pix／Scalapay／SeQura／Sunbit／SEPA／Swish／TWINT／WeChat Pay の節がある。**PayPay の節は存在しない。**（比較: PayPal の節は「デスティネーション支払い ✓／支払いと送金別方式 ✓／ダイレクト支払い ❌／on_behalf_of ❌」と明示されている）

**(4) アカウントのケイパビリティ一覧** https://docs.stripe.com/connect/account-capabilities

「決済手段」ケイパビリティ表（フルダッシュボード版・Express/Custom 版の両方）に、`us_bank_account_ach_payments`／`konbini_payments`／`jp_bank_transfer_payments`／`jcb_payments`／`alipay_payments`／`wechat_pay_payments` 等は列挙されているが、**`paypay_payments` は両表とも存在しない。** 比較のためコンビニ決済の行（逐語）:

> | [コンビニ決済] `konbini_payments` | すべてのビジネスタイプに対応: いいえ。詳しくは、[禁止業種] をご覧ください。 | デフォルトで利用可能: ダッシュボードの設定ページで支払い方法を有効化する必要があります。 | 追加の確認要件: いいえ | 利用可能な国: 連結アカウントは、サポート対象の事業所在地にある必要があります。 | Accounts v2 のサポート: はい |

また payment-method-support の「店舗支払い」表でコンビニ決済の Connect 欄には脚注4があり「他のアカウントを[代理](on_behalf_of)して支払いを作成するには、[招待をリクエスト]してください。」と、PayPay の脚注8より具体的に書かれている。PayPay の脚注8にはこの粒度の説明が無い。

**(5) Stripe 公式ニュースルーム** https://stripe.com/jp/newsroom/news/Japan-payments-moment-2025 （本セッションで取得）

> 発表日: 2025年4月22日
> 「本日より、利用希望フォーム から先行提供版にお申し込み頂けます」

先行提供版（ベータ）としての告知であり、Connect への言及は無い。

**確定した結論:** 概要ページ（Connect サポート＝いいえ）と Connect 専用 2 ページ（PayPay の記載なし）が一致しており、サポート表の「✓＋招待をリクエスト」だけが少数派。**Connect 経由の PayPay は、少なくとも公開ドキュメント上に実装経路（ケイパビリティ名・対応する支払いタイプ・申請条件）が示されていない。** 引継ぎ書 [S3] の「断定せず Stripe に確認する」という判断は正しく、変更の必要は無い。

### Q4. Checkout / Payment Links の Webhook と payment_status の扱い、冪等性・署名検証・再送

**一次資料:** https://docs.stripe.com/checkout/fulfillment?payment-ui=stripe-hosted, https://docs.stripe.com/webhooks （どちらも本セッションで取得）

**(a) Webhook は必須であり、リダイレクト先だけで判定してはならない**

> 「顧客が決済のランディングページを訪問するとは限らないため、ランディングページに限定してフルフィルメントをトリガーすることはできません。たとえば、決済が正常に完了した後、ランディングページが読み込まれる前に顧客のインターネット接続が途切れる可能性があります。」
> 「サブスクを販売する場合や、遅延型決済手段を受け付ける場合、Checkout Session の完了後にのみ後続の状態が変更されるため、Webhook による自動フルフィルメントが必要です。」
> 「支払いごとにフルフィルメントが発生するように Webhook を使用する必要があり、リダイレクトによって顧客は支払い後すぐにサービスやフルフィルメントの詳細にアクセスできます。」

Payment Links についても: 「Payment Links は Checkout を使用するため、以下の情報は特に記載のない限り、すべて Payment Links と Checkout の両方に適用されます。」

**(b) リッスンするイベントと payment_status**

コード例（逐語）:

```ruby
if event['type'] == 'checkout.session.completed' ||
event['type'] == 'checkout.session.async_payment_succeeded'
  fulfill_checkout(event['data']['object']['id'])
end
```

> 「また、`checkout.session.async_payment_failed` イベントをリッスンして処理することもできます。たとえば、遅延していた支払いが失敗した場合に顧客にメールを送信できます。」
> 「決済手段が遅延した場合、後で支払いが成功すると `checkout.session.async_payment_succeeded` イベントが生成されます。オブジェクトのステータスは、決済ステータスが成功または失敗になるまで処理中になります。」

fulfill 関数の要件（逐語）:

> 「1. 同じ Checkout セッション ID で複数回呼び出されたケースを正しく処理します。2. Checkout セッション ID を引数として受け入れます。3. 拡張した `line_items` プロパティを使って、API で Checkout セッションを取得します。4. **`payment_status` プロパティを確認して、フルフィルメントが必要かどうかを判断します。** 5. ラインアイテムのフルフィルメントを実行します。6. 指定された Checkout セッションのフルフィルメントステータスを記録します。」
> 「支払いごとに 1 回のみフルフィルメントを履行します。この導入とインターネットの動作が原因で、同じ Checkout セッションに対して `fulfill_checkout` 関数が複数回、場合によっては同時に呼び出されることがあります。」

サンプルコード内の判定は `if checkout_session.payment_status != 'unpaid'`（`unpaid` 以外なら履行）。TODO コメントは "Make this function safe to run multiple times, even concurrently, with the same session ID" / "Make sure fulfillment hasn't already been performed for this Checkout Session"。

**(c) success_url とタイミング**

> 「`checkout.session.completed` イベントを監視する Webhook エンドポイントを設定し、さらに `success_url` を設定した場合、Checkout はサーバーが Webhook イベントの応答を 10 秒待ってから顧客をリダイレクトします。この方法を使用する場合は、サーバーができるだけ早く `checkout.session.completed` イベントに応答するようにしてください。」

**(d) 署名検証**

> 「JSON ペイロード、`Stripe-Signature` ヘッダー、前のステップの `whsec_` Webhook 署名シークレットを使用して、Webhook リクエストが Stripe によって生成されたことを確認します。」
> 「Stripe で署名の検証を実行するには、未加工のリクエスト本文が必要です。フレームワークを使用している場合は、元の本文に手が加えられないようにする必要があります。未加工のリクエスト本文に何らかの変更が行われた場合、検証は失敗します。」
> 「次の両方の保護を使用します。— **IP の許可リスト**: Stripe は webhook イベントを特定の IP アドレスから送信します。サーバーやファイアウォールを設定して、これらのアドレスからのリクエストのみ受け入れるようにします。— **署名の確認**: Stripe では、`Stripe-Signature` ヘッダーに署名を含めることで、すべての Webhook イベントに署名が付与されます。」
> 「Stripe のライブラリには、タイムスタンプと現在時刻の間に 5 分のデフォルトの許容範囲があります。」「許容値 `0` は使用しないでください。」
> 「Stripe の Webhook は、TLS バージョン v1.2 および v1.3 のみサポートしています。」
> 「ダウングレード攻撃を防ぐには、`v1` 以外のスキームをすべて無視します。」

**(e) 重複・順序・再送**

> 「Webhook エンドポイントは、同じイベントを複数回受信する可能性があります。処理した**イベント ID** をログに記録し、すでにログに記録したイベントを処理しないようにすることで、重複するイベントの受信に対処することができます。」
> 「場合によっては、2 つの Event オブジェクトが個別に生成・送信されます。これらの重複を識別するには、`data.object` のオブジェクト ID と `event.type` を使用します。」
> 「Stripe は、イベントが生成された順序で配信されることを保証しません。」「**イベントの順序や、イベントをすでに処理したかどうかを判断するために `created` を使用しないでください。**代わりに イベント ID を追跡して、重複した配信を特定します。」
> 「本番環境では、Stripe は指数バックオフを使用して**最長 3 日間**、送信先へのイベントの配信を試行します。Stripe はサンドボックスで作成されたイベントの配信を数時間のうちに 3 回再試行します。」
> 手動再送: 「ダッシュボードで…**イベント作成後最大 15 日間**機能します」「Stripe CLI…**イベント作成後最大 30 日間**機能します」
> 「エンドポイントは、タイムアウトを引き起こす可能性のある複雑なロジックが実行される前に、成功のステータスコード (`2xx`) を素早く返す必要があります。」
> 「非同期キューで受信したイベントを処理するようにハンドラを設定します。」
> 「Webhook エンドポイントは、お客様の実装で必要なイベントのタイプのみを受信するように設定します。」
> 「Rails、Django、その他のウェブフレームワークを使用している場合…Webhook ルートを CSRF 保護から除外しなければならない可能性があります。」
> 「Stripe には最大 16 個の Webhook エンドポイントを登録できます。」

**(f) Connect を使う場合のイベント送信先スコープ**

> 「**アカウント**: 自社アカウントのリソースからのイベント。**連結アカウント**: 連結アカウントに属するリソースからのイベント。」
> 「プラットフォームの顧客、プラットフォームが所有する支払い、デスティネーション支払い、支払いと送金の分離など、プラットフォームアカウントのリソースのイベントの処理」には **アカウント** スコープの登録も必要。

**注意:** `payment_intent.succeeded` は Checkout フルフィルメントガイドでは推奨イベントとして挙げられていない（Webhook 一般ページのサンプルコードには登場する）。Checkout/Payment Links 経由なら `checkout.session.*` を正とし、`payment_intent.succeeded` を二重の根拠に使う場合は Checkout Session との突合を自前で行う必要がある。

### Q5. 日本の Stripe 手数料と入金サイクル

**(a) 決済手数料** https://stripe.com/jp/pricing, https://stripe.com/jp/pricing/local-payment-methods （どちらも本セッションで取得）

| 項目 | 料率 |
|---|---|
| カード決済 | 3.6%（成功した取引ごと） |
| 通貨換算が必要な場合 | +2% |
| PayPay | **3.98%**（デジタルコンテンツ事業者は **9.48%**） |
| コンビニ決済 | 3.6%（最低手数料 ¥120／返金時に 10% + ¥250 の記載あり） |
| 銀行振込 | 1.5% |
| Terminal（対面） | 3.24% ＋ Tap to Pay 認証ごと ¥18 ／ P2PE 認証ごと ¥8（オプション） |
| 不審請求の申し立て（チャージバック） | ¥1,500／件 |
| Smart Disputes | 成功した申し立て額の 30% |

Apple Pay / Google Pay については、`docs.stripe.com/connect/account-capabilities` で「`card_payments` で利用可能」＝カード決済ケイパビリティに含まれると明記されており、stripe.com/jp/pricing に個別料率の記載は見当たらなかった（＝カード料率 3.6% に含まれると読むのが自然だが、明示的な記述は未確認）。

**(b) Connect の料金** https://stripe.com/jp/connect/pricing （本セッションで取得）

> Stripe が料金を管理する場合: 「プラットフォームに対する手数料はなし」
> 自社で料金を管理する場合: 「￥200 (有効なアカウントごと、月額)」＋「0.25% + ￥250 (入金ごと)」
> 「有効なアカウントとは、当該月に銀行口座またはデビットカードへの入金が行われたアカウント」

**(c) 入金（payout）** https://docs.stripe.com/payouts （本セッションで取得）

> 国別の入金制限: 「**日本: 日次入金は利用できません。デフォルトのスケジュールは手動であり、週次および月次の入金スケジュールも利用できます。**」

売上処理タイミング表:

| 国 | 初期売上処理のタイミング | デフォルト売上処理のタイミング |
|---|---|---|
| 日本 | 7 暦日 | 4 営業日 |

> 最低入金額: JP = 1 JPY
> 週次は曜日指定、月次は日付指定が可能

**含意:** 参加者が支払った瞬間に幹事の手元に金が入ることは構造上ありえない。初回は 7 暦日、以降も 4 営業日の売上処理を経たうえ、日本では日次自動入金が無く**デフォルトは手動**（＝誰かが入金操作をしないと着金しない）。「参加者10人×5,000円 → 幹事に50,000円がそのまま入る」は手数料・タイミングの両面で成立しない。

### Q6. 日本の「個人間送金」「割り勘」「立替精算」に近い用途の公式見解

Stripe 側の公式見解としては、Q1 に挙げた Restricted Businesses の「ピアツーピアの送金」（禁止業種）と SSA 1.2(a)(i) の personal/family/household 禁止以外に、割り勘・立替精算を名指しした公式文書は**見つからなかった**。

一方、**日本の法令側には本件を名指しした規定が存在する。** これは Stripe の規約より先に効く。

**(a) 資金決済に関する法律 第二条の二**（e-Gov 法令API `https://laws.e-gov.go.jp/api/1/lawdata/421AC0000000059` から 2026-09-24 に取得した現行条文）

> 第二条の二　金銭債権を有する者（以下この条において「受取人」という。）からの委託（国内から国外へ向けて資金を移動させ、又は国外から国内へ向けて資金を移動させる行為に係る場合にあっては、二以上の段階にわたる委託を含む。）、受取人からの金銭債権の譲受けその他これらに類する方法により、当該金銭債権に係る債務者又は当該債務者からの委託（二以上の段階にわたる委託を含む。以下この条において同じ。）その他これに類する方法により支払を行う者（以下この条において「債務者等」という。）から弁済として資金を受け入れ、又は他の者に受け入れさせ、当該受取人又は当該受取人からの委託その他これに類する方法により支払を受ける者（以下この条において「受取人等」という。）に当該資金を引き渡すことによって、債務者等から受取人等に当該資金を移動させる行為（債務者等から現金の交付を受け、当該現金を受取人等に交付することにより当該資金を債務者等から受取人等に移動させる行為を除く。）であって、次の各号のいずれかに該当するものは、為替取引に該当するものとする。
> 一　受取人が個人（事業として又は事業のために受取人となる場合におけるものを除く。）であることその他の内閣府令で定める要件を満たす行為（次号に該当する行為を除く。）
> 二　国内から国外へ向けて資金を移動させ、又は国外から国内へ向けて資金を移動させる行為（当該行為の態様その他の事情を勘案し、利用者の保護に欠けるおそれが少ないものとして内閣府令で定めるものを除く。）

**(b) 資金移動業者に関する内閣府令 第一条の二**（e-Gov 法令API `https://laws.e-gov.go.jp/api/1/lawdata/422M60000002004` から 2026-09-24 に取得。現行版は令和8年内閣府令第51号による改正版、公布 2026-05-22・施行 2026-06-01、`current_revision_status: CurrentEnforced`）

> 第一条の二　法第二条の二第一号に規定する内閣府令で定める要件は、受取人（同条に規定する受取人をいう。以下この条及び次条において同じ。）が**個人（事業として又は事業のために受取人となる場合におけるものを除く。）であり**、かつ、次に掲げる要件のいずれかに該当することとする。
> 一　受取人が有する金銭債権に係る債務者等から弁済として資金を受け入れた時（他の者に資金を受け入れさせる場合にあっては、当該他の者が弁済として資金を受け入れた時）**までに当該金銭債権に係る債務者の債務が消滅しないものであること。**
> 二　受取人が有する金銭債権が、**資金の貸付け、連帯債務者の一人としてする弁済その他これらに類する方法によってする…信用の供与**をしたことにより発生したものである場合に、当該金銭債権の回収のために資金を移動させるものであること。
> 三　次に掲げる要件のいずれにも該当すること。
> 　イ　受取人がその有する金銭債権に係る債務者に対し反対給付をする義務を負っている場合に、当該反対給付に先立って又はこれと同時に…弁済として資金を受け入れ、又は他の者に受け入れさせ、当該反対給付が行われた後に受取人等に当該資金を引き渡す**ものでないこと**。
> 　ロ　受取人が有する金銭債権の発生原因である契約の締結の方法に関する定めをすることその他の**当該契約の成立に不可欠な関与**を行い、…**当該受取人の同意の下に**、当該契約の内容に応じて受取人等に当該資金を引き渡す**ものでないこと**。
> 　ハ　…（他の収納代行者）からの委託…その他これに類する方法により、…受取人等に当該資金を引き渡すものでないこと。
> 　ニ　**銀行等又は資金移動業者からの委託**その他これに類する方法により、…受取人等に当該資金を引き渡すものでないこと。

**(c) 金融庁のパブリックコメント回答**（2021-03-19 公表、令和2年法律第50号関係。https://www.fsa.go.jp/news/r2/sonota/20210319-2/01.pdf を本セッションで取得し pdftotext で抽出）

> No.48（回答）「資金決済法第２条の２の規定は、いわゆる**確認規定**であると考えます。また、同条の規定により『為替取引』に該当するものとされる行為は、他の法令においても『為替取引』とされるべきものと考えます。」
> No.52（コメント）「個人を受取人とする収納代行サービス等のうち、いわゆる**割り勘アプリ**の中で事後的に連帯債務等を発生させて回収するなどの法的構成を採用しているものを為替取引とする旨確認した規定と理解している」
> No.55/56（回答・繰り返し）「資金移動業者府令第１条の２の規定は、資金決済法第２条の２の規定により為替取引に該当するものとされる行為の具体的な要件を定めるものであり、**当該要件に該当しない行為であれば為替取引に該当しないことを意味するものではない**ことは、事務ガイドライン（資金移動業者）Ⅰ－２に記載しているとおりです。」
> No.56（回答）「どのような行為が為替取引に該当するかについては、個別事例ごとに実態に即して実質的に判断されるべきものと考えますが、**債務者に二重支払のリスクがあるかどうかは、こうした判断に当たり、考慮要素の一つ**となるものと考えます。」
> No.59（コメント→回答「貴見のとおりと考えます。」）「『弁済として資金を受け入れた時…までに当該債務者の債務が消滅しないもの』には、弁済として資金を受け入れた時と同時に債務者の債務が消滅するものは含まれない」
> No.61（回答）「『その他』の直前に規定されている『連帯債務者の一人としてする弁済』もいわゆる**立替払**の一類型と考えられ、これに類する方法による信用の供与であれば、『その他これらに類する方法によってする…信用の供与』に該当するものと考えます。」
> No.69/70（回答）「多数の者が参加して取引を行うことが可能なプラットフォームを提供する事業者が、**利用規約において当該プラットフォームの利用条件や取引成立条件を定めているような場合には、『契約の締結の方法に関する定め』をしており、『契約の成立に不可欠な関与』を行っているもの**と考えます。」
> No.76（回答）「**債務者等から受取人に資金が移動するまでの流れを受取人が把握・許容していることが重要**と考えます。」
> No.77（回答）「債務者については、資金移動業者府令第１条の２第１号に掲げる要件により**二重支払のリスクを回避**でき、一定の保護が図られるものと考えます。他方で、受取人については、資金を受け取るまでの間、収納代行業者に対する**信用リスク**を抱えることになるため、**その同意が得られていない場合には、収納代行業者の行為が為替取引に該当し得るものとし、受取人の保護を図ることが適当**と考えます。」

**(d) 令和7年改正の射程**（https://www.fsa.go.jp/news/r7/sonota/20260522/04.pdf を本セッションで取得し pdftotext で抽出）

表題は「コメントの概要及びコメントに対する金融庁の考え方（**クロスボーダー収納代行（国境を跨ぐ収納代行）**）」。凡例で改正法＝「資金決済に関する法律の一部を改正する法律（令和７年法律第 66 号）」、参照は「金融審議会『資金決済制度等に関するワーキング・グループ』報告（2025 年１月 22 日）」。目次は「1 資金決済法第２条の２や関係法令の適用に関する解釈」「2 移動業府令第１条の２第３号関係」「3〜9 移動業府令第１条の３（＝クロスボーダーの適用除外）関係」。文書全体で「割り勘」の語は 1 度も出現しない。

→ **令和7年改正は第2条の2に第2号（クロスボーダー）を追加し、従来の国内向け規律を第1号に整理したもので、国内の「個人を受取人とする収納代行＝割り勘アプリ」規制の枠組みは維持されている。**

---

## 未確認事項

1. **Stripe への用途照会を一切行っていない。** 「幹事の会費集金」が Stripe の承認対象かどうかは、規約文言からの整理にとどまる。承認可否を予断してはならない。
2. **Connect × PayPay の「招待」の実体**（申請フォーム、審査基準、所要期間、対象となるプラットフォーム像、承認後に使える支払いタイプ）はどのページにも記載が無い。脚注8のリンク先は `support.stripe.com/contact/email?topic=payment_apis` の問い合わせ窓口であり、条件は公開されていない。
3. **日本の Stripe アカウントの入金（payout）に振込手数料が発生するか。** stripe.com/jp/pricing を実際に開いたが、入金手数料・振込手数料・入金サイクルに関する記述が見当たらなかった。Connect で「自社で料金を管理する」場合の「0.25% + ￥250（入金ごと）」は connect/pricing に明記があるが、非 Connect の通常入金については未確認。
4. **JP × individual の連結アカウントで currently_due となる具体的フィールド一覧。** `docs.stripe.com/connect/required-verification-information` が対話手順書に置き換わっており、静的な要件表が本文に無い。要件本体は `docs.stripe.com/_endpoint/get-requirements-for-setups` 等を叩く必要があり、本調査では未取得。
5. **JCB / American Express の日本での個別料率。** stripe.com/jp/pricing にカード 3.6% 以外のブランド別料率の記載を確認できなかった。Connect には `jcb_payments` ケイパビリティ（「連結アカウントは日本にある必要があります」）が存在することのみ確認。
6. **Apple Pay / Google Pay の追加手数料の有無。** `card_payments` ケイパビリティに含まれることは確認したが、料率が 3.6% と同一であることの明示的な記載は未確認。
7. **Accounts v2 API での日本・individual・PayPay の扱い。** `docs.stripe.com/connect/accounts-v2` 系のページは本調査では開いていない。Standard/Express/Custom が非推奨扱いになっている以上、実装前に必読。
8. **e-Gov の Web UI（`laws.e-gov.go.jp/law/...`）は SPA のため WebFetch では条文が取得できなかった。** 条文は e-Gov 法令 API 経由で取得した（本文は同一だが、参照リンクとしては API URL を記載している）。
9. **事務ガイドライン（第三分冊：金融会社関係 14 資金移動業者関係）Ⅰ－２の原文は未取得。** 金融庁回答が繰り返し参照している重要文書であり、法務レビュー時に必読。
10. **PayPay 側（PayPay 株式会社）の加盟店規約・個人間送金APIの有無は本調査の対象外**（Stripe スコープのため）。引継ぎ書 4-1 の判断は再確認していない。

---

## 本アプリ設計への含意

### 1. 「幹事の個人PayPayに直接送金し、それをアプリが検知する」は Stripe では実現経路が無い

Stripe における PayPay は**加盟店が消費者から受け取る決済手段**であり、受取先は Stripe アカウントの残高、そこから銀行口座への入金である。幹事の個人 PayPay 残高が受取先になることはない。加えて Connect での PayPay 利用は公開された実装経路が無い。**受取先を「幹事の個人PayPay」に固定したまま Stripe を採る道は存在しない。**

### 2. Stripe を採るなら、幹事は「事業として有料イベントを主催する個人事業主」でなければならない

SSA 1.2(a)(i) の personal/family/household 禁止は業種リストより上位の包括禁止。「友人同士の飲み会の精算」という実態のまま Stripe を通すことは規約違反になる。逆に、幹事が反復継続的にイベントを主催して参加費を対価として受領する実態があれば、通常のイベント決済として整理できる余地がある。**この分岐はプロダクトのターゲット定義そのものであり、実装より前に決めるべき。**

### 3. 運営者が資金を預かる構成を採るなら、資金移動業登録リスクを設計で潰す必要がある

府令第1条の2 の適用は「受取人が非事業者の個人」で始まる。幹事がまさにそれ。規制外に立つには、以下を**同時に**満たす設計が要る（いずれも金融庁の「個別事例ごとに実態に即して実質的に判断」の対象であり、法務レビュー必須）。

- **第1号を外す:** 参加者がアプリに支払った時点で、参加者の幹事に対する債務が消滅する（＝参加者に二重払いリスクを負わせない）。これを利用規約に明記する。No.59 の金融庁回答が「弁済と同時に債務消滅するものは第1号に含まれない」と確認している。
- **第2号を外す:** 立替払い・連帯債務・資金の貸付けなど信用供与の法律構成を一切使わない。No.61 で「連帯債務者の一人としてする弁済」は立替払の一類型と明示されている。「先に幹事に払って後で参加者から回収する」設計は禁じ手。
- **第3号ロの除外に乗る:** アプリが利用規約で「参加者が幹事に会費債務を負う条件」＝取引成立条件を定め、「契約の成立に不可欠な関与」を行う。かつ資金の流れを**幹事が把握・許容**していること（No.76）を UI とフローで担保する。これが満たされれば第3号は不成立になる。

「単に集金を代行するだけで契約成立に関与しない」中立的な集金代行を作ると、第3号が成立して為替取引になり、資金移動業登録が必要になる。**これは設計の自由度ではなく、設計の必須制約。**

### 4. 自動チェックの技術要件は Stripe で満たせる（Connect を使わなければ）

- Checkout / Payment Links → `checkout.session.completed` ＋ `checkout.session.async_payment_succeeded`（PayPay は即時決済だが、将来コンビニ決済・銀行振込を足す場合に必須）＋ `checkout.session.async_payment_failed`。
- 請求レコード ID を `client_reference_id` か `metadata` で Checkout Session に埋め、Webhook 受信時に Session を API で再取得して `payment_status != 'unpaid'` を確認してから支払済みにする。イベントの `data.object` を鵜呑みにせず API 再取得する（ドキュメントのサンプルもそうしている）。
- **重複排除は Stripe イベント ID を主キーにした処理済みテーブルで行う。** `created` を順序判定に使ってはならない（ドキュメントが明示的に禁じている）。
- 署名検証は生ボディで。フレームワークのボディパーサを Webhook ルートだけ無効化する。CSRF 保護からも除外する。
- 2xx を先に返してから非同期キューで処理する。success_url を使う場合、Checkout は Webhook 応答を最大 10 秒待つため、同期処理を重くすると決済後の体感が悪化する。
- 再送は最長 3 日・指数バックオフ。ダッシュボード再送は 15 日、CLI 再送は 30 日。障害復旧手順はこの窓に収まるよう設計する。
- IP 許可リストと署名検証の**両方**を使うのが Stripe の推奨。

### 5. PayPay を決済手段に入れる場合の実装上の制約

`setup_future_usage` 不可、SetupIntents 不可、手動キャプチャー不可、サブスク・Invoicing 不可、Express Checkout Element 不可、リダイレクト必須、最小 50 JPY・最大 1,000,000 JPY、**不審請求の申し立てサポートなし**、返金は 365 日以内・即時。「事前にカードを登録しておいて後で自動請求」型の二次会追加徴収は PayPay では作れない。カードなら作れる。

### 6. 「決済完了」と「幹事への着金」を UI で明確に分ける

日本は日次入金不可・デフォルト手動・初回 7 暦日・以降 4 営業日。幹事画面には「参加者の支払済み（=決済完了）」と「幹事の口座への入金予定」を別々のステータスとして出す。これを混ぜると必ずクレームになる。引継ぎ書 3. の「決済完了と幹事への入金完了は分ける」という方針は一次資料で裏付けられた。

### 7. Connect を使うなら Accounts v2 を前提に設計する

`docs.stripe.com/connect/accounts` は明示的に「新しい Connect プラットフォームを設定する場合…このページを無視して Accounts v2 API を使え」と書いている。Standard/Express/Custom という語彙で設計を固めると、着手時点で非推奨 API に乗ることになる。ただし Accounts v2 は `paypal_payments` のような一部ケイパビリティが未対応であることがドキュメント中に例示されており、**必要ケイパビリティが v2 で使えるかを先に確認する必要がある。**

### 8. 手数料の負担者を先に決める

カード 3.6% / PayPay 3.98%。5,000円の会費なら 180〜199円。Connect で自社料金管理なら加えて月額¥200/有効アカウント＋入金ごと0.25%+¥250。**参加者負担（上乗せ）か幹事負担かで、必要な金額計算ロジックと表示文言が変わる。**未定のまま実装に入ると請求金額の設計を作り直すことになる。

---

## 参照URL一覧（すべて本セッションで実際に取得）

**Stripe 規約・法務**
- https://stripe.com/jp/legal/restricted-businesses （最終更新 2026-09-22）
- https://stripe.com/legal/restricted-businesses （同内容、最終更新 2026-09-22）
- https://stripe.com/jp/legal/ssa （Stripe Services Agreement、Last modified: November 18, 2025）
- https://stripe.com/jp/legal/connect-account （Stripe Connected Account Agreement、Last modified: November 18, 2025）

**Stripe ドキュメント**
- https://docs.stripe.com/payments/paypay
- https://docs.stripe.com/payments/paypay/accept-a-payment （バリアント一覧のみ）
- https://docs.stripe.com/payments/payment-methods/payment-method-support
- https://docs.stripe.com/payments/payment-methods/payment-method-connect-support
- https://docs.stripe.com/connect/accounts
- https://docs.stripe.com/connect/account-capabilities
- https://docs.stripe.com/connect/service-agreement-types
- https://docs.stripe.com/connect/required-verification-information
- https://docs.stripe.com/checkout/fulfillment?payment-ui=stripe-hosted
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/payouts
- https://docs.stripe.com/get-started/account

**Stripe 料金・ニュース**
- https://stripe.com/jp/pricing
- https://stripe.com/jp/pricing/local-payment-methods
- https://stripe.com/jp/connect/pricing
- https://stripe.com/jp/newsroom/news/Japan-payments-moment-2025 （2025年4月22日）

**Stripe サポート**
- https://support.stripe.com/questions/selling-on-stripe-without-a-separate-business-entity
- https://support.stripe.com/questions/business-information-requirements-to-use-stripe

**日本の法令・当局**
- https://laws.e-gov.go.jp/api/1/lawdata/421AC0000000059 （資金決済に関する法律・現行、e-Gov法令API）
- https://laws.e-gov.go.jp/api/1/lawdata/422M60000002004 （資金移動業者に関する内閣府令・現行、e-Gov法令API）
- https://laws.e-gov.go.jp/api/2/law_data/422M60000002004?response_format=json （改正情報: 令和8年内閣府令第51号、公布2026-05-22・施行2026-06-01、CurrentEnforced）
- https://www.fsa.go.jp/news/r2/sonota/20210319-2/01.pdf （金融庁パブコメ回答、2021-03-19公表、施行日 令和3年5月1日）
- https://www.fsa.go.jp/news/r7/sonota/20260522/04.pdf （金融庁パブコメ回答「クロスボーダー収納代行」、令和7年法律第66号関係）

**取得に失敗したURL（引用していない）**
- https://laws.e-gov.go.jp/law/421AC0000000059 （SPAのため本文取得不可 → APIで代替）
- https://support.stripe.com/questions/payout-schedule-in-japan （404）
- https://support.stripe.com/questions/understanding-payout-schedule （404）
