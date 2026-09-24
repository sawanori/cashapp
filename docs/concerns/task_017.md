# task_017 の残懸念

PaymentProvider IF v2 / レジストリ / ManualConfirmAdapter / 非自動ラベル 8 層 /
O-0 オンボーディング・適格性（`docs/task-list.json` task_017）。

各項目は「指摘 / 深刻度 / 対応案 / 対応予定タスク」で書く。

---

## C-017-1 PayPay 受取リンクの URL 形式が一次資料未取得

- **指摘**: `ManualConfirmAdapter` の受取リンクはサーバー側テンプレートから組み立てる設計だが、
  PayPay の個人間受取リンクの URL 形式を一次資料で確認できていない。推測で URL を書くことを
  禁じる規約（未確認の外部仕様は `docs/vendor-docs/` に退避してから使う）に従い、
  `RECEIVING_LINK_TEMPLATES` の `paypay_p2p` エントリを `verified: false` で登録した。
  `activeReceivingLinkTemplates()` が未検証エントリを外すため、**Phase 1 の既定動作では
  `deepLink` は常に `null`** になり、参加者画面は「お支払い先は幹事にご確認ください」に倒れる。
  P-5 の「遷移先ホスト名の併記」は、検証済みテンプレートを入れたときにだけ画面に現れる
  （単体テストは検証済みテンプレートを注入して併記の材料が揃うことを検査している）。
- **深刻度**: medium（機能の一部が既定で無効。安全側の縮退であり、誤った URL を出すよりは軽い）
- **対応案**: `docs/vendor-docs/paypay/receiving-link.md` に一次資料（取得日つき）を貼り、
  `build` / `host` / `identifierPattern` を合わせて `verified: true` にする。
  併せて `tests/unit/payments/manual-confirm.test.ts` の「既定のテンプレート表は未検証」ケースを
  検証済みの期待値へ更新する（削除しない）。
- **対応予定タスク**: PO の資料取得 → task_026（PayPay 着手時）

## C-017-2 `InvoiceRow.tsx` の自己申告表示（8 層の⑦）は task_015 が同時に実装していた

- **指摘**: 本タスクの `files_to_modify` に `src/components/InvoiceRow.tsx` が含まれるが、
  作業中に並行実行の task_015 が同ファイルへ `RosterStatus` の `self_reported`
  （支払済みと別の tone / label / アイコン）を未コミットで追加していた。8 層の⑦
  「自己申告の見た目を支払済みと同じにしない」は**その変更で既に満たされている**ため、
  本タスクでは同ファイルを変更せず、コミットにも含めていない（他タスクの未コミット成果物を
  巻き込まないという共通ルールに従った）。
- **深刻度**: low（担当ファイルの 1 つを自タスクのコミットで担保していないが、実体は入っている）
- **確認済み**: task_015 のコミット `2a17eb5`（`git show 2a17eb5:src/components/InvoiceRow.tsx`）に
  `self_reported` が 5 か所で含まれていることを実測した。8 層の⑦は担保されている。
  `SummaryBar.tsx` 側（8 層の④⑤）は本タスクで変更・コミットした。
- **対応案**: 追補は不要。以後 `InvoiceRow.tsx` の非自動バッジ・自己申告表示を変更する際は、
  task_015 と task_017 の両方の受入条件（check_031 / check_034 / check_087）を確認する。
- **対応予定タスク**: なし（記録のみ）

## C-017-3 レジストリ 9 パターンの「実 DB」は統合テスト側にある

- **指摘**: `implementation_steps` は「registry テストは実 DB のゲート・フラグで 9 パターン」と
  書いているが、`npm run test:unit` は DB を持たない環境でも走る必要があるため、
  `tests/unit/payments/registry.test.ts` は `GateEnvironment` のフェイクで 9 パターンを回し、
  **実 DB（`compliance_gate` / `feature_flag` / `app_user`）版の 9 パターンは
  `tests/integration/checkout.test.ts`** に置いた（`dbGateEnvironment()` 経由）。
  check_090 の `verification_method` は `npm run test:unit` なので、台帳の記述と実体が半分ずれる。
- **深刻度**: low（どちらも実装済みで、合計のカバレッジは指示より広い）
- **対応案**: check_090 の `verification_method` に `npm run test:integration` を併記する
  （`docs/acceptance-checks.json` は本タスクの担当ファイルではないため変更していない）。
- **対応予定タスク**: task_022（検証の集約）

## C-017-4 手動確認の `payment_attempt` が滞留しうる

- **指摘**: `POST /api/e/checkout` は手動確認でも `payment_attempt` を write-ahead する
  （done_definition の「同時 2 回で attempt が 1 つ」を成立させるため）。しかし手動経路には
  事業者からの確定が来ないので、`manual-attest` が走らない限り試行は `is_open` のまま
  `expires_at`（24 時間）まで残る。名簿の状態導出（`src/lib/db/repositories/participants.ts`）が
  open attempt を「手続き中（催促は送れません）」に写すなら、支払っていない参加者が
  24 時間催促対象から外れる。`manual-attest` 側では生きた試行を `canceled` に落として
  固定化を防いでいる（統合テストで検査済み）。
- **深刻度**: medium
- **対応案**: 照合ジョブ（`/api/cron/reconcile`）が `capabilities.statusQuery === false` の
  試行を期限で `expired` に落とす分岐を持つこと。あるいは手動確認では試行を作らず、
  「同時 2 回で 1 つ」の担保を別の一意キーに移す（設計判断）。
- **対応予定タスク**: task_020（照合ジョブ）

## C-017-5 `POST /api/e/cannot-pay` が未実装のため P-4 の導線は案内のみ

- **指摘**: §8-2 P-4 の「この方法では払えない」は常設したが、押しても要対応キューに入らない
  （`POST /api/e/cannot-pay` と O-9 要対応インボックスは task_021 の scope）。いまは
  「LINE のトークで幹事へご連絡ください」という固定文言を開くだけである。
- **深刻度**: low
- **対応案**: task_021 でエンドポイントを実装したら、ボタンから POST するよう差し替える。
- **対応予定タスク**: task_021

## C-017-6 参加者画面が `event.allow_cash` を読めない

- **指摘**: P-4 の現金受付は `event.allow_cash` に従うべきだが、参加者向けのイベント情報
  取得（`GET /api/e/me`）は task_015 の scope で、`POST /api/e/checkout` の応答には
  `allowCash` を載せていない。現状は「幹事が現金を受け付けている場合は」という条件つきの
  文言にして、受け付けていない幹事に現金を約束しないようにしてある。
- **深刻度**: low
- **対応案**: task_015 の `GET /api/e/me` が `allowCash` を返すようになったら、P-4 の現金欄を
  その値で出し分ける。
- **対応予定タスク**: task_015 / task_016

## C-017-7 O-0 の選択結果は O-3 に引き渡していない

- **指摘**: O-0 で「手動確認版ではじめる」を選んでも、その選択は画面内の state に留まり、
  イベント作成（O-3）へは渡らない。Cookie / localStorage に状態を持たせない規約（§8-3）と、
  選択を保存するサーバー側の置き場（幹事プロフィール）が未定義であるため。
  実効上の害は小さい（Phase 1 は `event.provider_key` が既定で `manual_confirm`）。
- **深刻度**: low
- **対応案**: 幹事プロフィールに「選んだ運用」を持たせるか、O-3 に読み取り専用で再掲する。
- **対応予定タスク**: task_021（設定・法務）

## C-017-8 `applyToLedger` の本体は task_018

- **指摘**: `manual-attest` は「最小追記」であり、金額不一致・二重払い（台帳残高 > 請求額）・
  取消後入金・`needs_attention` の立ち上げといった `applyToLedger` の不変条件は実装していない
  （task_017 の `non_scope` 明記）。いまは「請求額と同額を 1 件だけ credit し、ランクを前進」だけを行う。
- **深刻度**: medium（単独では正しいが、自動経路が入ると分岐が必要）
- **対応案**: task_018 で `applyToLedger` を実装し、`manual-attest` をその呼び出しに寄せる。
- **対応予定タスク**: task_018

## C-017-9 e2e / 適合テストは未着手（deferred）

- **指摘**: check_001（O-0〜O-8 の主要フロー）と check_092 の e2e は `npm run test:e2e`
  （task_022）、check_022 / check_026 / check_027 / check_093 の C9・C10・C12・C23・C30 は
  ProviderConformanceKit（task_019）の担当で、本タスクでは走らせていない。
- **深刻度**: low（本タスクの done_definition には含まれない）
- **対応案**: そのまま各担当タスクで実施する。
- **対応予定タスク**: task_019 / task_022

## C-017-10 Hyperdrive 経由の実測（A21）は deferred

- **指摘**: 本タスクの DB アクセスはローカル Supabase の direct 接続（ロール `app_rw`）でのみ
  検証した。Workers + Hyperdrive 経由の挙動（接続再利用・トランザクションの持続）は未実測。
- **深刻度**: low
- **対応案**: deferred: task_035（staging Supabase ＋ Hyperdrive）完了後に再実測する。
- **対応予定タスク**: task_035

## C-017-11 write-ahead の保証が 1 トランザクションの中では成立しない（G5 round1 GPT F-1）

- **指摘**: `POST /api/e/checkout` は `payment_attempt` を INSERT してから
  `provider.createCheckout()` を呼ぶが、両者は同じトランザクションの中にある
  （冪等予約・業務書き込み・`done` 更新を 1 トランザクションにまとめる P-01 の是正が
  それを要求する）。したがって「事業者を呼んだ後にコミット前で落ちても試行記録は残る」という
  write-ahead 本来の保証は**成立しない**。落ちれば予約ごとロールバックされる。
- **深刻度**: medium（Phase 1 は実害なし。`manual_confirm` は外部呼び出しを一切しないため、
  ロールバックしても外部に副作用は残らない）
- **対応案**: 自動アダプタを足す時点で「試行だけを別トランザクションで先にコミットしてから
  事業者を呼ぶ」形へ作り替える。冪等予約との整合は、予約を `in_flight` のまま残して
  照合ジョブに解決させるか、`payment_attempt` を outbox 経由にするかの設計判断が要る。
  本タスクでは route の docstring を実態に合わせて訂正した（誤った保証を書かない）。
- **対応予定タスク**: task_018 / task_026

## G5 round1 の指摘と対応

`docs/review-log/task_017.json`（round 1・`merge-review: pass` / 有効票 2 / 欠票 0 / 実効 high 0）。
gemini 2.5 Pro は PASS（指摘 0）、GPT-6 Astra は medium 4 件 / low 1 件。
**実効 high が 0 なので差し戻しではないが、5 件とも実在の穴なので同じ周で処理した**。

| id | 深刻度 | 内容 | 対応 |
|---|---|---|---|
| F-1 | medium | write-ahead の保証が同一トランザクションでは成立しない | docstring を実態に訂正し、C-017-11 として記録（設計変更は task_018 / 026） |
| F-2 | medium | `PROVIDER_<KEY>_MODE` が未設定・不正値でもガードを通過 | `!== "on"` で拒否する形に変更（fail-closed）。回帰テスト 1 件を追加 |
| F-3 | medium | `{ ...yen(3000), amountMinor: 3000.5 }` がブランドを保ったまま境界を通る | `toProviderAmount()` に整数・範囲の検査を足し、`ManualConfirmAdapter` の金額検査もそこへ寄せた。回帰テスト 2 件 |
| F-4 | medium | P-6 が状態を問い合わせず常に「幹事の確認待ち」 | 招待トークン（`?t=`）を P-4 → P-6 → P-7 で持ち回し、`GET /api/e/me` の実状態を表示する形に変更。トークンが無い場合は状態を断定せず P-3 へ誘導 |
| F-5 | low | `mixedCount > 0` でも「すべて手動確認」と表示 | 表示条件に `mixedCount === 0` を追加 |
