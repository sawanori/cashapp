# task_019 残懸念

ProviderConformanceKit（`docs/implementation-plan.md` §14-4、`docs/research/premortem-risks.md` §3-4、`check_020〜027` / `check_097〜101`）。

書式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

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
