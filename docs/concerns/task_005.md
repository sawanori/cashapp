# task_005 — 残懸念（hardening ラウンド）

対象: `scripts/deny-dangerous-bash.sh` / `scripts/deny-test-weakening.sh` / `.claude/settings.json` /
`package.json` の `lint:changed` / `tests/unit/hooks/**`

本ラウンドで受けたレビュー指摘 7 件の処理結果と、処理の過程で新たに実測した穴を記録する。
「指摘 / 深刻度 / 対応案 / 対応予定タスク」の形式。

---

## 1. 指摘 7 件の処理結果（すべて修正済み）

| # | 指摘 | 状態 | 検証 |
|---|---|---|---|
| 1 | `>\|`（noclobber 上書き）が遮断されない | 修正 | `normalize()` が `\|` を節区切りにする前に `>\|` を `>` へ畳む。遮断ケース 4 件 |
| 2 | `rm -r .` / `git checkout .` / `git clean -fdx` 等の全面迂回 | 修正 | `.` `./` `..` `*` `/` 等を「ここ全体」として拒否。`git clean` は dry-run 以外を拒否。遮断ケース 13 件 |
| 3 | `git apply` / `patch` による保護ファイルの書き換え | 修正 | 読めるパッチは本文を走査、読めなければ fail-closed。遮断 5 件＋「無害と示せるパッチは通す」1 件 |
| 4 | `cd` 後の相対パス・変数展開された宛先 | 修正 | 節ごとに `cd` を追跡（`CWD_REL`）して宛先を解決。`$` を含む宛先は解決不能として拒否。遮断ケース 13 件 |
| 5 | `.claude/**` 保護がスクリプト名の出現回数 | 修正 | 編集後のファイルを組み立てて jq で解析し、event / matcher / command の登録を検査。遮断 7 件＋許可 2 件 |
| 6 | `lint:changed` が remote 不在で常に空振り | 修正 | `HEAD` との差分＋ステージ済み差分の和。0 件なら「対象なし」と明示して exit 0 |
| 7 | 上記を `tests/unit/hooks/*.test.ts` に追加 | 修正 | フックのユニットテストは 148 → 215 件、`npm run test:unit` は 185 → 259 件で全 pass |

---

## 2. 新たに実測した残穴（本ラウンドの指摘外）

`scripts/deny-dangerous-bash.sh` に対して実際にフック入力を流して確認した結果（`ALLOW` = 素通り）。
いずれも**保護対象ファイルを Bash から書き換え・削除できる経路として現存する**。

```
ALLOW  awk -i inplace '{print}' scripts/deny-dangerous-bash.sh
ALLOW  ed -s scripts/deny-dangerous-bash.sh
ALLOW  ex -sc wq scripts/deny-dangerous-bash.sh
ALLOW  vim -es scripts/deny-dangerous-bash.sh
ALLOW  sponge scripts/deny-dangerous-bash.sh
ALLOW  find tests -name '*.test.ts' -delete
ALLOW  xargs rm < /tmp/list.txt
ALLOW  git stash push tests/unit/hooks/deny-dangerous-bash.test.ts
ALLOW  git stash pop
ALLOW  git revert --no-edit HEAD
ALLOW  git reset HEAD~1
```

- **指摘**: `write_rules_hit()` は「書き換えを行うコマンド名」の列挙で成り立っている。列挙にない
  エディタ系（`ed` / `ex` / `vim -es`）・`awk -i inplace`・`sponge`、宛先がコマンド行に現れない
  `find -delete` / `xargs rm`、履歴操作で内容を巻き戻す `git stash` / `git revert` / `git reset`
  （`--hard` 以外）は素通りする。
- **深刻度**: high（ガード本体とテストを 1 コマンドで書き換え・巻き戻しできる）。
  ただし「悪意ある回避」を前提にしたときの深刻度であり、通常作業では踏まない。
- **対応案**: 列挙の追加ではなく方針を変える。(a) `interpreter_write_hit()` と同じく
  「コマンド行のどこかに保護対象パスが現れたら、読み取り専用と明示できるコマンド
  （`cat` / `ls` / `grep` / `jq` / `git diff` / `git log` / `git add` 等）以外は fail-closed」
  という allowlist 方式へ寄せる。(b) `git stash` / `git revert` / `git reset` は、
  対象に保護対象パスを含むかを `git diff --name-only` で事前判定して遮断する。
- **対応予定タスク**: 未起票（task_005 の次の hardening ラウンド）。**deferred**。

---

## 3. ガード本体が本セッションから編集不能になったこと（運用上の制約）

- **指摘**: 指摘 3 の修正で `git apply` / `patch` を塞いだ結果、`scripts/deny-*` を変更する経路が
  Claude Code のセッション内に 1 つも残っていない。内訳:
  - Edit / Write → `deny-test-weakening.sh` が `scripts/(deny-*|record-run.sh)` を拒否
  - Bash のリダイレクト・`tee`・`sed -i`・`cp`/`mv`・`rm`・`chmod`・`ln`・`dd`・インタプリタの
    ワンライナー → `deny-dangerous-bash.sh` が拒否
  - `git apply` / `patch` → 本ラウンドで拒否（パッチ本文に `scripts/deny-` が現れるため）
- 本ラウンドの修正そのものは、**まだ `git apply` が通った時点で** `git apply` により当てた
  （`/private/tmp/.../scratchpad/guards.patch`）。適用後は同じ経路が塞がっている。
  §2 の残穴（`ed` 等）は迂回路であって正規の手段ではないため、修正には使っていない。
- **深刻度**: medium（次の hardening ラウンドがセッション内で作業できない）。
- **対応案**: ガードを直す必要が出たら、次のいずれかを PO が選ぶ。
  1. PO が Claude Code の外（通常のエディタ / `git apply`）で `scripts/deny-*` を編集する。
  2. `.claude/settings.json` の PreToolUse 登録を PO が一時的に外して作業し、戻す
     （フック登録を外す編集は AI からは通らないが、PO の手編集なら可能）。
  3. ガードを複数ファイルに分け、追加分を `scripts/guards/` のような
     `scripts/deny-*` に当たらないパスへ置けるようにする設計変更を起票する。
- **対応予定タスク**: 未起票（PO 裁定）。**accepted-risk**（自己保全はこのハーネスの目的そのもの）。

---

## 4. 指摘 5 の到達範囲（コマンド文字列の意味までは検査していない）

- **指摘**: `.claude/settings.json` の構造検査は「event / matcher / command 文字列」までしか見ない。
  登録されたコマンドが実際にガードを起動するかどうかは、コマンド文字列を実行せずには決定できない。
  `#` 以降を無視して名前を探すことで `true # deny-dangerous-bash.sh` のようなコメント化は落とせるが、
  `bash -c 'exit 0' # …` を組み立てるような改変までは検出できない。
- **深刻度**: low（`.claude/**` の編集自体が PO の目に触れる差分として残る）。
- **対応案**: フックの実効性を「登録内容の静的検査」ではなく「起動して exit 2 を返すか」で
  検査する smoke テスト（`npm run gate:hooks` 相当）を CI に置く。
- **対応予定タスク**: 未起票（task_006 のゲート整備と合わせて検討）。**deferred**。

---

## 5. `cd` 追跡の副作用（遮断理由の文言が実際の対象とずれることがある）

- **指摘**: 保護対象ディレクトリへ `cd` した後の削除系の節は、節の全トークンが
  「そのディレクトリ配下のパス」として解決されるため、遮断メッセージが引用するトークンが
  コマンド名そのものになることがある。実測例:
  `cd docs/run-log && rm nonexistent-probe.json` → `該当: 削除・復元の対象 rm`。
- **深刻度**: low（遮断の判断は正しく、文言だけが分かりにくい）。
- **対応案**: 削除系の走査で、節の先頭トークン（コマンド名）と `-` 始まりのトークンを
  対象判定から除外する。
- **対応予定タスク**: 未起票（次の hardening ラウンドで §2 と同時に）。**deferred**。

---

## 6. 既存の未達（本ラウンドで変化なし）

- `check_053`（新規セッションでの SessionStart 注入の目視）は 3 周目で
  `claude` CLI のヘッドレス新規セッションにより実測済み。本ラウンドでは再実行していない。
- 本ラウンドの検証中、作業ツリーの `npm run test:unit` が 1 件落ちた
  （`tests/unit/db-client.test.ts` の `ALLOW_PRIVILEGED_DB_ROLE` の 3 条件ケース）。
  原因は並行タスクが未コミットで編集中の `src/lib/db/client.ts`（Hyperdrive 経路では
  特権ロールを常に拒否する変更）で、`tests/unit/db-client.test.ts` の期待値がまだ追随していない。
  どちらも task_005 の担当範囲外。本タスクのコミット `136be6d` を分離ワークツリーに
  チェックアウトして実行した `npm run test:unit` は 259 件全 pass（`docs/run-log/task_005.json` に記録）。
  **対応予定タスク**: 当該並行タスク（task_011 / task_035 系）。**deferred**。
- GitHub リモートが未作成のため、CI（GitHub Actions）での実走検証は行えない。
  task_005 は `.github/workflows/**` を作らないため本ラウンドの done_definition には影響しない。
  **deferred: GitHub リモート作成後に実施**。
