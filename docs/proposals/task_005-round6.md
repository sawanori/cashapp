# 提案: task_005 6 周目 — GPT-6 Astra の high 8 件を塞ぐ

- 起票日: 2026-09-24
- 起票者: メインセッション（Claude）
- 対象: `scripts/deny-dangerous-bash.sh` / `scripts/deny-test-weakening.sh` /
  `tests/unit/hooks/deny-dangerous-bash.test.ts` / `tests/unit/hooks/deny-test-weakening.test.ts`
- 状態: **PO のレビュー待ち（未適用）**
- 根拠: 敵対レビュー B（`adversarial-reviewer-gpt` / GPT-6 Astra、`codex-cli 0.154.0`、verdict FAIL）の
  F-1〜F-8（severity high）。F-9（medium）は本提案の対象外（後述）。
- ベースコミット: `ffe9f01`。4 つの対象ファイルは `96aca7d`（起票時点の HEAD）でも同一であることを
  `git diff --stat ffe9f01..HEAD --` と `git status --porcelain --` で確認済み。
- **このパッチは 5 周目（`task_005-round5.patch`）を含む累積パッチ**。5 周目が未適用のリポジトリに
  そのまま当たる。

## なぜ提案の形なのか

ガード本体（`scripts/deny-*` / `scripts/record-run.sh`）は `scripts/deny-test-weakening.sh` により
**Edit / Write ツールからも書き換えを遮断**している（ガード自己保全、R-SEC-07 / R-TH-02）。したがって
AI は修正を直接当てられない。修正内容をパッチとして置き、人間（PO）が hooks の外で適用する。

検証はスクラッチ用の git worktree（`git worktree add --detach` で HEAD から作成、`node_modules` は
本リポジトリのものを symlink）で行い、リポジトリ本体のガード・テストには一切書き込んでいない。

## 各指摘: 再現 → 修正 → 実測

再現・実測は「5 周目まで適用済みのワークツリー」と「6 周目まで適用したワークツリー」の両方に、
指摘の repro と同じフック入力 JSON を stdin で流し、終了コードを読む方法で行った
（0 = 素通り、2 = 遮断）。**5 周目の状態では下表の 13 入力すべてが exit 0 だった**。

| # | 再現に使った入力 | 5 周目 | 修正 | 6 周目 |
|---|---|---|---|---|
| F-1 | `/bin/cp /dev/null .claude/settings.json` | exit 0 | 書き込み規則の動詞に前置パス `([^ ]*/)?` を許す（`CMD_PFX`）。`raw_rules_hit` の `basename_clause` は使えない（オペランドのディレクトリまで落ちて保護対象が見えなくなる） | exit 2 `cp/mv の対象 .claude/settings.json` |
| F-1 | `/bin/rm scripts/deny-dangerous-bash.sh` | exit 0 | 同上（`rm` / `tee` / `sed` / `chmod` / `dd` / `find` / `xargs` / `git` / `patch` / インタプリタすべてに適用。`is_rm_rf` の `case " $s " in *" rm "*` も正規表現へ） | exit 2 `削除・復元の対象 scripts/deny-dangerous-bash.sh` |
| F-2 | Write `{"file_path":"scripts/./deny-dangerous-bash.sh", …}` | exit 0 | `deny-test-weakening.sh` に `norm_path()` を足し、判定はすべて正規化した `FILE_N` で行う（メッセージには元の `$FILE` を残す） | exit 2 `対象: scripts/./deny-dangerous-bash.sh` |
| F-2 | `/bin/cp /dev/null scripts/./deny-dangerous-bash.sh`（Bash 側） | exit 0 | `protected()` / `protected_tree()` の `[ -n "$CWD_REL" ]` 条件を外し、`join_path()`（`.` / `..` を畳む）を常に通す | exit 2 `cp/mv の対象 scripts/./deny-dangerous-bash.sh` |
| F-3 | `.claude/settings.json` の `PreToolUse[0].hooks[0].command` を `"true deny-dangerous-bash.sh"` にした全文を Write | exit 0 | `EXPECTED_HOOKS` に `kind`（`script` / `npm`）を足し、jq の `contains($c)` を「実際に実行される位置にあるか」を見る `test()` に置き換えた。script は「代入・`env`/`exec`/`command`・インタプリタ+オプションを挟んだ先頭のトークン」、npm は「`npm`/`yarn`/`pnpm` の `run` の引数」でなければ登録と認めない | exit 2 `対象: .claude/settings.json` |
| F-4 | Edit `old_string:"(\`exit 2: ${command}\`, () => {"` → `new_string:".skip(…"`, `replace_all:true` | exit 0 | tests/** の Edit / MultiEdit は、`edit_result()`（`settings_result()` を汎用化）で編集後の全文を組み立て、**ディスク上の現物と全文どうしで** `.skip/.todo/.only` の増加・`it/test` の減少・`expect` の減少を数え直す。断片どうしの比較は従来どおり残す（両方が通らないと許可しない） | exit 2 `対象: tests/unit/hooks/deny-dangerous-bash.test.ts` |
| F-5 | `git -C . reset --hard HEAD` | exit 0 | `strip_git_opts()` を足し、`git` の直後のグローバルオプション（値を取るものはその値も）を落とした変種を作って同じ規則を再適用する。`-C` / `--work-tree` / `--git-dir` の値はそのサブコマンドが動くディレクトリとして `CWD_REL` に一時反映する | exit 2 `git reset --hard` |
| F-5 | `git -c core.pager=cat reset --hard HEAD` / `git --git-dir=.git reset --hard HEAD` / `git --no-pager reset --hard HEAD~1` | exit 0 | 同上 | exit 2 `git reset --hard` |
| F-5 | `git -C docs/run-log checkout .` | exit 0 | 同上（`-C` の値を `CWD_REL` に反映 → `.` が保護ツリーを指す） | exit 2 `削除・復元の対象` |
| F-5 | `git -C $DIR restore src/app/page.tsx` | exit 0 | `git_global_unresolved()`: `-C` の値が変数展開で解決できず書き込み系サブコマンドが続く場合は fail-closed | exit 2 |
| F-6 | `"wrangler " + "\\" + "\n" + "deploy --env production"` | exit 0 | `normalize()` の順序を変え、改行をいったん `NLP`(`\004`) に退避してから `\`+`NLP` を畳む（従来はバックスラッシュを先に消してから改行を節区切りにしていた） | exit 2 `wrangler deploy` |
| F-7 | `cd tests/unit/hooks/fixtures && npm run release`（`DENY_BASH_PACKAGE_JSON` 未設定） | exit 0 | `pkg_dir_for_cwd()` / `pkg_for_cwd()` を足し、追跡している `cd` の位置から上へ辿って最初に見つかった `package.json` で解決する。入れ子の走査には `PKG_REL` を引き継ぐ | exit 2 `wrangler deploy`（release → build / deploy:production → `wrangler deploy --env production` まで辿った） |
| F-8 | `cd .claude && (cd ..) && printf x > settings.json` | exit 0 | `normalize()` が `(`/`{` と `)`/`}` を別の目印（`SUB_OPEN` / `SUB_CLOSE`）に変え、駆動部が `push_cwd` / `pop_cwd` で `(CWD_REL, CWD_UNKNOWN)` を積み下ろしする | exit 2 `リダイレクト先 settings.json` |

通過側（修正後も exit 0 のままであることを同じ方法で実測）: `git status --porcelain` /
`git -C . status` / `(cd src && echo x > page.tsx)` / `npm run test:unit` /
`cd "$CLAUDE_PROJECT_DIR" && npm run --silent typecheck` / `src/app/page.tsx` への Write /
現行の `.claude/settings.json` をそのまま書き直す Write。

## 追加したテスト（既存は 1 件も弱めていない）

`tests/unit/hooks/deny-dangerous-bash.test.ts`（235 → **270**、+35）:

- 遮断側: `/bin/cp /dev/null .claude/settings.json` / `/bin/rm scripts/deny-dangerous-bash.sh` /
  `/usr/bin/sed -i '' s/x/y/ scripts/record-run.sh` / `/usr/bin/tee docs/run-log/task_005.json` /
  `/bin/chmod -x scripts/deny-test-weakening.sh` / `/usr/local/bin/rsync -a /tmp/logs/ docs/run-log/` /
  `cp /dev/null scripts/./deny-dangerous-bash.sh` / `rm ./scripts/deny-test-weakening.sh` /
  `echo x > docs/./run-log/task_005.json` / `echo x > docs/gates/../gates/legal-clearance.json` /
  `git -C . reset --hard HEAD` / `git -c core.pager=cat reset --hard HEAD` /
  `git --git-dir=.git reset --hard HEAD` / `git --no-pager reset --hard HEAD~1` /
  `git -C docs/run-log checkout .` / `git -C . clean -fdx` / `git -C . stash` /
  `git -C $DIR restore src/app/page.tsx` / 行継続版の `wrangler deploy --env production` /
  `npm run deploy:production` / `rm -f`+`-r` / `cd .claude && (cd ..) && printf x > settings.json` /
  `cd docs/run-log && (cd /tmp) && echo x > y.json` / `cd tests && { cd ..; } && echo x > smoke.test.ts`
- 通過側: `git -C . status --porcelain` / `git -C src log --oneline -5` / `git --no-pager diff --stat` /
  `git -c core.pager=cat log -1` / 行継続版の `git status --porcelain` /
  `cd src && (cd ../docs) && echo x > page.tsx` / `(cd src && echo x > page.tsx) && echo done` /
  `/bin/ls tests/unit/hooks` / `/usr/bin/grep -rn expect tests/unit`
- F-7 専用の 2 件（`run()` に渡す package.json を切り替えて、ルートの package.json では
  解決できない `release` がフィクスチャ側で解決されることと、`cd` の先に package.json が
  無ければ従来どおり上位で解決することを分けて見る）

`tests/unit/hooks/deny-test-weakening.test.ts`（52 → **67**、+15）:

- F-2: `scripts/./deny-…` / `./scripts/deny-…` / `scripts/../scripts/record-run.sh` /
  `docs/./run-log/` / `docs/gates/../gates/` / `tests/./contract/…` の遮断と、
  `src/./app/page.tsx` の通過
- F-3: `true deny-dangerous-bash.sh` / `echo deny-test-weakening.sh` / `echo lint:changed` の遮断と、
  `node --no-warnings "…/session-brief.mjs"`（オプション挟み）・`"…/append-handoff.sh"`（直接実行）の通過
- F-4: `replace_all` の Edit と同形の MultiEdit の遮断、および `allowed` 配列に 1 行足すだけの
  Edit が通ること。`edit()` ヘルパに `replaceAll` 引数、`multiEdit()` の型に `replace_all?` を追加した
  （既存呼び出しの挙動は変わらない）

## 検証（2026-09-24、スクラッチ用ワークツリーで実施）

- `npx vitest run tests/unit/hooks/deny-dangerous-bash.test.ts tests/unit/hooks/deny-test-weakening.test.ts`:
  **337 / 337 合格**（内訳 270 + 67）。同じコマンドを 5 周目までの状態で回すと 287（235 + 52）。
- `npx vitest run tests/unit`（6 周目適用）: 30 ファイル **949 件中 941 件合格 / 8 件失敗**。
  失敗 8 件はすべて `tests/unit/gate-constraints.test.ts` の
  `Error: Test timed out in 5000ms.` で、本提案が触っていないファイル。
- 同条件の基準線（**5 周目までしか当てていない**同じ構成のワークツリー）で `npx vitest run tests/unit`:
  **899 件中 888 件合格 / 11 件失敗**。失敗 11 件もすべて `tests/unit/gate-constraints.test.ts` の
  同じ timeout（`grep -c "Test timed out"` = 11）。件数の差 50 は追加テスト 50 件（35 + 15）と一致する。
- `tests/unit/gate-constraints.test.ts` を単体で回すと、未改変 HEAD のワークツリーでも
  1 回目 6 失敗 / 2 回目 30 件全合格、6 周目のワークツリーでも 3 失敗と揺れる。
  **負荷依存で落ちる既存の不安定テストであり、本提案による退行ではない**（同ファイルは
  一時 git リポジトリを都度作る作りで、per-test の timeout が 5000ms）。
- `bash -n` による構文検査: 両ガードとも通る。

未実施（適用時に PO が本リポジトリで回す必要がある）: `npm run test:gate-meta` /
`npm run gate:check` / `node scripts/gate-integrity.mjs --write-baseline` /
統合テスト。**本提案ではリポジトリ本体を変更していないため、これらは走らせていない。**

なお、起票時点の本リポジトリは `npm run --silent typecheck` が
`tests/integration/events.test.ts` の TS2739（`Sql<{}>` が `TransactionSql<{}>` に足りない）で
exit 2 になる既存の状態で、これは本提案と無関係（PostToolUse フックがこの理由で毎回赤くなる）。

## 既知の制約（受け入れるか判断が要る点）

- **`.claude/settings.json` の構造検査（script 形式）は登録コマンドの形を絞る**。
  「代入 → `env`/`exec`/`command` → インタプリタ + そのオプション → スクリプトのパス」という
  並びしか認めないので、`cd "$X" && bash "…/deny-dangerous-bash.sh"` のように別のコマンドを
  先に置いた登録は実際には動くのに遮断される。現行の 9 登録はすべて通る形。
- **tests/** の Edit / MultiEdit は node を必要とする**。`command -v node` に失敗すると fail-closed で
  遮断する（`.claude/settings.json` の構造検査と同じ方針）。engines が node>=22 なので実運用では
  問題にならないが、node の無い環境では tests/** の編集が一切できなくなる。
- **動詞の前置パス許容はノイズを生む**。`([^ ]*/)?rm` は `/tmp/rm` のように末尾がたまたま動詞名と
  一致するトークンも動詞として扱う。fail-closed 側のノイズなので受け入れる。
- **`-C` の値が保護ツリーだと、その節の全トークンが `<cwd>/<token>` として保護対象に見える**。
  遮断の是非は正しいが、遮断メッセージが名指しするトークンが実際の対象とずれることがある
  （実測例: `git -C docs/run-log checkout .` の理由文が `削除・復元の対象 git`）。
- **`cd $VAR && npm run <name>` は従来どおりルートの package.json で解決する**。cd 先が解決できない
  ため、F-7 の修正が効かない変種として残る。名前が `deploy|secret|publish|reset|push|prod` に
  一致しなければ通る。根本策は §2 の「allowlist 方式へ寄せる」。
- 列挙方式そのものの限界（`git rebase` / `git filter-branch` / `git update-ref` などは対象外）は
  5 周目の提案と同じく残る。

## F-9（medium、対象外）

> 日本語ファイル名の変更が lint 対象から消える。Git が引用したパスは末尾に二重引用符を持つため、
> `grep` の `[.]tsx?$` に一致しない。対象がそのファイルだけなら、構文エラーがあっても
> 「対象なし」で成功終了する。（`package.json` line 8 = `lint:changed`）

ガード本体ではなく `package.json` の `lint:changed` 定義（と `scripts/lint-changed` 側）の問題なので、
本提案では直していない。**別途 task_005 の通常修正（Edit/Write が通る範囲）で対応できる**。
想定される直し方は `git -c core.quotePath=false diff --name-only …` を使うか、
`git diff -z --name-only` + NUL 区切りで読むかのどちらか。

## 適用手順（PO。Claude のフックの外で実行する）

```
cd /Users/noritakasawada/AI_P/cashapp
git apply --check docs/proposals/task_005-round6.patch
git apply docs/proposals/task_005-round6.patch
npm run test:unit -- tests/unit/hooks/deny-dangerous-bash.test.ts tests/unit/hooks/deny-test-weakening.test.ts
npm run test:gate-meta
node scripts/gate-integrity.mjs --write-baseline   # deny-* は G13 の対象
npm run gate:check
git add scripts/deny-dangerous-bash.sh scripts/deny-test-weakening.sh \
        tests/unit/hooks/deny-dangerous-bash.test.ts tests/unit/hooks/deny-test-weakening.test.ts \
        docs/gates/integrity-baseline.json
git commit -m "task_005(6周目): GPT-6 Astra の high 8 件を遮断（docs/proposals/task_005-round6 を適用）"
```

`task_005-round6.patch` は 5 周目を含む累積パッチなので、**5 周目のパッチを先に当てていると
当たらない**。先に 5 周目を当ててしまった場合は `git apply -R docs/proposals/task_005-round5.patch`
で戻してから 6 周目を当てる。

適用後は `docs/concerns/task_005.md` に 6 周目の閉塞を追記し、
`docs/review-log/task_005.json` の GPT-6 Astra 票の F-1〜F-8 を「閉塞（6 周目）」として扱う。
F-9 は task_005 の通常修正へ残す。
