-- ============================================================================
-- 0006_payment_event_attempt_scope_fk.sql — payment_event の invoice / attempt 整合
--
-- 0001_init.sql の payment_event は invoice_id と attempt_id を**互いに独立した
-- 2 本の単独 FK**でしか持たない。そのため
--   payment_event.attempt_id = A（A.invoice_id = I1）
--   payment_event.invoice_id = I2（I1 ≠ I2）
-- という行が DB に受理される。照合（reconcile）と台帳記帳は payment_event の
-- invoice_id を基準に請求を引くため、食い違った 1 行が入るだけで「別の請求に
-- 入金が立つ」。W2 の重複防止をすり抜けた誤記帳になり、金額の正しさが静かに壊れる
-- （R-PAY-03 / R-PAY-15）。
--
-- 対処は 0003 / 0004 と同型: payment_attempt に (id, invoice_id) の UNIQUE を張り、
-- payment_event から複合 FK で参照する。既存の単独 FK
-- （payment_event_invoice_id_fkey / payment_event_attempt_id_fkey）は残す。
-- 0001 ではどちらも ON DELETE 句を持たない（= NO ACTION）ので、複合側も
-- ON DELETE 句を書かずに挙動を揃える。
--
-- ★ 既定の MATCH SIMPLE なので、attempt_id が NULL の行（webhook が試行に
--   紐づく前に着信した場合・orphan イベント）は複合 FK の検査対象外になり、
--   invoice_id の単独 FK だけが効く。これは設計どおりで、指摘の
--   「attempt_id が NULL の行は単独 FK のまま」に一致する。
--   invoice_id だけが NULL の行も同様に複合側は素通りし、attempt_id の
--   単独 FK が効く。
-- ============================================================================

-- 複合 FK の参照先。payment_attempt.id は既に主キーなので、この UNIQUE は
-- 「id と invoice_id の組」を参照可能にするためだけの冗長な一意制約である。
ALTER TABLE payment_attempt
  ADD CONSTRAINT payment_attempt_invoice_scope_uk UNIQUE (id, invoice_id);

-- ★ payment_event が名乗る invoice_id は、参照する試行の invoice_id と一致するほかない。
ALTER TABLE payment_event
  ADD CONSTRAINT payment_event_attempt_invoice_fk
  FOREIGN KEY (attempt_id, invoice_id)
  REFERENCES payment_attempt (id, invoice_id);

COMMENT ON CONSTRAINT payment_attempt_invoice_scope_uk ON payment_attempt IS
  'payment_event の複合 FK の参照先。試行と請求の対応を DB で担保する。';
COMMENT ON CONSTRAINT payment_event_attempt_invoice_fk ON payment_event IS
  'payment_event.invoice_id は attempt_id が指す試行の invoice_id と一致する。別請求への誤記帳を防ぐ（R-PAY-03 / R-PAY-15）。attempt_id が NULL の行は MATCH SIMPLE により対象外。';
