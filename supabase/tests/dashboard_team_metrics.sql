-- ============================================================
-- Migration 085 (dashboard_team_metrics) — the counting rules that
-- used to run in the browser (and were unit-tested there), RLS and
-- grants. Nothing is committed (ends in ROLLBACK):
--   (echo "BEGIN;"; cat supabase/migrations/085_*.sql supabase/tests/dashboard_team_metrics.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual numeric, expected numeric, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- tenants: A (ana owner, bia agent) and B (other) -----------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('85000000-0000-4000-8000-00000000000a', 'ana@team.test', '{"full_name":"Ana"}'),
 ('85000000-0000-4000-8000-00000000000b', 'bia@team.test', '{"full_name":"Bia"}'),
 ('85000000-0000-4000-8000-00000000000c', 'other@team.test', '{"full_name":"Other"}');
CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '85000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '85000000-0000-4000-8000-00000000000c') AS acc_b,
       '85000000-0000-4000-8000-00000000000a'::uuid AS ana,
       '85000000-0000-4000-8000-00000000000b'::uuid AS bia,
       '85000000-0000-4000-8000-00000000000c'::uuid AS other;
GRANT SELECT ON ids TO authenticated;
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent' WHERE user_id = (SELECT bia FROM ids);

-- Conversations k1..k12 in A (one contact each), k99 in B.
INSERT INTO contacts(id, user_id, account_id, phone, name)
SELECT ('85000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid, (SELECT ana FROM ids), (SELECT acc_a FROM ids),
       '551198500' || lpad(n::text, 4, '0'), 'K' || n
  FROM generate_series(1, 12) n;
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
 ('85000000-0000-4000-8000-000000000199', (SELECT other FROM ids), (SELECT acc_b FROM ids), '5511985009999', 'B');
INSERT INTO conversations(id, user_id, account_id, contact_id, status)
SELECT ('85000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid, (SELECT ana FROM ids), (SELECT acc_a FROM ids),
       ('85000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid, 'closed'
  FROM generate_series(1, 12) n;
INSERT INTO conversations(id, user_id, account_id, contact_id, status) VALUES
 ('85000000-0000-4000-8000-000000000299', (SELECT other FROM ids), (SELECT acc_b FROM ids), '85000000-0000-4000-8000-000000000199', 'open');
CREATE TEMP TABLE k AS SELECT n, ('85000000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid AS id FROM generate_series(1, 12) n;
GRANT SELECT ON k TO authenticated;

-- handled: ana in k1 (twice) and k2, bia in k2, no sender in k3; ana in k4
-- before the period; ana's message in B does not count for A.
INSERT INTO messages(conversation_id, sender_type, sender_id, content_type, content_text, created_at) VALUES
 ((SELECT id FROM k WHERE n = 1), 'agent', (SELECT ana FROM ids), 'text', 'x', now() - interval '1 day'),
 ((SELECT id FROM k WHERE n = 1), 'agent', (SELECT ana FROM ids), 'text', 'x', now() - interval '1 day'),
 ((SELECT id FROM k WHERE n = 2), 'agent', (SELECT ana FROM ids), 'text', 'x', now() - interval '1 day'),
 ((SELECT id FROM k WHERE n = 2), 'agent', (SELECT bia FROM ids), 'text', 'x', now() - interval '1 day'),
 ((SELECT id FROM k WHERE n = 3), 'agent', NULL, 'text', 'x', now() - interval '1 day'),
 ((SELECT id FROM k WHERE n = 4), 'agent', (SELECT ana FROM ids), 'text', 'x', now() - interval '40 days'),
 ((SELECT id FROM k WHERE n = 1), 'customer', NULL, 'text', 'x', now() - interval '1 day'),
 ('85000000-0000-4000-8000-000000000299', 'agent', (SELECT ana FROM ids), 'text', 'x', now() - interval '1 day');

-- first responses set by hand (the message trigger fills them too):
-- ana 60, 120, 600 (+ a null and a negative that are ignored), bia 30, 90,
-- one without a responder, one of ana's before the period.
UPDATE conversations SET first_response_at = NULL, first_response_seconds = NULL, first_response_by = NULL
 WHERE account_id IN ((SELECT acc_a FROM ids), (SELECT acc_b FROM ids));
UPDATE conversations c SET first_response_at = now() - interval '2 days', first_response_by = w.who, first_response_seconds = v.secs
  FROM (VALUES (1, 'ana', 60), (2, 'ana', 120), (3, 'ana', 600), (4, 'ana', NULL), (5, 'ana', -5),
               (6, 'bia', 30), (7, 'bia', 90), (8, NULL, 5)) AS v(n, who_name, secs)
  CROSS JOIN LATERAL (SELECT CASE v.who_name WHEN 'ana' THEN (SELECT ana FROM ids) WHEN 'bia' THEN (SELECT bia FROM ids) END AS who) w(who)
  JOIN k ON k.n = v.n
 WHERE c.id = k.id;
UPDATE conversations SET first_response_at = now() - interval '40 days', first_response_by = (SELECT ana FROM ids), first_response_seconds = 9999
 WHERE id = (SELECT id FROM k WHERE n = 9);

-- resolved: ana closed x2, ana reopened, bia to pending, a close without
-- actor, an old close by bia.
INSERT INTO conversation_events(account_id, conversation_id, event_type, actor_user_id, payload, created_at) VALUES
 ((SELECT acc_a FROM ids), (SELECT id FROM k WHERE n = 1), 'status_changed', (SELECT ana FROM ids), '{"status":"closed"}', now() - interval '1 day'),
 ((SELECT acc_a FROM ids), (SELECT id FROM k WHERE n = 2), 'status_changed', (SELECT ana FROM ids), '{"status":"closed"}', now() - interval '1 day'),
 ((SELECT acc_a FROM ids), (SELECT id FROM k WHERE n = 2), 'status_changed', (SELECT ana FROM ids), '{"status":"open"}', now() - interval '1 day'),
 ((SELECT acc_a FROM ids), (SELECT id FROM k WHERE n = 3), 'status_changed', (SELECT bia FROM ids), '{"status":"pending"}', now() - interval '1 day'),
 ((SELECT acc_a FROM ids), (SELECT id FROM k WHERE n = 3), 'status_changed', NULL, '{"status":"closed"}', now() - interval '1 day'),
 ((SELECT acc_a FROM ids), (SELECT id FROM k WHERE n = 4), 'status_changed', (SELECT bia FROM ids), '{"status":"closed"}', now() - interval '40 days');

-- open assignments right now: bia x3 (any age), ana's closed one does not count.
UPDATE conversations SET status = 'open', assigned_agent_id = (SELECT bia FROM ids) WHERE id IN (SELECT id FROM k WHERE n IN (10, 11, 12));
UPDATE conversations SET status = 'closed', assigned_agent_id = (SELECT ana FROM ids) WHERE id = (SELECT id FROM k WHERE n = 9);

-- tasks: ana completed 2 in the period, 1 before; one without assignee; one open.
INSERT INTO task_statuses(id, account_id, name, position, kind) VALUES
 ('85000000-0000-4000-8000-000000000401', (SELECT acc_a FROM ids), 'Feito', 0, 'done'),
 ('85000000-0000-4000-8000-000000000402', (SELECT acc_a FROM ids), 'A fazer', 1, 'open');
INSERT INTO tasks(account_id, created_by, assignee_user_id, title, completed_at, status_id)
SELECT acc, cb, au, tt, ca,
       CASE WHEN ca IS NULL THEN '85000000-0000-4000-8000-000000000402' ELSE '85000000-0000-4000-8000-000000000401' END::uuid
  FROM (VALUES
 ((SELECT acc_a FROM ids), (SELECT ana FROM ids), (SELECT ana FROM ids), 't1', now() - interval '1 day'),
 ((SELECT acc_a FROM ids), (SELECT ana FROM ids), (SELECT ana FROM ids), 't2', now() - interval '2 days'),
 ((SELECT acc_a FROM ids), (SELECT ana FROM ids), (SELECT ana FROM ids), 't3', now() - interval '40 days'),
 ((SELECT acc_a FROM ids), (SELECT ana FROM ids), NULL, 't4', now() - interval '1 day'),
 ((SELECT acc_a FROM ids), (SELECT ana FROM ids), (SELECT bia FROM ids), 't5', NULL::timestamptz)) AS v(acc, cb, au, tt, ca);

-- ---- as Ana (member of A) -----------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '85000000-0000-4000-8000-00000000000a', true);
CREATE TEMP TABLE r AS SELECT * FROM public.dashboard_team_metrics((SELECT acc_a FROM ids), now() - interval '29 days');
SELECT pg_temp.assert_eq((SELECT handled FROM r WHERE user_id = (SELECT ana FROM ids)), 2, 'handled: distinct conversations (k1 twice = 1), period and account only');
SELECT pg_temp.assert_eq((SELECT handled FROM r WHERE user_id = (SELECT bia FROM ids)), 1, 'handled: bia in k2');
SELECT pg_temp.assert_eq((SELECT resolved FROM r WHERE user_id = (SELECT ana FROM ids)), 2, 'resolved: only status_changed to closed, by actor');
SELECT pg_temp.assert_eq((SELECT resolved FROM r WHERE user_id = (SELECT bia FROM ids)), 0, 'resolved: pending and old closes do not count');
SELECT pg_temp.assert_true((SELECT first_response_avg_seconds = 260 AND first_response_median_seconds = 120 AND first_response_samples = 3
                              FROM r WHERE user_id = (SELECT ana FROM ids)), 'first response: ana mean 260, median 120, 3 samples (null, negative, old ignored)');
SELECT pg_temp.assert_true((SELECT first_response_avg_seconds = 60 AND first_response_median_seconds = 60 AND first_response_samples = 2
                              FROM r WHERE user_id = (SELECT bia FROM ids)), 'first response: bia mean 60, median of two = 60');
SELECT pg_temp.assert_eq((SELECT tasks_completed FROM r WHERE user_id = (SELECT ana FROM ids)), 2, 'tasks: completed in the period by assignee');
SELECT pg_temp.assert_eq((SELECT tasks_completed FROM r WHERE user_id = (SELECT bia FROM ids)), 0, 'tasks: open task does not count');
SELECT pg_temp.assert_eq((SELECT open_assigned FROM r WHERE user_id = (SELECT bia FROM ids)), 3, 'open assignments right now');
SELECT pg_temp.assert_eq((SELECT open_assigned FROM r WHERE user_id = (SELECT ana FROM ids)), 0, 'closed assignment does not count');
SELECT pg_temp.assert_eq((SELECT count(*) FROM r WHERE user_id IS NULL), 0, 'no row without a user');
RESET ROLE;

-- ---- B cannot read A's numbers, even passing A's id -----------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '85000000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.dashboard_team_metrics((SELECT acc_a FROM ids), now() - interval '29 days')), 0, 'RLS: tenant B sees nothing of A');
RESET ROLE;

SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'public.dashboard_team_metrics(uuid, timestamptz)', 'EXECUTE'), 'anon cannot call');
SELECT pg_temp.assert_true(has_function_privilege('authenticated', 'public.dashboard_team_metrics(uuid, timestamptz)', 'EXECUTE'), 'authenticated can call');

ROLLBACK;
