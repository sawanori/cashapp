-- ============================================================================
-- 0001_init.sql — スキーマ v2（正本）
--
-- このファイル群（supabase/migrations/*.sql）がスキーマの**唯一の正本**である。
-- Drizzle（src/lib/db/schema.ts）は型とクエリのためだけに存在し、
-- drizzle-kit generate / push でマイグレーションを作らない
-- （docs/implementation-plan.md §7-2「マイグレーション」行、R-SEC-03）。
--
-- 設計根拠:
--   - docs/implementation-plan.md §10-1 / §10-2 / §10-3（本節が正本）
--   - docs/research/design-synthesis.md §2-2（ベース DDL）
--   - docs/research/premortem-risks.md §2-2（本 DDL に適用済みの差分）
--
-- 本 DDL が設計ブリーフ（design-synthesis.md §2-2）から意図的に変えている点:
--   1. RLS deny-all ＋ service role を**採用しない**。ランタイムは最小権限ロール
--      `app_rw` で接続する（implementation-plan.md §7-2「DB ロール」行）。
--      理由: service role は RLS を素通りするため deny-all が防御にならない（R-SEC-03）。
--   2. 追記専用の実装に RULE を**使わない**。`DO INSTEAD NOTHING` は違反を
--      「無言の 0 行成功」に変えてしまい、呼び出し側が失敗に気づけない（R-SEC-03）。
--      代わりに BEFORE UPDATE/DELETE/TRUNCATE の**文レベル**トリガで RAISE EXCEPTION する。
--      文レベルにしているのは、対象行が 0 行の UPDATE/DELETE でも必ず例外にするため。
--   3. premortem §2-2 の列追加・制約追加・テーブル追加をすべて反映済み。
-- ============================================================================

-- gen_random_uuid() は PostgreSQL 13+ の組み込み（pgcrypto 不要）だが、
-- Supabase のローカル/本番いずれでも存在することを明示しておく。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 共通: 追記専用テーブルを守るトリガ関数
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'append_only_violation: % on % is forbidden', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '0A000';  -- feature_not_supported
END;
$$;

COMMENT ON FUNCTION forbid_mutation() IS
  '追記専用テーブル（ledger_entry / audit_log）の UPDATE / DELETE / TRUNCATE を例外にする。'
  '文レベルトリガから呼ぶことで、0 行対象の UPDATE も「無言の成功」にせず例外にする。';

-- 更新時刻の自動更新（updated_at を持つテーブル用）。
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 主体
-- ============================================================================

-- app_user: LINE ユーザー。organizer テーブルは作らない（幹事と参加者は同一ユーザーで、
-- ロールはイベントごとに変わる）。
CREATE TABLE app_user (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC-SHA256(sub, PEPPER)。生の LINE userId は保存しない。
  line_user_ref      bytea NOT NULL,
  -- pepper のローテーション世代（R-SEC-09）。
  pepper_version     smallint NOT NULL DEFAULT 1 CHECK (pepper_version > 0),
  -- LINE プロバイダー世代。userId はプロバイダー単位で共通・移動不可のため、
  -- プロバイダーを変えた場合は別スコープとして共存させる（R-LINE-07）。
  identity_scope     text NOT NULL CHECK (length(identity_scope) BETWEEN 1 AND 64),
  -- どの LINE 環境（開発/審査/本番チャネル）で発行された参照か（R-LINE-04）。
  line_env           text NOT NULL CHECK (line_env IN ('development', 'staging', 'production')),
  -- セッション一括失効の世代（R-SEC-10）。
  session_epoch      integer NOT NULL DEFAULT 1 CHECK (session_epoch > 0),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  suspended_at       timestamptz,
  tos_accepted_at    timestamptz,
  privacy_consent_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_identity_uk UNIQUE (identity_scope, pepper_version, line_user_ref),
  CONSTRAINT app_user_suspended_consistency
    CHECK ((status = 'suspended') = (suspended_at IS NOT NULL))
);

CREATE TRIGGER app_user_set_updated_at
  BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- used_id_token: LINE ID トークンの単回使用（R-SEC-08）。TTL は exp。
CREATE TABLE used_id_token (
  jti_or_hash text PRIMARY KEY,
  used_at     timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX used_id_token_expiry_idx ON used_id_token (expires_at);

-- consent_log: 同意の取得履歴（R-LAW-10 / R-LAW-06）。
CREATE TABLE consent_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  consent_kind text NOT NULL CHECK (consent_kind IN
               ('tos', 'privacy', 'organizer_disclosure', 'fee_display')),
  text_version text NOT NULL CHECK (length(btrim(text_version)) > 0),
  accepted_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_log_user_idx ON consent_log (user_id, consent_kind, accepted_at DESC);

-- provider_binding: 幹事の決済事業者アカウント紐付け。資格情報の「値」は保持しない。
CREATE TABLE provider_binding (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_user_id         uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  provider_key              text NOT NULL CHECK (provider_key ~ '^[a-z0-9_]{1,32}$'),
  -- premortem §2-2: NULL 許容（manual_confirm は外部資格情報を持たない）。
  credential_ref            text,
  credential_fp             text CHECK (credential_fp IS NULL OR credential_fp ~ '^[0-9a-f]{16}$'),
  -- 受取識別子（加盟店 ID 等）。生の口座番号は入れない（R-SEC-14）。
  receiving_identifier      text,
  receiving_identifier_kind text CHECK (receiving_identifier_kind IN
                            ('merchant_id', 'bank_account_ref', 'none')),
  -- 手数料率（basis point）。幹事が手入力し、表示に使う（R-PAY-14）。
  fee_rate_bp               integer CHECK (fee_rate_bp IS NULL OR fee_rate_bp BETWEEN 0 AND 10000),
  capabilities              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                    text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
  verified_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_binding_organizer_provider_uk UNIQUE (organizer_user_id, provider_key),
  CONSTRAINT provider_binding_receiving_identifier_format CHECK (
    receiving_identifier IS NULL OR receiving_identifier ~ '^[A-Za-z0-9_-]{1,64}$'
  ),
  CONSTRAINT provider_binding_receiving_identifier_kind_pairing CHECK (
    (receiving_identifier IS NULL) = (receiving_identifier_kind IS NULL)
  )
);

CREATE TRIGGER provider_binding_set_updated_at
  BEFORE UPDATE ON provider_binding FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- イベント・名簿
-- ============================================================================

CREATE TABLE event (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  title                text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  -- 幹事の表示名。参加者に「誰が集金しているか」を示す（R-UX-01）。
  organizer_label      text NOT NULL CHECK (length(organizer_label) BETWEEN 1 AND 40),
  event_at             timestamptz,
  -- 対価性の証跡（R-LAW-09 / R-LAW-04）。
  venue                text CHECK (venue IS NULL OR length(venue) BETWEEN 1 AND 200),
  offering             text CHECK (offering IS NULL OR length(offering) BETWEEN 1 AND 400),
  currency             char(3) NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),
  default_amount_minor integer CHECK (default_amount_minor IS NULL
                       OR default_amount_minor BETWEEN 1 AND 1000000),
  -- premortem §2-2: date → timestamptz。
  collect_by_at        timestamptz,
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'collecting', 'closed', 'canceled')),
  -- 招待トークンは生で保存しない（定数時間比較・R-SEC-02）。
  join_token_hash      bytea NOT NULL,
  join_token_expires_at timestamptz,
  join_token_version   integer NOT NULL DEFAULT 1 CHECK (join_token_version > 0),
  allow_cash           boolean NOT NULL DEFAULT false,
  -- 未成年参加の申告（R-LAW-04）。既定値を置かず必ず申告させる。
  minors_included      boolean NOT NULL,
  provider_key         text NOT NULL DEFAULT 'manual_confirm'
                       CHECK (provider_key ~ '^[a-z0-9_]{1,32}$'),
  provider_binding_id  uuid REFERENCES provider_binding(id),
  -- 擬似匿名化の期日（終了 +90 日、R-DATA-02）。
  retention_due_at     timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_join_token_hash_uk UNIQUE (join_token_hash)
);
CREATE INDEX event_organizer_idx ON event (organizer_user_id, status, created_at DESC);
CREATE INDEX event_retention_idx ON event (retention_due_at) WHERE retention_due_at IS NOT NULL;

CREATE TRIGGER event_set_updated_at
  BEFORE UPDATE ON event FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- participant: 名簿。claim（LINE ユーザーとの束縛）は participant_claim に分離した
-- （premortem §2-2、R-SEC-01）。
CREATE TABLE participant (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id                 uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  -- 幹事が入力する表示名。保持期間経過後に NULL 化する。
  display_label            text CHECK (display_label IS NULL
                           OR length(display_label) BETWEEN 1 AND 40),
  -- 名簿の氏名を他の参加者に見せてよいか（R-LAW-06）。
  name_visibility          text NOT NULL DEFAULT 'organizer_only'
                           CHECK (name_visibility IN ('organizer_only', 'participants')),
  -- 参加者ごとの個別リンクのトークン（生は保存しない、R-SEC-01）。
  claim_token_hash         bytea,
  pepper_version           smallint CHECK (pepper_version IS NULL OR pepper_version > 0),
  confirmed_by_organizer_at timestamptz,
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX participant_event_idx ON participant (event_id, status);
CREATE UNIQUE INDEX participant_claim_token_uk ON participant (claim_token_hash)
  WHERE claim_token_hash IS NOT NULL;

CREATE TRIGGER participant_set_updated_at
  BEFORE UPDATE ON participant FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- participant_claim: claim の履歴。unclaim（released_at を埋める）後に本人が再 claim できる。
CREATE TABLE participant_claim (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  participant_id  uuid NOT NULL REFERENCES participant(id) ON DELETE CASCADE,
  line_user_ref   bytea NOT NULL,
  pepper_version  smallint NOT NULL DEFAULT 1 CHECK (pepper_version > 0),
  claimed_at      timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  released_reason text CHECK (released_reason IN
                  ('organizer_unclaim', 'self_release', 'participant_removed', 'admin')),
  CONSTRAINT participant_claim_release_consistency
    CHECK ((released_at IS NULL) = (released_reason IS NULL))
);
-- ★ 1 イベント内で 1 人の LINE ユーザーが同時に持てる未解放 claim は 1 つだけ（R-SEC-01）。
CREATE UNIQUE INDEX participant_claim_active_user_uk
  ON participant_claim (event_id, line_user_ref) WHERE released_at IS NULL;
-- ★ 1 participant を同時に 2 人が claim できない。
CREATE UNIQUE INDEX participant_claim_active_participant_uk
  ON participant_claim (participant_id) WHERE released_at IS NULL;
CREATE INDEX participant_claim_event_idx ON participant_claim (event_id, claimed_at DESC);

-- ============================================================================
-- 請求（中心エンティティ）
-- ============================================================================

CREATE TABLE invoice (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  -- premortem §2-2: CASCADE → RESTRICT（請求のある参加者を物理削除させない、R-PAY-03）。
  participant_id      uuid NOT NULL REFERENCES participant(id) ON DELETE RESTRICT,
  -- premortem §2-2: 上限 1,000,000（R-PAY-10）。
  amount_minor        integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000),
  currency            char(3) NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),

  settlement_status   text NOT NULL DEFAULT 'unpaid' CHECK (settlement_status IN
                      ('unpaid', 'authorized', 'paid', 'refund_pending', 'refunded', 'charged_back')),
  -- ★ 生成列。status と rank の乖離を構造的に不可能にする（W3）。
  --   ELSE NULL を書かない（未知 status を足すと NOT NULL / CHECK で必ず落ちる）。
  settlement_rank     smallint NOT NULL GENERATED ALWAYS AS (
                        CASE settlement_status
                          WHEN 'unpaid'         THEN 0
                          WHEN 'authorized'     THEN 10
                          WHEN 'paid'           THEN 40
                          WHEN 'refund_pending' THEN 60
                          WHEN 'refunded'       THEN 70
                          WHEN 'charged_back'   THEN 80
                        END) STORED,

  -- ★ 取消は独立軸。単調ランクと衝突させない。
  lifecycle_state     text NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'void')),
  voided_at           timestamptz,
  needs_attention     boolean NOT NULL DEFAULT false,

  -- ★ 非自動ラベルの根拠。false = 自動検知ではない（N11）。
  auto_detected       boolean NOT NULL DEFAULT false,
  confirmation_method text NOT NULL DEFAULT 'manual_by_organizer'
                      CHECK (confirmation_method IN ('automatic', 'manual_by_organizer')),

  paid_at             timestamptz,
  -- 幹事口座への入金確認。ランクの梯子に入れない。
  settled_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_event_participant_uk UNIQUE (event_id, participant_id),
  CONSTRAINT invoice_void_consistency CHECK ((lifecycle_state = 'void') = (voided_at IS NOT NULL)),
  -- premortem §2-2: rank が NULL になり得ないことを列の NOT NULL とは別に CHECK でも明示する
  -- （R-PAY-15。settlement_status に未知の値を足して CASE の ELSE を忘れた瞬間に落ちる）。
  CONSTRAINT invoice_settlement_rank_not_null CHECK (settlement_rank IS NOT NULL)
);

CREATE INDEX invoice_event_idx ON invoice (event_id, settlement_status);
-- 照合は「時刻カーソル」ではなく「状態」で走査する（W9）。
CREATE INDEX invoice_recon_idx ON invoice (settlement_status, updated_at)
  WHERE settlement_rank < 40 AND lifecycle_state = 'active';
CREATE INDEX invoice_attention_idx ON invoice (event_id) WHERE needs_attention;
CREATE INDEX invoice_participant_idx ON invoice (participant_id);

CREATE TRIGGER invoice_set_updated_at
  BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 決済試行
-- ============================================================================

CREATE TABLE payment_attempt (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id            uuid NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  provider_key          text NOT NULL CHECK (provider_key ~ '^[a-z0-9_]{1,32}$'),
  -- premortem §2-2: NOT NULL（どの加盟店アカウント宛の試行かを必ず残す、R-PAY-01）。
  provider_binding_id   uuid NOT NULL REFERENCES provider_binding(id),
  -- 'iv_' || replace(invoice_id::text,'-','') || '_' || attempt_seq。64 文字・[A-Za-z0-9_-]。
  external_ref          text NOT NULL CHECK (external_ref ~ '^[A-Za-z0-9_-]{1,64}$'),
  provider_payment_id   text,
  -- 突合の基準額はここ（invoice.amount_minor ではない。premortem §2-3）。
  amount_minor          integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 1000000),
  currency              char(3) NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),
  status                text NOT NULL DEFAULT 'created' CHECK (status IN
                        ('created', 'redirected', 'authorized', 'succeeded',
                         'failed', 'canceled', 'expired', 'refunded')),
  is_open               boolean NOT NULL GENERATED ALWAYS AS (
                          status IN ('created', 'redirected', 'authorized')) STORED,
  checkout_url          text,
  expires_at            timestamptz,
  -- 決済画面からの復帰トークン（セッション不要・単回・短命。R-LINE-01）。
  return_token_hash     bytea,
  return_token_expires_at timestamptz,
  -- 代理払いの「入力シグナル」。自動検知ではない。
  opened_by_user_ref    bytea,
  last_snapshot         jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempt_provider_ref_uk UNIQUE (provider_key, external_ref),
  CONSTRAINT payment_attempt_return_token_pairing CHECK (
    (return_token_hash IS NULL) = (return_token_expires_at IS NULL)
  )
);
-- ★ premortem §2-2: 同一請求に生きた試行は 1 つだけ（R-PAY-02）。
CREATE UNIQUE INDEX payment_attempt_open_uk ON payment_attempt (invoice_id) WHERE is_open;
CREATE UNIQUE INDEX payment_attempt_return_token_uk ON payment_attempt (return_token_hash)
  WHERE return_token_hash IS NOT NULL;
CREATE INDEX payment_attempt_invoice_idx ON payment_attempt (invoice_id, created_at DESC);
CREATE INDEX payment_attempt_open_expiry_idx ON payment_attempt (expires_at) WHERE is_open;

CREATE TRIGGER payment_attempt_set_updated_at
  BEFORE UPDATE ON payment_attempt FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 外部由来イベント（冪等の入口）
-- ============================================================================

CREATE TABLE payment_event (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_key      text NOT NULL CHECK (provider_key ~ '^[a-z0-9_]{1,32}$'),
  -- W1: 事業者のイベント ID。持たない事業者は 'sha256:'||sha256(raw_body)。NULL にしない。
  provider_event_id text NOT NULL CHECK (length(btrim(provider_event_id)) > 0),
  event_type        text NOT NULL,
  kind              text NOT NULL CHECK (kind IN
                    ('authorized', 'succeeded', 'failed', 'canceled', 'expired', 'refunded',
                     'refund_pending', 'refund_failed', 'disputed', 'dispute_resolved', 'unknown')),
  external_ref      text NOT NULL,
  -- W2: 業務レベルの観測キー。★ UNIQUE にしない（同一 charge への 2 回目の部分返金が
  -- 同じキーを生み、正当なイベントが DB 制約で黙って落ちるため。design-synthesis.md §2-2 の注）。
  business_idem_key text NOT NULL,
  invoice_id        uuid REFERENCES invoice(id),
  attempt_id        uuid REFERENCES payment_attempt(id),
  amount_minor      integer CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency          char(3),
  -- 順序判定には使わない（W4）。
  occurred_at       timestamptz,
  received_at       timestamptz NOT NULL DEFAULT now(),
  ingestion_source  text NOT NULL CHECK (ingestion_source IN ('webhook', 'poll', 'manual', 'bank')),
  trust             text NOT NULL CHECK (trust IN
                    ('verified', 'reverified', 'unverified', 'attested')),
  apply_result      text CHECK (apply_result IN
                    ('applied', 'duplicate', 'ignored', 'mismatch', 'orphan',
                     'signature_failed', 'error')),
  processed_at      timestamptz,
  -- premortem §2-2: raw → raw_redacted（許可キーのみ。生の本文を残さない、R-DATA-01）。
  raw_redacted      jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT payment_event_w1_uk UNIQUE (provider_key, provider_event_id)
);
CREATE INDEX payment_event_business_idx
  ON payment_event (provider_key, external_ref, kind, apply_result);
CREATE INDEX payment_event_invoice_idx ON payment_event (invoice_id, received_at);
CREATE INDEX payment_event_unprocessed_idx ON payment_event (received_at) WHERE processed_at IS NULL;

-- ============================================================================
-- 台帳（追記専用）
-- ============================================================================

CREATE TABLE ledger_entry (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id              uuid NOT NULL REFERENCES invoice(id),
  event_id                uuid NOT NULL REFERENCES event(id),
  direction               text NOT NULL CHECK (direction IN ('credit', 'debit')),
  -- premortem §2-2: chargeback / chargeback_reversal / fee を追加（R-PAY-07 / R-PAY-14）。
  kind                    text NOT NULL CHECK (kind IN
                          ('payment', 'refund', 'overpay', 'proxy_payment', 'adjustment',
                           'writeoff', 'chargeback', 'chargeback_reversal', 'fee')),
  amount_minor            integer NOT NULL CHECK (amount_minor > 0),
  currency                char(3) NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),
  confidence              text NOT NULL CHECK (confidence IN
                          ('provider_verified', 'provider_polled', 'bank_matched',
                           'organizer_attested')),
  -- ★ 二重計上の唯一の防波堤（W2）。
  dedupe_key              text NOT NULL CHECK (length(btrim(dedupe_key)) > 0),
  source_payment_event_id bigint REFERENCES payment_event(id),
  recorded_by             text NOT NULL CHECK (length(btrim(recorded_by)) > 0),
  memo                    text,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_dedupe_uk ON ledger_entry (invoice_id, dedupe_key);
CREATE INDEX ledger_invoice_idx ON ledger_entry (invoice_id, created_at);
CREATE INDEX ledger_event_idx ON ledger_entry (event_id, created_at);

-- ★ 追記専用。文レベルにしているので 0 行対象の UPDATE/DELETE でも必ず例外になる。
CREATE TRIGGER ledger_entry_no_update
  BEFORE UPDATE ON ledger_entry FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entry_no_delete
  BEFORE DELETE ON ledger_entry FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entry_no_truncate
  BEFORE TRUNCATE ON ledger_entry FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- payment_self_report: 参加者の自己申告。★ 台帳には書かない（R-UX-02）。
CREATE TABLE payment_self_report (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id           uuid NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  reported_by_user_ref bytea NOT NULL,
  method               text NOT NULL CHECK (method IN
                       ('paypay_p2p', 'cash', 'bank_transfer', 'other')),
  note                 text CHECK (note IS NULL OR length(note) <= 200),
  reported_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_self_report_invoice_idx ON payment_self_report (invoice_id, reported_at DESC);

-- manual_attestation: 手動確認（自動ではない経路）の証跡。
CREATE TABLE manual_attestation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES invoice(id),
  organizer_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  method            text NOT NULL CHECK (method IN
                    ('paypay_p2p', 'cash', 'bank_transfer', 'other')),
  reason            text NOT NULL,
  -- 自由記述のみ。画像は保存しない。
  evidence_note     text,
  attested_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manual_attestation_reason_not_blank CHECK (length(btrim(reason)) > 0)
);
CREATE INDEX manual_attestation_invoice_idx ON manual_attestation (invoice_id, attested_at DESC);

-- ============================================================================
-- 監査ログ（追記専用 ＋ ハッシュ連鎖）
-- ============================================================================
-- 連鎖は id 順で確定する。書き込み時は pg_advisory_xact_lock(AUDIT_CHAIN_LOCK) で
-- 直列化する（トランザクションスコープのみ。セッションスコープの pg_advisory_lock は
-- 接続プーラ経由で解放されない事故があるため使わない。R-SEC-15 / R-OPS-08）。
CREATE TABLE audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_type     text NOT NULL CHECK (actor_type IN
                 ('organizer', 'participant', 'system', 'webhook', 'admin')),
  -- line_user_ref か admin_id のハッシュ。生の userId は入れない。
  actor_ref      bytea,
  action         text NOT NULL CHECK (length(btrim(action)) > 0),
  target_type    text NOT NULL,
  target_id      text NOT NULL,
  before_rank    smallint,
  after_rank     smallint,
  amount_minor   integer,
  provider_key   text,
  external_ref   text,
  request_id     text NOT NULL CHECK (length(btrim(request_id)) > 0),
  -- HMAC。生 IP は保存しない（R-SEC-02）。
  source_ip_hash bytea,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash      bytea,
  row_hash       bytea NOT NULL
);
CREATE INDEX audit_target_idx ON audit_log (target_type, target_id, occurred_at DESC);
CREATE INDEX audit_action_idx ON audit_log (action, occurred_at DESC);

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ============================================================================
-- ゲート・フラグ（実行時キルスイッチ）
-- ============================================================================
-- ★ compliance_gate の正本は docs/gates/compliance-gates.json。この表は射影であり、
--   scripts/gates-sync.mjs が JSON から同期する（DB を直接書き換えても次回同期で戻る）。
CREATE TABLE compliance_gate (
  gate_key        text PRIMARY KEY CHECK (gate_key ~ '^[A-Z0-9-]{1,64}$'),
  description     text NOT NULL,
  scope           text,
  required_for    text[] NOT NULL CHECK (array_length(required_for, 1) >= 1),
  status          text NOT NULL DEFAULT 'unknown'
                  CHECK (status IN ('unknown', 'inquired', 'passed', 'failed', 'n/a')),
  valid_until     timestamptz,
  evidence_uri    text,
  evidence_version text,
  source_url_hash bytea,
  source_ref      text,
  -- 申請者と別人であることを要求する（R-SEC-06）。
  requested_by    text,
  approved_by     text,
  inquired_at     timestamptz,
  decided_at      timestamptz,
  decided_by      text,
  confidence      text CHECK (confidence IS NULL OR confidence IN
                  ('measured', 'documented', 'designed', 'unknown')),
  note            text,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_gate_evidence_required
    CHECK (status <> 'passed' OR evidence_uri IS NOT NULL),
  CONSTRAINT compliance_gate_approver_distinct
    CHECK (approved_by IS NULL OR requested_by IS NULL OR approved_by <> requested_by)
);

CREATE TABLE feature_flag (
  key        text PRIMARY KEY CHECK (key ~ '^[A-Z0-9_]{1,64}$'),
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 人間のみ。エージェント・システムが自分で立てられないことを制約で示す（L11）。
  updated_by text NOT NULL CHECK (
    length(btrim(updated_by)) > 0
    AND lower(updated_by) NOT IN ('system', 'agent', 'ai', 'bot', 'automation')
  )
);

-- ============================================================================
-- 非同期・突合・受信ログ
-- ============================================================================

CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind ~ '^[a-z0-9_]{1,48}$'),
  payload         jsonb NOT NULL,
  run_after       timestamptz NOT NULL DEFAULT now(),
  attempts        smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- premortem §2-2: 上限と DLQ（R-OPS-01）。
  max_attempts    smallint NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  dead_lettered_at timestamptz,
  locked_until    timestamptz,
  done_at         timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox (run_after)
  WHERE done_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX outbox_dead_idx ON outbox (dead_lettered_at) WHERE dead_lettered_at IS NOT NULL;

CREATE TABLE webhook_delivery (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key   text NOT NULL CHECK (provider_key ~ '^[a-z0-9_]{1,32}$'),
  received_at    timestamptz NOT NULL DEFAULT now(),
  sig_ok         boolean NOT NULL,
  -- premortem §2-3: 送信元 IP 許可リストの検査結果（R-SEC-11）。
  ip_allowed     boolean NOT NULL,
  http_status    smallint NOT NULL,
  body_sha256    text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  -- 14 日で NULL 化（保持期間 cron）。
  raw_body       text,
  headers        jsonb,
  source_ip_hash bytea
);
CREATE INDEX webhook_delivery_retention_idx ON webhook_delivery (received_at)
  WHERE raw_body IS NOT NULL;
CREATE INDEX webhook_delivery_provider_idx ON webhook_delivery (provider_key, received_at DESC);

CREATE TABLE reconciliation_run (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  scanned           integer NOT NULL DEFAULT 0 CHECK (scanned >= 0),
  advanced          integer NOT NULL DEFAULT 0 CHECK (advanced >= 0),
  mismatches        integer NOT NULL DEFAULT 0 CHECK (mismatches >= 0),
  -- premortem §2-3 走査2: paid 済みの再照会（R-PAY-07）。
  paid_rescanned    integer NOT NULL DEFAULT 0 CHECK (paid_rescanned >= 0),
  post_paid_changes integer NOT NULL DEFAULT 0 CHECK (post_paid_changes >= 0),
  truncated         boolean NOT NULL DEFAULT false,
  note              text
);
CREATE INDEX reconciliation_run_started_idx ON reconciliation_run (started_at DESC);

-- premortem §2-2: PK を (user_ref, endpoint, key) に変更し、in_flight と expires_at を持つ。
CREATE TABLE idempotency_key (
  user_ref      bytea NOT NULL,
  endpoint      text NOT NULL,
  key           text NOT NULL CHECK (length(btrim(key)) > 0),
  state         text NOT NULL DEFAULT 'in_flight' CHECK (state IN ('in_flight', 'done')),
  request_hash  text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- 保存許可フィールドのみのホワイトリスト方式（生のレスポンスを丸ごと入れない）。
  response_body jsonb,
  status_code   smallint,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_key_pk PRIMARY KEY (user_ref, endpoint, key),
  CONSTRAINT idempotency_key_done_consistency
    CHECK (state <> 'done' OR status_code IS NOT NULL)
);
CREATE INDEX idempotency_key_expiry_idx ON idempotency_key (expires_at);

CREATE TRIGGER idempotency_key_set_updated_at
  BEFORE UPDATE ON idempotency_key FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- abuse_report: 参加者からの通報（R-LAW-15）。
CREATE TABLE abuse_report (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  reporter_user_ref bytea NOT NULL,
  reason            text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX abuse_report_event_idx ON abuse_report (event_id, created_at DESC);

-- reminder_log: 催促ログ（Phase 3）。一意制約で回数上限を構造的に縛る。
CREATE TABLE reminder_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  -- 送信主体は必ず幹事（運営者が送らない。§7-3）。
  sent_by_organizer uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  -- 1 請求あたり最大 2 回（§7-3）。
  seq               smallint NOT NULL CHECK (seq BETWEEN 1 AND 2),
  sent_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminder_log_invoice_seq_uk UNIQUE (invoice_id, seq)
);

-- payout: 入金（Phase 3）。
CREATE TABLE payout (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_binding_id uuid NOT NULL REFERENCES provider_binding(id) ON DELETE RESTRICT,
  period              daterange NOT NULL,
  amount_minor        integer NOT NULL CHECK (amount_minor >= 0),
  fee_minor           integer NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  currency            char(3) NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),
  settled_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_binding_period_uk UNIQUE (provider_binding_id, period)
);

-- ============================================================================
-- ロールと権限（R-SEC-03）
-- ============================================================================
-- ランタイム（Workers → Hyperdrive → Postgres）はこの app_rw で接続する。
-- service role / postgres はマイグレーションと運用コマンドでのみ使い、
-- ランタイムの環境変数には置かない（implementation-plan.md §7-2「DB ロール」行）。
--
-- パスワードはここで設定しない。本番 / staging は秘密ストアから
-- `ALTER ROLE app_rw PASSWORD ...` で投入し（task_024 / task_035）、
-- ローカル / CI はテストのセットアップ（tests/integration/setup.ts）が
-- ローカル専用の値を設定する。マイグレーションに秘密値を埋めない。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw LOGIN;
  END IF;
END
$$;

ALTER ROLE app_rw SET search_path = public;

-- DDL を持たせない: スキーマへの CREATE を明示的に剥がす。
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM app_rw;
GRANT USAGE ON SCHEMA public TO app_rw;

-- 通常テーブル: 読み書き。
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app_user, used_id_token, consent_log, provider_binding, event, participant,
  participant_claim, invoice, payment_attempt, payment_event, payment_self_report,
  manual_attestation, outbox, webhook_delivery, reconciliation_run, idempotency_key,
  abuse_report, reminder_log, payout
TO app_rw;

-- ★ 追記専用テーブル: INSERT と SELECT のみ。UPDATE / DELETE の権限を与えない。
--   トリガと二重の防御にする（権限エラーとトリガ例外のどちらでも止まる）。
GRANT SELECT, INSERT ON ledger_entry TO app_rw;
GRANT SELECT, INSERT ON audit_log TO app_rw;

-- ★ ゲートの正本は JSON。ランタイムは読むだけ（書き込みは gates-sync が直接接続で行う）。
GRANT SELECT ON compliance_gate TO app_rw;
-- フラグは管理画面（別系統認証・二人承認）から更新されるため INSERT / UPDATE を許すが、
-- 行の削除は許さない（履歴を消させない）。
GRANT SELECT, INSERT, UPDATE ON feature_flag TO app_rw;

-- IDENTITY / serial 列のためのシーケンス使用権。
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- ★ Supabase の PostgREST ロール（anon / authenticated）にはこのスキーマの権限を与えない。
--   本アプリは PostgREST を使わず、すべてサーバー側（Route Handler）から接続する（I3）。
--   ロールが存在しない素の PostgreSQL（CI の一部経路）でも落ちないようガードする。
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- 以後このマイグレーションを実行したロールが作るオブジェクトの既定権限。
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
