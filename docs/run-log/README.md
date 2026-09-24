# docs/run-log/

証拠つき実行記録。各タスクの検証コマンド・人手確認の結果を機械可読な形で保持する。

## 書き込み経路

**このディレクトリへの書き込みは `scripts/record-run.sh` 経由のみを正とする（R-TH-02）。**
手で JSON を編集・追記しない。将来 `task_005` が `PreToolUse(Edit|Write)` フックでこのディレクトリへの
直接書き込みを機械的に遮断するまでは強制はされないが、規約として厳守する。

```sh
# 検証コマンドを実行して記録する（実 exit code を記録し、同じ exit code で終了する）
scripts/record-run.sh <task_id> <command...>

# 自動化できない人手確認を記録する
scripts/record-run.sh --manual <task_id> "<観察結果>"
```

## ファイル形式

`docs/run-log/<task_id>.json` は JSON 配列。1 回の記録につき 1 要素が追記される。

コマンド実行の要素:

```json
{
  "type": "command",
  "command": "npm run test:unit",
  "exit_code": 0,
  "stdout_tail": "...(最後の40行)...",
  "commit": "<git rev-parse HEAD>",
  "ran_at": "2026-09-24T03:02:21Z",
  "by": "<実行者@ホスト>"
}
```

人手確認の要素:

```json
{
  "type": "manual",
  "observation": "<観察結果>",
  "commit": "<git rev-parse HEAD>",
  "ran_at": "2026-09-24T03:02:21Z",
  "by": "<実施者@ホスト>"
}
```

- `stdout_tail` は標準出力・標準エラーを結合した末尾 40 行のみを保持する。全文はコマンド実行時に呼び出し元の
  ターミナルへそのまま出力される（`record-run.sh` はサイレントラッパーではない）。
- `commit` は記録時点の `git rev-parse HEAD`。CI の acceptance ジョブは `evidence.commit === HEAD`（G9）を検査する。
- 同一 `task_id` への同時書き込みは `.locks/run-log/<task_id>.lock`（mkdir ベース排他、最大 30 分待ち）で直列化する。

## CI との関係

CI の acceptance ジョブは run-log を信用せず、`verify_commands` を自分でもう一度実行する（R-TH-02 の対策）。
run-log は「実行した証拠」であって「合格の証明」ではない。
