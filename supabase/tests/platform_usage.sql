-- ============================================================
-- Migration 112 (platform_usage): numbers of two sample companies checked by hand, month boundaries
-- (America/Sao_Paulo), the rolling 7 days, "never active" (NULL), grants (service_role only).
--
-- Nothing is committed (ends in ROLLBACK). Needs the local DB migrated through 112:
--   docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/tests/platform_usage.sql
-- Never run `supabase db reset`.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual numeric, expected numeric, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
CREATE FUNCTION pg_temp.assert_fails_with(stmt text, state text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = state THEN RETURN; END IF;
    RAISE EXCEPTION 'FAIL (wrong error %: %): %', SQLSTATE, SQLERRM, label;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- two companies -------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('11200000-0000-4000-8000-00000000000a', 'owner-a@usage.test', '{"full_name":"Owner A"}'),
 ('11200000-0000-4000-8000-00000000000b', 'owner-b@usage.test', '{"full_name":"Owner B"}');
CREATE TEMP TABLE ctx AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '11200000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '11200000-0000-4000-8000-00000000000b') AS acc_b;

-- A: two contacts (one 1 day old, one 8 days old) -> contacts_7d = 1
INSERT INTO contacts(id, user_id, account_id, phone, name, created_at) VALUES
 ('11200000-0000-4000-8000-0000000000c1', '11200000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900000001', 'C1', now() - interval '1 day'),
 ('11200000-0000-4000-8000-0000000000c2', '11200000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900000002', 'C2', now() - interval '8 days');
-- A: d1, d2 created in June 2026; d3 created in May 2026
INSERT INTO conversations(id, user_id, account_id, contact_id, created_at, status) VALUES
 ('11200000-0000-4000-8000-0000000000d1', '11200000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11200000-0000-4000-8000-0000000000c1', '2026-06-10 12:00:00+00', 'open'),
 ('11200000-0000-4000-8000-0000000000d2', '11200000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11200000-0000-4000-8000-0000000000c2', '2026-06-15 12:00:00+00', 'open'),
 ('11200000-0000-4000-8000-0000000000d3', '11200000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11200000-0000-4000-8000-0000000000c2', '2026-05-20 12:00:00+00', 'closed');
-- June (America/Sao_Paulo = UTC-3): [2026-06-01 03:00Z, 2026-07-01 03:00Z)
INSERT INTO messages(conversation_id, sender_type, content_text, created_at) VALUES
 ('11200000-0000-4000-8000-0000000000d1', 'customer', 'x', '2026-06-10 12:00:00+00'),
 ('11200000-0000-4000-8000-0000000000d1', 'customer', 'x', '2026-06-10 12:01:00+00'),
 ('11200000-0000-4000-8000-0000000000d1', 'agent',    'x', '2026-06-10 12:02:00+00'),
 ('11200000-0000-4000-8000-0000000000d1', 'bot',      'x', '2026-06-10 12:03:00+00'),
 ('11200000-0000-4000-8000-0000000000d3', 'customer', 'x', '2026-06-01 02:59:59+00'),  -- last second of May
 ('11200000-0000-4000-8000-0000000000d3', 'customer', 'x', '2026-06-01 03:00:00+00'),  -- first second of June
 ('11200000-0000-4000-8000-0000000000d3', 'agent',    'x', '2026-07-01 02:59:59+00'),  -- last second of June
 ('11200000-0000-4000-8000-0000000000d3', 'agent',    'x', '2026-07-01 03:00:00+00');  -- first second of July
-- last_message_at after the inserts (a trigger may have moved it)
UPDATE conversations SET last_message_at = '2026-06-10 12:03:00+00' WHERE id = '11200000-0000-4000-8000-0000000000d1';
UPDATE conversations SET last_message_at = '2026-07-01 03:00:00+00' WHERE id = '11200000-0000-4000-8000-0000000000d3';
-- A: AI. June: 2 ok calls (150.5 + 49.5 cents = 2.00 USD); an error row and a July row do not count
INSERT INTO ai_usage(account_id, feature, provider, model, cost_cents, status, created_at) VALUES
 ((SELECT acc_a FROM ctx), 'suggest_reply', 'openai', 'm', 150.5, 'ok',    '2026-06-05 12:00:00+00'),
 ((SELECT acc_a FROM ctx), 'suggest_reply', 'openai', 'm', 49.5,  'ok',    '2026-06-20 12:00:00+00'),
 ((SELECT acc_a FROM ctx), 'suggest_reply', 'openai', 'm', 0,     'error', '2026-06-06 12:00:00+00'),
 ((SELECT acc_a FROM ctx), 'suggest_reply', 'openai', 'm', 99,    'ok',    '2026-07-01 03:00:00+00');
-- B: nothing at all

CREATE TEMP TABLE jun AS SELECT * FROM platform_usage('2026-06-17');   -- any day of the month works
CREATE TEMP TABLE may AS SELECT * FROM platform_usage('2026-05-01');

-- one row per account, B present with zeros and never active
SELECT pg_temp.assert_eq((SELECT count(*) FROM jun WHERE account_id IN ((SELECT acc_a FROM ctx), (SELECT acc_b FROM ctx))), 2, 'a row for each account');
SELECT pg_temp.assert_eq((SELECT count(*) FROM jun), (SELECT count(*) FROM accounts), 'one row per account in total');
SELECT pg_temp.assert_true((SELECT conversations = 0 AND messages_received = 0 AND messages_sent = 0 AND ai_calls = 0
   AND ai_cost_usd = 0 AND contacts_7d = 0 AND last_activity_at IS NULL FROM jun WHERE account_id = (SELECT acc_b FROM ctx)), 'B: zeros, never active');

-- A in June, by hand
SELECT pg_temp.assert_eq((SELECT conversations FROM jun WHERE account_id = (SELECT acc_a FROM ctx)), 2, 'A conversations in June (d3 is May)');
SELECT pg_temp.assert_eq((SELECT messages_received FROM jun WHERE account_id = (SELECT acc_a FROM ctx)), 3, 'A received: 2 + the first second of June');
SELECT pg_temp.assert_eq((SELECT messages_sent FROM jun WHERE account_id = (SELECT acc_a FROM ctx)), 3, 'A sent: agent + bot + the last second of June');
SELECT pg_temp.assert_eq((SELECT ai_calls FROM jun WHERE account_id = (SELECT acc_a FROM ctx)), 2, 'A AI calls (errors and July out)');
SELECT pg_temp.assert_eq((SELECT ai_cost_usd FROM jun WHERE account_id = (SELECT acc_a FROM ctx)), 2.00, 'A AI cost in USD');
SELECT pg_temp.assert_eq((SELECT contacts_7d FROM jun WHERE account_id = (SELECT acc_a FROM ctx)), 1, 'A people in the last 7 days (the 8-day-old one is out)');
SELECT pg_temp.assert_true((SELECT last_activity_at = '2026-07-01 03:00:00+00' FROM jun WHERE account_id = (SELECT acc_a FROM ctx)), 'A last activity (older than 14 days: the "no use" signal)');

-- A in May: only the message of the last second of May and the conversation created in May
SELECT pg_temp.assert_true((SELECT conversations = 1 AND messages_received = 1 AND messages_sent = 0 AND ai_calls = 0 AND ai_cost_usd = 0
   FROM may WHERE account_id = (SELECT acc_a FROM ctx)), 'A in May');

-- grants: service_role only
SELECT pg_temp.assert_true(has_function_privilege('service_role', 'public.platform_usage(date)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.platform_usage(date)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.platform_usage(date)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.platform_usage(date)', 'EXECUTE'), 'grants');
SET ROLE anon;
SELECT pg_temp.assert_fails_with($q$SELECT * FROM platform_usage('2026-06-01')$q$, '42501', 'anon cannot run it');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11200000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_fails_with($q$SELECT * FROM platform_usage('2026-06-01')$q$, '42501', 'a company owner cannot run it');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

ROLLBACK;
SELECT 'platform_usage.sql: all assertions passed' AS result;
