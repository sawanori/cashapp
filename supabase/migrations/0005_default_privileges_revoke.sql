-- ============================================================================
-- 0005_default_privileges_revoke.sql — anon / authenticated の既定権限を剥がす
--
-- 0001_init.sql の権限節は `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon,
-- authenticated` を実行していたが、`ALL TABLES` は**その時点で存在するテーブルだけ**に
-- 効く。以後に作られるテーブル・シーケンス・関数には Supabase 既定の
-- ALTER DEFAULT PRIVILEGES がそのまま効き、anon / authenticated へ自動で
-- 全権が付く。実測（0005 適用前・pg_default_acl）:
--
--   grantor=postgres nspname=public defaclobjtype=r
--     {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--      authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
--   同 S（シーケンス）= rwU、同 f（関数）= X
--
-- つまり今後 task_012 以降が public に 1 テーブル足すたび、PostgREST の
-- anon ロールがそのテーブルを読み書きできる状態で生まれる。I3（PostgREST を
-- 使わない）と R-SEC-03（最小権限）を静かに破る穴なので、既定権限そのものを
-- 剥がす。
--
-- 対象は 0001 と同じく anon / authenticated の 2 ロール。TABLES / SEQUENCES /
-- FUNCTIONS の 3 種すべて。
--
-- 実行できる grantor は「実行ロールが USAGE 権限を持つロール」に限られるため、
-- 'postgres'（Supabase のマイグレーション実行ロール）と current_user だけを回す。
-- supabase_admin が public に持つ既定権限は postgres が supabase_admin の
-- メンバーでないため触れない（実測: pg_auth_members に supabase_admin 無し）。
-- 本アプリのテーブルは postgres が作るのでこの範囲で穴は閉じる。
-- 残余は docs/concerns/task_011.md に accepted-risk として記録した。
--
-- ロールが存在しない素の PostgreSQL（CI の一部経路）でも落ちないようガードする。
-- ============================================================================

DO $$
DECLARE
  grantor_role text;
  target_role  text;
BEGIN
  FOREACH grantor_role IN ARRAY ARRAY['postgres', current_user::text] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantor_role);
    -- 自分がメンバーでないロールの既定権限は変更できない（42501 になる）。
    CONTINUE WHEN NOT pg_has_role(current_user, grantor_role, 'USAGE');

    FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role);

      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
        grantor_role, target_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
        grantor_role, target_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I',
        grantor_role, target_role);
    END LOOP;
  END LOOP;
END
$$;

-- 念のため、既に存在するオブジェクトへの剥奪も再実行しておく（0001 と同内容・冪等）。
-- 0001 から 0005 のあいだに 0002〜0004 が作ったオブジェクトがあるため。
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
