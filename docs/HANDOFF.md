# HANDOFF

## task_002（外部照会文の起案・ADR-010）

### 決まったこと

- 弁護士照会は Q-LG1（為替取引該当性）を単独先行（`docs/inquiries/lawyer-q-lg1.md`）とし、否定回答時の分岐を検討する Q-LG1-B（第3号ニの提携先候補・株式会社化の要否・`manual_confirm` の該当可否）を同便に含めた。残り14問（Q-LG2〜Q-LG16）は別便（`docs/inquiries/lawyer.md`）。
- Q-LG11（非弁該当性・催促）、Q-LG12〜LG15（クラウド例外・同意前情報・漏えい報告期限・保持期間根拠）、LINE の Q-LN7（`shareTargetPicker` 可否）、PayPay の Q-PP9〜Q-PP12（クレデンシャル預託・紛争通知・IPレンジ・Webhook URL変更）、PAY.JP の Q-PJ1〜Q-PJ7 全問は `docs/research/consolidated.md` §5 の一次質問リストに原文が無く、`docs/implementation-plan.md` §18-1 の要約行と `docs/research/premortem-risks.md`（R-LAW-02/04/05/07/08/11/15、R-PAY-07、R-SEC-11、R-LINE-06）の対応策文言から本タスクで新規に文章化した。各ファイル末尾の「確信度・レビュー状態」に明記済み。
- `docs/research/consolidated.md` §5-3 項目7（LINE 2026-10-14 ポリシー改定の影響）は `docs/implementation-plan.md` §18-1 の確定質問リストに引き継がれていないため、`line.md` からは除外した（`implementation-plan.md` を正本とする運用ルールに従う）。
- PAY.JP・Stripe には `docs/gates/compliance-gates.json` に固有の `gate_key` が定義されていない。`external-inquiries.json` の `payjp` / `stripe` エントリは `gate_keys: []` とした（同ファイルの変更は PO 専管のため本タスクでは追加していない）。
- ADR-010 は3分岐（第3号ニ提携／自社登録／`manual_confirm` 縮退継続）を列挙するのみで、いずれを採用するかは Q-LG1-B の回答後に PO が判断する前提で `proposed` のまま起票した。
- `docs/implementation-plan.md` §18-2 に「LINE 未回答なら (web) 経路で先行パイロット」という例示があるが、同 §18-4 項目15「(web) ルートグループは Phase 1 では退避先にならない（ADR-013）」と矛盾するため、`external-inquiries.json` の `line` エントリの `default_decision_on_timeout` では後者（より具体的で ADR-013 に裏付けられた制約）を優先し、(web) 退避を明示的に対象外とした。

### 未解決 / concerns

- 依存タスク task_001（G0-USER 同意・ADR-001）が本タスク作業時点で未完了と観測した。`docs/task-list.json` の task_001 `completion_status` は `null`、`docs/decisions/` に ADR-001 ファイルは存在せず、`docs/run-log/task_001.json` も存在しない（`docs/run-log/` には `task_036.json` のみ）。task_002 の成果物自体（照会文起案・ADR-010起票）は ADR-001 の内容に依存しない設計のため実施したが、task_037（送付）に進む前に task_001 の完了確認が必要。
- `docs/implementation-plan.md` §18-2 と §18-4 項目15 の矛盾（上記「決まったこと」参照）は本タスクの起案文書内では回避したが、`implementation-plan.md` 本文自体の修正は本タスクのスコープ外（files_to_modify に含まれない）。別タスクでの修正を推奨。
- ADR-010 の3分岐（提携先候補のリードタイム、運営者自身の登録要件〔NonTurn LLC が合同会社であることの影響〕）はいずれも一次資料未検証（`[不明]`）。Q-LG1-B の回答が来るまで着手しない。

### 次のアクション

- task_037（PO）: 6通の照会文を PO レビュー後に送付し、`external-inquiries.json` の `status` を `sent` に更新して `sent_at` / `no_response_deadline`（+21日）を記入する。
