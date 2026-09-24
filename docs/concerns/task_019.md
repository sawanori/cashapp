# task_019 残懸念

ProviderConformanceKit（`docs/implementation-plan.md` §14-4、`docs/research/premortem-risks.md` §3-4、`check_020〜027` / `check_097〜101`）。

書式は「指摘 / 深刻度 / 対応案 / 対応予定タスク」。

---

## 1. 依存タスク task_018 が完全に未着手で、C1〜C31 の大半が実装不能

- **指摘**: task_019 は `dependencies: ["task_018"]` だが、task_018（台帳適用・冪等基盤・
  Webhook ルート・fixture_provider 契約テストヘルパー）は `git log --all --grep=task_018` が
  0 件、`files_to_create` 22 本（`src/lib/ledger/{apply,rank,dedupe,balance}.ts` /
  `src/lib/outbox.ts` / `src/app/api/webhooks/[providerKey]/[bindingRef]/route.ts` /
  `scripts/audit-verify.mjs` / `tests/contract/**` 等）が全て未作成（実測: 各パスを `find`
  で確認し 0 件）。全 `git worktree list` を確認しても task_018 のコミットは無い。
  `npm run gate:constraints` 自身が `defer P2 (0 targets; waiting on task_018)` /
  `defer W4 (0 targets; waiting on task_018)` と出力しており独立に裏付けられる。
  `docs/research/design-synthesis.md` §9-2 は「キットは保存済み fixture を HTTP で自前
  Route Handler に投げる形で実装」と明記しており、C1〜C31 のうち C1・C2・C3・C4・C4b・
  C6〜C8・C11・C14〜C19・C21〜C26・C28〜C31 は Webhook ルートと `applyToLedger` を経由した
  DB 実状態の検証を要求する。これらは全て task_018 の `files_to_create` であり、
  task_019 の担当範囲外（「他タスクの files_to_create に含まれるファイルを作らない・変更
  しない」に抵触するため実装しない）。DB スキーマ自体（`ledger_entry` / `payment_event` /
  `webhook_delivery` 等）は既存マイグレーションに存在するが、アプリケーション層が無い。
- **深刻度**: high（`done_definition` の中核「fixture_provider は C1〜C31 pass」が
  構造的に満たせない）
- **対応案**: task_018 を先に完了させる。task_019 は再着手し、task_018 のコミット後に
  `tests/conformance/kit.ts`（`registerProvider` / capabilities に応じた n/a 記録 /
  `captured_from` 必須の登録拒否）、`tests/conformance/provenance.ts`、2 本の
  `*.conformance.test.ts`、4 本の fixture JSON、`tests/fixtures/README.md` を作成し、
  `package.json` の `test:conformance` / `test:gate` と `.github/workflows/gate-contract.yml`
  （独立ファイル。`gate.yml` は編集しない規約）を追加する。
- **対応予定タスク**: task_018（先行）→ task_019 再着手
