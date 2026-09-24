# task_008 の残懸念

Workflow スクリプト 3 本（`.claude/workflows/task-loop.ts` / `premortem.ts` / `release-audit.ts`）。
形式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

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
エージェントの応答だけを差し替えて制御フローを測る（41 ケース）。判定ロジックには手を入れていない。
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

**対応予定タスク**: deferred（メインセッション / PO。task_008 の再開時）

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
