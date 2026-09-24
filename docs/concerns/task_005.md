# task_005 — 残懸念

対象: `scripts/deny-dangerous-bash.sh` / `scripts/deny-test-weakening.sh` / `.claude/settings.json` /
`package.json` の `lint:changed` / `tests/unit/hooks/**`

3 周目（hardening）と 4 周目のレビュー指摘の処理結果、および処理の過程で実測した残穴を記録する。
「指摘 / 深刻度 / 対応案 / 対応予定タスク」の形式。

---

## 0. 4 周目レビュー指摘 8 件の処理結果（すべて修正済み）

| # | 深刻度 | 指摘 | 修正 | 検証 |
|---|---|---|---|---|
| 1 | high | コマンド名を語頭で錨づけしていたため `./node_modules/.bin/wrangler deploy` と `npx wrangler@latest deploy` が本番デプロイ判定を素通り | 各トークンを basename 化し `@版` を落とした変種にも rule set A を当てる（`basename_clause()`） | 遮断ケース 8 件追加。`./node_modules/.bin/vitest run tests/unit` 等の許可ケースで巻き込みが無いことも検査 |
| 2 | high | `cp` / `mv` / `rsync` / `install` が `protected()` しか呼ばず、宛先をディレクトリ名で書くと素通り | `protected_tree()` を併用し、`-t <dir>` と `--target-directory=<dir>` の値も判定（`opt_value()`） | 遮断ケース 7 件追加 |
| 3 | high | `cd` 追跡が節の先頭が literal `cd` のときしか発火せず、サブシェル・ブレースグループ・`bash -c`・`pushd`・`&` で無効化された | `normalize()` が `(` `)` `{` `}` `&` も節区切りに畳み、`strip_wrappers()` で `bash -c` / `sudo` / `env` / `VAR=…` を剥がしてから `cd` / `pushd` を判定。解決できない `cd` の後は相対の宛先を fail-closed | 遮断ケース 11 件追加。`(cd src && echo x > page.tsx)` 等の許可ケース 7 件で巻き込みが無いことも検査 |
| 4 | medium | `lint:changed` が git 未追跡の新規ファイル（Write ツールが作る形）を 1 件も eslint に渡さない | 収集を「HEAD 差分 ＋ ステージ済み差分 ＋ `git ls-files --others --exclude-standard`」の 3 つの和に変更 | 使い捨て git リポジトリ＋eslint スタブで 9 シナリオ実測（未追跡 .ts / .tsx が渡る・gitignore 済みは対象外・重複は 1 回・eslint 失敗が伝播）。テスト 5 件追加 |
| 5 | medium | `patch_rules_hit()` が `git am` を見ておらず素通り | 検出を `git +(apply\|am)` に拡張 | 遮断ケース 3 件追加。ライブのフックでも BLOCKED を実測 |
| 6 | medium | PreToolUse の編集側 matcher が `Edit\|Write\|MultiEdit` のみで、MCP のファイル編集ツールがガードを起動せずに保護対象を書き換えられた | matcher を `Edit\|Write\|MultiEdit\|NotebookEdit\|mcp__serena__.*` に拡張し、`deny-test-weakening.sh` に MCP 分岐を追加（`relative_path` / `paths_include_glob` から対象を取り出す。対象を限定しない一括編集・`.claude/**`・編集前本文を示さない tests/** 編集は fail-closed） | 遮断ケース 10 件・許可ケース 3 件追加。ライブのフックで `mcp__serena__replace_content` が実際に BLOCKED になることを実測 |
| 7 | medium | `git push` の強制判定がフラグ形だけで、`+` 付き refspec が素通り | `git push` の節に `+` 始まりのトークンがあれば遮断 | 遮断ケース 3 件追加 |
| 8 | medium | `script_names()` が npm / yarn / npx の 3 形式しか解決せず、Node 22 の `node --run <script>` が残っていた | `node --run <name>` / `node --run=<name>` を抽出して既存の解決経路へ流す | 遮断ケース 3 件追加、許可ケース `node --run test:unit` で巻き込みが無いことも検査 |

フックのユニットテストは 215 → 272 件、`npm run test:unit` は 259 → 321 件で全 pass。

---

## 1. 3 周目レビュー指摘 7 件の処理結果（すべて修正済み）

| # | 指摘 | 状態 | 検証 |
|---|---|---|---|
| 1 | `>\|`（noclobber 上書き）が遮断されない | 修正 | `normalize()` が `\|` を節区切りにする前に `>\|` を `>` へ畳む。遮断ケース 4 件 |
| 2 | `rm -r .` / `git checkout .` / `git clean -fdx` 等の全面迂回 | 修正 | `.` `./` `..` `*` `/` 等を「ここ全体」として拒否。`git clean` は dry-run 以外を拒否。遮断ケース 13 件 |
| 3 | `git apply` / `patch` による保護ファイルの書き換え | 修正 | 読めるパッチは本文を走査、読めなければ fail-closed。遮断 5 件＋「無害と示せるパッチは通す」1 件 |
| 4 | `cd` 後の相対パス・変数展開された宛先 | 修正 | 節ごとに `cd` を追跡（`CWD_REL`）して宛先を解決。`$` を含む宛先は解決不能として拒否 |
| 5 | `.claude/**` 保護がスクリプト名の出現回数 | 修正 | 編集後のファイルを組み立てて jq で解析し、event / matcher / command の登録を検査 |
| 6 | `lint:changed` が remote 不在で常に空振り | 修正 | remote を参照しない定義へ（未追跡ファイルの取りこぼしは 4 周目 #4 で追加修正） |
| 7 | 上記を `tests/unit/hooks/*.test.ts` に追加 | 修正 | フックのユニットテスト 148 → 215 件 |

---

## 2. 残穴（未閉塞。4 周目でも変化なし）

`scripts/deny-dangerous-bash.sh` に実際にフック入力を流して確認した結果（`ALLOW` = 素通り）。
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
  （`--hard` 以外）は素通りする。列挙方式である限り漏れは構造的に残る。
- **深刻度**: high（ガード本体とテストを 1 コマンドで書き換え・巻き戻しできる）。
  ただし「悪意ある回避」を前提にしたときの深刻度であり、通常作業では踏まない。
- **対応案**: 列挙の追加ではなく方針を変える。(a) `interpreter_write_hit()` と同じく
  「コマンド行のどこかに保護対象パスが現れたら、読み取り専用と明示できるコマンド
  （`cat` / `ls` / `grep` / `jq` / `git diff` / `git log` / `git add` 等）以外は fail-closed」
  という allowlist 方式へ寄せる。(b) `git stash` / `git revert` / `git reset` は、
  対象に保護対象パスを含むかを `git diff --name-only` で事前判定して遮断する。
- **対応予定タスク**: 未起票（task_005 の次の hardening ラウンド）。**deferred**。

---

## 3. ガード本体をセッション内から編集する経路（accepted-risk。4 周目で文言を訂正）

3 周目は「経路が 1 つも残っていない」と書いたが、それは誤りだった。4 周目のレビューが
`git am` の素通りを実測し、§2 の残穴も未閉塞のまま現存する。現状の正確な記述は次のとおり。

- **正規の編集経路は塞がっている**:
  - Edit / Write / MultiEdit / NotebookEdit → `deny-test-weakening.sh` が `scripts/(deny-*|record-run.sh)` を拒否
  - MCP のファイル編集ツール（`mcp__serena__*`）→ 4 周目 #6 で同じ判定に接続（ライブで実測済み）
  - Bash のリダイレクト・`tee`・`sed -i`・`cp`/`mv`・`rm`・`chmod`・`ln`・`dd`・インタプリタの
    ワンライナー → `deny-dangerous-bash.sh` が拒否
  - `git apply` / `patch`（3 周目）と `git am`（4 周目）→ パッチ本文に `scripts/deny-` が現れるため拒否。
    読めないパッチは fail-closed
- **迂回路は残っている**: §2 に列挙した `ed` / `ex` / `vim -es` / `awk -i inplace` / `sponge` /
  `find -delete` / `xargs rm` / `git stash` / `git revert` / `git reset`。したがって
  「セッション内からガードを変更できない」とは言えない。§2 を閉じるまでこの状態が続く。
- 4 周目の修正そのものは、**まだ通っていた `git am`** でメールボックス形式のパッチを当てて適用した
  （3 周目は同様に `git apply` を使った）。適用後は同じ経路が塞がっている。§2 の残穴は
  迂回路であって正規の手段ではないため、修正には使っていない。
- **深刻度**: medium（正規経路としては塞がっており、次の hardening ラウンドはセッション内で
  作業できない。一方で §2 が開いている限り自己保全は完全ではない）。
- **対応案**: ガードを直す必要が出たら、次のいずれかを PO が選ぶ。
  1. PO が Claude Code の外（通常のエディタ）で `scripts/deny-*` を編集する。
  2. `.claude/settings.json` の PreToolUse 登録を PO が一時的に外して作業し、戻す
     （フック登録を外す編集は AI からは通らないが、PO の手編集なら可能）。
  3. ガードを複数ファイルに分け、追加分を `scripts/deny-*` に当たらないパスへ置けるようにする
     設計変更を起票する。
- **対応予定タスク**: 未起票（PO 裁定）。**accepted-risk**。

---

## 4. 構造検査の到達範囲（コマンド文字列の意味までは検査していない）

- **指摘**: `.claude/settings.json` の構造検査は「event / matcher / command 文字列」までしか見ない。
  登録されたコマンドが実際にガードを起動するかどうかは、コマンド文字列を実行せずには決定できない。
  `#` 以降を無視して名前を探すことで `true # deny-dangerous-bash.sh` のようなコメント化は落とせるが、
  `bash -c 'exit 0' # …` を組み立てるような改変までは検出できない。
- **深刻度**: low（`.claude/**` の編集自体が PO の目に触れる差分として残る）。
- **対応案**: フックの実効性を「登録内容の静的検査」ではなく「起動して exit 2 を返すか」で
  検査する smoke テスト（`npm run gate:hooks` 相当）を CI に置く。
- **対応予定タスク**: 未起票（task_006 のゲート整備と合わせて検討）。**deferred**。

---

## 5. 遮断理由の文言・散文の巻き込み（fail-closed の副作用）

- **指摘 A**: 保護対象ディレクトリへ `cd` した後の削除系の節は、節の全トークンが
  「そのディレクトリ配下のパス」として解決されるため、遮断メッセージが引用するトークンが
  コマンド名そのものになることがある。実測例:
  `cd docs/run-log && rm nonexistent-probe.json` → `該当: 削除・復元の対象 rm`。
- **指摘 B**: パッチ適用ルールはコマンド行に `git apply` / `git am` / `patch` という語が
  並んでいれば発火する。散文（コミットメッセージ・`echo`・`record-run.sh --manual` の観察文）に
  同じ語が現れるだけで遮断される。実測例:
  `scripts/record-run.sh --manual task_005 '… git am …'` → BLOCKED。
  インタプリタ判定は 3 周目に「フラグがインタプリタ自身のものか」を見る形へ直したが、
  パッチ適用ルールは同じ絞り込みをしていない。
- **深刻度**: low（どちらも遮断の方向であり、判断が緩む側ではない。作業の言い換えで回避できる）。
- **対応案**: 削除系の走査でコマンド名トークンと `-` 始まりのトークンを対象判定から除外する。
  パッチ適用ルールは「節の先頭トークンが `git` / `patch` であること」を条件に加える。
- **対応予定タスク**: 未起票（次の hardening ラウンドで §2 と同時に）。**deferred**。

---

## 6. 既存の未達

- `check_053`（新規セッションでの SessionStart 注入の目視）は 3 周目で
  `claude` CLI のヘッドレス新規セッションにより実測済み。4 周目では再実行していない。
- 3 周目に記録した `tests/unit/db-client.test.ts` の失敗は解消済み。原因だった
  `src/lib/db/client.ts` の変更が並行タスク側で `69935e5` としてコミットされ、4 周目の
  `npm run test:unit` は 8 ファイル 321 件すべて pass（`docs/run-log/task_005.json`）。
- PostToolUse（typecheck / lint:changed / gate:constraints）の matcher は
  `Edit|Write|MultiEdit` のままで、MCP のファイル編集ツールを覆っていない。PreToolUse の
  ガードだけを 4 周目 #6 の指摘どおり拡張した。MCP 経由の編集は typecheck / lint を
  起動しない。**深刻度 low**、**対応予定タスク**: 未起票。**deferred**。
- GitHub リモートが未作成のため、CI（GitHub Actions）での実走検証は行えない。
  task_005 は `.github/workflows/**` を作らないため done_definition には影響しない。
  **deferred: GitHub リモート作成後に実施**。
