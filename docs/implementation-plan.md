# Implementation Plan: 幹事向け会費集金アプリ（LINEミニアプリ）

作成日: 2026-09-24（JST）／改訂: 2026-09-24 プレモータム反映版
作成者: Claude Code（計画フェーズ。実装は未着手）
関連ファイル: `docs/task-list.json`（34 タスク）／`docs/acceptance-checks.json`（受入チェック）／`docs/research/`（調査・設計・プレモータムの一次成果物）

> **根拠ラベル（全節で使用）**
> - **[実測]** このセッションで実際にコマンドを実行して確認した
> - **[文書]** 一次資料（公式ドキュメント・規約・法令）を実際に取得して確認した
> - **[設計]** 本計画の提案。未実装・未検証
> - **[不明]** 確認できていない。着手前に確認が必要
>
> [設計] または [不明] にしか根拠がない決定は「暫定」であり、Phase 0 の照会結果とプレモータムの再実行で入れ替わりうる。

---

## 1. Overview

幹事がイベント（サークル活動・教室・合宿・懇親会など）の参加者リストと請求額を管理し、参加者が自分の請求に支払うと、決済事業者の正規の通知／照会 API の結果によって当該参加者に「支払済み」が付く LINE ミニアプリを構築する。運営主体は NonTurn LLC。開発は noritaka 1 名と AI エージェント群（Opus 5.5 / Sonnet / Gemini 系 / GPT-6 Astra。Fable は使わない）。

一次資料調査（`docs/research/consolidated.md`）の結論により、引継ぎ書の中心要件を構成する 3 条件 **(1) 参加者ごとの自動検知、(2) 受取先が幹事の個人 PayPay、(3) 幹事が非事業者のまま** は、公開仕様の範囲では同時に満たす経路が見つかっていない [文書]。根拠は 2 本に分かれる。「自動検知を提供する主体は例外なく加盟店／ビジネスアカウントであり、登録に事業実態の証憑を要する」は確信度 高、「個人 PayPay への着金を第三者が照会する手段が無い」は確信度 中で非存在の証明ではなく、確定には Q-PP4 の回答を要する（`consolidated.md` §7-2）。本計画が条件 (3) を落とすのは前者に基づく。本計画は **条件 (3) を落とす**（幹事が自身の名義で決済事業者の加盟店アカウントを持つ）構成を骨格とし、その変更への PO（noritaka）の明示同意を Phase 0 のゲート `G0-USER` に置く。不同意なら Phase 1 の成果物を「名簿＋PayPay 個人間送金導線＋幹事の手動確認」構成（`manual_confirm` 単独）で運用する。**縮退構成を「自動チェック要件を満たした」と説明することは、API・画面・CSV・サマリ・文言・CI・自己申告表示・混在表示の 8 層で機械的に禁止する。**

設計の絶対制約は「**運営者の口座・決済アカウントを資金が一切経由しない**」こと（資金決済法 2 条の 2、資金移動業者に関する内閣府令 1 条の 2 [文書]）。アーキテクチャは「台帳（ledger）が製品、決済事業者はプラグイン」。ホスティングは PO の指示により **Cloudflare Workers**（Next.js を `@opennextjs/cloudflare` でデプロイ、DB は Supabase Postgres に Hyperdrive 経由で接続）とする。調査（`docs/research/research-tech-stack.md`）は Vercel を推奨していたため、この決定と未確認事項（OpenNext 互換性・Hyperdrive 経由の Postgres・Cron Triggers・CPU 上限）を ADR-012 に記録し、task_003 / task_011 のスパイクで実測する。`PaymentProvider` アダプタ IF を最初から置き、Phase 1 では自動ではない `ManualConfirmAdapter` のみを出荷、Phase 2 で `PayPayOnlineAdapter`（第一候補）と `PayjpAdapter`（第二候補）を追加する。**決済事業者・LINEヤフー・弁護士への照会は 1 件も行っていない**ため、第一候補は照会の順序であって採用確定ではない。

8 レンズのプレモータム（`docs/research/premortem-risks.md`、118 件 → 86 件に統合、S1 42 件）で見つかった設計欠陥は本改訂版で解消済みの前提で書いている。特に、設計ブリーフの次の記述は誤りとして撤回した: 「決済事業者からの復帰は SameSite=Lax で通る」「ゲートを全入口に置く」「RLS deny-all ＋ service role」「nonce 検証」「金額不一致は台帳に書かない」「PreCompact フックで永続化」「CODEOWNERS の PO 承認」「リリースは 3 者全会一致」。

---

## 2. Goal

### 2-1. ユーザーゴール（幹事）

- 参加者リストに名前と請求額を登録し、参加者ごとの個別リンクを LINE で配布できる。
- 参加者が支払うと、その行に「支払済み」が付く。**自動確認（決済事業者 API 由来）・手動確認（幹事の申告）・参加者の自己申告（幹事確認待ち）・手続き中（決済画面を開いたが確定前）は常に別の見た目で表示される。**
- 未払い人数・金額、要対応事項（金額不一致・二重払い・取消後入金・支払手段なし・紛争）が一覧で分かり、その通知が LINE 公式アカウント経由で届く。
- 集金総額・手数料概算・受取見込額・入金予定時期が、請求発行の前に提示される。

### 2-2. ユーザーゴール（参加者）

- LINE 内で招待リンクを開くと、同意の前にイベント名・幹事の表示名・締切・金額レンジが見える。自分の個別リンクまたは名前選択で claim し、自分の請求額だけを見て支払える。他人の金額・支払状況は見えない。
- 決済後に外部ブラウザで戻っても、自分の請求の状態だけは確認でき、LINE へ戻る導線がある。

### 2-3. ビジネスゴール（NonTurn LLC）

- 資金移動業・前払式支払手段・割賦販売法のいずれの登録・免許も要しない構成で LINE ミニアプリとして配布する。
- 決済事業者の変更で名簿・画面・台帳を作り直さない。
- 「手動版を自動版と説明する」「自己申告を検証済み入金と扱う」「AI が本番ゲートを書き換える」を構造的に起こさない。

### 2-4. 自動チェックの達成定義

以下をすべて満たしたときのみ「自動チェック要件を満たした」と言う。

1. 参加者ごとに個別の決済オブジェクト（`external_ref`）を、幹事の `provider_binding` に紐付けて発行している。
2. 署名検証済み Webhook、または正式な照会 API（`getPaymentStatus`）の結果に基づき、`payment_attempt.amount_minor` と一致する金額で `settlement_status` が `paid` に前進している。
3. 当該請求の `confirmation_method` が `automatic`（`ledger_entry.confidence` から導出）である。
4. Webhook を止めた状態でも、照合ジョブだけで同じ請求が `paid` に到達する。
5. 本番で少額の実決済 1 件が台帳に載り、幹事の受取口座への着金を人間が確認して記録している。

---

## 3. Current State

| 項目 | 状態 | 根拠 |
|---|---|---|
| リポジトリ `/Users/noritakasawada/AI_P/cashapp` | コミット 0・ファイル 0（本計画の `docs/` を除く）。**`cashapp/.git` は存在せず、`git rev-parse --show-toplevel` はホームディレクトリ `/Users/noritakasawada` を返す**（ホーム直下に git リポジトリがあり、cashapp はその未追跡サブディレクトリ）。task_003 の最初の手順で `cashapp` 直下に `git init` して独立したリポジトリにする（ホーム側の管理は PO が確認） | [実測] |
| Node / パッケージマネージャ | Node v22.22.0、npm 10.9.4。**pnpm は corepack シム破損で起動不可** | [実測] |
| CLI | supabase CLI 2.58.5、Vercel CLI 50.17.0（不使用）、gh CLI 認証済み（sawanori・単一アカウント）、codex-cli 0.154.0、**wrangler 未導入（task_003 で devDependency として導入）** | [実測] |
| codex（GPT-6 Astra 経路） | `~/.codex/config.toml` の既定モデルは `gpt-6-astra`。`~/.codex/hooks/block-non-claude-model.sh` には Claude 側にある `ALLOW_NON_CLAUDE_MODEL=1` 例外句が無く、`~/.codex/hooks.json` の UserPromptSubmit で有効。codex MCP は接続失敗 | [実測] |
| Gemini 経路 | gemini-cli MCP（ask-gemini）は動作するが、ツール応答が「Gemini CLI は 2026-06-18 廃止済み、Antigravity CLI へフォールバック、実モデルは gemini-3.5-flash」と明示。**3.8 Flash への到達は未確認** | [実測] |
| MCP | context7 / codex / figma / magic / obsidian / vfx が接続失敗。Vercel（不使用）・GitHub・gemini-cli は接続済み。Cloudflare の MCP は未設定（`cloudflare` / `wrangler` / `workers-best-practices` スキルで代替） | [実測] |
| Claude Code フック | 公式ドキュメント（2026-09-24 取得）で PreToolUse（exit 2 = "Blocks the tool call"、`permissionDecision: deny` 可）/ PostToolUse / UserPromptSubmit / Stop（exit 2 = "Prevents Claude from stopping"）/ SubagentStop / PreCompact / SessionStart が実在。**本プロジェクトで各イベントの遮断挙動を実測はしていない**（task_006 で実測） | [文書] https://code.claude.com/docs/en/hooks |
| 決済事業者・LINE・弁護士への照会 | 0 件 | 引継ぎ書 |
| 一次資料の検証カバレッジ | 意思決定に効く主張のうち 3 レンズ反証検証（source / recency / inference）を通ったのは一部のみ。大半は未検証 | [不明] ワークフロー実行時の集計では 105 件中 16 件と記録したが、集計の原本を保存しておらず再現できない。リポジトリに現存する記録は `consolidated.md` §0-4 の自己申告「82 件中 18 件」と、同 §3 が claim ID 付きで残す 14 件のみで、14 / 18 / 16 は一致しない。どの数でも「大半が未検証」という結論は変わらない |
| プレモータム | 8 レンズ 118 件 → 86 件（S1 42 / S2 42 / S3 2）。統合者は一次資料を再取得していない。2 レンズは gemini-3.5-flash 経由 | `docs/research/premortem-risks.md` §6 |
| 検証コマンド | 存在しない（`package.json` が無い） | [実測] |

---

## 4. Scope

### 4-1. Phase 0 — 照会・法務・同意ゲート（非コード。ハーネス構築と並行）

- `G0-USER`（受取先変更と加盟店審査発生への PO 明示同意）。
- 弁護士照会 **Q-LG1（為替取引該当性）を単独先行発注**し、否定回答時の分岐 ADR を先に用意する。
- PayPay 加盟店窓口・PAY.JP・LINEヤフー審査窓口への照会。各照会に `no_response_deadline`（送付 + 21 日）と `default_decision_on_timeout` を持たせる。
- ゲートの正本は `docs/gates/*.json`（Git 管理・PR 対象）。DB の `compliance_gate` はデプロイ時に JSON から同期される射影。

### 4-2. ハーネス（task_003〜task_010。必須セットは週 0 の 5 営業日にタイムボックス）

- 必須セット: `deny-test-weakening.sh` / `deny-dangerous-bash.sh`、`record-run.sh`（run-log の唯一の書き込み経路）、`gate-check.mjs`（G0〜G14）、違反フィクスチャとメタゲート（`test:gate-meta`）、`session-brief.mjs`、Stop フックでの HANDOFF 毎ターン追記、フック実在マトリクスの実測、CI の static / secrets / deps / acceptance / test-tamper-guard。
- 任意セット（5 営業日を超えたら機能実装を優先し、残件を `docs/PROGRESS.md` に記録）: 6 エージェント定義、Workflow 3 本、敵対レビュー経路、ベンチ。

### 4-3. Phase 1 — 決済非依存コア（Phase 0 と並行）

- DB スキーマ v2（§10）。ランタイムは最小権限ロール `app_rw`、追記専用はトリガで例外化。
- 認証・セッション・CSRF・鍵運用（§7-4）。環境分離（Supabase prod/staging 2 プロジェクト、wrangler environments のバインディング・シークレット分離、staging の Webhook/cron 404）。
- イベント・参加者・請求・招待（イベント単位トークン＋参加者単位 claim トークン、unclaim、preview、自己申告）。
- 配布（催促文＋URL コピーを主導線、`shareTargetPicker` は可用性判定つき補助、参加者ごとの個別リンク）。
- `PaymentProvider` IF v2（`binding` 第一引数）、`resolveProvider`（環境ガード＋ゲートは `createCheckout` と binding 作成のみ）、`ManualConfirmAdapter`、非自動ラベル 8 層、オンボーディング分岐（O-0）、適格性チェック、未成年申告。
- 台帳適用・冪等基盤・監査連鎖の直列化と検証ジョブ、Webhook ルート（`/:providerKey/:bindingRef`、Phase 1 は 404）、契約テスト 3 本、ConformanceKit C1〜C31。
- cron（照合はバッチ・xact ロック・猶予、outbox の配達先表、保持期間、冪等キー掃除、監査検証）。
- 管理面（読み取り専用 lookup、フラグの二人承認、gates-sync、anonymize / export）、要対応インボックス、CSV、特商法表示（Phase 1 から運営者情報）、規約・プライバシー（弁護士レビュー必須）、インシデント対応手順、悪用対策（上限・通報・停止）。
- **Messaging API チャネルを Phase 1 に前倒し**し、幹事向け要対応通知の配送先にする。外形監視と `degraded` health。
- E2E・セキュリティ・a11y・LINE 非依存ビルド（`build:web-only`。将来の退避余地の担保であり、Phase 1 では `(web)` に静的法務ページと管理者画面のみを置く）、バックアップ復元リハーサル、実機確認（iOS / Android）、未認証ミニアプリ公開、パイロット。

### 4-4. Phase 2 — 自動アダプタ（Phase 0 のゲート通過が前提）

- `PayPayOnlineAdapter`（サンドボックス先行、fixture は実キャプチャ必須）、Webhook 有効化（IP 許可リスト・binding 分離）、`return_token` による Cookie 非依存の復帰、「手続き中」表示、binding 接続と資格情報カストディ（鍵を持たない構成を第 2 案として型で用意）、返金・一括返金・イベント中止、紛争種別、事業者アカウント停止検知、手数料・入金時期の事前提示、本番少額実決済、負荷 300 件、キルスイッチ実測、`PayjpAdapter`（部分返金は当面非対応）。

### 4-5. Phase 3 — 運用・拡張（task-list では optional）

- 認証ミニアプリ審査・サービスメッセージ、催促（送信主体は幹事・回数と時間帯の制約）、複数イベント横断台帳、`payout` テーブルと `listSettlements`、PEPPER とセッション鍵のローテーション演習、`BankReconciler` の調査。

---

## 5. Non-Scope

- 運営者が資金を預かる収納代行型（候補 F）。資金移動業登録（株式会社限定・供託）を要する [文書]。
- 立替精算モード（内閣府令 1 条の 2 第 2 号）[文書]。
- アプリ内残高・チャージ・ポイント・ウォレット。
- Stripe の採用（SSA 1.2(a)(i)、禁止業種「ピアツーピアの送金」、日本固有「Stripe Connect 外での C2C サービス」）。照会リストの 5 番目に置く [文書]。
- PayFac 型（割賦販売法 35 条の 17 の 2）。
- ネイティブアプリ。参加者への手数料上乗せ。国外の参加者・幹事（通貨 JPY 固定）。
- スクリーンショット等の画像証跡。代理払いの自動検知（決済事業者 API は支払者を返さない [文書]）。
- 出欠管理・当日 QR 受付・二次会追加徴収の一般化。
- カード番号を本アプリのサーバーが受け取る実装（割賦販売法 35 条の 16）。
- 部分返金の台帳表現（Phase 2 では `capabilities.refund` を `'full'` 以下に限定。R-PAY-05 を解くまで非対応）。
- `settled_at`（実績の入金日）と、実績入金に基づく「入金日」UI（Phase 1〜2 では実装しない。`payout` は Phase 3）。O-3 / O-11 の「入金予定時期」はこれに当たらない。`capabilities.settlementSchedule` / `settlementLagHint` 由来の**推定**の事前提示であり Phase 1 から必須（§17-1 A6、§17-2 R-PAY-14）。Phase 1 の値の出どころは `src/lib/payments/capabilities-static.ts`（task_014 で作る静的表。`manual_confirm` は手数料なし・即時）。
- 幹事と参加者の連絡手段の提供（LINE のトークで直接連絡する固定文言で代替）。
- 多タイムゾーン対応（国内限定。時刻規約は §7-8）。
- **LINE 非依存の幹事・参加者導線**。`(web)` ルートグループは Phase 1 では静的法務ページと管理者画面のみ。LINE ミニアプリ配布が不可になった場合の退避は別計画（画面層とセッション層の作り直し。所要は Phase 1 相当。ADR-013）。

---

## 6. Assumptions

| # | 仮定 | ラベル / 確信度 | 覆った場合 |
|---|---|---|---|
| A1 | PO は受取先変更（幹事名義の加盟店アカウント経由の銀行口座）と加盟店審査の発生に同意する | [不明]（`G0-USER`） | `manual_confirm` 単独構成。Phase 2 は着手しない |
| A2 | 会費徴収は PayPay オンライン決済の取扱可能商材 | [不明] 確信度 低（NG 商材「寄付・募金・投げ銭」の公式記載あり）[文書] | 第一候補を PAY.JP に差し替え |
| A3 | PayPay オンライン決済ルートに実店舗要件がない | [文書] 確信度 中 | 同上 |
| A4 | PayPay STAGING サンドボックスは加盟店審査前から使える | [文書] 確信度 中 | Phase 2 先行実装を PAY.JP テストキーへ |
| A5 | 「運営者が資金の受入れ・保管・引渡しに一切関与しない」構成なら資金移動業登録は不要。**ただし「アプリが支払先と金額を指定して参加者に支払わせる行為」が柱書の「他の者に受け入れさせ」に当たらないか（Q-LG1）は未確認** | [不明] 弁護士見解待ち。事務ガイドラインは「個別具体的に判断」[文書] | Phase 2 は無期限停止。第 3 号ニ（登録済み資金移動業者の委託先）または株式会社化を ADR で検討。`manual_confirm` でも柱書該当の可能性が残ることを明記 |
| A6 | 運営者が幹事の加盟店 API クレデンシャルを保管して API を呼ぶことが「資金の受入れへの関与」と評価されず、加盟店規約の「認証情報の第三者預託禁止」にも抵触しない | [不明]（`GATE-CRED-CUSTODY`、Q-LG7 / Q-PP9） | `capabilities.credentialCustody: 'organizer'`（鍵を持たない構成）へ切り替え、Phase 1 で型として用意しておく。**ただしこの構成では運営者が加盟店 API を呼べないため §2-4 の (4)（Webhook を止めても照合だけで paid）は成立せず、(2) も PayPay のように署名の無い事業者（A17）では成立しない。したがって「自動チェック要件を満たした」とは言えず、Phase 2 の到達点は「幹事が事業者管理画面で確認した入金を幹事自身が記録する半自動」へ縮退し、非自動ラベル 8 層の対象として扱う（§18-4 の 14）** |
| A7 | 「幹事が管理する精算・集金の台帳」は LINE ミニアプリポリシーの禁止業種「募金、寄附、クラウドファンディング等」に該当せず、「有料サービスの販売」条項（アプリ内課金必須）にも当たらない | [不明]（`GATE-LINE-POLICY`、Q-LN1 / Q-LN2） | LINE ミニアプリ配布を再検討。**LINE 非依存の幹事・参加者導線は Phase 1 では未実装のため、退避には別計画（画面層とセッション層の作り直し、所要は Phase 1 相当）が要る（ADR-013）。`build:web-only` はビルドが LINE SDK 無しで通ることの担保にすぎない** |
| A8 | 未認証ミニアプリで外部決済を含む本番リリースができ、利用者数の上限がない | [文書] 確信度 高（決済）／[不明]（上限 Q-LN5） | 上限があれば認証審査を前倒し。縮退モード（新規招待停止）を用意 |
| A9 | ミニアプリチャネルで `shareTargetPicker` が利用できる | [不明]（`GATE-LINE-SHARE`、有効化手順の一次資料未特定） | 催促文＋URL コピーと個別リンクが主導線なので設計は変わらない |
| A10 | 2026 年夏以降 LINE 本体に PayPay 送金・グループ支払いが統合される | [文書] 確信度 低〜中（未反証検証） | 差別化軸（名簿・複数イベント横断・21 名以上・個別金額）は変わらない |
| A11 | ターゲット幹事は継続的な主催者（サークル・部活・教室・コミュニティ）で、加盟店審査を通れる。単発の飲み会幹事には自動決済を提示しない | [不明] PO 判断（ADR-001） | Phase 2 の価値が成立しない |
| A12 | Cloudflare Workers Paid と Supabase Pro（PITR 込み）を Phase 1 の必須費用として確保する。Supabase Tokyo の可用性 | [不明] Workers Paid の CPU 上限（`limits.cpu_ms`）・Hyperdrive の料金枠・Supabase Tokyo はいずれも未確認 | 復旧目標（RPO 15 分 / RTO 4 時間）が満たせない、または照合バッチが CPU 上限に収まらない |
| A13 | 4 モデルの単価・レイテンシ・コンテキスト長 | すべて [不明] | task_010 の実測まで配置は暫定 |
| A14 | Gemini 3.8 Flash が呼べる | [実測] 本セッションでは gemini-3.5-flash にフォールバック | 到達可能な Gemini 系モデルに読み替え、ADR-003 に実モデル名を記録 |
| A15 | フレームワーク・ライブラリの具体バージョン | [不明]。task_003 で `npm view` の実測値を ADR-002 に記録 | — |
| A16 | 決済事業者 API は「どの決済が支払われたか」は返すが「誰が支払ったか」は返さない | [文書] 確信度 高 | `capabilities.payerIdentity` の型を緩める |
| A17 | PayPay の Webhook に署名検証が無い（IP 許可リスト推奨）。送信元 IP レンジは公式一覧を照会で取得できる | [文書] 確信度 中／[不明] | 署名があれば再照会を省略可。IP 一覧が無ければ再照会のみで運用 |
| A18 | Cloudflare Cron Triggers の最小間隔・実行タイムアウト・リトライ | [不明]。task_020 で一次資料を再取得し `docs/vendor-docs/cloudflare/cron-triggers.md` に保存してから実装。専用の cron Worker が本体の `/api/cron/*` を `CRON_SECRETS` 付きで呼ぶ構成なので OpenNext 側の制約に依存しない | 外形監視（`reconciliation_run` 鮮度）で停止を検知 |
| A20 | Next.js（App Router）が `@opennextjs/cloudflare` で Workers にデプロイでき、Route Handler の `request.text()`・`server-only`・ミドルウェア・セキュリティヘッダが動く | [不明]。task_003 のスパイクで最小構成を実測 | 動かない機能を Hono 等の Workers ネイティブ実装へ切り替える ADR を起票 |
| A21 | Workers から Supabase Postgres へ Hyperdrive 経由で接続し、トランザクション内の `pg_try_advisory_xact_lock`・`FOR UPDATE`・生成列・トリガが期待どおり動く | [不明]。**task_035（staging Supabase ＋ Hyperdrive の作成と実測。task_018 の台帳実装より前に置く）で 1 回実測し、task_024 の本番環境構築で再確認** | Hyperdrive の origin（direct / Supavisor）の切替、または Supabase の HTTP 経路へ切り替える場合は台帳の DB 制約が維持できるかを再評価（ADR-012） |
| A22 | 個人 PayPay アカウントへの着金を第三者アプリが照会する公開手段は存在しない | [文書] 確信度 中（非存在の証明ではない。`consolidated.md` §3-1 / §7-2）。Q-PP4 の回答で確定 | 存在すれば `paypay_p2p` アダプタ（`autoDetect: true`）を検討し、条件 (2)(3) を落とさない構成を再評価 |
| A23 | ゲート `passed`（§7-2 / §10-2）とフラグ変更（§9 `POST /api/admin/flags`）に求める二人承認の第二承認者を誰が務めるか | [不明]。§16-2 の体制では管理者は noritaka 1 名（A19 と同じ単一アカウント制約） | 縮退案: 単独承認＋ 24 時間のクーリング期間、`audit_log` に申請行と承認行の 2 行（同一 actor 可、`cooling_period_sec` を記録）、`PAYMENTS_ENABLED` の true 化は `legal-clearance.json.cleared==true` を前提条件に含める |
| A24 | 契約する Cloudflare プランで WAF カスタムルールと Rate Limiting ルールを所要本数使え、Cloudflare API から実設定を読み出して CI で照合でき、staging を Cloudflare Access で保護でき、Smart Placement が有効に働く | [不明] | WAF が使えない場合は IP 許可リストをアプリ層（`src/lib/webhook/ip-allowlist.ts`）のみで運用し、再照会（W7）を必須のままにする |
| A25 | Next.js 一式を `@opennextjs/cloudflare` でバンドルした Worker が Workers Paid のスクリプトサイズ上限（圧縮後）に収まる | [不明]。上限値も成果物サイズも未計測 | `build:cf` のたびに `.open-next` の Worker サイズを CI で記録し、上限の 80% で警告。超えたらルート分割または Hono 化を ADR で判断 |
| A26 | 継続的主催者は自身の特商法表記（氏名・住所・電話、または Q-LG10 で認められる代替手段）を公開してよいと判断する | [不明]（Q-LG10 / `G0-USER`） | 自動決済版は屋号住所または法人・団体名義を持つ主催者に限定し、それ以外は `manual_confirm` に固定 |
| A27 | Workers の Rate Limiting バインディングと Durable Objects が契約プランで使える | [不明] | アプリ層のレート制限を Postgres（Hyperdrive 経由）のカウンタ表に置き換える（精度は落ちるが in-memory は使わない） |
| A19 | GitHub は単一アカウント（sawanori）のため、PR 作成者が自分の PR を承認できない | [実測] | CODEOWNERS の承認必須は使わず、PR テンプレート記入の CI 検査で代替（承認の代替ではなく、緩和事実の記録強制。§16-6） |

サービス名・料金体系・手数料の負担者・想定利用人数・公開日は未定。手数料は参加者に上乗せしない、ということだけを決める。

---

## 7. Architecture Impact

### 7-1. 資金フロー（確定）

```
参加者 ──支払──▶ 決済事業者（幹事名義の加盟店アカウント）──入金──▶ 幹事の銀行口座
                      │
                      └─Webhook / 照会API─▶ 本アプリ（台帳に記録するだけ。資金には触れない）
```

「販売事業者は幹事である」を ADR に明文化する（特商法表示義務の主体。幹事の住所・電話の表示方法は Q-LG10）。

### 7-2. 技術スタック（採用は確定〈PO 決定〉。実現性は A20 / A21 / A24 / A25 / A27 の実測待ち。バージョンは task_003 で実測）

| 層 | 採用 | 根拠 | 不採用 |
|---|---|---|---|
| パッケージマネージャ | npm 10.9.4。`.npmrc` に `ignore-scripts=true`、バージョン完全固定 | pnpm 破損 [実測]。サプライチェーン統制（R-SEC-13） | pnpm / yarn |
| フレームワーク | Next.js（App Router）/ TypeScript。ルートグループ `(liff)` と `(web)` を並置 | `request.text()` で生本文 [文書]。`npm run build:web-only` で LINE 非依存を維持（R-LINE-05） | SvelteKit / Remix |
| ホスティング | **Cloudflare Workers（PO 決定・ADR-012）**。Next.js は `@opennextjs/cloudflare` で Workers にデプロイ。Workers Paid。`wrangler.toml` の environments（`staging` / `production`）でバインディングとシークレットを分離。staging は Cloudflare Access で保護。Smart Placement で Supabase Tokyo 近傍に配置。cron は専用 Worker の Cron Triggers | PO の指示 [実測]。調査（`research-tech-stack.md`）は Vercel を推奨していたが、Cloudflare は Cron Triggers・WAF による IP 許可リスト・環境分離が標準で揃う **[不明]（プラン別の WAF ルール本数・Access の無料枠・Smart Placement の効果は未検証。A24）**。CPU 時間制限（`limits.cpu_ms`）と Hyperdrive 経由の Postgres 接続は task_003 / task_011 で実測（A20 / A21） | Vercel |
| DB | Supabase Pro（Tokyo）を **prod / staging の 2 プロジェクト**。PITR。Workers からの接続は **Cloudflare Hyperdrive** 経由（transaction スコープの advisory lock のみ使用）、direct connection はマイグレーション専用（CI / ローカル） | 台帳整合性を DB 制約で担保。RPO 15 分 / RTO 4 時間（R-OPS-04） | Turso / PlanetScale |
| DB ロール | **ランタイムは最小権限ロール `app_rw`（`ledger_entry` / `audit_log` は INSERT のみ、DDL なし）。service role はマイグレーション実行時のみで、ランタイム環境変数に置かない。追記専用は `BEFORE UPDATE/DELETE` トリガの `RAISE EXCEPTION`** | RLS deny-all ＋ service role では RLS が素通りし、RULE は無言で 0 行になる（R-SEC-03） | RLS deny-all ＋ service role |
| マイグレーション | 正本は `supabase/migrations/*.sql` の 1 本。Drizzle は型とクエリに限定 | 台帳の二重化を防ぐ（R-SEC-03） | drizzle-kit migrate |
| 認証 | LINE ID トークンをサーバーで verify → 自前セッション JWT（`kid` 二重鍵、`session_epoch`）を `__Host-` Cookie で発行。CSRF はレスポンスボディで返し `X-CSRF-Token` ヘッダで送る（JS 設定の Cookie を使わない） | Supabase Auth に LINE 無し [文書]。R-SEC-08 / 10 / 12 | Supabase Auth |
| 管理面の認証 | LINE セッションとは別系統（GitHub OIDC または WebAuthn）＋リポジトリ管理の管理者許可リスト。ゲート `passed` とフラグ変更は二人承認（第二承認者が確保できない間は A23 の縮退案: 単独承認＋24 時間クーリング＋監査 2 行） | L11 の最終防衛線を LINE セッションに依存させない（R-SEC-06） | LINE セッションの流用 |
| レート制限 | エッジは Cloudflare WAF Rate Limiting ルール（`infra/waf-rules.json` に定義し CI で照合。対象は `/api/auth/line`・`/api/e/preview`・`/api/telemetry/client-error`・`/api/return/*`）。アプリ層のトークン単位・ユーザー単位の制限は Workers の Rate Limiting バインディング、全球で厳密なカウントが要る箇所のみ Durable Object 1 個。**アイソレート内メモリをカウンタに使わない**（A27） | Workers はアイソレート間でメモリを共有しないため in-memory Map は本番で無効（R-SEC-02 / R-SEC-08） | KV（結果整合でカウンタに不適） |
| 決済 SDK | アダプタ内に閉じる。Phase 1 は `package.json` に入れない | 依存が無ければ誤って本番決済を叩けない | — |
| LIFF SDK | npm でバージョン固定してバンドル。`browserslist` とサポート下限を文書化 | CDN 障害・古い WebView の白画面（R-LINE-03） | CDN 直リンク |
| セキュリティヘッダ | nonce ベース CSP、HSTS、X-Content-Type-Options、`Referrer-Policy: no-referrer`。外部遷移は `rel="noreferrer"` | XSS と識別子露出（R-SEC-12 / R-SEC-02） | — |
| テスト | Vitest（`TZ=UTC` 固定）/ supabase ローカル Postgres / Playwright + `@line/liff-mock` / axe-core / 自作 ProviderConformanceKit | §13 | Jest / Stripe CLI |
| 可観測性 | 自前テレメトリ `POST /api/telemetry/client-error`（PII なし）、依存先込みの `/api/health`（`degraded`）、外形監視、ログ集計メトリクス | ブラウザ側の起動失敗がサーバーに残らない（R-LINE-03 / R-OPS-07） | — |
| CI | GitHub Actions | gh 認証済み [実測] | — |

### 7-3. LINE ミニアプリ統合

- プロバイダー「NonTurn LLC」1 つ。配下に LINE ミニアプリチャネル（開発／審査／本番の内部チャネル、各別 LIFF ID・別エンドポイント URL）と **Messaging API チャネル（Phase 1 で開設。幹事向け要対応通知の配送先）**。userId はプロバイダー単位で共通、後から移動不可 [文書]。`app_user.identity_scope` でプロバイダー世代を保持し、幹事にはリカバリトークン（1 回だけ表示・DB はハッシュ）を用意する。
- LIFF ID と LINE Login チャネル ID は **ペアの設定オブジェクトを 1 つの環境変数に束ねる**（`LINE_ENV_PROFILE`）。起動時に `APP_ENV`（wrangler environment から注入: `staging` / `production`）と整合をアサートし、不一致なら起動失敗。`/api/health` が `liffIdFingerprint` / `channelIdFingerprint` / `pepper_fingerprint` を返す。
- Scope は `profile` + `openid` のみ。
- Phase 1・2 は未認証ミニアプリで本番リリース。**Q-LN5（利用者数上限）の回答が前提**。上限があれば認証審査を前倒し。縮退モード（新規招待停止・既存イベントの完走のみ）を用意。
- 起動順序: `liff.init` → **`isInClient` 判定 → 外部なら `liff.login()` を呼ばず `outside_line` へ** → `isLoggedIn` → login（sessionStorage の試行回数 2 回で打ち切り `auth_unavailable`）。フォールバック優先順は「① LINE で開くリンク ② URL コピー ③ QR（別端末用）」。
- 名簿・請求・台帳はミニアプリのエンドポイントドメイン内で完結。外部へ出るのは決済画面のみ。決済からの復帰は **`return_token` 付き復帰エンドポイント**（§7-4）。
- 配布の主導線は **催促文＋URL のクリップボードコピー**と参加者ごとの個別リンク。`shareTargetPicker` は `liff.isApiAvailable()` 判定つきの補助（`GATE-LINE-SHARE`）。`liff.sendMessages()` は使わない。
- 催促はサービスメッセージで送れない前提。Phase 1〜2 は幹事の手動シェア。Phase 3 の催促は送信主体を幹事に固定し、1 請求あたり最大 2 回・間隔 24 時間以上・締切前日と当日のみ・編集不可テンプレート。
- 「主な機能はミニアプリ内で提供」要件のため `(liff)` ルートを主とする。`(web)` は管理者画面と静的法務ページ（O-13 相当の運営者情報・規約・プライバシー）のみ。LINE 非依存の幹事・参加者導線は Phase 1 では作らない（ADR-013、§5）。`build:web-only` は LINE SDK 無しでビルドが通ることの担保。
- サービス定義は「幹事が管理する精算・集金の台帳」。禁止語（寄付・募金・投げ銭・カンパ・支援・応援・クラウドファンディング・チャリティ・自動チェック・自動で確認・入金を確認しました・領収書・インボイス・適格請求書・事業内容の記入例・審査の通し方・未確定の手数料の確定表示）を `docs/wording-policy.md` に置き CI で grep。
- dev 用 LIFF のエンドポイント URL は Cloudflare Workers の staging 環境の固定カスタムドメイン（例 `dev.<domain>`、Cloudflare Access で保護。LIFF の実機確認時は Access のバイパス規則を限定的に適用）に向け、LIFF に触る PR は実機確認を必須にする。

### 7-4. 認証・セッション・復帰

```
LIFF: liff.init → isInClient? (false → outside_line) → isLoggedIn? : login（2 回で打ち切り）→ idToken = liff.getIDToken()
POST /api/auth/line { idToken }（IP 単位のレート制限）
  ① POST https://api.line.me/oauth2/v2.1/verify { id_token, client_id: LINE_ENV_PROFILE.loginChannelId }
  ② sub / aud / exp（許容ずれ 60 秒）を検証。used_id_token に jti（無ければ sha256(idToken)）を exp まで保存し、2 回目の提示は 401
  ③ line_user_ref = HMAC-SHA256(sub, PEPPER[pepper_version])。生の sub は保存しない。旧 pepper_version の行はログイン時に新版へ移行
  ④ app_user を upsert（identity_scope, pepper_version）
  ⑤ セッション JWT（HS256、kid 付き、session_epoch クレーム、30 分スライディング）を __Host- Cookie（HttpOnly / Secure / SameSite=Lax / Path=/）で発行
  ⑥ CSRF トークンはレスポンスボディでのみ返し、以後 X-CSRF-Token ヘッダで送る
```

- `liff.getDecodedIDToken()` / `liff.getProfile()` の結果をサーバーへ送らない [文書]。
- **決済からの復帰は Cookie に依存しない。** アプリ間遷移では Cookie ストアが分かれるため、`createCheckout` 時に 15 分・invoice 1 件に紐付く `return_token` を発行（DB はハッシュ。**読み取りは期限内再利用可、`getPaymentStatus` の外部照会は初回のみ**）し、`returnUrl` に **パスセグメント**として載せる。`GET /api/return/:returnToken` はセッション無しでも当該 invoice の金額と支払状況だけを返し（2 回目以降は DB の現在値。IP 単位のレート制限）、「LINE で開く」パーマネントリンクを提示する。P-6 の自動更新はこの再読み取りで行う。401 は通常系として共通フェッチラッパで 1 回だけ静かに再認証する。
- 識別子規約: 長寿命の識別子（`joinToken` 等）は URL パスに置かずヘッダまたは POST ボディで運ぶ。短命（15 分）・単一リソース（invoice 1 件）・読み取り専用の `return_token` のみパス配置を許す。
- 鍵運用: セッション鍵は現行＋直前の 2 鍵で検証。`session_epoch` を進めるだけで個別・全体の失効ができる。PEPPER は環境間共有・単独ではローテーション不可を明示し、`pepper_version` の二重運用で回す。PEPPER・セッション鍵・`CRON_SECRETS` は外部シークレットストアに置き、未設定または 32 バイト未満なら起動失敗。

### 7-5. 最小 PII と保持

| 項目 | 扱い |
|---|---|
| LINE userId | 生値を保存しない。`line_user_ref`（HMAC、`pepper_version` 付き）のみ。突合（提示された userId をハッシュして一致検索）はできるが逆引きはできない状態を維持し、その手順を `docs/legal-forensics.md` に記載 |
| 幹事の表示名 | `event.organizer_label`（幹事の自己申告、1〜40 文字、イベントスコープ、終了 + 90 日で NULL 化） |
| 参加者の表示名 | `participant.display_label`（幹事が入力、終了 + 90 日で NULL 化）。**未 claim の氏名は幹事だけが読めるラベルとし、参加者間の氏名相互表示は既定で無効** |
| 画像・メール・電話・住所 | 収集しない。連絡は LINE のトークで直接（固定文言） |
| 決済事業者へ渡す情報 | 金額・通貨・`external_ref`・`returnUrl` のみ |
| Webhook 生本文 | `webhook_delivery.raw_body` に 14 日保持（唯一の保管場所）。`payment_event.raw_redacted` は許可キーのみ |
| 監査ログ | ID・enum・金額・タイムスタンプのみ。IP は HMAC |
| プラットフォームログ（Cloudflare Workers Logs / Logpush） | 保持期間と参照権限をプライバシーポリシーに記載 |
| 保持・削除 | 請求・支払・監査は金額と ID のみで 7 年（要弁護士確認）。削除請求への対応は擬似匿名化であり物理削除ではない旨を規約に明記。RPO 15 分 / RTO 4 時間 |
| 同意 | `consent_log` に文言バージョンと取得時刻。幹事と運営者の関係（委託か共同利用か）は ADR と規約で先に確定（Q-LG9） |

### 7-6. 決済アダプタ層と実行時ゲート

- `PaymentProvider` IF v2: **全メソッドの第一引数は `binding`**（`createCheckout(binding, cmd)` / `parseWebhook(binding, raw, headers, secrets[])` / `getPaymentStatus(binding, externalRef)` / `refund(binding, externalRef, money?)` / `cancelCheckout(binding, externalRef)` / `listSettlements?(binding, period)`）。省略すると型エラー。
- `ProviderCapabilities`: `autoDetect` / `webhook` / `webhookSignature` / `statusQuery` / `refund`（`'none'|'full_once'|'full'|'partial'`）/ `refundWindowDays` / `dispute`（`'webhook'|'poll'|'none'`）/ `disputeResponseWindowDays` / `checkoutIdempotent` / `credentialCustody`（`'server'|'organizer'`）/ `settlementQuery` / `feeModel`（率・固定額・未確定フラグ）/ `settlementSchedule` / `payerIdentity: false` 固定 / `settlementLagHint`。`CreateCheckoutCommand` に `timeoutMs`。エラー型に `ProviderAccountError`。
- `Money` はブランド型（`yen(5000)` 以外のコンストラクタ禁止）。アダプタ境界は `toProviderAmount(money)` 1 関数のみ。JPY はゼロデシマル。均等割りは最大剰余法。
- `resolveProvider(key, ctx)`: **`key === 'manual_confirm'` なら以降のガードをすべてスキップして返す**（Phase 1 の唯一の出荷アダプタであり、新規の資金移動を起こさない）。以下は自動アダプタにのみ適用: **環境ガード**（`APP_ENV !== 'production'` なら `ProviderNotEnabledError`）→ `PAYMENTS_ENABLED` → `compliance_gate`（`passed` かつ `valid_until` 内）→ `PROVIDER_<KEY>_MODE` → `provider_binding.status='active'` → 幹事が `suspended` でない → `event.minors_included=false` → fixture が synthesized のみのアダプタは `autoDetect` を拒否。**ゲートが止めるのは `createCheckout` と `provider_binding` 作成のみ。Webhook 受信・保存・照合・`getPaymentStatus`・`refund` は止めない。**
- `ManualConfirmAdapter`: 幹事から任意 URL を受け取らない。受取用の識別子だけを受け取り、リンクはサーバー側の固定テンプレートから組み立てる（許可ホスト限定）。参加者画面に遷移先ホスト名を併記。
- 非自動ラベルの 8 層: ① API 型必須（`autoDetected` / `confirmationMethod` ∈ `automatic | manual_by_organizer | mixed`）、② 幹事画面のバッジ（`InvoiceRow` 必須 props）、③ CSV 列、④ サマリ内訳、⑤ 文言（手動確認に「入金を確認しました」と書かない）、⑥ CI（`gate:wording` ＋スナップショット＋ C10）、⑦ 自己申告状態を支払済みと同じ見た目にしない、⑧ `mixed` の表示規約。
- 代理払いは自動検知できない。`opened_by_user_ref` は弱いシグナルとして O-9 に出し、確定は幹事の手動記録のみ。

### 7-7. インフラ・運用

- cron: 専用の cron Worker（`workers/cron/`、Cloudflare Cron Triggers を同 Worker の `wrangler.toml` の `[triggers] crons` に定義）が `CRON_SECRETS`（カンマ区切りの許容リスト。cron Worker は先頭値を送る）付きで本体を呼ぶ: `/api/cron/reconcile`（5 分）、`/api/cron/outbox`（1 分）、`/api/cron/retention`（日次）、`/api/cron/idempotency-cleanup`（日次。`idempotency_key` と `used_id_token` の期限切れ行を削除）、`/api/cron/audit-verify`（日次）、Phase 2 で `/api/cron/apply-pending`、`/api/cron/refund`。GET/POST 両対応、認可は許容シークレットリスト。**cron の生存は cron 自身ではなく `reconciliation_run` の鮮度で外形から監視する。** Cron Triggers の仕様（最小間隔・タイムアウト・リトライ）は着手前に一次資料を再取得。
- `/api/webhooks/*` と `/api/cron/*` は `APP_ENV !== 'production'` で無条件 404。
- シークレット: 本番鍵は `wrangler secret put --env production`（CI の `environment: production` から投入）にのみ。ローカルの `.dev.vars` には staging の値だけを置く。`provider_binding.credential_ref` は外部シークレットストアのキー名（値は DB に入れない）。復号はメモリ内・API 呼び出し直前のみ、例外メッセージにも出さない、`credential_fp` のみログ。鍵を持たない構成（`credentialCustody: 'organizer'`）を第 2 案として型で用意。
- ログ・ビルド成果物: 資格情報・生 userId・生 IP・`joinToken` 平文を出さない。`.next/static/**` と `.open-next/**`（Workers 用ビルド成果物）を実シークレット名で grep して 0 件。DB クライアントとシークレット取得モジュールに `import 'server-only'`。
- 外形監視: `/api/health`（DB 疎通・reconcile 鮮度・outbox 滞留・直近 Webhook 受信）を定期ポーリングし `degraded` で通知。
- 復旧: 週次の論理バックアップを別ストレージへ。復元リハーサル（別プロジェクトへリストア → `test:integration` / `test:conformance` 緑）を Phase 1 で 1 回、以後四半期 1 回。

### 7-8. 横断規約

- 時刻: 保存はすべて `timestamptz`（UTC）。業務上の日付境界は `AT TIME ZONE 'Asia/Tokyo'` で評価。表示は JST。`date` 型は使わない。テストは `TZ=UTC` と `TZ=Asia/Tokyo` の両方で日付境界が一致することを検証。
- 識別子: §7-4。
- 金額: §7-6。上限 `amount_minor BETWEEN 1 AND 1000000`。
- キルスイッチは「新規の資金移動」だけを止める（§17-4）。

---

## 8. UI Plan

### 8-1. 幹事側

| # | 画面 | 主な要素 | 特有の状態 |
|---|---|---|---|
| O-0 | オンボーディング分岐 | (A) いますぐ使える手動確認版（アプリは入金を検知しない）／(B) 自動検知版（加盟店審査が必要・目安の所要期間）。適格性チェック（継続的な主催者か、特商法表記＝氏名・住所・電話または代替手段を公開できるか。A26）。まず (A) で 1 イベント完走 | — |
| O-1 | 起動・同意 | LIFF 初期化 → ID トークン検証 → 利用規約・プライバシー・支払状況開示への同意（`consent_log`） | loading / outside_line / auth_unavailable / 認証失敗 |
| O-2 | イベント一覧 | 進捗（自動 n / 手動 m / 申告 k）、**要対応件数バッジ常設** | empty / error |
| O-3 | イベント作成 | タイトル・開催日時・会場・提供内容・既定金額・締切（`collect_by_at`）・**集金者としての表示名（必須）**・未成年の有無（必須申告）・現金受付フラグ・**集金総額／手数料概算／受取見込額／入金予定時期の提示と同意チェック（推定値と明示）**・「参加者全員がこの決済手段を使えるか」の確認文 | バリデーション / 二重送信抑止 |
| O-4 | イベント詳細（名簿） | 参加者行（名前・金額・状態バッジ）。状態は **未払い／手続き中（確定前・催促無効）／申告済み（幹事確認待ち）／支払済み（自動）／支払済み（手動）／混在／取消**。既定フィルタ「未払いのみ」、名前検索、並べ替え、カーソルページング（100 名超）。サマリ「支払済み 2/4（自動 1 / 手動 1）」。手数料と受取見込額を並記。claim 解除操作 | empty / 要対応あり |
| O-5 | 参加者登録 | 手入力・一括貼り付け。参加者ごとの個別リンク生成 | 重複警告 / 上限（幹事あたりの人数・イベント数・合計額） |
| O-6 | 請求発行 | 参加者 × 金額 | 既発行スキップ |
| O-6.5 | 請求内容の確認 | 「人数 N × 金額 X = 合計 Y」を大きく表示、過去単価からの乖離警告、2 段階確認 | — |
| O-7 | 配布 | **催促文＋URL コピー（主導線）**、参加者ごとの個別リンク、未払い者だけを再共有、`shareTargetPicker`（可用性判定つき補助）、Flex テンプレ固定（幹事ラベル／イベント名／金額／締切／「支払先は幹事の決済アカウントで、アプリはお金を預かりません」）、リンクを疑われた際の説明テンプレ | picker 不可 / 送信キャンセル |
| O-8 | 手動確認 | 方法・理由必須・メモ。確定前に「これは自動照合ではありません」ダイアログ | — |
| O-9 | 要対応インボックス | 金額不一致／二重払い（台帳残高 > 請求額）／取消後入金／孤児／支払手段なし／手動と自動の混在／紛争／二重送金の可能性（自己申告）／返金期限が近い／代理払いの可能性 | empty（0 件が正常） |
| O-10 | 返金 | 個別・一括返金、部分失敗の表示、`full_once` の事前警告。`refund='none'` → 「この決済手段はアプリからの返金に対応していません」 | 409 |
| O-11 | 決済事業者の接続 | 審査の進捗ステップ表示、接続前の手数料提示、事業者側アカウント無効の状態。ゲート未通過 → 接続ボタン非表示＋説明 | gate_blocked |
| O-12 | CSV | `auto_detected` / `confirmation_method` / 手数料 / 受取見込額。出力名は「会費受領記録」（「本書は適格請求書ではありません」「発行者は幹事です」を固定印字） | — |
| O-13 | 設定・法務 | **Phase 1 から運営者名・所在地・連絡先を掲示**、規約・プライバシー、幹事の特商法表記編集と公開ページ（Phase 2）、データ削除請求（擬似匿名化）、一括エクスポート | — |

### 8-2. 参加者側

| # | 画面 | 主な要素 | 特有の状態 |
|---|---|---|---|
| P-1 | 招待リンク着地 | **同意の前に preview（イベント名・幹事の表示名・締切・参加者数・金額レンジ。氏名と個別金額は出さない）→ 同意 → LINE ログイン** | outside_line / auth_unavailable / トークン無効・期限切れ / claim 済み → 自分の請求へ |
| P-2 | 自己申告（claim） | 個別リンクなら自動確定。名簿選択なら「あなたは〈山田〉さんですか」の確認ダイアログ必須。候補 0 件 → 「名簿への追加をリクエスト」（幹事承認制） | 競合 409 / 承認待ち |
| P-3 | 自分の請求 | 金額・締切・状態・支払ボタン。「LINE のトークで幹事へ連絡」固定文言。「このリンクを自分に送る」導線 | 支払済み / 手続き中 / 申告済み・幹事確認待ち（**未払いと同じ見た目にしない**）/ 復帰せず・確定待ち / 期限切れ / 取消済み |
| P-4 | 支払い方法の選択 | 有効なアダプタ。手動確認には「幹事が手動で確認します」。**「この方法では払えない」導線常設**（要対応キューへ）。現金受付が有効なら現金 | 有効なアダプタなし |
| P-5 | 決済事業者へ遷移 | 遷移先ホスト名を併記 | 遷移失敗 |
| P-6 | 決済からの復帰 | `GET /api/return/:returnToken`（Cookie 非依存）で状態を確定。初回のみ `getPaymentStatus`、以後の自動更新は DB の現在値の再読み取り。未確定なら「確認中（最大 5 分で自動反映）」＋自動更新＋「LINE で開く」 | 確定 / 未確定 / 失敗 / 期限切れ（15 分超は「LINE で開いて確認」） |
| P-7 | 完了 | 会費受領記録・幹事への連絡（固定文言） | — |

### 8-3. 共通規約・レスポンシブ・a11y

- 全画面で `loading` / `empty` / `error`（`requestId` は不透明 ID）/ `forbidden` / `outside_line` / `auth_unavailable` / `gate_blocked` / `degraded`（確定遅延の告知帯）を実装。
- LINE アプリ内ブラウザの縦画面。最小幅 320px で横スクロールなし。名簿は 1 行 1 参加者。
- WCAG 2.2 AA。支払状態は色＋テキスト＋アイコンの三重表現。最小タップ 44px。rem 指定。フォント 200% で崩れない。ダークモード。`npm run test:a11y`（axe-core）違反 0。
- Cookie / localStorage に状態を持たせない。タイポグラフィは `web-typography` スキル準拠。

---

## 9. API Plan

JSON。エラーは `{ code, message, requestId }`。状態変更系は `Idempotency-Key` 必須（主キー `(user_ref, endpoint, key)`、`in_flight` 先行予約、`request_hash` 不一致は 409、TTL 24 時間、`response_body` は許可フィールドのみ）。参加者向けのトークンは **ヘッダ `X-Join-Token` または POST ボディ**で運ぶ（パスに置かない）。

| メソッド | パス | 認可 | 要点 | 主なエラー |
|---|---|---|---|---|
| POST | `/api/auth/line` | ID トークン検証（IP レート制限） | §7-4 | 401 `ID_TOKEN_INVALID` / 429 |
| GET | `/api/me` | セッション | events[], claimedInvoices[] | 401 |
| GET | `/api/me/export.zip` | セッション | 本人の全イベントのエクスポート | 401 |
| POST | `/api/consent` | セッション | `consent_log` に文言バージョンと時刻 | 400 |
| POST | `/api/events` | セッション | 必須: `organizerLabel`, `eventAt`, `venue`, `offering`, `defaultAmountMinor`, `collectByAt`, `minorsIncluded`, `allowCash`, 手数料提示への同意。`joinToken` はこの応答でのみ返す | 400 / 409 / 429（上限） |
| GET | `/api/events/:id` | 当該 organizer（SQL の WHERE 必須） | **サマリ専用**（内訳、要対応件数、手数料・受取見込額） | 403 / 404 |
| GET | `/api/events/:id/participants` | 当該 organizer | `cursor` / `filter=unpaid` / `q` / `sort` | 403 |
| PATCH | `/api/events/:id` | 当該 organizer | title / collectByAt / status | 403 / 409 |
| POST | `/api/events/:id/cancel` | 当該 organizer | 配下の active invoice を void、生きた attempt を `cancelCheckout`、返金タスク（Phase 2） | 403 |
| POST | `/api/events/:id/participants` | 当該 organizer | 一括登録。参加者ごとの `claim_token` を発行（応答でのみ返す） | 400 / 403 / 429 |
| DELETE | `/api/events/:id/participants/:pid` | 当該 organizer | **論理削除**（`status='removed'`）。生きた attempt があれば 409 `HAS_OPEN_ATTEMPT`、`settlement_rank >= 40` なら 409 | 409 |
| POST | `/api/events/:id/participants/:pid/unclaim` | 当該 organizer | 理由必須。支払済みなら `needs_attention` | 403 |
| POST | `/api/events/:id/participants/:pid/approve-add` | 当該 organizer | 参加者からの追加リクエストの承認 | 403 |
| POST | `/api/events/:id/rotate-join-token` | 当該 organizer | 旧トークン失効 | 403 |
| GET | `/api/events/:id/join-token` | 当該 organizer | 現行トークン（配布画面用） | 403 |
| POST | `/api/events/:id/invoices` | 当該 organizer | O-6.5 の確認済みフラグ必須 | 400 / 403 |
| PATCH | `/api/invoices/:id` | 当該 organizer | `settlement_rank=0` かつ open attempt 無しのみ金額変更 | 409 |
| POST | `/api/invoices/:id/void` | 当該 organizer | `settlement_rank < 40` かつ active のみ。Webhook 経路からは呼べない | 409 `VOID_NOT_ALLOWED` |
| POST | `/api/invoices/:id/manual-attest` | 当該 organizer | reason 必須。`confidence='organizer_attested'` | 400 / 403 |
| POST | `/api/invoices/:id/refund` | 当該 organizer | `capabilities.refund` と `refundWindowDays` に従う。ゲート off でも動く | 409 `NOT_SUPPORTED` |
| POST | `/api/events/:id/refund-all` | 当該 organizer | 冪等・部分失敗を個別再実行（Phase 2） | 409 |
| GET | `/api/events/:id/export.csv` | 当該 organizer | `auto_detected` / `confirmation_method` / 手数料列 | 403 |
| GET | `/api/e/preview` | **セッション不要**（`X-Join-Token`、IP レート制限） | イベント名・幹事ラベル・締切・人数・金額レンジのみ | 404 / 429 |
| GET | `/api/e/candidates` | セッション＋同意（`X-Join-Token`） | 未 claim の候補（氏名のみ、幹事が `name_visibility` を許可した場合） | 401 / 403 |
| POST | `/api/e/claim` | セッション＋同意 | `{ participantId }` または `{ claimToken }`。確認済みフラグ必須 | 409 `ALREADY_CLAIMED` |
| POST | `/api/e/request-add` | セッション＋同意 | 名簿への追加リクエスト（幹事承認制） | 429 |
| GET | `/api/e/me` | セッション＋ claim 済み | 自分の請求のみ | 403 `NOT_CLAIMED` |
| POST | `/api/e/checkout` | セッション＋ claim 済み | **金額を取らない**。生きた attempt があれば同じ `checkoutUrl` を返す。`payment_attempt` を write-ahead | 409 `GATE_NOT_PASSED` / `PROVIDER_NOT_ENABLED` / `NO_PAYMENT_METHOD` |
| POST | `/api/e/self-report` | セッション＋ claim 済み | `payment_self_report` にのみ記録。台帳には書かない | 429 |
| POST | `/api/e/cannot-pay` | セッション＋ claim 済み | 要対応「支払手段なし」 | — |
| POST | `/api/e/report` | セッション＋同意（`X-Join-Token`。claim 前でも可） | `abuse_report` に記録（`event_id` / `reporter_user_ref` / `reason`）。レート制限 | 429 |
| POST | `/api/providers/bind` | 当該 organizer。`GATE-CRED-CUSTODY` が passed または n/a | `provider_binding` の作成（`credential_ref` はキー名のみ）。Phase 2 | 409 `GATE_NOT_PASSED` |
| GET | `/api/return/:returnToken` | **セッション不要・15 分・invoice 1 件スコープ・IP レート制限** | 当該 invoice の金額と状態のみ。`getPaymentStatus` は初回のみ（2 回目以降は DB の現在値） | 404 / 410（15 分超過）/ 429 |
| POST | `/api/webhooks/:providerKey/:bindingRef` | 送信元 IP 許可リスト → `external_ref` 書式 → binding 解決 → シークレット取得 → 署名検証。**`APP_ENV !== 'production'` は 404**。CSRF 除外 | ゲート未通過でも受信・保存し適用のみ保留 | 400 `SIGNATURE_INVALID` / 403 / 404 |
| POST | `/api/telemetry/client-error` | なし（レート制限） | `{ code, liffIdFingerprint, uaClass, requestId }` のみ | 429 |
| GET/POST | `/api/cron/reconcile` / `outbox` / `retention` / `idempotency-cleanup` / `audit-verify` / `apply-pending` / `refund` | 許容シークレットリスト。非 production は 404 | xact advisory lock | 401 |
| GET | `/api/admin/gates` | 管理者（別 IdP・許可リスト） | **読み取りのみ**（正本は `docs/gates/*.json`） | 403 |
| POST | `/api/admin/flags` | 管理者・二人承認 | `PAYMENTS_ENABLED` / `PROVIDER_<KEY>_MODE`。全操作を audit_log | 403 |
| GET | `/api/admin/lookup` | 管理者 | `invoice_id` / `external_ref` / `requestId` で照会。`display_label` を返さない | 403 |
| POST | `/api/admin/anonymize` | 管理者 | 削除請求への擬似匿名化 | 403 |
| POST | `/api/admin/suspend` | 管理者・二人承認（A23 の縮退可） | 幹事の `suspended_at` 設定。全操作を audit_log | 403 |
| GET | `/api/health` | なし | `{ status: ok|degraded, db, reconcileStalenessSec, outboxOldestSec, webhookLastSeenSec, pepperFingerprint, liffIdFingerprint, channelIdFingerprint }` | — |

**認可の原則**: 所有者判定をリクエストボディから取らない。リポジトリ関数は `organizerUserId` を必須引数に持つ。イベント単位トークン（`joinToken`、128 ビット CSPRNG、`join_token_expires_at`、ローテーション可）は候補一覧の表示までの権限。請求の閲覧・支払いは参加者単位 claim トークンまたは幹事承認を要する。preview は認可ではなく公開最小情報。

**Webhook 処理手順**: ① 送信元 IP 許可リスト（Cloudflare WAF カスタムルール（`infra/waf-rules.json`）をリポジトリ内に明記し CI で Cloudflare API の実設定と照合。許可外は本文を読まず 403）→ ② `external_ref` 書式検査（不正は 400）→ ③ `bindingRef` 解決 → シークレット取得 → `parseWebhook`（署名検証。複数シークレット）→ ④ `webhook_delivery` 記録 → ⑤ 同一トランザクションで `payment_event` INSERT（`ON CONFLICT DO NOTHING RETURNING`）＋ `applyToLedger`。`trust='unverified'` は `getPaymentStatus` で再照会（矛盾なら `mismatch`）。attempt 無しは `orphan` として `outbox` に `orphan_alert`。⑥ 2xx を素早く返す。分離せざるを得ない場合は `/api/cron/apply-pending` で必ず再適用。

**`applyToLedger` の不変条件**: 突合基準は `payment_attempt.amount_minor`（参加者に提示した金額）。**金額・通貨が一致しないイベントはランクを前進させず、受領事実を `ledger_entry.kind='adjustment'` として記録し `needs_attention` を立てる。** ランクは `WHERE settlement_rank < $new` の前進のみ。`charged_back`（80）へ前進する分岐を持つ。二重払いは attempt 件数ではなく「台帳残高 > 請求額」で検知。`confirmation_method` は `ledger_entry.confidence` の集合から導出（`automatic` / `manual_by_organizer` / `mixed`）。取消済み請求への入金は前進させつつ `void` 維持・`needs_attention`・`paid_after_void`。

**再照合ジョブ**: `pg_try_advisory_xact_lock` → 状態走査 `settlement_rank < 40 AND lifecycle_state='active' AND (is_open OR (status='expired' AND updated_at > now() - 4 days))` を `ORDER BY updated_at ASC LIMIT 100`（上限到達は `note='truncated'`）→ 1 件 3 秒 timeout・並列 5 → expired へ落とす前に最終照会 1 回 → 走査 2（`settlement_rank >= 40 AND paid_at > now() - 30 days` を日次 1 回再照会し事業者側の返金・紛争を反映）→ `reconciliation_run` に `scanned` / `advanced` / `mismatches` / `paid_rescanned` / `post_paid_changes`。

---

## 10. Database Plan

### 10-1. 設計方針

- `invoice.settlement_status` は誰も直接 UPDATE しない。事実は `payment_event`（冪等）と `ledger_entry`（追記専用）にだけ書き、`invoice` の状態は射影として単調に前進する。
- 状態は 2 軸。軸 1 `settlement_status` / `settlement_rank`（生成列、`CHECK (settlement_rank IS NOT NULL)`、`ELSE NULL` 禁止）。軸 2 `lifecycle_state`（active | void）。`settled_at` は Phase 3 の `payout` へ。
- 二重計上防止は 3 段: `payment_event (provider_key, provider_event_id)` 一意、`ledger_entry (invoice_id, dedupe_key)` 一意、`invoice` 更新の代入的冪等。`business_idem_key` は UNIQUE にしない。
- 残高整合: 台帳残高（credit − debit）と `settlement_status` の整合を日次監査。部分返金は Phase 2 で非対応（`refunded` は全額返金に限定）。
- 追記専用は `BEFORE UPDATE/DELETE` トリガの `RAISE EXCEPTION`。RULE は使わない。監査連鎖は `id` 順で確定し、書き込み時に `pg_advisory_xact_lock(AUDIT_CHAIN_LOCK)` で直列化。

### 10-2. テーブル一覧（DDL 全文は task_011 で `supabase/migrations/0001_init.sql` に置く。ベースは `docs/research/design-synthesis.md` §2-2 に本節の差分を適用）

| テーブル | 役割 | 主要制約・列（設計ブリーフからの差分は太字） |
|---|---|---|
| `app_user` | LINE ユーザー | `line_user_ref bytea`、**`pepper_version smallint`、`session_epoch integer`、`identity_scope text`、`line_env text`、`suspended_at`**、一意制約 **`(identity_scope, pepper_version, line_user_ref)`**、`tos_accepted_at`、`privacy_consent_at` |
| `used_id_token` | **ID トークン単回使用** | `jti_or_hash text PK`、`expires_at`（TTL = exp） |
| `consent_log` | **同意ログ** | `user_id`、`consent_kind`、`text_version`、`accepted_at` |
| `provider_binding` | 幹事の決済事業者アカウント | **`credential_ref text NULL`**（キー名のみ）、`credential_fp`、**`receiving_identifier text` ＋形式 CHECK、`fee_rate_bp integer`**、`capabilities jsonb`、`status`（pending / active / suspended / revoked）、`UNIQUE (organizer_user_id, provider_key)` |
| `event` | イベント | **`organizer_label text NOT NULL CHECK (length BETWEEN 1 AND 40)`**、`event_at`、**`venue`、`offering`**（対価性の証跡）、`currency CHECK ('JPY')`、`default_amount_minor`、**`collect_by_at timestamptz`**、`status`、`join_token_hash bytea UNIQUE`、**`join_token_expires_at`、`join_token_version`、`allow_cash boolean`、`minors_included boolean NOT NULL`**、`provider_key DEFAULT 'manual_confirm'`、`provider_binding_id`、`retention_due_at` |
| `participant` | 名簿 | `display_label`、**`claim_token_hash bytea`、`name_visibility text`、`confirmed_by_organizer_at`、`pepper_version`**、`status`（active / removed） |
| `participant_claim` | **claim 履歴** | `participant_id`、`line_user_ref`、`claimed_at`、`released_at`、`released_reason`。部分一意 `(event_id, line_user_ref) WHERE released_at IS NULL` |
| `invoice` | 請求 | `amount_minor CHECK (BETWEEN 1 AND 1000000)`、`settlement_status`、`settlement_rank` 生成列 **NOT NULL**、`lifecycle_state`、`needs_attention`、`paid_at`、`participant_id` **`ON DELETE RESTRICT`**、`UNIQUE (event_id, participant_id)`、`invoice_recon_idx` |
| `payment_attempt` | 決済試行 | **`provider_binding_id NOT NULL`**、`external_ref`（`iv_<hex>_<seq>`、64 文字・`[A-Za-z0-9_-]`）、`amount_minor`（突合基準）、`status`、`is_open` 生成列、**`UNIQUE (invoice_id) WHERE is_open`、`return_token_hash`、`return_token_expires_at`**、`opened_by_user_ref`、`UNIQUE (provider_key, external_ref)` |
| `payment_event` | 外部由来イベント | `UNIQUE (provider_key, provider_event_id)`、`kind`（authorized / succeeded / failed / canceled / expired / refunded / **refund_pending / refund_failed / disputed / dispute_resolved** / unknown）、`ingestion_source`、`trust`、`apply_result`、**`raw_redacted jsonb`**（許可キーのみ） |
| `ledger_entry` | 台帳（追記専用） | `direction`、`kind`（payment / refund / overpay / proxy_payment / adjustment / writeoff / **chargeback / chargeback_reversal / fee**）、`confidence`、`UNIQUE (invoice_id, dedupe_key)`、**トリガで UPDATE/DELETE 例外** |
| `payment_self_report` | **参加者の自己申告** | `invoice_id`、`reported_by_user_ref`、`method`、`reported_at`。台帳には書かない |
| `manual_attestation` | 手動確認の証跡 | `method`、`reason NOT NULL CHECK (length(btrim(reason)) > 0)`、`evidence_note` |
| `audit_log` | 監査（append-only ＋連鎖） | `id` 順で連鎖確定、`prev_hash` / `row_hash`、`actor_type`、`source_ip_hash`、**トリガで UPDATE/DELETE 例外** |
| `compliance_gate` | ゲートの射影（正本は JSON） | `gate_key PK`、`status`、`evidence_uri`、**`valid_until`、`evidence_version`、`source_url_hash`、`approved_by`（申請者と別人）、`CHECK (status <> 'passed' OR evidence_uri IS NOT NULL)`** |
| `feature_flag` | フラグ | `key PK`、`value`、`updated_by`（人間のみ） |
| `outbox` | 非同期タスク | `kind`（配達先対応表を持つ）、`run_after`、`attempts`、**`max_attempts`、`dead_lettered_at`**、`locked_until` |
| `webhook_delivery` | 受信ログ | `sig_ok`、`body_sha256`、`raw_body`（14 日）、`source_ip_hash`、**`ip_allowed boolean`** |
| `reconciliation_run` | 照合実行記録 | `scanned` / `advanced` / `mismatches` / **`paid_rescanned` / `post_paid_changes` / `note`** |
| `idempotency_key` | 冪等キー | **PK `(user_ref, endpoint, key)`、`state`（in_flight / done）、`expires_at`**、`request_hash`、`response_body`（許可フィールドのみ） |
| `abuse_report` | **参加者からの通報** | `event_id`、`reporter_user_ref`、`reason`、`created_at` |
| `reminder_log` | **催促ログ（Phase 3）** | `invoice_id`、`sent_by_organizer`、`sent_at`。一意制約で回数上限 |
| `payout` | **入金（Phase 3）** | `provider_binding_id`、`period`、`amount_minor`、`fee_minor`、`settled_at` |

### 10-3. ロール・マイグレーション・検証

- `0001_init.sql`: 全テーブル・制約・生成列・インデックス・トリガ。**`CREATE ROLE app_rw`** と GRANT（`ledger_entry` / `audit_log` は INSERT のみ、DDL なし）。ランタイム接続文字列は `app_rw`。
- `0002_seed_gates.sql`: `compliance_gate` の初期在庫は `docs/gates/*.json` から同期（`gates-sync`）。`feature_flag PAYMENTS_ENABLED='false'`。
- 統合テスト（`npm run test:integration`）: 生成列、**`app_rw` からの UPDATE/DELETE が例外**（0 行成功は不合格）、`role_table_grants` スナップショット一致、`payment_event` 重複 0 行、`ledger_entry` dedupe 0 行、`participant_claim` 部分一意、`payment_attempt` の open 一意、`settlement_rank IS NULL` 0 件、未知 status の拒否、`supabase db diff` 差分 0。

---

## 11. File-by-File Plan

リスク: **high** = 資金・認可・冪等・ゲート・鍵、**medium** = 機能・UI、**low** = 設定・文書。`create` が基本。`modify` は先行タスクの成果物を後続タスクが変更する場合。

### 11-1. 計画・文書（`docs/`）

| ファイル | 操作 | 目的・期待する変更 | リスク |
|---|---|---|---|
| `docs/implementation-plan.md` / `task-list.json` / `acceptance-checks.json` | create（本書） | 照会結果・プレモータム再実行で更新 | low |
| `docs/research/*` | create（済） | 参照専用 | low |
| `docs/constraints.json` | create（task_004） | L/P/W/N/I ＋プレモータム由来の横断規約（時刻・識別子・金額）を機械可読化 | medium |
| `docs/wording-policy.md` | create（task_004） | 禁止語・許可文言（「幹事が受け取ったと申告」「あなたの申告を幹事が確認中です」等） | medium |
| `docs/external-inquiries.json` / `docs/inquiries/*.md` | create（task_002） | `no_response_deadline` / `default_decision_on_timeout` 必須 | medium |
| `docs/gates/legal-clearance.json` / `docs/gates/compliance-gates.json` / `docs/gates/release-<version>.json` | create（task_002 / 005） | ゲートの正本。`cleared` の変更は PO のみ | **high** |
| `docs/decisions/ADR-001..` | create | `confidence` 欄必須。[設計]/[不明] 依存は `proposed` 止まり。ADR-001 資金フロー・販売事業者、ADR-002 バージョン、ADR-003 モデル配置、ADR-004 PayPay、ADR-005 カストディ、ADR-006 複数 provider、ADR-007 生 userId 同意、ADR-008 BankReconciler、ADR-009 nonce 不採用と単回使用、ADR-010 Q-LG1 否定分岐、ADR-012 ホスティング（Cloudflare 採用と未確認事項 A20 / A21） | medium |
| `docs/PROGRESS.md` / `docs/HANDOFF.md` | create（task_005） | Stop フックで毎ターン追記 | low |
| `docs/run-log/<task_id>.json` | create（`scripts/record-run.sh` のみが書ける） | 実 exit code・stdout 末尾・HEAD・UTC 時刻 | **high** |
| `docs/review-log/<task_id>.md` | create | 封筒全文。`model_id_actual` / `cli_version` / `backend` 必須 | medium |
| `docs/harness-capability.md` | create（task_006） | フック 6 イベント × 遮断挙動の [実測] マトリクス、敵対レビュー経路の可否 | medium |
| `docs/supported-browsers.md` / `docs/privacy-policy.md` / `docs/legal-forensics.md` / `docs/incident-response.md` | create（task_013 / 021） | サポート下限、委託先・保管国・外的環境、突合手順、漏えい対応の期限と担当 | medium |
| `docs/runbooks/RB-01..RB-10.md` | create（task_021） | 決済障害 / 返金要求 / 鍵ローテ / 事業者アカウント停止 / キルスイッチ / 削除請求 / インシデント連絡 / バックアップ復旧 / 招待トークン漏洩 / orphan 復旧 | medium |
| `docs/vendor-docs/<provider>/<topic>.md` | create | 取得日つき一次資料スニペット（PayPay Webhook / IP / SDK、LINE verify / share、Cloudflare Cron Triggers / Hyperdrive / OpenNext） | low |
| `docs/metrics/weekly-*.json` / `model-bench.md` | create | 週次指標・実測ベンチ | low |
| `docs/premortem/<date>.json` | create（Workflow） | 再実行の差分 | low |
| `docs/ops/*.md`（supabase / cloudflare / backup / line-channels / monitoring / device-check / reconcile-monthly / first-live-payment / load-test / line-verification / key-rotation-drill / env-baseline.json） | create（task_023 / 024 / 025 / 028 / 029 / 031 / 033 / 035） | 環境構成・復元手順・チャネル構成・監視・月次突合・初回実決済・負荷試験・認証審査・鍵ローテ演習の実施記録 | medium |
| `docs/pilot/*.md` | create（task_025） | クローズド β の完走記録とフィードバック（PII なし） | low |
| `docs/gates/release-mode.json` | create（task_009） | `{ payments_enabled: false, provider_keys: ["manual_confirm"], basis, approved_by }`。`release.yml` の 2 段ゲートの入力。変更は PO のみ | **high** |
| `infra/waf-rules.json` | create（task_027） | Cloudflare WAF カスタムルールと Rate Limiting ルールの定義。CI（`gate:waf`）で API 実設定と照合 | **high** |
| `scripts/ci/*.{mjs,sh}` | create（task_009 / 027） | PR チェックリスト検査、シークレット grep、release ゲート静的検査、WAF 照合 | **high** |

### 11-2. ハーネス（`.claude/`, `scripts/`, `.github/`, `tests/gates/`）

| ファイル | 操作 | 目的 | リスク |
|---|---|---|---|
| `.claude/settings.json` | create（task_005） | SessionStart / UserPromptSubmit / PreToolUse（Bash, Edit\|Write\|MultiEdit）/ PostToolUse / Stop / SubagentStop。**PreCompact には依存しない** | **high** |
| `scripts/deny-dangerous-bash.sh` | create（task_005） | 破壊的・本番系（`wrangler deploy --env production`、`wrangler secret put ... --env production`、`supabase db push`）・`pnpm` を exit 2。`legal-clearance.json.cleared` が `true` でない限り決済・本番系を拒否 | **high** |
| `scripts/deny-test-weakening.sh` | create（task_005） | テスト弱体化、本番鍵書き込み、**`docs/run-log/**` と `acceptance-checks.json` の `evidence` への直接書き込み**を exit 2 | **high** |
| `scripts/record-run.sh` | create（task_005） | run-log の唯一の書き込み経路 | **high** |
| `scripts/session-brief.mjs` / `gate-status.mjs` / `assert-diff-exists.sh` / `append-handoff.sh` | create（task_005） | 注入・Stop 時の HANDOFF 追記・diff 検算 | medium |
| `scripts/test-hook-enforcement.sh` | create（task_006） | フック実在マトリクスの実測 | medium |
| `scripts/gate-constraints.sh` / `wording-lint.mjs` | create（task_004） | grep ゲート（`dangerouslySetInnerHTML` / `eval` / `new Function` / `NEXT_PUBLIC_` denylist / `server-only` 義務 / `liff.sendMessages` / `req.json()` in webhook / `date` 型 / `Math.round` on money を含む）。対象 0 件なら exit 1 | **high** |
| `scripts/gate-check.mjs` | create（task_006） | G0〜G14 | **high** |
| `scripts/validate-plan-json.mjs` / `assert-verify-commands.mjs` / `assert-acceptance.mjs` / `gate-env-scope.mjs` / `assert-server-only.mjs` / `gate-integrity.mjs` / `gates-sync.mjs` | create（task_006 / 011 / 021） | JSON 検証・コマンド実在・evidence 照合・env スコープ・server-only 到達性・ゲート定義ハッシュ・JSON⇔DB 同期 | **high** |
| `tests/gates/fixtures/violations/**` | create（task_006。最初の 1 本は人間が手書き） | 各ゲートが必ず落とす違反サンプル 10 本以上 | **high** |
| `.claude/agents/*.md`（6 本） | create（task_007） | 封筒固定。受入テスト生成は `src/**` 読み取り不可のツール制限 | medium |
| `scripts/build-review-packet.sh` / `merge-review.sh` / `validate-findings.mjs` / `review-gemini.mjs` / `review-gpt.mjs` | create（task_007） | `constraint_ids` の制約のみ同梱、diff が触れたファイル全文と import 先を同梱、repro 必須、`model_id_actual` 必須、`unavailable` / `model_mismatch` の記録 | **high** |
| `.claude/workflows/task-loop.ts` / `premortem.ts` / `release-audit.ts` | create（task_008） | §15-3 | medium |
| `.github/workflows/gate.yml` / `e2e.yml` / `release.yml`、`.github/PULL_REQUEST_TEMPLATE.md`、`.github/CODEOWNERS` | create（task_009） | §16-6。PR テンプレートに実機確認欄とゲート緩和チェックリスト | **high** |
| `scripts/bench-models.sh` | create（task_010） | 実測ベンチ | low |

### 11-3. アプリ本体（`src/`, `supabase/`, `tests/`, ルート）

| ファイル | 操作 | 目的 | リスク |
|---|---|---|---|
| `package.json` / `.npmrc` / `tsconfig.json` / `next.config.ts` / `eslint.config.mjs` / `vitest.config.ts` / `playwright.config.ts` / `drizzle.config.ts` / `wrangler.toml` / `open-next.config.ts` / `workers/cron/*` / `.dev.vars.example` / `.browserslistrc` / `.env.example` / `.gitignore` | create（task_003） | 骨格。`wrangler.toml` は environments（staging / production）/ Hyperdrive バインディング / `limits.cpu_ms` / Smart Placement。`workers/cron/` は Cron Triggers 専用 Worker | medium |
| `supabase/config.toml` / `supabase/migrations/0001_init.sql` / `0002_seed_gates.sql` | create（task_011） | §10 | **high** |
| `src/lib/db/schema.ts` / `client.ts`（`server-only`）/ `repositories/*.ts` | create（task_011, 014, 015） | `organizerUserId` 必須引数 | **high** |
| `src/lib/config/env.ts` | create（task_012） | `LINE_ENV_PROFILE`、必須 env 検証、`APP_ENV` 整合アサート | **high** |
| `src/lib/auth/line-verify.ts` / `pepper.ts` / `session.ts` / `csrf.ts` / `used-token.ts` / `rate-limit.ts` | create（task_012） | §7-4 | **high** |
| `src/middleware.ts` / `src/lib/security-headers.ts` | create（task_012） | セッション・CSRF・CSP・環境ガード | **high** |
| `src/app/api/**`（§9 の全ルート） | create（task_012〜021、Phase 2 で追加） | §9 | **high** |
| `src/lib/payments/types.ts` / `registry.ts` / `gates.ts` / `money.ts` / `providers/manual-confirm.ts` | create（task_017） | IF v2、ゲート、ブランド型 | **high** |
| `src/lib/payments/providers/paypay-online.ts` / `payjp.ts` | create（Phase 2） | Phase 1 では作らない | **high** |
| `src/lib/ledger/apply.ts` / `rank.ts` / `dedupe.ts` / `balance.ts` | create（task_018） | 不変条件 | **high** |
| `src/lib/audit.ts` / `outbox.ts` / `idempotency.ts` / `secrets.ts` / `errors.ts` / `logger.ts` / `reconcile.ts` / `retention.ts` / `telemetry.ts` / `health.ts` | create（task_014〜020） | — | **high** |
| `src/lib/liff/client.ts` / `mock.ts` / `share.ts` | create（task_013, 016） | 起動順序・フォールバック | medium |
| `src/lib/line/messaging.ts` | create（task_023） | 幹事向け要対応通知 | medium |
| `src/app/(liff)/**` / `src/app/(web)/**` / `src/components/**` / `src/content/terms.md` / `privacy.md` / `src/styles/tokens.css` | create（task_013〜021） | §8 | medium |
| `tests/unit/**` / `tests/contract/**` / `tests/conformance/**` / `tests/integration/**` / `tests/e2e/**` / `tests/security/**` / `tests/a11y/**` / `tests/fixtures/<provider>/*.json`（`captured_from` 必須） | create（task_011〜025） | §13・§14 | **high** |

---

## 12. Implementation Order

**順序規律**: ハーネス必須セット（task_003〜task_006、task_009 の一部）が「違反フィクスチャで落ちる」状態になるまで機能タスクに着手しない。必須セットは週 0 の 5 営業日にタイムボックスし、超過したら残件を `docs/PROGRESS.md` に記録して機能実装へ移る。Phase 0 は非コードで並行。Phase 2 は `docs/gates/*.json` の必須ゲートが `passed` になるまで `main` にマージしない。実行順の正本は本節の表であり、`docs/task-list.json` の配列順ではない。各タスクの `dependencies` の正本は `docs/task-list.json` で、本表の依存欄はその転記である。

| 順 | task_id | タイトル | Phase | 依存 |
|---|---|---|---|---|
| 1 | task_001 | G0-USER 同意と ADR-001（資金フロー・販売事業者・ターゲット） | 0 | — |
| 1' | task_036 | ゲート台帳と照会追跡台帳の雛形（非ブロッキング。同意や送付を待たない） | 0 | — |
| 2 | task_002 | 外部照会文の起案（Q-LG1 単独先行）と ADR-010 | 0 | task_001, task_036 |
| 2' | task_037 | 照会の送付・回答追跡・ゲート更新（PO） | 0 | task_002 |
| 3 | task_003 | プロジェクト初期化 | H | — |
| 4 | task_004 | 制約・禁止語の機械可読化と grep ゲート | H | task_003 |
| 5 | task_005 | フック群・deny スクリプト・record-run・HANDOFF 追記・legal-clearance | H | task_004 |
| 6 | task_006 | gate-check（G0〜G14）・違反フィクスチャ・メタゲート・フック実在マトリクス | H | task_005 |
| 7 | task_009 | CI・PR テンプレート・tamper guard・release-mode ゲート・5 営業日判定の記録（必須セット分） | H | task_006 |
| 8 | task_007 | （任意セット）エージェント定義・封筒スクリプト | H | task_006 |
| 9 | task_008 | （任意セット）Workflow 3 本 | H | task_007 |
| 10 | task_010 | （任意セット）ベンチ・codex フック・敵対レビュー経路の実測 | H | task_007, task_009 |
| 11 | task_011 | DB スキーマ v2・ロール・マイグレーション・統合テスト | 1 | task_009, task_036 |
| 11' | task_035 | staging Supabase ＋ Hyperdrive の作成と A21 実測（台帳実装より前） | 1 | task_011 |
| 12 | task_012 | 認証・セッション・CSRF・鍵運用・環境設定・セキュリティヘッダ | 1 | task_011 |
| 13 | task_013 | LIFF 外殻・起動順序・テレメトリ・フォールバック・ルートグループ | 1 | task_012 |
| 14 | task_014 | イベント・参加者 API と幹事画面（O-2〜O-6.5） | 1 | task_013 |
| 15 | task_015 | 請求・招待トークン・claim・preview・自己申告・参加者画面 | 1 | task_014 |
| 16 | task_016 | 配布（コピー主導線・個別リンク・picker 補助） | 1 | task_015 |
| 17 | task_017 | アダプタ IF v2・レジストリ・ManualConfirm・ラベル 8 層・O-0 | 1 | task_015 |
| 18 | task_018 | 台帳適用・冪等・監査連鎖・Webhook ルート・契約テスト | 1 | task_017, task_035 |
| 19 | task_019 | ProviderConformanceKit C1〜C31 | 1 | task_018 |
| 20 | task_020 | cron（照合・outbox・保持・掃除・監査検証） | 1 | task_018 |
| 21 | task_021 | 管理面・要対応・CSV・法務文書・ランブック・悪用対策 | 1 | task_020 |
| 22 | task_022 | E2E・セキュリティ・a11y・LINE 非依存ビルド | 1 | task_021 |
| 23 | task_023 | Messaging API チャネル・幹事通知・外形監視・degraded | 1 | task_020 |
| 24 | task_024 | 本番環境分離・Access・バックアップ復元リハーサル | 1 | task_035, task_012 |
| 25 | task_025 | LINE チャネル構成・本番デプロイ・実機確認・パイロット | 1 | task_022, task_023, task_024 |
| 26 | task_026 | PayPayOnlineAdapter（サンドボックス・実キャプチャ fixture） | 2 | task_019, task_001, task_037 |
| 27 | task_027 | Webhook 有効化・IP 許可リスト・return_token 復帰・手続き中表示 | 2 | task_026, task_020 |
| 28 | task_028 | binding 接続・カストディ・返金・中止・紛争・アカウント停止・手数料提示 | 2 | task_027, task_021 |
| 29 | task_029 | 本番有効化・実決済・負荷・キルスイッチ・legal-clearance | 2 | task_028, task_025 |
| 30 | task_030 | PayjpAdapter と core diff 検証 | 2 | task_029 |
| 31 | task_031 | （optional）認証審査・サービスメッセージ | 3 | task_029 |
| 32 | task_032 | （optional）催促・横断台帳・payout | 3 | task_031 |
| 33 | task_033 | （optional）鍵ローテーション演習 | 3 | task_029, task_021 |
| 34 | task_034 | （optional）BankReconciler 調査 | 3 | task_029 |

---

## 13. Verification Commands

**現時点でリポジトリに検証コマンドは 1 本も存在しない** [実測]。以下は task_003 以降で `package.json.scripts` に定義する予定のもの。定義されるまでフック・CI・task-list の `verify_commands` から参照しない（`scripts/assert-verify-commands.mjs` が機械検査）。テストは `TZ=UTC` で実行し、日付境界テストのみ `TZ=Asia/Tokyo` でも実行する。

| 予定スクリプト | 内容 | 作成タスク |
|---|---|---|
| `typecheck` / `lint` / `lint:changed` / `build` / `build:web-only` | `tsc --noEmit` / eslint / `next build` / LINE 非依存ビルド | task_003 / 013 |
| `test:unit` | Vitest | task_003 |
| `test:e2e` / `test:security` / `test:a11y`（雛形） | task_003 で smoke 1 本ずつの雛形を定義し、実体は task_022 で追加 | task_003（雛形）/ 022（実体） |
| `test:gate-meta` | 違反フィクスチャで各ゲートが非ゼロ終了 | task_006 |
| `test:contract` | 重複・逆順・署名不一致 | task_018 |
| `test:conformance` | ConformanceKit C1〜C31 | task_019 |
| `test:integration` | supabase ローカル Postgres に実マイグレーション | task_011 |
| `test:security`（実体） | IDOR・claim 3 本・冪等キー越境・ID トークン再利用・XSS/CSP・許可外 IP・deepLink ホスト・ログ grep | task_022 |
| `test:a11y`（実体） | axe-core | task_022 |
| `test:e2e`（実体） | Playwright ＋ liff-mock | task_022 |
| `test:gate` | `test:contract` ＋ `test:conformance`（Stop フック用） | task_019 |
| `gate:constraints` / `gate:wording` / `gate:check` / `gate:acceptance` / `gate:plan` / `gate:env` / `gate:integrity` / `gate:terms` / `gate:privacy-policy` / `gate:compliance-freshness` / `gates:sync` | 各ゲート | task_004 / 006 / 012 / 021 |
| `audit:verify` | 監査連鎖の先頭からの検証 | task_018 |
| `db:migrate` / `db:reset:local` / `db:restore:drill` | supabase CLI 経由。本番向け reset は作らない | task_011 / 024 |
| `bench:models` | 実測ベンチ | task_010 |
| `build:cf` / `cf:dev` | `opennextjs-cloudflare build`（CI で `.open-next` の Worker サイズも記録。A25）/ `wrangler dev`（ローカル実機確認用。CI からは呼ばない） | task_003 |
| `gate:waf` | `node scripts/ci/check-waf.mjs`（Phase 2） | task_027 |

**staging / production へのデプロイは npm スクリプトを作らない。** `.github/workflows/release.yml`（task_009。`cloudflare/wrangler-action` で `wrangler deploy --env staging` / `--env production`）からのみ実行する。ローカルの `wrangler deploy`（環境指定の有無を問わず）と `wrangler versions deploy`、および package.json 経由の別名呼び出しは PreToolUse の `deny-dangerous-bash.sh` が常に遮断する（§16-4）。

外部ツール（存在確認済み [実測]）: `git`、`node`、`npm`、`supabase`、`gh`、`codex`、`jq`、`python3`（`wrangler` は task_003 で devDependency として導入）。

---

## 14. Acceptance Criteria

詳細は `docs/acceptance-checks.json`。代表的な合否基準を示す。

### 14-1. 主要フロー・認可
- 幹事が O-0 → O-8 を完走し、名簿に「支払済み（手動確認・自動照合ではありません）」と「支払済み 1/4（自動 0 / 手動 1）」が出る。
- 参加者は同意前に preview（氏名・個別金額なし）を見て、claim 後は自分の請求だけを読める。他人の participant を claim できず、`joinToken` だけでは請求に到達できず、unclaim 後に本人が claim できる。
- `joinToken` は 128 ビット以上、期限切れで 404、ローテーション後は旧トークン失効、ログとアクセスログに平文が 0 件。

### 14-2. 認証・鍵
- 改竄・期限切れ・aud 不一致の ID トークンは 401。**同一 ID トークンの 2 回目の提示は 401**。`/api/auth/line` はレート制限で 429。
- 旧鍵で署名されたセッションが 1 世代前まで検証され、`session_epoch` を進めると即失効。`pepper_version` 違いの PEPPER でユーザーが移行され claim が維持される。
- JS から設定される Cookie が 0 個。`X-CSRF-Token` 欠落は 403。DB に生の LINE sub が無い。

### 14-3. DB・環境
- `app_rw` からの `UPDATE ledger_entry` / `DELETE audit_log` が例外（0 行成功は不合格）。`role_table_grants` スナップショット一致。`supabase db diff` 差分 0。
- `APP_ENV !== 'production'` で `/api/webhooks/*` と `/api/cron/*` が 404。本番以外の project ref で起動失敗。`.next/static/**` に実シークレットが 0 件。クライアントから DB クライアントを import するとビルド失敗。
- `settlement_rank IS NULL` が 0 件、未知 status は拒否、`amount_minor > 1000000` は失敗、生きた attempt は請求あたり 1 つ。

### 14-4. 冪等・順序・台帳（契約 3 本 ＋ C1〜C31）
- C1 重複 3 回で台帳 1 件。C2 逆順で `paid` 維持。C3 改竄で 400。C4b 正当な 2 回目の返金が載る。**C5 金額不一致で `adjustment` 1 件・rank 不変・`needs_attention`**。C11 取消後入金。C12 ゲート未通過。C13 2 binding 同時。C14 ゲート off でも受信保存。C15 expired 後の入金。C16/C17 紛争到達性。C20 少額支払いで paid にならない。C21 削除済み参加者の入金が orphan にならない。C22 中止後入金。C23 同時 checkout で attempt 1 つ。C24 手動と自動の混在。C25/C26 タイムアウト・クラッシュ後の回収。C27/C28 許可外ホスト・IP。C29 返金期限。C30 金額同値。C31 未知 status 拒否。

### 14-5. LIFF・UX・a11y
- `isInClient=false` で `liff.login()` が呼ばれず `outside_line`。login 2 回で `auth_unavailable`。SDK 3 秒失敗で静的フォールバック（白画面なし）。`liff.init` 失敗がテレメトリに届く。
- 320 / 375 / 414 px で横スクロールなし。axe-core 違反 0。フォント 200% で崩れない。状態は色＋テキスト＋アイコン。
- `shareTargetPicker` 不可でもコピー導線が動く。個別リンクが発行できる。Flex と P-1 に 5 要素が必ず含まれる。
- 自己申告状態が支払済みと同じ見た目にならない。`organizer_label` 空でイベント作成不可。

### 14-6. ラベル・文言
- `autoDetected=false` のバッジが消えるとスナップショットが失敗。`gate:wording` が拡張語彙（領収書・インボイス・記入例・審査の通し方・未確定手数料の確定表示）を検出。CSV に列あり。`confirmation_method='mixed'` の表示規約。

### 14-7. 運用・監視
- `outbox` の全 kind に配達先があり未定義 0 件。Messaging API 経由で幹事に要対応通知が届く。`/api/health` が `degraded` を返し外形監視から通知が届く（実測）。
- 照合ジョブが 2 プロセス同時で多重実行されず、kill 後にロックが残らない。300 件相当で時間内完走、上限到達で `truncated`。
- 復元リハーサル 1 回完了（run-log）。`audit:verify` 緑。`gate:compliance-freshness` 期限切れ 0。

### 14-8. ハーネス
- `test:gate-meta` 緑（対象 0 件は exit 1）。`record-run.sh` 以外からの run-log 書き込みが遮断される。gate-check が捏造コマンド・古い evidence・DONE 過大申告・high concerns 3 件超・provenance 欠落・ゲート定義ハッシュ不一致を検出。
- `tests/**` / `scripts/gate-*` に差分がある PR でチェックリストが空なら `test-tamper-guard` が落ちる。`release.yml` が `cleared=false` で先頭失敗。adversarial は経路実測まで required に入っていない。

### 14-9. ビルド・型・lint
- `typecheck` / `lint` / `build` / `build:web-only` / `test:unit` がすべて exit 0。`npm audit --audit-level=high` 緑。Phase 1 の `npm ls` に決済 SDK なし。

### 14-10. Phase 2
- 実決済 1 件が台帳に載り `confirmation_method='automatic'`。Webhook 停止でも照合だけで paid。キルスイッチで新規 checkout 409・既存 pending 照合継続・`refund` と受信は継続。`PayjpAdapter` PR でコアに差分なし。要対応の認知時間と checkout→paid の時間を実測記録。

---

## 15. Repair Loop

### 15-1. 基本ループ
1. 検証コマンドを `scripts/record-run.sh <cmd>` 経由で実行する（run-log はこの経路でしか書けない）。
2. 出力全文と終了コードを読み、失敗数・スキップ数を数える。
3. エラーを `docs/task-list.json` の `task_id` に対応付ける（対応付かなければ新規タスクを起票し `dependencies` を張る）。
4. 当該タスクの `files_to_create` / `files_to_modify` だけを修正する。**テストを編集・削除・skip しない**（`deny-test-weakening.sh` が遮断。誤ったテストは `BLOCKED` として報告）。
5. 再実行し、run-log に記録する。CI の acceptance ジョブは run-log を信用せず `verify_commands` を再実行する。
6. 計画から乖離したら本書と task-list を更新し、ADR を追加する。

### 15-2. ゲート判定（`scripts/gate-check.mjs`。Stop フックと CI で同一コード）

| # | ルール |
|---|---|
| G0 | 各ゲートが対応する違反フィクスチャに対して必ず非ゼロ終了する（対象 0 件での合格を禁止） |
| G1 | 全タスクに `done_definition` が非空。`verify_commands` は `files_to_create` / `files_to_modify` に `docs/**` 以外を含むタスクでは非空。成果物が `docs/**` のみのタスク（task_001 / 002 / 034 / 036 / 037）は `manual_verification` が非空であればよい |
| G2 | `completion_status` が `DONE` / `DONE_WITH_CONCERNS` / `in_progress` のタスクの `verify_commands` がすべて `package.json.scripts` に実在する。未着手（`null`）のタスクの参照は warn として列挙するのみ。ただし §13 の表に作成タスクが無いスクリプト名を参照している場合は未着手でも違反（コマンド捏造の検知） |
| G3 | 各 check が少なくとも 1 つの task から参照されている |
| G4 | `DONE` のタスクは run-log に全 `verify_commands` の exit 0 を持つ。`verify_commands` が空のタスクは run-log に `manual_verification` の各項目について実施者・UTC 日時・観察結果・HEAD が記録されている（`scripts/record-run.sh --manual` 経由） |
| G5 | `risk_level: high` かつ `adversarial_review: required` の `DONE` は review-log に敵対レビュー記録がある。記録は (a) 1 ベンダー以上の finding 封筒（`model_id_actual` / `cli_version` / `backend` 付き）、または (b) `reviewer_route: unavailable` の欠票記録（試行コマンド・不達理由・日時）のいずれかで足りる。**task_007 が DONE になるまで G5 は warn（非ブロッキング）とし、task_007 の DONE 時に review-log を持たない既存 DONE タスクを列挙して fail する** |
| G6 | `DONE_WITH_CONCERNS` は `concerns[]` に severity と対応案 |
| G7 | `tests/contract/` のファイル数が減っていない |
| G8 | `git diff` に実シークレット（本プロジェクトの名前・形式）が含まれない |
| G9 | `evidence.commit === HEAD` |
| G10 | `[設計]` / `[不明]` 依存の ADR が `accepted` になっていない |
| G11 | severity=high の未解決 concerns が 3 件以上なら新規機能タスクを `in_progress` にできない |
| G12 | fixture に `captured_from` がある。synthesized のみのアダプタは `autoDetect` を宣言できない |
| G13 | `docs/gates/**`・`.claude/**`・`.github/workflows/**`・`scripts/gate-*`・`scripts/deny-*`・`scripts/record-run.sh`・`scripts/append-handoff.sh`・`scripts/session-brief.mjs`・`scripts/assert-*`・`scripts/validate-*`・`scripts/ci/**` のハッシュが基準値（`docs/gates/integrity-baseline.json`）と一致する |
| G14 | 直近 7 日の監査連鎖が `audit:verify` で検証済み |

### 15-3. タスク実行ループ（`.claude/workflows/task-loop.ts`）

```
step 0  preflight        depends_on 未完 / ADR 未決 / constraint_ids 空 / G11 抵触 → BLOCKED or NEEDS_CONTEXT
step 1  spec-first tests acceptance-test-generator [Sonnet]（src/** 読み取り不可。受入基準のみ）
                         → テストが赤いことを確認。緑なら差し戻し。2 周目以降は再生成しない
step 2  implement        task-executor [Sonnet]（決済アダプタ・Webhook・状態機械・鍵は Opus 5.5）
step 3  self-quality     quality-fixer [Sonnet]
step 4  parallel:  a) code-reviewer [Opus 5.5]  b) adversarial-reviewer-gemini [Gemini]（引用なしは UNKNOWN）
                   c) adversarial-reviewer-gpt [GPT-6 Astra]（repro なしは info）  d) payment-contract-guard [Sonnet]
                   e) compliance-gatekeeper [Opus 5.5]（資金フローに触れる時）
step 5  merge-verdict    high 1 件でも → step 6（最大 3 周）。3 周後も high が残れば BLOCKED で PO 裁定（DONE_WITH_CONCERNS で通すことを禁止）
                         compliance-gatekeeper BLOCKED → 即終了。UNKNOWN > 20% → 再実行。reviewer_route unavailable → その票は欠票として記録（レビュー無効ではなく、欠票の事実を review-log と PR に残す）
step 6  fix              反例を先にテストケース化してから直す。step 4 へ
step 7  final verify     verifier [Opus 5.5]  完了前 5 ステップゲート
step 8  status           4 値ステータス。PROGRESS.md と HANDOFF.md に追記。コストを 1 周ごとに記録
```

`release-audit.ts` の合意条件は票数ではなく成立条件: **独立した 2 ベンダー以上の go かつ no-go ゼロ。不達のベンダーがある場合は PO が不達を明示承認した記録を `docs/gates/release-<version>.json` に残す。** `legal-clearance.json.cleared=false` なら無条件 no-go。

### 15-4. 完了ステータス（4 値）
`DONE` / `DONE_WITH_CONCERNS`（severity と対応案）/ `BLOCKED`（何にブロックされ何を試したか）/ `NEEDS_CONTEXT`（不足情報を名指し）。

---

## 16. チーム構成とハーネス

**使用モデル: Opus 5.5 / Sonnet / Gemini 系（到達可能な実モデルを task_010 で確定）/ GPT-6 Astra。Fable は使わない。** `fable-protocol` はプロンプト規範スキルでありモデルではない。その完了前 5 ステップゲートと 4 値ステータスは全モデル共通のプロトコル。

### 16-1. 配置の原則
1. 判断の可逆性で分ける。不可逆（設計骨格・法務・リリース可否・裁定）は Opus 5.5。可逆（実装・修正・テスト記述）は Sonnet。読み捨ての大量収集は Gemini。反例提示・独立監査は GPT。
2. 検出者と作者は別ベンダー。事実主張の最終票は Gemini / GPT。根拠: 本セッションの反証検証で Claude 系の断定が複数覆った（`consolidated.md` §3）。
3. 不明なスペックに依存しない。4 モデルの単価・レイテンシ・コンテキスト長は [不明]。実測まで配置は暫定。
4. **AI は停止はできるが再開・ゲート通過・フラグ変更はできない。** それらは人間の操作であり、AI による書き換えは F13 として独立の失敗モードに置く。

### 16-2. 役割表

| レーン | 役割 | 担当 | 停止・エスカレーション |
|---|---|---|---|
| 意思決定 | PO / 最終決裁 | [人間] noritaka | 最終決裁者。週 60〜90 分 |
| 意思決定 | 照会文起案・回答の構造化 | [Opus 5.5] | 期限超過（送付 + 21 日）を `session-brief.mjs` が警告 → `default_decision_on_timeout` を PO に提示 |
| 意思決定 | 法務ゲートキーパー | [人間] 弁護士 ＋ [Opus 5.5] 事前整理 | 本番決済は弁護士確認まで無条件ブロック（L11） |
| 設計 | オーケストレーター / 実装リード | [Opus 5.5] | コンテキスト 60% 超 → 成果物へ圧縮。ゲート 3 連続失敗 → PO |
| 設計 | 要件分解・ADR | [Opus 5.5] | 受入基準が YES/NO 化できない → 分解し直す |
| 実装 | バックエンド / LIFF フロント | [Sonnet] | タスクに無い判断 → `NEEDS_CONTEXT` |
| 実装 | 決済アダプタ・Webhook・状態機械・鍵運用 | [Opus 5.5] | W2/W3 を満たせない → 設計へ戻す |
| 実装 | 品質修正 / 受入テスト生成（`src/**` 不可） | [Sonnet] | テスト改変で `BLOCKED` |
| 調査 | 一次資料フェッチ・逐語抽出 | [Gemini] | 取得失敗は「取得失敗」と明記 |
| 調査 | 結論統合 | [Opus 5.5] | 逐語引用のない主張は載せない |
| 検証 | 設計適合レビュー | [Opus 5.5] | 「〜はず」で差し戻し |
| 検証 | 敵対レビュー A（規約・一次資料） | [Gemini] | 引用なしは UNKNOWN |
| 検証 | 敵対レビュー B（反例提示） | [GPT-6 Astra] | repro なしは info |
| 検証 | 契約ガード / コンプライアンス・ゲートキーパー | [Sonnet] / [Opus 5.5] | 1 件でも fail → マージ不可 / リリース不可 |
| 検証 | 証拠照合 | [Opus 5.5] | 「走った」と「通った」の混同で差し戻し |
| **UX・採用** | パイロット設計と実施 / ファネル計測 / a11y・一覧性の受入条件 | [人間] noritaka / [Sonnet] / [Opus 5.5] | パイロット幹事 1 名の完走と参加者 5 名以上の自力到達が無ければ Phase 1 を閉じない |
| 運用 | リリース前監査 | [Opus 5.5] ＋ [Gemini] ＋ [GPT] | §15-3 の成立条件 |
| 運用 | プレモータム | [Opus 5.5] 起案 → [GPT] 反証 → [Gemini] 照合 | 前回 high の未対応 3 件以上 → 新規着手停止（G11） |
| 運用 | インシデント一次対応 | [Sonnet]（本番は読み取り専用資格情報）→ [人間] | 資金・返金・書き込みは人間が実行 |
| 運用 | コスト監視 | [Sonnet] | task-loop 1 周ごとに記録。日次予算超過で Opus 停止 |

外部人間: 弁護士（Q-LG1 を単独先行）／PayPay 加盟店窓口／PAY.JP／LINEヤフー審査窓口／税理士（低）／パイロット幹事 3〜5 名。

### 16-3. モデル別の得意・リスク・撤回条件

| モデル | 配置 | リスク | 対策 | 撤回条件 |
|---|---|---|---|---|
| Opus 5.5 | 設計・法令読解・裁定・ゲート判定 | 自信過剰。コスト最大 | 異ベンダーの反証。1 タスク 3 呼び出し以内 | 異ベンダーの High が 3 スプリント連続 |
| Sonnet | 実装・修正・テスト・契約ガード | 仕様の穴を質問せずに埋める | 「してよい / してはいけない判断」をタスクに明記 | `NEEDS_CONTEXT` 率 30% 超 |
| Gemini 系 | 一次資料フェッチ・逐語抽出・スクリーニング | 深い法解釈不可。取得失敗を「存在しない」と書く。**実モデルが指定と異なる（本セッションで 3.5-flash にフォールバック [実測]）** | 出力を「逐語引用＋URL＋取得日時＋取得成否」に固定。封筒に `model_id_actual` 必須 | 単独検出 0 が 2 スプリント連続 |
| GPT-6 Astra | 反例提示・プレモータム反証・監査第 3 票 | **経路が codex CLI 1 本で現在フック遮断中 [実測]**。CI ランナーに CLI も認証も無い | 反例提示型に限定。CI は各社 API キー（GitHub Secrets）で呼ぶ。**経路が実測で通るまで required check に入れない**。欠票は review-log に記録し「3 ベンダー体制」と称さない | 同上 |

モデル名: 実行時は `~/.codex/config.toml` の既定 `gpt-6-astra` [実測]（ユーザー表記「gpt6 astla」は表記揺れと判断。ADR-003）。CLI 更新で既定が変わる可能性があるため、返信封筒の `model_id_actual` / `cli_version` / `backend` を必須にし、`model_mismatch` を `reviewer_route` に追加する。

### 16-4. フック（`.claude/settings.json`。プロジェクト単位でオプトイン。task_005 で SessionStart / UserPromptSubmit / PreToolUse（Bash, Edit|Write|MultiEdit）/ PostToolUse / Stop / SubagentStop を登録・有効化する。Stop の `gate:check` と PostToolUse の `gate:plan` は task_006、Stop の `test:gate` は task_019 で追加する。6 イベント × 遮断挙動の [実測] マトリクスは task_006 の `scripts/test-hook-enforcement.sh` で作る）

| イベント | フック | 目的 |
|---|---|---|
| `SessionStart` | `session-brief.mjs` | 未通過ゲート・未回答照会（期限超過を強調）・`legal-clearance.json`・HANDOFF 末尾を注入 |
| `UserPromptSubmit` | `gate-status.mjs` | 未通過 check 件数・BLOCKED タスク・high concerns 残高 |
| `PreToolUse`（Bash） | `deny-dangerous-bash.sh` | `tool_input.command` を正規化（空白圧縮・引用符除去・`&&` / `;` / `\|` / 改行で分割）し各サブコマンドに部分一致。遮断: `rm -rf` / `git push -f` / `git reset --hard` / `supabase db reset` / `supabase db push` / `wrangler deploy`（環境指定の有無を問わず）/ `wrangler versions deploy` / `wrangler secret put ... --env production` / `PAYPAY_ENV=PROD` / `sk_live_` / `npm publish` / `pnpm`。**`npm run <script>` 形式は package.json.scripts を再帰的に解決して同じ判定を適用**（解決不能でスクリプト名が `deploy|secret|publish|reset|push|prod` に一致すれば fail-closed）。**`docs/run-log/**`・`docs/gates/**`・`docs/acceptance-checks.json`・`tests/**`・`scripts/deny-*`・`scripts/record-run.sh`・`.claude/**`・`.github/workflows/**` への Bash 経由の書き込み（`>` / `>>` / `tee` / `sed -i` / `cp` / `mv` / `python3 ... open(..., 'w')`）も遮断**。決済・本番系は `cleared` が `true` でも常にローカルからは exit 2（デプロイは CI のみ） |
| `PreToolUse`（Edit\|Write\|MultiEdit） | `deny-test-weakening.sh` | テスト弱体化・本番鍵・**run-log と evidence への直接書き込み**・`docs/gates/**` の書き換え |
| `PostToolUse`（Edit\|Write\|MultiEdit） | `typecheck` / `lint:changed` / `gate:constraints` / `gate:plan` | 壊れたコードを持ち越さない |
| `Stop` | `test:gate` / `gate:check` / `append-handoff.sh` | 契約テストとゲート。**HANDOFF に「今ターンで決まったこと・未解決」を毎ターン追記**（PreCompact に依存しない） |
| `SubagentStop` | `assert-diff-exists.sh` | 完了報告を diff で検算 |

フックが呼ぶ npm スクリプトは実在させてから登録する。長いテストは CI へ。

### 16-5. Workflow・封筒
- `task-loop.ts` / `premortem.ts`（4 レンズ、フェーズ境界で再実行、前回との差分のみ新規）/ `release-audit.ts`。`model` は Claude ティア指定。Gemini / GPT へは `agentType` の Bash ラッパーで到達。
- 封筒: `constraint_ids` に対応する制約のみ全文同梱（全 51 件を毎回同梱しない）。artifact は diff ＋ diff が触れたファイル全文＋ import 先の自作モジュール全文。finding は repro 必須。返信に `model_id_actual` / `cli_version` / `backend` / `reviewer_route`（`verified | cli-fallback | unavailable | model_mismatch`）必須。

### 16-6. CI（GitHub Actions）

| ジョブ | 内容 | required |
|---|---|---|
| `static` | typecheck / lint / test:unit / gate:constraints | ✔ |
| `gate-meta` | test:gate-meta | ✔ |
| `gate-integrity` / `gates-sync` / `gate:env` / `gate:compliance-freshness` | ゲート定義ハッシュ / JSON⇔DB / env スコープ / 期限切れ | ✔ |
| `contract` | test:contract ＋ test:conformance | ✔（task_019 以降） |
| `labels` | gate:wording ＋ 非自動バッジのスナップショット | ✔ |
| `integration` | supabase start → migrate → test:integration（`app_rw` 例外、xact ロック、retention 後の許可キーのみ） | ✔（task_011 以降） |
| `security` | test:security ＋ `.next/static` / `.open-next` の実シークレット grep ＋ assert-server-only ＋ bundle-liff-id-grep | ✔ |
| `deps` | `npm audit --audit-level=high` ＋ OSV ＋ lockfile 差分レポート ＋ Phase 1 の決済 SDK 不在 | ✔ |
| `a11y` | test:a11y | ✔（task_022 以降） |
| `legal` | gate:terms ＋ gate:privacy-policy | ✔（task_021 以降） |
| `acceptance` | assert-verify-commands ＋ assert-acceptance ＋ **`verify_commands` の再実行** | ✔ |
| `test-tamper-guard` | `tests/**` / `scripts/**` / `.claude/**` / `.github/**` / `docs/gates/**` / `supabase/migrations/**` / `package*.json` に差分がある PR でチェックリスト記入を検査（記入者は検証しない。人間の関門ではなく緩和事実の記録強制） | ✔ |
| `waf`（Phase 2） | `gate:waf`（`scripts/ci/check-waf.mjs`。read-only トークン `CLOUDFLARE_WAF_READ_TOKEN`。未設定時は skip で neutral、緑にしない） | ✔（task_027 以降） |
| `adversarial` | 封筒 → Gemini / GPT → merge。**経路が実測で通るまで required に入れない** | 条件付き |
| `date-boundary` | `TZ=UTC` と `TZ=Asia/Tokyo` で一致 | ✔ |
| `web-only` | build:web-only | ✔（task_013 以降） |
| `e2e`（別 workflow） | nightly ＋ リリース前 | — |

ブランチ保護: 直 push 禁止、required status checks は上表。**承認必須は使わない**（単一アカウント [実測]）。`release.yml` の先頭は 2 段ゲート: (a) `docs/gates/release-mode.json` の `payments_enabled` が `false` なら、ビルド設定の `PAYMENTS_ENABLED` が `false` であることと `npm ls` に決済 SDK が無いことを検証して通す（Phase 1 の決済なし本番デプロイ）。(b) `true` なら `jq -e '.cleared == true' docs/gates/legal-clearance.json` を必須にする。両ファイルは `docs/gates/**` として G13 のハッシュ照合対象で、変更は PO のみ。**本リポジトリで人間（PO）が実際に関与する関門は 3 つだけである: ① `docs/gates/legal-clearance.json` / `release-mode.json` / `compliance-gates.json` の変更、② ADR の `accepted` 化、③ 実機確認とパイロット。** デプロイは `cloudflare/wrangler-action` による `wrangler deploy --env production`（`CLOUDFLARE_API_TOKEN` と本番シークレットは GitHub の `environment: production` にのみ置く）。

### 16-7. 週 0 と週次
1. codex フック例外句（PO 承認後）と CI からの敵対レビュー経路の実測。
2. ベンチ 1 回（判定基準を事前固定）。
3. ハーネス必須セット（5 営業日）。超過時は打ち切って記録。
4. Q-LG1 の単独先行発注 → PayPay → PAY.JP → LINEヤフー → Stripe。

週次: 月曜にゲート状態と 1 手決定、金曜にメトリクス（差し戻し率・ユニーク検出数・`NEEDS_CONTEXT` 率・`UNKNOWN` 率・欠票率・ゲート違反の検出箇所・コスト・未通過ゲート数・照会滞留日数・ゲート平均待ち時間）。月 1 回、既知バグ注入でレビュアの検知率を測る。

### 16-8. ハーネス自体の失敗モード

| # | 失敗モード | 検知 | 対策 |
|---|---|---|---|
| F1 | 幻覚 API / 幻覚 fixture | GPT 反例、typecheck、fixture の `captured_from`、G12 | SDK をアダプタ内に閉じる。synthesized fixture のみのアダプタは `autoDetect` 不可 |
| F2 | 完了の過大申告 | G4 / G9、CI の再実行 | run-log は `record-run.sh` のみ。Write 遮断 |
| F3 | テスト改変 | `deny-test-weakening.sh`（Edit/Write）、`deny-dangerous-bash.sh`（Bash 経由の書き込み）、`test-tamper-guard`、G7 | 契約テストの改変には PR 本文のゲート緩和チェックリスト記入が必須（記入者は検証しない。人間の関門ではなく記録強制） |
| F4 | コンテキスト喪失 | `session-brief.mjs` | Stop フックで HANDOFF 毎ターン追記 |
| F5 | MCP 停止 | 接続エラー通知 | `docs/vendor-docs/` へ退避。「能力が無い」と書かない |
| F6 | モデル不達・静かな差し替え | `reviewer_route` / `model_id_actual` | 欠票を記録。3 ベンダー体制と称さない |
| F7 | コスト暴走 | 1 周ごとの計測、日次予算 | 制約は `constraint_ids` のみ同梱。Opus は設計・裁定・ゲートのみ |
| F8 | L11 の踏み越え | `deny-dangerous-bash.sh`、`release.yml` 先頭 | 本番鍵は wrangler の production シークレットのみ（CI から投入） |
| F9 | レビューの形骸化 | 差し戻し率、月 1 の注入テスト | 2 週連続ユニーク検出 0 で撤回 |
| F10 | 単一人間のボトルネック | `WAITING_HUMAN` 滞留 | エスカレーション 3 種に限定 |
| F11 | 確信度「低」への依存 | ADR `confidence`、G10 | `proposed` 止まり |
| F12 | ハーネスの肥大・空振り | ゲート平均待ち時間、**G0（メタゲート）** | 必須セットのタイムボックス。空振り防止は違反フィクスチャで機械検証 |
| **F13** | **AI による本番ゲート・フラグ・ゲート定義ファイルの書き換え** | G13、`audit_log` の actor 内訳、`gates-sync` | 正本は Git、DB は射影。フラグは別 IdP ＋二人承認。AI は停止のみ可 |

---

## 17. プレモータム（先回りリスク台帳）

8 レンズ（security / payment-integrity / line-platform / legal-compliance / ops-support / ux-adoption / team-harness / data-infra）で 118 件を抽出し、86 件に統合した。**S1（致命）42 件、S2（重大）42 件、S3（軽微）2 件。S1 × high は 21 件。** 全文は `docs/research/premortem-risks.md`。統合者は一次資料を再取得しておらず、2 レンズは gemini-3.5-flash 経由（§6 の正直な申告）。実装コストの見積もりは行っていない。

### 17-1. レンズ間の裁定（本計画で採用した一本化）

| # | 対立 | 裁定 |
|---|---|---|
| A1 | 復帰識別子をパスに置く vs 招待トークンをパスから外す | 長寿命の `joinToken` はヘッダ／ボディ、単回・短命の `return_token` はパス（§7-4） |
| A2 | ゲート off でも受信・返金を止めるな vs Preview は無条件 404 | 環境ガードは最外層で常時、コンプライアンスゲートは `createCheckout` と binding 作成のみ（§7-6） |
| A3 | 金額不一致でランクを進めるな vs 受領事実は台帳へ | 台帳（事実）と invoice（判断）を分離。`adjustment` を記録し rank は動かさない（§9） |
| A4 | 参加者単位 claim トークン vs 個別リンク | 同一実装。`joinToken` は候補一覧までの権限 |
| A5 | RULE の無言 0 行 vs `app_rw` 不在 | `app_rw` を実在させ、追記専用はトリガの例外（§7-2） |
| A6 | 入金予定 UI を Phase 3 へ vs payout テーブル vs 手数料事前提示 | Phase 1〜2 は事前提示のみ必須、`payout` は Phase 3（§5） |
| A7 | ConformanceKit / gate-check の採番衝突 | C13〜C31、G0・G11〜G14 で一意化（§14-4、§15-2） |

### 17-2. 第 1 階層 — S1 × high（21 件）: 設計・実装に着手する前に潰す

| ID | 何が起きるか | 本計画での先回り策 | 反映先 |
|---|---|---|---|
| R-PAY-01 | アダプタが `binding` を取らず、幹事 B の決済を幹事 A の鍵で照会するか、全幹事が運営者名義の単一加盟店を共有する（L1 違反） | IF v2 の第一引数 `binding`、`payment_attempt.provider_binding_id NOT NULL`、Webhook を `/:providerKey/:bindingRef` に分離 | §7-6 §9 §10、task_017 / 018 / 027、C13 |
| R-PAY-02 | 連打で生きた attempt が 2 本でき過払い。推測可能な `Idempotency-Key` で他人の応答が返る | `UNIQUE (invoice_id) WHERE is_open`、生きた attempt の再利用、冪等キー PK `(user_ref, endpoint, key)` ＋ `in_flight` ＋ TTL、`response_body` 許可フィールド | §9 §10、task_014 / 015 / 017、C23 |
| R-PAY-03 | 決済画面を開いた参加者を幹事が削除し CASCADE で請求が消え、入金が orphan として捨てられる | 論理削除、`HAS_OPEN_ATTEMPT` 409、`ON DELETE RESTRICT`、orphan は `outbox` へ | §9 §10、task_014、C21 |
| R-PAY-14 | `settled_at` を書く経路が無く、手数料も台帳に無い。幹事は 50,000 円と見て 48,100 円が月末に入る | Phase 1〜2 は `settled_at` を実装せず、O-3 で総額・手数料概算・受取見込額・入金予定時期の提示と同意を必須化。`feeModel` / `settlementSchedule` を capabilities に。`payout` は Phase 3 | §5 §7-6 §8、task_014 / 028 / 032 |
| R-SEC-01 | 招待リンクが転送され、先に開いた他人が claim して他人の金額を読み、本人は永久に到達不能。unclaim 手段が無い | 参加者単位 claim トークン、`joinToken` は候補一覧まで、`unclaim` API、claim 履歴テーブル、確認ダイアログ必須 | §9 §10、task_015 |
| R-SEC-03 | RLS deny-all ＋ service role はアプリ自身に効かず、RULE は無言で 0 行。「台帳が製品」の前提が崩れる | `app_rw` ロール（INSERT のみ）、トリガ `RAISE EXCEPTION`、service role はマイグレーション専用、正本 SQL 一本化 | §7-2 §10、task_011 |
| R-SEC-05 | staging / プレビューデプロイが本番 DB に service role で接続し、Webhook / cron / ゲートをそこ経由で操作できる | Supabase 2 プロジェクト、wrangler environments のバインディング・シークレット分離、起動時アサート、非 production は Webhook / cron 404、staging は Cloudflare Access | §7-2 §7-7、task_012 / 024 |
| R-SEC-09 | PEPPER がローテーション不能。環境間で異なると同一人物が別 ref になる | `pepper_version` の二重運用、環境間共有の明示、外部シークレットストア、起動時検証、`/api/health` の fingerprint | §7-4 §10、task_011 / 012 / 033 |
| R-LINE-01 | 決済から外部ブラウザで戻ると Cookie が無く 401。`liff.state` でクエリも届かない。Lax でも None でも解決しない | `return_token`（パスセグメント・15 分・invoice 1 件・読み取り再利用可・外部照会は初回のみ）、Cookie 非依存の `/api/return/:token`、「手続き中」表示、実機往復の [実測] | §7-4 §8 §9、task_027 |
| R-LINE-02 | 無条件 `liff.login()` で LINE 外アクセスがリダイレクトループ。同一端末で QR は読めない | `isInClient` 判定を login より前に、試行回数 2 回で打ち切り、フォールバック順を「LINE で開く → コピー → QR」 | §7-3、task_013 |
| R-LINE-03 | `liff.init` 失敗・古い WebView の白画面がサーバーに残らず気づけない | 自前テレメトリ、静的フォールバック（3 秒）、SDK を npm でバンドル、`browserslist` | §7-2 §7-7、task_013 |
| R-LAW-03 | 審査を通すための虚偽申告をアプリの記入例が誘導し、幹事群が一斉停止 | 記入例・審査の通し方を禁止語に、適格性チェック、単発幹事には自動決済を提示しない | §7-3 §8 O-0、task_004 / 017 |
| R-OPS-01 | `outbox` に配達先が無く、mismatch や取消後入金が誰にも届かない | kind ごとの配達先表、Messaging API チャネルを Phase 1 に前倒し、O-2 の要対応バッジ、運営者向け内部通知 | §7-3 §10、task_020 / 023 |
| R-OPS-07 | `/api/health` が静的で、cron 停止と Webhook 途絶が無音。Cron Triggers の契約が未確認 | 依存先込み `degraded`、外形監視、`reconciliation_run` 鮮度、cron 契約の一次資料再取得、GET/POST 両対応 | §7-7 §9、task_020 / 023 |
| R-OPS-08 | 照合ジョブが全件走査で kill、セッションスコープの advisory lock が残留し以後空振り、接続上限 | `pg_try_advisory_xact_lock`、バッチ 100、timeout 3 秒、並列 5、Hyperdrive 経由の transaction、`limits.cpu_ms` | §9、task_020 / 029、負荷 300 件 |
| R-UX-01 | 見慣れないドメインでいきなり同意を求められ、主催者名は空欄。「詐欺リンクでは」で終わる | `organizer_label` 必須、Flex と P-1 の 5 要素固定、説明テンプレ、O-13 の運営者情報 | §7-5 §8、task_014 / 016 |
| R-UX-02 | 手動確認版で参加者が送金しても幹事が確認するまで「未払い」。二重送金が起きる | 自己申告 `self-report`（台帳に書かない）、「幹事確認待ち」表示、ラベル 7 項目目 | §7-6 §8 §9、task_015 / 017 |
| R-TH-01 | ゲートスクリプトが空振りしても緑。ゲート網全体が無言で無効化 | 違反フィクスチャ 10 本以上、`test:gate-meta`、対象 0 件は exit 1、G0 | §15-2 §16-8、task_006 |
| R-TH-02 | run-log と evidence を実装者自身が Write または Bash で書けるため G4 / G9 が迂回可能 | `record-run.sh` のみが書ける、Edit/Write 遮断に加え Bash 経由の書き込み（リダイレクト・`tee`・`sed -i`・`cp`/`mv`）も遮断、CI が `verify_commands` を再実行 | §15-1 §16-4、task_005 / 009 |
| R-TH-03 | GPT 経路がフック遮断中、CI ランナーに CLI も認証も無く、最初の PR から adversarial が落ちて main にマージ不能 | 経路が実測で通るまで required に入れない、API キー方式、欠票の記録 | §16-3 §16-6、task_009 / 010 |
| R-TH-04 | 単一アカウントでは CODEOWNERS 承認が構造的に満たせず、branch protection ごと解除される | 承認必須を使わず、PR テンプレートのチェックリストを CI で検査 | §16-6、task_009 |

### 17-3. 第 2 階層 — S1 × medium（21 件）: Phase 1 の完了条件

R-PAY-04（突合基準は `payment_attempt.amount_minor`、不一致は `adjustment`）／R-PAY-05（部分返金は当面非対応）／R-PAY-06（`cancel` で void ＋ `cancelCheckout` ＋返金タスク）／R-PAY-07（紛争種別と `charged_back` 到達、paid 後の日次再照会、月次 CSV 突合）／R-PAY-08（ゲートは新規資金移動のみ）／R-PAY-09（expired の猶予 4 日と最終照会）／R-PAY-10（`Money` ブランド型、ゼロデシマル、上限 CHECK、最大剰余法）／R-PAY-15（生成列 NOT NULL、未知 status 拒否）／R-SEC-04（実シークレット名での成果物 grep、`server-only`）／R-SEC-06（管理面の別 IdP、二人承認、gates 読み取り専用）／R-SEC-07（ゲート定義ハッシュ G13、tamper guard の対象拡大）／R-SEC-13（`.npmrc` ignore-scripts、audit、固定バージョン、lockfile 差分）／R-LINE-04（LIFF ID と Login チャネル ID の束ね、起動時アサート、bundle grep）／R-LINE-05（Q-LN2 → 配布導線の順序ゲート、`(liff)`/`(web)` 分離、`build:web-only`）／R-LAW-01（Q-LG1 単独先行、否定分岐 ADR-010）／R-LAW-02（鍵を持たない構成 `credentialCustody: 'organizer'` を型で用意、Q-PP9）／R-LAW-04（PAY.JP に対価性・同額多数決済の照会、イベントに開催日時・会場・提供内容を必須）／R-LAW-10（幹事あたりの上限、通報、即時停止、反社条項）／R-OPS-04（Supabase Pro ＋ PITR、RPO/RTO、週次バックアップ、復元リハーサル、擬似匿名化の明記）／R-OPS-09（ゲート正本は JSON、DB は射影、`gates-sync`、フラグは別 API）／R-TH-07（fixture の provenance、synthesized のみは `autoDetect` 不可、G12）。

### 17-4. 第 3〜5 階層（44 件）: Phase 1 のうちに対処、または Phase 2 以降

S2 × high（27 件）: R-PAY-13 混在（台帳残高で二重払い検知、`mixed`）／R-SEC-02 招待トークンの寿命と露出（128 ビット、期限、ローテーション、パスから除去、no-referrer）／R-SEC-11 Webhook 濫用（IP 許可リスト、書式検査、429 監視）／R-SEC-15 監査連鎖の分岐（`id` 順・xact ロック・`audit:verify`）／R-LINE-06 配布・再訪・催促（コピー主導線、個別リンク、追加リクエスト、「自分に送る」、`GATE-LINE-SHARE`、Q-LN5）／R-LAW-05 特商法（販売事業者は幹事、幹事ごとの表記ページ、Q-LG10）／R-LAW-06 同意の順序（未 claim 氏名は幹事のみ、`consent_log`、委託か共同利用か）／R-LAW-12 税務の誤解（「会費受領記録」、固定免責文、禁止語）／R-LAW-13 規約の有効性（一部免責・上限型、弁護士レビュー必須、`gate:terms`）／R-LAW-14 ゲートの陳腐化（`valid_until`、`gate:compliance-freshness`）／R-OPS-02 サポート照会（読み取り専用 lookup）／R-OPS-05 幹事の誤操作（O-6.5、`PATCH /api/invoices/:id`）／R-OPS-06 連絡先不在（固定文言、O-13 の運営者情報を Phase 1 から）／R-UX-03 多人数（サマリ専用 API、ページング、既定フィルタ）／R-UX-04 a11y（WCAG 2.2 AA、三重表現、44px）／R-UX-06 オンボーディング（O-0 分岐）／R-UX-07 同意画面の情報ゼロ（preview 先行）／R-UX-08 体制（UX・採用レーン）／R-TH-05 外部依存の停滞（期限とタイムアウト時の既定判断）／R-TH-06 ハーネスの肥大（必須セットとタイムボックス）／R-TH-08 レビューの誤検出（repro 必須、ファイル全文同梱）／R-TH-09 懸念の雪だるま（G11）／R-TH-10 コスト（`constraint_ids` のみ同梱、1 周ごと計測）／R-TH-12 文脈の消失（Stop フックで毎ターン追記）／R-TH-13 リリース合意（成立条件ベース）／R-DATA-01 生ペイロード（許可キーのみ、14 日）／R-DATA-02 時刻（規約、`date` 型禁止、TZ 両方でテスト）。

S2 × medium（14 件）: R-PAY-11 未適用の回収（同一トランザクション、`apply-pending`）／R-PAY-12 checkout の write-ahead と timeout／R-SEC-08 ID トークン再利用（単回使用、exp ずれ 60 秒、レート制限。nonce は不採用: ADR-009）／R-SEC-10 鍵運用（`kid`、`session_epoch`、CRON 許容リスト）／R-SEC-12 XSS・CSP・CSRF 運搬（nonce CSP、ヘッダ運搬、`__Host-`）／R-SEC-14 受取リンク偽装（サーバー側テンプレート、許可ホスト、ホスト名併記）／R-LAW-07 越境移転・外的環境（プライバシーポリシー記載、Q-LG）／R-LAW-08 漏えい報告（`incident-response.md`、期限と担当）／R-LAW-09 未成年（申告必須、自動決済拒否）／R-LAW-11 捜査協力（突合可能性の維持、`legal-forensics.md`）／R-LAW-15 催促の規制（送信主体は幹事、回数・時間帯制約）／R-OPS-03 事業者アカウント停止（`ProviderAccountError`、`suspended` 降格、`manual_confirm` フォールバック）／R-UX-05 支払手段の欠落（「この方法では払えない」、現金フラグ）／R-TH-11 モデルの静かな差し替え（`model_id_actual`）。

その他（3 件）: R-LINE-08 開発フロー（dev エイリアス、実機確認必須）／R-LINE-07 プロバイダー固着（`identity_scope`、リカバリトークン）／R-TH-14 テストの独立性（受入テスト生成は `src/**` 不可）。

### 17-5. キルスイッチ（「起きたら即停止」条件）

**止めるのは新規の資金移動だけ。Webhook 受信・保存・照合・`getPaymentStatus`・`refund`・`manual_confirm` は止めない。**

即時に `PAYMENTS_ENABLED=false`（人間の判断を待たない）: ① 人間以外の actor による `gate.%` / `flag.%` 変更、または `docs/gates/*.json` と `compliance_gate` の差分 ② 弁護士から Q-LG1 に否定的回答 ③ 決済事業者から規約違反・加盟店資格の指摘 ④ service role キー・PEPPER・セッション鍵の漏洩の疑い ⑤ 非 production から本番 DB への書き込み ⑥ `audit:verify` の不一致 ⑦ 過払いまたは金額不一致で paid になった請求が 1 件 ⑧ LINEヤフーからポリシー違反の指摘。

provider 単位で `off`: `mismatch` / `orphan` が 1 日 5 件以上、事業者 429 または受信レート 10 倍、`ProviderAccountError` 連続 N 回（binding のみ `suspended`）、本番ペイロードで `parseWebhook` が例外、ゲートの `valid_until` 超過。

決済以外: 招待トークン漏洩 → ローテーション、セッション偽造 → `session_epoch`、XSS → エスケープ固定＋全失効、許可外 deepLink → 幹事 `suspended`、悪用スコア超過 → 新規イベント停止、催促ブロック率超過 → 催促停止、未成年含むイベント → 自動決済不可、未認証上限接近 → 新規招待停止、high concerns 3 件以上 → 新規着手停止、日次コスト超過 → Opus 停止、メタゲート失敗 → 全マージ停止。

停止時に必ず行うこと: レバー・理由・時刻を `audit_log` と `PROGRESS.md` に記録。照合と受信が止まっていないことを `reconciliation_run` で確認。`degraded` の告知帯（「支払いを止めています」と「入金の記録は続いています」を分けて書く）。停止中の `payment_event` を復旧後に適用。**復旧の判断は人間（noritaka）が行う。AI は停止はできるが再開はできない。**

### 17-6. 検知シグナル（実装先: ログ集計 ＋ 週次 `docs/metrics/`）

主要なもの: `reconcile_staleness_seconds`（900 秒超）、`reconcile_truncated_rate`（3 回連続）、`reconcile_run_unfinished_count`、`webhook_received_1h`（0 かつ open attempt あり）、`webhook_sig_ok_false_rate`、`provider_429_count`、`provider_auth_error_rate`、`payment_event_unprocessed_age`（10 分）、`apply_result` 内訳、`outbox_oldest_pending_age_seconds`（24 時間）、`attention_unseen_hours_p95`（24 時間）、`checkout_error_rate`、`time_to_paid_p95`、`return_unidentified` / `auth_missing_on_return`、`login_attempt_count > 1`、`liff_init_failed`（UA クラス別）、`AUD_MISMATCH`（1 件で alert）、`app_user` 日次新規作成数（DAU 比）、`overpay_count`、`manual_pending_hours`、`abuse.*`、`gate.staleness_days`、ファネル（着地 → 同意 → claim → checkout → paid）、`organizer_repeat_event_rate`。DB 監査クエリ（`settlement_rank IS NULL` 0 件、台帳残高と請求額の差分、`prev_hash` 一意、open attempt 2 件以上 0 件、`raw_redacted` のキー分布、人間以外の actor による gate/flag 変更 0 件、grants スナップショット差分 0）。人手: 実機確認、四半期の復元リハーサルと漏えい机上訓練、月次の事業者 CSV 突合、パイロットヒアリング。

### 17-7. 再実行

`premortem.ts` をフェーズ境界（設計確定時・Phase 1 実装完了時・パイロット前・Phase 2 本番前）に再実行し、前回との差分のみを新規リスクとして `docs/premortem/<date>.json` に記録する。前回 high の未対応が 3 件以上なら新規着手を止める（G11）。

---

## 18. 未決事項・外部照会

### 18-1. 照会の優先順序（全文は task_002 で `docs/inquiries/*.md` に起票。各照会に `no_response_deadline`＝送付 + 21 日と `default_decision_on_timeout` を持たせる）

| 優先 | 宛先 | 主質問 | 決まること |
|---|---|---|---|
| 1 | **弁護士（単独先行）** | **Q-LG1** アプリが支払先と金額を指定して参加者に支払わせる行為は資金決済法 2 条の 2 柱書の「他の者に受け入れさせ」に当たるか。否定回答の場合に取りうる構成（第 3 号ニの提携先、株式会社化、`manual_confirm` の扱い） | `GATE-LEGAL-FUNDS` の骨格。否定なら Phase 2 停止（ADR-010） |
| 2 | PayPay 加盟店窓口 | Q-PP1 会費徴収は取扱可能商材か（寄付・募金・投げ銭に該当しないか）/ Q-PP2 イベント参加権の販売は「役務の代価」か / Q-PP3 実店舗を持たない個人事業主の申込と店舗写真の代替 / Q-PP4 個人アカウントへの送金を第三者が API 照会する手段 / Q-PP5 Webhook の署名・登録手順・リトライ・ペイロード定義 / Q-PP6 支払者識別情報 / Q-PP7 継続課金・支払リクエストの「法人のみ」 / Q-PP8 LINE×PayPay 連携の外部 API / **Q-PP9 加盟店 API キーを委託先（本アプリ運営者）が保管して呼ぶことの規約上の可否** / **Q-PP10 紛争・売上取消の通知手段と API 表現** / **Q-PP11 Webhook 送信元 IP レンジの公式一覧** / **Q-PP12 Webhook URL の変更手順とリードタイム** | 第一候補の go/no-go、`GATE-PP-*`、`GATE-CRED-CUSTODY` |
| 3 | PAY.JP | 規約本文、個人間送金・立替精算の扱い、非事業者可否、手数料、返金仕様、Q-PP9 相当、**イベント参加費の対価性、同額多数決済が不正検知に抵触しないか** | 第二候補の go/no-go |
| 4 | 弁護士（残り） | Q-LG2 第 3 号ロ「契約の成立に不可欠な関与」/ Q-LG3 第 3 号ニ / Q-LG4 第 1 号を規約で外しても第 3 号で捕捉されるか / Q-LG5 前払い限定で第 2 号回避 / Q-LG6 継続的主催者は「事業として受取人」か / Q-LG7 クレデンシャル保管と権限分離 / Q-LG8 割賦販売法 35 条の 16・17 の 2 / Q-LG9 第三者提供該当性と同意設計（委託か共同利用か）/ Q-LG10 特商法（個人幹事の住所・電話の表示方法）/ Q-LG11 非弁該当性（催促）/ **Q-LG12 クラウド例外と外的環境の公表事項 / Q-LG13 同意前に出してよい最小情報 / Q-LG14 漏えい報告の期限 / Q-LG15 保持期間の根拠 / Q-LG16 グレーゾーン解消制度・ノーアクションレター・フィンテックサポートデスクの選択** | `GATE-LEGAL-PII`、`GATE-CRED-CUSTODY`、L11 |
| 5 | LINEヤフー審査窓口 | Q-LN1 禁止業種該当性 / **Q-LN2 現実世界の役務の集金にアプリ内課金は必要か（回答が配布導線 task_016 の前提）** / Q-LN3 集金仲介の審査評価 / Q-LN4 催促をサービスメッセージの枠内で送れるか / **Q-LN5 未認証ミニアプリの利用者数上限** / Q-LN6 利用料と通数カウント / **Q-LN7 ミニアプリチャネルで `shareTargetPicker` は利用可能か・申請要否** | `GATE-LINE-POLICY`、`GATE-LINE-SHARE` |
| 6 | Stripe（後回し） | 日本の「Connect 外での C2C サービス」条項、PayPay×Connect の記載矛盾、`paypay_payments`、Accounts v2 | 保留候補 |
| 7 | PayPal / 楽天銀行・電子決済等代行業者 | ビジネスアカウント要否・API 資格 / 「外部サービス会社」契約基準・審査要件・リードタイム・費用 | 第三候補・Phase 3 |

### 18-2. 回答が返るまでの進め方
- Phase 1 は照会と並行。アダプタ層・台帳・冪等基盤・LIFF 外殻・ハーネスは事業者が変わっても捨てない。
- `resolveProvider` が `manual_confirm` 以外を返さないので、コードが勝手に先へ行くことは構造的に起きない。
- Phase 1 の間、決済 SDK を `package.json` に入れない。
- PayPay サンドボックスでの先行実装は可。`main` へのマージはゲート通過後。
- 期限超過は `session-brief.mjs` が毎セッション警告し、`default_decision_on_timeout`（例: PayPay 未回答なら PAY.JP を第一候補に繰り上げ、LINE 未回答なら `(web)` 経路で先行パイロット）を PO に提示する。
- **`GATE-LINE-POLICY` と `GATE-LEGAL-PII` は、パイロットをクローズド β（招待した幹事 3〜5 名・参加者は同意済み）に限定する場合に限り Phase 1 リリースの前提から免除する**（ADR に記録。一般公開時には必須）。

### 18-3. 費用（すべて未確定）

| 項目 | 概算 | 確信度 |
|---|---|---|
| Cloudflare Workers Paid | $5/月〜（必須。Hyperdrive・Cron Triggers・WAF カスタムルール・Access の無料枠は [不明]） | 低 |
| Supabase Pro（PITR）× 2 プロジェクト | $25/月〜 ×2（Free は選択肢から外す） | 低 |
| LINE ミニアプリ利用料 / Messaging API 通数 | 不明（Q-LN6） | 低 |
| ドメイン・外形監視・シークレットストア | 年 ¥2,000 前後 ＋ 無料枠想定 | 中 |
| 弁護士照会 | 不明（数十万円規模を想定） | 低 |
| 幹事の決済手数料 | PayPay オンライン物販 3.8% / デジタル 10%（未検証）、PAY.JP 不明 | 低 |
| 加盟店審査期間 / 入金タイミング | PayPay 2 週間〜1 カ月 ＋ 5 営業日 / 月 1 回・月末（未検証） | 低 |
| AI 運用コスト | 4 モデルの単価が [不明]。task-loop 1 周ごとに計測 | 不明 |

5,000 円 × 10 人 = 50,000 円で手数料 3.8% なら 1,900 円が幹事負担。PayPay / Kyash の個人間送金は 0 円。差額に見合う価値（名簿・複数イベント横断・21 名以上・個別金額・受領記録）は未検証であり PO の判断事項。

### 18-4. 明示的に満たせない要件（構造的制約）
1. 「幹事の個人 PayPay で受け取りつつ自動チェック」を実現する公開経路は見つかっていない（確信度 中。Q-PP4 の回答で確定。A22）。本計画はこの経路を前提にしない。
2. 幹事の加盟店審査と、幹事自身が特商法 11 条の表示義務の主体になること（氏名・住所・電話の公開、または Q-LG10 で認められる代替手段の確保）が最大の摩擦で、設計では解けない。ターゲットを継続的主催者、なかでも屋号住所または団体名義を持つ主催者に寄せる（A26）。
3. 代理払いを自動で追えない。
4. 手数料ゼロの既存機能に構造的に負け、2026 年夏以降 LINE 本体が競合する。
5. 画像証跡を扱わない。
6. アダプタ層の抽象化コストを先払いしている。
7. 第一候補の選定が未検証の事実に依存している。
8. `manual_confirm` 縮退構成でも柱書該当の可能性が残る（Q-LG1 待ち）。
9. Phase 1〜2 の幹事通知はプッシュではない（Messaging API 経由の通知は幹事が友だち追加した場合のみ）。
10. 幹事と参加者の連絡手段をアプリは提供しない。
11. プロバイダー固着は解消できない。
12. 未成年が含まれるイベントは自動決済を使えない。
13. ハーネス側: 4 モデルのスペック [不明]、GPT 経路遮断中、Gemini の実モデルが指定と異なる、フック遮断挙動は未実測、`context7` MCP 停止。
14. Q-PP9 / Q-LG7 が否定された場合、`credentialCustody: 'organizer'`（鍵を持たない構成）では運営者が照会 API を呼べず、§2-4 の達成定義 (2)(4) を満たせない。Phase 2 は「幹事が事業者管理画面で確認した入金を幹事自身が記録する半自動」に縮退し、これを自動チェックとは呼ばない。
15. `(web)` ルートグループは Phase 1 では退避先にならない（§5、ADR-013）。
