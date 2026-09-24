# 照会文: Stripe（営業／サポート）

- **inquiry_id（docs/external-inquiries.json）:** `stripe`
- **宛先:** Stripe 営業／サポート `payment_apis` 窓口
- **優先順位:** 6（`docs/implementation-plan.md` §18-1 優先6。「保留候補」。Phase 1/2 の go/no-go には用いない）
- **送付主体・時期:** PO（noritaka、NonTurn LLC）。送付は task_037 で実施する。本ファイルは起案（draft）であり、現時点では未送付。
- **関連ゲート:** なし（`docs/gates/compliance-gates.json` に Stripe 固有のゲートは定義されていない。保留候補のため）
- **関連リスクID:** なし（本照会自体に紐づく premortem リスクIDは無い）

## 前提説明（質問文冒頭に付す）

私たちは、イベント幹事が参加者から会費・参加費を集める用途のLINEミニアプリを開発しています。幹事ご自身の決済アカウントへ参加者が直接支払う構成を想定しており、当方（開発・運営元）は資金の受入れ・保管・引渡しには一切関与しません。カード決済の選択肢としてStripeの利用可能性を検討しており、以下をご教示いただけますでしょうか。

## 質問

### Q-ST1 禁止業種「ピアツーピアの送金」該当性

イベント主催者（個人事業主または法人）が参加者からイベント参加費を受け取るプラットフォームを構築したいと考えています。この用途は貴社の禁止業種「ピアツーピアの送金」に該当しますか。該当する場合、事前の明示的な承認を得る余地はありますか。

### Q-ST2 「Connect外でのC2Cサービス」の定義

貴社の禁止業種ページの日本向け「管轄区域固有の禁止業種」に「Stripe Connect 外での C2C サービス」という記載がありますが、この「C2Cサービス」の定義と「Connect 外」の意味を具体的に教えてください。イベント主催者と参加者の間の決済はC2Cに当たりますか。

### Q-ST3 PayPayのConnect対応

PayPay の Connect 対応について、`docs.stripe.com/payments/paypay` は「Connect のサポート: いいえ」、`payment-method-support` の表は「サポート対象（脚注: 招待をリクエスト）」と記載が食い違っています。どちらが正しいですか。招待の申請条件・審査基準・所要期間、承認後に使える支払いタイプ（ダイレクト／デスティネーション／送金別）を教えてください。

### Q-ST4 paypay_paymentsケイパビリティ

Connect のアカウントケイパビリティ一覧に `paypay_payments` が存在しませんが、連結アカウントに対してPayPayを有効化するAPI上の手段はありますか。

### Q-ST5 Accounts v2での日本対応

新規のConnectプラットフォームは Accounts v2 API を使うよう指示されていますが、日本・individual・`card_payments` / `konbini_payments` の組み合わせは v2 で利用可能ですか。

### Q-ST6 入金手数料

日本の通常の入金（payout）に振込手数料は発生しますか。

## この照会が動かすゲート

現時点で `docs/gates/compliance-gates.json` に Stripe 固有の `gate_key` は定義されていない（Stripe は §18-1 優先6「保留候補」であり、Phase 1/2 の go/no-go 判断には用いない）。

## 出典・根拠

- `docs/implementation-plan.md` §18-1（優先6: Stripe・後回し）
- `docs/research/consolidated.md` §5-2 項目1〜6（Q-ST1〜Q-ST6 の原文）

## 確信度・レビュー状態

[設計] — task_002 で起案。質問文は `docs/research/consolidated.md` §5-2 の原文をそのまま宛先別照会文の形式へ転記したもの。送付優先度が最も低く、送付時期はPO判断（`docs/implementation-plan.md` §18-1 優先6）。送付前に PO レビューを経ること（`task-list.json` task_002 の `adversarial_review: "required"`）。
