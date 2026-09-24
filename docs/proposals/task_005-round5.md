# 提案: task_005 5 周目 — deny-dangerous-bash.sh の残穴（§2）を塞ぐ

- 起票日: 2026-09-24
- 起票者: メインセッション（Claude）
- 対象: `scripts/deny-dangerous-bash.sh` / `tests/unit/hooks/deny-dangerous-bash.test.ts`
- 状態: **PO のレビュー待ち（未適用）**
- 根拠: `docs/concerns/task_005.md` §2「残穴（未閉塞。4 周目でも変化なし）」、
  敵対レビュー `docs/review-log/task_005.json` round 1 の F-BASH-01（Gemini、severity high、reject）

## なぜ提案の形なのか

ガード本体（`scripts/deny-*` / `scripts/record-run.sh`）は `scripts/deny-test-weakening.sh` により
**Edit / Write ツールからも書き換えを遮断**している（ガード自己保全、R-SEC-07 / R-TH-02）。したがって
AI は修正を直接当てられない。修正内容をパッチとして置き、人間（PO）が hooks の外で適用する。

## 変更内容（`task_005-round5.patch`）

§2 に列挙された 11 件の素通りをすべて遮断する。列挙方式そのものは変えず、次の 4 クラスを足す。

| クラス | 遮断する形 | 通す形 |
|---|---|---|
| 編集系コマンド | `ed` / `ex` / `vi` / `vim` / `nvim` / `view` / `nano` / `sponge`、`awk`・`gawk` の `-i` / `--in-place` / `--inplace` で、節内（awk は行全体）に保護対象パスがある | `awk '{print $1}' docs/run-log/x.json`（`-i` 無し）、保護対象外への sponge |
| `find` の書き込み動作 | `-delete` または `-exec` / `-execdir` / `-ok` / `-okdir` + 書き込み動詞（`WRITE_VERB_RE`）で、探索元が保護対象・保護対象を含む親（`docs`、リポジトリ直下 `.`）・省略（= `.`）・変数展開・未解決 cd の後の相対パス | `find docs -name '*.md'`（読むだけ）、`find /tmp/scratch -delete`、`find src -exec grep …` |
| `xargs` + 書き込み動詞 | `xargs` のオプション列の直後が `rm` / `mv` / `tee` / `sed` / `sh` / `bash` / `node` … のいずれか（入力リストは判定不能なので fail-closed）。`{}` が節区切りになる `xargs -I{} sh -c '…'` は行全体で判定 | `xargs wc -l` / `xargs grep` / `xargs cat` |
| git の履歴操作 | `git stash`（`list` / `show` 以外）、`git revert`、`git reset` に `--hard` / `--merge` / `--keep` / `--soft` / `--mixed` またはコミット指定（`HEAD~1`、SHA、`origin/x`、`main`、`@{…}`）があり `--` が無い | `git stash list` / `git stash show -p`、`git reset`、`git reset -- <paths>`、`git reset HEAD -- <paths>`（インデックスだけ戻す形） |

実装上の注意点（パッチの中で説明済み）:

- `normalize()` は `{` / `}` を節区切りにするため、`awk -i inplace '{print}' <path>` と
  `xargs -I{} sh -c '…'` は節単位では動詞と対象が分断される。`feeder_write_hit()` を追加し、
  `interpreter_write_hit()` と同じく**行全体**で判定する。
- `protected_parent()` を追加し、`docs` とリポジトリ直下を「保護対象を含む親」として扱う
  （`docs/research` などの兄弟は対象外のまま）。
- 遮断メッセージ内の変数展開は `${tok}` の形にする。`$tok（` は bash が `tok（` を変数名と解釈し
  `set -u` で落ちる（実測。落ちた場合はフックがエラー終了し**素通りになる**）。

## 検証（2026-09-24、スクラッチ用ワークツリーで実施）

- 修正案を当てた `scripts/deny-dangerous-bash.sh` に対し
  `tests/unit/hooks/deny-dangerous-bash.test.ts`（既存 201 件 ＋ 追加 34 件）: **235 / 235 合格**。
- 追加した遮断ケース（抜粋、すべて exit 2 を実測）:
  `awk -i inplace '{print}' scripts/deny-dangerous-bash.sh` / `gawk -i inplace '{print}' .claude/settings.json` /
  `ed -s scripts/deny-dangerous-bash.sh` / `ex -sc wq …` / `vim -es tests/…` / `sponge scripts/deny-dangerous-bash.sh` /
  `echo '{}' | sponge docs/gates/legal-clearance.json` / `find tests -name '*.test.ts' -delete` /
  `find . -name '*.json' -delete` / `find -name '*.test.ts' -delete` / `find docs -type f -delete` /
  `find $DIR -name '*.json' -delete` / `cd $TARGET && find . -name '*.json' -delete` /
  `xargs rm < /tmp/list.txt` / `cat /tmp/list.txt | xargs -0 rm -f` / `xargs -I{} sh -c 'echo x > {}' < /tmp/list.txt` /
  `git stash push tests/unit/hooks/deny-dangerous-bash.test.ts` / `git stash` / `git stash pop` /
  `git revert --no-edit HEAD` / `git reset HEAD~1` / `git reset --soft HEAD~1` / `git reset --keep origin/main`
- 追加した通過ケース（すべて exit 0・stderr 空を実測）:
  `find docs -name '*.md'` / `find /tmp/scratch -name '*.log' -delete` / `find src -name '*.tsx' -exec grep -l useState {} \;` /
  `ls tests/unit | xargs wc -l` / `git stash list` / `git stash show -p` / `git reset` /
  `git reset -- src/app/page.tsx` / `git reset HEAD -- src/app/page.tsx` / `awk '{print $1}' docs/run-log/task_005.json`
- 同ワークツリーで `npx vitest run tests/unit` を実行: **26 ファイル / 768 件すべて合格**（修正案が他の
  単体テストを壊していないことの確認。統合テストと gate-meta は適用時に本リポジトリで実行する）。

## 既知の制約（受け入れるか判断が要る点）

- 既存の git 系ルールと同じく節全体で一致を取るため、**コミットメッセージ等の散文に `git stash` /
  `git revert` / `git reset HEAD~1` が現れる Bash 節も遮断される**（`node / deno / bun` の散文と同じ
  クラス。散文では「stash」「revert」と書く）。
- `xargs git add …` も遮断される（`git` を書き込み動詞に含めたため）。読み取り専用の `xargs` は通る。
- `git rebase` / `git filter-branch` / `git update-ref` は §2 に無いので今回は対象外（列挙方式の限界は
  §2 の「対応案 (a) allowlist 方式へ寄せる」が根本策。本提案はその前段の穴埋め）。

## 適用手順（PO。Claude のフックの外で実行する）

```
cd /Users/noritakasawada/AI_P/cashapp
git apply --check docs/proposals/task_005-round5.patch
git apply docs/proposals/task_005-round5.patch
npm run test:unit -- tests/unit/hooks/deny-dangerous-bash.test.ts
npm run test:gate-meta
node scripts/gate-integrity.mjs --write-baseline     # deny-dangerous-bash.sh は G13 の対象
npm run gate:check
git add scripts/deny-dangerous-bash.sh tests/unit/hooks/deny-dangerous-bash.test.ts docs/gates/integrity-baseline.json
git commit -m "task_005(5周目): 残穴 §2 の 11 件を遮断（docs/proposals/task_005-round5 を適用）"
```

適用後は `docs/concerns/task_005.md` §2 を「閉塞（5 周目）」に更新し、`docs/task-list.json` の task_005
の concerns から `[severity: high]` の項目を external の低リスク項目へ落とす。
