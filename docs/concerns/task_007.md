# task_007 残懸念

エージェント定義 7 本とレビュー封筒スクリプト（`docs/implementation-plan.md` §16-2 / §16-5、
`check_066`、R-TH-03 / R-TH-08 / R-TH-10 / R-TH-11 / R-TH-14）。

書式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

---

## 0. 最終 HEAD では `npm run gate:constraints` が並行タスクの未追跡ファイルで exit 1

- **指摘**: verify_commands の 1 本 `npm run gate:constraints` は、本タスクの作業中
  （2026-09-24T08:55:43Z / 09:05:08Z）は exit 0 だったが、最終確認時（09:19:30Z）に exit 1 に
  変わった。違反 2 件はいずれも**並行実行中の task_013 の未追跡ファイル**である
  （`src/components/ConsentGate.tsx:20` と `src/lib/liff/client.ts:15`。どちらも
  「`localStorage` は使わない」と書いたコメント行が N7 の forbid grep に当たっている）。
  **task_007 の成果物には違反 0 件。**
  同じ理由で `npm run gate:wording` も最終確認時に exit 1 になっている
  （`src/components/StateView.tsx:132` の「禁止語を使わない」と説明するコメント行が
  W-AUTO の禁止語「自動で確認」「入金を確認しました」に当たる。これも task_013 の未追跡ファイル）。
- **深刻度**: low（本タスクに起因しない。ただし「最終 HEAD で verify_commands が緑」とは言えない）
- **対応案**: task_013 が当該コメントの書き方を変えるか、N7 の `allow_if_line_matches` に
  「使わない」旨の否定文を加える（`docs/constraints.json` は task_004 の所有）。
  経緯は `docs/run-log/task_007.json` の manual エントリに記録済み。
- **対応予定タスク**: task_013（または task_004）

## 1. GPT-6 Astra 経路が遮断されたままで、敵対レビューは実質 1 ベンダー

- **指摘**: `codex exec --json -m gpt-6-astra` は **exit 0 のままエージェント応答を 1 件も
  返さない**（`--output-last-message` が 0 バイト、`turn.completed` のトークン 0）[実測 2026-09-24]。
  原因は `~/.codex/hooks/block-non-claude-model.sh` が UserPromptSubmit で非 Claude モデルの
  プロンプトを遮断していること。`scripts/review-gpt.mjs` は欠票封筒を返すので事実は残るが、
  **現状の敵対レビューは Gemini 単独である**。「検出者と作者は別ベンダー」（§16-1）は
  1 ベンダーぶんしか成立していない。
- **深刻度**: high
- **対応案**: フックの例外句追加は PO の承認事項。AI は解除してはならない（§16-1 の 4 / F13）。
  解除されるまでは欠票を review-log に残し続け、**「3 ベンダー体制」と称さない**（F6 / R-TH-06）。
  CI から呼ぶ経路は各社 API キー（GitHub Secrets）で作る。**経路が実測で通るまで
  adversarial を required status checks に入れない**（R-TH-03）。
- **対応予定タスク**: task_010（codex フック例外句・到達可能な実モデルの確定）

## 2. G13 の基準値は task_007 の未コミット状態で焼かれた

- **指摘**: G13 のハッシュ対象領域（`.claude/**` / `scripts/validate-*` ほか）に本タスクは
  8 ファイル（エージェント定義 7 本 ＋ `scripts/validate-findings.mjs`）を追加した。本タスクの
  作業中は `npm run gate:integrity` が 14 件の不一致（うち 6 件は並行実行中の task_009 の
  `.github/workflows/*` と `scripts/ci/*`）で FAIL していた。その後 **task_009 が
  `node scripts/gate-integrity.mjs --write-baseline` を走らせ、本タスクの 8 ファイルが
  未コミットのまま基準値に焼き込まれた**（task_009 自身が `docs/HANDOFF.md` にそう書いている）。
  本タスクのコミット後は `gate:integrity` が 38 ファイル / 不一致 0 件で通る [実測]。
- **深刻度**: medium（現時点は緑だが、焼かれた経緯が「意図した再生成」ではない）
  本タスクの最終確認時点（2026-09-24T09:2xZ 以降）では **`scripts/ci/secrets-grep.sh` の
  ハッシュ不一致 1 件で G13 が FAIL** になっている。これは task_009 の成果物が
  コミット `a261bd9` の後に未コミットのまま書き換えられたためで（`git status` に
  ` M scripts/ci/secrets-grep.sh`）、task_007 の 8 ファイルは基準値と一致している。
- **対応案**: エージェント定義やレビュースクリプトを今後編集したら、そのタスクが
  `node scripts/gate-integrity.mjs --write-baseline` をやり直し、差分を PR で人間に見せる。
  **全ハーネスタスク完了後に、クリーンなチェックアウトで `npm run gate:integrity` が
  exit 0 になることを 1 度確認すること**（task_009 の HANDOFF と同じ申し送り）。
- **対応予定タスク**: task_009 / task_010 / PO

## 2-b. CI の `adversarial` ジョブが存在しない入口を探している

- **指摘**: task_009 が作った `.github/workflows/gate.yml` の `adversarial` ジョブは
  `scripts/review/run-adversarial.sh` または `scripts/review/run-adversarial.mjs` の実在を
  条件にしており、無ければ非 0 で落ちる。本タスクが作った実際の入口は
  `scripts/build-review-packet.sh` / `review-gemini.mjs` / `review-gpt.mjs` /
  `validate-findings.mjs` / `merge-review.sh` の 5 本であり、**パスが一致しない**。
  したがって経路が実在する今も、このジョブは緑にならない。
- **深刻度**: medium
- **対応案**: `gate.yml` は task_009 の単独所有ファイルなので本タスクからは触っていない。
  入口名をそろえる（`gate.yml` 側を実在する 5 本に向ける）か、`scripts/review/run-adversarial.sh`
  を薄いラッパーとして追加するかは task_010 が決める。どちらにしても
  **required status checks には入れない**（R-TH-03）。
- **対応予定タスク**: task_010（task_009 と調整）

## 3. G5 が task_007 の完了でブロッキングになり、既存 5 タスクが review-log を持たない

- **指摘**: `scripts/gate-check.mjs` の G5 は「task_007 が DONE になるまで warn、以降は
  ブロッキング」と実装されている（§15-2 の設計どおり）。本タスクの完了により、
  `risk_level: high` かつ `adversarial_review: required` の完了済みタスク
  **task_004 / task_005 / task_006 / task_011 / task_012** が
  `docs/review-log/<task_id>.json` を持たない違反として列挙される。
- **深刻度**: high（ただしこれは事故ではなく、計画が意図した強制力である）
- **対応案**: 各タスクについて次を 1 回走らせれば足りる。Gemini 経路は実測で通るので、
  欠票で埋めるのではなく**実レビューを取る**こと。
  ```
  bash scripts/build-review-packet.sh <task_id> --base <当該コミットの親> --out /tmp/p.json
  node scripts/review-gemini.mjs --packet /tmp/p.json --model gemini-2.5-pro --out /tmp/g.json
  node scripts/review-gpt.mjs    --packet /tmp/p.json --out /tmp/x.json
  bash scripts/merge-review.sh <task_id> /tmp/g.json /tmp/x.json
  ```
  本タスクで他タスクの review-log を代わりに作ることはしなかった。他タスクの成果物であり、
  また自動で欠票を敷き詰めると G5 の「未レビューを可視化する」意味が消えるためである。
- **対応予定タスク**: task_004 / 005 / 006 / 011 / 012 の各担当、または PO の一括指示

## 4. 合格モデルのホワイトリストが未設定で `model_mismatch` を検出できない

- **指摘**: `scripts/validate-findings.mjs` は `docs/metrics/model-bench.md` の
  `machine-readable` ブロック（`{"approved_models": [...]}`）と `model_id_actual` を照合するが、
  このファイルは**まだ存在しない**。現状は `model_whitelist_unconfigured` の警告が出るだけで、
  どのモデル ID でも票として通る。R-TH-11 の「静かな差し替え」検知は半分しか働いていない
  （「名乗らせる」は効いているが「照合する」は効いていない）。
- **深刻度**: medium
- **対応案**: task_010 のベンチで合格モデルを確定し、`docs/metrics/model-bench.md` に
  上記の形式で書く。形式が変わる場合は `DEFAULT_WHITELIST_REL` とパーサを合わせて直す。
- **対応予定タスク**: task_010

## 5. codex の応答モデル ID が観測できず、自己申告に頼る

- **指摘**: codex-cli 0.154.0 の `--json` イベントは `thread.started` / `turn.started` /
  `item.completed` / `turn.completed` の 4 種で、**応答モデル ID を含まない** [実測]。
  Gemini 側は `stats.models` の `roles.main` から観測できる（`model_id_source: "cli_stats"`）が、
  GPT 側は返信本文の自己申告しか根拠がない。`review-gpt.mjs` は自己申告のとき
  `reviewer_route: "cli-fallback"` ＋ `model_id_source: "self_report"` を付けて `verified` と
  区別しているが、**自己申告は偽装できる**。
- **深刻度**: medium
- **対応案**: 経路が開通したら、API 直叩き（レスポンスの `model` フィールド）へ寄せるか、
  codex の新しいバージョンで観測手段が増えていないか再確認する。CI では各社 API キーで
  呼ぶ計画（§16-6）なので、その実装時に観測値へ切り替える。
- **対応予定タスク**: task_010 / task_009（CI 経路）

## 6. 封筒が並行タスクの未コミット差分を巻き込む

- **指摘**: `scripts/build-review-packet.sh` を `--base` 無しで使うと、対象は「HEAD と作業
  ツリーの差分＋未追跡ファイル」になる。並行実行中の他タスクの未コミットファイルが
  同じ作業ツリーに存在するため、封筒に他タスクの成果物が混ざる（本タスクの初回実行で
  task_009 の `scripts/ci/*` と `.github/workflows/*` が 17 ファイル中に混入した [実測]）。
  レビュアは自タスクと無関係なファイルに指摘を出す。
- **深刻度**: medium
- **対応案**: **`--base <当該タスクのコミットの親>` を必ず渡す**運用にする。本タスクの
  実レビューはコミット後に `--base <parent>` で取り直した。`.claude/workflows/task-loop.ts`
  （task_008）で封筒生成を組むときは `--base` を必須引数として扱うこと。
- **対応予定タスク**: task_008（task-loop の封筒生成）

## 7. 封筒が大きいとレビューが返ってこない（実測でタイムアウト）

- **指摘**: 本タスクの最初の実レビュー封筒は `payload_bytes: 264995`（同梱 17 ファイル、
  同梱制約 0 件）で、`gemini-2.5-pro` は **900 秒で応答を返さずタイムアウトした** [実測
  2026-09-24]。同じモデルで 88KB の封筒は 2 分以内に返っている。**封筒のサイズは
  コストだけでなくレビューの成否そのものに効く**。制約の全文同梱を `constraint_ids` に
  絞る対策（R-TH-10）は効いているが、支配的なのは artifact 側（diff と同梱ファイル全文）である。
- **深刻度**: medium
- **対応案**: 本タスクで `--max-diff-bytes`（既定 120000）を追加し、打ち切った事実を
  `artifact.diff_truncated` / `diff_bytes_total` として封筒に書くようにした。並行タスクが
  先にコミットすると `HEAD` が自分のコミットでなくなるため `--head <自分のコミット>` も
  追加した。実レビューは `--base <親> --head <自分> --max-file-bytes 2600
  --max-diff-bytes 22000`（`payload_bytes: 76688`）で取り直した。
  task-loop（task_008）は `metrics.payload_bytes` を 1 周ごとに run-log へ記録し、
  返ってこないときは上限を絞る → レビュアを 2 並列に落とす、の順で縮退すること。
  **既定値のままだと大きい変更で返ってこない**ので、既定 120000 は実測に基づいて
  task_008 / task_010 で見直すこと。
- **対応予定タスク**: task_008（1 周ごとの計測と上限の運用）/ task_010（日次予算）

## 8. CI の adversarial ジョブは未作成（GitHub リモート不在のため実走不能）

- **指摘**: §16-6 の `adversarial` ジョブ（封筒 → Gemini / GPT → merge）は本タスクの
  `files_to_create` に無く、作っていない。GitHub リモートが未作成（PO 判断待ち）のため
  ワークフローの実走検証もできない。
- **深刻度**: low（計画どおり「経路が実測で通るまで required に入れない」ため）
- **対応案**: **deferred: GitHub リモート作成後に実施。** ジョブを追加するときは
  `.github/workflows/gate-adversarial.yml` として独立ファイルで足し、`gate.yml` は編集しない。
  required status checks には入れない。
- **対応予定タスク**: task_009 / task_010

## 9. 受入テスト生成のツール制限は「エージェント定義の許可ツール」でしか担保していない

- **指摘**: `acceptance-test-generator-restricted` は `tools: Write` だけを持たせることで
  `src/**` を読む手段を無くしてある。これは Claude Code のサブエージェント定義で表現できる
  最強の制限だが、**パス単位の Read/Grep 拒否ではない**。呼び出し側が誤って通常の
  `acceptance-test-generator` を使えば制限は掛からないし、R-TH-14 が併せて求めている
  「生成テストが `src/` の内部シンボルを参照していない grep 検査」は本タスクの範囲外である。
- **深刻度**: medium
- **対応案**: CI に当該 grep 検査を足す。task-loop（task_008）の step1 では
  `acceptance-test-generator-restricted` を名指しで使い、2 周目以降は受入テストを再生成しない。
- **対応予定タスク**: task_008（task-loop の step1）/ task_022（CI の grep 検査）

## 10. 実レビューの結果（本タスク自身）— 1 ベンダーのみ、指摘 1 件は誤検出

- **指摘**: 本タスクの diff（`34ec688...1f4acfd`）に対する敵対レビューを 2 周実施し、
  `docs/review-log/task_007.json` に記録した。
  - **round 1**（封筒 265KB）: Gemini は 900 秒でタイムアウト、GPT はフック遮断。
    有効票 0 / 欠票 2 → `not_established`（exit 3）。
  - **round 2**（封筒 76688 bytes）: Gemini が `reviewer_route: "verified"` /
    `model_id_actual: "gemini-2.5-pro"` / `cli_version: "0.38.1"` / `backend: "gemini-cli"` で
    応答。`verdict: "FAIL"`、finding 1 件（medium、repro と citation つき、降格 0 件）。
    GPT は欠票のまま。有効票 1 / 欠票 1 / 実効 high 0 → `pass`（exit 0）。
  - **唯一の finding は誤検出だった**。「`build-review-packet.sh` の import 走査が
    `export … from './x'` を拾えない」という指摘だが、走査正規表現は引用符の直前トークンが
    `from` であることだけを見るので、`export * from "./a"` も `export { x } from "./a"` も
    `import { y } from "./a"` もすべて `./a` として拾う（3 形式を実ファイルで実行して確認）。
    指摘は修正していない。
- **深刻度**: medium
- **対応案**: (1) task_010 で GPT 経路が開通したら 2 票目を取り直す。**1 票しか無い状態を
  「複数ベンダーで検証した」と書かない。** (2) R-TH-08 は「false_positive 判定を review-log に
  記録し週次で誤検出率を出す」ことを求めているが、**現在の封筒スキーマに `false_positive`
  フィールドが無い**ので、上の判定はこの concerns にしか残っていない。誤検出率を機械で
  出したいなら `merge-review.sh` に判定を書き込む口を足す必要がある（task_008 の task-loop
  step5 / step6 の設計と合わせて決めるのが自然）。
- **対応予定タスク**: task_010（2 票目）/ task_008（false_positive 台帳）
