-- ============================================================
-- Migration 079 (conversation snooze) — behaviour + RLS smoke.
--
-- Nothing is committed (ends in ROLLBACK). Base: a local DB migrated
-- through 078; apply 079 in the same transaction:
--   (echo "BEGIN;"; cat supabase/migrations/079_*.sql supabase/tests/conversation_snooze.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- On a DB already at 079 the migration re-applies idempotently.
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual bigint, expected bigint, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
-- The statement must fail with this SQLSTATE.
CREATE FUNCTION pg_temp.assert_state(stmt text, want text, label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN got := SQLSTATE;
  END;
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL: % (sqlstate %, want %)', label, got, want; END IF;
END $$;
-- 076 closes new functions by default: open this script's pg_temp helpers
-- to the roles it switches to.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- fixtures -----------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('79000000-0000-4000-8000-00000000000a', 'owner-a@snooze.test', '{"full_name":"Owner A"}'),
 ('79000000-0000-4000-8000-00000000000b', 'owner-b@snooze.test', '{"full_name":"Owner B"}'),
 ('79000000-0000-4000-8000-00000000000d', 'agent-a@snooze.test', '{"full_name":"Agent A"}'),
 ('79000000-0000-4000-8000-00000000000e', 'agent-a2@snooze.test', '{"full_name":"Agent A2"}'),
 ('79000000-0000-4000-8000-00000000000f', 'viewer-a@snooze.test', '{"full_name":"Viewer A"}');

CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '79000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '79000000-0000-4000-8000-00000000000b') AS acc_b,
       '79000000-0000-4000-8000-00000000000d'::uuid AS agent,
       '79000000-0000-4000-8000-00000000000e'::uuid AS agent2,
       '79000000-0000-4000-8000-00000000000f'::uuid AS viewer,
       '79000000-0000-4000-8000-00000000000b'::uuid AS owner_b;
GRANT SELECT ON ids TO anon, authenticated, service_role;

UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id IN ('79000000-0000-4000-8000-00000000000d', '79000000-0000-4000-8000-00000000000e');
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'viewer'
 WHERE user_id = '79000000-0000-4000-8000-00000000000f';

INSERT INTO contacts(id, user_id, account_id, phone, name)
SELECT ('79000000-0000-4000-8000-0000000000d' || n)::uuid, '79000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '55119790000' || n, 'C' || n
  FROM generate_series(1, 9) n;
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
 ('79000000-0000-4000-8000-0000000000db', '79000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '5511979000099', 'Outro');

-- c1..c9 in A (cN ↔ contact dN); cb in B. All live, customer wrote 1 h ago.
INSERT INTO conversations(id, user_id, account_id, contact_id, status, assigned_agent_id, last_customer_message_at, last_message_at, unread_count, priority)
SELECT ('79000000-0000-4000-8000-0000000000c' || n)::uuid, '79000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids),
       ('79000000-0000-4000-8000-0000000000d' || n)::uuid,
       CASE WHEN n = 3 THEN 'pending' ELSE 'open' END,
       CASE WHEN n IN (2, 9) THEN NULL WHEN n = 4 THEN '79000000-0000-4000-8000-00000000000e'::uuid ELSE '79000000-0000-4000-8000-00000000000d'::uuid END,
       now() - interval '1 hour', now() - interval '1 hour', 3, 'normal'
  FROM generate_series(1, 9) n;
INSERT INTO conversations(id, user_id, account_id, contact_id, status, last_customer_message_at)
VALUES ('79000000-0000-4000-8000-0000000000cb', '79000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '79000000-0000-4000-8000-0000000000db', 'open', now());

CREATE TEMP VIEW conv WITH (security_invoker = true) AS SELECT * FROM conversations WHERE id::text LIKE '79000000-%';
CREATE TEMP VIEW ev WITH (security_invoker = true) AS SELECT * FROM conversation_events WHERE conversation_id::text LIKE '79000000-%' AND event_type IN ('snoozed', 'unsnoozed');
GRANT SELECT ON conv, ev TO authenticated, service_role;

-- ---- 1. an agent snoozes ------------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000d', true);
UPDATE conversations SET snoozed_until = now() + interval '2 hours', snooze_note = 'ligar depois'
 WHERE id = '79000000-0000-4000-8000-0000000000c1';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT snoozed_until = now() + interval '2 hours' AND snoozed_at IS NOT NULL
  AND snoozed_by = (SELECT agent FROM ids) AND snooze_woke_at IS NULL AND unread_count = 0 AND status = 'open'
  FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c1'), 'snooze: stamped, unread zeroed, status kept');
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(event_type = 'snoozed' AND actor_user_id = (SELECT agent FROM ids)
  AND payload->>'note' = 'ligar depois' AND payload ? 'until' AND NOT payload ? 'previous_until')
  FROM ev WHERE conversation_id = '79000000-0000-4000-8000-0000000000c1'), 'snooze: one snoozed event');
-- Changing the time logs previous_until.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000d', true);
UPDATE conversations SET snoozed_until = now() + interval '3 hours' WHERE id = '79000000-0000-4000-8000-0000000000c1';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM ev WHERE conversation_id = '79000000-0000-4000-8000-0000000000c1'
  AND event_type = 'snoozed' AND payload ? 'previous_until'), 1, 'reschedule: event with previous_until');

-- ---- 2. valid / invalid times -----------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_state($$UPDATE conversations SET snoozed_until = now() - interval '1 minute' WHERE id = '79000000-0000-4000-8000-0000000000c3'$$, '22023', 'past time rejected');
SELECT pg_temp.assert_state($$UPDATE conversations SET snoozed_until = now() + interval '30 seconds' WHERE id = '79000000-0000-4000-8000-0000000000c3'$$, '22023', 'under 1 minute rejected');
SELECT pg_temp.assert_state($$UPDATE conversations SET snoozed_until = now() + interval '367 days' WHERE id = '79000000-0000-4000-8000-0000000000c3'$$, '22023', 'over 366 days rejected');
SELECT pg_temp.assert_state($$UPDATE conversations SET snoozed_until = now() + interval '1 hour', snooze_note = repeat('x', 201) WHERE id = '79000000-0000-4000-8000-0000000000c3'$$, '23514', 'note over 200 chars rejected');
UPDATE conversations SET snoozed_until = now() + interval '365 days' WHERE id = '79000000-0000-4000-8000-0000000000c3';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT snoozed_until IS NOT NULL AND status = 'pending' FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c3'), '365 days accepted, pending kept');
-- Dead conversations cannot be snoozed.
UPDATE conversations SET status = 'closed' WHERE id = '79000000-0000-4000-8000-0000000000c8';
SELECT pg_temp.assert_state($$UPDATE conversations SET snoozed_until = now() + interval '1 hour' WHERE id = '79000000-0000-4000-8000-0000000000c8'$$, '23514', 'closed conversation rejected');
UPDATE conversations SET archived_at = now() WHERE id = '79000000-0000-4000-8000-0000000000c8';
SELECT pg_temp.assert_state($$UPDATE conversations SET snoozed_until = now() + interval '1 hour' WHERE id = '79000000-0000-4000-8000-0000000000c8'$$, '23514', 'archived conversation rejected');

-- ---- 3. who can snooze: viewer, other tenant, spoofed insert -------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000f', true);
UPDATE conversations SET snoozed_until = now() + interval '1 hour' WHERE id = '79000000-0000-4000-8000-0000000000c2';
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000b', true);
UPDATE conversations SET snoozed_until = now() + interval '1 hour' WHERE id = '79000000-0000-4000-8000-0000000000c2';
SELECT pg_temp.assert_eq((SELECT count(*) FROM conversations WHERE account_id = (SELECT acc_a FROM ids)), 0, 'tenant B reads nothing of A');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT snoozed_until IS NULL FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c2'), 'viewer and tenant B cannot snooze (RLS: 0 rows)');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000d', true);
INSERT INTO conversations(id, user_id, account_id, contact_id, status, snoozed_until, snoozed_by, snooze_woke_at)
VALUES ('79000000-0000-4000-8000-0000000000ca', '79000000-0000-4000-8000-00000000000d', (SELECT acc_a FROM ids), '79000000-0000-4000-8000-0000000000d9', 'closed',
        now() + interval '1 hour', '79000000-0000-4000-8000-00000000000b', now());
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT snoozed_until IS NULL AND snoozed_by IS NULL AND snooze_woke_at IS NULL FROM conv WHERE id = '79000000-0000-4000-8000-0000000000ca'), 'insert cannot carry a snooze');

-- ---- 4. stamped columns are read-only from outside -------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000d', true);
UPDATE conversations SET snoozed_by = '79000000-0000-4000-8000-00000000000b', snooze_woke_at = now(), snoozed_at = now() - interval '9 days'
 WHERE id = '79000000-0000-4000-8000-0000000000c1';
UPDATE conversations SET snoozed_by = '79000000-0000-4000-8000-00000000000b' WHERE id = '79000000-0000-4000-8000-0000000000c2';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT snoozed_by = (SELECT agent FROM ids) AND snooze_woke_at IS NULL AND snoozed_at > now() - interval '1 minute'
  FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c1'), 'direct writes to stamped columns reverted (snoozed)');
SELECT pg_temp.assert_true((SELECT snoozed_by IS NULL FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c2'), 'direct writes to stamped columns reverted (awake)');

-- ---- 5. messages: only the customer wakes ------------------------------------------
INSERT INTO messages(conversation_id, sender_type, content_text) VALUES
 ('79000000-0000-4000-8000-0000000000c1', 'agent', 'vou verificar'),
 ('79000000-0000-4000-8000-0000000000c1', 'bot', 'fora do expediente');
INSERT INTO messages(conversation_id, sender_type, content_text, origin) VALUES
 ('79000000-0000-4000-8000-0000000000c1', 'customer', '5', 'csat');
SELECT pg_temp.assert_true((SELECT snoozed_until IS NOT NULL FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c1'), 'agent / bot / csat messages keep the snooze');
INSERT INTO messages(conversation_id, sender_type, content_text) VALUES
 ('79000000-0000-4000-8000-0000000000c1', 'customer', 'oi, voltei');
SELECT pg_temp.assert_true((SELECT snoozed_until IS NULL AND snooze_woke_at IS NOT NULL AND snooze_note = 'ligar depois' AND status = 'open'
  FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c1'), 'customer message wakes (note kept)');
SELECT pg_temp.assert_eq((SELECT count(*) FROM ev WHERE conversation_id = '79000000-0000-4000-8000-0000000000c1'
  AND event_type = 'unsnoozed' AND payload->>'cause' = 'customer_reply'), 1, 'customer_reply event');

-- ---- 6. resolve / archive / reassign cancel; team, priority, pending don't ----------
-- Agent A snoozes c2, c4, c5, c6 (c2 unassigned, c4 is Agent A2's).
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000d', true);
UPDATE conversations SET snoozed_until = now() + interval '1 day'
 WHERE id IN ('79000000-0000-4000-8000-0000000000c2', '79000000-0000-4000-8000-0000000000c4',
              '79000000-0000-4000-8000-0000000000c5', '79000000-0000-4000-8000-0000000000c6');
UPDATE conversations SET priority = 'high', status = 'pending' WHERE id = '79000000-0000-4000-8000-0000000000c6';
UPDATE conversations SET status = 'open' WHERE id = '79000000-0000-4000-8000-0000000000c6';
SELECT pg_temp.assert_true((SELECT snoozed_until IS NOT NULL FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c6'), 'priority / pending↔open keep the snooze');
UPDATE conversations SET status = 'closed' WHERE id = '79000000-0000-4000-8000-0000000000c2';
UPDATE conversations SET status = 'closed', archived_at = now() WHERE id = '79000000-0000-4000-8000-0000000000c5';
UPDATE conversations SET assigned_agent_id = (SELECT agent FROM ids) WHERE id = '79000000-0000-4000-8000-0000000000c4';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT bool_and(snoozed_until IS NULL AND snooze_woke_at IS NULL) FROM conv WHERE id IN
  ('79000000-0000-4000-8000-0000000000c2', '79000000-0000-4000-8000-0000000000c4', '79000000-0000-4000-8000-0000000000c5')), 'resolve / archive / reassign cancel');
SELECT pg_temp.assert_true((SELECT status = 'closed' AND archived_at IS NOT NULL FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c5'), 'archive went through');
SELECT pg_temp.assert_true((SELECT string_agg(right(conversation_id::text, 2) || ':' || (payload->>'cause') || ':' || (actor_user_id = (SELECT agent FROM ids)), ',' ORDER BY conversation_id)
  FROM ev WHERE event_type = 'unsnoozed' AND conversation_id IN
  ('79000000-0000-4000-8000-0000000000c2', '79000000-0000-4000-8000-0000000000c4', '79000000-0000-4000-8000-0000000000c5'))
  = 'c2:resolved:true,c4:reassigned:true,c5:resolved:true', 'cancel causes (resolve wins over archive)');
-- Archive alone (archived_at without a status change in the same statement).
UPDATE conversations SET snoozed_until = now() + interval '1 day' WHERE id = '79000000-0000-4000-8000-0000000000c9';
UPDATE conversations SET archived_at = now() WHERE id = '79000000-0000-4000-8000-0000000000c9';
SELECT pg_temp.assert_eq((SELECT count(*) FROM ev WHERE conversation_id = '79000000-0000-4000-8000-0000000000c9'
  AND event_type = 'unsnoozed' AND payload->>'cause' = 'archived'), 1, 'archived cause');
UPDATE conversations SET archived_at = NULL WHERE id = '79000000-0000-4000-8000-0000000000c9';
-- Team change keeps the snooze.
INSERT INTO teams(id, account_id, name) VALUES ('79000000-0000-4000-8000-0000000000e1', (SELECT acc_a FROM ids), 'Suporte');
UPDATE conversations SET team_id = '79000000-0000-4000-8000-0000000000e1' WHERE id = '79000000-0000-4000-8000-0000000000c6';
SELECT pg_temp.assert_true((SELECT snoozed_until IS NOT NULL FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c6'), 'team change keeps the snooze');
-- Manual resume.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000e', true);
UPDATE conversations SET snoozed_until = NULL WHERE id = '79000000-0000-4000-8000-0000000000c3';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT snoozed_until IS NULL AND snooze_woke_at IS NULL AND snoozed_by = (SELECT agent FROM ids) FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c3'), 'manual resume: no marker, snoozed_by kept');
SELECT pg_temp.assert_eq((SELECT count(*) FROM ev WHERE conversation_id = '79000000-0000-4000-8000-0000000000c3' AND event_type = 'unsnoozed'
  AND payload->>'cause' = 'manual' AND actor_user_id = (SELECT agent2 FROM ids)), 1, 'manual event by the resuming agent');

-- ---- 7. wake_due: batching, idempotency, service role only -------------------------------
-- c3 / c7 due in 2 / 3 minutes, c6 in 1 day.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000d', true);
UPDATE conversations SET snoozed_until = now() + interval '2 minutes' WHERE id = '79000000-0000-4000-8000-0000000000c3';
UPDATE conversations SET snoozed_until = now() + interval '3 minutes', snooze_note = 'retorno' WHERE id = '79000000-0000-4000-8000-0000000000c7';
SELECT pg_temp.assert_state($$SELECT * FROM public.conversation_snooze_wake_due(now() + interval '1 hour', 10)$$, '42501', 'authenticated cannot run wake_due');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.assert_state($$SELECT * FROM public.conversation_snooze_wake_due(now() + interval '1 hour', 10)$$, '42501', 'anon cannot run wake_due');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SET ROLE service_role;
CREATE TEMP TABLE woke1 AS SELECT * FROM public.conversation_snooze_wake_due(now() + interval '5 minutes', 1);
CREATE TEMP TABLE woke2 AS SELECT * FROM public.conversation_snooze_wake_due(now() + interval '5 minutes', 500);
CREATE TEMP TABLE woke3 AS SELECT * FROM public.conversation_snooze_wake_due(now() + interval '5 minutes', 500);
RESET ROLE;
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(conversation_id = '79000000-0000-4000-8000-0000000000c3') FROM woke1), 'p_limit respected, earliest first');
SELECT pg_temp.assert_true((SELECT count(*) FILTER (WHERE conversation_id::text LIKE '79000000-%') = 1
  AND bool_and(conversation_id <> '79000000-0000-4000-8000-0000000000c7' OR (snoozed_by = (SELECT agent FROM ids) AND snooze_note = 'retorno' AND assigned_agent_id = (SELECT agent FROM ids) AND account_id = (SELECT acc_a FROM ids)))
  FROM woke2), 'second batch: the rest that is due, with push data');
SELECT pg_temp.assert_eq((SELECT count(*) FROM woke3 WHERE conversation_id::text LIKE '79000000-%'), 0, 'idempotent: nothing left to wake');
SELECT pg_temp.assert_true((SELECT bool_and(snoozed_until IS NULL AND snooze_woke_at IS NOT NULL AND unread_count >= 1 AND status IN ('open', 'pending'))
  FROM conv WHERE id IN ('79000000-0000-4000-8000-0000000000c3', '79000000-0000-4000-8000-0000000000c7')), 'woken: marker + unread');
SELECT pg_temp.assert_true((SELECT snoozed_until IS NOT NULL FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c6'), 'not yet due stays snoozed');
SELECT pg_temp.assert_eq((SELECT count(*) FROM ev WHERE event_type = 'unsnoozed' AND payload->>'cause' = 'timer' AND actor_user_id IS NULL
  AND conversation_id IN ('79000000-0000-4000-8000-0000000000c3', '79000000-0000-4000-8000-0000000000c7')), 2, 'timer events, no actor');
SELECT pg_temp.assert_true(COALESCE(current_setting('app.snooze_wake', true), '') = '', 'wake flag reset after the RPC');

-- ---- 8. privileges + one function per name ----------------------------------------------
SELECT pg_temp.assert_true(NOT has_function_privilege('authenticated', 'public.conversations_snooze_guard()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.conversations_snooze_guard()', 'EXECUTE'), 'guard closed');
SELECT pg_temp.assert_true(has_function_privilege('service_role', 'public.conversation_snooze_wake_due(timestamptz, integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.conversation_snooze_wake_due(timestamptz, integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.conversation_snooze_wake_due(timestamptz, integer)', 'EXECUTE'), 'wake_due: service_role only');
SELECT pg_temp.assert_true(has_function_privilege('authenticated', 'public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean, uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean, uuid)', 'EXECUTE'), 'inbox RPCs: authenticated yes, anon no');
SELECT pg_temp.assert_eq((SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'inbox_counts'), 1, 'one inbox_counts');
SELECT pg_temp.assert_eq((SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'inbox_conversation_page'), 1, 'one inbox_conversation_page');

-- ---- 9. inbox: tabs, counts, facets, cursor -------------------------------------------------
-- State now: snoozed = c6 (Agent A, high, team, +1 day). Snooze c1 (Agent
-- A's) and c9 (unassigned, customer waiting: queue + Radar material).
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000d', true);
UPDATE conversations SET snoozed_until = now() + interval '2 days' WHERE id = '79000000-0000-4000-8000-0000000000c1';
UPDATE conversations SET snoozed_until = now() + interval '3 days' WHERE id = '79000000-0000-4000-8000-0000000000c9';
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all')
  WHERE snoozed_until IS NOT NULL), 0, 'all: no snoozed');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'mine')
  WHERE snoozed_until IS NOT NULL), 0, 'mine: no snoozed');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'queue')
  WHERE id = '79000000-0000-4000-8000-0000000000c9'), 0, 'queue: no snoozed');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_radar => 'unassigned')
  WHERE id = '79000000-0000-4000-8000-0000000000c9'), 0, 'radar filter: no snoozed');
SELECT pg_temp.assert_true((SELECT string_agg(right(id::text, 2), ',' ORDER BY ord) FROM (
  SELECT id, row_number() OVER () AS ord FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'snoozed')) t)
  = (SELECT string_agg(right(id::text, 2), ',' ORDER BY snoozed_until, id) FROM conv WHERE account_id = (SELECT acc_a FROM ids) AND snoozed_until IS NOT NULL),
  'snoozed tab: whole team, next to wake first');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'snoozed')), 3, 'snoozed tab: c1, c6, c9');
-- Cursor: page of 1, then everything after it.
CREATE TEMP TABLE p1 AS SELECT * FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'snoozed', p_limit => 1);
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'snoozed',
  p_cursor_ts => (SELECT snoozed_until FROM p1), p_cursor_id => (SELECT id FROM p1))
  WHERE id <> (SELECT id FROM p1)), 2, 'snoozed cursor: the rest');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'snoozed',
  p_cursor_ts => (SELECT snoozed_until FROM p1), p_cursor_id => (SELECT id FROM p1))
  WHERE id = (SELECT id FROM p1)), 0, 'snoozed cursor: excludes the cursor row');
-- Counts agree with the pages.
CREATE TEMP TABLE cnt AS SELECT * FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids));
SELECT pg_temp.assert_eq((SELECT snoozed_count FROM cnt), 3, 'snoozed_count');
SELECT pg_temp.assert_eq((SELECT all_count FROM cnt), (SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_limit => 1000)), 'all_count = all tab');
SELECT pg_temp.assert_eq((SELECT mine_count FROM cnt), (SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'mine', p_limit => 1000)), 'mine_count = mine tab');
SELECT pg_temp.assert_eq((SELECT queue_count FROM cnt), (SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'queue', p_limit => 1000)), 'queue_count = queue tab');
SELECT pg_temp.assert_eq((SELECT radar_unassigned FROM cnt), (SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_radar => 'unassigned', p_limit => 1000)), 'radar_unassigned = filtered list');
SELECT pg_temp.assert_eq((SELECT radar_waiting FROM cnt), (SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_radar => 'waiting', p_limit => 1000)), 'radar_waiting = filtered list');
-- Facets narrow snoozed_count (c6 is the only high-priority / team one).
SELECT pg_temp.assert_eq((SELECT snoozed_count FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids), p_priority => 'high')), 1, 'snoozed_count respects priority');
SELECT pg_temp.assert_eq((SELECT snoozed_count FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids), p_team_id => '79000000-0000-4000-8000-0000000000e1')), 1, 'snoozed_count respects team');
-- Old-style call (positional, pre-079 args) still works.
SELECT pg_temp.assert_true((SELECT queue_count IS NOT NULL FROM public.inbox_counts((SELECT acc_a FROM ids), 'live', false, NULL, 15, 24)), 'old-style inbox_counts call');
-- Viewer reads the snoozed tab; tenant B sees nothing.
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000f', true);
SELECT pg_temp.assert_eq((SELECT snoozed_count FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids))), 3, 'viewer sees the snoozed count');
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT snoozed_count FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids))), 0, 'tenant B: zero counts for A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'snoozed')), 0, 'tenant B: empty snoozed tab for A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM ev), 0, 'tenant B: no snooze events of A');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- ---- 10. SLA keeps running; snoozing does not touch it ------------------------------------
UPDATE conversations SET status = 'open', archived_at = NULL WHERE id = '79000000-0000-4000-8000-0000000000c5';
UPDATE conversations SET resolution_due_at = now() + interval '5 hours', resolution_warn_at = now() + interval '4 hours'
 WHERE id = '79000000-0000-4000-8000-0000000000c5';
CREATE TEMP TABLE sla_before AS SELECT first_response_due_at, first_response_warn_at, resolution_due_at, resolution_warn_at, sla_breached_at
  FROM conversations WHERE id = '79000000-0000-4000-8000-0000000000c5';
UPDATE conversations SET snoozed_until = now() + interval '1 day' WHERE id = '79000000-0000-4000-8000-0000000000c5';
SELECT pg_temp.assert_true((SELECT (c.first_response_due_at, c.first_response_warn_at, c.resolution_due_at, c.resolution_warn_at, c.sla_breached_at)
  IS NOT DISTINCT FROM (s.first_response_due_at, s.first_response_warn_at, s.resolution_due_at, s.resolution_warn_at, s.sla_breached_at)
  FROM conv c, sla_before s WHERE c.id = '79000000-0000-4000-8000-0000000000c5'), 'snoozing leaves the SLA stamps alone');
-- Breach while snoozed: the event fires, the conversation stays snoozed and out of "Estourados".
UPDATE conversations SET resolution_due_at = now() - interval '1 minute', resolution_warn_at = now() - interval '2 minutes'
 WHERE id = '79000000-0000-4000-8000-0000000000c5';
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.sla_tick(now()) WHERE conversation_id = '79000000-0000-4000-8000-0000000000c5' AND stage = 'breached'), 1, 'sla_tick breaches a snoozed conversation');
SELECT pg_temp.assert_true((SELECT snoozed_until IS NOT NULL AND sla_breached_at IS NOT NULL FROM conv WHERE id = '79000000-0000-4000-8000-0000000000c5'), 'breach does not wake');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '79000000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_true((SELECT radar_sla_breached FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids)))
  = (SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_sla_breached => true)),
  'Estourados chip agrees with the filter');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_sla_breached => true)
  WHERE id = '79000000-0000-4000-8000-0000000000c5'), 0, 'Estourados: no snoozed');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'snoozed', p_sla_breached => true)
  WHERE id = '79000000-0000-4000-8000-0000000000c5'), 1, 'breached snoozed shows in the snoozed tab');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SELECT 'conversation_snooze: all assertions passed' AS result;
ROLLBACK;
