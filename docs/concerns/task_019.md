# task_019 残懸念

ProviderConformanceKit（`docs/implementation-plan.md` §14-4、`docs/research/premortem-risks.md` §3-4、`check_020〜027` / `check_097〜101`）。

書式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

## -1. 修正ラウンド（レビューのギャップ対応。§0〜§8 は前ラウンドの記録のまま保持）

前ラウンドの `docs/run-log/task_019.json` 実測失敗（G4: 本ファイルと台帳の状態トークン食い違い）と、
検証者が転記したレビューのギャップ（high 1・medium 6）を修正した。

- **G4（検証失敗）**: `docs/PROGRESS.md` 482 行目の状態トークンを `BLOCKED` → `DONE_WITH_CONCERNS`
  に訂正した（task_013 の 4 周目と同じ扱い。本文は当時のまま）。
- **[high→修正] done_definition 第1項の pass 主張と実行実態の乖離**: `tests/conformance/kit.ts` に
  `assertCatalogComplete`/`buildReport` の第3引数 `executedCaseIds`（`describe()` 見出しから
  `afterEach` フックで拾う、実際に `it()` が走ったケース id の集合）を追加し、`status: "pass"` な
  のに対応する `it()` がファイル内に無いケースを例外で検出するようにした。C27（許可外ホストの
  deepLink 拒否）は `manual-confirm.conformance.test.ts` に `buildReceivingLink` を直接呼ぶ実テスト
  を新設し pass へ格上げ。C12/C23/C25/C30 は n/a のまま据え置いたが、理由文言を「実際にどこで
  検証済みか」（C12→manual-confirm 側の実テスト／C23→`tests/integration/checkout.test.ts` の
  check_093 実測／C25→C15 が検査する webhook-side の帰結と同一）、または「Phase 1 に外部 API を
  呼ぶアダプタが 1 つも無い構造的な理由」（C30）へ書き換えた。C21/C22 は §4 のとおり `blocked` に
  分離した。
- **[medium→修正] C21/C22 の n/a 埋没**: `ConformanceCaseStatus` に `"blocked"` を追加し、
  fixture_provider の C21/C22 を n/a から blocked（apply.ts 拡張の担当タスク未定という実装ギャップ
  である旨を型で区別）に変更した。詳細は §4 を更新。
- **[medium→修正] C29 の空虚な pass**: fixture_provider の C29 は「invoiceId 文字列を変えただけで
  期限判定を検査していない」のに pass と記録していた。`capabilities.refundWindowDays` が null
  （期限概念自体が無い）ことを根拠に n/a へ訂正した（テストは削除せず、主張を実態に合わせた）。
- **[medium→修正] C5 の mismatch_alert 未検証**: `fixture-provider.conformance.test.ts` の C5 に
  outbox の `mismatch_alert` 検査を追加した。
- **[medium→修正] C14 の「復帰後に台帳へ載る」が未実行**: `runApplyPending`（task_020 所有・
  変更しない。`applyGate` を開けた状態で呼ぶ）を使い、ゲート off で保留された行が復帰後に実際に
  台帳へ載ることを検査する 2 段目を追加した（done_definition の文言をそのまま実行）。
- **[medium→修正] C13 の credential_fp 未検証**: 2 つの binding に 16 進 16 桁の `credential_fp`
  を明示的に書き分け、適用後の `payment_attempt.provider_binding_id` と
  `provider_binding.credential_fp` を突き合わせる assertion を追加した。
- **[medium] 敵対レビュー記録（G5）の対象コミットが古い**: `docs/review-log/task_019.json` の
  round1 は BLOCKED 宣言のみのコミット（`47608da`）に対するもので、9421d14 以降の実装（fixture
  provider 実装・本ラウンドの修正）を一度も審査していない。ハーネス規則（既に review-log がある
  タスクは再作成不要。reject でも再レビューしない）に従い、本ラウンドでは
  review-drive.sh/merge-review.sh を実行せず、この食い違いを記録するに留める。
- **verify_commands 3 本すべて `scripts/with-lock.sh db scripts/record-run.sh task_019` 経由で
  実測 exit 0**: `test:conformance`（2 ファイル 38/38 pass）／`test:gate`（test:contract 8/8 +
  test:conformance 38/38）／`gate:constraints`（29 grep entry 0 violation。§8 の W11 違反は
  task_020 の着地で解消済み）。`typecheck` / `lint:changed` も exit 0。

---

## 0. 敵対レビュー（G5 round1・`docs/review-log/task_019.json`）指摘の反映（本ラウンドで対応済み）

- **指摘（G5 round1・high）**: task_018 に依存しない部分（`captured_from` 欠落 fixture の登録拒否、
  および manual_confirm で検証可能な C9 能力宣言遵守 / C10 非自動ラベル / C12 ゲート未通過）が
  未着手のまま BLOCKED にされていた。詳細は `docs/review-log/task_019.json` の指摘本文を参照
  （このファイル自体は G5 の記録であり再作成しない）。
- **対応**: `tests/conformance/provenance.ts`（`captured_from`/`captured_at` の必須検証。
  `synthesized` のみの fixture では `autoDetect:true` を登録拒否）、`tests/conformance/kit.ts`
  （`registerProvider` / 32 ケース（C1〜C31 + C4b）のカタログと `n/a` 理由つきレポート）、
  `tests/conformance/manual-confirm.conformance.test.ts`（C9・C10・C12 が pass。C12 は
  `manual_confirm` 自身がゲートを一切見ない設計 — `registry.ts` guard 0 — のため、ゲート経路を
  汎用的に確認する最小フェイクアダプタで検証。`tests/unit/payments/registry.test.ts` の
  `autoProvider()` と同じ設計判断）、`tests/fixtures/README.md` を新規作成。`package.json` に
  `test:conformance`（`TZ=UTC vitest run tests/conformance`）を追加し、`vitest.config.ts` の
  `include` に `tests/conformance/**/*.test.ts` を追加（同ファイルの既存コメントが
  「task_018/019 が追加する」と明記していた箇所）。`npm run test:conformance` は
  `scripts/record-run.sh task_019` 経由で実測 exit 0（11/11 pass）。
- **未対応のまま残す**: `tests/conformance/fixture-provider.conformance.test.ts` と
  `tests/fixtures/fixture_provider/{refund-partial-1,refund-partial-2,orphan,underpaid}.json`
  （下記 §1 のとおり task_018 の Webhook ルート・`applyToLedger`・
  `tests/contract/helpers/fixture-provider.ts`（HMAC 署名ヘルパー）に依存するため）。
  `.github/workflows/gate-contract.yml` と `.claude/settings.json` の Stop フック登録も、
  `test:gate` が実際に pass する状態（task_018 完了後）まで見送る。

## 1. 依存タスク task_018 が未完了で、fixture_provider 側の C1〜C31 と test:gate の実 pass が実装不能

- **指摘**: task_019 は `dependencies: ["task_018"]` だが、task_018（台帳適用・冪等基盤・
  Webhook ルート・fixture_provider 契約テストヘルパー）は本ラウンド開始時点で
  `completion_status: null`・`git log --all --grep=task_018` が 0 件だった。本ラウンドの
  作業中、並行して走っている別セッションが task_018 のファイル（`src/lib/ledger/**` /
  `src/lib/outbox.ts` / `src/app/api/webhooks/[providerKey]/[bindingRef]/route.ts` /
  `scripts/audit-verify.mjs` / `tests/contract/{duplicate,signature,reorder}.test.ts` /
  `tests/contract/helpers/fixture-provider.ts` 等）をワークツリーに書き進めているのを実測した。
  本ラウンド終盤の再実行では `npm run test:contract` が 3 ファイル・7 テスト中 6 pass まで
  進んでいたが、1 件（`reorder.test.ts` の C2 正順ケース）が `PostgresError: deadlock detected`
  （`src/lib/db/repositories/events-log.ts:94` の `INSERT INTO payment_event`）で失敗した
  （`scripts/record-run.sh task_019 npm run test:gate` で実測。多数のエージェントが同一の
  ローカル Postgres に同時アクセスしている本セッションの環境要因の可能性があるが、task_018
  自身のトランザクション設計の問題である可能性も排除できない。切り分けは task_018 の担当）。
  いずれにせよ **本ラウンド終了時点で task_018 は未コミット**（`git log --oneline` に
  task_018 のコミットが無く、`completion_status` も `null` のまま）であり、`npm run test:gate`
  は exit 0 に至っていない（`docs/run-log/task_019.json` 参照）。task_019 の `files_to_create`
  のうちこれに依存する2本（`tests/conformance/fixture-provider.conformance.test.ts` と
  `tests/fixtures/fixture_provider/{refund-partial-1,refund-partial-2,orphan,underpaid}.json`）
  は、task_018 がまだ未コミット・不安定（上記デッドロック）なため本ラウンドでは作成しなかった
  — 未確定なインターフェースの上に構築すると、task_018 が実際にコミットされる際に食い違う
  リスクがある。「他タスクの files_to_create に含まれるファイルを作らない・変更しない」に
  従い、task_018 の `src/lib/ledger/**` / Webhook ルート / `tests/contract/**` の中身には
  一切手を付けていない。
- **深刻度**: high（`done_definition` の第1項後半「fixture_provider は C1〜C31 pass」と
  第3項「test:gate が contract と conformance の両方を実行」が構造的に満たせない）
- **本ラウンドで実装した独立部分**（§0 参照）: `captured_from` 欠落の fixture 拒否、
  `synthesized` のみでの `autoDetect` 登録拒否、manual_confirm の C9・C10・C12。
  `npm run test:conformance` は実測 exit 0（`scripts/record-run.sh task_019` 経由）。
- **対応案**: task_018 が `tests/contract/**` の実体と `tests/contract/helpers/
  fixture-provider.ts` をコミットしたら、task_019 を再着手して
  `tests/conformance/fixture-provider.conformance.test.ts` と4本の fixture JSON を作成し、
  `.github/workflows/gate-contract.yml`（独立ファイル。`gate.yml` は編集しない規約）と
  `.claude/settings.json` の Stop フック（`test:gate` 登録）を追加する。
- **対応予定タスク**: task_018（先行・完了待ち）→ task_019 再着手

## 2. gate:constraints の実行時点の結果は他タスクの未コミット WIP に左右される（task_019 自身は原因ではない）

- **指摘**: `scripts/record-run.sh task_019 npm run gate:constraints` を実行した時点で
  5 件の違反が出た（`docs/run-log/task_019.json` 参照）。内訳は `src/lib/outbox.ts:44`
  （L3）、`src/components/ShareSheet.tsx:14,302`（N9 / GC-XSS）、`src/lib/liff/share.ts:11-12`
  （N9）で、いずれも task_018 / task_020 の並行セッションが同一ワークツリーに書いている
  未コミットファイルであり、task_019 の `files_to_create` / `files_to_modify` には含まれない
  （実測: 違反行を `git log -- <file>` で確認するといずれも追跡外＝未コミット）。
- **深刻度**: low（task_019 自身の変更が原因ではなく、共有ワークツリーでの並行実行に
  起因する一時的な状態。それらのタスクがコミットする時点で解消される見込み）
- **対応案**: 対応不要（他タスクの範囲）。当該タスク（task_018 / task_020）が自身の
  コミット前に `gate:constraints` を通すことで解消する。
- **対応予定タスク**: task_018 / task_020（それぞれの担当範囲）

## 4. 再着手ラウンド（task_018 完了後）: fixture_provider の実装結果（本ラウンドで更新）

- **指摘/記録**: task_018 が 7833726 で完了したため BLOCKED を解除し、
  `tests/conformance/fixture-provider.conformance.test.ts`（新規）と4本の fixture JSON
  （`refund-partial-1/2.json`・`orphan.json`・`underpaid.json`）を実装した。修正ラウンドの結果、
  C1〜C31（+C4b）の32ケースは **fixture_provider が pass 20／n/a 10／blocked 2**、
  **manual_confirm が pass 4（C9/C10/C12/C27）／n/a 28**。n/a は能力宣言
  （`createCheckout`/`refund`/`statusQuery` 非対応）・W3（ランク前進のみ）・Phase 1 に外部 API
  呼び出しアダプタが無い構造的制約のいずれかを理由に持つ（`ConformanceCaseStatus` の型で
  n/a と区別した `reason` 必須）。C21/C22 は「対象外」ではなく実装ギャップのため `blocked` に
  分離した（下記）。done_definition の文言「C1〜C31 pass」は文字どおりには満たせていない
  （n/a/blocked はテスト対象外・実装待ちという意味で失敗ではないが、pass でもない）。
- **深刻度**: medium（テスト自体は全て通っており、pass 主張は `executedCaseIds` で実行実態と
  機械的に一致する。残るのは capability の限界と apply.ts の実装ギャップ）
- **対応案**: n/a の大半は fixture_provider / manual_confirm の構造的な限界（webhook のみの
  テストアダプタ、または Phase 1 に外部 API 呼び出しアダプタが無い）で解消不要。C21（削除済み
  参加者）・C22（イベント中止）は `src/lib/ledger/apply.ts`（task_018 所有）に
  participant.status / event.status を読む分岐が無いための実装ギャップ——真に対応するなら
  apply.ts の拡張が要る（担当タスク未定）。C23（同時 checkout）・C25（checkout タイムアウト）は
  実際の挙動が他ファイル（`tests/integration/checkout.test.ts`／同ファイルの C15）で検証済みだが
  ConformanceKit の case id とは未結線。C30（金額同値）は Phase 2 で実アダプタが載るまで
  検証対象を持たない。
- **対応予定タスク**: C21/C22 は未定（apply.ts 拡張の担当タスクが決まり次第）。C23/C25/C30 は
  対応不要（構造的、または他ファイルで検証済み）。

## 5. gate.yml の acceptance ジョブが test:contract / test:conformance / test:gate を
   Postgres 無しで実行しようとする（task_009 所有・修正不能）

- **指摘**: `.github/workflows/gate.yml` の `acceptance` ジョブは `DONE`/`DONE_WITH_CONCERNS`
  な全タスクの `verify_commands` を `DB_ONLY_NAMES`（`test:integration|gates:sync|
  db:migrate|db:diff:drizzle`）でスキップ判定しながら再実行するが、このリストに
  `test:contract`/`test:conformance`/`test:gate` が入っていない。task_018 の完了時点
  （`test:contract` を verify_commands に追加）で既に存在した構造的な穴で、本ラウンドの
  `test:conformance`（実 Postgres 必須化）で対象が広がった。
- **深刻度**: high（CI の acceptance ジョブが Postgres 無しで落ちる可能性が高い）
- **対応案**: `gate.yml` の `DB_ONLY_NAMES` に3スクリプトを追加するか、
  `gate-contract.yml`（本ラウンドで作成）が担保する前提でスキップに含める。
  `gate.yml` は task_009 が単独所有するため本タスクからは編集していない。
- **対応予定タスク**: task_009（gate.yml 所有者）

## 6. task_018 の既存5 fixture が captured_at を欠く（provenance スキーマ未整合）

- **指摘**: `tests/fixtures/fixture_provider/{succeeded,expired,tampered,amount-mismatch,
  disputed}.json`（task_018 所有）は `captured_from: "synthesized"` のみで `captured_at` を
  持たない。`tests/conformance/provenance.ts`（task_019 が 9421d14 で導入。task_018 の
  実装コミットより前）の必須スキーマを満たさず、`assertFixtureProvenance()` に通すと拒否
  される。`fixture-provider.conformance.test.ts` の登録テストで実測・固定した。
- **深刻度**: low（webhook ルート経由の C1〜C31 検査自体は `loadFixtureBody()` 経由で
  provenance を経由しないため無影響。ConformanceKit のレポート/登録機能にだけ影響）
- **対応案**: task_018 の5本に `captured_at: "2026-09-24"` 相当を追記する
  （task_018 の files_to_create のため本タスクからは変更していない）。
- **対応予定タスク**: task_018（ファイル所有者）が次の修正ラウンドで対応

## 7. CI ジョブ追加（gate-contract.yml）と Stop フックの test:gate 登録

- **記録**: `.github/workflows/gate-contract.yml`（独立ファイル。実 Postgres 上で
  `npm run test:gate` を実行。YAML 妥当性と参照スクリプトの実在は静的検証済み）と
  `.claude/settings.json` の Stop フックへの `npm run --silent test:gate` 登録を実施した。
- **深刻度**: medium（実走確認とrequired_status_checksへの追加は git push 後のCI待ち）
- **対応案**: deferred: メインセッションが push した後、Actions での実走と
  `gh api` による required checks への `contract` 追加を確認する（task_009 の担当領域）。
- **対応予定タスク**: メインセッションの push 後 → task_009（required checks 設定）

## 8. gate:constraints の一時的な exit 1 は他タスクの未コミット WIP が原因（本ラウンドで解消確認）

- **指摘**: `scripts/record-run.sh task_019 npm run gate:constraints` の実行時点で
  `src/lib/reconcile.ts:1`（W11: pg_try_advisory_lock パターン欠落）が1件出た。
  `git status` でこのファイルは未追跡（`??`）——他タスク（おそらく task_020）が
  同一ワークツリーに書いている作業中ファイルで、task_019 の files_to_create ではない。
- **深刻度**: low（task_019 自身の変更が原因ではない。当該タスクのコミット時に解消見込み）
- **対応案**: 対応不要（他タスクの範囲）。
- **対応予定タスク**: task_020（自身のコミット前に gate:constraints を通すことで解消）
- **解消確認（本ラウンド）**: task_020 が `pg_try_advisory_xact_lock` を実装してコミット
  （`9dcab77`）したのを受け、本ラウンドの `gate:constraints` 実測は 29 grep entry
  **0 violation**。W11 の指摘は消えている。

## 3. CI 実走（PR 1本で contract ジョブが緑・required_status_checks）は deferred

- **指摘**: `done_definition` 第4項「PR 1 本で contract ジョブが緑になり
  required_status_checks に contract が含まれる」は、git push が禁止されている本セッションの
  範囲では実走確認できない。加えて contract ジョブ自体は task_018 の `tests/contract/**` が
  無いと動かせないため、二重に未達。
- **深刻度**: medium
- **対応案**: task_018 完了後、メインセッションが push した PR 上で
  `.github/workflows/gate-contract.yml` の実走と `required_status_checks` への追加
  （task_009 が required checks の設定を所有）を確認する。
- **対応予定タスク**: task_018 → task_019 再着手時 → task_009（required checks 設定）
