-- ============================================================================
-- 0002_seed_gates.sql — compliance_gate の初期在庫と feature_flag の安全側既定
--
-- ★ ゲートの正本は docs/gates/compliance-gates.json（Git 管理・PR 対象・変更は PO のみ）。
--   この表はその射影にすぎない。DB を直接書き換えても次回の `npm run gates:sync -- --apply`
--   で JSON の値に戻る（docs/gates/README.md）。
--   本ファイルは JSON（schema_version 1 / generated_at 2026-09-24）から生成した内容と
--   一致しており、`npm run gates:sync` が両者の差分 0 を機械検査する。
--
-- 出典: docs/implementation-plan.md §10-3、docs/acceptance-checks.json check_052。
-- ============================================================================

INSERT INTO compliance_gate
  (gate_key, description, required_for, status, valid_until, evidence_uri, approved_by, source_ref)
VALUES
  ('G0-USER', '受取先変更（幹事名義の加盟店アカウント経由の銀行口座になること）と、それに伴う幹事への加盟店審査発生について、PO の明示同意があること', ARRAY['phase1', 'phase2']::text[], 'unknown', NULL, NULL, NULL, 'implementation-plan.md §4-1, §6 A1; docs/research/design-synthesis.md §7 ゲート一覧'),
  ('GATE-LINE-POLICY', '「幹事が管理する精算・集金の台帳」というサービス定義が、LINEミニアプリポリシーの禁止業種（募金・寄附・クラウドファンディング等）および有料サービス販売条項（アプリ内課金必須）のいずれにも該当しないこと', ARRAY['phase1']::text[], 'unknown', NULL, NULL, NULL, 'implementation-plan.md §6 A7, §18-1 (Q-LN1/Q-LN2); docs/research/design-synthesis.md §7 ゲート一覧'),
  ('GATE-LINE-SHARE', 'ミニアプリチャネルで shareTargetPicker が配布の補助導線として利用可能であること（利用可否・申請要否）', ARRAY['phase1']::text[], 'unknown', NULL, NULL, NULL, 'implementation-plan.md §6 A9, §7-3, §18-1 (Q-LN7)'),
  ('GATE-LEGAL-PII', '幹事への支払状況開示（名簿・請求状況の表示、参加者の個人情報の取扱い）に関する法的整理と同意文言が確定していること', ARRAY['phase1']::text[], 'unknown', NULL, NULL, NULL, 'docs/research/design-synthesis.md §7 ゲート一覧; implementation-plan.md §18-1 (Q-LG9, Q-LG12〜16)'),
  ('GATE-LEGAL-FUNDS', '幹事が受取先と金額を指定し参加者に支払わせる本資金フローが、資金決済法上の為替取引（資金移動業登録)を要しないとの弁護士見解が得られていること（Q-LG1）', ARRAY['phase2']::text[], 'unknown', NULL, NULL, NULL, 'implementation-plan.md §18-1 (Q-LG1); docs/research/design-synthesis.md §7 ゲート一覧'),
  ('GATE-PP-MERCHANDISE', '会費徴収が PayPay オンライン決済の取扱可能商材であり、寄付・募金・投げ銭に該当しないこと（Q-PP1, Q-PP2）', ARRAY['phase2']::text[], 'unknown', NULL, NULL, NULL, 'docs/research/design-synthesis.md §7 ゲート一覧; implementation-plan.md §18-1 (Q-PP1/Q-PP2)'),
  ('GATE-PP-ONBOARD', '幹事が PayPay 加盟店申込を行えること（実店舗を持たない個人事業主の申込条件・必要書類が確定していること）（Q-PP3）', ARRAY['phase2']::text[], 'unknown', NULL, NULL, NULL, 'docs/research/design-synthesis.md §7 ゲート一覧; implementation-plan.md §18-1 (Q-PP3)'),
  ('GATE-PP-WEBHOOK', 'Webhook の署名有無・登録手順・リトライ仕様・ペイロード定義が確定していること（Q-PP5）', ARRAY['phase2']::text[], 'unknown', NULL, NULL, NULL, 'docs/research/design-synthesis.md §7 ゲート一覧; implementation-plan.md §18-1 (Q-PP5)'),
  ('GATE-CRED-CUSTODY', '幹事の加盟店 API クレデンシャルを運営者（委託先）が保管して API を呼ぶことが、「資金の受入れへの関与」と評価されず、加盟店規約の認証情報第三者預託禁止にも抵触しないこと（Q-LG7 / Q-PP9）', ARRAY['phase2']::text[], 'unknown', NULL, NULL, NULL, 'implementation-plan.md §6 A6, §9 (/api/providers/bind), §18-1 (Q-LG7/Q-PP9); docs/research/design-synthesis.md §7 ゲート一覧'),
  ('GATE-PP-IP-RANGE', 'Webhook 送信元 IP の公式レンジが一次資料で確定しており、受信時の IP 許可リストを構成できること（Q-PP11）', ARRAY['phase2']::text[], 'unknown', NULL, NULL, NULL, 'implementation-plan.md §18-1 (Q-PP11), §4-4, §17-3 (R-SEC-11 IP 許可リスト)')
ON CONFLICT (gate_key) DO UPDATE SET
  description  = EXCLUDED.description,
  required_for = EXCLUDED.required_for,
  status       = EXCLUDED.status,
  valid_until  = EXCLUDED.valid_until,
  evidence_uri = EXCLUDED.evidence_uri,
  approved_by  = EXCLUDED.approved_by,
  source_ref   = EXCLUDED.source_ref,
  synced_at    = now();

-- ★ 決済機能のキルスイッチ。Phase 1 は決済非依存コアのみで、決済経路は Phase 2 の
--   ゲート通過まで物理的に無効でなければならない（L11、docs/research/premortem-risks.md §5）。
--   updated_by は「人間のみ」制約があるため、初期値の責任者である PO を記録する。
INSERT INTO feature_flag (key, value, updated_by)
VALUES ('PAYMENTS_ENABLED', 'false', 'po:noritaka')
ON CONFLICT (key) DO NOTHING;
