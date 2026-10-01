-- ============================================================
-- Migration 058 (AI foundations) — behaviour + RLS smoke test.
--
-- Run against a database that already has 058 applied, or apply the
-- missing migrations in the same transaction first (nothing is
-- committed — the script ends in ROLLBACK):
--   (echo 'BEGIN;'; cat supabase/migrations/05{4,5,6,7,8}_*.sql supabase/tests/ai_foundations.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;

-- Signup trigger creates one account per user (owner).
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('58000000-0000-4000-8000-00000000000a', 'owner-a@ai.test', '{"full_name":"Owner A"}'),
 ('58000000-0000-4000-8000-00000000000b', 'owner-b@ai.test', '{"full_name":"Owner B"}'),
 ('58000000-0000-4000-8000-00000000000d', 'agent-a@ai.test', '{"full_name":"Agent A"}');

CREATE TEMP TABLE ids AS
SELECT
  (SELECT account_id FROM profiles WHERE user_id = '58000000-0000-4000-8000-00000000000a') AS acc_a,
  (SELECT account_id FROM profiles WHERE user_id = '58000000-0000-4000-8000-00000000000b') AS acc_b;
GRANT SELECT ON ids TO authenticated;

UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id = '58000000-0000-4000-8000-00000000000d';

-- Fixtures (as postgres = service path).
INSERT INTO ai_provider_credentials(account_id, provider, api_key_enc, last4)
SELECT acc_a, 'openai', 'iv:ciphertext:tag', 'abcd' FROM ids;
INSERT INTO ai_provider_credentials(account_id, provider, api_key_enc, last4)
SELECT acc_b, 'anthropic', 'iv:secret-b:tag', 'wxyz' FROM ids;
INSERT INTO ai_usage(account_id, feature, provider, model, input_tokens, output_tokens, cost_cents, status)
SELECT acc_a, 'suggest_reply', 'openai', 'gpt-4.1-mini', 1000, 100, 0.5, 'ok' FROM ids;
INSERT INTO ai_usage(account_id, feature, provider, model, cost_cents, status, error_code)
SELECT acc_a, 'suggest_reply', 'openai', 'gpt-4.1-mini', 0, 'error', 'invalid_key' FROM ids;
INSERT INTO ai_usage(account_id, feature, provider, model, cost_cents, status, error_code)
SELECT acc_a, 'suggest_reply', 'openai', 'gpt-4.1-mini', 0, 'blocked', 'budget_exceeded' FROM ids;
INSERT INTO ai_usage(account_id, feature, provider, model, input_tokens, cost_cents, status, created_at)
SELECT acc_a, 'suggest_reply', 'openai', 'gpt-4.1-mini', 500, 9, 'ok', NOW() - INTERVAL '40 days' FROM ids;
INSERT INTO ai_usage(account_id, feature, provider, model, cost_cents, status)
SELECT acc_b, 'suggest_reply', 'anthropic', 'claude-haiku-4-5', 7, 'ok' FROM ids;

-- ---- constraints -------------------------------------------
DO $$ BEGIN
  INSERT INTO ai_provider_credentials(account_id, provider, api_key_enc, last4)
  SELECT acc_a, 'openai', 'x', '1234' FROM ids;
  RAISE EXCEPTION 'second credential for the same provider accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_provider_credentials(account_id, provider, api_key_enc, last4)
  SELECT acc_a, 'gemini', 'x', '1234' FROM ids;
  RAISE EXCEPTION 'unknown provider accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_settings(account_id, enabled, provider, model) SELECT acc_a, true, 'openai', 'gpt-4.1-mini' FROM ids;
  RAISE EXCEPTION 'enabled without consent accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_settings(account_id, enabled, provider, model, consent_provider, consented_at)
  SELECT acc_a, true, 'openai', 'gpt-4.1-mini', 'anthropic', NOW() FROM ids;
  RAISE EXCEPTION 'enabled with consent for another provider accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_settings(account_id, model) SELECT acc_a, 'bad model; drop' FROM ids;
  RAISE EXCEPTION 'bad model id accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_usage(account_id, feature, provider, model, status)
  SELECT acc_a, 'chat', 'openai', 'm', 'ok' FROM ids;
  RAISE EXCEPTION 'unknown feature accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;

-- ---- privileges ------------------------------------------
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated', 'ai_provider_credentials_public', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'ai_provider_credentials_public', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'ai_provider_credentials_public', 'DELETE')
  AND has_table_privilege('authenticated', 'ai_provider_credentials_public', 'SELECT'),
  'credentials view is read-only for authenticated');
SELECT pg_temp.assert_true(
  NOT has_table_privilege('anon', 'ai_provider_credentials_public', 'SELECT'),
  'anon cannot read the credentials view');
SELECT pg_temp.assert_true(
  NOT has_function_privilege('anon', 'public.ai_usage_summary(uuid, timestamptz)', 'EXECUTE'),
  'anon cannot call ai_usage_summary');
SELECT pg_temp.assert_true(
  NOT has_table_privilege('authenticated', 'ai_usage', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'ai_provider_credentials', 'SELECT'),
  'usage/credentials base tables closed to authenticated');

-- ---- summary (service path) --------------------------------
SELECT pg_temp.assert_true(
  (SELECT calls = 2 AND errors = 1 AND input_tokens = 1000 AND cost_cents = 0.5
     FROM ai_usage_summary((SELECT acc_a FROM ids), NOW() - INTERVAL '1 day')),
  'summary counts ok+error since the window start, skips blocked and older rows');

-- ---- admin (owner A) ---------------------------------------
-- 076 closes new functions by default: open this script's pg_temp helpers.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '58000000-0000-4000-8000-00000000000a', true);

DO $$ BEGIN
  PERFORM api_key_enc FROM ai_provider_credentials;
  RAISE EXCEPTION 'authenticated read the credentials base table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 AND bool_and(last4 = 'abcd') FROM ai_provider_credentials_public),
  'admin sees only own account credential via the public view');
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'ai_provider_credentials_public' AND column_name = 'api_key_enc'),
  'public view has no ciphertext column');

INSERT INTO ai_settings(account_id, provider, model, consent_provider, consented_at, consented_by)
SELECT acc_a, 'openai', 'gpt-4.1-mini', 'openai', '2000-01-01', '58000000-0000-4000-8000-00000000000b' FROM ids;
SELECT pg_temp.assert_true(
  (SELECT consented_by = '58000000-0000-4000-8000-00000000000a' AND consented_at > NOW() - INTERVAL '1 minute'
     FROM ai_settings WHERE account_id = (SELECT acc_a FROM ids)),
  'consent stamped with the caller and the server clock');
UPDATE ai_settings SET enabled = true WHERE account_id = (SELECT acc_a FROM ids);
-- An unrelated update cannot forge who accepted the notice.
UPDATE ai_settings SET consented_by = '58000000-0000-4000-8000-00000000000b', updated_by = '58000000-0000-4000-8000-00000000000b'
 WHERE account_id = (SELECT acc_a FROM ids);
SELECT pg_temp.assert_true(
  (SELECT consented_by = '58000000-0000-4000-8000-00000000000a' AND updated_by = '58000000-0000-4000-8000-00000000000a'
     FROM ai_settings WHERE account_id = (SELECT acc_a FROM ids)),
  'consented_by / updated_by cannot be forged');
-- Writes through the credentials view are refused.
DO $$ BEGIN
  UPDATE ai_provider_credentials_public SET account_id = (SELECT acc_b FROM ids) WHERE provider = 'openai';
  RAISE EXCEPTION 'credential moved through the view';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  DELETE FROM ai_provider_credentials_public;
  RAISE EXCEPTION 'credential deleted through the view';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT pg_temp.assert_true(
  (SELECT enabled FROM ai_settings WHERE account_id = (SELECT acc_a FROM ids)),
  'admin enables after consent');
DO $$ BEGIN
  UPDATE ai_settings SET provider = 'anthropic' WHERE account_id = (SELECT acc_a FROM ids);
  RAISE EXCEPTION 'provider switch kept enabled without re-consent';
EXCEPTION WHEN check_violation THEN NULL; END $$;

SELECT pg_temp.assert_true(
  (SELECT count(*) = 4 FROM ai_usage), 'admin reads own account usage only');
SELECT pg_temp.assert_true(
  (SELECT calls = 0 FROM ai_usage_summary((SELECT acc_b FROM ids), NOW() - INTERVAL '1 day')),
  'summary of another account is empty under RLS');
DO $$ BEGIN
  INSERT INTO ai_usage(account_id, feature, provider, model, status)
  SELECT acc_a, 'suggest_reply', 'openai', 'm', 'ok' FROM ids;
  RAISE EXCEPTION 'authenticated inserted usage';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

-- ---- agent A -----------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '58000000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM ai_provider_credentials_public), 'agent sees no credentials');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM ai_settings), 'agent reads own account settings');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM ai_usage), 'agent cannot read usage');
UPDATE ai_settings SET instructions = 'hacked' WHERE account_id = (SELECT acc_a FROM ids);
SELECT pg_temp.assert_true(
  (SELECT instructions IS NULL FROM ai_settings), 'agent cannot update settings');
RESET ROLE;

-- ---- owner B -----------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '58000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM ai_settings), 'other account cannot read settings');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 AND bool_and(last4 = 'wxyz') FROM ai_provider_credentials_public),
  'other account sees only its own credential');
DO $$ BEGIN
  INSERT INTO ai_settings(account_id) SELECT acc_a FROM ids;
  RAISE EXCEPTION 'cross-account settings insert accepted';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

-- ---- anon --------------------------------------------------
SET LOCAL ROLE anon;
DO $$ BEGIN
  PERFORM 1 FROM ai_provider_credentials_public;
  RAISE EXCEPTION 'anon read the credentials view';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

-- ---- platform override accepts `ai` ------------------------
SELECT pg_temp.assert_true(
  (SELECT prosrc LIKE '%''calendar'', ''ai''%' FROM pg_proc WHERE proname = 'platform_update_account'),
  'platform_update_account allows the ai module');

\echo 'ai_foundations: all assertions passed'
ROLLBACK;
