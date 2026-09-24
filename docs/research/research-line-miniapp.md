# LINEミニアプリ/LIFF 一次資料調査レポート（決済・規約・審査・技術仕様）

調査日：2026-09-24 / 調査者：リサーチエージェント
一次資料は全て WebFetch で実際に開いて本文を取得している。開けなかったURLは「未確認事項」に回した。

---

## 結論

**LINEミニアプリで「幹事の会費集金アプリ」を配布すること自体は、LINEの現行規約上は成立しうる。ただし成立条件は3つある。**

1. **決済は外部決済（Stripe等）で実装してよい。** LINE公式の『決済システムを利用する』は日本について「LINE Pay ❌ / LINEミニアプリのアプリ内課金 ✅ / その他の決済方法 ✅」と明示し、その他の決済方法は「一般のウェブページで決済を提供して処理するのと同様に実装してください」と書いている。LINEミニアプリのアプリ内課金は**デジタルコンテンツ（消耗型）専用**なので、現実の会費集金には使えないし、使う義務もない。
2. **LINE Pay（日本）は2025年4月30日に終了済み。** LINEミニアプリ側の決済手段として日本でLINE Payは選べない。LINEヤフーは送金・決済をPayPayに一本化した。さらに2026年7月2日発表で、**2026年夏以降にLINEとPayPayのアカウント連携が始まり、LINEのトーク上でPayPay残高の送金とグループでの割り勘が使えるようになる**。本アプリの正面からの競合になる。
3. **ポリシー上の地雷が2つある。** (a) 禁止業種に「募金、寄附、クラウドファンディング等の資金調達」が、禁止事項に「チャリティまたは募金として寄付金を収集する目的の内容」がある。会費集金を「集金プラットフォーム」として一般公開すると、この解釈リスクをLINEの審査で問われうる。(b)「LINEミニアプリ内で有料アイテム、有料サービス等を販売するためには、別途『LINEアプリ内課金利用規約』に同意の上、本サービス上のLINEアプリ内課金機能を利用しなければなりません」という条項があり、「有料サービスの販売」と読まれる設計にした場合はIAP必須と判断される余地が残る（IAPは認証済ミニアプリ・日本限定・デジタルコンテンツのみ）。

**運営者属性については明確。** 認証済ミニアプリを出せるのは「日本の法人番号、または台湾やタイの納税番号がある組織」「日本の個人事業主」に限られる。NonTurn LLC は法人なので認証済ミニアプリを申請できる。逆に、**一般個人の幹事が自分で認証済ミニアプリを出すことはできない**（未認証なら日本の個人も可）。したがって「幹事ごとにミニアプリを作る」構成は不可能で、**NonTurn LLC が1つのミニアプリを運営し、幹事はその中のユーザーになる**構成しかない。この構成は、幹事が受け取る金銭を運営者が一旦預かるかどうかという資金移動業の論点を直接呼び込む（本レポートの範囲外。別調査が必要）。

**技術面の要点。** 参加者の一意識別は LIFF の IDトークン（`liff.getIDToken()`）をサーバーへ送り `POST https://api.line.me/oauth2/v2.1/verify` で検証する方式が正規。userIdは**プロバイダー単位**で共通なので、ミニアプリチャネルとMessaging APIチャネルは同一プロバイダー配下に置く。参加者への配布は `liff.shareTargetPicker()`（要：コンソールでチャネルごとの同意有効化＋ログイン済み）。支払い完了の通知は**サービスメッセージ（認証済ミニアプリ限定・ユーザー操作への応答としてのみ・1アクション最大5回）**が使える。未認証のままではサービスメッセージが一切使えない。

---

## 問いごとの回答

### Q1. LINEミニアプリの定義とLIFFとの関係、認証済み/未認証の違い

**定義とLIFFとの関係**

> 「LINEミニアプリは、LIFF（LINE Front-end Framework）上で実行されるウェブアプリです。」
> 「今後、LIFFとLINEミニアプリは、ブランド統合を予定しています。この統合により、LIFFはLINEミニアプリに統合されます。」
> 「LIFFアプリを新規作成する際は、LINEミニアプリとして作成することを推奨します。」
— https://developers.line.biz/ja/docs/line-mini-app/discover/introduction/ （および同ページのMarkdown版 https://developers.line.biz/ja/docs/line-mini-app/discover/introduction/index.html.md ）

LIFF自体の定義：

> 「LINE Front-end Framework（LIFF）は、LINEヤフー株式会社が提供するウェブアプリのプラットフォームです。」
— https://developers.line.biz/ja/docs/liff/overview/

**認証済み/未認証の機能差（公式表）**

> 「さらにユーザー体験を充実させるために、以下の機能をLINEミニアプリに追加できます。使用できる機能は、LINEミニアプリが未認証ミニアプリか認証済ミニアプリかによって異なります。」

| 機能 | 未認証ミニアプリ | 認証済ミニアプリ |
|---|---|---|
| サービスメッセージ | ❌ | ✅ |
| Custom Path | ❌ | ✅ |
| ユーザー端末のホーム画面にLINEミニアプリへのショートカットを追加する | ❌ | ✅ |
| 共通プロフィールのクイック入力 | ❌ | ✅ |
| ヘッダーにLINEミニアプリ名を表示する | ❌ | ✅ |
| ユーザーをLINE公式アカウントの友だち追加へ誘導する | ✅ | ✅ |
| カスタムアクションボタン | ✅ | ✅ |
| **決済システムの利用** | **✅** | **✅** |
| 広告の掲載 | ✅ | ✅ |

— https://developers.line.biz/ja/docs/line-mini-app/discover/custom-features/

ヘッダー表示の差：認証済はミニアプリ名＋認証バッジ、未認証はエンドポイントURLのドメイン名が表示される（同ページ）。

**審査の要否と利用対象者（ポリシー本文）**

> 「本サービスは、お客様が以下のいずれかに該当する場合のみご利用いただけます。（中略）
> ◆未認証ミニアプリ
> ・日本の法人番号、または台湾やタイの納税番号がある組織
> ・日本の個人事業主
> ・日本、台湾およびタイの個人
> ◆認証済ミニアプリ
> ・日本の法人番号、または台湾やタイの納税番号がある組織
> ・日本の個人事業主」
— https://terms2.line.me/LINE_MINI_App?lang=ja （最終改定日：2026年2月19日）

審査基準（ポリシー「LINEミニアプリの認証審査」節・[要約]）：①ユーザーの不利益につながる可能性の有無 ②法令における規制への抵触 ③利用規約・ガイドライン違反のおそれ ④当社独自の認証審査基準の充足 ⑤当社事業への悪影響・信用損傷の可能性。審査結果の理由説明義務は負わないと明記。

審査期間：

> 「1〜2週間程度かかります」
— https://developers.line.biz/ja/docs/line-mini-app/submit/submission-guide/

審査の前提：

> 「LINEミニアプリが、すべてのガイドラインやルールに従っていること」「LINEミニアプリポリシーを遵守していること」（同上）

**利用者数上限については、一次資料で確認できなかった**（未確認事項参照）。

---

### Q2. 決済・金銭授受・外部決済誘導・個人間送金に関する禁止/制限（逐語）

**(a) 有料アイテム等の販売＝アプリ内課金の使用義務**

> 「◆有料アイテム等の販売
> LINEミニアプリ内で有料アイテム、有料サービス等を販売するためには、別途「LINEアプリ内課金利用規約（LINEミニアプリご提供者様向け）」に同意の上、本サービス上のLINEアプリ内課金機能を利用しなければなりません。」
— https://terms2.line.me/LINE_MINI_App?lang=ja

**(b) 外部誘導の制限**

> 「お客様が公開するLINEミニアプリの主な機能は、LINEミニアプリ内で提供される必要があります。ただし、「LINE未使用ユーザーをウェブブラウザに誘導する」機能が有効な場合の外部のブラウザ誘導や、以下の場合において一時的にユーザーを外部のウェブサイトやネイティブアプリに誘導することを許可します。」

許可される一時的誘導の例（同節）：
- 「トランザクションや認証を行う」
- 「決済を別のネイティブアプリで行う」
- 「プライバシーポリシーや利用規約、企業の公式サイトに遷移する」
- 「店舗の地図を地図アプリで開く」

> 「外部のウェブサイトへの誘導とは、LINEミニアプリのエンドポイントURLのドメイン名とは異なるドメイン名のサイトを、LIFFブラウザまたは外部ブラウザで開くことを指します。ユーザーが外部のウェブサイトに遷移した際に、LINEミニアプリのパーマネントリンクが正常に動作しない等の問題が生じる可能性があります。そのため、ユーザーを外部のウェブサイトに誘導した場合の動作は保証していません。」
— 同上

**(c) 禁止業種（金銭関連を抜粋・原文）**

> 「・募金、寄附、クラウドファンディング等の資金調達（一部当社が認めた場合を除く）」
> 「・消費者金融などの貸金業（一部当社が認めた場合を除く）」
> 「・ギャンブル関連、パチンコ等（公営競技・公営くじ、一部当社が認めた場合を除く）」
> 「・連鎖販売取引」
> 「・情報商材、自己啓発セミナー等」
— 同上（「LINEミニアプリを利用できない業種」節）

**(d) 禁止事項（金銭関連を抜粋・原文）**

> 「・チャリティまたは募金として寄付金を収集する目的の内容」
> 「・ネットワークビジネス、ねずみ講などに関わる内容」
> 「・他のネイティブアプリ、または外部のウェブサイトへの誘導に関して、「ユーザーの誘導について」の記載に違反する内容」
> 「・Apple Inc.若しくはGoogle LLC等の他のプラットフォーム提供業者によって提供される方針、約款及びそれらに相当する文書に違反する内容や行為」
— 同上（「LINEミニアプリに関する禁止事項」節）

**個人間送金（P2P送金）そのものを名指しで禁止する条項は、LINEミニアプリポリシー本文中には確認できなかった。** ただし禁止業種の「募金、寄附、クラウドファンディング等の資金調達」と禁止事項の「チャリティまたは募金として寄付金を収集する目的の内容」は、会費集金サービスの審査で参照される可能性が高い。

---

### Q3. LINE Pay終了後にLINEミニアプリで公式に案内されている決済手段

**公式の決済手段一覧（『決済システムを利用する』本文をそのまま）**

> 「LINEミニアプリで利用できる決済システムは、国または地域によって異なります。」

| 決済方法 | 日本 | 台湾 | タイ |
|---|:--:|:--:|:--:|
| LINE Pay | ❌ | ✅ | ✅ |
| LINEミニアプリのアプリ内課金 | ✅ | ❌ | ❌ |
| その他の決済方法 | ✅ | ✅ | ✅ |

> 「**日本国内におけるLINE Payのサービスを終了しました**
> 2025年4月30日をもって、日本国内におけるLINE Payのサービスを終了しました。なお、台湾、タイ現地のLINE Payのサービスは引き続き利用できます。」

> 「## その他の決済方法
> LINEミニアプリで上記以外の決済方法を提供するには、一般のウェブページで決済を提供して処理するのと同様に実装してください。なお、外部のドメインや外部のアプリで決済を完了した後、ユーザーがLINEミニアプリのページに戻るようにしてください。」

> 「## LINEミニアプリのアプリ内課金
> 「アプリ内課金とは、LINEミニアプリ内で提供するデジタルコンテンツを、ユーザーが購入できる仕組みです」。LINEアプリ内でLINEミニアプリを起動してデジタルコンテンツの購入を開始し、App StoreまたはGoogle Playの決済機構を利用して決済します。現在、アプリ内課金を利用できるのは日本のみです。」
— https://developers.line.biz/ja/docs/line-mini-app/develop/payment/index.html.md

**アプリ内課金（IAP）の適用範囲（＝本アプリには使えない根拠）**

- 対象商品は「消耗型（consumable）のみ」＝デジタルコンテンツ
- 「サービスを提供する地域」と「会社・事業者の所在国・地域」が両方とも日本
- **認証済ミニアプリであることが必須**
- LIFF SDK v2.26.0 以上、ユーザーは日本の電話番号登録とLINE 15.6.0以降
- 手数料は「所定の手数料がかかります」とのみ記載。料率はLINE Developersコンソールの［アプリ内課金］タブ内に表示され、公開ドキュメントには載っていない
— https://developers.line.biz/ja/docs/line-mini-app/in-app-purchase/overview/

アプリ内課金利用規約（https://terms2.line.me/LINE_MINI_App_IAP?lang=ja 最終改定日：2026年7月27日）は、対象を「有料アイテム、有料サービスおよびお客様のLINEミニアプリにおいてのみ利用可能なアプリ内通貨等」と定義し、「ユーザーが販売代金をアプリストアに支払った日」という表現でApp Store/Google Playの決済機構が前提であることを示している。手数料率は「本件手数料率は、本サービスの申込みを行う申込書、申込画面等に明記するもの」とされ、規約本文には記載がない。

**LINE Pay終了の公式発表**

> 発表日：2024年6月13日 / サービス終了日：2025年4月30日（水）
> 「国内の送金・決済サービス領域は『PayPay』に一本化」
— https://www.lycorp.co.jp/ja/news/release/008628/

**PayPay連携について（LINEミニアプリ向けの公式SDK連携は確認できず）**

LINEミニアプリのドキュメント上、PayPayは「その他の決済方法」に含まれるだけで、専用の連携手段は案内されていない。一方、プラットフォーム側では次の動きがある。

> 発表日：2026年7月2日。「2026年夏以降」にLINEとPayPayのアカウント連携を開始。「LINE」のトーク上で「PayPay残高」の「送金」および「グループでの割り勘」が利用できるようになる。「LINEポイント」は有効期限のない「PayPayポイント」へ移行できる。
— https://www.lycorp.co.jp/ja/news/release/020581/

これは本アプリの中核体験（グループの割り勘・集金）と正面から重なる。設計判断として無視できない。

---

### Q4. LIFF SDKとIDトークンのサーバー検証

**IDトークン検証エンドポイント**

- `POST https://api.line.me/oauth2/v2.1/verify`
- 必須：`id_token`（IDトークン）、`client_id`（「期待されるチャネルID。LINEプラットフォームが発行した、チャネル固有の識別子」）
- 任意：`nonce`（「認可リクエストに指定したnonceの値」）、`user_id`（「期待されるユーザーID」）
- レスポンス：`iss` / `sub`（ユーザーID）/ `aud`（チャネルID）/ `exp`・`iat`（「UNIX時間（秒）で返されます」）/ `nonce`（「認可リクエストにnonceの値を指定しなかった場合は含まれません」）/ `amr`（pwd, lineautologin, lineqr, linesso, mfa）/ `name`・`picture`（`profile`スコープ未指定なら含まれない）/ `email`（`email`スコープ未指定なら含まれない）
— https://developers.line.biz/ja/reference/line-login/

**LIFF側**

- `liff.init()`：「ページを開くたびに必ず初期化する必要があります」。初期化時にアクセストークンとIDトークンをLINEプラットフォームから取得する。
- `liff.login()`：外部ブラウザおよびLINE内ブラウザでのみ利用可。「LIFFブラウザ内でのLINEログインによる認可リクエストの動作は保証されません」。`redirectUri`が「エンドポイントURLで始まらない場合、ログイン処理に失敗」する。
- `liff.getIDToken()`：`openid`スコープが必要。IDトークンの有効期間は「発行から1時間」。
- `liff.getProfile()`：`profile`スコープが必要。「メインプロフィールのみ。ユーザーのサブプロフィールは取得できません」。
— https://developers.line.biz/ja/reference/liff/

**サーバーへ送ってよいもの/いけないもの（重要）**

> IDトークン（`liff.getIDToken()`）とアクセストークン（`liff.getAccessToken()`）はサーバーに送ってよい。サーバー側でLINEプラットフォームのエンドポイントに検証させて安全にプロフィールを取得する。
> 一方「`liff.getDecodedIDToken()`や`liff.getProfile()`で取得したユーザー情報を、LIFFアプリからサーバーに送信しないでください」。
> アクセストークンの検証は `GET /oauth2/v2.1/verify`＋チャネルIDと有効期限の確認、プロフィール取得は `GET /v2/profile`。
> 「ユーザーがLIFFアプリを閉じると、有効期間が経過していなくてもアクセストークンは無効になります。」
— https://developers.line.biz/ja/docs/liff/using-user-profile/index.html.md

**userIdのスコープ（プロバイダー単位）**

> 「同じプロバイダーの配下に作成することで、各チャネルでは同じユーザーに対し、同じユーザーIDが割り当てられます。」
— https://developers.line.biz/ja/docs/line-developers-console/best-practices-for-provider-and-channel-management/

→ LINEミニアプリチャネルとMessaging APIチャネル（LINE公式アカウント）を連携させたい場合は、同一プロバイダー配下に置く必要がある。プロバイダーを跨ぐと同じユーザーでも別のuserIdになる。

---

### Q5. shareTargetPicker / sendMessages / ブラウザ差 / ストレージ制約

**liff.shareTargetPicker()**

前提条件（原文）：

> 「シェアターゲットピッカーを利用するには、以下の手順に従って「情報利用に関する同意について」に同意する必要があります。この同意は、チャネルごとに必要です。
> 1. LINE Developersコンソールで、LIFFアプリを追加するLINEログインのチャネルを選択します
> 2. ［LIFF］タブの［シェアターゲットピッカー］をクリックすると、「情報利用に関する同意について」が表示されます
> 3. 表示された内容をよく読み、［上記の事項に同意する］をチェックし、［有効化］をクリックします」

送信先（原文）：

| 送信先の種類 | 選択できる送信先 |
|---|---|
| グループ | ユーザーが参加しているグループ。オープンチャットは含まれません。 |
| 友だち | ユーザーの友だち。ただし、LINE公式アカウントは「友だち」欄には表示されません。 |
| トーク | 一定期間内にメッセージの送受信があったトーク。グループ、ユーザー、トークルーム、LINE公式アカウントが含まれます。 |

> 「メソッドを呼び出す際に`options.isMultiple`プロパティに`false`を指定した場合は、「友だち」欄のみが表示され、友だちの中から1人のみを送信先として選択できます。」

> 「あらかじめ、`liff.isApiAvailable()`メソッドを実行することで、現在の環境でターゲットピッカーが利用可能であることを確認できます。」
> ```javascript
> if (liff.isApiAvailable("shareTargetPicker")) { liff.shareTargetPicker([{ type: "text", text: "Hello, World!" }]); }
> ```

友だち欄に表示されない条件（原文）：
- 「友だちが、LINEアプリの［設定］>［プライバシー管理］>［アプリからの情報アクセス］で［拒否］を選択している」
- 「友だちが「お互いに友だちの場合は許可」を選択しており、その友だちが送信元のユーザーを友だち追加していない」
- 「ユーザーがLINEアプリの友だちリストで、友だちを非表示にしている、またはブロックしている」

— https://developers.line.biz/ja/docs/liff/developing-liff-apps/index.html.md

APIリファレンス側の利用条件：「ユーザーがログイン状態」かつ「LINE Developersコンソールでシェアターゲットピッカーがオン」。外部ブラウザでは「シングルサインオン（SSO）によるログインセッションが必要」。送信できるメッセージはテキスト/画像/動画/音声/位置情報/テンプレート/Flex Message（URIアクションのみ）で最大5件（https://developers.line.biz/ja/reference/liff/ ）。

**LINEミニアプリでのシェア（カスタムアクションボタン）**

> 「LINEミニアプリでは、現在開いているページを友だちと共有できるアクションボタンが、（A）ヘッダーに用意されています。このアクションボタンはLINEによって実装されていてデフォルトで表示されますが、ボタンの動作やメッセージの内容は、カスタマイズできません。一方、（B）ボディにカスタムアクションボタンを実装すると、メッセージの内容をカスタマイズしてLINEミニアプリをシェアできます。」

> 「カスタムシェアメッセージは、Flex Messageのバブルコンテナを使用して作成します。Flex Messageのカルーセルコンテナは使用しないでください。」

> 「**LINEミニアプリのLIFF URLが変更されました**
> 2023年12月13日より、LINEミニアプリのLIFF URLが`https://miniapp.line.me/{liffId}`に変更されました。従来の`https://liff.line.me/{liffId}`にアクセスした場合も、引き続き当該のLINEミニアプリが開きます。そのため、発行済みのQRコードも引き続き利用可能です。」

フッター（F）にはLINEミニアプリのアイコン・名前・`https://vos.line-scdn.net/service-notifier/footer_go_btn.png` の「>」画像を入れ、トップページ `https://miniapp.line.me/{your-liffId}` へのURIアクションを設定することが必須。ボタン（E）は最大3個で、最低1つは詳細ページを表示すること。
— https://developers.line.biz/ja/docs/line-mini-app/develop/share-messages/index.html.md

**liff.sendMessages()**

> 使用可能な文脈：「1対1のトーク、グループトーク、または複数人トークから起動したLIFFアプリ」の「LIFFブラウザ内」のみ。必須条件：`chat_message.write`スコープが有効。条件を満たさない場合エラーコード`403`が発生。最大5件。
— https://developers.line.biz/ja/reference/liff/

→ **パーマネントリンクやシェアメッセージから開かれたLIFFアプリでは `sendMessages` は使えない。** 集金リンクの導線では実質使えないと考えるべき。

**ブラウザの差**

> 「LIFFブラウザ」：LINEアプリ内に組み込まれた専用ブラウザ。iOSではWKWebView、AndroidではAndroid WebViewを使用。
> 「外部ブラウザ」：Microsoft Edge、Google Chrome、Firefox、Safariの最新版に対応。
> 機能差の例：「liff.scanCode()は、外部ブラウザでは利用できません。」
> 「LIFFアプリは、OS、LINEともに最新バージョンの環境での利用を推奨します」
— https://developers.line.biz/ja/docs/liff/overview/

**Cookie / localStorage / sessionStorage**

> 「LIFFアプリではcookie、localStorage、またはsessionStorageを利用できますが、OSの仕様変更によって将来的に利用が制限される可能性があります。」
> 「ユーザーの同意なく、cookie、localStorage、またはsessionStorageを使ってユーザーをトラックしたり、LINEのユーザー情報と外部セッション情報を結びつけたりしてはいけません。」
— https://developers.line.biz/ja/docs/liff/development-guidelines/index.html.md （WebFetchでは要約形式で返却。上記2文は検索結果本文と一致した記述）

同ガイドラインのその他の要件（[要約]）：LIFFアプリと内部コンテンツはHTTPS必須（HTTPコンテンツはLINE内ブラウザで表示されLIFF機能が使えない）／位置情報・カメラ・マイクなどのデバイスAPIは「ユーザー操作をきっかけにして実行されるように実装」／SPAはフラグメントルーティングではなくHistory APIを使う／LIFF URLでの負荷試験や大量APIリクエストは禁止（超過時 `429 Too Many Requests`）／連携解除時は認可解除エンドポイントを呼ぶこと。

**iOS/AndroidのLINEバージョン依存**：`shareTargetPicker` の最低LINEバージョンは一次資料で特定できなかった（`liff.isApiAvailable()` での実行時判定が公式の推奨手段）。アプリ内課金については「ユーザーは日本の電話番号登録とLINE 15.6.0以降が必須」と明記あり。

---

### Q6. チャネル構成、開発/本番の分離、エンドポイントURL要件、料金、サービスメッセージ

**チャネル構成**

> 「LINEミニアプリチャネルは、LINEミニアプリポリシーにおける「本サービスのご利用対象者」であれば、どなたでも作成できます。」

> 「LINE Developersコンソールの［チャネル設定］タブでは、LINEミニアプリチャネルは1つに見えますが、内部では以下の3つのチャネル（以降、内部チャネル）で構成されています。」
> - 「開発用LINEミニアプリチャネル：開発用に使用するLINEミニアプリチャネルです。チャネルステータスは常に「開発中」です。」
> - 「審査用LINEミニアプリチャネル：LINEヤフー株式会社による審査の際に使用するLINEミニアプリチャネルです。チャネルステータスは常に「開発中」です。」
> - 「本番用LINEミニアプリチャネル：ユーザーに対して本番公開されるLINEミニアプリチャネルです。チャネルステータスは常に「公開中」です。」

> 「LINEミニアプリ用として提供されるAPIは、LIFF APIとサービスメッセージAPIの2種類があります。」

> 「ステータスが「審査前」または「審査中」のLINEミニアプリでは、ベーシック認証が利用できます。」（［ウェブアプリ設定］タブの［開発用］または［審査用］の［エンドポイントURL］にベーシック認証のかかったURLを指定する）
— https://developers.line.biz/ja/docs/line-mini-app/develop/develop-overview/

**LIFF IDの分離とコンソールの制約**

> 「内部チャネルごとにLINEミニアプリ（LIFFアプリ）が1つずつ追加されています。内部チャネルごとに異なる［LIFF ID］を確認し、［エンドポイントURL］を指定して、各エンドポイントURLにLIFFアプリをデプロイしてください。」
> 「LINEミニアプリチャネルの［ウェブアプリ設定］タブでは、デフォルトで追加されているLINEミニアプリ（LIFFアプリ）以外のLIFFアプリを追加することはできません。」
> 「LINEミニアプリチャネルの［ウェブアプリ設定］タブでは、Scope、友だち追加オプションなどの設定をLIFFアプリ（内部チャネル）ごとに変更することはできません。」
> 「LINEミニアプリチャネルの［ウェブアプリ設定］タブでは、［モジュールモード］は設定できません。」
> 「LINEミニアプリが認証済ミニアプリの場合、チャネル名やLIFFアプリのScope、友だち追加オプションなど、LINE Developersコンソールで設定を変更した場合、開発用の設定のみが変更されます。」
— https://developers.line.biz/ja/docs/line-mini-app/discover/console-guide/index.html.md

**エンドポイントURLの要件**

> 「URLスキームはhttpsである必要があります。なお、URLフラグメント（#URL-fragment）は指定できません。」
> LIFF IDの例：`1234567890-AbcdEfgh` / LIFF URLの例：`https://liff.line.me/1234567890-AbcdEfgh`（LINEミニアプリは `https://miniapp.line.me/{liffId}`）
> サイズは `Compact`、`Tall`、`Full` の3種類。
— https://developers.line.biz/ja/docs/liff/registering-liff-apps/

**サービスメッセージ**

> 「この機能は、認証済ミニアプリでのみ利用できます」
> 「サービスメッセージは、LINEミニアプリ上でのユーザーの操作（アクション）に対する確認や応答としてのみ送信できます」
> 「値下げ、ショッピング特典、新商品、割引クーポン、プロモーションなどの情報を含む広告やイベントの通知は禁止されています」
> 「最大5回まで送信できます」（同一操作に対して）
> 「サービス通知トークンは、発行から1年間（31,536,000秒間）有効」
> 表示先：日本は「LINEミニアプリ お知らせ」、タイは「LINE MINI App Notice」、台湾は「LINE MINI App 通知」
> トークン：「ステートレスチャネルアクセストークンの使用を推奨します」。長期トークンおよびv2.1は使用不可。
> エンドポイント：トークン発行 `POST /notifier/token`、送信 `POST /notifier/send?target=service`
> テンプレートはチャネルごとに最大20個。6言語（日本語、英語、繁体字中国語、タイ語、インドネシア語、韓国語）。
> 「手順1でLINEミニアプリチャネルに追加したサービスメッセージテンプレートをサービスメッセージを送るAPIで利用するには、LINEヤフー株式会社による審査を通過する必要があります」
> 後続送信は前回レスポンスの `notificationToken` を使い、新規発行してはいけない。`remainingCount` で残回数を確認する。
— https://developers.line.biz/ja/docs/line-mini-app/develop/service-messages/index.html.md

**チャネル同意の簡略化**

> 「「チャネル同意の簡略化」機能とは、ユーザーがLINEミニアプリに初めてアクセスする際に必要となる、権限への同意を簡略化する仕組みです。」
> 「「チャネル同意の簡略化」機能の対象となる権限は、ユーザーIDの取得（`openid`スコープ）のみです。」
> 適用条件：認証済ミニアプリであること（未認証は開発用・審査用のみ対応）、LIFF SDK v2.13.x以降、LIFF間遷移で開かれていないこと。
> 注意点：IDトークン検証を用いた設計では、この機能によりプロフィール情報がトークンペイロードに含まれなくなる可能性がある。回避策として `liff.permission.query()` と `liff.permission.requestAll()` で必要な権限を事前要求することが推奨される。
— https://developers.line.biz/ja/docs/line-mini-app/develop/channel-consent-simplification/index.html.md

**料金**：LINEミニアプリのプラットフォーム利用料について、明記した一次資料は見つけられなかった（未確認事項参照）。

---

## 未確認事項

1. **未認証ミニアプリの利用者数上限**：`site:developers.line.biz` で「未認証ミニアプリ 制限 利用者数」を検索したが、上限を定める一次資料は見つからなかった。二次記事には言及があるが、一次資料で裏取りできていない。
2. **LINEミニアプリのプラットフォーム利用料（無料枠）**：https://developers.line.biz/ja/services/line-mini-app/ と https://www.lycbiz.com/jp/service/line-mini-app/ を実際に開いたが、どちらにも料金の明記がなかった。「無料」と書かれた一次資料を確認できていない。サービスメッセージがLINE公式アカウントのメッセージ通数にカウントされるか否かも、一次資料で確認できていない。
3. **LINEミニアプリチャネルでのシェアターゲットピッカー有効化の具体的なコンソール手順**：シェアターゲットピッカーの前提条件は「LINEログインのチャネル」の［LIFF］タブ手順として書かれており、LINEミニアプリチャネルのコンソールガイドには「シェアターゲットピッカー」の語が出てこなかった。ミニアプリ側はカスタムアクションボタンのドキュメントで shareTargetPicker の利用を明確に指示しているので利用可能と考えられるが、有効化手順の一次資料は特定できていない。
4. **shareTargetPicker が動作する最低LINEバージョン**：一次資料に記載を見つけられなかった。公式の推奨は `liff.isApiAvailable("shareTargetPicker")` による実行時判定。
5. **アプリ内課金の手数料率**：規約・ドキュメントとも「所定の手数料」「申込書、申込画面等に明記する」とのみ記載。コンソールの［アプリ内課金］タブでしか確認できない。
6. **「有料サービスの販売」の解釈範囲**：ポリシーの「有料アイテム、有料サービス等を販売するためには…アプリ内課金機能を利用しなければなりません」が、現実世界の役務（飲み会の会費など）を含むのか、デジタルコンテンツに限定されるのかは、ポリシー本文だけでは断定できない。アプリ内課金の対象が「消耗型のデジタルコンテンツ」に限定されていることから後者と読むのが自然だが、審査照会が必要。
7. **LINEミニアプリで第三者の資金決済を仲介する行為の可否**：ポリシーにP2P送金の明文禁止は見当たらなかったが、明文の許可もない。認証審査基準の「法令における規制への抵触の有無」に該当するため、mini_request@linecorp.com 等への事前照会が必要。
8. **LINE×PayPayアカウント連携（2026年夏以降）の開発者向けAPI提供有無**：プレスリリースはユーザー向け機能のみの発表で、第三者アプリ向けAPIの記載はなかった。

---

## 本アプリ設計への含意

1. **LINEミニアプリ配布は可能。ただし運営主体はNonTurn LLC（法人）に固定される。** 認証済ミニアプリの利用対象者は法人番号を持つ組織か日本の個人事業主のみ。一般個人の幹事が自分のミニアプリを持つ構成は成立しない。「運営者が1つのミニアプリを提供し、幹事はその中のユーザー」という構成が唯一。これは資金の受取経路（幹事の口座へ直接か、運営者を経由するか）の設計問題を最初に解く必要があることを意味する。
2. **決済は外部決済で組む。** LINEミニアプリのアプリ内課金は消耗型デジタルコンテンツ専用なので、会費集金には使えない。公式に「その他の決済方法」が日本で✅であり、「一般のウェブページで決済を提供して処理するのと同様に実装してください」と明記されているため、Stripe Checkout等をLIFF内/外部ブラウザで開く実装はLINE側の規約上ブロックされない。ただし「外部のドメインや外部のアプリで決済を完了した後、ユーザーがLINEミニアプリのページに戻るようにしてください」という復帰要件があるので、`success_url` は必ずミニアプリのパーマネントリンクに戻す。なお、Stripe側で個人間送金が禁止されている問題（引継ぎ書[S1]）はLINE側の話とは別で、依然として未解決である。
3. **LINE Payは選択肢から完全に外れる（日本）。PayPay連携も現時点では「その他の決済方法」扱い。** PayPayを使うなら加盟店としてのPayPay（オンライン決済）を自前で契約する話になり、「幹事の個人PayPayへ送る」という当初要件とは別物。引継ぎ書4-1の結論（個人PayPay着金を外部アプリから検知する正規APIは未確認）を覆す材料は、LINE側の一次資料からは何も出なかった。
4. **2026年夏以降のLINE×PayPay連携は事業判断に直結する。** LINEのトーク上でPayPay残高の送金とグループでの割り勘が標準機能として提供される。幹事の会費集金という中核ユースケースが、LINE本体の機能で満たされる可能性が高い。差別化は「参加者リストと請求額の管理」「支払状況の自動照合と可視化」「複数イベント管理」といった台帳側に寄せるべきで、送金手段そのもので勝負しない設計にする。
5. **支払完了の通知手段はサービスメッセージ一択だが、認証審査が前提。** 未認証ミニアプリではサービスメッセージが使えない。「支払いました」の確認通知や未払いリマインドをLINEで送るなら、認証済ミニアプリになる必要がある。しかもサービスメッセージは「ユーザーの操作に対する確認や応答としてのみ」で、1アクションあたり最大5回。**幹事から未払い者への催促は「その参加者自身の操作」ではないので、サービスメッセージでは送れない可能性が高い。** 催促は shareTargetPicker による幹事の手動シェア、またはLINE公式アカウント（Messaging API、有料通数）での配信を前提に設計する。
6. **参加者の識別はIDトークンのサーバー検証で行う。** `liff.getIDToken()` → サーバー → `POST https://api.line.me/oauth2/v2.1/verify`（`id_token` + `client_id`、可能なら `nonce`）。`liff.getProfile()` / `liff.getDecodedIDToken()` の結果をサーバーに送るのは公式に禁止されている。IDトークンの有効期間は1時間なので、自前のセッションを発行して以後はそれを使う。
7. **プロバイダー設計を最初に確定する。** userIdはプロバイダー単位で共通。LINEミニアプリチャネルとMessaging APIチャネルを同一プロバイダーに置かないと、同じ人が別IDになり支払照合が壊れる。後から移せないので初期設定で誤ると作り直しになる。
8. **開発/本番の分離はLINEの内部チャネル機構に従う。** 1つのミニアプリチャネルが開発用・審査用・本番用の3内部チャネルを持ち、それぞれ別のLIFF IDと別のエンドポイントURLを持つ。よって環境変数は `LIFF_ID` を環境ごとに切り替える設計にする。ただしScopeや友だち追加オプションは内部チャネルごとに変えられないので、権限設計は3環境で共通になる。審査前はベーシック認証をかけたURLを指定できる。
9. **ストレージ前提を弱くする。** LIFFブラウザは iOS WKWebView / Android WebView。cookie・localStorage は「OSの仕様変更によって将来的に利用が制限される可能性があります」と公式に予告されている。支払状態や認証状態をクライアントストレージに依存させず、サーバー側の真実を毎回取得する設計にする。加えて「ユーザーの同意なく…LINEのユーザー情報と外部セッション情報を結びつけたりしてはいけません」という規定があるので、プライバシーポリシーと同意取得の導線を最初から入れる。
10. **`liff.sendMessages()` は集金導線で使えない前提で設計する。** これはトークルームから起動されたLIFFアプリでのみ動く。集金リンク（パーマネントリンク）から開かれたケースでは403になる。参加者への配布は `liff.shareTargetPicker()`（要：チャネルごとの同意有効化、ログイン済み、`liff.isApiAvailable()` でのフォールバック）とQR/URLコピーの2系統を用意する。
11. **審査で問われるポリシー条項を先回りする。** 禁止業種「募金、寄附、クラウドファンディング等の資金調達」と禁止事項「チャリティまたは募金として寄付金を収集する目的の内容」に触れないよう、サービス定義を「幹事が管理する精算・集金の台帳」として明確化し、寄付・募金・クラファンの文脈を排する。さらに「主な機能はLINEミニアプリ内で提供される必要があります」という要件があるため、名簿管理・支払状況表示・イベント管理はミニアプリ内で完結させ、外部へ出るのは決済画面だけにする。認証審査申請前の相談窓口（ポリシーに記載あり、mini_request@linecorp.com がカスタムシェアメッセージの相談窓口として明記）に、決済モデルを事前照会する。
12. **HTTPS必須・URLフラグメント不可・History APIルーティング。** Next.js等のSPAを使う場合、ハッシュルーティングは使えない。エンドポイントURLはhttpsのみ。

---

## 参照URL一覧（全てWebFetchで本文取得済み）

1. https://developers.line.biz/ja/docs/line-mini-app/discover/introduction/
2. https://developers.line.biz/ja/docs/line-mini-app/discover/introduction/index.html.md
3. https://developers.line.biz/ja/docs/line-mini-app/discover/custom-features/
4. https://developers.line.biz/ja/docs/line-mini-app/submit/submission-guide/
5. https://terms2.line.me/LINE_MINI_App?lang=ja （LINEミニアプリポリシー・最終改定日2026年2月19日）
6. https://terms2.line.me/LINE_MINI_App_IAP?lang=ja （LINEアプリ内課金利用規約・最終改定日2026年7月27日）
7. https://developers.line.biz/ja/docs/line-mini-app/develop/payment/index.html.md
8. https://developers.line.biz/ja/docs/line-mini-app/in-app-purchase/overview/
9. https://developers.line.biz/ja/docs/line-mini-app/in-app-purchase/implement-in-app-purchase/
10. https://www.lycorp.co.jp/ja/news/release/008628/ （LINE Pay終了・2024年6月13日発表）
11. https://www.lycorp.co.jp/ja/news/release/020581/ （LINE×PayPayアカウント連携・2026年7月2日発表）
12. https://developers.line.biz/ja/reference/line-login/
13. https://developers.line.biz/ja/reference/liff/
14. https://developers.line.biz/ja/reference/liff/index.html.md
15. https://developers.line.biz/ja/docs/liff/using-user-profile/index.html.md
16. https://developers.line.biz/ja/docs/liff/developing-liff-apps/index.html.md
17. https://developers.line.biz/ja/docs/liff/overview/
18. https://developers.line.biz/ja/docs/liff/registering-liff-apps/
19. https://developers.line.biz/ja/docs/liff/development-guidelines/index.html.md
20. https://developers.line.biz/ja/docs/line-mini-app/develop/develop-overview/
21. https://developers.line.biz/ja/docs/line-mini-app/discover/console-guide/index.html.md
22. https://developers.line.biz/ja/docs/line-mini-app/develop/service-messages/index.html.md
23. https://developers.line.biz/ja/docs/line-mini-app/develop/share-messages/index.html.md
24. https://developers.line.biz/ja/docs/line-mini-app/develop/channel-consent-simplification/index.html.md
25. https://developers.line.biz/ja/docs/line-developers-console/best-practices-for-provider-and-channel-management/
26. https://developers.line.biz/ja/docs/line-mini-app/service/service-operation/index.html.md
27. https://developers.line.biz/ja/services/line-mini-app/ （料金の記載なしを確認）
28. https://www.lycbiz.com/jp/service/line-mini-app/ （料金の記載なしを確認）
