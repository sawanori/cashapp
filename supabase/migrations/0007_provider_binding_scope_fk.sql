-- ============================================================================
-- 0007_provider_binding_scope_fk.sql — provider_binding のスコープ複合外部キー
--
-- 0003 / 0004 / 0006 は「名乗る event_id / invoice_id」を実体に縛ったが、
-- provider_binding を指す 2 本の参照（event.provider_binding_id / 0001_init.sql:171、
-- payment_attempt.provider_binding_id / 0001_init.sql:300）には同型の穴が残っていた。
-- どちらも provider_binding(id) への**単独 FK**でしかないため、次の 2 つが受理される。
--
--   (a) cross-owner: 幹事 O1 のイベント／請求に対して、O2 が所有する受取先
--       （merchant_id）宛の行を作れる。集金先が別人になる。
--   (b) provider_key mismatch: 行が名乗る provider_key と、指しているバインディングの
--       provider_key が食い違う行を作れる。payment_attempt の
--       (provider_key, external_ref) 一意や payment_event 側の provider_key 照合と
--       ずれ、照合が静かに別プロバイダの結果を拾う。
--
-- 実測（0007 適用前・BEGIN/ROLLBACK 内）:
--   O2 所有の provider_binding（provider_key='paypay'）を、O1 のイベントの請求に対する
--   payment_attempt（provider_key='manual_confirm'）に渡す → INSERT 0 1 で受理。
--   cross_owner_attempt_rows=1 / provider_key_mismatch_rows=1。
--
-- 本マイグレーションで閉じる範囲:
--   * payment_attempt の (b) — 複合 FK (provider_binding_id, provider_key)
--   * event の (a) と (b) — 複合 FK (provider_binding_id, organizer_user_id) と
--     (provider_binding_id, provider_key)
--
-- 閉じ**ない**範囲（意図的に残す。docs/concerns/task_011.md の C-011-7）:
--   * payment_attempt の (a)（cross-owner）。payment_attempt には organizer_user_id も
--     event_id も無く、invoice → event → organizer_user_id の連鎖を DB で縛るには列の
--     追加（＝ schema.ts とリポジトリ層への波及）が要る。範囲判断は PO 裁定
--     （task_017 / task_018）に送る。event 側が (a) を閉じたことで「イベントに紐づく
--     正しいバインディング」は一意に決まるため、残る穴は「アプリが event の
--     バインディング以外を payment_attempt に渡した場合」に限られる。
--
-- ★ すべて既定の MATCH SIMPLE。event.provider_binding_id は NULL 可なので、
--   バインディング未設定のイベント（manual_confirm 運用の初期状態）は従来どおり通る。
--   payment_attempt.provider_binding_id は 0001 で NOT NULL なので常に検査される。
-- ★ 0001 の単独 FK（event_provider_binding_id_fkey /
--   payment_attempt_provider_binding_id_fkey）は残す。どちらも ON DELETE 句を
--   持たない（= NO ACTION）ので、複合側も ON DELETE 句を書かずに挙動を揃える。
-- ============================================================================

-- 複合 FK の参照先。provider_binding.id は既に主キーなので、この 2 本の UNIQUE は
-- 「id と provider_key の組」「id と organizer_user_id の組」を参照可能にするためだけの
-- 冗長な一意制約である。
ALTER TABLE provider_binding
  ADD CONSTRAINT provider_binding_provider_scope_uk UNIQUE (id, provider_key);

ALTER TABLE provider_binding
  ADD CONSTRAINT provider_binding_owner_scope_uk UNIQUE (id, organizer_user_id);

-- ★ 試行が名乗る provider_key は、指しているバインディングの provider_key と一致するほかない。
ALTER TABLE payment_attempt
  ADD CONSTRAINT payment_attempt_binding_provider_fk
  FOREIGN KEY (provider_binding_id, provider_key)
  REFERENCES provider_binding (id, provider_key);

-- ★ イベントが名乗る provider_key も同様。
ALTER TABLE event
  ADD CONSTRAINT event_binding_provider_fk
  FOREIGN KEY (provider_binding_id, provider_key)
  REFERENCES provider_binding (id, provider_key);

-- ★ イベントのバインディングは、そのイベントの幹事が所有するものに限る（集金先の乗っ取り防止）。
ALTER TABLE event
  ADD CONSTRAINT event_binding_owner_fk
  FOREIGN KEY (provider_binding_id, organizer_user_id)
  REFERENCES provider_binding (id, organizer_user_id);

COMMENT ON CONSTRAINT provider_binding_provider_scope_uk ON provider_binding IS
  'event / payment_attempt の複合 FK の参照先。provider_key の食い違いを DB で弾く。';
COMMENT ON CONSTRAINT provider_binding_owner_scope_uk ON provider_binding IS
  'event の複合 FK の参照先。イベントのバインディングを幹事本人の所有物に限る。';
COMMENT ON CONSTRAINT payment_attempt_binding_provider_fk ON payment_attempt IS
  'payment_attempt.provider_key は provider_binding.provider_key と一致する（R-PAY-01）。';
COMMENT ON CONSTRAINT event_binding_provider_fk ON event IS
  'event.provider_key は provider_binding.provider_key と一致する（R-PAY-01）。';
COMMENT ON CONSTRAINT event_binding_owner_fk ON event IS
  'event.provider_binding_id は event.organizer_user_id が所有するバインディングに限る。他人の受取先への集金を防ぐ（R-PAY-01 / R-SEC-03）。';
