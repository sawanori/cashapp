# task_008 の残懸念

Workflow スクリプト 3 本（`.claude/workflows/task-loop.ts` / `premortem.ts` / `release-audit.ts`）。
形式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

## 6 周目（修正周）で閉じた指摘

- **[high・解消済み] `task-loop.ts` が実効 high を直近 1 周分しか保持していなかった**。
  high を出したレビュア経路が最終周で不達（欠票）になると、前の周で確定していた high が消えて
  DONE で閉じていた（修正前の HEAD に対する実測: `status: "DONE"` / `effective_high_remaining: 0`）。
  未解消 high を `unresolvedHigh` として周をまたいで持ち越し、**その周に有効票（`reviewer_route === "ok"`）を
  返したレーンが挙げなくなった分だけ**落とす形に直した。欠票したレーンは自分の過去の high を落とせない。
  修正後の同じ応答表では `BLOCKED` / `effective_high_remaining: 1`（実測）。
- **[high・解消済み] 有効票を返した独立ベンダーが 0 件の周でも DONE で閉じられた**。
  修正前は gemini / gpt の両方が最初から不達でも 1 周で `DONE` が出ていた（実測）。
  「high 0 件で打ち切る周」に監査済みの判定（`votingVendors.length > 0`）を足し、
  監査されていない周は `BLOCKED` にした。修正後は `BLOCKED` / `rounds_used: 1`（実測）。
- **[medium・解消済み] `release-audit.ts` の成立条件 1 が fail-open だった**。
  `goVendors.length >= 2 && independentGoVendors.length >= 1`（作者 claude ＋ 独立 1 件で go）を、
  `independentGoVendors.length >= REQUIRED_GO_VENDORS`（独立 2 件）に締めた。解釈の食い違いは C-008-10。

再現と対照は `tests/unit/workflows/workflow-scripts.test.ts`（44 ケース・全緑）と、
修正前の HEAD を同じ応答表で走らせる非空振りの対照（scratchpad の `control-r6.mjs`。3 ケースとも
修正前は `DONE` / `go`）で取ってある。

---

## C-008-1 [medium] Workflow ツールが本セッションに無く、3 本の「起動」を run ID で記録できていない

**指摘**: `done_definition` の第 1 項は「3 本が起動する（run ID を record-run で記録）」であり、
`manual_verification` は「Workflow ツールで task-loop.ts を task_003 に対して実行」である。
本セッション（実装エージェント）のツール一覧に `Workflow` は無く、`ToolSearch` の
`select:Workflow` も `No matching deferred tools found` を返した。**したがって runId は 1 つも取得できていない。**
journal（`<transcriptDir>/journal.jsonl`）も存在しないため、「journal に step 1〜8 が記録される」も未確認である。

**代わりに何を測ったか**: スクリプト本体は素の JavaScript であり、Workflow ランタイムは本体を
`AsyncFunction` にラップして `agent` / `parallel` / `pipeline` / `phase` / `log` / `args` / `budget` /
`workflow` を注入して実行する（`workflow-authoring` スキルの Resume 節と script API の記述）。
`tests/unit/workflows/workflow-scripts.test.ts` は同じラップで 3 本の本体を実際に走らせ、
エージェントの応答だけを差し替えて制御フローを測る（6 周目で 44 ケース）。判定ロジックには手を入れていない。
これで測れたのは「3 周上限で BLOCKED」「欠票の記録」「2 周目以降は受入テストを再生成しない」
「1 周ごとのコスト記録」「成立条件の判定」であり、測れていないのは
**ランタイムが `meta` / `agentType` / `model` / `phase` をどう解釈するか**である。

**対応案**: Workflow ツールを持つセッション（メインセッションまたは PO）で

```
Workflow({ name: "task-loop",      args: { taskId: "task_003", dryRun: true } })
Workflow({ name: "premortem",      args: { date: "<YYYY-MM-DD>", dryRun: true } })
Workflow({ name: "release-audit",  args: { version: "v0.0.0", dryRun: true } })
```

を回し、返ってきた runId を `scripts/record-run.sh --manual task_008 "<runId と観察>"` で記録する。
`dryRun: true` を必ず付ける（付けないと task-loop は実際にファイルを書き換えるエージェントを起動する）。

**状態**: **deferred**。6 周目・7 周目・8 周目（本修正周）のいずれのセッションでも
`ToolSearch select:Workflow` は `No matching deferred tools found` を返し、`Workflow` ツールは無い。
レビューセッションでも同じ結果だった（8 周目のレビューの medium も同じ理由で「現状維持でよい」としている）。
8 周目の確認は `scripts/record-run.sh --manual task_008` で run-log に記録済み。
この環境では満たせない項目であり、満たすまで task_008 を DONE へ昇格させない
（`completion_status` は DONE_WITH_CONCERNS のまま）。

**対応予定タスク**: deferred（メインセッション / PO。Workflow ツールを持つセッションで実走）

---

## C-008-2 [medium] `agentType` と `model` の別名がランタイムで解決できるかは未検証

**指摘**: `task-loop.ts` は `acceptance-test-generator-restricted` / `adversarial-reviewer-gemini` /
`adversarial-reviewer-gpt` / `payment-contract-guard` / `compliance-gatekeeper` を、
`premortem.ts` は `premortem-facilitator` を、`release-audit.ts` は `release-auditor` を
`opts.agentType` で参照する。いずれも `.claude/agents/` に実在するファイル名・`name:` と一致させてある
（実在確認済み）。`opts.model` に渡す `"opus"` / `"sonnet"` は同じ `.claude/agents/*.md` の
frontmatter が使っている値をそのまま使った。

ただし **Workflow ランタイムがこの 2 つをどう解決するかは実走していない**。存在しない `agentType` を
渡した場合の挙動（エラーか既定エージェントへのフォールバックか）も未確認である。
`code-reviewer` など `.claude/agents/` に無い名前は `agentType` に使わず、素の `agent()` ＋ `model` 指定にした。

**対応案**: C-008-1 の dry-run 実走で、各エージェントが意図した定義で起動したかを journal で確かめる。
解決できない場合は `agentType` を外し、エージェント定義の本文をプロンプトに展開する形へ落とす。

**対応予定タスク**: deferred（C-008-1 と同時）

---

## C-008-3 [medium] `release-audit.ts` は法務クリアランスについて `release-auditor.md` より強い条件を採っている

**指摘**: 2 つの一次文書が食い違っている。

- `docs/implementation-plan.md` §15-3: 「`legal-clearance.json.cleared=false` なら**無条件 no-go**」
- `.claude/agents/release-auditor.md` の成立条件 4: `payments_enabled: true` のときだけ
  `cleared == true` を要求し、`payments_enabled: false` のときはビルドフラグと `npm ls` だけを見る

`payments_enabled: false`（Phase 1 の既定）かつ `cleared: false`（現状）のとき、前者は no-go、
後者は go を許す。**計画書を優先して fail-closed（無条件 no-go）にした**（成立条件 6 として実装）。
その結果、`docs/gates/legal-clearance.json` の `cleared` が false である限り、決済を無効にした
リリースであっても本スクリプトは go を出さない。

**対応案**: どちらが正かを ADR で一本化する。決済無効のリリースまで法務クリアランス待ちにするのが
過剰であれば、条件 6 を「`payments_enabled: true` のときのみ」に緩める。**緩めるのは ADR と PO の仕事**
であり、スクリプト側でその場で緩めてはならない（R-TH-13）。

**対応予定タスク**: PO 裁定（ADR 起票）

---

## C-008-4 [medium] G13 の基準値を再生成しており、既知の洗浄リスクをそのまま踏んでいる

**指摘**: `.claude/workflows/` の 3 ファイルは G13 のハッシュ対象領域（`.claude/**`）に入るため、
追加した時点で `npm run gate:integrity` が「G13 追加: …（基準値に無いファイルがゲート対象領域に
増えています）」で exit 1 になった（実測）。`docs/HANDOFF.md` の運用どおり
`node scripts/gate-integrity.mjs --write-baseline` で基準値を再生成し、43 ファイル / 不一致 0 に戻した（実測）。

これは `docs/concerns/task_006.md` に既に記録されている残留リスク（`--write-baseline` を走らせられる
エージェントは改竄を洗浄できる）をそのまま踏んでいる。緩和は「洗浄が `docs/gates/**` の diff として
人の前に出る」ことだけである。

**対応案**: `--write-baseline` を PO 専用にする／ガードに列挙する案は task_038 に起票済み。
本タスクの差分では `docs/gates/integrity-baseline.json` の変更が
`.claude/workflows/*.ts` の 3 エントリ追加だけであることを diff で確認できる。

**対応予定タスク**: task_038

**7 周目の追記**: 今周も `.claude/workflows/*.ts` を 2 本直したため基準値を再生成したが、同時に
別タスクが G13 対象のスクリプトを未コミットで編集していた。作業ツリー全体で
`--write-baseline` を走らせると他タスクの未コミット差分まで基準値に焼き込まれ、そのタスクの
レビュアから G13 の信号が消える。これを避けるため、**`git ls-files` + `tar` で作業ツリーの追跡
ファイルを退避先へ複製し、他タスクが編集中の G13 対象ファイルだけを `git show HEAD:` の内容へ
戻した木**を `--root` に渡し、`--base` をリポジトリにして基準値を書いた
（`node scripts/gate-integrity.mjs --root <退避先> --base <repo> --write-baseline`）。結果の diff は
`.claude/workflows/release-audit.ts` / `task-loop.ts` の 2 エントリと `generated_at` /
`generated_at_commit` だけである（実測）。

並行タスクのコミットが相次いだため、退避対象は周回中に変わった。最初の再生成時（HEAD `ffe9f01`）は
`scripts/gate-env-scope.mjs` 1 件、**最終コミット時点（HEAD `12fc3b9`）は
`scripts/gate-constraints.sh` / `scripts/wording-lint.mjs` の 2 件**（いずれも task_004 が編集中）。
最終状態の `npm run gate:integrity` は「43 ファイル照合・不一致 2 件」で exit 1 になり、
`npm run gate:check` は G13 のみ不合格になる。**2 件とも task_008 の変更ではなく、所有タスクが
コミット時に基準値を再生成すれば解消する。** task_007 が 4 周目に「G13 は task_009 の未コミット差分」と
記録したのと同じ扱いである。

**8 周目の追記**: `release-audit.ts` を 1 本直したため今周も同じ手順で基準値を再生成した
（`git ls-files` + `tar` で退避した木を `--root` に、リポジトリを `--base` に渡す）。今周は退避時点で
G13 対象領域に他タスクの未コミット差分が 1 件も無く（`git status --porcelain -- docs/gates .claude
.github/workflows scripts/ci` と `-- scripts` がいずれも空・実測）、diff は
`.claude/workflows/release-audit.ts` の 1 エントリと `generated_at` / `generated_at_commit` だけである。
7 周目に残っていた不一致 2 件（`scripts/gate-constraints.sh` / `scripts/wording-lint.mjs`）は
所有タスク（task_004）のコミットで解消しており、**今周の最終状態では
`npm run gate:integrity` が「43 ファイル照合・不一致 0 件」で exit 0**（実測）。

---

## C-008-11 [low・解消済み] 独立性の会計に封筒の自己申告 `vendor` を使っており、作者ベンダーのレーンが独立票に化けられた

**指摘（7 周目のレビュー high）**: `task-loop.ts` と `release-audit.ts` は、スクリプト自身が持つ
レーン定数 `lane.vendor`（`code-reviewer` / `release-auditor` = `"claude"`）を、レビュア自身が返した
`env.vendor` / `res.vendor` で上書きしてから `AUTHOR_VENDOR` 判定をしていた。作者ベンダーのレーンが
封筒に `vendor: "gemini"` と書くだけで独立ベンダーの票として数えられる（R-TH-11 / F6）。

修正前 HEAD（3bdf5d4）の本体を `git show` で取り出して同じ応答表で走らせた実測:

- `task-loop`: gemini / gpt の両レーンが不達でも `code-reviewer` が `vendor:"gemini"` と名乗ると
  `status=DONE` / `voting_vendors=["gemini"]` / `audited=true` / final verify 1 回。
- `release-audit`: `release-auditor` が `vendor:"gemini"` と名乗り、本物の gemini は不達（PO 承認済み）、
  本物の独立 go は gpt だけ、という表で `verdict=go` / `independent_go_vendors=["gemini","gpt"]` /
  成立条件 1 pass。

**対応**: 独立性の会計をレーン定数だけで行うようにした。封筒の自己申告 `vendor` は
「レーン定数と一致するか」の照合にのみ使い、食い違う封筒は `reviewer_route: "invalid_envelope"` の
欠票（`abstentions`）へ落とす。修正後は上の 2 ケースがそれぞれ `BLOCKED`（`voting_vendors=[]` /
`audited=false` / final verify 0 回）と `verdict≠go`（`independent_go_vendors=["gpt"]` /
成立条件 1 fail）になる（実測）。

**対応予定タスク**: 完了（task_008 7 周目）

---

## C-008-12 [low・解消済み] `model_id_actual` の無い封筒・`findings` 配列の無い封筒が有効票として数えられた

**指摘（7 周目のレビュー medium）**: `task-loop.ts` の票の採否は `reviewer_route` しか見ておらず、
`highFindingsOf` は `Array.isArray(envelope.findings)` が偽なら黙って `[]` を返していた。壊れた封筒・
途中で切れた封筒が「レビューして指摘 0 件」と同義になる。`model_id_actual` は
`REVIEW_SCHEMA` / `VENDOR_SCHEMA` の `required` に入っておらず、存在確認も無かった
（§16-2「封筒に `model_id_actual` 必須」/ `scripts/validate-findings.mjs` /
`scripts/review-gpt.mjs` / `.claude/agents/adversarial-reviewer-gemini.md` が既に採っている規律との齟齬）。

**対応**: 票として数える条件に「`vendor` がレーン定数と一致」「`model_id_actual` が非空」
「`findings` が配列」を足し、満たさない封筒は `invalid_envelope` の欠票へ落とす。`release-audit.ts`
側は加えて `verdict` が `go` / `no-go` / `UNKNOWN` のいずれかであることを確かめる。
レビュア向けプロンプトにもこの 3 条件を明記した。修正前 HEAD ではいずれのケースも
`status=DONE` / `audited=true` になることを対照実験で実測している。

**対応予定タスク**: 完了（task_008 7 周目）

---

## C-008-13 [low・解消済み] 成立条件 3 が PO の承認ファイルの有無を見ずに「承認済み」の自己申告だけで pass していた

**指摘（8 周目のレビュー high）**: `release-audit.ts` の成立条件 3 の `pass` は
`unapprovedUnavailable.length === 0` だけで決まり、`evidence.approval_file_exists` は
`EVIDENCE_SCHEMA` の `required` に入れて集めておきながら detail 文字列に「承認記録: あり/なし」と
印字するだけで、どの判定にも使われていなかった。その結果、承認ファイルが無い
（`approval_file_exists: false`）のに `approved_unavailable_vendors` に不達ベンダーが載った
自己矛盾した封筒で、条件 3 が「未承認: なし / 承認記録: なし」と書きながら `pass: true` になり
`verdict: "go"` が出た。task_008 の scope 行「不達は PO の明示承認を
`docs/gates/release-<version>.json` に」と `docs/implementation-plan.md` §15-3 の同文は
**その記録がファイルにあること**を要求している。7 周目に塞いだ「自己申告を会計に使わない」
（C-008-11）と同じクラスの fail-open で、判定材料はスクリプトの手元にあった。

**再現（修正前 HEAD の本体を `git show` で取り出し、テストと同じ `AsyncFunction` ラップで実走）**:
evidence = `{approval_file_exists: false, approved_unavailable_vendors: ["claude"], 他は clean}`、
release-auditor レーン = unavailable、gemini / gpt = go の応答表で
`{verdict: "go", unapproved_unavailable_vendors: [], cond3.pass: true}`。

**対応**: 承認の存在は `approval_file_exists`（材料集めが実際に見たファイルの有無）だけで決める。
`approved_unavailable_vendors` は「そのファイルに何が書かれていたか」の申告なので、記録が無い間は
空として扱い、不達があれば必ず未承認へ落とす。無視した申告は
`disregarded_approved_unavailable_vendors` と条件 3 の detail に出して黙って捨てない。
材料集めのプロンプトにも「記録の無い承認は存在しない」を明記した。
修正後は同じ応答表で `verdict: "no-go"` / `unapproved_unavailable_vendors: ["claude"]` /
`cond3.pass: false`（実測）。テストは 49 → 50 件（`expect` の削減・`skip` / `only` の追加なし）。

**対応予定タスク**: 完了（task_008 8 周目）

---

## C-008-5 [low] `premortem.ts` の `platform` レンズはエージェント定義の 3 本目と名前が一致しない

**指摘**: `docs/task-list.json` の task_008 の scope は 4 レンズを
「legal / payment / platform / harness」と定める。`.claude/agents/premortem-facilitator.md` の
3 本目は「ops-support / ux-adoption（運用負荷・問い合わせ・幹事と参加者の離脱）」である。
台帳の名前を採り、`platform` の担当範囲に ops / ux を明示的に畳み込んだ
（LINE 審査・LIFF・Workers の制約・決済事業者の停止 ＋ 運用負荷・問い合わせ・離脱）。
畳み込んだ結果、ux-adoption の観点が `platform` の後半に埋もれて薄くなる可能性がある。

**対応案**: 実運用 2 回で ux-adoption 由来の新規検出が 0 件なら、レンズを 5 本に割り直すか、
エージェント定義側の名前を台帳に合わせる。どちらに寄せても両方のファイルを同時に直す。

**対応予定タスク**: task_010（エージェント定義の改訂時）

---

## C-008-10 [medium] 「独立した 2 ベンダー以上が go」の読みを fail-closed 側で固定した（ADR 待ち）

**指摘**: `docs/implementation-plan.md` §15-3 と `.claude/agents/release-auditor.md` の成立条件 1 は
どちらも「独立した 2 ベンダー以上が go（Claude 系のみでは成立しない）」である。この一文は 2 通りに読める。

- 緩い読み: go ベンダーが 2 件以上あり、そのうち 1 件以上が独立（作者 claude ＋ 独立 1 件で成立）
- 厳しい読み: **独立ベンダー**が 2 件以上 go（作者 claude の票は数に入れない）

6 周目までは緩い読み（`goVendors.length >= 2 && independentGoVendors.length >= 1`）で実装されており、
これは fail-open である。C-008-3 と同じく計画書の逐語を優先し、**厳しい読み**
（`independentGoVendors.length >= REQUIRED_GO_VENDORS`）に締めた。

**副作用**: レーンは `release-auditor(claude)` / `gemini` / `gpt` の 3 本しか無いので、
gemini と gpt の**両方**が go を返さない限り go は出ない。結果として成立条件 3
（不達ベンダーの PO 明示承認）は、独立ベンダーが不達のケースでは実質的に go へ到達できない
（承認しても条件 1 で落ちる）。作者ベンダー側が不達で独立 2 件が go のときだけ条件 3 が効く
（`tests/unit/workflows/workflow-scripts.test.ts` の「不達が作者ベンダー側でも…」で実測）。

**対応案**: ADR を起票して「独立」の定義と、独立ベンダーが 1 本落ちたときのリリース可否を一本化する。
緩める場合でも ADR と PO の裁定であり、スクリプト側でその場で緩めてはならない（R-TH-13）。

**対応予定タスク**: PO 裁定（ADR 起票。C-008-3 と同じ ADR にまとめてよい）

---

## C-008-6 [low] UNKNOWN の引き直しは 1 周 1 回までで、2 回目も UNKNOWN が高ければ有効票として数える

**指摘**: §15-3 step 5 は「UNKNOWN > 20% → 再実行」とだけ定める。無限ループを避けるため
`task-loop.ts` は同じ周での引き直しを 1 回に制限した（`UNKNOWN_RERUN_THRESHOLD = 0.2`）。
2 回目の封筒も UNKNOWN 比率が高い場合、その票は「UNKNOWN が多いまま有効票」として数えられる。
欠票（`reviewer_route !== "ok"`）とは扱いが違う。

**対応案**: 2 回目も閾値超過なら `reviewer_route` を `invalid_envelope` として欠票側に落とす案がある。
ただし「断定できないこと」と「経路が通らないこと」を同じ箱に入れてよいかは設計判断なので、
実運用で UNKNOWN 比率の分布を見てから決める。

**対応予定タスク**: task_010

---

## C-008-7 [low] 1 周ごとのコストはターン全体の共有プールから測っており、他の実行が混ざる

**指摘**: `task-loop.ts` は `budget.spent()`（そのターンに main loop と全 Workflow が使った
出力トークンの合計）を周の前後で差し引いてコストとしている。スキル記述のとおりこのプールは
Workflow ごとではなく**ターン共有**なので、同じターンで他の作業が走っていれば
その分が周のコストに混ざる。コスト監視（§16-2 運用レーン）に使うときは上振れを前提にすること。

**対応案**: 1 ターン 1 Workflow で回す運用にする。より正確な値が要るなら Workflow の返り値ではなく
セッションの使用量ログ側で測る。

**対応予定タスク**: task_010

---

## C-008-8 [low] task_007 から送られた「封筒の自己申告パス集合の正本化」は task_008 の scope に無い

**指摘**: `docs/HANDOFF.md` の task_007（4 周目）節に
「自己申告のパス集合（`docs/concerns/**` / `HANDOFF.md` / `PROGRESS.md`）は
`build-review-packet.sh` 内の固定リストである。パス集合の正本化は封筒スキーマ側で決めること。
→ task_008 / task_010」とある。task_008 の scope は Workflow スクリプト 3 本であり、
`files_to_create` にも `files_to_modify` にも封筒スキーマは無い。**本タスクでは触っていない。**

**対応案**: 封筒スキーマは task_010 の担当として送り返す。task_007 が挙げた F-1（封筒の出所担保）の
残りも同様に task_006 / task_009 / task_010 の所有ファイルで閉じる。

**対応予定タスク**: task_010

---

## C-008-9 [low] `docs/premortem/<date>.json` の書き出しはエージェント任せで、形式の機械検査が無い

**指摘**: `premortem.ts` は自身ではファイルを書けない（Workflow スクリプトにファイルシステム API が
無い）。出力形式は畳み込みエージェントへのプロンプトと `docs/premortem/README.md` に書いてあるだけで、
書かれた JSON が 7 項目を満たすかを機械検査するゲートは無い。
7 項目の欠けた item が混ざっても、いまは誰も落とさない。

**対応案**: `docs/premortem/*.json` のスキーマ検査を `scripts/validate-plan-json.mjs`（`gate:plan`）か
新しい判定器に足す。ただし `docs/premortem/**` にファイルが 1 つも無い状態で
「対象 0 件のまま合格するゲート」を作らないこと（R-TH-01）。`expect_targets` を
`from_task_008` ではなく最初の実行が終わってからにする。

**対応予定タスク**: task_010
