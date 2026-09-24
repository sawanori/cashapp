# チーム構成・ハーネス案 T2 — 品質ゲート駆動

起案日: 2026-09-24 / 起案者: 開発組織・AIハーネス設計者（独立起案）
観点: **「壊れた状態を次工程に渡さない」を最優先**。合格した工程の出力だけが次工程の入力になる。
使用モデル: Opus 5.5 / Sonnet / Gemini 3.8 Flash / GPT-6 Astla。**Fable モデルは使わない。**

---

## 0. この案の前提と、本セッションで検証した事実

### 0-1. T2 が最適化している対象

このプロジェクトで「壊れた状態」とは、テストが赤いことではない。**最も高価な壊れた状態は、規約・法令に抵触する設計を実装まで進めてしまうこと**である。統合調査（`research/consolidated.md`）が示した実績がその根拠になる。

- 過去のAI（Claude系）が「Stripe Connect を使えば誰でも幹事になって友人から会費を集められる」と断定し、引継ぎ書がそれを訂正している（引継ぎ書 §4-2）。
- 調査統合レポートは、**3レンズ反証検証にかけた18件のうち、PayPay公開API範囲(PP-01)、公式SDKメソッド数(PP-02)、Stripe禁止業種の性質(F02)、資金決済法2条の2の除外範囲(F1)、LINE送金機能の現存(F04) など複数が「3レンズ全てが refuted」で覆った**（§3-1〜3-8）。
- つまりこのプロジェクトでは、**単一ベンダーの推論だけで固めた事実主張が、実測で覆る確率が観測上高い**。T2 のハーネスはこの1点を中心に組む。

したがって T2 のゲートは、CI の赤緑だけでなく次の3層を機械化する。

| 層 | 壊れた状態の例 | ゲート |
|---|---|---|
| 法務・規約層 | 運営者が資金を経由する実装が入る（制約 L1 違反） | G0 法務ゲート、G2-c 禁止パターン grep、G5 敵対レビュー |
| 契約・整合層 | Stripe SDK を Route Handler が直接叩く（制約 P1 違反） | G2-b 境界ゲート、G4 CI |
| 実行層 | Webhook が重複で二重計上する（制約 W1/W2 違反） | G3 Stop フック（3本の必須テスト）、G4 CI |

### 0-2. 本セッションで実際に確認した環境事実（コマンド実行済み）

| 事実 | 確認方法 |
|---|---|
| `codex-cli 0.154.0` がインストール済み（`/Users/noritakasawada/.local/share/nvm/v22.22.0/bin/codex`） | `codex --version` |
| `gemini 0.38.1` がインストール済み（同 nvm bin） | `gemini --version` |
| `claude 2.1.257 (Claude Code)` | `claude --version` |
| `node v22.22.0` | `node -v` |
| **pnpm は起動不可**（`node:internal/modules/cjs/loader` で throw。corepack シム破損） | `pnpm --version` |
| `gh` / `stripe` / `supabase` / `vercel` CLI が PATH 上に存在 | `which` |
| `~/.claude/agents` に既存エージェント定義43本（task-executor, code-reviewer, verifier, quality-fixer, investigator, technical-designer, solver, work-planner, task-decomposer, acceptance-test-generator, integration-test-reviewer, code-verifier, document-reviewer, rule-advisor, scope-discoverer, requirement-analyzer, prd-creator, serena-expert, design-sync ほか） | `ls ~/.claude/agents/` |
| `~/.claude/settings.json` に存在するフックイベントは **SessionStart / UserPromptSubmit / Notification** の3種 | 実ファイル読解 |
| fable-protocol の `references/hooks.md` が **PostToolUse / Stop** のレシピを持つ | 実ファイル読解 |
| `scratchpad/design/` と `scratchpad/premortem/` は**空**。T1 は本セッション時点で未作成 | `ls -la` |
| MCP: `mcp__gemini-cli__*` は利用可能。**`codex` MCP は CONNECTION_CLOSED で接続失敗**。`context7` も接続失敗 | 本セッションのシステム通知 |

**帰結（設計に直結）**: Gemini への経路は MCP と CLI の二重化ができるが、**GPT への経路は現時点で `codex` CLI（Bash 経由）しかない**。T2 のベンダー横断レビューは、この非対称を前提に代替経路を定義する（§2-4、§7-5）。

### 0-3. 本セッションで確認できていないこと（不明と明記する）

- **Opus 5.5 / Sonnet / Gemini 3.8 Flash / GPT-6 Astla の、正確なコンテキスト長・トークン単価・p50/p95 レイテンシ・ツール呼び出し精度は、本セッションで一次資料を取得していない。不明。** 本書のモデル配置根拠は「公開スペック」ではなく、**タスクの性質と、週0で実測する手順**に接地させる（§2-5 に実測プロトコルを置く）。
- 本セッションの実行モデルは `claude-opus-5[1m]`（モデルIDに 1M コンテキストの表記）。これは環境情報からの引用であり、他モデルの値は不明。
- Claude Code のフックイベントのうち **PreToolUse / SubagentStop / PreCompact の実在と、PreToolUse が exit code 2 でツール呼び出しを遮断する挙動は、本セッションで未検証**。§3-1 の該当行に `[要検証]` を付す。導入前に `/update-config`（update-config スキル）で実挙動を確認すること。
- Workflow ツールの `agent()` / `parallel()` / `pipeline()` の正確なシグネチャは未確認（`local-context.md` の記載を引用）。§3-3 のスクリプトは疑似コードであり、実装前に `workflow-authoring` スキルを読むこと。

### 0-4. 「Fable を使わない」と `fable-protocol` スキルの関係

**Fable モデルは使わない。** 一方 `fable-protocol` は ~/.claude/skills 配下の**プロンプト規範スキル**であり、モデルではない。T2 はこのスキルの「完了前5ステップゲート」と「4値完了ステータス」を、Opus 5.5 / Sonnet / Gemini / GPT の全モデルに適用する共通プロトコルとして採用する（§4）。両者を混同しない。

---

## 1. 役割表

担当欄の記法: `[人間]` / `[Opus5.5]` / `[Sonnet]` / `[G-Flash]`（Gemini 3.8 Flash）/ `[GPT6]`（GPT-6 Astla）。

### 1-1. 意思決定・外部折衝レーン

| 役割 | 担当 | 入力 | 出力 | 停止・エスカレーション条件 | 使うツール |
|---|---|---|---|---|---|
| **プロダクトオーナー / 最終決裁** | [人間] noritaka | ゲート報告、go/no-go 候補一覧、コスト実績 | 受取先方式の決定、本番決済の有効化承認、公開可否 | — （最終決裁者。ここで止まる） | GitHub Issue、`docs/decisions/ADR-*.md` |
| **照会文起案・回答の構造化** | [Opus5.5] | `consolidated.md` §5 の質問リスト | PayPay/Stripe/LINE/弁護士あて照会文、回答の構造化記録 | 回答が「確認中」で2週間停滞 → PO へ日次エスカレーション | `docs/inquiries/*.md`、Gmail MCP（下書きのみ、送信は人間） |
| **法務ゲートキーパー** | [人間] 弁護士（資金決済法） + [Opus5.5] が事前整理 | 資金フロー図、利用規約案、`consolidated.md` §6-1 の L1〜L12 | 各ルートの適法性判断書、`docs/decisions/ADR-legal-*.md` | **本番決済の有効化は弁護士確認またはグレーゾーン解消制度の回答が出るまで無条件でブロック（L11）** | 人間の面談。AI側は照会文と論点整理のみ |
| **決済事業者窓口** | [人間] PO | 照会文 | 商材可否・審査要件・手数料の一次回答 | PayPay の商材照会（§5-1 Q1〜3）が未回答なら候補A実装は着手しない | 電話・メール・加盟店パネル |

### 1-2. 設計・実装レーン

| 役割 | 担当 | 入力 | 出力 | 停止・エスカレーション条件 | 使うツール |
|---|---|---|---|---|---|
| **オーケストレーター / 実装リード** | [Opus5.5]（Claude Code メインセッション） | `handover.md`、`consolidated.md`、`docs/task-list.json` | タスク割当、ゲート判定、`docs/PROGRESS.md` 更新 | コンテキスト使用率60%超 → 成果物へ圧縮して再開（orchestration.md）。ゲート3連続失敗 → PO へ | Claude Code 本体、Workflow ツール |
| **要件分解・タスク化** | [Opus5.5] | 承認済み設計、制約ID一覧 | `docs/task-list.json`、`docs/acceptance-checks.json` | 1タスクの受入基準がYES/NO化できない → 分解し直す | agent: `requirement-analyzer` → `task-decomposer`、skill: `plan` |
| **技術設計** | [Opus5.5] | 制約ID（L/P/W/N/I）、照会回答 | `docs/design/*.md`（PaymentProvider IF、DBスキーマ、状態機械） | 決済事業者未確定の部分にアダプタ層以外の依存が生じたら停止 | agent: `technical-designer` |
| **実装（バックエンド）** | [Sonnet] | タスクファイル1本（自己完結） | コード + テストの同一diff | タスクファイルに書かれていない判断が必要 → `NEEDS_CONTEXT` で返す（勝手に埋めない） | agent: `task-executor`、Serena MCP |
| **実装（LIFF/フロント）** | [Sonnet] | タスクファイル1本 | コード + テスト | 同上 | agent: `task-executor-frontend`、skill: `web-typography`, `frontend-design` |
| **品質修正** | [Sonnet] | 失敗した lint/type/test の出力全文 | 修正diff、全Phase緑の証拠 | **テストを通すためにテストを編集しようとした瞬間に停止**し、`BLOCKED` で報告 | agent: `quality-fixer` / `quality-fixer-frontend` |
| **調査（広域一次資料）** | [G-Flash] | 調査スコープ + 出力フォーマット | 一次資料の逐語引用 + URL + 取得日時 | フェッチ失敗したURLは「取得失敗」と明記。推測で埋めたら差し戻し | `mcp__gemini-cli__ask-gemini`、WebFetch |
| **調査（結論の統合）** | [Opus5.5] | G-Flash の生収集物 | 確信度付きの結論 | 一次資料の逐語引用がない主張は結論に載せない | agent: `investigator` |

### 1-3. 検証・敵対レビューレーン（T2 の中核）

| 役割 | 担当 | 入力 | 出力 | 停止・エスカレーション条件 | 使うツール |
|---|---|---|---|---|---|
| **自陣レビュー（設計適合）** | [Opus5.5] | diff + 該当タスクの受入基準 | 適合/不適合の判定と根拠 | 判定に「〜はず」が入ったら差し戻し | agent: `code-reviewer` |
| **敵対レビューA: 規約・仕様の裏取り** | [G-Flash] | diff + 制約ID一覧 + 該当一次資料URL | JSON findings（後述フォーマット） | **一次資料を再フェッチせずに「規約違反なし」と答えたら無効票** | `mcp__gemini-cli__ask-gemini`（主）/ `gemini -p`（副）、agent: `adversarial-reviewer-gemini`（新規） |
| **敵対レビューB: 論理・設計の穴** | [GPT6] | diff + 制約ID一覧 + 「違反する入力列を1つ挙げよ」 | JSON findings | 具体的な入力列を書けない指摘は `severity: info` に降格 | `codex exec`（Bash）、agent: `adversarial-reviewer-gpt`（新規） |
| **契約ガード（P/W/N制約の機械検査）** | [Sonnet] | diff | 違反した制約IDの一覧 | 1件でも違反 → マージ不可 | agent: `payment-contract-guard`（新規）+ `scripts/gate-constraints.sh` |
| **法務ガード（L制約の機械検査）** | [Opus5.5] | diff + 資金フロー変更の有無 | L制約違反の有無、弁護士エスカレーション要否 | **資金が運営者名義を経由するコード・設定を検知したら即 BLOCKED** | agent: `legal-gatekeeper`（新規） |
| **検証（証拠の照合）** | [Opus5.5] | 完了主張 + 添付された実行ログ | 5ステップゲートの通過可否 | 「テストが走った」と「テストが通った」の混同を検出したら差し戻し | agent: `verifier` / `code-verifier` |
| **受入テスト生成** | [Sonnet] | 受入基準（仕様のみ。実装は見せない） | テストコード | 実装を見て書いたら無効（AgentCoder パターン） | agent: `acceptance-test-generator` |

### 1-4. 運用レーン

| 役割 | 担当 | 入力 | 出力 | 停止・エスカレーション条件 | 使うツール |
|---|---|---|---|---|---|
| **リリース前監査** | [Opus5.5] + [G-Flash] + [GPT6]（3者独立） | リリース候補の全diff、ADR、acceptance-checks の充足状況 | 3者それぞれの go/no-go と根拠 | **3者のうち1者でも no-go なら PO 判断へ。全会一致でなければ自動リリースしない** | agent: `release-auditor`（新規）、Workflow `release-audit.ts` |
| **プレモータム実施・再実行** | [Opus5.5] 起案 → [GPT6] 反証 → [G-Flash] 一次資料照合 | 現行設計、前回のプレモータム結果 | `scratchpad/premortem/premortem-YYYYMMDD.md`、新規リスクの task 化 | 前回から未対応のまま残った High リスクが3件以上 → 実装を止めて対応 | agent: `premortem-facilitator`（新規） |
| **インシデント一次対応** | [Sonnet]（ランブック実行） → [人間] 判断 | アラート、ランブックID | 対応ログ、恒久対応タスク | **資金・返金に関わる操作は人間の承認なしに実行しない** | `docs/runbooks/*.md`、Supabase MCP、Stripe MCP |
| **コスト監視** | [Sonnet]（週次） | モデル別トークン実績 | `docs/metrics/cost-YYYYWW.md` | 週次予算の120%超で Opus 呼び出しを一時停止し PO へ | ccusage 等（導入要）、CI のジョブログ |

---

## 2. モデル適材適所の根拠

### 2-1. 配置の原則

**原則1: 判断の可逆性で分ける。** 取り消しが効かない判断（設計の骨格、法務、リリース可否）は Opus 5.5。取り消しが効く作業（実装、定型修正、テスト記述）は Sonnet。読み捨ての収集は Gemini Flash。

**原則2: 検出者と作者は別ベンダーにする。** Claude が書いたコードの「見落とし」は、同じ訓練分布の Claude では拾いにくい。§0-1 で示した通り、このプロジェクトでは実際に Claude系の断定が反証で覆っている。レビューの最終票は必ず異ベンダー（Gemini / GPT）が持つ。

**原則3: 不明なスペックに依存した配置をしない。** 後述の通り各モデルの正確な諸元は本セッションで未確認なので、配置根拠を「そのモデルにしかできないこと」ではなく「**失敗した時の損害の大きさ × 検証コスト**」に置く。

### 2-2. モデル別 — 得意・不得意・配置

#### Opus 5.5

- **配置**: オーケストレーション、技術設計、法令条文の読解、レビュー判定の統合、リリース監査、照会文起案。
- **得意と判断する根拠**: 内閣府令1条の2第3号「イ〜ニのいずれにも該当すること」のような**多重条件の充足判定と、その否定形（どれか1つを崩せば不成立）の導出**は、`consolidated.md` §3-4 が実際にそうやって設計選択肢を1つ増やした種類の推論であり、長文の条文と複数資料を同時に保持したうえでの整合判定を要する。これが本プロジェクトで最も価値の高い認知作業。
- **不得意・リスク**: (a) 自分の推論に自信を持ちすぎる（引継ぎ書 §4-2 が訂正した断定はこの系統）。(b) コストと遅延が最大。
- **対策**: Opus の事実主張は**必ず異ベンダーの反証を通す**。Opus を「書く人」ではなく「判定する人」に寄せ、1タスクあたりの呼び出し回数を設計上3回以内（設計 → レビュー判定 → 完了ゲート）に制限する。
- **コスト・遅延・コンテキスト長**: 本セッションの実行モデルIDは `claude-opus-5[1m]`（1M コンテキスト表記）。**単価とレイテンシは本セッションで未確認＝不明。** §2-5 で実測する。

#### Sonnet

- **配置**: 実装（task-executor / task-executor-frontend）、品質修正（quality-fixer）、受入テスト生成、ランブック実行、契約ガードの機械検査、週次メトリクス集計。
- **得意と判断する根拠**: 入力が自己完結したタスクファイル1本に固定されている状況での、コード生成とツールループ。既存エージェント定義（`task-executor.md` の「Asks no questions, executes consistently from investigation to implementation」）がこの前提で書かれており、そのまま使える。
- **不得意・リスク**: **仕様の穴を質問せずに埋める。** これは本プロジェクトで致命的になる（例: 決済事業者未確定なのに Stripe SDK を直接 import する、Webhook の冪等キーを event_id だけにする）。
- **対策**: (a) タスクファイルに「この判断はしてよい/してはいけない」を明記し、書かれていない判断が必要になったら `NEEDS_CONTEXT` で返す規律を課す（§4）。(b) `payment-contract-guard` の機械検査を PostToolUse で走らせ、穴埋めを構造的に潰す。
- **コスト・遅延・コンテキスト長**: **不明**（未確認）。Opus より安価・高速という一般的期待に依存した設計はしていない。実測後にタスク割当比率を調整する。

#### Gemini 3.8 Flash

- **配置**: 広域の一次資料フェッチと逐語抽出、大量HTML/法令XMLの突合、diff の一次スクリーニング、敵対レビューA（規約・仕様の裏取り）。
- **得意と判断する根拠**: このプロジェクトの調査フェーズは、`scratchpad/` に 5.9MB の法令XML、290KB の Stripe SSA HTML、467KB の事務ガイドラインテキストなどを落として突合する作業だった（`ls -la` で実測）。**「大量の一次資料を安く何度も読み直す」**ことが定常的に必要で、これは Flash 級の役割。加えて、レビューで「規約に違反していないか」を答えるには**毎回 URL を再フェッチさせる**必要があり、呼び出し回数が多い。
- **不得意・リスク**: (a) 深い法解釈と、複数条文にまたがる条件充足判定は任せられない。(b) フェッチに失敗しても「見つからなかった＝存在しない」と書く危険。
- **対策**: 出力フォーマットを「逐語引用 + URL + 取得日時 + 取得成否」に固定し、**引用のない主張は無効票**にする。統合と解釈は Opus が行う。
- **コスト・遅延・コンテキスト長**: **不明**（未確認）。ただし経路は二重（MCP `mcp__gemini-cli__ask-gemini` と CLI `gemini 0.38.1`）で、片方が落ちても継続できることは本セッションで確認済み。

#### GPT-6 Astla

- **配置**: 敵対レビューB（論理・設計の穴）、プレモータムの反証役、リリース監査の第3票、Claude が書いた「事実主張」の独立反証。
- **得意と判断する根拠**: **訓練分布が Claude と異なること自体が配置理由。** 得意分野の主張ではなく、相関のない誤りを出すことに価値がある。`consolidated.md` の3レンズ反証検証が18件中複数を覆した実績が、この設計の期待値を裏付ける。
- **不得意・リスク**: (a) **本セッションで `codex` MCP が CONNECTION_CLOSED。経路が CLI 1本しかない。** (b) このプロジェクトの日本法・PayPay・LINE の文脈知識は未検証。
- **対策**: (a) 経路の代替を §7-5 に定義。(b) 法令解釈は担当させず、「この diff が制約 X に違反する**具体的な入力列**を1つ挙げよ。挙げられなければ PASS と書け」という**反例提示型**に限定する。知識ではなく構成力を使わせる。
- **コスト・遅延・コンテキスト長**: **不明**（未確認）。`codex-cli 0.154.0` がインストール済みであることのみ確認。

### 2-3. 一覧（配置と、その配置を撤回する条件）

| 作業 | 一次担当 | 撤回条件（この条件が観測されたら配置を変える） |
|---|---|---|
| 技術設計・法令読解 | Opus5.5 | 設計レビューで異ベンダーの finding が3スプリント連続で High を出す → 設計段階から GPT6 を同席させる |
| 実装 | Sonnet | `NEEDS_CONTEXT` 率が30%超 → タスク分解が粗い。task-decomposer を Opus に戻す |
| 一次資料収集 | G-Flash | 逐語引用の欠落率が10%超 → Opus の `investigator` に戻す |
| 敵対レビューA | G-Flash | Gemini 単独検出 finding が2スプリント連続ゼロ → 役割が機能していない。プロンプトを見直すか GPT6 に統合 |
| 敵対レビューB | GPT6 | 同上 |
| リリース監査 | 3者 | — （撤回しない。全会一致要件は固定） |

### 2-4. ベンダー横断レビューの設計

**設計思想**: レビューを「感想文」ではなく「**反例の提出**」にする。反例が出なければ PASS、出たらその反例をそのままテストケースにする。これで「レビューで指摘されたが直っていない」が構造的に起きない。

#### レビュー入力パッケージ（3者共通・機械生成）

```
scripts/build-review-packet.sh <PR番号>  →  /tmp/review-packet.json
{
  "pr": 42,
  "diff": "<git diff origin/main...HEAD の全文>",
  "changed_files": ["src/lib/payments/stripe.ts", "..."],
  "task_ids": ["T-013"],
  "acceptance_checks": [ ...docs/acceptance-checks.json から該当分を抽出... ],
  "constraints": [
    {"id":"L1","text":"運営者の口座・決済アカウントを資金が経由しない","source":"資金決済法2条の2柱書"},
    {"id":"P1","text":"PaymentProvider アダプタ層を経由しない決済SDK呼び出しを禁止"},
    {"id":"P2","text":"parseWebhook は raw 文字列と Headers を受け取る。アダプタ外で JSON.parse しない"},
    {"id":"P3","text":"リダイレクト到達を支払い確定の根拠にしない"},
    {"id":"P9","text":"参加者ごとに個別の決済リクエストを発行する"},
    {"id":"W1","text":"(provider, event_id) の一意制約で重複を弾く"},
    {"id":"W2","text":"加えて (data.object のID, event.type) の業務冪等キーを併用"},
    {"id":"W3","text":"支払状態は単調な状態ランクでのみ前進"},
    {"id":"W5","text":"署名検証→重複排除→状態更新 を同期で済ませ 2xx を素早く返す"},
    {"id":"N2","text":"フロントから送られたユーザーIDを信用しない。サーバー側でトークン検証"},
    {"id":"N4","text":"主機能はミニアプリのエンドポイントドメイン内で完結"},
    {"id":"I3","text":"MVPではRLSを使わず全DBアクセスをサーバー側で行う"}
  ],
  "primary_sources": ["https://docs.stripe.com/webhooks", "https://www.paypay.ne.jp/opa/doc/v1.0/dynamicqrcode", "..."]
}
```

制約リストの全文は `consolidated.md` §6（L1-L12 / P1-P9 / W1-W12 / N1-N12 / I1-I6）を `docs/constraints.json` に機械可読化して保持し、このスクリプトが参照する。

#### 敵対レビューA（Gemini 3.8 Flash）のプロンプト骨子

```
あなたは敵対的レビュアーです。このdiffを「通す」ためのレビューではなく、
「規約・一次資料に照らして違反している箇所を探す」レビューをします。

必須手順（省略したら無効票として扱われます）:
1. primary_sources のURLを実際にフェッチする。フェッチできなかったURLは fetched:false と記録する。
2. 各 constraint について、diff の該当行を引用し、一次資料の該当箇所を逐語引用する。
3. 逐語引用できない constraint は verdict:"UNKNOWN" とする。"PASS" にしてはいけない。

禁止:
- 一次資料を再フェッチせずに "規約違反なし" と書くこと
- 「おそらく問題ない」「一般的には」で判定すること

出力は次のJSONのみ:
{"reviewer":"gemini-3.8-flash","fetched_sources":[{"url":"...","fetched":true}],
 "findings":[{"constraint_id":"P2","verdict":"FAIL","severity":"high",
   "diff_excerpt":"const body = await req.json()",
   "source_quote":"未加工のリクエスト本文に何らかの変更が行われた場合、検証は失敗します",
   "source_url":"https://docs.stripe.com/webhooks",
   "repro":"署名付きWebhookを送ると constructEvent が SignatureVerificationError を投げる"}],
 "overall":"FAIL"}
```

#### 敵対レビューB（GPT-6 Astla）のプロンプト骨子

```
あなたは敵対的レビュアーです。知識ではなく構成力を使ってください。

各 constraint について、次のどちらかだけを書きます:
(a) この diff がその constraint に違反する【具体的な入力列】を1つ。
    例: "Webhook A(event_id=e1, status=paid) が t=0 に届き、
        Webhook B(event_id=e2, 同一 payment の status=pending) が t=1 に届く。
        コードは event_id で重複排除しているため B も処理され、status が paid→pending に後退する"
(b) 反例を構成できなかった場合は "PASS"。

禁止: 「〜すべき」「ベストプラクティスでは」という一般論。
反例を書けない指摘は severity:"info" に降格されます。

出力JSONは敵対レビューAと同一スキーマ（reviewer:"gpt-6-astla"）。
```

#### 集計ルール（機械）

```
scripts/merge-review.sh  →  review-verdict.json
- severity:"high" が1件でもある → PR は BLOCKED（マージ不可）
- severity:"medium" は該当タスクの acceptance_checks に自動追記され、
  次のループで潰すまで DONE にできない
- verdict:"UNKNOWN" が constraint 総数の20%を超える → レビュー自体が無効。再実行
- Gemini と GPT が同一 constraint で FAIL/PASS に割れた → Opus5.5 が
  一次資料を自分でフェッチして裁定し、裁定理由を ADR に残す
```

#### なぜ Claude 同士のレビューで代替しないか

`code-reviewer`（Opus5.5）は残すが、それは**設計適合**（タスクの受入基準を満たしたか）の判定であり、**事実主張の反証ではない**。§0-1 の通り、このプロジェクトでは Claude 系の断定が実際に覆っている。事実主張の反証票は異ベンダーが持つ。

### 2-5. スペック不明を埋める実測プロトコル（週0に1回だけ実施）

各モデルの諸元が不明なので、**配置を根拠づける最小の実測**を先に行う。

```
scripts/bench-models.sh   # 4モデル × 3タスクを1回ずつ。結果を docs/metrics/model-bench.md へ
  タスクB1: 「consolidated.md §6 の制約表から docs/constraints.json を生成せよ」
            → 構造化変換の正確さ（欠落セル数）・所要秒・概算コスト
  タスクB2: 「この Webhook ハンドラ（意図的に W2 違反を仕込んだ40行）の
             バグを指摘し、再現する入力列を書け」
            → 反例提示力（正解検出/誤検出）
  タスクB3: 「https://docs.stripe.com/webhooks を読み、
             重複イベント識別に使うフィールドを逐語で引用せよ」
            → 一次資料フェッチの成否・逐語一致率
```

判定基準は事前に固定する（B1: 欠落0が合格 / B2: 正解検出かつ誤検出0が合格 / B3: 逐語一致が合格）。**この結果が出るまで、本書のモデル配置は「暫定」と扱う。** 実測でひっくり返ったら §2-3 の撤回条件に従って配置を変える。

---

## 3. ハーネス構成

### 3-1. (a) `.claude/settings.json` のフック

**方針**: フックはプロジェクト単位でオプトインする（`fable-protocol/references/hooks.md` の指示）。`/Users/noritakasawada/AI_P/cashapp/.claude/settings.json` に置き、グローバルには入れない。**pnpm が壊れているので全コマンドを `npm` で書く**（§0-2 で実測）。

```jsonc
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {
    // --- G2-a: 編集のたびに型と lint。壊れたコードを次の編集に持ち越さない ---
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && npx tsc --noEmit -p tsconfig.json",
            "timeout": 120,
            "statusMessage": "typecheck"
          },
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && npx eslint --max-warnings=0 $(git diff --name-only --diff-filter=ACM -- '*.ts' '*.tsx' | tr '\\n' ' ') 2>/dev/null || true",
            "timeout": 90,
            "statusMessage": "lint(changed)"
          },
          // --- G2-b/c: 制約の機械検査。ここが T2 の心臓部 ---
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && bash scripts/gate-constraints.sh",
            "timeout": 60,
            "statusMessage": "constraint gate (L/P/W/N/I)"
          }
        ]
      },
      {
        // 計画ファイルを壊したら即座に気づく
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && node scripts/validate-plan-json.mjs",
            "timeout": 30,
            "statusMessage": "task-list/acceptance-checks schema"
          }
        ]
      }
    ],

    // --- G3: テストが通るまでターンを終了できない ---
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && npm run test:gate",
            "timeout": 300,
            "statusMessage": "stop gate: contract tests"
          }
        ]
      }
    ],

    // --- 危険コマンドの遮断（PreToolUse。[要検証] §0-3） ---
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/scripts/deny-dangerous-bash.sh\"",
            "timeout": 10,
            "statusMessage": "danger guard"
          }
        ]
      },
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PROJECT_DIR/scripts/deny-test-weakening.sh\"",
            "timeout": 10,
            "statusMessage": "test tamper guard"
          }
        ]
      }
    ],

    // --- サブエージェントの完了報告を信じない（verification.md の対応表） ---
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && bash scripts/assert-diff-exists.sh",
            "timeout": 30,
            "statusMessage": "subagent produced a real diff?"
          }
        ]
      }
    ],

    // --- 毎ターン、未通過ゲートを本文へ注入してコンテキスト喪失を防ぐ ---
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && node scripts/gate-status.mjs",
            "timeout": 15,
            "statusMessage": "gate status"
          }
        ]
      }
    ],

    // --- 圧縮の直前に進捗を必ず永続化する ---
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && bash scripts/snapshot-progress.sh",
            "timeout": 30,
            "statusMessage": "persist PROGRESS.md before compaction"
          }
        ]
      }
    ]
  }
}
```

`[要検証]` **PreToolUse / SubagentStop / PreCompact の実在と、PreToolUse が非0終了（exit 2）でツール呼び出しを遮断する挙動は本セッションで未確認。** 本セッションで実在を確認できたのは SessionStart / UserPromptSubmit / Notification（実 settings.json）と PostToolUse / Stop（fable-protocol hooks.md）のみ。導入前に `update-config` スキルで確認し、使えないイベントは CI（§3-4）と Stop フックへ寄せる。

#### `scripts/gate-constraints.sh` の中身（制約の機械検査）

grep ベースの安価な検査で、Sonnet の「仕様の穴を勝手に埋める」を構造的に止める。

```bash
#!/usr/bin/env bash
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}"
fail=0
say() { echo "GATE-VIOLATION $1: $2" >&2; fail=1; }

# P1: 決済SDKの直接利用は src/lib/payments/providers/ 配下だけ
if git diff --name-only --diff-filter=ACM | grep -v '^src/lib/payments/providers/' \
   | xargs -r grep -lnE "from ['\"](stripe|@paypayopa/|@stripe/stripe-js)" 2>/dev/null | grep -q .; then
  say P1 "PaymentProvider アダプタ外で決済SDKを直接 import している"
fi

# P2: Webhook ルートで req.json() を使っていない（raw body 必須）
if grep -rnE "await (req|request)\.json\(\)" src/app/api/webhooks/ 2>/dev/null | grep -q .; then
  say P2 "Webhook ルートで req.json() を使用。raw body (await request.text()) が必要"
fi

# W1/W2: webhook_events の重複排除が両方の鍵で実装されているか
if [ -d src/lib/payments ]; then
  grep -rq "on conflict" src/lib/payments src/app/api/webhooks 2>/dev/null \
    || say W1 "webhook_events への insert ... on conflict do nothing が見当たらない"
  grep -rqE "business_idempotency_key|object_id.*event_type" src/lib/payments 2>/dev/null \
    || say W2 "(data.object のID, event.type) 由来の業務冪等キーが見当たらない"
fi

# W3: 状態更新が単調前進ガード付きか
if grep -rn "status *= *'paid'" src/ 2>/dev/null | grep -qv "status_rank"; then
  say W3 "支払状態の更新に status_rank による単調前進ガードがない"
fi

# L1/L3: 運営者が資金を預かる語彙の混入を検知（設計事故の早期警報）
if git diff --diff-filter=ACM -U0 | grep -nE "^\+.*(escrow|payout_to_organizer|platform_balance|wallet_balance|user_balance|charge_top_up)" | grep -q .; then
  say L1/L3 "運営者が資金を保持する設計語彙を検出。legal-gatekeeper のレビューが必要"
fi

# N2: LIFF プロフィールをそのままサーバへ送っていないか
if grep -rnE "getProfile\(\).*fetch\(|liff\.getDecodedIDToken\(\).*(fetch|axios)" src/ 2>/dev/null | grep -q .; then
  say N2 "liff.getProfile()/getDecodedIDToken() の結果をサーバへ送信している疑い"
fi

# I3: MVP 期間中のクライアント直 DB アクセス禁止
if grep -rn "createBrowserClient\|createClientComponentClient" src/ 2>/dev/null | grep -q .; then
  say I3 "クライアントから Supabase へ直アクセスしている（MVPはサーバー経由のみ）"
fi

exit $fail
```

#### `scripts/deny-dangerous-bash.sh`（危険コマンド遮断）

```bash
#!/usr/bin/env bash
# stdin から渡されるフック入力JSONのコマンド文字列を検査し、
# 該当したら exit 2（ツール呼び出しを遮断）。[要検証: exit 2 の遮断挙動]
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
deny() { echo "BLOCKED: $1" >&2; exit 2; }

case "$cmd" in
  *"rm -rf /"*|*"rm -rf ~"*)                     deny "破壊的削除" ;;
  *"git push --force"*|*"git push -f"*)          deny "強制push（履歴破壊）" ;;
  *"git reset --hard"*)                          deny "未コミット変更の破棄" ;;
  *"supabase db reset"*)                         deny "DBリセット（人間承認が必要）" ;;
  *"vercel --prod"*|*"vercel deploy --prod"*)    deny "本番デプロイは CI 経由のみ" ;;
  *"sk_live_"*|*"rk_live_"*|*"whsec_live"*)      deny "本番決済キーの文字列を検出" ;;
  *"stripe "*"--live"*)                          deny "Stripe live モード操作" ;;
  *"PAYPAY_ENV=PROD"*|*"env: \"PROD\""*)         deny "PayPay 本番環境の指定" ;;
  *"npm publish"*)                               deny "意図しない公開" ;;
  *"pnpm "*)                                     deny "pnpm は本環境で破損（npm を使う）" ;;
esac
exit 0
```

最後の `pnpm` 遮断は §0-2 の実測に基づく。破損した pnpm を叩いて謎のエラーに時間を溶かす事故を先回りで止める。

#### `scripts/deny-test-weakening.sh`（テスト改変の遮断）

```bash
#!/usr/bin/env bash
# テストファイルから it/test/expect を「減らす」編集を遮断する。
# 増やす編集・新規追加は通す。
input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')
case "$path" in
  *".test.ts"|*".test.tsx"|*".spec.ts"|*"/tests/"*|*"/e2e/"*) ;;
  *) exit 0 ;;
esac
[ -f "$path" ] || exit 0
before=$(grep -cE "^\s*(it|test)\(|expect\(" "$path" 2>/dev/null || echo 0)
new=$(printf '%s' "$input" | jq -r '.tool_input.new_string // .tool_input.content // ""')
old=$(printf '%s' "$input" | jq -r '.tool_input.old_string // ""')
d_old=$(printf '%s' "$old" | grep -cE "^\s*(it|test)\(|expect\(" || echo 0)
d_new=$(printf '%s' "$new" | grep -cE "^\s*(it|test)\(|expect\(" || echo 0)
if [ "$d_new" -lt "$d_old" ]; then
  echo "BLOCKED: テストの it/expect を削減する編集です（before=$before, -$d_old/+$d_new）。" >&2
  echo "テストが誤っていると判断した場合は編集せず BLOCKED で報告してください（verification.md）。" >&2
  exit 2
fi
# .skip / .todo / .only の追加も遮断
if printf '%s' "$new" | grep -qE "\.(skip|todo|only)\("; then
  echo "BLOCKED: テストの skip/todo/only を追加する編集です。" >&2
  exit 2
fi
exit 0
```

#### `scripts/assert-diff-exists.sh`（サブエージェントの完了報告を信じない）

```bash
#!/usr/bin/env bash
cd "${CLAUDE_PROJECT_DIR:-.}"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "WARN: サブエージェントは完了を報告しましたが、作業ツリーに差分がありません。" >&2
  echo "「サブエージェントが完了した」の証拠は VCS diff です（verification.md 対応表）。" >&2
  echo "成果物の実体を確認するか、NEEDS_CONTEXT として扱ってください。" >&2
fi
exit 0   # 警告のみ。調査専任エージェントは差分ゼロが正常なため遮断しない
```

### 3-2. (b) `.claude/agents/*.md` の割当

#### 既存エージェントの利用（プロジェクト側で `model:` を明示して固定する）

| エージェント | 割当モデル | 用途 | 本プロジェクト固有の追記 |
|---|---|---|---|
| `requirement-analyzer` | opus | 受取先方式ごとの要件差分 | 「3つの条件（参加者別検知/受取先/幹事の非事業者性）のどれを落とすか」を必ず明示させる |
| `task-decomposer` | opus | task-list.json 生成 | 各タスクに constraint_ids を必須付与 |
| `technical-designer` | opus | PaymentProvider IF・DB設計 | 制約 P1-P9 / W1-W12 を設計書に転記させる |
| `task-executor` | sonnet | 実装 | タスクファイル外の判断は `NEEDS_CONTEXT` |
| `task-executor-frontend` | sonnet | LIFF/UI 実装 | N1-N12 を必ず参照 |
| `quality-fixer` / `-frontend` | sonnet | 型/lint/test の修復 | テスト改変禁止を明記 |
| `acceptance-test-generator` | sonnet | 受入テスト生成 | **実装を読ませない**（仕様のみ入力） |
| `code-reviewer` | opus | 設計適合判定 | 事実主張の反証は担当外と明記 |
| `verifier` / `code-verifier` | opus | 5ステップゲートの照合 | 「走った≠通った」検出を明示 |
| `integration-test-reviewer` | sonnet | L3 統合テストの妥当性 | stripe listen / PayPay STAGING の実行証跡を要求 |
| `investigator` | opus | 収集物の統合 | 逐語引用のない主張を落とす |
| `solver` | opus | 2回失敗したバグの打開 | debugging.md 参照を必須化 |
| `document-reviewer` | sonnet | ADR/ランブックの整合 | — |
| `serena-expert` | sonnet | 大規模リファクタ時の記号操作 | Serena MCP 経由 |

#### 新規作成するエージェント（6本）

**`.claude/agents/adversarial-reviewer-gemini.md`**
```yaml
---
name: adversarial-reviewer-gemini
description: Claude が書いた diff を Gemini 3.8 Flash に敵対的レビューさせる。一次資料の再フェッチを必須とし、逐語引用のない判定を無効票にする。PR レビュー時に使用。
tools: Bash, Read, Grep, mcp__gemini-cli__ask-gemini
model: sonnet   # このエージェント自身は薄いブリッジ。判断は Gemini 側が行う
---
1. `bash scripts/build-review-packet.sh $PR` でレビューパケットを生成する。
2. `mcp__gemini-cli__ask-gemini` に §2-4 の敵対レビューA プロンプトとパケットを渡す。
   MCP が失敗したら `gemini -p "<プロンプト>" < /tmp/review-packet.json` にフォールバックし、
   どちらの経路を使ったかを出力に必ず記録する。
3. 返ってきた JSON をスキーマ検証する（`node scripts/validate-findings.mjs`）。
   スキーマ不一致・逐語引用なし・fetched:false が半数超 → 「無効票」として再実行を1回だけ行う。
4. 結果を `reviews/pr-$PR/gemini.json` へ書き出し、要約だけを本文で返す。
禁止: 自分（Claude）の判断で findings を追加・削除・加筆すること。ブリッジに徹する。
```

**`.claude/agents/adversarial-reviewer-gpt.md`**
```yaml
---
name: adversarial-reviewer-gpt
description: Claude が書いた diff を GPT-6 Astla に反例提示型でレビューさせる。codex CLI 経由（codex MCP は接続不可）。
tools: Bash, Read, Grep
model: sonnet
---
1. `bash scripts/build-review-packet.sh $PR`。
2. `codex exec --model gpt-6-astla "<§2-4 敵対レビューB のプロンプト>" < /tmp/review-packet.json`
   （codex CLI の正確なサブコマンドとモデル指定フラグは未検証。初回は `codex --help` で確認し、
    確認できた形を `docs/runbooks/RB-07-model-routes.md` に記録する）
3. 非ゼロ終了・タイムアウト（180秒）なら §7-5 の代替経路へ。
4. `reviews/pr-$PR/gpt.json` へ書き出し、要約を返す。
禁止: findings の加筆。反例を書けなかった項目を PASS に昇格させること。
```

**`.claude/agents/payment-contract-guard.md`**
```yaml
---
name: payment-contract-guard
description: diff が P1-P9 / W1-W12 / N1-N12 / I1-I6 の制約に違反していないかを機械的に検査する。実装後・PR前に必ず実行。
tools: Bash, Read, Grep, Glob
model: sonnet
---
`bash scripts/gate-constraints.sh` を実行し、加えて grep では取れない次を目視確認する:
- PaymentProvider の4メソッド（createCheckout / parseWebhook / getPaymentStatus / refund）の
  シグネチャが `docs/design/payment-provider.md` と一致しているか（P1）
- returnUrl が必須引数になっているか（P4）
- 「支払済み（決済完了）」と「幹事への入金予定」が別カラム・別表示になっているか（P6）
- refund が未対応事業者で NotSupportedError を投げるか（P7）
出力は違反した制約IDの配列のみ。違反ゼロなら "PASS"。推測で PASS にしない。
```

**`.claude/agents/legal-gatekeeper.md`**
```yaml
---
name: legal-gatekeeper
description: 資金フローに影響する変更を検知し、L1-L12 に照らして弁護士エスカレーションの要否を判定する。DBスキーマ・決済設定・利用規約の変更時に必ず実行。
tools: Read, Grep, Glob, Bash
model: opus
---
判定対象:
- 資金が運営者名義の口座・決済アカウントを経由する経路が生まれていないか（L1）
- 立替精算モード（後払い）の実装が入っていないか（L2）
- アプリ内残高・チャージ・ポイント・ウォレットのテーブル/フィールドが増えていないか（L3）
- 返金原資を運営者が保持する設計になっていないか（L4）
- カード番号がアプリのサーバへ渡る経路がないか（L8）
- 幹事をサブ加盟店として運営者が審査・契約する処理がないか（L9）
1件でも該当 → 出力の先頭に `BLOCKED: 弁護士確認が必要` と書き、
`docs/inquiries/legal-YYYYMMDD.md` に照会文の草案を生成する。
本番決済の有効化は、弁護士確認またはグレーゾーン解消制度の回答なしに承認しない（L11）。
```

**`.claude/agents/release-auditor.md`**
```yaml
---
name: release-auditor
description: リリース候補の全体監査。Opus/Gemini/GPT の3者独立監査のうち Claude 側の1票を担当する。
tools: Read, Grep, Glob, Bash
model: opus
---
チェック順（この順で、飛ばさない）:
1. docs/acceptance-checks.json の全 check が status:"passed" かつ evidence を持つか
2. その evidence が今回のリリース候補コミットで再実行された出力か（古い証拠を弾く）
3. L1-L12 のうち、このリリースで新たに関係するものの判定が ADR に残っているか
4. 決済は test/STAGING キーのみが Production 以外に設定されているか
5. ランブック（RB-01〜RB-06）が今回の変更で陳腐化していないか
6. ロールバック手順が実際に実行可能か（コマンドを書き出す）
出力: go / no-go と、no-go の場合の具体的な差し戻し先タスクID。
```

**`.claude/agents/premortem-facilitator.md`**
```yaml
---
name: premortem-facilitator
description: 「このプロジェクトは6か月後に失敗した。何が起きたか」を起案し、GPT/Gemini に反証させ、出たリスクをタスク化する。設計変更時・スプリント開始時・受取先方式の決定時に実行。
tools: Read, Write, Bash, Grep, Glob
model: opus
---
1. 前回の scratchpad/premortem/ の最新版を読み、未対応リスクを引き継ぐ。
2. 新規リスクを起案する（最低10件。技術/規約/法務/市場/運用の5カテゴリ各2件以上）。
3. 各リスクを GPT-6 Astla（codex exec）へ渡し「このリスクが起きない理由」を書かせる。
   反論できたリスクは severity を下げ、反論できなかったリスクは上げる。
4. 各リスクを Gemini 3.8 Flash へ渡し、一次資料で裏取りできるものを確認させる。
5. severity:high のリスクを docs/task-list.json へ mitigation タスクとして自動追加する。
6. scratchpad/premortem/premortem-YYYYMMDD.md に全文を保存する。
```

### 3-3. (c) Workflow スクリプト

`~/.claude/workflows/` は未作成（`local-context.md` 実測）。プロジェクト側 `.claude/workflows/` に3本置く。
**`agent()` / `parallel()` / `pipeline()` の正確なシグネチャは未確認。以下は疑似コードであり、実装前に `workflow-authoring` スキルを読むこと（§0-3）。**

#### `implement-review-verify-fix.ts` — 1タスクを回す基本ループ

```
入力: taskId（docs/task-list.json の1件）
出力: 4値ステータス（DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT）

step 0  preflight:
          - docs/task-list.json から taskId を読む
          - depends_on が全て status:"done" でなければ → BLOCKED("依存未完")
          - constraint_ids が空なら → BLOCKED("制約未割当。タスク分解の欠陥")

step 1  spec-first tests   agent("acceptance-test-generator", model=sonnet)
          入力: 受入基準のみ（実装は渡さない）
          出力: 失敗するテスト（この時点で赤いことを確認。緑なら仕様が既存実装に汚染されている）

step 2  implement          agent("task-executor", model=sonnet)
          入力: タスクファイル + 制約テキスト + step1 のテスト
          PostToolUse フックが型/lint/制約ゲートを毎編集で走らせる

step 3  self-quality       agent("quality-fixer", model=sonnet)
          全Phase緑になるまで。テスト改変は PreToolUse が遮断する

step 4  parallel:                       ← ここが T2 の要。3者を同時に走らせる
          a) agent("code-reviewer",           model=opus)     設計適合
          b) agent("adversarial-reviewer-gemini")             規約・一次資料
          c) agent("adversarial-reviewer-gpt")                反例提示
          d) agent("payment-contract-guard",  model=sonnet)   制約の機械検査
          e) agent("legal-gatekeeper",        model=opus)     ※資金フロー変更を含む時のみ

step 5  merge-verdict      scripts/merge-review.sh
          high が1件でも → step 6 へ（ループ）
          medium → acceptance-checks に追記して step 6 へ
          e) が BLOCKED → 即終了。人間（弁護士）へエスカレーション

step 6  fix                agent("quality-fixer", model=sonnet)
          入力: findings の repro（反例）をそのままテストケース化してから直す
          step 4 へ戻る。**最大3周**。3周で high が消えなければ BLOCKED("レビュー収束せず")

step 7  final verify       agent("verifier", model=opus)
          5ステップゲート（IDENTIFY/RUN/READ/VERIFY/CLAIM）を実行し、
          acceptance-checks.json の該当 check に evidence（コマンド+出力+終了コード）を書き込む

step 8  status             DONE / DONE_WITH_CONCERNS のいずれかを返す
          docs/PROGRESS.md に1行追記
```

**ループ上限を3周に固定する理由**: 収束しないレビューループは、コストが線形に増える一方で成果が出ない典型的な暴走モード（§7-7）。3周で止めて人間に返すほうが安い。

#### `premortem.ts` — プレモータムの実行と再実行

```
トリガー: (1) スプリント開始時 (2) 受取先方式の決定/変更時
          (3) 決済事業者からの回答受領時 (4) 前回から30日経過時

step 1  agent("premortem-facilitator", model=opus)  リスク起案（前回分を引き継ぐ）
step 2  parallel:
          - GPT-6 Astla に各リスクの反証を書かせる
          - Gemini 3.8 Flash に一次資料での裏取りをさせる
step 3  severity 再計算 → high を docs/task-list.json へ mitigation タスクとして追加
step 4  前回 high のうち未対応が3件以上残っていたら
        → 実装タスクの新規着手を止め、mitigation を先に消化する（ゲート）
step 5  scratchpad/premortem/premortem-YYYYMMDD.md を書き出す
```

#### `release-audit.ts` — リリース前監査

```
step 1  parallel（3者独立・互いの出力を見せない）:
          a) agent("release-auditor", model=opus)
          b) Gemini 3.8 Flash に同じチェックリストを渡す
          c) GPT-6 Astla に同じチェックリストを渡す
step 2  3者の go/no-go を突き合わせる
          全会一致 go → PO へ「承認可」と報告（自動リリースはしない）
          1者でも no-go → 差分理由を Opus が裁定し ADR に記録 → PO 判断へ
step 3  L11 チェック: 本番決済の有効化を含むリリースなら、
        弁護士確認またはグレーゾーン解消制度の回答の有無を確認。
        なければ無条件で no-go
step 4  ロールバック手順を実コマンドとして出力し、docs/runbooks/RB-06 を更新
```

### 3-4. (d) CI（GitHub Actions）

ローカルのフックは「自分で気づく」ための仕組み、CI は「通さない」ための仕組み。両方要る。gh CLI は認証済み（`local-context.md`）。

`.github/workflows/gate.yml`

```yaml
name: quality-gate
on:
  pull_request:
  push: { branches: [main] }

concurrency:
  group: gate-${{ github.ref }}
  cancel-in-progress: true

jobs:
  # ---- L0/L1: 型・lint・単体。最速で落とす ----
  static:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.22.0', cache: 'npm' }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx eslint . --max-warnings=0
      - run: npm run test:unit -- --coverage
      - name: 制約ゲート（L/P/W/N/I）
        run: bash scripts/gate-constraints.sh

  # ---- L2: 契約テスト。この3本が T2 の必須ゲート ----
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.22.0', cache: 'npm' }
      - run: npm ci
      - name: Webhook 契約テスト（重複・逆順・署名不一致）
        run: npm run test:contract
        # consolidated.md I5:「最初に書くテストは重複・逆順・署名不一致の3本」

  # ---- L3: 統合。Supabase ローカル + Stripe CLI ----
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22.22.0', cache: 'npm' }
      - run: npm ci
      - uses: supabase/setup-cli@v1
      - run: supabase start
      - run: supabase db push
      - name: Stripe CLI で Webhook を実送信
        env: { STRIPE_API_KEY: ${{ secrets.STRIPE_TEST_KEY }} }
        run: |
          npm run build && npm run start &
          npx wait-on http://localhost:3000/api/health
          stripe listen --forward-to localhost:3000/api/webhooks/stripe --print-secret > /tmp/whsec &
          sleep 5
          stripe trigger checkout.session.completed
          stripe trigger checkout.session.completed   # 二重送信で冪等性を実測
          npm run test:integration

  # ---- 秘密情報とキー種別の検査 ----
  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: 本番キーの混入検査
        run: |
          if git grep -nE "sk_live_|rk_live_|whsec_[A-Za-z0-9]{32,}" -- . ':!*.md'; then
            echo "本番キーがコミットされています"; exit 1; fi
      - uses: gitleaks/gitleaks-action@v2

  # ---- 敵対レビュー。PR にのみ走らせる ----
  adversarial:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    needs: [static, contract]
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - run: bash scripts/build-review-packet.sh ${{ github.event.number }}
      - name: Gemini 敵対レビュー
        env: { GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }} }
        run: node scripts/review-gemini.mjs /tmp/review-packet.json > reviews/gemini.json
        continue-on-error: true       # 落ちても CI は止めず、下の集計で "UNKNOWN" として扱う
      - name: GPT 敵対レビュー
        env: { OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }} }
        run: node scripts/review-gpt.mjs /tmp/review-packet.json > reviews/gpt.json
        continue-on-error: true
      - name: 集計とゲート判定
        run: bash scripts/merge-review.sh   # high が1件でもあれば exit 1
      - uses: actions/github-script@v7      # findings を PR コメントとして残す
        with:
          script: |
            const fs=require('fs');
            const v=JSON.parse(fs.readFileSync('reviews/verdict.json','utf8'));
            await github.rest.issues.createComment({...context.repo, issue_number: context.issue.number,
              body: '## 敵対レビュー結果\n\n'+v.markdown});

  # ---- acceptance-checks の充足をゲート化 ----
  acceptance:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    needs: [static, contract, integration]
    steps:
      - uses: actions/checkout@v4
      - run: node scripts/assert-acceptance.mjs --pr ${{ github.event.number }}
        # この PR の task_ids に紐づく check が全て passed かつ
        # evidence.commit が HEAD と一致することを検査する
```

**ブランチ保護**: `main` に対し `static` / `contract` / `secrets` / `adversarial` / `acceptance` を required status checks に設定し、直 push を禁止する。

**E2E（L4）は別ワークフロー**（`e2e.yml`、nightly + リリース前のみ）。Playwright + `@line/liff-mock` は遅いので PR 毎には回さない。

### 3-5. (e) `docs/task-list.json` と `docs/acceptance-checks.json` をゲートとして機械的に使う

`plan` スキルが生成する3点セット（`implementation-plan.md` / `task-list.json` / `acceptance-checks.json`）を、**読み物ではなく実行可能なゲート**として使う。本プロジェクト用に必須フィールドを追加する。

#### `docs/task-list.json`

```jsonc
{
  "version": 2,
  "generated_at": "2026-09-24T00:00:00+09:00",
  "tasks": [
    {
      "id": "T-013",
      "title": "PaymentProvider.parseWebhook を raw body + Headers で実装する",
      "status": "todo",                    // todo | in_progress | done | blocked | needs_context
      "owner_model": "sonnet",             // 誰に割り当てるか（機械が agent を選ぶ）
      "agent": "task-executor",
      "depends_on": ["T-011", "T-012"],
      "constraint_ids": ["P1", "P2", "W1", "W2", "W5", "W6"],   // 必須。空ならゲートで弾く
      "acceptance_check_ids": ["AC-031", "AC-032", "AC-033"],   // 必須
      "gate_level": "contract",            // static | contract | integration | e2e
      "decision_dependency": null,         // 例: "ADR-003"（決済事業者の決定待ちなら埋める）
      "adversarial_review": "required",    // required | skip（決済/法務に触れるものは required 固定）
      "completion_status": null,           // DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
      "concerns": []
    }
  ]
}
```

#### `docs/acceptance-checks.json`

```jsonc
{
  "version": 2,
  "checks": [
    {
      "id": "AC-031",
      "task_id": "T-013",
      "statement": "同一 event_id の Webhook を2回送っても支払記録が1件のままである",
      "verify_command": "npm run test:contract -- -t 'duplicate event_id'",
      "expected": "exit 0, failures=0",
      "status": "pending",                 // pending | passed | failed
      "evidence": null                     // 下の形で verifier が埋める
      // "evidence": {
      //   "command": "npm run test:contract -- -t 'duplicate event_id'",
      //   "exit_code": 0,
      //   "stdout_tail": "Tests  3 passed (3)",
      //   "commit": "a1b2c3d",
      //   "ran_at": "2026-09-25T10:03:11+09:00",
      //   "by": "verifier(opus)"
      // }
    }
  ]
}
```

#### 機械的な使い方（4箇所）

1. **UserPromptSubmit フック** — `scripts/gate-status.mjs` が毎ターン、未通過 check の件数と直近の BLOCKED タスクを本文へ注入する。コンテキスト喪失（§7-4）への直接の対策。
2. **PostToolUse フック** — `scripts/validate-plan-json.mjs` が両ファイルのスキーマを検証する。`constraint_ids` が空、`acceptance_check_ids` が空、`status:"done"` なのに evidence が null、といった**自己矛盾を編集直後に検出**する。
3. **CI の `acceptance` ジョブ** — `scripts/assert-acceptance.mjs` が、PR に含まれるタスクの check が全て `passed` かつ `evidence.commit == HEAD` であることを検査する。**古い実行結果を証拠として使い回すこと（過大申告の主要経路）をここで潰す。**
4. **完了宣言の条件** — `completion_status: "DONE"` を書けるのは、紐づく全 check が `passed` かつ evidence が HEAD で取られている時だけ。それ以外は 4値の残り3つを選ぶ（§4）。

```javascript
// scripts/assert-acceptance.mjs（骨子）
import fs from 'node:fs'; import cp from 'node:child_process';
const head = cp.execSync('git rev-parse --short HEAD').toString().trim();
const tasks = JSON.parse(fs.readFileSync('docs/task-list.json','utf8')).tasks;
const checks = JSON.parse(fs.readFileSync('docs/acceptance-checks.json','utf8')).checks;
const touched = cp.execSync(`git diff --name-only origin/main...HEAD`).toString().split('\n');
const prTasks = tasks.filter(t => t.status === 'done' || t.completion_status);
let bad = [];
for (const t of prTasks) {
  if (!t.constraint_ids?.length) bad.push(`${t.id}: constraint_ids が空`);
  if (t.completion_status === 'DONE') {
    for (const id of t.acceptance_check_ids) {
      const c = checks.find(x => x.id === id);
      if (!c)                          bad.push(`${t.id}: check ${id} が存在しない`);
      else if (c.status !== 'passed')  bad.push(`${t.id}: ${id} が ${c.status}`);
      else if (!c.evidence)            bad.push(`${t.id}: ${id} に evidence がない`);
      else if (c.evidence.commit !== head)
        bad.push(`${t.id}: ${id} の evidence は ${c.evidence.commit} で取得（HEAD=${head}）。再実行が必要`);
      else if (c.evidence.exit_code !== 0)
        bad.push(`${t.id}: ${id} の evidence の exit_code が ${c.evidence.exit_code}`);
    }
  }
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log(`OK: ${prTasks.length} tasks, evidence at ${head}`);
```

---

## 4. タスク実行ループの手順書（1タスクの開始から完了宣言まで）

fable-protocol の **4値完了ステータス** と **完了前5ステップゲート** を組み込んだ、そのまま実行できる手順。

### 手順

**S0. 着手判定（オーケストレーター [Opus5.5]）**
1. `docs/task-list.json` から対象タスクを読む。
2. `depends_on` が全て `done` か確認する。違えば `BLOCKED("依存 T-0xx 未完")` で即終了。
3. `decision_dependency` が埋まっていて、その ADR が `status: decided` でなければ `BLOCKED("ADR-00x 未決")`。
   — 例: 決済事業者未確定のまま Stripe 固有の実装をするタスクはここで止まる。
4. `constraint_ids` / `acceptance_check_ids` が空なら `NEEDS_CONTEXT("タスク分解が不完全")` で task-decomposer へ差し戻す。

**S1. STICK リスト作成（[Opus5.5]）**
5. タスクの要求を **YES/NO で答えられる質問のリスト**に分解する（verification.md の STICK）。
   例: 「raw body を使っているか？」「event_id の一意制約があるか？」「業務冪等キーがあるか？」「2xx を先に返しているか？」
6. リストを `docs/task-list.json` の当該タスクに `stick[]` として保持する。

**S2. 仕様先行テスト（[Sonnet] `acceptance-test-generator`）**
7. **受入基準だけを入力**してテストを書かせる（実装を見せない。AgentCoder パターン）。
8. 書いたテストを実行し、**赤いことを確認する**。緑なら仕様が既存実装に汚染されているので S1 へ戻る。

**S3. 実装（[Sonnet] `task-executor`）**
9. タスクファイル + 制約テキスト + S2 のテストを渡す。
10. 編集のたびに PostToolUse フックが tsc / eslint / `gate-constraints.sh` を走らせる。**壊れたまま次の編集に進めない。**
11. タスクファイルに書かれていない判断が必要になったら、**推測で埋めずに `NEEDS_CONTEXT` で返す**。

**S4. 自陣品質（[Sonnet] `quality-fixer`）**
12. 型/lint/テストが全部緑になるまで直す。
13. **テストを弱める編集は PreToolUse が遮断する。** 遮断されたら `BLOCKED("テストが誤っている疑い")` で人間へ報告する。テストを直して通すのは禁止。

**S5. 4者並列レビュー**
14. `code-reviewer`[Opus] / `adversarial-reviewer-gemini`[G-Flash] / `adversarial-reviewer-gpt`[GPT6] / `payment-contract-guard`[Sonnet] を同時に走らせる。資金フローに触れるなら `legal-gatekeeper`[Opus] も。
15. `scripts/merge-review.sh` で集計する。
    - `high` あり → S6 へ（最大3周）
    - `legal-gatekeeper` が BLOCKED → **ループを回さず即終了**。人間（弁護士）へ。
    - `UNKNOWN` が20%超 → レビュー無効。再実行。

**S6. 修正（[Sonnet] `quality-fixer`）**
16. **findings の `repro`（反例）を先にテストケースへ変換してから**直す。指摘を「直したつもり」で閉じさせない。
17. S5 へ戻る。3周で `high` が消えなければ `BLOCKED("レビュー収束せず")`。

**S7. 完了前5ステップゲート（[Opus5.5] `verifier`）** — ここを飛ばしたら完了宣言は無効
18. **IDENTIFY** — 各 acceptance check の `verify_command` を特定する（推測で作らない。`docs/acceptance-checks.json` に書かれているものを使う）。
19. **RUN** — 今、フレッシュに、全量実行する。**過去のターン・過去のセッションの実行結果は使わない。**
20. **READ** — 出力全文と終了コードを読む。failures 数・skipped 数を数える。
21. **VERIFY** — 出力が主張を裏付けているか照合する（「テストが走った」≠「テストが通った」）。
22. **CLAIM** — `acceptance-checks.json` の該当 check に `evidence`（command / exit_code / stdout_tail / commit / ran_at / by）を書き込む。
23. S1 の STICK リストを再採点する。**NO が1つでも残っていれば未完了。** S3 へ戻る。

**S8. 完了ステータスの決定（4値。「だいたい完了」は存在しない）**

| ステータス | 選ぶ条件 | 必ず書くこと |
|---|---|---|
| `DONE` | 全 check が passed、evidence が HEAD で取得済み、STICK 全 YES、レビュー high ゼロ、テストが同一 diff に含まれる | 実行したコマンドと出力の要点 |
| `DONE_WITH_CONCERNS` | 上記を満たすが懸念が残る（例: PayPay STAGING でしか確認できていない、未検証の手数料前提に依存） | **各懸念に severity と対応案**。懸念は `docs/task-list.json` の `concerns[]` と、必要なら新規タスクへ |
| `BLOCKED` | 依存未完 / ADR 未決 / レビュー収束せず / テスト改変を要求された / 外部回答待ち | **何にブロックされ、何を試したか** |
| `NEEDS_CONTEXT` | タスクファイルにない判断が必要 / 制約が割り当てられていない / 決済事業者の仕様が不明 | **不足している情報を具体的に名指し** |

**S9. 記録**
24. `docs/PROGRESS.md` に1行追記（日付 / タスクID / ステータス / 証拠のコミットSHA / 次の一手）。
25. 設計判断が発生していたら `docs/decisions/ADR-XXX.md` を書く。
26. PR を作る。CI の required checks が全部緑になって初めてマージ可。

### 禁止事項（この手順の中で絶対にやらない）

- 過去の実行結果を evidence として使い回す
- テストを編集・skip・削除して通す
- レビュー findings を「対応済み」と書くだけで閉じる（反例のテスト化が必須）
- `DONE` と `DONE_WITH_CONCERNS` の中間を発明する
- 自己申告・スクリーンショットを検証済み入金として扱う（引継ぎ書 §4-1 の禁止事項を実装にも適用）

---

## 5. 外部人間の役割と関与タイミング

| 役割 | 誰 | 何を出してもらうか | 関与タイミング | 関与しないとどうなるか | リードタイム |
|---|---|---|---|---|---|
| **弁護士（資金決済法・フィンテック）** | 外部顧問 | `consolidated.md` §5-4 の質問1〜11への回答。特に (a) 2条の2柱書「他の者に受け入れさせ」の射程、(b) 内閣府令1条の2第3号ロ「契約の成立に不可欠な関与」、(c) **第3号ニ（銀行等・資金移動業者からの委託）に乗る構成の可否** | **週0で着手。本番決済の有効化前に必ず完了（制約 L11）。** 設計の骨格が変わるので、受取先方式の決定前に (a)(c) だけでも先に取る | 無登録で為替取引を業として行うと銀行法4条1項違反（`consolidated.md` §4-1、確信度 低・未検証） | 不明。初回面談まで1〜2週間を見込む |
| **金融庁 グレーゾーン解消制度 / フィンテックサポートデスク** | 行政 | 照会書への回答 | 弁護士の助言を受けてから提出。回答は本番前ゲートの根拠として使う | 弁護士判断のみでの本番化はリスク集中 | 不明（制度上の標準処理期間を要確認） |
| **税理士** | 外部顧問 | 決済手数料・売上計上の扱い、幹事が個人事業主になる場合の助言、NonTurn LLC 側の収益計上 | 収益モデル（手数料を誰が負担するか）の決定時。MVP のクリティカルパスではない | 後戻りする | 不明 |
| **PayPay 加盟店窓口 / 営業担当** | 決済事業者 | `consolidated.md` §5-1 の質問1〜8。**最優先は Q1「会費徴収は取扱可能商材か」** | **週0。これ1本で候補A（PayPayオンライン加盟店）の go/no-go が決まる。** 並行して STAGING で実装検証は始められる | 決済事業者の第一候補が確定しない。アダプタ層より先へ進めない | 審査は2週間〜1カ月＋5営業日（確信度 低・未検証） |
| **Stripe サポート（`payment_apis` 窓口）／営業** | 決済事業者 | §5-2 の質問1〜6。**最優先は Q2「日本の『Connect 外での C2C サービス』の定義」と Q3「PayPay×Connect の記載矛盾」** | 週0〜1。候補B の go/no-go | 「日本ではConnect必須」と「PayPayはConnect非対応」が同時に成り立つなら Stripe+PayPay は塞がっている（§1 論点3）。ここを確かめずに実装すると全損 | 不明 |
| **LINEヤフー ミニアプリ審査窓口** | 配布プラットフォーム | §5-3 の質問1〜7。**最優先は Q1「会費集金は禁止業種『募金、寄附、クラウドファンディング』に当たるか」** | 未認証でMVPは出せる（§1 論点6）ので、**認証審査が必要になる機能（サービスメッセージ＝催促、LINE内検索）を作る前** | 認証審査で差し戻され、催促機能が作り直しになる | 認証審査1〜2週間（確信度 低・未検証） |
| **パイロット幹事（3〜5名）** | 実ユーザー | 実際の飲み会1回を通した利用。受取までの体感、手数料負担の受容度、**「決済完了」と「入金」が別であることへの納得** | **ステージング完成直後、本番決済の前。** 実決済は使わず、サンドボックス＋当日は従来手段を併用してもらう | 「幹事に満額がすぐ入る」という期待値の破綻を本番で発見することになる（§1 論点5） | 飲み会1回分＝2〜3週間 |
| **デザイン** | 社内（NonTurn） | 幹事画面の「支払済み / 入金予定」の2ステータス表現、参加者の支払い導線、LINE内での戻り導線（制約 P4） | 設計確定後・実装前。**「支払済み＝入金済み」と読める画面を作らせない**ことが最大の役割 | 誤解を生むUIは規約リスクではなく信頼リスクに直結する | 社内調整 |
| **Vercel / Supabase サポート** | インフラ | Supabase 東京リージョンの可用性・料金（§5-5 の未確認事項）、Vercel Pro の cron 分単位実行 | インフラ確定時（週1） | reconciliation の遅延許容度が決まらない（制約 I2） | 不明 |

**関与の原則**: 外部回答待ちは `BLOCKED` の正当な理由だが、**待っている間に止まる作業と止まらない作業を分ける**。`consolidated.md` の指示通り、PaymentProvider アダプタ層・名簿/イベント管理・Webhook冪等基盤の3つは決済事業者が変わっても捨てずに済むので、照会の回答を待たずに作る。

---

## 6. コミュニケーションと引継ぎ

### 6-1. 文書の役割分担（重複させない）

| ファイル | 役割 | 更新者 | 更新頻度 |
|---|---|---|---|
| `docs/PROGRESS.md` | **時系列の追記ログ**。1行1イベント。書き換えない | 全エージェント（追記のみ） | タスク完了ごと |
| `docs/HANDOFF.md` | **現在地のスナップショット**。常に全文を書き換える | オーケストレーター | セッション終了時 / コンテキスト圧縮前（PreCompact フック） |
| `docs/decisions/ADR-XXX.md` | **1決定1ファイル**。決めた理由と、覆す条件 | Opus5.5 が起案、PO が承認 | 決定ごと |
| `docs/task-list.json` | 機械が読むタスク状態 | task-decomposer / verifier | タスク状態変化ごと |
| `docs/acceptance-checks.json` | 機械が読む合格条件と証拠 | acceptance-test-generator / verifier | 検証ごと |
| `docs/inquiries/*.md` | 外部照会の質問と回答（逐語） | Opus5.5 起案、PO が回答を貼る | 照会ごと |
| `docs/runbooks/RB-XX-*.md` | 障害時の手順 | Sonnet が起案、人間が承認 | 障害・変更ごと |
| `docs/constraints.json` | L/P/W/N/I 制約の機械可読版 | Opus5.5 | 制約追加時 |
| `scratchpad/premortem/*.md` | プレモータムの履歴 | premortem-facilitator | 月次 + トリガー時 |

### 6-2. `docs/HANDOFF.md` のテンプレート（固定）

```markdown
# HANDOFF — 最終更新 YYYY-MM-DD HH:MM JST / 更新者 <model>

## 1. いま何が決まっていて、何が決まっていないか
- 決定済み: ADR-001（LINEミニアプリで配布）, ADR-003（...）
- 未決定・ブロッカー: 受取先方式（PayPay 商材照会の回答待ち。2026-09-24 送信）

## 2. 動くもの / 動かないもの（証拠つき）
- 動く: PaymentProvider IF + モックアダプタ。`npm run test:contract` → 12 passed（commit a1b2c3d, 2026-09-30）
- 動かない: PayPay 実アダプタ（STAGING キー未取得）

## 3. 未通過ゲート
- AC-041（Webhook 逆順） status:failed — 原因: status_rank 未実装
- legal-gatekeeper: BLOCKED（返金フローが L4 に抵触の疑い）

## 4. 直近3件の 4値ステータス
- T-013 DONE (a1b2c3d)
- T-014 DONE_WITH_CONCERNS（PayPay は STAGING でしか未確認 / severity: medium）
- T-015 BLOCKED（ADR-003 未決）

## 5. 次にやること（1手だけ）
- T-016: status_rank の単調前進ガードを実装する

## 6. 触ってはいけないもの
- `src/lib/payments/providers/` 配下は P1 の境界。ここ以外から決済SDKを import しない
- 本番キーは Vercel Production 環境変数のみ。ローカルに置かない
```

### 6-3. ADR テンプレート（固定）

```markdown
# ADR-003: 受取先を幹事の決済アカウントにする
- Status: proposed | decided | superseded-by ADR-00X
- Date: 2026-XX-XX  / Decider: noritaka(PO)
- 関連制約: L1, L2, P5, P6

## 決定
（1文）

## 理由（根拠のURLと取得日つき。取得していないURLは引用しない）

## 検討した代替と、採らなかった理由
（consolidated.md §7-3 の代替1〜4のどれに当たるかを明記）

## この決定を覆す条件（重要）
- PayPay から「会費徴収は NG 商材」と回答があった場合
- 弁護士が第3号ニの構成を可と判断した場合

## 影響を受けるタスク
T-013, T-021, T-030
```

### 6-4. モデル間の受け渡しフォーマット

**原則: モデル間は自然言語で渡さない。JSON か、固定見出しの Markdown で渡す。** 自然言語の要約は、渡すたびに情報が劣化し、劣化したことが検出できない。

| 経路 | フォーマット | 検証 |
|---|---|---|
| Opus → Sonnet（実装依頼） | タスクファイル（自己完結。ファイル名・IF・制約ID・受入基準・スコープ外を名指し） | `validate-plan-json.mjs` |
| Sonnet → 各レビュアー | `/tmp/review-packet.json`（§2-4） | スキーマ検証 |
| Gemini/GPT → 集計 | findings JSON（§2-4 のスキーマ） | `validate-findings.mjs`。不一致は無効票 |
| 各エージェント → verifier | acceptance check の evidence オブジェクト | `assert-acceptance.mjs` |
| セッション → 次セッション | `HANDOFF.md`（§6-2 の6見出し固定） | PreCompact フックで強制永続化 |
| サブエージェント指示の末尾 | `fable-protocol/references/subagent-snippet.md` を貼る（結論先行 / 即行動 / 進捗の実証 / スコープ規律 / ターン終了規律 / 境界） | — |

**Gemini / GPT へ渡す時の追加規律**: 彼らは本プロジェクトの文脈を持たない。プロンプトに**制約の全文を毎回同梱する**（IDだけ渡さない）。ID だけ渡すと「P2 とは何か」を彼らが推測で埋め、それが finding の質を静かに下げる。

---

## 7. ハーネス自体の失敗モードと対策

ハーネスを入れると、ハーネス固有の壊れ方が増える。先回りして対策を置く。

### 7-1. 幻覚API（存在しないエンドポイント・フラグ・SDKメソッドを使う）

**このプロジェクトでの具体的な危険**: Stripe Connect の `paypay_payments` ケイパビリティ（`consolidated.md` は「Connect専用2ページに存在しない」と記録）、PayPay の署名検証機構（ドキュメントに記載なし）、`liff.sendMessages()` の集金導線での利用（403 になる）。

**対策**
1. **CI の型チェックが第一防壁**。SDK の型定義にないメソッドはビルドで落ちる。Stripe/Supabase は型が充実しているのでこれが効く。
2. **型がない領域（PayPay REST の生叩き、LINE の一部）には、保存済み fixture ベースの契約テストを置く。** 実レスポンスを1回取って `tests/fixtures/paypay/*.json` に固定し、コードがそれを正しく扱うことをテストする。
3. **Gemini 敵対レビューに「使われているAPIが一次資料に実在するか」を毎回確認させる**（§2-4 のプロンプトが逐語引用を強制する）。
4. **context7 MCP が接続失敗している**（本セッション実測）ので、ライブラリ仕様の確認は WebFetch + 逐語引用で代替し、**接続が戻ったら context7 を優先に戻す**（ユーザーの global CLAUDE.md の指示）。
5. `docs/runbooks/RB-07-model-routes.md` に「確認済みのコマンド・フラグ」だけを記録し、未確認のものは `[未検証]` を付けて書く。

### 7-2. 完了の過大申告

**対策（4重）**
1. **4値ステータスに「だいたい完了」を作らない**（§4 S8）。
2. **`assert-acceptance.mjs` が evidence の commit を HEAD と照合する。** 古い実行結果の使い回し＝過大申告の主要経路を、CI が機械的に潰す。
3. **Stop フックが契約テストを毎ターン走らせる。** 「テストは通ってるはず」でターンを終われない。
4. **`assert-diff-exists.sh`（SubagentStop）** — サブエージェントの「完了しました」を VCS diff で検算する。verification.md の対応表「サブエージェントが完了した → 必要な証拠は VCS diff・生成物の実体確認」をそのまま実装したもの。
5. **計測**: 「DONE 宣言後に CI または敵対レビューで落ちた件数 ÷ DONE 件数」を週次で出す（§8）。これが過大申告率そのもの。

### 7-3. テスト改変によるゲート突破

**対策**
1. `deny-test-weakening.sh`（PreToolUse）が it/expect の削減、`.skip` / `.todo` / `.only` の追加を遮断する。
2. CI で `--max-warnings=0` と、テスト件数のベースライン比較（`npm run test:unit -- --reporter=json` の件数を前コミットと比較し、減っていたら PR に警告コメント）。
3. `quality-fixer` のエージェント定義に「テストが誤っていると判断したら回避せず BLOCKED で報告」を明記（既存の fable-protocol 規範と一致）。
4. **`.github/CODEOWNERS` で `tests/` と `scripts/gate-*.sh` を PO の必須レビュー対象にする。** ゲートそのものを緩める PR は人間が見る。

### 7-4. コンテキスト喪失

**対策**
1. **PreCompact フックで `HANDOFF.md` を強制永続化する**（§3-1）。圧縮でセッションが痩せる前に、現在地をファイルへ落とす。
2. **UserPromptSubmit フックが毎ターン、未通過ゲートを本文に注入する**（`gate-status.mjs`）。何を忘れてはいけないかを毎ターン再供給する。
3. **コンテキスト使用率 40〜60% を維持する**（orchestration.md）。超えたら生ログを捨てて `HANDOFF.md` から再開する。
4. **広域探索はサブエージェントへ委譲し、結論だけ受け取る**（コンテキスト防火壁）。本プロジェクトは `scratchpad/` に合計 30MB 超の一次資料があり（実測）、メインコンテキストに読み込むと即座に破綻する。

### 7-5. MCP 停止・モデル不達

**本セッションで実際に起きている**: `codex` / `context7` / `figma` / `magic` / `obsidian` / `vfx` の6サーバーが接続失敗。これは想定リスクではなく現実の状態。

**代替経路の定義**

| 一次経路 | 停止時の代替1 | 代替2 | 代替2も不可の場合 |
|---|---|---|---|
| `mcp__gemini-cli__ask-gemini` | `gemini -p "<prompt>"`（CLI 0.38.1、実測で存在） | CI の `review-gemini.mjs`（API 直叩き、`GEMINI_API_KEY`） | finding を `UNKNOWN` として記録し、**その制約の担当を Opus5.5 へ一時移管。移管したことを PR コメントに明記** |
| `codex` MCP（**現在停止中**） | `codex exec`（CLI 0.154.0、実測で存在） | CI の `review-gpt.mjs`（API 直叩き） | 同上。**「GPT 票が取れなかった」状態でマージしたことを ADR に残す** |
| `context7` MCP（**現在停止中**） | WebFetch で公式ドキュメントを取得し逐語引用 | ローカルの `node_modules/**/*.d.ts` を読む | ライブラリ仕様に依存する実装を `BLOCKED` にする |
| Stripe MCP（要認証） | `stripe` CLI（実測で PATH 上に存在） | Stripe ダッシュボード（人間） | — |
| Supabase MCP（要認証） | `supabase` CLI 2.58.5 | ダッシュボード（人間） | — |
| GitHub MCP | `gh` CLI（認証済み） | Web UI | — |

**規律**: **代替経路を使ったことを必ず記録する。** 「Gemini 票が取れないまま通した PR」が後から特定できないと、ゲートが形骸化したことに気づけない。`merge-review.sh` は経路を verdict.json に記録し、`reviewer_route: "cli-fallback"` や `"unavailable"` を PR コメントに出す。

**モデル不達（レート制限・障害）**: レビューは `continue-on-error: true` で CI を止めず、集計側で `UNKNOWN` として扱う。ただし **`UNKNOWN` が20%を超えたらレビュー自体が無効**で、マージはできない（§2-4）。「落ちたから素通し」にはならない。

### 7-6. 決済サンドボックスとステージングの取り違え（本番事故）

**対策**
1. `deny-dangerous-bash.sh` が `sk_live_` / `PAYPAY_ENV=PROD` / `vercel --prod` を遮断する。
2. CI の `secrets` ジョブが本番キー文字列のコミットを検出する。
3. **本番キーは Vercel の Production 環境変数にのみ存在し、ローカル `.env` には置かない。** `.env.example` に `STRIPE_SECRET_KEY=sk_test_...` と test 前提で書く。
4. ステージングは Vercel Preview（`hnd1`、制約 I1）+ **Supabase は本番と別プロジェクト**。同一プロジェクトのスキーマ共有をしない。
5. **本番決済の初回有効化は、L11 ゲート（弁護士確認）を通した後、PO が手動で行う。自動化しない。**

### 7-7. コスト暴走

**発生源**: (a) レビューループが収束せず何周も回る、(b) Opus に細かい作業をさせる、(c) 大きな一次資料をメインコンテキストへ読み込む、(d) 敵対レビューを全 PR の全ファイルに対して走らせる。

**対策**
1. **レビューループの上限を3周に固定**（§3-3）。超えたら人間へ。
2. **Opus の呼び出しを1タスク3回以内に設計上制限**（設計 / レビュー判定 / 完了ゲート）。
3. **敵対レビューは `adversarial_review: "required"` のタスクに限定**。決済・Webhook・認証・法務に触れないタスク（UI文言の修正など）は skip。
4. **レビューパケットを diff に限定**（リポジトリ全体を渡さない）。
5. **週次予算を設定し、Sonnet 換算のトークン実績を `docs/metrics/cost-YYYYWW.md` に記録。120% 超で Opus 呼び出しを止めて PO へ**（§1-4）。
6. **`scripts/bench-models.sh`（§2-5）を先に回して、単価不明のまま配置しない。**

### 7-8. ハーネスが遅すぎて使われなくなる（最大の静かな失敗）

**兆候**: PostToolUse の tsc が毎回30秒かかり、開発者が `--no-verify` 相当の抜け道を探し始める。

**対策**
1. PostToolUse は**変更ファイルのみ**を対象にする（`eslint $(git diff --name-only)`）。
2. Stop フックは**契約テストのサブセット**だけ（`npm run test:gate` = 重複・逆順・署名不一致の3本 + 単体）。全量は CI。
3. E2E は PR 毎に走らせない（nightly + リリース前）。
4. **月次で「フックが遅くて無効化された回数」を計測**する。1回でもあれば設計の失敗として扱い、フックを軽くする。

---

## 8. 週次のリズムと計測指標

### 8-1. 週次リズム

| 曜日 | 内容 | 担当 | 成果物 |
|---|---|---|---|
| 月 AM | **ゲート棚卸し** — 未通過 check、BLOCKED タスク、外部回答待ちの一覧を作る | [Opus5.5] | `docs/PROGRESS.md` 更新、今週の1手 |
| 月 PM | **外部照会のフォロー** — PayPay / Stripe / LINE / 弁護士の未回答を突く | [人間] PO | `docs/inquiries/*.md` に回答を逐語で追記 |
| 火〜木 | **実装ループ**（§4 の S0〜S9 を回す） | [Sonnet] 主、[Opus5.5] 判定 | PR、evidence 付き acceptance-checks |
| 木 PM | **敵対レビューまとめ読み** — 今週の findings を読み、繰り返し出る型を制約へ昇格させる | [Opus5.5] | `docs/constraints.json` 追記、`gate-constraints.sh` にルール追加 |
| 金 AM | **メトリクス集計** | [Sonnet] | `docs/metrics/YYYYWW.md` |
| 金 PM | **週次レビュー（人間30分）** — メトリクスを見て、モデル配置の撤回条件（§2-3）に該当するか判定 | [人間] PO | ADR（配置変更があれば） |
| 月末 | **プレモータム再実行** | premortem-facilitator | `scratchpad/premortem/premortem-YYYYMMDD.md` |

**スプリントは1週間**。理由: 外部回答待ちが多く、2週間スプリントだと「待ちで何も動かなかった週」が可視化されずに埋もれる。

### 8-2. 計測指標

**A. 品質ゲートの指標（主指標）**

| 指標 | 定義 | 目標 | 取り方 |
|---|---|---|---|
| **レビュー差し戻し率** | `high` finding が1件以上出た PR 数 ÷ 全 PR 数 | 週を追って低下（初週 60% → 8週で 20% 未満） | `reviews/*/verdict.json` を集計 |
| **ベンダー別ユニーク検出数** | Gemini だけ / GPT だけ / 両方 が検出した high の件数 | **どちらかが2週連続ゼロなら、その役割は機能していない**（§2-3 の撤回条件） | 同上 |
| **過大申告率** | `DONE` 宣言後に CI または敵対レビューで落ちた件数 ÷ `DONE` 件数 | **5% 未満**。これが T2 の存在意義を直接測る | `task-list.json` の履歴 + CI ログ |
| **ゲート初回通過率** | G2（PostToolUse）/ G3（Stop）/ G4（CI）/ G5（敵対レビュー）それぞれの初回通過率 | G2 90% / G3 85% / G4 80% / G5 60% | フックとCIのログ |
| **4値ステータス分布** | DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT の件数比 | `NEEDS_CONTEXT` が30%超ならタスク分解が粗い（§2-3） | `task-list.json` |

**B. テスト網羅の指標**

| 指標 | 定義 | 目標 |
|---|---|---|
| **契約テスト充足率** | PaymentProvider の4メソッド × 異常系3種（重複・逆順・署名不一致）= 12セル、× プロバイダ数。埋まったセル ÷ 全セル | アダプタ実装済みプロバイダについて 100% |
| **テストピラミッド比** | L1単体 : L2契約 : L3統合 : L4 E2E の件数比 | 60 : 20 : 15 : 5（逆ピラミッドなら是正） |
| **制約カバレッジ** | `gate-constraints.sh` が機械検査している制約数 ÷ `docs/constraints.json` の制約総数 | 週ごとに増やす。50% を下回らない |
| **単体カバレッジ** | 金額計算・状態ランク・merchantPaymentId 生成/解析の分岐網羅 | 90%（この3モジュールに限定。全体カバレッジは追わない） |

**C. コスト・速度の指標**

| 指標 | 定義 | 目標 |
|---|---|---|
| **AIコスト（週次・モデル別）** | Opus / Sonnet / Gemini / GPT それぞれのトークンと概算円 | 週次予算内。Opus 比率が50%超なら配置を見直す |
| **1タスクあたりのコスト** | 週の AI コスト ÷ `DONE` タスク数 | 週を追って低下 |
| **レビューループ周回数** | 1タスクあたりの S5⇄S6 の平均周回数 | 1.5 周以下（3周上限に張り付いていたら制約が伝わっていない） |
| **フック実行時間** | PostToolUse / Stop の p50 / p95 | PostToolUse p95 < 20秒、Stop p95 < 90秒。超えたら軽くする（§7-8） |

**D. 外部依存の指標**

| 指標 | 定義 | 用途 |
|---|---|---|
| **照会リードタイム** | 発信日から回答日までの日数（PayPay / Stripe / LINE / 弁護士 別） | ブロッカーの見積もり精度を上げる |
| **BLOCKED 滞留日数** | `BLOCKED` タスクが BLOCKED のまま経過した日数の中央値 | 7日超のものは週次レビューで必ず扱う |
| **代替経路使用率** | 敵対レビューが `cli-fallback` / `unavailable` で実行された割合 | 20% 超なら MCP 環境の修復を優先タスク化（§7-5） |

### 8-3. 週0（着手週）にやること — 順番も含めてこの通り

1. **PayPay へ商材照会を送る**（`consolidated.md` §5-1 Q1〜3）。回答1本で候補A の go/no-go が決まる。
2. **弁護士に §5-4 Q1〜4 を送る**（特に第3号ニの構成）。
3. **Stripe に §5-2 Q2〜4 を送る**。
4. `scripts/bench-models.sh` を回し、4モデルの実測値を `docs/metrics/model-bench.md` に入れる（§2-5）。**これが出るまで本書のモデル配置は暫定。**
5. `.claude/settings.json` のフックを入れ、`update-config` スキルで PreToolUse / SubagentStop / PreCompact の実在を確認する（§0-3 の `[要検証]` を解消する）。
6. `docs/constraints.json` を `consolidated.md` §6 から生成し、`gate-constraints.sh` を書く。
7. **照会の回答を待たずに作れるもの**だけ着手する: PaymentProvider アダプタ層（モックのみ）、名簿/イベント管理、Webhook 冪等基盤（W1〜W12）。決済事業者が変わっても捨てずに済む（`consolidated.md` 付録）。
8. 1回目のプレモータムを実行する（`scratchpad/premortem/` は現在空）。

---

## 付録: T2 のゲート一覧（1枚）

| ID | ゲート | 通す条件 | 実装 | 落ちた時の行き先 |
|---|---|---|---|---|
| G0 | 法務ゲート | L1-L12 に抵触しない。本番決済は弁護士確認済み | `legal-gatekeeper` + 人間 | 弁護士へ。実装は止める |
| G1 | 設計ゲート | constraint_ids と acceptance_check_ids が全タスクに付いている | `validate-plan-json.mjs` | task-decomposer へ差し戻し |
| G2 | 編集ゲート | tsc 0 / eslint 0 / `gate-constraints.sh` 違反0 | PostToolUse フック | その場で修正（次の編集に進めない） |
| G3 | ターンゲート | 契約テスト3本 + 単体が緑 | Stop フック | ターンを終われない |
| G4 | PRゲート | static / contract / integration / secrets / acceptance が緑 | GitHub Actions（required） | マージ不可 |
| G5 | 敵対レビューゲート | Gemini/GPT の high がゼロ、UNKNOWN 20% 未満 | `merge-review.sh` | findings を反例テスト化して修正ループ（最大3周） |
| G6 | ステージングゲート | パイロット幹事の1回の実利用で重大問題なし。決済は test/STAGING のみ | 人間 + `release-auditor` | 差し戻し |
| G7 | 本番ゲート | 3者監査が全会一致 go、かつ G0 通過 | `release-audit.ts` + PO の手動操作 | PO 判断 |

**T2 の一文要約**: 各工程の出口に「次の工程が受け取ってよい状態か」を判定する機械を置き、その判定のうち**事実主張に関わる票だけは異ベンダー（Gemini / GPT）に持たせる**。Claude が書いたものを Claude が承認する経路を、設計上どこにも作らない。
