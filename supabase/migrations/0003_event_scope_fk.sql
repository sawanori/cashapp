-- ============================================================================
-- 0003_event_scope_fk.sql — event スコープの複合外部キー（レビュー指摘の修正）
--
-- 0001_init.sql では invoice / participant_claim の `event_id` と `participant_id`
-- が**互いに独立した 2 本の単独 FK**でしか縛られていなかった。そのため
-- 「participant が属する event」と「行が名乗る event_id」がずれていても DB が受理し、
-- 以下の 2 つの一意制約が迂回できた（実測で再現済み）:
--
--   1. invoice_event_participant_uk UNIQUE (event_id, participant_id)
--      → 同じ participant に対し event_id を変えるだけで請求を 2 行作れた
--        （§10-2 が要求する「1 参加者 1 請求」が破れる。R-PAY-03）。
--   2. participant_claim_active_user_uk (event_id, line_user_ref) WHERE released_at IS NULL
--      → 呼び出し側が誤った / 細工した event_id を渡せば、同一イベント内で
--        1 人の LINE ユーザーが未解放 claim を複数持てた（R-SEC-01、check_016 の要）。
--
-- 対処: participant に (event_id, id) の UNIQUE を張り、両テーブルから
-- **複合 FK** で参照する。これにより「名乗る event_id」は参照先 participant の
-- 実際の event_id と一致するほかなくなり、上記 2 つの部分一意 / 一意が
-- アプリの正しさに依存せず DB だけで成立する。
--
-- 既存の単独 FK（invoice_event_id_fkey / invoice_participant_id_fkey /
-- participant_claim_event_id_fkey / participant_claim_participant_id_fkey）は
-- 残す。ON DELETE の挙動（invoice → participant は RESTRICT、
-- participant_claim → participant は CASCADE）を複合側でも同じに揃えてあるため、
-- 削除時のふるまいは 0001 から変わらない。
-- ============================================================================

-- 複合 FK の参照先。participant.id は既に主キーなので、この UNIQUE は
-- 「event_id と id の組」を参照可能にするためだけの冗長な一意制約である。
ALTER TABLE participant
  ADD CONSTRAINT participant_event_scope_uk UNIQUE (event_id, id);

-- ★ invoice が名乗る event_id は participant の event_id と一致しなければならない。
ALTER TABLE invoice
  ADD CONSTRAINT invoice_event_participant_fk
  FOREIGN KEY (event_id, participant_id)
  REFERENCES participant (event_id, id) ON DELETE RESTRICT;

-- ★ participant_claim が名乗る event_id も同様。
ALTER TABLE participant_claim
  ADD CONSTRAINT participant_claim_event_participant_fk
  FOREIGN KEY (event_id, participant_id)
  REFERENCES participant (event_id, id) ON DELETE CASCADE;

COMMENT ON CONSTRAINT participant_event_scope_uk ON participant IS
  'invoice / participant_claim の複合 FK の参照先。event スコープの一貫性を DB で担保する。';
COMMENT ON CONSTRAINT invoice_event_participant_fk ON invoice IS
  'invoice.event_id は participant.event_id と一致する。UNIQUE (event_id, participant_id) の迂回を塞ぐ（R-PAY-03）。';
COMMENT ON CONSTRAINT participant_claim_event_participant_fk ON participant_claim IS
  'participant_claim.event_id は participant.event_id と一致する。未解放 claim の部分一意の迂回を塞ぐ（R-SEC-01）。';
