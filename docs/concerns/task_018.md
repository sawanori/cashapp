# task_018 の残懸念

台帳適用・冪等基盤・監査連鎖検証・Webhook ルート・契約テスト 3 本
（`docs/task-list.json` task_018）。

各項目は「指摘 / 深刻度 / 対応案 / 対応予定タスク」で書く。

---

## C-018-1 Hyperdrive 経路（A21）を 1 度も通していない

- **指摘**: `dependencies` の task_035（staging Supabase ＋ Hyperdrive）が未着手のため、
  本タスクの全テストは direct 接続（ローカル Postgres・ロール `app_rw`）でのみ緑。
  Hyperdrive のクエリキャッシュ下での read-after-write（premortem P-09）も未確認。
- **深刻度**: high（premortem P-05 / P-09 は「確定するまで task_018 を DONE にしない」と書く）
- **対応案**: deferred: task_035 完了後に Hyperdrive 経路で `test:integration` と
  `test:contract` を再実行し、`docs/run-log/task_018.json` に追記する。
- **対応予定タスク**: task_035（PO 作業）→ 本タスクの再検証

## C-018-2 Stop フックへの `test:gate` 登録を行っていない

- **指摘**: scope に「Stop フックに test:gate」とあるが、共通規約は
  「`.claude/settings.json` は task_019 以外は触らない」と定め、`docs/implementation-plan.md`
  §16-4 も「Stop の `test:gate` は task_019 で追加する」と書く。npm スクリプト
  `test:gate`（= `test:contract` ＋ `test:conformance`）の定義までを本タスクで行った。
- **深刻度**: medium
- **対応案**: `.claude/settings.json` の Stop フックへの登録は task_019 が行う。
- **対応予定タスク**: task_019

## C-018-3 「適用保留」に専用の `apply_result` 値が無い

- **指摘**: check_095 は保留を `apply_result='held'` と書くが、`payment_event.apply_result` の
  CHECK は 7 値（`applied` / `duplicate` / `ignored` / `mismatch` / `orphan` /
  `signature_failed` / `error`）で `held` を持たない。本実装は保留を
  `apply_result IS NULL AND processed_at IS NULL`（＝未処理）で表す。
- **深刻度**: medium（`/api/cron/apply-pending` の走査条件がこの表現に依存する）
- **対応案**: マイグレーションで `held` を CHECK に足すか、check_095 の文言を
  「未処理（NULL）」に改める。どちらもスキーマ / 受入チェックの所有者の判断。
- **対応予定タスク**: task_020（apply-pending の実装時に確定）

## C-018-4 `tests/unit/gate-check.test.ts` の 2 件が `test:contract` の実在で赤

- **指摘**: task_006 の `tests/unit/gate-check.test.ts`「G2 の 3 分岐」2 件が、
  **`test:contract` が package.json に無いこと**を前提にフィクスチャを組んでいる。
  §13 の表どおり本タスクが `test:contract` を定義したため、その 2 件が落ちる
  （`expected '' to contain '\`test:contract\` は未定義'` ほか）。ゲート本体（G2）は正しい。
  他タスクのテストを通すために編集しない規約に従い、手を入れていない。
- **深刻度**: medium（`npm run test:unit` が exit 1 のままになる）
- **対応案**: フィクスチャの placeholder を「どのタスクも定義しない名前」に替えるか、
  `--base` を合成 package.json に向ける。判断と修正は当該テストの所有者。
- **対応予定タスク**: task_006（premortem P-11 の「完了済みタスク由来の赤」）

## C-018-5 `audit:verify` のローカル実行は `rowsChecked: 0`

- **指摘**: 統合テストがすべて `withRollback` で巻き戻すため、ローカルの `audit_log` は空。
  `npm run audit:verify` は exit 0 だが検査した行は 0 件である。
- **深刻度**: low
- **対応案**: 連鎖破壊の検出能力そのものは `tests/integration/webhook-route.test.ts` の
  「連鎖が壊れた行を verifyChain が検出する」（合成行）と、`appendAuditLog` が書いた実行を
  `scripts/audit-verify.mjs` の `computeRowHash` で再計算する写し一致テストで担保している。
  実データ上の緑は staging（task_035）以降に取る。
- **対応予定タスク**: task_035 / task_020（cron audit-verify）

## C-018-6 `trust='unverified'` のイベントは適用せず保留にする

- **指摘**: 署名を持たない事業者のイベントは `applyToLedger` で台帳に載せず
  `apply_result='ignored'` にする。§3-3 が要求する `getPaymentStatus` での再照会は
  このモジュールが事業者アダプタを持たないため実装していない。
- **深刻度**: medium（Phase 2 で署名なし事業者を足すと、再照会が無い限り入金が反映されない）
- **対応案**: 再照合ジョブ側で `trust='unverified'` かつ未処理の `payment_event` を拾い、
  `getPaymentStatus` の結果を `reverified` として同じ経路へ流す。
- **対応予定タスク**: task_020

## C-018-7 Webhook の秘密値・許可リストを env 雛形に載せていない

- **指摘**: ルートは `WEBHOOK_IP_ALLOWLIST` / `WEBHOOK_SIGNING_SECRETS` を読むが、
  `.dev.vars.example` / `.env.example` は本タスクの `files_to_modify` に無いため未記載。
  どちらも未設定なら fail-closed（IP は全拒否、署名は必ず失敗）になる。
- **深刻度**: low
- **対応案**: env 台帳（`docs/ops/env-baseline.json`）の整備時に名前を登録する。
- **対応予定タスク**: task_035 / task_024

## C-018-8 `npm run test:integration` の 3 件が他タスクの未コミット成果物で赤

- **指摘**: `tests/integration/admin.test.ts`（未追跡。task_021 の作業中ファイル）の 3 件が
  `append_only_violation: DELETE on audit_log is forbidden` ほかで落ちる。当該ファイルを
  除いた `tests/integration` は **13 ファイル 204/204 pass**（run-log に両方を記録した）。
- **深刻度**: low（並行実行中の他タスクの作業ツリー由来。本タスクのコードは原因ではない）
- **対応案**: 当該ファイルの所有タスクが自タスクの検証で解消する。
- **対応予定タスク**: task_021
