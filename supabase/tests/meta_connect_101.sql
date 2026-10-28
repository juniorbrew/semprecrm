-- ============================================================
-- Migration 101 (Instagram / Messenger modules + connect sessions).
--
-- Nothing is committed (ends in ROLLBACK). Run with 099 and 100 in the same
-- transaction (strip each file's own BEGIN/COMMIT), and 101 TWICE to prove the
-- second run is a no-op:
--   (echo "BEGIN;"; sed '/^BEGIN;$/d;/^COMMIT;$/d' supabase/migrations/099_*.sql supabase/migrations/100_*.sql supabase/migrations/101_*.sql; \
--    cat supabase/tests/meta_connect_101.sql) | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_fails(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN RETURN;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- every current plan: trial / pro / empresa gained both modules, basico did not ----
SELECT pg_temp.assert_true(
  (SELECT bool_and(pv.definition->'modules' ? 'channel_instagram' AND pv.definition->'modules' ? 'channel_messenger')
     FROM public.platform_plan_catalog c JOIN public.platform_plan_versions pv ON pv.id = c.current_version_id
    WHERE c.plan IN ('trial', 'pro', 'empresa')), 'current trial/pro/empresa versions have both modules');
SELECT pg_temp.assert_true(
  (SELECT bool_and(NOT (pv.definition->'modules' ? 'channel_instagram') AND NOT (pv.definition->'modules' ? 'channel_messenger'))
     FROM public.platform_plan_catalog c JOIN public.platform_plan_versions pv ON pv.id = c.current_version_id
    WHERE c.plan = 'basico'), 'current basico version is unchanged');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM public.platform_plan_versions WHERE plan = 'basico' AND actor_name = 'Sistema (101: Instagram e Messenger)'),
  'no new basico revision');
SELECT pg_temp.assert_true(
  (SELECT count(*) >= 3 FROM public.platform_plan_versions WHERE actor_name = 'Sistema (101: Instagram e Messenger)'),
  'a new revision for each of trial / pro / empresa');

-- ---- accounts and account_billing now point at revisions that carry the modules ----
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM public.accounts a JOIN public.platform_plan_versions pv ON pv.id = a.plan_version_id
    WHERE a.plan IN ('trial', 'pro', 'empresa') AND NOT (pv.definition->'modules' ? 'channel_instagram')),
  'no trial/pro/empresa account left on a version without the modules');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM public.account_billing b JOIN public.platform_plan_versions pv ON pv.id = b.plan_version_id
    WHERE pv.plan IN ('trial', 'pro', 'empresa') AND NOT (pv.definition->'modules' ? 'channel_instagram')),
  'no billing row left on a version without the modules');

-- ---- accounts seeded BEFORE 101 (meta_connect_101_pre.sql) ----
SELECT pg_temp.assert_true((SELECT count(*) = 3 FROM pre_versions), 'pre-seeded accounts exist');
SELECT pg_temp.assert_true(
  (SELECT bool_and(a.plan_version_id <> v.old_account_version AND b.plan_version_id <> v.old_billing_version
                   AND pv.definition->'modules' ? 'channel_instagram' AND pv.definition->'modules' ? 'channel_messenger'
                   AND bpv.definition->'modules' ? 'channel_instagram')
     FROM pre_versions v
     JOIN accounts a ON a.id = v.account_id JOIN platform_plan_versions pv ON pv.id = a.plan_version_id
     JOIN account_billing b ON b.account_id = v.account_id JOIN platform_plan_versions bpv ON bpv.id = b.plan_version_id
    WHERE v.plan IN ('pro', 'empresa')),
  'pro / empresa accounts AND their account_billing were repointed to the new revisions');
SELECT pg_temp.assert_true(
  (SELECT bool_and(a.plan_version_id = v.old_account_version AND b.plan_version_id = v.old_billing_version
                   AND NOT (pv.definition->'modules' ? 'channel_instagram'))
     FROM pre_versions v
     JOIN accounts a ON a.id = v.account_id JOIN platform_plan_versions pv ON pv.id = a.plan_version_id
     JOIN account_billing b ON b.account_id = v.account_id
    WHERE v.plan = 'basico'),
  'basico account and billing untouched');

-- ---- the plan validator and the platform update accept the new keys ----
SELECT pg_temp.assert_true(
  public.valid_plan_definition('{"modules":["channel_instagram","channel_messenger"],"limits":{"max_users":1,"max_channels":1}}'::jsonb),
  'valid_plan_definition accepts the new modules');
SELECT pg_temp.assert_true(
  NOT public.valid_plan_definition('{"modules":["channel_telegram"],"limits":{"max_users":1,"max_channels":1}}'::jsonb),
  'valid_plan_definition still rejects unknown modules');

INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('11000000-0000-4000-8000-00000000000a', 'owner@connect.test', '{"full_name":"Owner"}'),
 ('11000000-0000-4000-8000-0000000000ff', 'platform@connect.test', '{"full_name":"Platform"}');
INSERT INTO public.platform_admins(user_id) VALUES ('11000000-0000-4000-8000-0000000000ff');
CREATE TEMP TABLE ids AS
SELECT account_id AS acc FROM profiles WHERE user_id = '11000000-0000-4000-8000-00000000000a';

SELECT pg_temp.assert_true(
  (public.platform_update_account_v2(
     (SELECT acc FROM ids),
     '{"module_overrides":{"channel_instagram":true,"channel_messenger":false}}'::jsonb,
     '11000000-0000-4000-8000-0000000000ff')).module_overrides = '{"channel_instagram":true,"channel_messenger":false}'::jsonb,
  'platform_update_account_v2 accepts the new override keys');
SELECT pg_temp.assert_fails(
  format('SELECT public.platform_update_account_v2(%L, %L::jsonb, %L)', (SELECT acc FROM ids), '{"module_overrides":{"channel_whatever":true}}', '11000000-0000-4000-8000-0000000000ff'),
  'platform_update_account_v2 still rejects unknown override keys');

-- ---- connect sessions: server only ----
INSERT INTO meta_connect_sessions(account_id, user_id, kind, pages)
VALUES ((SELECT acc FROM ids), '11000000-0000-4000-8000-00000000000a', 'messenger', 'ciphertext');
SELECT pg_temp.assert_true((SELECT expires_at > now() AND expires_at <= now() + interval '16 minutes' FROM meta_connect_sessions LIMIT 1), 'session expires in 15 min');
SELECT pg_temp.assert_fails(format('INSERT INTO meta_connect_sessions(account_id, user_id, kind, pages) VALUES (%L, %L, %L, %L)', (SELECT acc FROM ids), '11000000-0000-4000-8000-00000000000a', 'telegram', 'x'), 'kind CHECK');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_fails('SELECT pages FROM meta_connect_sessions', 'authenticated cannot read connect sessions');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.assert_fails('SELECT id FROM meta_connect_sessions', 'anon cannot read connect sessions');
RESET ROLE;

-- ---- a second run of 101 is a no-op (counted by the wrapper that appends 101 again) ----
CREATE TEMP TABLE before_second AS
SELECT (SELECT count(*) FROM public.platform_plan_versions) AS versions,
       (SELECT string_agg(current_version_id::text, ',' ORDER BY plan) FROM public.platform_plan_catalog) AS pointers,
       (SELECT string_agg(plan_version_id::text, ',' ORDER BY id) FROM public.accounts) AS acct_versions;
