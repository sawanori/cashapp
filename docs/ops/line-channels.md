# LINE チャネル構成（Messaging API チャネルの開設手順）

task_023 の scope「Messaging API チャネル（同一プロバイダー）の開設手順を記録する」に対応する
手順書。**本書はここまでのタスクの範囲では手順の記録のみであり、実際のチャネル開設は未実施**
（N1 の `enforcement: manual` / `expect_targets: from_task_025`。実機確認と ADR への記録は
`task_025` 以降の scope）。実施者（PO または実装担当）はこの手順に沿って LINE Developers
コンソールで作業したあと、実機確認の結果を本書末尾の「実施記録」に追記する。

## 前提: なぜ「同一プロバイダー配下」が必須か

`docs/constraints.json` の `N1`（「LINEミニアプリチャネルと Messaging API チャネルは同一
プロバイダー配下に置く（後から移せない）」）と、`docs/research/research-line-miniapp.md`
Q6 が引用する一次資料（LINE Developers ドキュメント）に基づく。

> 「同じプロバイダーの配下に作成することで、各チャネルでは同じユーザーに対し、同じユーザーID
> が割り当てられます。」
> — `docs/research/research-line-miniapp.md` Q6（LINE Developers ドキュメント引用）

LINE の `userId` は**プロバイダー単位**で共通に発行される。LINE ミニアプリチャネル（参加者・
幹事がログインする側）と Messaging API チャネル（幹事への通知を配信する側）が別プロバイダー
配下にあると、同じ人物でも `userId` が一致せず、`line_user_ref`（`docs/implementation-plan.md`
§7-4 の HMAC 突合）による本人確認ができない。**プロバイダーは後から変更できない**ため、
最初の作成時点で誤ると、既存の幹事・参加者アカウントを作り直すことになる（`docs/task-list.json`
task_023 の `constraint_ids: ["N1", ...]`）。

## 手順

1. **既存プロバイダーの確認**: LINE Developers コンソール（https://developers.line.biz/console/）
   で、既存の LINE ミニアプリチャネル（`docs/implementation-plan.md` §7-3 が定める開発／審査／
   本番の内部チャネル）が属するプロバイダー名を確認する（想定: `NonTurn LLC`。`docs/decisions/`
   に記録された実際のプロバイダー名と一致することを確認する）。
2. **Messaging API チャネルの新規作成**: 同じプロバイダーの配下で「Messaging API」チャネルを
   新規作成する。チャネル名・アイコン・説明は「幹事向けの要対応通知専用の LINE 公式アカウント」
   であることが分かる表記にする（禁止語は `docs/wording-policy.md` に従う。寄付・募金・投げ銭
   等の語を使わない）。
3. **プロバイダー一致の確認（実機）**: 作成後、コンソールの「チャネル基本設定」でプロバイダー名
   が手順 1 で確認した名称と一致することを目視確認し、本書末尾の「実施記録」に記録する。
4. **チャネルアクセストークンの発行**: 長期トークンは使わず、`docs/research/research-line-miniapp.md`
   Q6 が引用する一次資料のとおり**ステートレスチャネルアクセストークン**を使う。発行したトークン
   の値そのものはこの docs には書かない。`wrangler secret put --env <env>`（CI 経由。
   `docs/implementation-plan.md` §16-4）でのみ投入し、環境変数名（例: `LINE_MESSAGING_CHANNEL_TOKEN`）
   だけをここに記録する。
5. **Webhook URL の登録**: Messaging API チャネル自体は本タスクでは Webhook 受信を実装しない
   （task_023 は `push` 送信のみが scope。友だち追加イベント等の Webhook 受信は Phase 3 以降）。
   コンソール側の Webhook 設定は無効のままにする。
6. **友だち追加導線（未認証状態でも可）**: 幹事がミニアプリ内から Messaging API チャネルを
   友だち追加できる導線を用意する。LINE ミニアプリチャネルの認証状態（認証済／未認証）に
   Messaging API チャネルの友だち追加は依存しない（別チャネルの操作のため）。実装は次のいずれか:
   - LINE 公式アカウントの友だち追加用 URL（`https://line.me/R/ti/p/@<Basic ID>` 形式。コンソールの
     「Messaging API設定」タブに表示される Basic ID を使う）を幹事向け画面から開く
   - QR コード（コンソールが生成するものをそのまま使う。独自生成しない）
   - 友だち追加をボタンタップの操作にする（自動遷移にしない。`shareTargetPicker` と同様、
     ユーザー操作をきっかけに実行する原則に合わせる）
7. **友だち追加状態の確認**: ADR-007（`docs/decisions/ADR-007-raw-userid-consent.md`、パターン B,
   proposed・PO 承認前の暫定運用）により、Phase 1 は友だち追加の有無にかかわらず `push` を
   送らない（幹事は O-2 の
   要対応バッジのみで気づく）。友だち追加導線は Phase 2 で `push` を有効にする際の前提を
   先行して整えるためのものであり、Phase 1 時点では「友だち追加済みかどうか」をアプリ側で
   判定・保存する実装は行わない。本書は友だち追加**導線**の記録に留め、`push` 実装そのものは
   この手順書の対象外（Phase 2 で ADR-007 を更新したのち着手する）。

## 未確認・持ち越し事項

- Messaging API の通数課金プラン（無料枠のメッセージ数上限）は `docs/task-list.json` task_023 の
  concerns（低深刻度）で既に「未検証」と記録済み。実際にチャネルを作成した時点で、コンソールの
  プラン画面から一次資料として `docs/vendor-docs/line/` に取得日つきで退避する。
- チャネルアクセストークンの発行手順の実機確認（トークンの実際の値ではなく、発行 UI の場所・
  失効/再発行の挙動）は本書の手順 4 の実施時に追記する。

## 実施記録

（未実施。実施したら以下の形式で追記する: 実施日 [実測] / 実施者 / プロバイダー名が一致したことの
確認方法 / チャネル ID・Basic ID など秘密でない識別子のみ。トークン・シークレットは書かない）
