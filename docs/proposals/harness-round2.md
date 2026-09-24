# 提案: ハーネス 2 周目 — Phase 1 後半プレモータム（P-02 / P-04 / P-05 / P-06 / P-11）への対応

- 起票日: 2026-09-24
- 起票者: メインセッション（Claude）
- 根拠: `docs/research/premortem-phase1b-2026-09-24.md`
- 状態: **PO の判断待ち（未適用）**

## なぜ今すぐ当てないのか

5 件はいずれもゲート（`scripts/gate-check.mjs` / `scripts/gate-integrity.mjs`）やガード本体
（`scripts/record-run.sh`）の判定条件を変える。実装ワークフロー v5（task_014〜023）が同じ作業ツリーで走って
おり、各エージェントの Stop フックが `gate:check` を実行する。判定条件をいま変えると、進行中のタスクが自分の
変更と無関係な理由で止まる（P-06 の G11 変更は特に、未コミット差分があるだけで違反になる）。
`record-run.sh` は Edit/Write からも自己保全されており、AI は変更できない。

したがって、**ワークフロー完了後の静かな時点で PO が順に適用する**前提で起票する。

## 提案一覧

| # | 対象 | 変更 | 影響 | 優先 |
|---|---|---|---|---|
| H2-1（P-02） | `scripts/gate-integrity.mjs` の `INTEGRITY_PATTERNS` | `docs/acceptance-checks.json` を単一ファイルとして追加し、G13 のハッシュ対象にする | 受入基準の本文を書き換えると G13 が落ち、基準値の再生成（= docs/gates/** の差分）が CODEOWNERS と tamper-guard に出る。evidence の記入も G13 を落とすため、**evidence は最終 HEAD で一括記入し、その直後に基準値を再生成する運用**が必要 | 高 |
| H2-2（P-04） | `scripts/record-run.sh`（自己保全対象。PO が適用） | 記録に `dirty_files`（`git status --porcelain` の行数）と、同時に存在する他タスクのロック名を追加する。判定は変えない | G4 に「`dirty_files > 0` の記録は DONE の根拠にしない」を足すのは第 2 段階（並行実装が終わってから） | 中 |
| H2-3（P-05） | `scripts/gate-check.mjs` に G15 | DONE 系タスクの `dependencies` がすべて DONE 系であること。`owner_model` が `human:` のタスクは、`docs/gates/dependency-bypass.json`（PO 専管、docs/gates/** 配下）に理由つきで記録された場合のみ bypass | 現状の bypass（task_035 / 007 / 013）を PO が明示的に記録することになる | 高 |
| H2-4（P-06） | `scripts/gate-check.mjs` の G11 | 「`in_progress` が 1 件以上」に加えて「未コミット差分のパスが、未完了タスクの `files_to_create` / `files_to_modify` に一致する」を着手中の判定に含める | 並行ワークフロー中は常時発火しうる。適用はワークフロー完了後 | 中 |
| H2-5（P-11） | `docs/task-list.json` の task_014〜021 の `verify_commands` | 画面を持つタスクに `test:a11y`（当該ページ限定）を追加。「完了済みタスク由来の赤」の引き受け先を `docs/PROGRESS.md` の運用規則として明記 | v5 の実装者は既に走っているため、追加分は task_022 の中で「到達しないページ数 0」を機械検査する形でも代替できる | 中 |

## 適用順（提案）

1. ワークフロー v5 完了（task_023 まで）を待つ。
2. H2-3（G15）→ H2-1（acceptance-checks を G13 に）→ H2-4（G11）→ H2-2（record-run）→ H2-5 の順に、
   1 件ずつ `npm run test:gate-meta` と `npm run gate:check` を通してコミットする。
3. 各件の違反フィクスチャ（`tests/gates/fixtures/`）を同時に足し、G0（メタゲート）で空振りを防ぐ。

## 追加（同日）: task_006 への GPT-6 Astra 敵対レビュー（docs/review-log/task_006.json、reject、high 3 / medium 4）

gate-check.mjs 等の判定条件を変える指摘なので、上と同じ理由でワークフロー完了後に適用する。
適用前に「現在の台帳で新たに違反になる完了済みタスク」を洗い出し、該当タスクの記録を先に補う
（G4 の手動検証記録など）。そうしないと、進行中エージェントの Stop フック（gate:check）が他タスクの
記録不足で止まる。

| # | 対象 | 指摘（GPT F-id） | 変更 |
|---|---|---|---|
| H2-6 | `scripts/gate-check.mjs` G4 | F-1 (high): verify_commands が非空だと manual_verification の記録を検査しない | 両方を検査する（manual 項目は全件に記録を要求） |
| H2-7 | `scripts/gate-check.mjs` G4 | F-2 (high): 同じ手動検証記録の複製で別項目を充当できる | 記録の `manual_verification[<索引>]` 明示を必須にし、索引の重複・欠落を違反にする |
| H2-8 | `scripts/gate-check.mjs` G8 | F-3 (high): コミット済みの追加行が秘密値走査の入力に入らない | 直近 N コミット（または origin/main 以降）の追加行も走査対象に含める |
| H2-9 | `scripts/validate-plan-json.mjs` | F-4 (medium): 台帳が JSON の null でも exit 0 | 読み取り結果が object でなければ違反 |
| H2-10 | `scripts/gate-check.mjs` G2 | F-5 (medium): 計画（§13）に無い script 名を package.json に足せば warn 止まり | §13 に無い名前は違反（計画の記述どおり） |
| H2-11 | `scripts/test-hook-enforcement.sh` | F-6 (medium): 登録行の存在だけを見て、登録コマンドの実体を使わずに固定の deny スクリプトを呼ぶ | settings.json の登録コマンドをそのまま実行して遮断を検査する |
| H2-12 | `scripts/gate-check.mjs` G7 | F-7 (medium): 基準値は再帰、G7 は 2 階層までで件数が食い違う | 両者を同じ走査関数にする |
| H2-15 | `scripts/deny-dangerous-bash.sh`（ガード本体。task_005 の 7 周目候補） | 実測 2026-09-24〜25: 並行エージェントの `git add -A` が他タスクの add 済み内容を巻き戻し（a6953f2 → 46fc8bf、171760b で復旧）、以後 task_004 は私用インデックス（GIT_INDEX_FILE + write-tree/commit-tree）で回避した。規則で禁止していてもフックは止めない | `git add -A` / `git add --all` / リポジトリ直下での `git add .` を遮断（パス明示だけを許す）。併せて `git commit -a` も遮断 |
| H2-16 | 制約ゲート（task_004、`scripts/gate-constraints.sh` / `wording-lint.mjs`） | C-004-8 [high・未解消]: 行指向 grep は複数行にまたがる回避（改行した `OR`、改行した動的 import、エスケープしたバックティック）を閉じられず、G5 が 2〜6 回目まで毎回同型の high を返した | 道具の交換。TypeScript 側は AST（task_011 の `assert-server-only.mjs` と同じ手法）、SQL 側は task_018 の台帳テストで担保し、grep ゲートは「早期検出」に格下げする |
| H2-14 | `scripts/gate-check.mjs` G4（`progressDeclarations`） | 実測 2026-09-24（task_013 の修正者）: task ごとに docs/PROGRESS.md の**最初の**宣言行しか採らないため、後から正しい形式で BLOCKED / DONE_WITH_CONCERNS の行を足しても台帳との照合に使われず、先頭行のトークンを書き換える運用になった | 最後の宣言行（最新）を採る。先頭行は履歴として残す |
| H2-13 | `scripts/merge-review.sh` / `scripts/validate-findings.mjs`（task_007） | 実測 2026-09-24: GPT の finding の repro に例示の本番鍵形式トークンが含まれ、GitHub の push protection が docs/review-log/task_006.json:184 で push を拒否した（メインセッションが該当トークンだけを `***` にマスクして再 push） | 封筒を review-log に追記する前に秘密値らしきトークン（sk_/rk_/pk_ の live|test、AKIA、ghp_、xox*-、PEM、JWT 形式）をマスクする。scripts/record-evidence.mjs の maskSecrets() と同じ規則を共有する |

## 参考: P-01 / P-03 / P-07 / P-08 / P-10 / P-12 の扱い

これらは実装タスク側の失敗モードなので、`docs/task-list.json` の task_014〜023 の `files_to_read` に
`docs/research/premortem-phase1b-2026-09-24.md` を配線した。各タスクの実装者とレビュアーが読む。
P-03（`organizer_label NOT NULL` と check_043 の矛盾）と P-12（ADR-007 未作成）は PO 判断を伴う。
