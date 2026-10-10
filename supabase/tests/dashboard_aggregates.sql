-- ============================================================
-- Migration 084 (dashboard aggregates) — results, local-day
-- bucketing, response-time pairing, RLS. Expected values follow the
-- client loops that 084 replaces (src/lib/dashboard/queries.ts).
--
-- Nothing is committed (ends in ROLLBACK):
--   (echo "BEGIN;"; cat supabase/migrations/084_*.sql supabase/tests/dashboard_aggregates.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual numeric, expected numeric, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- tenants -----------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('84000000-0000-4000-8000-00000000000a', 'owner-a@dash.test', '{"full_name":"Owner A"}'),
 ('84000000-0000-4000-8000-00000000000b', 'owner-b@dash.test', '{"full_name":"Owner B"}');
CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '84000000-0000-4000-8000-00000000000a') AS acc_a,
       '84000000-0000-4000-8000-00000000000a'::uuid AS user_a;
GRANT SELECT ON ids TO authenticated;

INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
 ('84000000-0000-4000-8000-000000000101', (SELECT user_a FROM ids), (SELECT acc_a FROM ids), '5511984000001', 'X'),
 ('84000000-0000-4000-8000-000000000102', (SELECT user_a FROM ids), (SELECT acc_a FROM ids), '5511984000002', 'Y');
INSERT INTO conversations(id, user_id, account_id, contact_id, status) VALUES
 ('84000000-0000-4000-8000-000000000201', (SELECT user_a FROM ids), (SELECT acc_a FROM ids), '84000000-0000-4000-8000-000000000101', 'open'),
 ('84000000-0000-4000-8000-000000000202', (SELECT user_a FROM ids), (SELECT acc_a FROM ids), '84000000-0000-4000-8000-000000000102', 'open');

-- Times in São Paulo (UTC-3). Window starts 2026-03-01 00:00 local.
-- X: c0 is before the window, so a0 answers nothing.
--    c1+c2 wait, a1 answers (20 min, Monday); a2 answers nothing.
--    c3 Tue 23:30 local (Wed in UTC), b1 answers (40 min, Tuesday local).
--    c4 is never answered.
-- Y: c5 → a3 (10 min, Monday).
INSERT INTO messages(conversation_id, sender_type, content_type, content_text, created_at) VALUES
 ('84000000-0000-4000-8000-000000000201', 'customer', 'text', 'c0', '2026-02-28 23:00-03'),
 ('84000000-0000-4000-8000-000000000201', 'agent',    'text', 'a0', '2026-03-01 00:30-03'),
 ('84000000-0000-4000-8000-000000000201', 'customer', 'text', 'c1', '2026-03-02 10:00-03'),
 ('84000000-0000-4000-8000-000000000201', 'customer', 'text', 'c2', '2026-03-02 10:05-03'),
 ('84000000-0000-4000-8000-000000000201', 'agent',    'text', 'a1', '2026-03-02 10:20-03'),
 ('84000000-0000-4000-8000-000000000201', 'agent',    'text', 'a2', '2026-03-02 10:30-03'),
 ('84000000-0000-4000-8000-000000000201', 'customer', 'text', 'c3', '2026-03-03 23:30-03'),
 ('84000000-0000-4000-8000-000000000201', 'bot',      'text', 'b1', '2026-03-04 00:10-03'),
 ('84000000-0000-4000-8000-000000000201', 'customer', 'text', 'c4', '2026-03-05 09:00-03'),
 ('84000000-0000-4000-8000-000000000202', 'customer', 'text', 'c5', '2026-03-02 11:00-03'),
 ('84000000-0000-4000-8000-000000000202', 'agent',    'text', 'a3', '2026-03-02 11:10-03');

INSERT INTO pipelines(id, user_id, account_id, name) VALUES
 ('84000000-0000-4000-8000-000000000301', (SELECT user_a FROM ids), (SELECT acc_a FROM ids), 'Vendas');
INSERT INTO pipeline_stages(id, pipeline_id, name, position) VALUES
 ('84000000-0000-4000-8000-000000000311', '84000000-0000-4000-8000-000000000301', 'Novo', 0),
 ('84000000-0000-4000-8000-000000000312', '84000000-0000-4000-8000-000000000301', 'Proposta', 1);
INSERT INTO deals(user_id, account_id, pipeline_id, stage_id, title, value, status) VALUES
 ((SELECT user_a FROM ids), (SELECT acc_a FROM ids), '84000000-0000-4000-8000-000000000301', '84000000-0000-4000-8000-000000000311', 'd1', 100, 'open'),
 ((SELECT user_a FROM ids), (SELECT acc_a FROM ids), '84000000-0000-4000-8000-000000000301', '84000000-0000-4000-8000-000000000311', 'd2', 50.5, 'open'),
 ((SELECT user_a FROM ids), (SELECT acc_a FROM ids), '84000000-0000-4000-8000-000000000301', '84000000-0000-4000-8000-000000000312', 'd3', 10, 'open'),
 ((SELECT user_a FROM ids), (SELECT acc_a FROM ids), '84000000-0000-4000-8000-000000000301', '84000000-0000-4000-8000-000000000311', 'won', 999, 'won');

-- ---- tenant A ---------------------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '84000000-0000-4000-8000-00000000000a', true);

CREATE TEMP TABLE s_sp AS SELECT * FROM public.dashboard_message_series('2026-03-01 00:00-03', 'America/Sao_Paulo');
SELECT pg_temp.assert_eq((SELECT outgoing FROM s_sp WHERE day = '2026-03-01'), 1, 'series: a0 on Mar 1 (window start)');
SELECT pg_temp.assert_true((SELECT incoming = 3 AND outgoing = 3 FROM s_sp WHERE day = '2026-03-02'), 'series: Mar 2 = 3 in / 3 out');
SELECT pg_temp.assert_true((SELECT incoming = 1 AND outgoing = 0 FROM s_sp WHERE day = '2026-03-03'), 'series: c3 is Mar 3 in São Paulo');
SELECT pg_temp.assert_true((SELECT incoming = 0 AND outgoing = 1 FROM s_sp WHERE day = '2026-03-04'), 'series: bot counts as outgoing');
SELECT pg_temp.assert_eq((SELECT sum(incoming + outgoing) FROM s_sp), 10, 'series: c0 before the window is left out');

CREATE TEMP TABLE s_utc AS SELECT * FROM public.dashboard_message_series('2026-03-01 00:00-03', 'UTC');
SELECT pg_temp.assert_true((SELECT incoming = 1 AND outgoing = 1 FROM s_utc WHERE day = '2026-03-04'), 'series: the zone moves c3 to Mar 4 in UTC');
SELECT pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM s_utc WHERE day = '2026-03-03'), 'series: no Mar 3 in UTC');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.dashboard_message_series('2026-03-01 00:00-03', 'Not/AZone') x
                           JOIN s_utc u USING (day, incoming, outgoing)), (SELECT count(*) FROM s_utc), 'series: unknown zone = UTC');

CREATE TEMP TABLE rt AS SELECT public.dashboard_response_time('2026-03-01 00:00-03', 'America/Sao_Paulo', '2026-03-03 00:00-03', '2026-02-24 00:00-03') AS j;
SELECT pg_temp.assert_eq((SELECT jsonb_array_length(j->'buckets') FROM rt), 2, 'rt: Monday and Tuesday buckets only');
SELECT pg_temp.assert_true((SELECT (b->>'sum_minutes')::numeric = 30 AND (b->>'samples')::numeric = 2 FROM rt, jsonb_array_elements(j->'buckets') b WHERE b->>'dow' = '0'), 'rt: Monday 20 + 10 min (c1 waits from 10:00, not c2)');
SELECT pg_temp.assert_true((SELECT (b->>'sum_minutes')::numeric = 40 AND (b->>'samples')::numeric = 1 FROM rt, jsonb_array_elements(j->'buckets') b WHERE b->>'dow' = '1'), 'rt: c3 is Tuesday local, 40 min');
SELECT pg_temp.assert_true((SELECT (j->'this_week'->>'sum_minutes')::numeric = 40 AND (j->'this_week'->>'samples')::numeric = 1 FROM rt), 'rt: this week');
SELECT pg_temp.assert_true((SELECT (j->'last_week'->>'sum_minutes')::numeric = 30 AND (j->'last_week'->>'samples')::numeric = 2 FROM rt), 'rt: last week');

CREATE TEMP TABLE dl AS SELECT * FROM public.dashboard_open_deals_by_stage();
SELECT pg_temp.assert_true((SELECT deal_count = 2 AND total_value = 150.5 FROM dl WHERE stage_id = '84000000-0000-4000-8000-000000000311'), 'deals: open only (won left out)');
SELECT pg_temp.assert_true((SELECT deal_count = 1 AND total_value = 10 FROM dl WHERE stage_id = '84000000-0000-4000-8000-000000000312'), 'deals: second stage');
RESET ROLE;

-- ---- tenant B sees nothing of A ------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '84000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.dashboard_message_series('2026-03-01 00:00-03', 'UTC')), 0, 'RLS: series');
SELECT pg_temp.assert_eq((SELECT jsonb_array_length(public.dashboard_response_time('2026-03-01 00:00-03', 'UTC', '2026-03-03', '2026-02-24')->'buckets')), 0, 'RLS: response time');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.dashboard_open_deals_by_stage()), 0, 'RLS: deals');
RESET ROLE;

-- ---- grants -----------------------------------------------------------------
SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'public.dashboard_message_series(timestamptz, text)', 'EXECUTE'), 'anon cannot call');
SELECT pg_temp.assert_true(has_function_privilege('authenticated', 'public.dashboard_response_time(timestamptz, text, timestamptz, timestamptz)', 'EXECUTE'), 'authenticated can call');

ROLLBACK;
