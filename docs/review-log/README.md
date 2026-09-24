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
`3` = レビュー不成立（有効票 0、無効な封筒あり、または宛先違いの封筒あり）/ `64` = usage。

**作者の自己申告（`docs/concerns/**` / `docs/HANDOFF.md` / `docs/PROGRESS.md`）は封筒の
レビュー対象に入らない。** `build-review-packet.sh` はこれらを `artifact.diff` からも
`artifact.files` からも外し、パスと大きさだけを `artifact.excluded_paths` と
`self_declared_concerns` に残す（中身は同梱しない）。作者が自分で書いた既知懸念を
レビュアが読み上げて high にすると、懸念を誠実に記録するほど差し戻しやすくなり
task-loop が収束しないため [実測 2026-09-24 / task_007 round 3: finding 3 件が
すべて `docs/concerns/task_007.md` の既存項目と 1 対 1 対応していた]。
封筒サイズの面でも効く（実測: 同じ範囲で 479,449 → 151,359 bytes）。

## エントリの形

封筒 1 通につき 1 エントリ。末尾に `type: "summary"` の判定が 1 件付く。

| フィールド | 意味 |
|---|---|
| `schema_version` | 1 固定 |
| `task_id` / `reviewer` / `vendor` | 対象タスク、エージェント名、ベンダー（gemini / gpt / claude）。**`claude` は作者と同じベンダーなので敵対レビューの票にならない**（下記） |
| `reviewer_route` | `verified` / `cli-fallback` / `unavailable` / `model_mismatch` |
| `model_id_actual` / `model_id_source` | 実際に応答したモデル ID と、その出どころ（`cli_stats` = 観測 / `self_report` = 自己申告） |
| `cli_version` / `backend` | ラッパーが観測した CLI バージョンと応答元 |
| `verdict` | `PASS` / `FAIL` / `BLOCKED` / `UNKNOWN` |
| `findings[]` | `id` / `severity` / `title` / `detail` と、`effective_severity`（降格後） |
| `unavailable_reason` / `attempted_command` | `reviewer_route: "unavailable"` のとき必須 |
| `classification` | `vote` / `missing_vote` / `invalid` / `invalid_review` / `self_review` / `task_mismatch` |
| `validation` | `validate-findings.mjs` の errors / warnings / downgrades / counts |

`type: "summary"` のエントリは判定のほかに `vendors`（有効票を投じたベンダー集合）・
`author_vendor`（作者ベンダー）・`self_reviews`（自己レビューとして票から外した通数）・
`task_mismatches`（宛先違いとして票から外した通数）を持つ。

`classification` の意味は次のとおり。**`vote` 以外は「敵対レビューを受けた」証拠にならない。**

| `classification` | 意味 | 判定への効き方 |
|---|---|---|
| `vote` | 有効票 | `votes` に加算。実効 high は差し戻しに数える |
| `missing_vote` | 欠票（`reviewer_route: "unavailable"`） | 判定をブロックしない。記録だけ残す |
| `invalid` | 封筒として無効（必須フィールド欠落など） | レビュー不成立（exit 3） |
| `invalid_review` | 封筒は読めるが票にならない（`model_mismatch`） | レビュー不成立（exit 3） |
| `self_review` | 作者と同じベンダー | 票から外す。実効 high は差し戻しに数える |
| `task_mismatch` | 封筒の `task_id` が畳み先と違う | レビュー不成立（exit 3）。実効 high も数えない |

## 宛先照合 — 他タスクの封筒を流用できない

封筒の `task_id` は「そのレビューが何を読んだか」である。`merge-review.sh <task_id>` の
`<task_id>` と違う封筒は、**別のタスクの diff に対するレビュー**であって、こちらのタスクの
敵対レビューではない。照合が無いと、他タスクで正規に取得した封筒をそのまま渡すだけで
`decision: pass` / exit 0 を作れる（改竄も偽造も要らない）。`merge-review.sh` は不一致の封筒を
`classification: "task_mismatch"` として記録し、有効票にも欠票にも数えず `not_established` /
exit 3 に落とす [実測 2026-09-24: `task_id: "task_009"` の正規形式封筒 1 通を task_007 へ畳むと
修正前は pass / exit 0、修正後は not_established / exit 3]。

エントリ側の `task_id` は封筒の申告どおり残す（証拠を書き換えない）ので、
`docs/review-log/<task_id>.json` の中に別タスクの `task_id` を持つエントリが現れることがある。
その場合は必ず `classification: "task_mismatch"` が付いている。

なお **G5（`scripts/gate-check.mjs`）はエントリの `task_id` も `classification` も見ない**ため、
不成立で終わった周回でも log に残ったエントリだけで G5 は充足する。G5 側の強化は task_006 の
所有（`docs/concerns/task_007.md` の 20）。`review-log` があることを「敵対レビューを受けたこと」の
証明として扱わない、という原則はここでも変わらない。

## ベンダー独立性 — `vendor: "claude"` は敵対レビューの票にならない

§16-1 の 2「**検出者と作者は別ベンダー**」が敵対レビューの定義である。本リポジトリの
コードは Claude 系が書いているので、`vendor: "claude"` の封筒は**自己レビュー**であり、
封筒として妥当でも敵対レビューの票にはならない。`merge-review.sh` は
`--author-vendor`（既定 `claude`）と同じ `vendor` の封筒を `classification: "self_review"`
として記録し、`votes` から外す。したがって claude の封筒だけを渡すと `votes: 0` となり
`decision: "not_established"` / exit 3 になる [実測 2026-09-24]。

**自己レビューの指摘そのものは捨てない。** 実効 high は差し戻し（exit 1）に数える。
票にしないことと、指摘を無視することは別である。

自己レビューも票に数えたい特殊な用途では `--author-vendor none` を渡す。この値を使った
記録は summary の `author_vendor` に残るので、後から「独立性を外して通した」ことが分かる。

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

## 一括ドライバと gemini CLI の注意（2026-09-24 追記）

`scripts/review-drive.sh <task_id> <最初の自コミット> <最終の自コミット>` が、閲覧用コミットの作成 →
封筒生成 → Gemini → GPT までを一括で行う（merge は呼び出し側）。並行タスクのコミットが交互に入る
ため、`<最初の自コミットの親>...<最終の自コミット>` の差分には他タスクの変更が混ざる（実測: task_005 は
38 ファイル中 18 が他タスク）。ドライバは「subject に task_id を含むコミットが触っていないファイル」を親の
版に戻した閲覧用コミット（`refs/review-view/<task_id>`、main には載せない）を head にして封筒を組む。
review-log の `commit` 欄はこの閲覧用コミットの SHA になる。

**gemini CLI 0.38.1 の実測**: ヘッドレス（`-p`）でも stdin 本文を `@path` 添付構文として走査し、本文中の
`@/` + 区切り文字（`,` `]` `)` `;` 引用符・空白・行末）を path `/` と解釈してルートを再帰走査する。
CPU 100% のまま 15〜60 分返らない（`[^@/]*$/` を含む 1 行入力で再現）。正規表現やコードを含む封筒は
ほぼ確実にこの形を含むので、`review-gemini.mjs` には `--cli scripts/gemini-safe.sh` を渡す。ラッパーは
転送時にだけ該当箇所へ U+200B を挟み（封筒ファイルは不変）、置換件数を stderr に出す。`--version` は
素通しで `cli_version` の観測を壊さない。ドライバはこのラッパーを既定で使う。
