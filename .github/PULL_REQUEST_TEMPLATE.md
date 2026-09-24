<!--
  このテンプレートの「ゲート緩和チェックリスト」は CI の test-tamper-guard
  （scripts/ci/check-pr-checklist.mjs）が機械的に読む。
  判定は「4 項目それぞれに 1 文字以上あるか」だけで、内容は検証しない。
  単一アカウント運用では CODEOWNERS の承認必須が構造的に成立しない（A19 / R-TH-04）ため、
  承認の代わりに「何をどう緩めたかが PR 本文に残る」ことを強制している。
  記入して通ったことは「レビューされた」を意味しない。事後追跡のための記録である。
-->

## 何を変えたか

<!-- 1〜3 行。関連する task_id と、docs/implementation-plan.md の節番号を書く。 -->

- task_id:
- 関連する節:

## 実機確認

<!-- LIFF は実機（LINE アプリ内ブラウザ）でしか確かめられない挙動がある（§7-3 / R-LINE-02）。
     この PR が LIFF・UI・決済導線に触れないなら「該当なし」と書く。 -->

- [ ] 実機（LINE アプリ内）で確認した
- [ ] 該当なし（LIFF・UI・決済導線に触れない変更）

- 確認した端末 / OS:
- 確認した操作と結果:

## 検証ログ

<!-- docs/run-log/<task_id>.json に記録されたコマンドと exit code。
     scripts/record-run.sh を経由していない実行は証跡として数えない（R-TH-02）。 -->

- 実行したコマンド:
- run-log の場所: `docs/run-log/`

## ゲート緩和チェックリスト

<!--
  次のいずれかに差分がある PR では、下の 4 項目すべてに 1 文字以上を書くこと。
  空のままだと CI の test-tamper-guard が落ちる。

    tests/**  scripts/**  .claude/**  .github/**
    docs/gates/**  supabase/migrations/**  package*.json

  緩めていないなら「緩めていない」と書く。ラベルの綴りは変えない
  （scripts/ci/check-pr-checklist.mjs の CHECKLIST_LABELS と一致している必要がある）。
-->

- 何を緩めたか:
- 理由:
- 復旧予定日:
- 代替の検知手段:

## 残る懸念

<!-- docs/concerns/<task_id>.md に「指摘 / 深刻度 / 対応案 / 対応予定タスク」で書いたものの要約。 -->

-
