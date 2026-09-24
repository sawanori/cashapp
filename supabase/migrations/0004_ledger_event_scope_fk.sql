-- ============================================================================
-- 0004_ledger_event_scope_fk.sql — ledger_entry の event スコープ複合外部キー
--
-- 0003_event_scope_fk.sql は invoice / participant_claim の「名乗る event_id」を
-- participant の実 event_id に縛ったが、ledger_entry には同じ穴が残っていた。
-- ledger_entry は invoice_id と event_id を**互いに独立した 2 本の単独 FK**でしか
-- 持たないため、invoice の実 event_id と異なる event_id を名乗る台帳行を作れた。
--
-- 実測（0004 適用前・BEGIN/ROLLBACK）:
--   INSERT INTO ledger_entry (invoice_id=<E1 の invoice>, event_id=<E2>, ...) → INSERT 0 1
--   SELECT count(*) FROM ledger_entry l JOIN invoice i ON i.id = l.invoice_id
--    WHERE l.event_id <> i.event_id;  → 1
--
-- 台帳はイベント単位の残高集計の基礎であり（ledger_event_idx、§10-1 の残高整合
-- 日次監査）、event_id がずれた行が 1 本混ざるだけで集計が静かに狂う。
-- ここを閉じるのはアプリの正しさではなく DB の仕事である（W2 / R-PAY-03）。
--
-- 対処は 0003 と同型: invoice に (event_id, id) の UNIQUE を張り、ledger_entry から
-- 複合 FK で参照する。既存の単独 FK（ledger_entry_invoice_id_fkey /
-- ledger_entry_event_id_fkey）は残す。0001 ではどちらも ON DELETE 句を持たない
-- （= NO ACTION）ので、複合側も ON DELETE 句を書かずに挙動を揃えてある。
-- ============================================================================

-- 複合 FK の参照先。invoice.id は既に主キーなので、この UNIQUE は
-- 「event_id と id の組」を参照可能にするためだけの冗長な一意制約である。
ALTER TABLE invoice
  ADD CONSTRAINT invoice_event_scope_uk UNIQUE (event_id, id);

-- ★ ledger_entry が名乗る event_id は invoice の event_id と一致するほかない。
ALTER TABLE ledger_entry
  ADD CONSTRAINT ledger_entry_event_invoice_fk
  FOREIGN KEY (event_id, invoice_id)
  REFERENCES invoice (event_id, id);

COMMENT ON CONSTRAINT invoice_event_scope_uk ON invoice IS
  'ledger_entry の複合 FK の参照先。event スコープの一貫性を DB で担保する。';
COMMENT ON CONSTRAINT ledger_entry_event_invoice_fk ON ledger_entry IS
  'ledger_entry.event_id は invoice.event_id と一致する。イベント単位の残高集計が静かに狂うのを防ぐ（R-PAY-03）。';
