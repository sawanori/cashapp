# チーム構成・ハーネス案 T1 — 幹事向け会費集金アプリ（LINEミニアプリ）

起案日: 2026-09-24 / 起案者: 組織・ハーネス設計エージェント（独立起案 T1）
入力: 引継ぎ書 / local-context.md / research/consolidated.md
使用モデル: Opus 5.5 / Sonnet / Gemini 3.8 Flash / GPT-6 Astra（Fable は使わない）

---

## 0. この案の設計前提（最初に結論）

**T1 の中心的な設計判断は「AI の実装速度を、外部人間の回答待ち時間から切り離すこと」である。**
統合調査の結論により、決済事業者を確定できるのは PayPay・Stripe・弁護士の3照会が返ってからで、それまで決済事業者を決め打ちした実装は着手してはならない（consolidated.md 付録）。一方で PaymentProvider アダプタ層・名簿／イベント管理・Webhook 冪等基盤・LINEミニアプリ外殻は、決済事業者が変わっても捨てずに済む（同 付録末尾）。

したがって T1 は2本のトラックを並走させる。

| トラック | 主担当 | 中身 | 止まる条件 |
|---|---|---|---|
| **A: 実装トラック** | AI エージェント群（Opus 5.5 / Sonnet 主導） | Provider 非依存コア（アダプタ IF・台帳・冪等基盤・LIFF 外殻・テスト） | 「本番決済の有効化」に到達したとき（ゲート L11） |
| **B: 照会トラック** | noritaka（人間）＋外部人間 | PayPay商材照会 / Stripe C2C条項 / 弁護士（資金決済法）/ LINEヤフー審査 | 回答が返るまでAは待たない。Bの回答で設計が変わる箇所は ADR で記録 |

**ハーネスの最重要機能は「トラックAが勝手にトラックBを飛び越えないこと」を機械的に保証すること。** 具体的には本番決済キー・本番 Webhook 登録・本番リリースを、`docs/gates/legal-clearance.json` が `cleared: true` になるまでフックと CI が物理的に拒否する（§3-a, §3-e）。

### 0-1. 本ドキュメント内の検証ラベル

- **[実測]** — 本セッションで実際にコマンドを実行して確認した
- **[文書]** — 既存ファイル（settings.json, SKILL.md 等）を読んで確認した
- **[設計]** — 本案の提案。未実装・未検証
- **[不明]** — 確認できていない。実装前に確認が必要

---

## 1. 役割表

### 1-1. AI エージェント（Claude Code 内）

| # | 役割 | 担当モデル | 入力 | 出力 | 停止・エスカレーション条件 | 使うツール |
|---|---|---|---|---|---|---|
| A1 | **オーケストレーター**（メインループ） | Opus 5.5 | ユーザー指示 / docs/task-list.json / HANDOFF.md | タスク割当・ゲート判定・最終報告 | ①L1〜L12 のいずれかに抵触する設計判断が必要 ②照会トラックB の回答が必要 ③スコープ変更 → **noritaka へエスカレーション** | Workflow, Task(Agent), Read, Bash |
| A2 | **技術設計者 / ADR 起案** | Opus 5.5 | consolidated.md §6 制約表, 照会回答 | docs/adr/NNNN-*.md, docs/implementation-plan.md | 制約表に根拠のない設計を要求されたとき → 照会文を起案して停止 | `technical-designer`（既存）＋ `model: opus` |
| A3 | **計画・タスク分解** | Sonnet | implementation-plan.md | docs/task-list.json, docs/acceptance-checks.json | verify_commands が package.json に存在しないとき → 停止（コマンドを捏造しない） | `plan` スキル, `work-planner`, `task-decomposer`（既存） |
| A4 | **実装（量産）** | Sonnet | 1タスク分の task-list.json エントリ | コード＋同一 diff 内のテスト | 3回連続でゲート不通過 → `BLOCKED` で A1 へ返す | `task-executor` / `task-executor-frontend`（既存） |
| A5 | **実装（難所）**: Webhook 冪等・状態機械・決済アダプタ | Opus 5.5 | 制約 W1〜W12 / P1〜P9 | コード＋重複・逆順・署名不一致の3テスト（I5） | 冪等キー設計が W2 を満たせないとき → 設計に戻す | `task-executor` ＋ `model: opus`、新設 `webhook-idempotency-auditor` |
| A6 | **品質修正（lint/type/test を緑にする）** | Sonnet | エラー出力 | 修正 diff＋実行ログ | テスト自体を書き換えて緑にしようとした瞬間 → 禁止・`BLOCKED` で報告 | `quality-fixer` / `quality-fixer-frontend`（既存） |
| A7 | **一次スクリーニング・レビュー（安価・高速）** | **Gemini 3.8 Flash** | git diff, 長い一次資料, CSV/ログ | 機械的指摘リスト（JSON） | 判断が割れたら判定せず「要 A8」とだけ返す | 新設 `screening-reviewer-gemini`（Bash → `gemini -p`） |
| A8 | **敵対的レビュー（別ベンダー独立視点）** | **GPT-6 Astra** | 高リスクファイルの diff＋設計意図 | 反証レポート（refuted/confirmed＋再現シナリオ） | 「問題なし」で終わらせない。必ず最低1つの攻撃シナリオを書く | 新設 `adversarial-reviewer-gpt`（Bash → `codex exec` / `codex exec review`） |
| A9 | **レビュー裁定** | Opus 5.5 | A7/A8 の指摘 | 採用／却下＋理由、修正タスク化 | A8 の指摘が設計変更を要するとき → ADR 起票して A1 へ | `code-reviewer`（既存）＋ `model: opus` |
| A10 | **受入テスト生成** | Sonnet | acceptance-checks.json | テストスケルトン | 検証手段が手動しかない項目は `manual_or_automated: manual` として明示 | `acceptance-test-generator`（既存） |
| A11 | **コンプライアンス・ゲートキーパー** | Opus 5.5 | diff 全体＋ L1〜L12 / P1〜P9 / N1〜N12 | pass/fail＋抵触箇所 | 1件でも fail → **リリース不可**。noritaka へ通知 | 新設 `compliance-gatekeeper` |
| A12 | **外部照会文の起案・追跡** | Sonnet | consolidated.md §5 の質問群 | 送付用テキスト, docs/external-inquiries.json 更新 | 回答が曖昧なとき → 再照会文を起案し noritaka に判断を渡す | 新設 `external-inquiry-drafter` |
| A13 | **調査（バグ再現・原因特定）** | Opus 5.5（難）/ Sonnet（易） | 障害報告 | 証拠マトリクス（観察のみ・解決策は出さない） | 再現できないとき → `NEEDS_CONTEXT` | `investigator` / `verifier`（既存） |
| A14 | **プレモータム（失敗の先回り）** | Opus 5.5 ×3 視点 ＋ GPT-6 Astra ×1 | 直近フェーズの設計・実装 | 想定障害リスト＋検知策＋回避策 | 致命度 High が新規に出たら A1 が計画を差し戻す | Workflow `cashapp-premortem` |

### 1-2. 人間

| # | 役割 | 担当 | 入力 | 出力 | 停止・エスカレーション条件 | 接点 |
|---|---|---|---|---|---|---|
| H1 | **PO / 最終判断 / 外部折衝** | noritaka | AI からのエスカレーション、外部回答 | 決定（採用/却下）、照会送付、リリース承認 | 法的判断が必要なもの → H2 へ | Claude Code 本体、Gmail、電話 |
| H2 | **弁護士（資金決済法・フィンテック）** | 外部（未選定） | consolidated.md §5-4 の質問1〜11 | 書面回答・意見書 | 回答が「個別判断が必要」で終わったら金融庁グレーゾーン解消制度へ | メール／面談。**本番決済有効化の必須ゲート（L11）** |
| H3 | **税理士** | 外部（未選定・優先度低） | 手数料・売上計上・インボイスの扱い | 助言 | 収益化の設計を始めるまで着手不要 | メール |
| H4 | **PayPay 加盟店窓口 / 営業担当** | 外部 | §5-1 の質問1〜8（特に1〜3） | 商材可否・加盟店資格の回答 | 「個別審査」で終わったら申込を出して審査で判定させる | 問い合わせフォーム／営業 |
| H5 | **Stripe サポート（`payment_apis` 窓口）** | 外部 | §5-2 の質問1〜6（特に2〜4） | C2C条項の射程、PayPay×Connect の正否 | 回答が公式文書と矛盾したら文書で再確認 | サポートチケット |
| H6 | **LINEヤフー ミニアプリ審査窓口** | 外部 | §5-3 の質問1〜7 | 用途可否・認証審査の観点 | 未認証で先に作れる範囲を確定させる | `mini_request@linecorp.com` 等 |
| H7 | **パイロット幹事（3〜5名）** | 外部（noritaka の知人・サークル主催者） | 動くミニアプリ（サンドボックス決済） | 実地フィードバック、誤照合の実例 | 実データ（他人の氏名）を扱う前に L6 同意フローが必要 | LINE グループ |
| H8 | **デザイン** | noritaka（NonTurn 内製）＋ AI | 画面要件 | UI トンマナ、LIFF 画面 | 当面は内製。外注が要るときのみ発生 | `frontend-design` / `web-typography` スキル |

---

## 2. モデル適材適所の根拠

### 2-1. 各モデルの評価軸（不明なものは不明と書く）

| 軸 | Opus 5.5 | Sonnet | Gemini 3.8 Flash | GPT-6 Astra |
|---|---|---|---|---|
| 呼び出し経路 | Claude Code 本体／サブエージェント `model:` | 同上 | **[実測]** `gemini -m gemini-3.8-flash -p "..."`（CLI v0.38.1）／`mcp__gemini-cli__ask-gemini` | **[実測]** `codex exec -m gpt-6-astra`（codex-cli 0.154.0）。※`~/.codex/config.toml` の既定値は `gpt-6-astra`。ユーザー表記「astla」との差異は表記揺れとみなす |
| 得意 | 長い制約表の同時保持、法務・規約の含意推論、設計判断、ゲート裁定 | 明確な仕様がある実装、テスト作成、修正の反復 | 大量テキストの一次スクリーニング、機械的な整合チェック、低レイテンシ | 別ベンダーの独立視点。Claude の思考の癖に引きずられない反証 |
| 不得意・注意 | コスト高・遅い。量産に使うと予算を食う | 長い制約表の取りこぼし（W1〜W12 を全部覚えていない） | 深い設計判断・法解釈。断定しがちな箇所を裁定に使わない | 本リポジトリの文脈を持たない。プロンプトに背景を全部渡す必要がある |
| コスト | **[不明]**（公開単価を本セッションで未確認） | **[不明]** | **[不明]**。CLI 経由・API キー認証 **[文書]**（`~/.gemini/settings.json` の `selectedType: gemini-api-key`） | **[不明]** |
| レイテンシ | **[不明]**（相対的に最も遅い前提で設計） | **[不明]** | **[実測]** 短プロンプトで数秒以内に応答 | **[実測]** 未達（後述のブロッカーにより応答取得できず） |
| コンテキスト長 | 本セッションのモデル ID は `claude-opus-5[1m]`（1M 枠）**[文書]**。「Opus 5.5」の正確な仕様は **[不明]** | **[不明]** | **[不明]** | **[不明]** |

**運用上の原則:** コンテキスト長・単価が不明なので、「モデルの公称スペック」ではなく「**このハーネスで実測したレイテンシと差し戻し率**」で配置を毎週見直す（§8 の指標）。初期配置は上表の得意/不得意だけを根拠にする。

### 2-2. 配置ルール（3行）

1. **判断するのは Opus 5.5 だけ。** 設計・裁定・ゲート判定・法務含意は Opus 5.5 に集約する。
2. **作るのは Sonnet。** 仕様が task-list.json に落ちたものは Sonnet が実装する。Opus 5.5 を回すのは「W/P/N 制約が密集する難所」（決済アダプタ、Webhook、状態機械、LIFF トークン検証）だけ。
3. **疑うのは別ベンダー。** Claude が書いたコードは Claude だけでレビューしない。Gemini 3.8 Flash が安く広く、GPT-6 Astra が高く深く疑う。

### 2-3. ベンダー横断レビューの設計

```
[書く] Claude (Sonnet または Opus 5.5)
   ↓ git diff
[一次スクリーニング] Gemini 3.8 Flash            ← 全 diff・毎 PR・安価
   gemini -m gemini-3.8-flash -p "<レビュー指示>" -o json --approval-mode plan
   出力: {findings:[{file,line,severity,claim}], needs_deep_review: bool}
   ↓ severity>=medium または 高リスクパスに触れた場合のみ
[敵対的レビュー] GPT-6 Astra                      ← 高リスクのみ・深い
   codex exec -m gpt-6-astra --sandbox read-only "<反証指示>"
   または codex exec review（リポジトリ全体のコードレビュー・[文書] codex exec --help）
   出力: 各 finding に refuted/confirmed ＋ 具体的な再現手順
   ↓
[裁定] Opus 5.5 (`code-reviewer` + model: opus)
   採用 → 修正タスク化（task-list.json に追記）
   却下 → 却下理由を docs/review-log/<pr>.md に記録（黙殺しない）
   ↓
[修正] Sonnet (`quality-fixer`)
```

**高リスクパス定義（GPT-6 Astra を必ず通す）:**
`src/payments/**`, `src/webhooks/**`, `src/auth/**`, `supabase/migrations/**`, `src/lib/idempotency*`, `docs/adr/**`

**敵対的レビューのプロンプト骨子（Claude の癖を狙い撃つ）:**
> このコードは Claude が書いた。次の4点を優先的に疑え。(1) 存在しない API・SDK メソッドを呼んでいないか（PayPay SDK / Stripe SDK / LIFF SDK の実在確認）。(2) テストが実装に合わせて書かれ、仕様を検証していないのではないか。(3) Webhook の重複・逆順・署名不一致で状態が壊れないか、具体的なイベント列で示せ。(4) 「動く」と「正しい」を取り違えていないか。問題なしで終わらせず、最低1つの攻撃シナリオを書け。

### 2-4. **[実測] 現時点のブロッカー — GPT-6 Astra は今すぐには使えない**

本セッションで実行した結果、`codex exec` は **UserPromptSubmit フックにブロックされて起動しない**。

```
$ ALLOW_NON_CLAUDE_MODEL=1 codex exec -m gpt-6-astra --sandbox read-only --skip-git-repo-check "Reply with exactly: OK"
hook: UserPromptSubmit Blocked
```

原因は **[文書]** `~/.codex/hooks/block-non-claude-model.sh`。Claude 側の同名フック（`~/.claude/hooks/block-non-claude-model.sh`）には
`if [ "${ALLOW_NON_CLAUDE_MODEL:-0}" = "1" ]; then exit 0; fi` という例外句があるが、**Codex 側のコピーにはこの例外句が無い**。したがって Codex の既定モデル `gpt-6-astra` は常にブロックされる。

**着手前に必要な設定作業（noritaka の承認が要る・AI が勝手に変えてはならない）:**
1. `~/.codex/hooks/block-non-claude-model.sh` に Claude 側と同じ `ALLOW_NON_CLAUDE_MODEL` 例外句を追加する、または
2. `~/.codex/hooks.json` の `UserPromptSubmit` から当該フックを外す。

併せて、MCP 経路 `codex` は本セッションで **CONNECTION_CLOSED** で接続失敗している。GPT-6 Astra への到達経路は現状ゼロ。**この解決が A8（敵対的レビュー）の前提条件であり、解決するまで A8 は Gemini 3.8 Flash による代替（プロンプトを反証モードに切り替える）で暫定運用する。**

Gemini 側は **[実測]** 疎通済み（`gemini -m gemini-3.8-flash -p "Reply with exactly: OK"` → `OK`、exit 0）。

---

## 3. ハーネス構成

### 3-a. `.claude/settings.json` の hooks（プロジェクト単位でオプトイン）

> フックはプロジェクト単位で入れる。グローバル導入はテストの無いディレクトリで誤発火する **[文書]**（fable-protocol `references/hooks.md`）。
> 以下のコマンドは **task_001「プロジェクト初期化」で package.json の scripts を作った後に有効になる**。存在しないコマンドを先に書かない。

```jsonc
// /Users/noritakasawada/AI_P/cashapp/.claude/settings.json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{
          "type": "command",
          "timeout": 15,
          "statusMessage": "cashapp context",
          // 照会トラックBの未回答一覧・法務ゲートの状態・前回の HANDOFF 末尾を毎回注入する
          "command": "cd \"$CLAUDE_PROJECT_DIR\" && node scripts/session-brief.mjs"
        }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "timeout": 10,
          "statusMessage": "danger command guard",
          // 危険コマンド遮断。exit 2 でツール実行をブロックし、stderr がモデルに返る
          "command": "cd \"$CLAUDE_PROJECT_DIR\" && node scripts/guard-bash.mjs"
        }]
      },
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{
          "type": "command",
          "timeout": 10,
          "statusMessage": "secret & test-tamper guard",
          // 1) sk_live_/pk_live_/CHANNEL_SECRET 等の本番鍵の書き込みを拒否
          // 2) tests/contract/**（冪等性3本）の書き換えを拒否（テスト改変対策）
          "command": "cd \"$CLAUDE_PROJECT_DIR\" && node scripts/guard-write.mjs"
        }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "timeout": 120, "statusMessage": "typecheck",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && npm run typecheck --silent" },
          { "type": "command", "timeout": 120, "statusMessage": "lint (changed files)",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && npm run lint:changed --silent" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          // 冪等性の3本（重複・逆順・署名不一致）だけを毎ターン走らせる。全件はCIで。
          { "type": "command", "timeout": 180, "statusMessage": "contract tests",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && npm run test:contract --silent" },
          // 完了の過大申告を機械的に潰す本丸（§3-e）
          { "type": "command", "timeout": 60, "statusMessage": "task gate",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && node scripts/gate-check.mjs" }
        ]
      }
    ]
  }
}
```

**`scripts/guard-bash.mjs` が遮断する対象（[設計]）**

| パターン | 理由 |
|---|---|
| `rm -rf` で `$CLAUDE_PROJECT_DIR` 外／`.git`／`node_modules` 以外を指すもの | 不可逆 |
| `git push --force`, `git push -f`, `git reset --hard origin/*` | 不可逆 |
| `supabase db reset`, `supabase link` で本番 project-ref | 本番データ破壊 |
| `stripe` かつ `sk_live` / `--live` を含む | 本番決済。ゲート L11 未通過で不可 |
| `vercel --prod`, `vercel deploy --prod` | 本番リリース。CI 経由に限定 |
| 環境変数に `PAYPAY_ENV=PROD` / `NODE_ENV=production` を伴う決済系スクリプト | 同上（I6: 開発は `env: "STAGING"`） |
| `docs/gates/legal-clearance.json` の `cleared` が `true` でない限り、上記の決済・本番系は**全て**拒否 | **L11 の機械的強制** |

**遮断の実装方針 [設計]**: フックの終了コード 2 ＋ stderr メッセージでブロックする（フック共通の仕様）。JSON の `permissionDecision` 形式を使う場合はフィールド名を `/update-config` スキルで確認してから入れる（**[不明]**: 現行 Claude Code の PreToolUse JSON スキーマの正確なフィールド名を本セッションで未確認）。

**既存のグローバルフックとの関係 [文書]**: `~/.claude/settings.json` には SessionStart の `fable-like-autoinject.sh`（非 Fable モデルへ規範注入）と UserPromptSubmit の `block-non-claude-model.sh` が既にある。前者は Opus 5.5 / Sonnet に対して有効で本案の前提。後者は**Claude Code セッション自身のモデル**を見るもので、Bash から `gemini` / `codex` を呼ぶことは妨げない（Codex 側の同名フックは §2-4 の通り別問題）。

### 3-b. `.claude/agents/*.md` — 既存の割当と新規

**既存エージェント（`~/.claude/agents`）に `model:` を明示する [設計]**
現状、`task-executor` / `verifier` / `quality-fixer` / `code-reviewer` / `investigator` / `work-planner` / `task-decomposer` / `acceptance-test-generator` / `technical-designer` / `requirement-analyzer` の frontmatter に `model:` は無い **[文書]**（`grep -l "^model:"` で hyperresearch-* と ugc-* 系にしかヒットしない）。プロジェクト側 `.claude/agents/` に同名で薄いオーバーライドを置き、`model:` だけを指定する。

| 既存エージェント | 本プロジェクトでの `model:` | 用途 |
|---|---|---|
| `technical-designer` | `opus` | ADR / Design Doc |
| `work-planner`, `task-decomposer` | `sonnet` | 計画・分解 |
| `task-executor`, `task-executor-frontend` | `sonnet` | 量産実装 |
| `task-executor`（高リスクパス用の別名 `task-executor-critical`） | `opus` | 決済／Webhook／認証 |
| `quality-fixer`, `quality-fixer-frontend` | `sonnet` | lint/type/test を緑に |
| `code-reviewer` | `opus` | レビュー裁定（A9） |
| `acceptance-test-generator` | `sonnet` | 受入テスト骨組み |
| `investigator` | `sonnet` | 一次調査 |
| `verifier` | `opus` | 調査結果の反証（ACH / Devil's Advocate） |
| `requirement-analyzer` | `opus` | 要件の含意抽出 |

**新規エージェント5つ [設計]**

1. **`screening-reviewer-gemini.md`**（tools: `Bash, Read, Grep`）
   ```yaml
   ---
   name: screening-reviewer-gemini
   description: 差分の一次スクリーニングを Gemini 3.8 Flash で行う。安価・高速。PR ごとに必ず通す。
   tools: Bash, Read, Grep
   ---
   ```
   本体は `git diff` を取り、`gemini -m gemini-3.8-flash -p "<指示>" -o json --approval-mode plan` を叩いて JSON を返すだけ。**判断はしない。** 迷ったら `needs_deep_review: true` を立てる。

2. **`adversarial-reviewer-gpt.md`**（tools: `Bash, Read, Grep`）
   `codex exec -m gpt-6-astra --sandbox read-only "<反証指示>"` を叩く。§2-4 のブロッカー未解消の間は「`codex` 到達不能」を `BLOCKED` として返し、**成功を偽装しない**。

3. **`webhook-idempotency-auditor.md`**（model: `opus`、tools: `Read, Grep, Glob, Bash`）
   consolidated.md §6-3 の W1〜W12 をチェックリストとして持ち、diff が各項目を満たすかを個別に判定する。特に W2（event_id だけでは不十分）、W3（単調な状態ランク）、W4（`created` を順序判定に使わない）、W7（PayPay は署名検証が無い前提で必ず再照会）。

4. **`compliance-gatekeeper.md`**（model: `opus`、tools: `Read, Grep, Glob`）
   L1〜L12 / P1〜P9 / N1〜N12 を全件チェック。1件でも fail ならリリース不可。特に **L1（運営者の口座を資金が経由しない）**、**L2（前払い専用・立替精算モードを実装しない）**、**L3（アプリ内残高を作らない）**、**N4（主要機能をミニアプリ内で完結）**、**N11（寄付・募金の文脈を排する）**。

5. **`external-inquiry-drafter.md`**（model: `sonnet`、tools: `Read, Write, Edit`）
   consolidated.md §5-1〜5-4 の質問群から送付用テキストを生成し、`docs/external-inquiries.json` の状態（`draft` → `sent` → `answered` → `superseded`）を更新する。

**全サブエージェントの指示末尾に貼る規範 [文書]**: `~/.claude/skills/fable-protocol/references/subagent-snippet.md` の6項目（結論先行／即行動／進捗の実証／スコープ規律／ターン終了規律／境界）。output style もフックもサブエージェントには効かないため、貼付は必須。

### 3-c. Workflow スクリプト（3本）

Workflow ツールの API は `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()`、先頭に純リテラルの `export const meta` が必須 **[文書]**。`opts.model` は Claude のティア指定であり、**Gemini / GPT へは `agentType` で Bash ラッパーエージェントを指すことで到達する**（`opts.model` に gemini/gpt を書いても通らない）。`Date.now()` / `Math.random()` は使用不可。

#### (1) `cashapp-task-loop` — implement → review → verify → fix

```js
export const meta = {
  name: 'cashapp-task-loop',
  description: '1つ以上のタスクを 実装→二段レビュー→裁定→修正→検証 で回す',
  phases: [
    { title: 'Implement', detail: 'task-list.json の各タスクを実装' },
    { title: 'Screen',    detail: 'Gemini 3.8 Flash による一次スクリーニング' },
    { title: 'Adversarial', detail: 'GPT-6 Astra による敵対的レビュー（高リスクのみ）' },
    { title: 'Adjudicate', detail: 'Opus 5.5 が採用/却下を裁定', model: 'opus' },
    { title: 'Fix',       detail: '採用された指摘を修正し検証コマンドを再実行' },
  ],
}

const HIGH_RISK = /^(src\/payments|src\/webhooks|src\/auth|supabase\/migrations|src\/lib\/idempotency)/

const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object',
      properties: { file: {type:'string'}, line: {type:'number'},
                    severity: {enum:['low','medium','high','critical']},
                    claim: {type:'string'} },
      required: ['file','claim','severity'] } },
    needs_deep_review: { type: 'boolean' },
  },
  required: ['findings','needs_deep_review'],
}

const VERDICT = {
  type: 'object',
  properties: {
    status: { enum: ['DONE','DONE_WITH_CONCERNS','BLOCKED','NEEDS_CONTEXT'] },
    accepted: { type:'array', items:{type:'string'} },
    rejected: { type:'array', items:{type:'object',
      properties:{ claim:{type:'string'}, reason:{type:'string'} },
      required:['claim','reason'] } },
    evidence: { type:'array', items:{type:'string'} },  // 実行したコマンドと終了コード
  },
  required: ['status','accepted','rejected','evidence'],
}

const taskIds = args && args.taskIds ? args.taskIds : []
if (!taskIds.length) { log('taskIds が空。docs/task-list.json から未完了タスクを渡すこと'); }

const results = await pipeline(taskIds,
  // 1. 実装
  (id) => agent(
    `docs/task-list.json の task_id=${id} を実装せよ。` +
    `scope 外に触れるな。done_definition を満たし、テストを同一 diff に含めよ。` +
    `verify_commands を実際に実行し、出力と終了コードを報告に含めよ。`,
    { phase: 'Implement', agentType: 'task-executor',
      model: HIGH_RISK.test(String(id)) ? 'opus' : undefined }),

  // 2. Gemini 一次スクリーニング
  (impl, id) => agent(
    `task_id=${id} の変更差分を Gemini 3.8 Flash でスクリーニングせよ。` +
    `実装要約:\n${String(impl).slice(0, 4000)}`,
    { phase: 'Screen', agentType: 'screening-reviewer-gemini', schema: FINDINGS, effort: 'low' }),

  // 3. GPT-6 Astra 敵対レビュー（高リスク or needs_deep_review のときだけ）
  async (screen, id) => {
    const deep = screen && (screen.needs_deep_review ||
      (screen.findings || []).some(f => f.severity === 'high' || f.severity === 'critical' || HIGH_RISK.test(f.file)))
    if (!deep) { log(`task ${id}: 敵対レビューをスキップ（低リスク判定）`); return { screen, adversarial: null } }
    const adv = await agent(
      `task_id=${id} の変更を GPT-6 Astra で敵対的にレビューせよ。` +
      `幻覚APIの実在確認 / テストが仕様でなく実装に合わせられていないか / ` +
      `Webhook の重複・逆順・署名不一致で状態が壊れないか、を具体的なイベント列で示せ。` +
      `一次スクリーニング結果:\n${JSON.stringify(screen)}`,
      { phase: 'Adversarial', agentType: 'adversarial-reviewer-gpt', effort: 'high' })
    return { screen, adversarial: adv }
  },

  // 4. Opus 5.5 が裁定
  (rev, id) => agent(
    `task_id=${id} のレビュー結果を裁定せよ。採用した指摘は修正タスクに、却下した指摘は理由を必ず書け。` +
    `fable-protocol の4値ステータスのいずれかで終えよ。証拠のない主張は「未検証」と明示せよ。\n` +
    JSON.stringify(rev).slice(0, 12000),
    { phase: 'Adjudicate', agentType: 'code-reviewer', model: 'opus', schema: VERDICT }),

  // 5. 修正＋再検証（DONE ならスキップ）
  async (verdict, id) => {
    if (!verdict || verdict.status === 'DONE' || !verdict.accepted.length) return verdict
    return await agent(
      `task_id=${id} について次の指摘を修正し、verify_commands を最初から最後まで再実行して、` +
      `出力全文と終了コードを報告せよ。テストを書き換えて緑にすることは禁止。\n` +
      JSON.stringify(verdict.accepted),
      { phase: 'Fix', agentType: 'quality-fixer', schema: VERDICT })
  },
)

return results.filter(Boolean)
```

#### (2) `cashapp-premortem` — 失敗の先回り（フェーズ境界で再実行）

引継ぎ書の追加要件「想定できるエラー・不具合・ネガティブ事象を先回りする設計」に対応する。**1回で終わらせず、フェーズ境界（設計確定時 / 実装完了時 / パイロット前 / 本番前）で毎回走らせ、前回結果との差分だけを新規リスクとして扱う。**

```js
export const meta = {
  name: 'cashapp-premortem',
  description: '「6か月後に失敗した」前提で失敗原因を洗い出し、検知策と回避策を出す',
  phases: [
    { title: 'Imagine',  detail: '4つの独立レンズで失敗シナリオを生成' },
    { title: 'Screen',   detail: '既知リスクとの重複を除去' },
    { title: 'Judge',    detail: '各シナリオを3視点で検証', model: 'opus' },
    { title: 'Synthesize', detail: '検知策・回避策・担当を付けて統合' },
  ],
}

const LENSES = [
  { id:'legal',   p:'資金決済法・規約違反で事業が止まる経路。L1〜L12 のどれが破れるか。' },
  { id:'payment', p:'決済事業者の審査落ち・商材NG・入金遅延・返金/二重払いで幹事が損をする経路。' },
  { id:'platform',p:'LINEミニアプリ審査落ち・ポリシー改定・LINE本体のグループ支払い機能に食われる経路。' },
  { id:'harness', p:'AIハーネス自身の失敗（幻覚API・完了の過大申告・テスト改変・コンテキスト喪失・コスト暴走）。' },
]
const SCEN = { type:'object', properties:{ scenarios:{type:'array', items:{type:'object',
  properties:{ id:{type:'string'}, title:{type:'string'}, mechanism:{type:'string'},
               severity:{enum:['low','medium','high','critical']},
               early_signal:{type:'string'}, mitigation:{type:'string'} },
  required:['id','title','mechanism','severity','early_signal','mitigation'] } } },
  required:['scenarios'] }

phase('Imagine')
const raw = (await parallel(LENSES.map(l => () => agent(
  `本プロジェクトは6か月後に失敗した。次のレンズでその原因を具体的に書け: ${l.p}\n` +
  `根拠は scratchpad/research/consolidated.md の制約表に接地させよ。推測は推測と書け。` +
  (args && args.previous ? `\n既知リスク（新規のみ出せ）:\n${JSON.stringify(args.previous)}` : ''),
  { phase:'Imagine', label:`premortem:${l.id}`, schema: SCEN, model:'opus' }))))
  .filter(Boolean).flatMap(r => r.scenarios)

// GPT-6 Astra を1レンズとして追加（到達可能になったら有効化）
phase('Judge')
const judged = await parallel(raw.map(s => () =>
  parallel(['起きる確率','検知可能性','回避策の実効性'].map(lens => () =>
    agent(`次のシナリオを「${lens}」の観点で反証せよ。不確実なら refuted=true に倒せ。\n${JSON.stringify(s)}`,
      { phase:'Judge', schema:{type:'object',properties:{refuted:{type:'boolean'},reason:{type:'string'}},
        required:['refuted','reason']} })))
    .then(v => ({ s, survives: v.filter(Boolean).filter(x => !x.refuted).length >= 2 }))))

phase('Synthesize')
const alive = judged.filter(Boolean).filter(x => x.survives).map(x => x.s)
return await agent(
  `次の生き残ったリスクを severity 順に統合し、各項目に「検知策（どのメトリクス/テスト/フックで気づくか）」と` +
  `「担当（AI役割 or 人間）」を付けて docs/risk-register.md 用の Markdown を返せ。\n${JSON.stringify(alive)}`,
  { phase:'Synthesize', model:'opus' })
```

#### (3) `cashapp-release-audit` — リリース前監査

```js
export const meta = {
  name: 'cashapp-release-audit',
  description: 'リリース前に法務・規約・冪等性・受入基準・鍵漏洩を一括監査する',
  phases: [
    { title: 'Audit', detail: '5系統の監査を並列実行' },
    { title: 'Verdict', detail: 'Opus 5.5 が go/no-go を判定', model: 'opus' },
  ],
}

phase('Audit')
const AUDITS = [
  { a:'compliance-gatekeeper',       p:'L1〜L12 / P1〜P9 / N1〜N12 を全件チェックし、抵触箇所をファイル:行で示せ。' },
  { a:'webhook-idempotency-auditor', p:'W1〜W12 を全件チェック。重複・逆順・署名不一致の3テストが実在し、実際に通ることを実行して示せ。' },
  { a:'adversarial-reviewer-gpt',    p:'本番稼働を止める最悪の1点を探せ。見つからないなら「探したが見つからない」と根拠付きで書け。' },
  { a:'screening-reviewer-gemini',   p:'docs/acceptance-checks.json の全 check を実装・テストと突き合わせ、未カバーを列挙せよ。' },
  { a:'general-purpose',             p:'リポジトリ全体に sk_live_ / pk_live_ / CHANNEL_SECRET / SERVICE_ROLE 等の実鍵が混入していないか grep で確認し、結果を貼れ。' },
]
const reports = (await parallel(AUDITS.map(x => () =>
  agent(x.p, { phase:'Audit', agentType:x.a, effort:'high' })))).filter(Boolean)

phase('Verdict')
return await agent(
  `以下の監査結果を読み、リリース go / no-go を判定せよ。` +
  `docs/gates/legal-clearance.json が cleared:true でない限り、本番決済を含むリリースは必ず no-go とせよ。` +
  `判定は fable-protocol の4値ステータスで返し、各主張に証拠（コマンドと出力）を添えよ。\n` +
  reports.join('\n---\n').slice(0, 60000),
  { phase:'Verdict', model:'opus', effort:'max' })
```

**保存先 [文書]**: `~/.claude/workflows/` は現在存在しない。Workflow ツールは `script` をインラインで受け取り、セッションディレクトリへ自動保存してパスを返す。再実行はそのパスを `scriptPath` で渡す。プロジェクト固定にしたければ、返ってきたスクリプトを `.claude/workflows/` にコピーして名前付きで呼ぶ。

### 3-d. CI（GitHub Actions）

`gh` CLI は **[文書]** 認証済み（sawanori）。

```yaml
# .github/workflows/ci.yml
name: ci
on:
  pull_request:
  push: { branches: [main] }

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test:contract      # 重複・逆順・署名不一致（I5）
      - run: npm test                   # 全件
      - run: npm run build

  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      # task-list.json / acceptance-checks.json の整合と、完了申告の裏取り
      - run: node scripts/gate-check.mjs --ci

  test-tamper-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      # 契約テストの改変は必ず人間レビューを要求する
      - name: block silent contract-test edits
        run: |
          if git diff --name-only origin/${{ github.base_ref }}...HEAD | grep -q '^tests/contract/'; then
            echo "::error::tests/contract/** が変更されています。実装を通すためのテスト改変でないことを PR 本文で説明し、label 'test-change-approved' を付けてください。"
            gh pr view ${{ github.event.pull_request.number }} --json labels -q '.labels[].name' | grep -q 'test-change-approved'
          fi
        env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }

  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          ! grep -rnE 'sk_live_|pk_live_|LINE_CHANNEL_SECRET=[A-Za-z0-9]|SUPABASE_SERVICE_ROLE_KEY=[A-Za-z0-9]' --include='*' . \
            || (echo "::error::本番鍵らしき文字列を検出"; exit 1)

  cross-vendor-review:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    continue-on-error: true       # 外部モデル到達不能でCIを止めない（ただし結果は必ず残す）
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: gemini screening
        run: |
          git diff origin/${{ github.base_ref }}...HEAD > /tmp/diff.patch
          npx -y @google/gemini-cli -m gemini-3.8-flash -p "$(cat prompts/review-screen.md)" \
            -o json < /tmp/diff.patch > /tmp/screen.json || echo '{"findings":[],"needs_deep_review":true}' > /tmp/screen.json
          gh pr comment ${{ github.event.pull_request.number }} --body-file /tmp/screen.json
        env: { GEMINI_API_KEY: '${{ secrets.GEMINI_API_KEY }}', GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
```

**[不明]**: `@google/gemini-cli` の npm パッケージ名と CI 上での認証方式（API キー環境変数名）は本セッションで未確認。ローカルは **[実測]** `gemini` コマンドが `~/.local/share/nvm/v22.22.0/bin/gemini` に存在し `gemini-api-key` 認証 **[文書]**。CI 導入前に実際に1回流して確認する。

**リリース用の別ワークフロー（`release.yml`）は `environment: production` を使い、`docs/gates/legal-clearance.json` の `cleared === true` を job の最初のステップで検証して false なら即失敗させる。** これが L11 の CI 側の実装。

### 3-e. `docs/task-list.json` と `docs/acceptance-checks.json` をゲートとして機械的に使う

`plan` スキルが生成するスキーマ **[文書]** をそのまま使い、ハーネス側で3ファイルを足す。

```
docs/
  implementation-plan.md      ← plan スキル
  task-list.json              ← plan スキル（tasks[].verify_commands, done_definition, risk_level）
  acceptance-checks.json      ← plan スキル（checks[].verification_method）
  task-status.json            ← [新] ハーネス所有。{task_id: {status, updated_by, run_log}}
  run-log/<task_id>.json      ← [新] 実際に走らせたコマンド・終了コード・出力先頭/末尾
  external-inquiries.json     ← [新] 照会トラックBの状態
  gates/legal-clearance.json  ← [新] {cleared:false, basis:null, approved_by:null}
  adr/NNNN-*.md               ← technical-designer
  risk-register.md            ← premortem の出力
```

**`scripts/gate-check.mjs` の判定（Stop フックと CI の両方で同じコードを使う）[設計]**

| # | ルール | 違反時 |
|---|---|---|
| G1 | `task-list.json` の全タスクに `done_definition` と `verify_commands` が非空 | fail |
| G2 | 全 `verify_commands` が `package.json.scripts` に実在する（**コマンド捏造の検出**） | fail |
| G3 | `acceptance-checks.json` の各 `check` が、少なくとも1つの `task_id` から参照されている | fail |
| G4 | `task-status.json` で `DONE` のタスクは、`run-log/<task_id>.json` に **全 verify_commands の exit 0 の記録** を持つ | fail（**完了の過大申告の検出**） |
| G5 | `risk_level: high` のタスクが `DONE` なら、`docs/review-log/<task_id>.md` に敵対的レビュー記録が存在する | fail |
| G6 | `DONE_WITH_CONCERNS` のタスクは `concerns[]` に severity と対応案が付いている | fail |
| G7 | `tests/contract/` 配下のファイル数が前回コミットより減っていない | fail（**テスト削除の検出**） |
| G8 | `git diff` に `sk_live_` 等が含まれない | fail |

**G4 が本案の中核。** 「DONE」と書けるのは、run-log にコマンドと終了コードが残っているときだけ。これで fable-protocol の「完了前5ステップゲート」の第2〜4ステップ（実行・読解・確認）をプロンプトではなくファイルで強制する。

---

## 4. タスク実行ループ手順書（1タスクの開始から完了宣言まで）

fable-protocol の4値ステータス（`DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT`）と完了前5ステップゲート **[文書]** を組み込む。

### Step 0 — 着手前（A1 オーケストレーター）
1. `docs/task-status.json` から次の未完了タスクを選ぶ。`dependencies` が全て `DONE` であることを確認する。
2. `docs/gates/legal-clearance.json` を読む。`cleared: false` のとき、選んだタスクが「本番決済有効化」に該当するなら**着手しない**。
3. そのタスクの `files_to_modify` が高リスクパスに掛かるかを判定し、実行者を Sonnet / Opus 5.5 のどちらにするか決める。
4. `docs/task-status.json` に `IN_PROGRESS` と担当モデルを書く。

### Step 1 — 実装（A4 Sonnet または A5 Opus 5.5）
5. `scope` 外のファイルに触れない。`non_scope` を先に読む。
6. テストを同一 diff に含める。決済／Webhook のタスクでは `tests/contract/` の3本（重複・逆順・署名不一致）を必ず更新または追加する（I5）。
7. PostToolUse フックで typecheck / lint が毎編集ごとに走る。赤いまま次の編集に進まない。

### Step 2 — 検証（**完了前5ステップゲート**）
8. **特定** — `verify_commands` のうち、この主張を証明する具体的なコマンドを1つ選ぶ。
9. **実行** — 今、最初から最後まで実行する。過去の実行結果の流用は不可。
10. **読解** — 出力全文と終了コードを読み、失敗数を数える。
11. **確認** — 出力が本当に主張を裏付けているか照合する。
12. **記録** — `docs/run-log/<task_id>.json` にコマンド・終了コード・出力の先頭/末尾を書く（G4 の入力）。
    いずれかを飛ばした場合、その主張は「未検証」と明示する。

### Step 3 — 二段レビュー（A7 → A8）
13. Gemini 3.8 Flash が差分を一次スクリーニング（全件・安価）。
14. `severity >= medium` または高リスクパスに触れたら GPT-6 Astra が敵対的レビュー。**§2-4 のブロッカーが未解消なら、この手順は `BLOCKED` として記録し、Gemini を反証モードで代替した旨を明記する（成功を偽装しない）。**

### Step 4 — 裁定（A9 Opus 5.5）
15. 指摘を採用／却下。却下は理由を `docs/review-log/<task_id>.md` に残す（黙殺しない）。
16. 採用分を修正タスクとして `task-list.json` に追記するか、その場で A6 が直す。

### Step 5 — 完了宣言
17. `npm run test:contract` と `node scripts/gate-check.mjs` を通す（Stop フックが自動で走る）。
18. 4値のいずれかを宣言する。「だいたい完了」は存在しない。
    - `DONE` — 全主張に run-log の証拠あり。テストは同一 diff に含まれる。
    - `DONE_WITH_CONCERNS` — 各懸念に severity と対応案を付す（G6）。
    - `BLOCKED` — 何にブロックされ、何を試したかを明記。
    - `NEEDS_CONTEXT` — 不足している情報を具体的に名指しする。
19. `docs/task-status.json` と `docs/PROGRESS.md` を更新し、コミットする。
20. ターン終了規律 — 「これから X します」で終わらない。最終段落が計画や約束になっていたら、終了せず今すぐ実行する。

---

## 5. 外部人間の役割と関与タイミング

| フェーズ | 何を作っているか | 関与する外部人間 | 具体的なアクション | 出ないと止まるもの |
|---|---|---|---|---|
| **P0: 照会（今すぐ・並走）** | 何も実装しない | H4 PayPay / H5 Stripe / H2 弁護士 / H6 LINEヤフー | §5-1 質問1〜3、§5-2 質問2〜4、§5-4 質問1〜4、§5-3 質問1〜3 を送付 | 決済事業者の確定（候補A〜Gの選択） |
| **P1: Provider 非依存コア** | アダプタ IF、台帳、冪等基盤、LIFF 外殻、テスト | （不要） | — | 何も止まらない。**ここを先にやる** |
| **P2: サンドボックス結線** | PayPay `env:"STAGING"`（I6）／Stripe test mode | H4（サンドボックス発行が要る場合） | サンドボックス資格情報の取得 | 決済の疎通テスト |
| **P3: 法務レビュー** | 利用規約・プライバシーポリシー・同意フロー（L5, L6, L7） | **H2 弁護士（必須）** | §5-4 質問1〜11 の回答。必要なら金融庁グレーゾーン解消制度へ照会 | **本番決済の有効化（L11）** |
| **P4: ミニアプリ審査** | LIFF エンドポイント、プロバイダー設計（N1, N6） | H6 LINEヤフー | 未認証で先行し、認証が要る段階で申請 | 一般公開 |
| **P5: パイロット** | サンドボックスまたは少額本番 | **H7 パイロット幹事 3〜5名** | 実イベントで使ってもらう。誤照合・UI 詰まりの実例を集める | 本番拡大の判断 |
| **P6: 収益化検討** | 手数料設計 | H3 税理士 | 売上計上・インボイス・手数料負担者（P5 制約） | 課金開始 |
| **随時** | UI トンマナ | H8 デザイン（noritaka 内製） | `frontend-design` / `web-typography` スキル適用 | — |

**noritaka（H1）のタイムボックス目安 [設計]**: P0 の照会送付に初週 3〜4 時間、以後は週1回 60〜90 分のレビュー枠（§8）＋ エスカレーション対応。実装自体には入らない。

**弁護士（H2）の関与は「1回の相談」ではなく「2回」**。1回目は §5-4 の質問1〜4（構成が資金移動業に当たるか）、2回目は規約・同意フローのドラフトレビュー。1回目の回答で設計が変わるので、規約ドラフトを先に作って持ち込まない。

---

## 6. コミュニケーションと引継ぎ

### 6-1. 3つの常設ドキュメント

| ファイル | 誰が書く | 何を書く | 更新タイミング |
|---|---|---|---|
| `docs/PROGRESS.md` | 各タスク完了時に実行エージェント | タスクID・4値ステータス・実行した検証コマンドと終了コード・残課題 | 毎タスク |
| `docs/HANDOFF.md` | セッション終了時に A1 | 「次のセッションが最初に読む1ページ」。現在地・次の1手・未解決の照会・踏んではいけない地雷 | セッション終了時／compact 前 |
| `docs/adr/NNNN-title.md` | A2（technical-designer） | 決定・文脈・検討した選択肢・**却下理由**・一次資料URLと取得日 | 決定のたび |

**ADR は「決めたこと」だけでなく「決められなかったこと」も書く。** 照会待ちの論点は `status: proposed` のまま残し、回答が来たら `accepted` / `superseded` に更新する。consolidated.md §5 の未確認項目が ADR の初期在庫になる。

### 6-2. モデル間の受け渡しフォーマット

異なるベンダーのモデルに渡すときは、リポジトリ文脈が無い前提で**自己完結した封筒**を作る。

```json
{
  "envelope_version": 1,
  "from": "claude-sonnet",
  "to": "gpt-6-astra",
  "purpose": "adversarial_review",
  "task_id": "task_014",
  "context": {
    "what_this_repo_is": "LINEミニアプリの会費集金台帳。運営者は資金に触れない（制約L1）。",
    "constraints_in_force": ["L1","L2","W1","W2","W3","W4","P2","P3","P9"],
    "known_unknowns": ["PayPayのWebhook署名検証の有無（P/W7）","Stripe C2C条項の射程"]
  },
  "artifact": { "type": "git_diff", "base": "origin/main", "head": "HEAD" },
  "question": "重複・逆順・署名不一致で状態が壊れる具体的なイベント列を示せ。",
  "output_contract": {
    "schema": "FINDINGS",
    "rules": ["問題なしで終わらせない", "推測は推測と書く", "存在しないAPIメソッドを指摘に使わない"]
  }
}
```

**受け取り側の出力も必ず同じ封筒に包んで返す**（`from`/`to` を入れ替え、`findings` を載せる）。封筒は `docs/review-log/<task_id>.md` にそのまま貼る。これでどのモデルが何を言ったかが後から追える。

### 6-3. 一次資料の扱い

**[実測] 本セッションでは context7 MCP が CONNECTION_CLOSED で接続できない。** ユーザーのグローバル規範はライブラリ資料を context7 で取ることを求めているが、落ちている間は代替が要る。

代替ルール [設計]:
- 決済・LIFF の仕様は `docs/vendor-docs/<provider>/<topic>.md` にスニペットを**取得日つき**で保存し、実装はそこを参照する。
- **実際にフェッチしていない URL を引用しない。** ADR の参考文献には「取得日」を必須にする。
- context7 が復帰したら、保存済みスニペットを再取得して差分を確認する（これ自体を週次タスクにする）。

---

## 7. ハーネス自体の失敗モードと対策

| # | 失敗モード | 具体的な現れ方（本プロジェクト固有） | 検知 | 対策 |
|---|---|---|---|---|
| F1 | **幻覚 API** | PayPay SDK に存在しないメソッドを呼ぶ。Stripe の `paypay_payments` ケイパビリティを実在扱いする（consolidated §5-2 質問4 の通り**存在しない**）。LIFF の API を推測で使う | GPT-6 Astra 敵対レビューの重点項目1。typecheck。`docs/vendor-docs/` との突合 | SDK 呼び出しは全てアダプタ層に閉じ込め、アダプタのテストは録画済みレスポンス fixture で書く。context7 復帰後は必ず再確認 |
| F2 | **完了の過大申告** | 「Webhook 冪等性を実装しました」と書くが重複テストを実行していない | **G4（run-log に exit 0 の記録が無い DONE は fail）** | Stop フックで `gate-check.mjs`。4値ステータスの強制。証拠（コマンド＋終了コード）の添付を報告テンプレに含める |
| F3 | **テスト改変** | 落ちる契約テストを緩めて緑にする。`tests/contract/` を削除する | PreToolUse の `guard-write.mjs`（`tests/contract/**` の書き換え拒否）、CI の `test-tamper-guard` job、G7 | 契約テスト3本は「人間ラベル承認がないと変えられない」資産にする。fable-protocol の「テストが誤っていれば回避せず報告する」を subagent-snippet で全エージェントに貼る |
| F4 | **コンテキスト喪失** | compact 後に「照会トラックBが未回答」を忘れて決済事業者を決め打ちする | SessionStart フックの `session-brief.mjs` が毎回 `external-inquiries.json` と `legal-clearance.json` を注入 | `HANDOFF.md` の運用。広いコード探索はサブエージェントに委譲して結論だけ受け取る（コンテキスト防火壁） |
| F5 | **MCP 停止** | **[実測] 本セッションで context7 / codex / figma / magic / vfx-mcp が接続失敗。** Stripe / Supabase プラグインは未認証 | セッション開始時の MCP 接続エラー通知 | §6-3 の `docs/vendor-docs/` 退避。MCP が落ちている間は「MCP が落ちている」と明示して代替経路を使い、**能力が無いとは書かない** |
| F6 | **モデル不達** | **[実測] `codex exec` が `~/.codex/hooks/block-non-claude-model.sh` にブロックされ GPT-6 Astra に到達できない** | ラッパーエージェントが到達失敗を `BLOCKED` で返す | §2-4 の設定作業（noritaka 承認）。未解消の間は Gemini 反証モードで代替し、その旨を review-log に明記 |
| F7 | **コスト暴走** | Opus 5.5 を量産実装に回す。premortem を毎ターン回す。Workflow の loop-until-dry が止まらない | Workflow の `budget.total` / `budget.spent()`。週次の AI コスト計測（§8） | 既定は Sonnet。Opus は設計・裁定・ゲートのみ。スクリーニングは Gemini Flash。`effort: 'low'` を機械的ステージに明示。同時実行は Workflow の並行上限（min(16, CPU-2)）に任せる |
| F8 | **L11 の踏み越え** | AI が本番 Stripe キーで疎通テストしてしまう | `guard-bash.mjs`（`sk_live`/`--live`/`PAYPAY_ENV=PROD` を `legal-clearance.cleared` が true でない限り拒否）、`release.yml` の gate step | 本番鍵はローカルに置かない。CI の `environment: production` シークレットにのみ置く |
| F9 | **レビューの形骸化** | Gemini が毎回「問題なし」を返し、誰も読まない | 週次で「レビュー差し戻し率」を計測（§8）。0% が続いたらプロンプトが壊れている | レビュープロンプトに「問題なしで終わらせない。最低1つの攻撃シナリオ」を入れる。月1回、既知バグを混ぜた diff で検知率を測る（レビュアの健全性テスト） |
| F10 | **単一人間のボトルネック** | noritaka の承認待ちで全部止まる | `task-status.json` に `WAITING_HUMAN` が滞留 | エスカレーションを3種類に限定（破壊的操作の直前／真のスコープ変更／本人しか出せない情報）。それ以外は AI が推奨1つを出して進める |
| F11 | **調査結果の陳腐化** | consolidated.md の確信度「低」の 64 件が未検証のまま設計前提になる | ADR に「根拠の確信度」欄を必須化 | 確信度「低」の主張に依存する設計は ADR で `status: proposed` 止まりにし、実装のブロッカーとして task-list に載せる |

---

## 8. 週次リズムと計測指標

### 8-1. 週次リズム（noritaka の稼働は週 60〜90 分）

| 曜日 | 誰 | 何を |
|---|---|---|
| 月 | A1（AI） | 先週の `task-status.json` を集計し `docs/PROGRESS.md` の週次サマリを生成。今週のタスク候補を3〜5件提示 |
| 月 | H1 noritaka | 30分: 今週のタスク承認、エスカレーション裁定、照会トラックBの進捗確認 |
| 火〜木 | AI 群 | `cashapp-task-loop` を回す。noritaka は非同期でレビュー通知のみ |
| 金 | A14 | `cashapp-premortem` を前回結果との差分モードで実行し `docs/risk-register.md` を更新 |
| 金 | H1 noritaka | 30〜60分: リスク差分レビュー、ADR 承認、外部回答の反映判断、`HANDOFF.md` 確認 |
| 隔週 | A1 | `cashapp-release-audit` をドライランし、リリース可否の距離を測る |
| 月次 | H1 | 既知バグ混入 diff でレビュアの検知率テスト（F9 対策）。モデル配置の見直し |

### 8-2. 計測指標（全て `docs/metrics/weekly-<ISO週>.json` に記録）

| 指標 | 定義 | 目標 | 取得元 |
|---|---|---|---|
| **レビュー差し戻し率** | 裁定で「採用」された指摘があった PR ÷ 全 PR | 15〜40%（0% はレビューの形骸化、50%超は実装プロンプトの欠陥） | `docs/review-log/` |
| **ベンダー別検知寄与** | Gemini 単独検知 / GPT 単独検知 / 両方 の件数 | GPT 単独検知が 0 件ならレビュー階層を統合してコスト削減 | 同上 |
| **ゲート通過率（初回）** | 初回の `gate-check.mjs` で pass したタスク ÷ 全タスク | 70%以上。低ければ done_definition が曖昧 | `docs/run-log/` |
| **G4 違反件数** | 「DONE と書いたが run-log が無い」件数 | **0 件**（1件でも出たら報告規律の再教育） | `gate-check.mjs` |
| **契約テスト実行率** | `test:contract` が exit 0 で終わったターン ÷ 全ターン | 95%以上 | Stop フックのログ |
| **テスト網羅（分母を明示）** | ①`acceptance-checks.json` の automated check のうち実テストが存在する割合 ②`src/payments`/`src/webhooks` の行カバレッジ | ① 90%以上 ② 80%以上。**全体カバレッジは指標にしない**（意味が薄い） | vitest coverage |
| **AI コスト** | 週の出力トークン量（モデル別）。Workflow の `budget.spent()` と各 CLI のログ | Opus 比率 30%以下、Gemini 比率 40%以上 | Workflow ログ、`gemini`/`codex` のセッションログ |
| **人間ボトルネック時間** | `WAITING_HUMAN` の滞留時間中央値 | 48時間以内 | `task-status.json` のタイムスタンプ |
| **照会トラックB の進捗** | `external-inquiries.json` の `answered` / 全件 | P0 の4件を4週以内に answered | 同ファイル |
| **プレモータム新規リスク数** | 週ごとの新規 High 以上 | 減少傾向。増え続けるなら設計が発散している | `risk-register.md` の差分 |

---

## 9. この案の既知の弱点（正直な申告）

1. **GPT-6 Astra が現時点で到達不能 [実測]。** §2-4 の設定作業が終わるまで、ベンダー横断レビューは「Claude＋Gemini」の2社体制にしかならない。3社体制を前提にした差し戻し率の目標値は、到達後に測り直す必要がある。
2. **各モデルの単価・コンテキスト長が不明 [不明]。** コスト配分の目標（Opus 30%以下等）は根拠のある数字ではなく初期仮置きである。2週間実測してから見直す。
3. **`gate-check.mjs` / `guard-bash.mjs` / `session-brief.mjs` は未実装 [設計]。** これらは task_001〜003 として task-list.json の先頭に置かないと、ハーネス全体が絵に描いた餅になる。**ハーネスの実装を機能実装より先にやる。**
4. **PreToolUse の JSON ブロック形式のフィールド名が未確認 [不明]。** 終了コード 2 による遮断は共通仕様なのでそちらを先に使い、JSON 形式は `/update-config` スキルで確認してから移行する。
5. **CI での Gemini 実行方法が未確認 [不明]。** ローカル CLI は疎通済みだが、GitHub Actions 上のパッケージ名・認証は1回流して確かめるまで確定させない。
6. **consolidated.md の 64 件が未検証のまま [文書]。** 特に PayPay 加盟店資格・手数料・Stripe Connect×PayPay・資金移動業登録要件は、設計の根幹に効くのに確信度が低い。ADR でこれらに依存する決定は `proposed` 止まりにする運用が必要で、T1 はその運用を組み込んだが、**運用が守られるかはフックで強制できていない**（人間規律に依存する残存リスク）。
