-- ============================================================
-- Migration 105 (manager alerts) — behaviour + privilege smoke.
--
-- Nothing is committed (ends in ROLLBACK). Base: a local DB migrated
-- through 104; apply 105 in the same transaction:
--   (echo "BEGIN;"; cat supabase/migrations/105_*.sql supabase/tests/manager_alerts.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- On a DB already at 105 the migration re-applies idempotently.
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual bigint, expected bigint, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
CREATE FUNCTION pg_temp.assert_state(stmt text, want text, label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN got := SQLSTATE;
  END;
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL: % (sqlstate %, want %)', label, got, want; END IF;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- Only this script's rows count (the local DB has demo data).
CREATE TEMP TABLE due_rows (conversation_id uuid, account_id uuid, contact_id uuid, assigned_agent_id uuid, kind text, wait_started_at timestamptz);
CREATE FUNCTION pg_temp.tick(p_now timestamptz, p_lim integer DEFAULT 500) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  DELETE FROM due_rows;
  INSERT INTO due_rows SELECT * FROM public.manager_alerts_due(p_now, p_lim) d WHERE d.conversation_id::text LIKE '10500000-%';
  SELECT count(*) INTO n FROM due_rows;
  RETURN n;
END $$;

-- ---- fixtures -----------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('10500000-0000-4000-8000-00000000000a', 'owner-a@alerts.test', '{"full_name":"Owner A"}'),
 ('10500000-0000-4000-8000-00000000000b', 'owner-b@alerts.test', '{"full_name":"Owner B"}'),
 ('10500000-0000-4000-8000-00000000000d', 'agent-a@alerts.test', '{"full_name":"Agent A"}');

CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '10500000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '10500000-0000-4000-8000-00000000000b') AS acc_b,
       '10500000-0000-4000-8000-00000000000d'::uuid AS agent,
       now() AS t0;
GRANT SELECT ON ids TO anon, authenticated, service_role;

UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id = '10500000-0000-4000-8000-00000000000d';
-- Account A: reply target 10 min, unassigned alert 3 min. Owner A wants both.
UPDATE accounts SET preferences = COALESCE(preferences, '{}'::jsonb) || '{"inbox_sla_minutes":10,"unassigned_alert_minutes":3}'
 WHERE id = (SELECT acc_a FROM ids);
UPDATE profiles SET notification_prefs = '{"manager_waiting":true,"manager_unassigned":true}'
 WHERE user_id = '10500000-0000-4000-8000-00000000000a';
-- The agent's prefs never count (not a manager).
UPDATE profiles SET notification_prefs = '{"manager_waiting":true,"manager_unassigned":true}'
 WHERE user_id = '10500000-0000-4000-8000-00000000000d';

INSERT INTO contacts(id, user_id, account_id, phone, name)
SELECT ('10500000-0000-4000-8000-0000000000d' || n)::uuid, '10500000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '55119105000' || n, 'C' || n
  FROM generate_series(1, 6) n;
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
 ('10500000-0000-4000-8000-0000000000db', '10500000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '5511910500099', 'B');

-- c1 assigned, customer waiting 12 min          → waiting
-- c2 unassigned, waiting 4 min                  → unassigned only (4 < 10)
-- c3 assigned, agent replied after the customer → nothing
-- c4 closed, waiting 30 min                     → nothing
-- c5 unassigned, waiting 3 days                 → nothing (stale)
-- c6 assigned, waiting 12 min but snoozed       → nothing
-- cb account B, waiting 30 min, nobody opted in → nothing
INSERT INTO conversations(id, user_id, account_id, contact_id, status, assigned_agent_id, last_customer_message_at, last_agent_message_at)
SELECT ('10500000-0000-4000-8000-0000000000c' || n)::uuid, '10500000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids),
       ('10500000-0000-4000-8000-0000000000d' || n)::uuid,
       CASE WHEN n = 4 THEN 'closed' ELSE 'open' END,
       CASE WHEN n IN (2, 5) THEN NULL ELSE (SELECT agent FROM ids) END,
       (SELECT t0 FROM ids) - CASE n WHEN 1 THEN interval '12 min' WHEN 2 THEN interval '4 min' WHEN 3 THEN interval '20 min'
                                    WHEN 4 THEN interval '30 min' WHEN 5 THEN interval '3 days' ELSE interval '12 min' END,
       CASE WHEN n = 3 THEN (SELECT t0 FROM ids) - interval '5 min' END
  FROM generate_series(1, 6) n;
-- Snoozing goes through the 079 guard: done by the assigned agent.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10500000-0000-4000-8000-00000000000d', true);
UPDATE conversations SET snoozed_until = (SELECT t0 FROM ids) + interval '1 hour'
 WHERE id = '10500000-0000-4000-8000-0000000000c6';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT snoozed_until IS NOT NULL FROM conversations
  WHERE id = '10500000-0000-4000-8000-0000000000c6'), 'fixture: c6 snoozed');
INSERT INTO conversations(id, user_id, account_id, contact_id, status, last_customer_message_at)
VALUES ('10500000-0000-4000-8000-0000000000cb', '10500000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids),
        '10500000-0000-4000-8000-0000000000db', 'open', (SELECT t0 FROM ids) - interval '30 min');

-- c1's wait started with an earlier unanswered message (15 min ago) after
-- an old agent reply: the wait is measured from the first one.
INSERT INTO messages(conversation_id, sender_type, content_text, created_at) VALUES
 ('10500000-0000-4000-8000-0000000000c1', 'agent', 'oi', (SELECT t0 FROM ids) - interval '1 hour'),
 ('10500000-0000-4000-8000-0000000000c1', 'customer', 'primeira', (SELECT t0 FROM ids) - interval '15 min'),
 ('10500000-0000-4000-8000-0000000000c1', 'customer', 'segunda', (SELECT t0 FROM ids) - interval '12 min');
-- The trigger moved the per-side stamps; pin them back to the scenario.
UPDATE conversations SET last_customer_message_at = (SELECT t0 FROM ids) - interval '12 min',
                         last_agent_message_at = (SELECT t0 FROM ids) - interval '1 hour'
 WHERE id = '10500000-0000-4000-8000-0000000000c1';

-- ---- 1. first tick ------------------------------------------------------
-- One claim per call: the already-claimed oldest wait (c1) must not take the
-- only slot of the next call and starve c2.
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids), 1), 1, 'limit 1: first claim');
SELECT pg_temp.assert_true((SELECT conversation_id = '10500000-0000-4000-8000-0000000000c1' FROM due_rows), 'limit 1: oldest first');
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids), 1), 1, 'limit 1: next call reaches the newer wait');
SELECT pg_temp.assert_true((SELECT conversation_id = '10500000-0000-4000-8000-0000000000c2' FROM due_rows), 'limit 1: c2 not starved');
DELETE FROM conversation_alerts WHERE conversation_id::text LIKE '10500000-%';
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids)), 2, 'tick 1: two alerts');
SELECT pg_temp.assert_true((SELECT kind = 'waiting' AND wait_started_at = (SELECT t0 FROM ids) - interval '15 min'
  AND assigned_agent_id = (SELECT agent FROM ids) AND contact_id = '10500000-0000-4000-8000-0000000000d1'
  FROM due_rows WHERE conversation_id = '10500000-0000-4000-8000-0000000000c1'), 'c1: waiting, measured from the first unanswered message');
SELECT pg_temp.assert_true((SELECT kind = 'unassigned' AND assigned_agent_id IS NULL
  FROM due_rows WHERE conversation_id = '10500000-0000-4000-8000-0000000000c2'), 'c2: unassigned only');

-- ---- 2. same wait is never pushed twice --------------------------------
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids) + interval '1 min'), 0, 'tick 2: nothing new');
-- c2 keeps waiting past the reply target: already pushed as "nobody
-- assigned" for this same wait, so no second push.
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids) + interval '7 min'), 0, 'tick 3: c2 is not pushed twice');

-- ---- 3. a reply ends the wait; a new customer message starts a new one ---
INSERT INTO messages(conversation_id, sender_type, content_text, created_at) VALUES
 ('10500000-0000-4000-8000-0000000000c1', 'agent', 'respondido', (SELECT t0 FROM ids) + interval '8 min'),
 ('10500000-0000-4000-8000-0000000000c1', 'customer', 'de novo', (SELECT t0 FROM ids) + interval '9 min');
UPDATE conversations SET last_agent_message_at = (SELECT t0 FROM ids) + interval '8 min',
                         last_customer_message_at = (SELECT t0 FROM ids) + interval '9 min'
 WHERE id = '10500000-0000-4000-8000-0000000000c1';
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids) + interval '15 min'), 0, 'new wait: not due before the target');
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids) + interval '20 min'), 1, 'new wait: due after the target');
SELECT pg_temp.assert_true((SELECT wait_started_at = (SELECT t0 FROM ids) + interval '9 min'
  FROM due_rows WHERE conversation_id = '10500000-0000-4000-8000-0000000000c1'), 'new wait anchored on the new message');

-- ---- 4. nobody opted in → nothing ---------------------------------------
UPDATE profiles SET notification_prefs = '{}' WHERE user_id = '10500000-0000-4000-8000-00000000000a';
INSERT INTO messages(conversation_id, sender_type, content_text, created_at) VALUES
 ('10500000-0000-4000-8000-0000000000c2', 'agent', 'ok', (SELECT t0 FROM ids) + interval '21 min'),
 ('10500000-0000-4000-8000-0000000000c2', 'customer', 'oi', (SELECT t0 FROM ids) + interval '22 min');
UPDATE conversations SET last_agent_message_at = (SELECT t0 FROM ids) + interval '21 min',
                         last_customer_message_at = (SELECT t0 FROM ids) + interval '22 min'
 WHERE id = '10500000-0000-4000-8000-0000000000c2';
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids) + interval '1 hour'), 0, 'opted out: nothing');

-- ---- 5. malformed settings never break the scan --------------------------
UPDATE profiles SET notification_prefs = '{"manager_waiting":"yes","manager_unassigned":1}'
 WHERE user_id = '10500000-0000-4000-8000-00000000000a';
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids) + interval '2 hours'), 0, 'non-boolean prefs read as off');
UPDATE profiles SET notification_prefs = '{"manager_waiting":true}'
 WHERE user_id = '10500000-0000-4000-8000-00000000000a';
UPDATE accounts SET preferences = preferences || '{"inbox_sla_minutes":1e30,"unassigned_alert_minutes":-5}'
 WHERE id = (SELECT acc_a FROM ids);
-- 1e30 is clamped to 1440 min: c2 (waiting since t0+22min) is not due yet at t0+2h.
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids) + interval '2 hours'), 0, 'huge minutes clamped, no overflow');
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids) + interval '24 hours'), 0, 'clamped to a day: not before');
SELECT pg_temp.assert_eq(pg_temp.tick((SELECT t0 FROM ids) + interval '24 hours 30 min'), 1, 'clamped to a day: due after');

-- ---- 6. privileges ------------------------------------------------------
SET ROLE authenticated;
SELECT pg_temp.assert_state('SELECT * FROM public.manager_alerts_due(now(), 10)', '42501', 'authenticated cannot run the RPC');
SELECT pg_temp.assert_state('SELECT * FROM public.conversation_alerts', '42501', 'authenticated cannot read the table');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.assert_state('SELECT * FROM public.manager_alerts_due(now(), 10)', '42501', 'anon cannot run the RPC');
RESET ROLE;

\echo 'manager_alerts: all assertions passed'
ROLLBACK;
