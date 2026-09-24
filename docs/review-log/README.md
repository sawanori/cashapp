# docs/review-log/

敵対レビューの封筒と判定の保存先。`docs/implementation-plan.md` §16-5 / task_007 /
`check_066` / R-TH-03 / R-TH-08 / R-TH-11 / R-TH-13。

**1 タスク 1 ファイル**（`docs/review-log/<task_id>.json`）。中身は JSON 配列で、
`scripts/merge-review.sh` が 1 周ごとに追記する。人が手で書くファイルではない。

## なぜファイルが要るのか

`scripts/gate-check.mjs` の G5 が読む。`risk_level: high` かつ
`adversarial_review: required` のタスクが完了状態になったとき、G5 は
`docs/review-log/<task_id>.json` に次のどちらかがあることを確かめる。

- **(a) finding 封筒** — `model_id_actual` / `cli_version` / `backend` を持つエントリ
- **(b) 欠票記録** — `reviewer_route: "unavailable"` のエントリ（試行コマンド・不達理由・日時つき）

(b) を認めているのは、経路が通らないことを隠して「レビュー済み」にする逃げ道を塞ぐためである
（R-TH-03 / F6）。**欠票は欠票として残す。残した上で「3 ベンダー体制」と称さない。**

G5 は task_007（本経路の実装）が完了状態になるまで warn、それ以降はブロッキングになる。

## 生成の流れ

```
# 封筒を作る。--base / --head を必ず渡す（既定は「HEAD と作業ツリーの差分」なので、
# 並行タスクの未コミットファイルまで混ざる）
scripts/build-review-packet.sh <task_id> --base <親> --head <自分のコミット> --out packet.json
node scripts/review-gemini.mjs --packet packet.json --out gemini.json
node scripts/review-gpt.mjs    --packet packet.json --out gpt.json
node scripts/validate-findings.mjs gemini.json --json        # 単体検証（任意）
bash scripts/merge-review.sh <task_id> gemini.json gpt.json  # 判定して追記
```

**封筒のサイズはレビューの成否に効く** [実測 2026-09-24]。265KB の封筒（同梱 17 ファイル /
diff 150KB）は `gemini-2.5-pro` が 900 秒で応答を返さずタイムアウトし、76KB に絞ると
同じモデルで返った。`--max-file-bytes`（既定 200000）と `--max-diff-bytes`（既定 120000）で
切り詰められる。切り詰めた事実は `artifact.truncated_files` / `artifact.diff_truncated` /
`artifact.diff_bytes_total` として封筒に残るので、黙って短くなることはない。
同梱したバイト数は `metrics.payload_bytes` にある（R-TH-10 の代理指標）。

`merge-review.sh` の終了コード: `0` = pass / `1` = 差し戻し（実効 high が 1 件以上）/
`3` = レビュー不成立（有効票 0、または無効な封筒あり）/ `64` = usage。

## エントリの形

封筒 1 通につき 1 エントリ。末尾に `type: "summary"` の判定が 1 件付く。

| フィールド | 意味 |
|---|---|
| `schema_version` | 1 固定 |
| `task_id` / `reviewer` / `vendor` | 対象タスク、エージェント名、ベンダー（gemini / gpt / claude） |
| `reviewer_route` | `verified` / `cli-fallback` / `unavailable` / `model_mismatch` |
| `model_id_actual` / `model_id_source` | 実際に応答したモデル ID と、その出どころ（`cli_stats` = 観測 / `self_report` = 自己申告） |
| `cli_version` / `backend` | ラッパーが観測した CLI バージョンと応答元 |
| `verdict` | `PASS` / `FAIL` / `BLOCKED` / `UNKNOWN` |
| `findings[]` | `id` / `severity` / `title` / `detail` と、`effective_severity`（降格後） |
| `unavailable_reason` / `attempted_command` | `reviewer_route: "unavailable"` のとき必須 |
| `classification` | `vote` / `missing_vote` / `invalid` / `invalid_review` |
| `validation` | `validate-findings.mjs` の errors / warnings / downgrades / counts |

## 降格の規則（`scripts/validate-findings.mjs` が機械的に適用する）

1. **repro の無い `high` は `info` へ落ちる**（R-TH-08）。diff しか見ないレビュアが
   「別ファイルで担保済み」の事項を high で指摘し、task-loop が 3 周する事故を止めるため。
2. **`vendor: "gemini"` の `high` / `medium` は citation（逐語引用 + URL + 取得日）が無いと
   `unknown` へ落ちる**。敵対レビュー A の役割は一次資料の照合であり、引用を出せない
   事実主張は「不明」である（§16-2）。
3. `model_id_actual` が `docs/metrics/model-bench.md`（task_010 が作る）の合格モデル一覧に
   無ければ `reviewer_route` が `model_mismatch` になり、そのレビューは票にならない（R-TH-11）。
   一覧が無い間は「未照合」の警告だけが出る。

## 経路の実測（2026-09-24、task_007）

| 経路 | 結果 |
|---|---|
| Gemini（`gemini -o json -m <model> -p …`、CLI 0.38.1） | **通る**。`stats.models` のうち `roles.main` を持つキーが応答モデル ID として観測できる。`-m gemini-2.5-pro` は実測で反映された（`model_id_actual` = 指定値）。`-m` 無指定では `gemini-3-flash-preview` が main、`gemini-2.5-flash-lite` が utility_router になった |
| GPT-6 Astra（`codex exec --json -m gpt-6-astra`、codex-cli 0.154.0） | **通らない**。`~/.codex/hooks/block-non-claude-model.sh` が UserPromptSubmit で非 Claude モデルを遮断する。症状は「**exit 0 のまま、エージェントの応答が 1 件も返らない**」。イベントは `thread.started` / `turn.started` / `item.completed`(type=error, skills の警告) / `turn.completed`(トークン 0) のみ。`--output-last-message` の出力は 0 バイト。終了コードだけを見ると成功に見えるので、`review-gpt.mjs` は**応答本文の有無だけ**を成立判定に使う |
| codex の応答モデル ID | `--json` のイベントに**含まれない** [実測]。よって観測できず、自己申告しか根拠が無い。`review-gpt.mjs` は自己申告のとき `reviewer_route: "cli-fallback"` ＋ `model_id_source: "self_report"` を付け、`verified` と区別する |

codex フックの解除は PO の承認事項（task_010 / R-TH-03）。**AI は解除してはならない。**
