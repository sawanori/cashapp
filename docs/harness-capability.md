# ハーネス実在マトリクス（フック 6 イベント × 遮断挙動）

`docs/implementation-plan.md` §16-4 / task_006 / `check_065` / `R-TH-12`。

「フックを登録した」ことと「フックが効いている」ことは別である。前者は `.claude/settings.json`
を読めば分かるが、後者は実際に発火させるか、発火した痕跡を見ないと分からない。本書は後者を
記録する。**推測で埋めた欄は無い。** 再測定は `scripts/test-hook-enforcement.sh`。

## 測定条件

| 項目 | 値 |
|---|---|
| 測定日時 | 2026-09-24（UTC） |
| 測定コマンド | `bash scripts/test-hook-enforcement.sh`（exit 0） |
| Claude Code | `claude` 2.1.257（`claude --version` [実測]） |
| ホスト | darwin 25.5.0 / bash 3.2 / node v22.22.0 |
| 設定 | `.claude/settings.json`（プロジェクト単位のオプトイン。`PreCompact` は未登録） |
| 測定セッション | 本リポジトリの Claude Code セッション群（`~/.claude/projects/-Users-noritakasawada-AI-P-cashapp/**.jsonl`、228 ファイル） |

測り方は 3 階層:

- **A 登録** — `.claude/settings.json` に何がどの matcher で登録されているか。
- **B 単体挙動** — 登録されたコマンドそのものにフック入力 JSON を stdin で渡し、終了コードを見る。
- **C ライブ痕跡** — 実セッションの transcript と、フックが残すファイルの副作用を数える。
  **C が本体である。** A と B だけでは「Claude Code が実際にこのイベントを発火させるか」は分からない。

## マトリクス

| イベント | A 登録 [実測] | B 単体挙動 [実測] | C ライブ発火 [実測] | ツール実行を止められるか [実測] |
|---|---|---|---|---|
| `SessionStart` | `node scripts/session-brief.mjs`（matcher なし） | exit 0。`hookSpecificOutput.hookEventName=SessionStart` と `additionalContext` を持つ JSON を stdout に出す | transcript に `hookName:"SessionStart*"` の注入記録 **12 件**（`SessionStart:startup` / `SessionStart:resume` を含む）。task_005 がヘッドレス新規セッション `e3bbac37…` の transcript で注入テキスト 63 行 9085 bytes を逐語確認 | 止められない（プロンプト前の注入専用）。止める必要のある判断はこのイベントに置かない |
| `UserPromptSubmit` | `node scripts/gate-status.mjs`（matcher なし） | exit 0。`hookSpecificOutput.hookEventName=UserPromptSubmit` と `additionalContext` | transcript に `hookName:"UserPromptSubmit"` の注入記録 **45 件** | 止められない（注入専用）。`gate-status.mjs` は常に exit 0 で返す契約にしてある（読み取り失敗でプロンプトを拒否しないため） |
| `PreToolUse`（`Bash`） | `bash scripts/deny-dangerous-bash.sh` | 保護ツリーの再帰削除 → **exit 2**。`git status --short` → exit 0 | transcript に `PreToolUse:Bash hook` **173 件**。本セッションでも `python3 -c` による `docs/acceptance-checks.json` 参照が実際に遮断され、コマンドは実行されなかった | **止められる。** exit 2 でツール呼び出し自体が行われない（本セッションで直接観測） |
| `PreToolUse`（`Edit｜Write｜MultiEdit｜NotebookEdit｜mcp__serena__.*`） | `bash scripts/deny-test-weakening.sh` | `docs/run-log/**` への Write → **exit 2**。通常の `src/**` の Write → exit 0 | transcript に `PreToolUse:Write hook` **21 件** / `PreToolUse:Edit hook` **3 件** / `PreToolUse:mcp__*` **11 件**。本セッションでも `docs/acceptance-checks.json` 名のフィクスチャ、`docs/gates/**`、`docs/run-log/**` への Write が実際に遮断された | **止められる。** exit 2 で書き込みが行われない（本セッションで直接観測） |
| `PostToolUse`（`Edit｜Write｜MultiEdit`） | `npm run typecheck` / `lint:changed` / `gate:constraints` / `gate:plan`（gate:plan は task_006 で追加） | 実行時のリポジトリ状態に依存するのでスクリプト側に期待値は置かない。測定時は typecheck exit 1 / lint:changed exit 0 / gate:constraints exit 1 / gate:plan exit 0（exit 1 の 2 本はいずれも並行タスク task_012 の未コミット変更が原因） | 本セッションで `PostToolUse:Edit hook blocking error from command: "... npm run --silent typecheck"` を直接受け取った。ただし**フックが exit 0 のときは transcript に何も残らない** | **ツールの実行そのものは止められない**（編集は既に適用済み）。返せるのは「実行後の差し戻し」であり、止める必要があるものはこのイベントに置かない（→ 下の「寄せ先」） |
| `Stop` | `bash scripts/append-handoff.sh` ＋ `npm run gate:check`（gate:check は task_006 で追加） | `append-handoff.sh` exit 0、使い捨てディレクトリに `docs/HANDOFF.md` の「ターンログ」節と 1 行を作った | `docs/HANDOFF.md` のターンログが **46 行**（最終 2026-09-24T06:59:43Z）。task_005 が実セッション 3 ターンで「1 ターン 1 行」の対応を確認（16→17→18 行） | 止められる（exit 2 で停止をブロックする）。ただし `gate:check` は **exit 1** で返す実装にしてある。停止をブロックすると、ゲートが直らない限りセッションが終われない罠になるため |
| `SubagentStop` | `bash scripts/assert-diff-exists.sh` | exit 0。使い捨ての git リポジトリで `.locks/subagent-head-baseline-<session_id>` を書いた | `.locks/subagent-head-baseline-f9bfc039-…`（本セッションの `session_id` キー）が **存在し 2026-09-24T06:56:06Z に更新**。このファイルを書くのは `assert-diff-exists.sh` だけなので、本セッションでサブエージェント終了ごとに発火していることの直接の痕跡である | 止められる（exit 2）。ただし `assert-diff-exists.sh` は**報告に留める**（常に exit 0）。読み取り専従のサブエージェントは差分ゼロで終わるのが正しく、exit 2 は正常動作の側で鳴りやすい |

### C の数値についての注意 [実測]

transcript の件数は固定文字列の出現回数であり、**これらの文字列を検索したコマンド行そのもの
（本タスクの調査 Bash）も数に含まれる**。したがって上の件数は「この種の遮断が実セッションで
起きている」ことの指標であって、正確な遮断回数ではない。イベントが発火するという判定の根拠は
件数ではなく、本セッションで直接観測した遮断・差し戻し（`PreToolUse:Bash` / `PreToolUse:Write` /
`PostToolUse:Edit`）と、`.locks/subagent-head-baseline-<session_id>` の副作用である。

### 本セッションで観測できなかったこと [実測]

- `SessionStart` と `UserPromptSubmit` は**このセッション（サブエージェント）では新たに観測できない**。
  セッションは既に始まっており、ユーザープロンプトの注入はサブエージェントには届かない。
  両イベントの発火は task_005 がヘッドレス新規セッション 2 本（`e3bbac37…` / `4a06740d…`）の
  transcript で確認済みで、その記録は `docs/run-log/task_005.json` の manual エントリにある。
- `Stop` は**サブエージェントのターン終了では追記されない**。ターンログの最終行は本セッションの
  作業開始前（06:59:43Z）のままである。サブエージェントの終了に対応するのは `SubagentStop` で、
  そちらは上記のとおり本セッションで発火している。

## 使えないイベント分の寄せ先

| 置きたかったもの | 置けないイベント | 実際の置き場 | 理由 |
|---|---|---|---|
| 壊れたコードの持ち越し防止 | `PostToolUse`（実行後にしか鳴らない） | `Stop` の `npm run gate:check` ＋ CI の `static` / `gate-meta` / `acceptance` ジョブ（task_009） | `PostToolUse` は編集が済んだ後に差し戻すだけで、書き込み自体は止まらない。止める必要のある規則（テスト弱体化・run-log 直書き・ゲート定義の書き換え）は全部 `PreToolUse` 側に置いてある |
| 圧縮前の文脈保存 | `PreCompact`（本プロジェクトでは未登録） | `Stop` の `append-handoff.sh` による毎ターン追記 | `PreCompact` は圧縮が起きたときにしか鳴らない。鳴らなければ何も残らないので、毎ターン確実に鳴る `Stop` に寄せた（§16-4 / F4） |
| 完了報告の裏取り | `SubagentStop`（正常動作でも鳴る） | `docs/run-log/**` を `record-run.sh` 以外から書けなくすること（`PreToolUse`）＋ CI の `verify_commands` 再実行（task_009）＋ G4 / G9 | 読み取り専従のサブエージェントは差分ゼロで終わるのが正しいので、`SubagentStop` の exit 2 は誤検知が多い。`assert-diff-exists.sh` は報告のみに留め、ブロックする検査は別の層に置いた |
| セッション開始時の状態注入の強制 | `SessionStart`（止められない） | 注入内容を `session-brief.mjs` が常に出す（読み取り失敗でも exit 0） | 注入に失敗してもセッションは始まってしまう。始まらなくする手段が無い以上、注入の欠落は `UserPromptSubmit` の `gate-status.mjs` が毎プロンプトで補う二重化にしてある |
| 本番デプロイの禁止 | どのフックも CI を止められない | ローカルは `PreToolUse(Bash)` が常時遮断、本番は `.github/workflows/release.yml` の 2 段ゲート（task_009） | フックはローカルのツール呼び出ししか見られない。CI から実行されるものはフックの射程外である（§16-6） |

## 敵対レビュー経路の可否 [実測]

`docs/implementation-plan.md` §11-1 は本書に「敵対レビュー経路の可否」も記録することを求めている。
task_006 の時点で測れたのは**到達手段の実在まで**であり、実際にレビューを 1 往復させた記録は
task_007（経路実装）と task_010（到達可能な実モデルの確定）の担当である。

| 経路 | 測定結果 |
|---|---|
| `claude` CLI | `/opt/homebrew/bin/claude` 2.1.257 [実測] |
| `codex` CLI | `/Users/noritakasawada/.local/share/nvm/v22.22.0/bin/codex` codex-cli 0.154.0 [実測] |
| `gemini` CLI | `/Users/noritakasawada/.local/share/nvm/v22.22.0/bin/gemini` 0.38.1 [実測] |
| `gh` CLI | `/opt/homebrew/bin/gh` [実測]。GitHub リモートは未作成（PO 判断待ち）なので CI 経由の経路は未実走 |
| `wrangler` CLI（PATH 上） | PATH には無い [実測]。devDependency としては導入済みで `npx wrangler` で到達する（task_003） |
| MCP 経由（codex / context7 / 他） | 本セッションでは `codex` / `context7` / `figma-dev-mode` / `magic` / `obsidian-mcp-tools` / `vfx-mcp` が接続失敗（`CONNECTION_CLOSED` 等）[実測]。接続断であって「能力が無い」ではない（F5） |

`model_id_actual` / `cli_version` / `backend` / `reviewer_route` を伴う実レビューの往復、および
`reviewer_route: unavailable` の欠票記録の形式は task_007 が定める。**それまで G5（敵対レビュー
記録の必須化）は warn であり、`gate-check.mjs` はその猶予を task_007 の `completion_status` から
機械的に決める**（`tests/gates/fixtures/violations/g5-missing-review-log` が猶予の外れ方を固定している）。

## 再測定

```sh
scripts/record-run.sh <task_id> bash scripts/test-hook-enforcement.sh
```

`.claude/settings.json` を変更したとき、Claude Code を更新したときは測り直すこと。
本書の数値は測定日時つきの実測値であり、更新せずに引用してはならない。
