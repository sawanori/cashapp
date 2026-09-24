# 競合/近接機能の実態調査：PayPayグループ支払い・LINE内送金・Kyash・Peatix等

調査日：2026-09-24 ／ 調査者：決済・プラットフォーム規約リサーチャー（サブエージェント）
対象：幹事向け会費集金アプリ（参加者リスト＋支払い自動チェック、LINEミニアプリ配布、受取先は幹事の個人PayPay希望）

---

## 結論

本アプリが解こうとしている「参加者リスト＋支払いの自動チェック」は、**PayPayの「グループ支払い」と Peatix の参加者管理によって、無料またはほぼ無料で既に提供されている**。PayPayは20名までのグループに対して一人ひとり異なる金額を請求でき、送金手数料は無料で、公式ページは「幹事の方は誰が支払ったか確認できる」と明記している（[出典](https://paypay.ne.jp/promo/p2p/)）。Peatixは参加者一覧に「支払い済み／支払い待ち／期限切れ／キャンセル済み」の状態を表示し、CSV出力とチェックインまで備える（[出典](https://help-organizer.peatix.com/ja-JP/support/solutions/articles/44001821753)）。つまり機能面の空白はほとんど無い。

さらに決定的なのは規制である。2020年の資金決済法改正で、**受取人が個人（事業としてでない）である収納代行、すなわち「割り勘アプリ」は為替取引に該当することが法文上明示された**（資金決済法第2条の2第1号、資金移動業者に関する内閣府令第1条の2）。第三者のアプリが参加者から金を受け取って幹事個人に渡す設計は、原則として資金移動業の登録（全国で84業者しかない）を要する。登録を避ける現実的な道は、内閣府令第1条の2第3号のイ（エスクロー）またはロ（契約の成立に不可欠な関与＝プラットフォーム）に該当しない構成を取ること、すなわち**アプリ自身が資金に触れない設計**にするか、**利用規約で取引成立条件を定めるプラットフォームになる**かのいずれかである。

受取先を「幹事の個人PayPay」にする当初案は、二方向から塞がれている。第一に、PayPay加盟店の申込資格は「実店舗のある法人様・個人事業主様」であり、非事業者の個人幹事は加盟店になれない（[出典](https://paypay.ne.jp/store/faq/)）。第二に、一般個人のPayPayアカウントに届く送金を第三者アプリが照会するAPIは、本調査でも発見できなかった（引継ぎ書[S4][S5]の結論は覆らなかった）。

Stripeについては引継ぎ書の警戒が正しい。Stripeの禁止業種には「ピアツーピアの送金」が明記されている（[出典](https://stripe.com/jp/legal/restricted-businesses)、最終更新2026-09-22）。またPayPay概要ページは「Connect のサポート：いいえ」、決済手段対応表はPayPay行に「✓ サポート対象 8」＋脚注8「Connect を使用するには、招待をリクエストしてください」と、**資料間の記載差が2026-09-24時点でも解消されていない**。

LINE内で完結する送金は、LINE Pay終了（2025-04-30）後は**PayPayの「送る・受け取る」がトークルームに組み込まれた形だけ**が残っている。ただしグループトークでは「同じ金額の請求のみ対応可能」という制約があり、参加者ごとに金額が異なる集金はLINEのグループトーク内では完結しない。ここが唯一、本アプリが客観的に指摘できる隙間である。

---

## 問いごとの回答

### 問1. PayPay「グループ支払い」「送金を依頼」の詳細仕様

**a) 人数上限：20名**

> 「一つのグループに参加できる人数は20名までです。」
> — PayPayヘルプ「グループチャットを利用したい」 https://paypay.ne.jp/help/c0224/

2022-09-07の告知でも「家族や友人、仕事仲間など最大20名のユーザーとさまざまな用途に応じたグループを簡単に作ることができます」とされ、必要バージョンは「PayPayアプリ v3.54.0以降」。
https://paypay.ne.jp/notice/20220907/f-group/

**b) 金額調整と支払い状況の可視化：どちらも公式に可能と明記**

> 「一人ひとり異なる金額を設定できる」
> 「幹事の方は誰が支払ったか確認できる」
> 「グループの複数精算も一目でわかる」
> — PayPay「『送る』『受け取る』ならPayPayで」 https://paypay.ne.jp/promo/p2p/

英語プレスリリース（2023-04-24、Group Bill 提供開始）も同旨。

> "allows users to conveniently use the group chat within the 'Send/Receive' feature to split a bill among friends" / users can "set the amount to be paid by each member of the group" / the feature lets users "see which members have already paid, preventing missed payments."
> — https://about.paypay.ne.jp/en/pr/20230424/02/

なお旧「わりかん」機能は終了している。

> 「2023/5/31をもって「わりかん」機能は終了いたしました。」
> — PayPayヘルプ https://paypay.ne.jp/help/c0099/

**c) 手数料：無料**

> 「何度でも手数料無料」「1円単位で金額指定可能」「24時間365日いつでも使える」
> — https://paypay.ne.jp/promo/p2p/

**d) 作成者資格・本人確認**

請求リンクの作成には本人確認が必要。

> 「請求リンクを作成するには、本人確認が必要です」
> — https://paypay.ne.jp/promo/p2p/

送金上限は本人確認未完了で1度に最大10万円、完了で最大30万円（同ページ）。「PayPayマネー」を送るには本人確認完了が必須で、受取側が本人確認未完了だと「PayPayマネーライトでの受け取り」になり銀行口座へ出金できない（https://paypay.ne.jp/help/c0006/）。受取側もPayPayアプリのインストールとアカウント登録が必要（https://paypay.ne.jp/guide/receive/）。

**e) 本アプリの中心要件をどこまで満たすか**

参加者リスト（グループ＝最大20名）、個別金額、支払済みの可視化、手数料ゼロ、という**中心要件はすでにPayPay単体で満たされている**。満たされないのは、①21名以上、②PayPayアプリ未導入者の取り込み、③イベントを跨いだ複数集金の台帳管理、④締切・リマインドの自動化（公式ヘルプに記載を確認できず＝未確認）、の4点に限られる。

### 問2. LINEアプリ内の送金/割り勘の現状

**a) LINE Payは日本国内で終了済み**

> 「国内の送金・決済サービス領域は『PayPay』に一本化し、国内における『LINE Pay』サービスを終了することとしました。」
> — LINEヤフー株式会社 2024-06-13発表 https://www.lycorp.co.jp/ja/news/release/008628/

同発表で残高送金・送付は2024年9月上旬に終了、サービス全体は2025-04-30までに順次終了と示されている。LINEミニアプリの開発者ドキュメントにも「2025年4月30日をもって、日本国内におけるLINE Payのサービスを終了しました」と反映済み（https://developers.line.biz/ja/docs/line-mini-app/develop/payment/）。

**b) 現在LINE内に残っているのはPayPayの「送る・受け取る」**

2024-10-15にLINEトークルームからPayPayの送る・受け取るが使えるようになった。

- 前提：「LINEのバージョン14.16.0以上」「PayPayアプリのバージョン4.64.0以上」
- ID連携：「ユーザーは、『LINE』と『PayPay』のID連携をする必要はなく」
- 請求：トークルームから支払いのリクエスト送信が可能
- **グループトークの制約：「グループトーク内のメンバーに対して、同じ金額の請求のみ対応可能」**
- 非対応：「オープンチャット、LINE公式アカウント、デスクトップ版『LINE』では対応していない」

— https://www.lycorp.co.jp/ja/news/release/009440/ ／ 英語版 https://about.paypay.ne.jp/en/pr/20241015/01/（"only requests for the same amount to members of the group chat are supported"）

**含意：** 参加者ごとに金額が違う集金（学生/社会人で会費が違う、遅刻者だけ減額、など）は**LINEのグループトーク内では完結せず、PayPayアプリ側のグループ支払いへ遷移する必要がある**。これが「LINE内完結」軸で残る唯一の隙間。

### 問3. Kyash・楽天ペイ・au PAY・d払いの個人間送金に「請求」「グループ集金」「支払い状況一覧」はあるか

| サービス | 個人間送金 | 請求（相手に支払わせる） | 複数人への一括請求 | 支払い状況の一覧 |
|---|---|---|---|---|
| Kyash | あり（アカウント間は手数料無料・リアルタイム） | あり | **あり（最大10人）** | 公式ヘルプに記載を確認できず（未確認） |
| 楽天ペイ | あり（楽天キャッシュ） | あり（2024-10-10追加／QRまたはURL） | 記載なし（未確認） | 記載なし（未確認） |
| au PAY | あり（au PAY マネーのみ） | 受取用QR/URLの作成はあり | 記載なし（未確認） | 記載なし（未確認） |
| d払い | あり | 公式ガイドに請求機能の記載なし | 記載なし | 記載なし |

**Kyash**

> 「※最大10人まで選択可能です。」
> 「請求を受け取るためには、請求した相手が『本人確認アカウント』の必要があります」
> — Kyash HELP「複数人への請求方法」 https://help.kyash.co/--67bd581478037e1a3ae2d521

> 「Kyashアカウント同士なら、いつでも送金手数料無料でリアルタイムに送金したり受け取ったりできます。」
> — https://www.kyash.co/

Kyashは2020-08-27に資金移動業登録を完了（関東財務局長第00082号）。
https://www.kyash.co/press-release/20200827

**楽天ペイ**

> 「受け取る側は、送ってほしい金額をQRコードで相手に読み取ってもらうか、URLリンクを共有することで、楽天キャッシュを簡単に送ってもらうことができます。」
> — 楽天ペイメント 2024-10-10 https://payment.rakuten.co.jp/news/2024101000/

リンク有効期限は受け取り用3日間、請求用2週間（https://pay.rakuten.co.jp/guide/cash/send_receive/）。複数人一括請求・支払い状況一覧の記載は確認できなかった。

**au PAY**

> 送金利用にはau PAYアプリ上での本人確認完了、またはauじぶん銀行との口座連携が必須。受け取り側は本人確認不要だが「受取り用QRコード・URL作成の際は必要となります」。
> — https://wallet.auone.jp/contents/sp/guide/moneytransfer.html

送金できるのは「au PAY マネー」のみで、通信料金合算・クレジットカード・ギフトカードでチャージした「au PAY マネーライト」は送金・出金不可。請求機能や割り勘機能の記載は同ページに無い。

**d払い**

> 「送金・受け取りは、何度でも手数料無料です。」「1か月あたりの送金限度額は合計20万円」
> — https://service.smt.docomo.ne.jp/keitai_payment/guide/wallet/remit.html

送金には本人確認とd払い残高へのチャージが必要。同ガイドに請求機能・割り勘機能の記載は無い。

**結論：** 「請求」まで持つのはPayPay・Kyash・楽天ペイ。**「参加者リスト＋支払い状況の一覧」という幹事向けの台帳UIを公式に打ち出しているのはPayPayのグループ支払いのみ**。Kyashは10人一括請求ができるが、幹事向け台帳としての支払い状況一覧は公式ヘルプで確認できなかった。

### 問4. Peatix / PassMarket / connpass の個人主催者向け集金の実態

**Peatix（現役・最有力の近接サービス）**

- 主催者資格：「個人・法人を問わず、契約書の締結などの手続きなく、アカウント登録をしたら」利用可能（https://help-organizer.peatix.com/ja-JP/support/solutions/articles/44001821715）
- 費用：初期登録料・月額費無料。有料チケットのみ「販売実績の4.9%＋売れたチケット1枚につき99円」、振込手数料210円は主催者負担（https://help-organizer.peatix.com/ja-JP/support/solutions/articles/44001821779）
  - 公式計算例：2,000円×10枚＝20,000円 → 決済処理費用1,970円＋振込手数料210円 → 振込額17,820円（実質約10.9%）
- 入金：イベント終了後5営業日以内に振込手続き（複数日イベントは最終日以降5営業日以内）（https://help-organizer.peatix.com/ja-JP/support/solutions/articles/44001821780）
- **参加者管理：氏名（カナ）、券種別枚数、支払金額、支払い状況、申込日を表示。支払い状況は「支払い済み」「無料」「支払い待ち」「期限切れ」「キャンセル済み」。CSVダウンロードと当日チェックインに対応**（https://help-organizer.peatix.com/ja-JP/support/solutions/articles/44001821753）
- 制約：「Peatixを通して登録していない参加者は参加者一覧に追加できない」＝参加者側にPeatixアカウント登録の負担がある

**PassMarket（終了済み）**

passmarket.yahoo.co.jp は現在 thanks.yahoo.co.jp（「お客様がアクセスされたサービスは本日までにサービスを終了いたしました。」）へ301リダイレクトされ、主催者向け手数料ページも同様に失われている。終了日は2026-06-30、発表は2025-12-17と報じられている（ITmedia NEWS https://www.itmedia.co.jp/news/articles/2512/17/news116.html ／ 一次告知ページはリダイレクトにより本文取得不可）。
**含意：日本のイベント集金市場は直近で1プレイヤー減っており、Peatixへの集中が進んでいる。**

**connpass**

> connpassの有料（前払い）イベント作成手数料は無料。ただしPayPal所定の決済手数料（通常「決済1件につき、決済代金の3.6%+40円」）が発生。
> 「参加者がPayPalで決済すると、PayPal所定の手数料を差し引いた金額が、即座にイベント主催者のPayPalアカウントに振り込まれます。」
> 「connpassでは、払い戻し機能は提供しておりません。」
> — https://help.connpass.com/organizers/paid-event-edit

主催者はPayPalのパーソナル／ビジネスどちらでも可だが「本人確認手続きが完了している必要があります」。**connpassは資金を預からず、PayPal加盟店である主催者に即時着金する構造**であり、本アプリが取りうる「アプリは資金に触れない」設計の実例になっている。

### 問5. 6軸比較表と、本アプリが埋められる隙間

凡例：◎＝主要機能として公式に提供、○＝可能だが制約あり、△＝一部のみ、×＝提供されていない／確認できず

| 軸 | PayPayグループ支払い | LINEトークルーム内PayPay | Kyash | Peatix | connpass | 本アプリ（構想） |
|---|---|---|---|---|---|---|
| 幹事の負担 | ◎ グループ作成→金額入力→送信の3手順。個別金額可 | ○ 1対1は任意額、グループは同額のみ | ○ 最大10人へ一括請求 | △ イベント作成・券種設定・口座登録が必要 | △ イベント作成＋PayPalアカウント準備 | 未確定（少なくともPayPay以下にはできない） |
| 参加者の登録/インストール負担 | △ 全員にPayPayアプリと（受取側は）本人確認 | △ LINEは既存だがPayPayアプリは必要 | × 全員にKyashアカウント。受取に本人確認 | △ Peatixアカウント登録が必要 | △ connpassアカウント＋PayPal | 未確定 |
| 自動照合（支払済みチェック） | ◎ 「誰が支払ったか確認できる」 | × 一覧UIなし | 未確認（公式記載なし） | ◎ 支払い済み/支払い待ち/期限切れ/キャンセル済み＋CSV | ○ 参加者管理あり（詳細未確認） | これが要件 |
| 受取先 | 幹事のPayPay残高（即時） | 同左 | Kyash残高（出金は本人確認要） | 登録した銀行口座（イベント終了後5営業日以内） | 主催者のPayPalへ即時 | 個人PayPayは不可（後述） |
| 手数料 | 0円 | 0円 | 0円（アカウント間） | 4.9%＋99円/枚＋振込210円 | PayPal 3.6%＋40円 | 決済事業者の料率＋自社分 |
| LINE内完結 | × PayPayアプリへ遷移 | ○ ただしグループは同額のみ | × | × | × | ミニアプリなら○（ただし決済は外部遷移） |

**本アプリが客観的に埋められる隙間（3つだけ）**

1. **LINEグループトークで「参加者ごとに異なる金額」を請求する導線。** LINE公式の制約が一次資料で確認できており（「同じ金額の請求のみ対応可能」）、ここは事実として空いている。
2. **21名以上のイベント。** PayPayのグループは20名上限、Kyashの一括請求は10人上限。100人規模の同窓会・サークル合宿はPayPay単体では割れる。
3. **複数イベント・複数決済手段を跨ぐ台帳。** PayPayもKyashも「今回の精算」単位であり、幹事が年に何度も集金する場合の横断台帳は提供されていない。Peatixはそれに近いがイベント公開・券種・振込口座という重さがある。

**埋められない理由（客観）**

1. **受取先を個人PayPayにはできない。** PayPay加盟店の申込資格は「実店舗のある法人様・個人事業主様」（https://paypay.ne.jp/store/faq/）。非事業者の個人幹事は加盟店になれず、加盟店決済の正規APIで取引照会する道は最初から閉じている。一般個人アカウント宛の送金を第三者が照会するAPIも発見できなかった。
2. **アプリが資金を通すと資金移動業になる。** 資金決済法第2条の2第1号＋資金移動業者に関する内閣府令第1条の2により、受取人が個人（事業としてでない）の収納代行は為替取引に該当する。金融庁は「収納代行の形式をとりつつも、実質的には受取人が個人（消費者）である送金と認められるような行為について、為替取引に該当することを明確化しています」と回答している（令和2年改正パブコメ No.86）。資金移動業者は全国84社（令和8年7月31日現在）で、個人開発者が取得できる登録ではない。
3. **手数料でPayPayに勝てない。** PayPay・LINE内PayPay・Kyashはいずれも送金手数料0円。決済事業者を通す本アプリは最低でもPayPay/カードの加盟店手数料が乗るため、「無料の既存機能より高い」という不利は構造的に消せない。
4. **参加者のインストール負担も減らせない。** PayPayで払わせるなら結局PayPayアプリが要る。LINEミニアプリは「ユーザーはアプリをインストールせずにサービスを利用できます」（https://developers.line.biz/ja/docs/line-mini-app/discover/introduction/）が、その先の決済でウォレットアプリが必要になる点は変わらない。

---

## 未確認事項

- PayPayグループ支払いの「締切設定」「催促通知」「作成後の金額変更」「対応OSバージョン（v3.54.0以降以外の条件）」：公式ヘルプで記載を確認できなかった。
- PayPay送金リンク／請求リンクの有効期限：公式ガイドに記載が見当たらない。
- Kyashの複数人請求における個別金額設定の可否と、幹事向け支払い状況一覧UIの有無：support.kyash.co が HTTP 403 でフェッチ不可。help.kyash.co の該当記事には記載なし。
- 楽天ペイの送付上限金額、複数人一括請求の可否。
- au PAYの送金上限（2024年9月に5万円/回・5万円/月へ引き上げとの情報があるが、公式お知らせページ https://aupay.wallet.auone.jp/announce/detail/?id=797 は本文を取得できなかった）。
- PassMarketの終了日・告知日の一次ソース：公式告知 blog-passmarket.yahoo.co.jp は thanks.yahoo.co.jp へリダイレクトされ本文が失われている。日付はITmedia報道による。
- LINEミニアプリの「認証済ミニアプリ」審査で、個人（非法人）が申請できるか：審査ガイドには明示がなく未確認。
- PayPayミニアプリのポリシー（developer.paypay.ne.jp/miniapp/docs/policy）は本文を取得できなかった。
- 本アプリの具体設計が資金移動業に該当するか否かの最終判断：金融庁事務ガイドラインは「事業者の行為が為替取引に該当するかは、その事業者が行う取引内容等に応じ、最終的には個別具体的に判断する」としており、法律事務所または財務局への照会が必須。

---

## 本アプリ設計への含意

1. **「自分で決済を通す」設計は最初に捨てるか、法的構成を先に決める。** アプリが参加者から受け取って幹事に渡す＝為替取引→資金移動業。回避路は内閣府令第1条の2第3号の除外に乗ること、具体的には (a) エスクロー型（反対給付＝イベント実施の後に幹事へ引き渡す）にする、(b) 利用規約で「利用条件や取引成立条件を定めている」プラットフォームになる、のいずれか。金融庁は後者について「単なる決済方法の提供、商品の広告、又は顧客の紹介等を行うだけでは足りない」と明記している。つまり**ただの集金ツールでは除外に乗れない**。
2. **最も安全かつ最も軽い構成は connpass 型。** 資金はアプリを通さず、幹事が自分の決済アカウント（PayPal等）で直接受け取り、アプリはWebhook/APIで結果を読んで参加者にチェックを付けるだけ。ただしこの構成では幹事側に加盟店アカウントが要り、PayPayは非事業者を受け付けないため**第一候補はPayPayではない**。
3. **受取先の第一候補を再設定する必要がある。** 「幹事の個人PayPay」は加盟店資格の壁で不可。現実的な候補は、幹事がPayPal個人アカウントを持つconnpass型か、幹事が銀行口座を登録するPeatix型。どちらも「PayPayで受け取りたい」という当初要望からは離れる。この差はユーザーに明示して判断を仰ぐべき事項。
4. **Stripeは引き続き前提にしない。** 禁止業種に「ピアツーピアの送金」があり、PayPayのConnect対応は公式資料間で「いいえ」と「✓（招待制）」が矛盾したまま。加えてPayPay決済は不審請求の申し立て非対応・手動キャプチャー非対応・setup_future_usage非対応で、エスクロー的な与信保留もできない。採用するなら用途・受取人属性を明示してStripeに事前確認が要る。
5. **LINEミニアプリ配布自体は障害にならない。** 2024-11-28以降、未認証ミニアプリは審査なしで公開できる。ただし未認証ではLINE内検索・ホームタブ掲載・ホーム画面ショートカットが使えず、パーマネントリンク配布のみになる。幹事がLINEでURLを配る想定なら未認証で足りる。決済は「外部のドメインや外部のアプリで決済を完了した後、ユーザーがLINEミニアプリのページに戻るようにしてください」という公式指針に従う。
6. **差別化の主張は「幹事OS」ではなく、検証可能な3点に限定すべき。** ①LINEグループでの個別金額請求（公式に非対応と確認済み）、②21名以上、③複数イベント横断台帳。これ以外はPayPay/Peatixが無料または同等コストで提供済みであり、勝てる根拠が一次資料で見つからなかった。
7. **「手動チェック＋領収記録」に割り切る選択肢を正面から検討する価値がある。** 資金を通さなければ資金移動業の論点は消え、手数料ゼロで戦え、PayPayの20名制限も越えられる。ただしこれは引継ぎ書が明示的に「中心要件を満たさない」と釘を刺した案なので、採用するならユーザーの明示的な同意が必要。

---

## 参照URL一覧（本調査で実際にフェッチしたもののみ）

**PayPay**
- https://paypay.ne.jp/promo/p2p/
- https://paypay.ne.jp/help/c0224/
- https://paypay.ne.jp/help/c0099/
- https://paypay.ne.jp/help/c0006/
- https://paypay.ne.jp/guide/send/
- https://paypay.ne.jp/guide/receive/
- https://paypay.ne.jp/notice/20220907/f-group/
- https://paypay.ne.jp/store/faq/
- https://about.paypay.ne.jp/en/pr/20230424/02/
- https://about.paypay.ne.jp/en/pr/20241015/01/
- https://about.paypay.ne.jp/terms/merchant-online/rule/online/
- https://about.paypay.ne.jp/terms/consumer/legal/money/

**LINE / LINEヤフー**
- https://www.lycorp.co.jp/ja/news/release/008628/
- https://www.lycorp.co.jp/ja/news/release/009440/
- https://developers.line.biz/ja/docs/line-mini-app/develop/payment/
- https://developers.line.biz/ja/docs/line-mini-app/discover/introduction/
- https://developers.line.biz/ja/docs/line-mini-app/submit/submission-guide/

**他の決済事業者**
- https://help.kyash.co/--67bd581478037e1a3ae2d521
- https://www.kyash.co/
- https://www.kyash.co/press-release/20200827
- https://payment.rakuten.co.jp/news/2024101000/
- https://pay.rakuten.co.jp/guide/cash/send_receive/
- https://wallet.auone.jp/contents/sp/guide/moneytransfer.html
- https://service.smt.docomo.ne.jp/keitai_payment/guide/wallet/remit.html

**イベント集金サービス**
- https://help-organizer.peatix.com/ja-JP/support/solutions/articles/44001821715
- https://help-organizer.peatix.com/ja-JP/support/solutions/articles/44001821779
- https://help-organizer.peatix.com/ja-JP/support/solutions/articles/44001821780
- https://help-organizer.peatix.com/ja-JP/support/solutions/articles/44001821753
- https://help.connpass.com/organizers/paid-event-edit
- https://thanks.yahoo.co.jp/ （旧 passmarket.yahoo.co.jp のリダイレクト先）
- https://www.itmedia.co.jp/news/articles/2512/17/news116.html （二次情報：PassMarket終了日）

**法令・規制（一次）**
- https://laws.e-gov.go.jp/api/1/lawdata/421AC0000000059 （資金決済に関する法律 第2条の2）
- https://laws.e-gov.go.jp/api/1/lawdata/422M60000002004 （資金移動業者に関する内閣府令 第1条の2・第1条の3）
- https://www.fsa.go.jp/common/law/guide/kaisya/14.pdf （事務ガイドライン第三分冊14 資金移動業者関係）
- https://www.fsa.go.jp/singi/singi_kinyu/tosin/20250122/1.pdf （金融審議会 資金決済制度等WG報告 2025-01-22）
- https://www.fsa.go.jp/singi/kessaiseido_wg/siryou/20241107/1.pdf （同WG 第4回 事務局説明資料 2024-11-07）
- https://www.fsa.go.jp/news/r2/sonota/20210319-2/01.pdf （令和2年資金決済法改正パブコメ回答 2021-03-19）
- https://www.fsa.go.jp/menkyo/menkyoj/shikin_idou.pdf （資金移動業者登録一覧 令和8年7月31日現在）

**Stripe**
- https://stripe.com/jp/legal/restricted-businesses
- https://docs.stripe.com/payments/paypay
- https://docs.stripe.com/payments/payment-methods/payment-method-support
