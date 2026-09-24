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
