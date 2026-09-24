# task_006 の残懸念

`gate-check`（G0〜G14）・違反フィクスチャ・メタゲート・フック実在マトリクス。
形式: 指摘 / 深刻度 / 対応案 / 対応予定タスク。

---

## 1. 違反フィクスチャの 1 本目が人間の手書きではない

- **指摘**: task_006 の scope は「最初の 1 本は人間が手書きし CODEOWNERS 対象」と定めているが、
  23 本すべてをモデル（本タスクの実装エージェント）が書いた。各 `meta.json` の
  `provenance.authored_by` は `model:opus-5.5 (task_006)` と正直に記録してある。
  CODEOWNERS 自体は task_009 の成果物で、本タスクでは作れない。
- **深刻度**: medium。この条項の意図は「ゲート網の正しさの起点を、ゲート網を書いた当人以外に
  置く」ことである。モデルが書いたフィクスチャは、モデルが取り違えたゲートの意味をそのまま
  写している可能性があり、その取り違えは自分では見つけられない。
- **対応案**: (a) PO が 1 本を手書きし `provenance.authored_by` を `human:noritaka` にする。
  `gate-check.mjs` の G0 は「人間が手書きしたフィクスチャが 0 本」を毎回 **warn** で表示する
  実装にしてあるので、達成されるまで黙らない。(b) task_009 の CODEOWNERS に
  `tests/gates/fixtures/violations/**` を入れ、PO のレビューを必須にする。
- **対応予定タスク**: PO（(a)）/ task_009（(b)）

---

## 2. `docs/gates/integrity-baseline.json` を書けるのがエージェント自身である（G13 の自己参照）

- **指摘**: G13 はゲート定義ファイルのハッシュを基準値と照合するが、基準値は
  `node scripts/gate-integrity.mjs --write-baseline` で再生成できる。この経路は
  `deny-dangerous-bash.sh` の遮断対象ではない（リダイレクトでもインタプリタのワンライナーでも
  ないため）。したがって、ガードを書き換えたエージェントが基準値を作り直せば、G13 は緑に戻る。
- **深刻度**: high。F13（AI による本番ゲート・ゲート定義ファイルの書き換え）の検知そのものが
  自己封じできる。
- **対応案**: 現時点で残っている歯止めは「基準値の書き換えが `docs/gates/**` の diff として
  PR に出る」ことだけである。これを人間の関門に繋ぐのは task_009 の 2 本:
  (a) CODEOWNERS に `docs/gates/**` を入れて PO のレビューを必須にする、
  (b) `test-tamper-guard` ジョブの対象に `docs/gates/**` を含め、チェックリスト記入を強制する。
  さらに (c) CI では `--write-baseline` を使わず検証モードのみを走らせること、
  (d) 基準値の `generated_at_commit` と `generated_at` を PR で目視できるようにすること。
  なお `docs/gates/**` を書けるスクリプトを作らないという選択肢は取れなかった。
  `deny-test-weakening.sh` が Edit / Write / MCP 編集を、`deny-dangerous-bash.sh` が Bash 経由の
  書き込みを全部塞いでいるため、**基準値を作る手段が他に無い**。
- **対応予定タスク**: task_009

---

## 3. CI での実走が未証明（GitHub リモート未作成）

- **指摘**: §16-6 の `gate-meta` / `acceptance` / `gate-integrity` ジョブに本タスクの
  `test:gate-meta` / `assert-verify-commands` / `assert-acceptance` / `gate:integrity` を
  載せるのは task_009 の担当だが、GitHub リモートが未作成（PO 判断待ち）のため、
  ワークフローは一度も実走していない。本タスクは `.github/workflows/gate-*.yml` を追加していない
  （CI 登録は non_scope）。
- **深刻度**: medium。ローカルでの exit code は `docs/run-log/task_006.json` にあるが、
  「PR で緑」「required status checks に含まれる」は未証明。
- **対応案**: **deferred: GitHub リモート作成後に実施。** task_009 が
  `.github/workflows/gate.yml` を作る際に、`gate-meta` ジョブ（`npm run test:gate-meta`）と
  `acceptance` ジョブ（`node scripts/assert-verify-commands.mjs` ＋
  `node scripts/assert-acceptance.mjs` ＋ `verify_commands` の再実行）と
  `gate-integrity` ジョブ（`npm run gate:integrity`）を required に入れる。
- **対応予定タスク**: task_009

---

## 4. G8 が `tests/**/fixtures/**` を走査対象から外している

- **指摘**: G8（差分に実シークレットが含まれない）は、`tests/` 配下で `fixtures` を含むパスを
  「パターン定義ファイル」として走査から外す。違反フィクスチャは秘密値の形をした値を持つのが
  仕事であり（本タスクの `g8-live-key-in-diff`、task_012 の
  `tests/unit/config/fixtures/env-scope/secret-in-vars/wrangler.toml`）、外さないと
  ゲートが自分のフィクスチャで鳴り続けて本物の検出が埋もれる。
  除外したファイル名は毎回レポートに出す（黙って外さない）。
- **深刻度**: medium。**本物の秘密値をフィクスチャに貼っても G8 では捕まらない。**
- **対応案**: task_009 の `security` ジョブが `.next/static` / `.open-next` の成果物を
  実シークレット名で grep する（§16-6）。フィクスチャの値がバンドルに載れば、そちらで捕まる。
  載らない場合（テストでしか使わない値）は、G8 でも CI でも捕まらない経路が残る。
  埋めるなら、フィクスチャに `"synthetic": true` の宣言を必須化して宣言の無いものだけ走査する
  設計へ変える。本タスクでは他タスクのフィクスチャ形式まで決められないため見送った。
- **対応予定タスク**: task_009（成果物 grep）/ task_022（security テスト実体）

---

## 5. G8 の「本プロジェクトの秘密値名」リストが手書きの固定リスト

- **指摘**: G8 の `project-secret-with-value` 規則は、`PEPPER` / `CRON_SECRETS` /
  `SESSION_KEYS` / `LINE_CHANNEL_SECRET` / `PAYPAY_API_SECRET` / `PAYJP_SECRET_KEY` /
  `SUPABASE_SERVICE_ROLE_KEY` / `CLOUDFLARE_API_TOKEN` 等を名前で列挙している。
  新しい秘密値が増えたときに追随しないと素通りする。
- **深刻度**: medium。当初は汎用の `[A-Z_]*TOKEN = <長い文字列>` にしていたが、
  task_012 のテストが使う合成トークン（`RAW_JOIN_TOKEN`）で誤検知し、本物の検出が埋もれた。
  §15-2 の G8 が「**本プロジェクトの名前・形式**」と書いていることに合わせて絞った。
- **対応案**: task_012 の `scripts/gate-env-scope.mjs` が env スコープの正本を持つので、
  そこから秘密値名の一覧を機械的に取り込む（`gate-check.mjs` 側でハードコードしない）。
  接続点は task_012 の完了後に作る。
- **対応予定タスク**: task_012 完了後（起票は task_009 の CI 整備時に併せて）

---

## 6. G14 の判定が run-log の自己申告に依存する

- **指摘**: G14（直近 7 日の監査連鎖が検証済み）は、`docs/run-log/**` に
  `npm run audit:verify` の exit 0 記録があり、その `ran_at` が 7 日以内であることを見る。
  run-log は `record-run.sh` 以外から書けないので実行の証拠ではあるが、**監査連鎖そのものを
  検証しているのは `audit:verify` であって G14 ではない**。`audit:verify` は task_018 の成果物で
  まだ存在せず、現状 G14 は defer である。
- **深刻度**: low（Phase 1 の現時点では）。
- **対応案**: task_018 が `scripts/audit-verify.mjs` を作ったら、G14 を defer から実判定へ
  自動的に切り替える（`package.json` に `audit:verify` が現れた時点で切り替わる実装済み）。
  `tests/gates/fixtures/violations/g14-audit-chain-stale` がその時点の挙動を先に固定している。
- **対応予定タスク**: task_018

---

## 7. W1 の違反フィクスチャに実行手段が無い

- **指摘**: `docs/constraints.json` の W1（Webhook 受信ログの一意制約）は `enforcement: "test"`
  であり grep では検出できない。フィクスチャ
  `tests/gates/fixtures/violations/w1-webhook-replay-applied-twice` は入力データだけを用意して
  あり、`runner` は `null`・`blocked_on` は `task_018` である。
- **深刻度**: low。`tests/gates/meta.test.ts` は、実行手段の無いフィクスチャについて
  「`blocked_on` が実在する task で、かつまだ完了していない」ことを検査する。task_018 が
  完了した時点でこのテストが赤くなり、runner の埋め忘れを検知する。
- **対応案**: task_018 が `tests/contract/duplicate.test.ts` を作った時点で `meta.json` の
  `runner` を `npm run test:contract` 相当に埋める。
- **対応予定タスク**: task_018

---

## 8. 自タスクの files_to_create / files_to_modify 外を 1 ファイル触った

- **指摘**: `vitest.config.ts` の `include` に `tests/gates/**/*.test.ts` を 1 行追加した。
  `vitest.config.ts` は task_003 の成果物で、task_006 の `files_to_modify` には無い。
- **深刻度**: low。追加しないと `npm run test:gate-meta`（`vitest run tests/gates`）が
  「No test files found」で exit 1 になる。vitest は `include` に無いファイルを位置指定フィルタでも
  拾えず、CLI にも `--include` 相当のフラグが無い（`vitest run --help` で確認 [実測]）。
  task_011 が `tests/integration/**` を同じ理由・同じ書き方で追加した先例に合わせた。
- **対応案**: 追記のみ・既存行は変更なしなので巻き戻しは容易。別解は
  `vitest.gates.config.ts` を別に作ることだが、どのタスクの `files_to_create` にも無い
  新規ファイルになるため、こちらの方が侵襲が小さいと判断した。
- **対応予定タスク**: なし（記録のみ）

---

## 9. `docs/run-log/task_006.json` の先頭に exit 127 のエントリが 3 件ある

- **指摘**: 検証コマンドを fish のループ変数経由で `scripts/record-run.sh` に渡したところ、
  fish が変数を空白分割しないため `"npm run test:unit"` が 1 つの引数として渡り、
  `command not found`（exit 127）が 3 件記録された。run-log は追記専用で削除できない。
- **深刻度**: low。直後に同じコマンドを 1 本ずつ実行し直し、すべて exit 0 を記録してある。
  G4 は「全 `verify_commands` の exit 0 が run-log にあること」を見るので、127 の残骸は
  判定に影響しない。
- **対応案**: 記録のみ。`record-run.sh` の使い方として「シェル変数に入れたコマンド文字列を
  そのまま渡さない」を `docs/HANDOFF.md` に書いた。
- **対応予定タスク**: なし（記録のみ）

---

## 10. G5 / G7 / G9 / G12 / G14 は現時点で対象 0 件（defer）

- **指摘**: `tests/contract/`（G7）・evidence 記入済み check（G9）・`tests/fixtures/<provider>/`（G12）・
  `audit:verify`（G14）はまだ存在せず、G5 は task_007 待ちで warn である。
  これらは「合格」ではなく `defer`（理由つき）として報告される。
- **深刻度**: low。G0 が「対象 0 件のまま `ok` になっているゲート」を違反として検出するので、
  defer を ok に化かす実装変更は機械的に落ちる。各ゲートには対応する違反フィクスチャがあり、
  対象が現れた時点で実際に落ちることを `npm run test:gate-meta` が今すでに証明している。
- **対応案**: 対象を作るタスク（task_007 / 018 / 019）の完了時に defer が自動的に外れる。
- **対応予定タスク**: task_007 / task_018 / task_019

---

# レビュー指摘（2 周目）の処理結果

| # | 深刻度 | 指摘 | 結果 |
|---|---|---|---|
| 1 | high | G4 の manual 判定が項目を参照しておらず、無関係な manual 記録 1 件で N 項目すべてが満たされたことになる | 修正済み（下記 11） |
| 2 | medium | `gate-inputs/**` をリポジトリ直下に置くだけで G8 / G9 の入力を差し替えられる | 修正済み（下記 12） |
| 3 | medium | PROGRESS.md の完了申告が台帳に反映されておらず G4 / G6 が完了 7 件中 1 件しか見ていない | 修正済み（下記 13） |
| 4 | medium | G11 / G6 が `docs/concerns/<task_id>.md` を数えていない | 修正済み（下記 14） |
| 5 | medium | G13 のハッシュ対象から `wording-lint.mjs` / `gates-sync.mjs` / `test-hook-enforcement.sh` が漏れている | 修正済み（下記 15） |
| 6 | medium | Stop フックで落ちてもレポートが stdout にしか出ず、その場に現れない | 修正済み（下記 16） |
| 7 | medium・deferred | CI 実走が未証明 | 変化なし（上記 3。GitHub リモート未作成） |

---

## 11. G4 の manual 記録は「名指し」ではなく単射で充当している（残余）

- **指摘**: レビュー指摘 1（high）の修正として、`manual_verification` の各項目に
  **別々の** manual 記録を割り当てる単射マッチングを実装した。名指し
  （観察文中の `manual_verification[<索引>]`、または項目文字列の引き写し）があるものを
  先に確定し、残った項目には残った記録を 1 件ずつ充てる。したがって
  「項目 3 件・記録 1 件」は必ず 2 件の違反になる（反例 `g4-manual-items-uncovered`）。
  ただし名指しの無い記録でも項目数ぶんあれば充当されるため、「3 項目に対し内容の重複した
  3 記録」は通ってしまう。
- **深刻度**: low。充当時に必ず warn を出す（黙って通さない）ので、名指しの無い記録は
  毎回レポートに現れる。既存の唯一の該当例は task_002 の 1 項目 1 記録で、いま warn が出ている。
- **対応案**: `scripts/record-run.sh --manual` の観察文に `manual_verification[<索引>]` を
  書く運用を定着させ、全記録が名指しになった時点で名指しを必須に切り替える
  （`manualEntryNamesItem` を 2nd pass から外すだけで済む）。`record-run.sh` は task_003 の
  成果物なので、引数への索引フィールド追加は別タスクの担当。
- **対応予定タスク**: 未起票（運用で先行）

---

## 12. `gate-inputs/**` は overlay 専用にした（ベース側は違反として報告）

- **指摘**: 修正前は `ctx.resolve` のフォールバックにより、リポジトリ直下に
  `gate-inputs/git-diff.json` / `gate-inputs/head.txt` を置くだけで G8 / G9 の入力を
  差し替えられた（実 `git diff` / 実 `git rev-parse HEAD` が一度も走らない）。
  `gate-inputs/**` は deny ガードの保護パスにも G13 のハッシュ対象領域にも入らないため、
  新設が検知されなかった。
- **深刻度**: medium（修正済み）。`readOverlayText` を追加し、`gate-inputs/**` は
  `--root` がベースと異なるときに overlay からのみ読む。加えてベース側に `gate-inputs/` が
  あれば G8 と G0 が違反として名指しする。反例 `g8-gate-inputs-planted-in-base` が
  ベースを symlink で組み立てて実測する。
- **残余**: `gate-inputs/**` 自体は今も G13 のハッシュ対象領域に入らない（対象領域は
  §15-2 の列挙で決まっており、存在しないディレクトリを足しても意味がない）。歯止めは
  G8 / G0 の報告と、追加ファイルが PR の diff に出ることである。
- **対応予定タスク**: なし（記録のみ）

---

## 13. PROGRESS.md の完了申告を台帳へ反映した（他タスクの行にも触れた）

- **指摘**: 完了申告が書かれるのは `docs/PROGRESS.md` だけで、共通ルールは
  `docs/task-list.json` の `completion_status` を書けと指示していない。その結果、
  PROGRESS.md が 7 件の完了を宣言しているのに台帳では 1 件（task_011）しか入っておらず、
  G4 / G5 / G6 は完了タスクをほとんど見ていなかった。G0 は `targets === 0` のときしか
  鳴らないので、この過小カウントは検知されなかった。
- **深刻度**: medium（修正済み）。G4 に「PROGRESS.md が完了を宣言している task_id の
  `completion_status` が台帳で null」「両者のステータスが食い違う」を違反として追加し
  （反例 `g4-progress-ledger-drift`）、台帳側を PROGRESS.md に合わせた。
  G4 の対象は 1 件 → 7 件、G5 は 1 件 → 5 件、G6 は 1 件 → 6 件になった。
- **担当範囲の逸脱（記録）**: `docs/task-list.json` は task_006 の `files_to_modify` に無い。
  それでも触ったのは、追加した判定を満たすには台帳の同期が要るためである。書いたのは
  **PROGRESS.md の記載をそのまま写した `completion_status`** と、task_006 自身の `concerns[]` である。
  task_003 の既存 `concerns[]` 2 件は severity 表記が無く G6 に落ちたため、severity 接頭辞だけを
  付けた（1 件目は task_003 自身が `docs/HANDOFF.md` に書いた `[severity: medium] A21 未解決` からの転記、
  2 件目は該当する severity 記録が無いため task_006 が `low` を付与した旨を本文中に明記してある）。
  他タスクの concerns 本文は書き換えていない。
- **対応予定タスク**: 各タスクの完了時に自分の行を書く運用へ（共通ルールの改訂は PO 判断）

---

## 14. 残懸念の集計元を 3 箇所に広げた

- **指摘**: G11（high 3 件で `in_progress` を止めるキルスイッチ）と G6 は
  `docs/task-list.json` の `concerns[]` だけを数えていたが、本プロジェクトが実際に残懸念を
  書いている場所は `docs/concerns/<task_id>.md` と `docs/HANDOFF.md` のタスク節である。
  数える場所が違えば、しきい値 3 件には一生届かない。
- **深刻度**: medium（修正済み）。`collectConcerns` が 3 箇所を読む。severity 表記は
  `**深刻度**: high` / `severity: high` / `【high】` / 見出しの `[high]` の 4 形式に対応し、
  `修正済み` などの表記があるものは残高から外す。HANDOFF はタスク節の中の
  `- **[severity: …]` で始まる箇条書きだけを拾い、周回ごとの書き写しは先頭 60 文字で重複排除する。
  反例 `g11-high-concerns-only-in-concerns-files` が「concerns ファイルにしか無い high 3 件」で
  発火することを実測する。現在の残高は 7 件（task_005 / task_006 / task_011）。
- **残余**: severity 表記が 4 形式あること自体が脆い。表記を 1 つに寄せるか、
  `docs/concerns/*.md` と台帳 `concerns[]` の同期を `gate:plan` で強制するのが本筋。
- **対応予定タスク**: 未起票（表記の統一は PO 判断）

---

## 15. G13 のハッシュ対象に 3 本を追加した

- **指摘**: `scripts/wording-lint.mjs`（required ジョブ `labels` の本体）・
  `scripts/gates-sync.mjs`（required ジョブ `gates-sync` の本体）・
  `scripts/test-hook-enforcement.sh`（フック実在マトリクスの再測定手段）は、
  ファイル名が `gate-` / `deny-` / `assert-` / `validate-` のどの接頭辞にも当たらないため
  ハッシュ対象から漏れていた（`gates-sync.mjs` は 5 文字目が `s`）。書き換えても G13 が沈黙した。
- **深刻度**: medium（修正済み）。`INTEGRITY_PATTERNS` に file エントリとして 3 本を追加し、
  基準値を作り直した（21 → 24 ファイル）。
- **残余**: `scripts/with-lock.sh`（並行実行の排他）と `scripts/db-diff-drizzle.mjs` は
  対象に入れていない。どちらも合否を判定するゲートではなく、§15-2 の列挙にも無いため、
  範囲を広げるのは計画の改訂とセットにすべきと判断した。
- **対応予定タスク**: task_009（§15-2 の列挙改訂と CODEOWNERS）

---

## 16. Stop フックで落ちたときのレポートを stderr にも出す

- **指摘**: Stop フックの `npm run --silent gate:check` は exit 1 で返すが、
  `gate-check.mjs` はレポートも違反行も stdout に書いていた。Claude Code の Stop フックで
  非ブロッキング（exit 2 以外の非ゼロ）のときセッションに提示されるのは stderr なので、
  ゲートが落ちても「どのゲートが何件落ちたか」がその場に現れなかった。
- **深刻度**: medium（修正済み）。非ゼロ終了する場合に限り、集計行と違反行を stderr にも書く。
  exit 1 のまま据え置く判断（exit 2 はセッションを終われなくする罠になる）は変更していない。
- **対応予定タスク**: なし（記録のみ）

---

## 17. 基準値の再生成が並行タスクの変更もまとめて正にする

- **指摘**: G13 の基準値は作業ツリーのファイルをハッシュする。今回の再生成では
  `scripts/gate-env-scope.mjs`（task_012 の成果物。本タスクの作業中に task_012 の
  2 周目がコミット `3062179` で書き換えた）の新しい内容も一緒に基準値へ入った。
  基準値の再生成は「いま作業ツリーにあるものを正とする」操作なので、
  他タスクの変更も区別なく正になる。
- **深刻度**: medium。悪用すれば「ガードを書き換えてから基準値を作り直す」という
  上記 2 の自己封じと同じ経路になる。
- **対応案**: 基準値の差分（`docs/gates/integrity-baseline.json`）を PR で人間に見せることが
  唯一の歯止めであり、それを強制するのは task_009 の CODEOWNERS と `test-tamper-guard`。
  運用としては、基準値の再生成は「ゲート対象領域に未コミット変更が無い状態」で行うべきだが、
  並行実行中はそれを保証できない。再生成した時刻と HEAD は基準値ファイルに記録されている。
- **対応予定タスク**: task_009
