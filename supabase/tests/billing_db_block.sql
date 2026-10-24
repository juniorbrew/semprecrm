-- ============================================================
-- Migration 094 (billing part 3): database-level write block for read-only and
-- blocked accounts. Nothing is committed (ends in ROLLBACK). Needs migrations
-- 001..093 applied. 094 has its own BEGIN/COMMIT, so strip those and run both in
-- ONE transaction (the final ROLLBACK then also undoes 094):
--   (echo 'BEGIN;'; sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' supabase/migrations/094_billing_db_block.sql;
--    cat supabase/tests/billing_db_block.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- If 094 is already applied, run only: (echo 'BEGIN;'; cat supabase/tests/billing_db_block.sql) | psql ...
-- ============================================================
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual numeric, expected numeric, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
-- The statement must be refused with insufficient_privilege (42501): the RLS /
-- guard refusal. Any other error, or success, fails the test.
CREATE FUNCTION pg_temp.denied(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN insufficient_privilege THEN RETURN;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;
-- The statement must run without error.
CREATE FUNCTION pg_temp.ok(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL (refused: %): %', SQLERRM, label;
  END;
END $$;
-- Rows an UPDATE/DELETE touched. A RESTRICTIVE USING hides the rows, so a
-- blocked UPDATE/DELETE is "0 rows", not an error.
CREATE FUNCTION pg_temp.rows(stmt text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN EXECUTE stmt; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---------- fixtures: one owner per account state ----------
-- R trial ended | P past_due | S suspended | C canceled | A active (valid-until in the past: must stay writable) | T trial running
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('94000000-0000-4000-8000-0000000000a1', 'r@block.test', '{"full_name":"R"}'),
 ('94000000-0000-4000-8000-0000000000a2', 'p@block.test', '{"full_name":"P"}'),
 ('94000000-0000-4000-8000-0000000000a3', 's@block.test', '{"full_name":"S"}'),
 ('94000000-0000-4000-8000-0000000000a4', 'c@block.test', '{"full_name":"C"}'),
 ('94000000-0000-4000-8000-0000000000a5', 'a@block.test', '{"full_name":"A"}'),
 ('94000000-0000-4000-8000-0000000000a6', 't@block.test', '{"full_name":"T"}');

CREATE TEMP TABLE t AS
SELECT l.label, l.uid::uuid AS uid, (SELECT account_id FROM profiles WHERE user_id = l.uid::uuid) AS acc,
       NULL::uuid AS contact, NULL::uuid AS conv, NULL::uuid AS pipe, NULL::uuid AS stage,
       NULL::uuid AS deal, NULL::uuid AS task, NULL::uuid AS tag, NULL::uuid AS status
  FROM (VALUES ('R','94000000-0000-4000-8000-0000000000a1'), ('P','94000000-0000-4000-8000-0000000000a2'),
               ('S','94000000-0000-4000-8000-0000000000a3'), ('C','94000000-0000-4000-8000-0000000000a4'),
               ('A','94000000-0000-4000-8000-0000000000a5'), ('T','94000000-0000-4000-8000-0000000000a6')) AS l(label, uid);
GRANT SELECT ON t TO authenticated, service_role;

UPDATE accounts SET plan_status = 'trial',     plan_expires_at = now() - interval '1 day'  WHERE id = (SELECT acc FROM t WHERE label = 'R');
UPDATE accounts SET plan_status = 'past_due',  plan_expires_at = NULL                      WHERE id = (SELECT acc FROM t WHERE label = 'P');
UPDATE accounts SET plan_status = 'suspended', plan_expires_at = NULL                      WHERE id = (SELECT acc FROM t WHERE label = 'S');
UPDATE accounts SET plan_status = 'canceled',  plan_expires_at = NULL                      WHERE id = (SELECT acc FROM t WHERE label = 'C');
UPDATE accounts SET plan_status = 'active',    plan_expires_at = now() - interval '30 days' WHERE id = (SELECT acc FROM t WHERE label = 'A');
UPDATE accounts SET plan_status = 'trial',     plan_expires_at = now() + interval '7 days' WHERE id = (SELECT acc FROM t WHERE label = 'T');

-- Seed CRM data (as the superuser: the fixtures themselves are not under test).
DO $$
DECLARE r record; v_contact uuid; v_conv uuid; v_pipe uuid; v_stage uuid; v_deal uuid; v_status uuid; v_task uuid; v_tag uuid;
BEGIN
  FOR r IN SELECT * FROM t LOOP
    INSERT INTO contacts(user_id, account_id, phone, name) VALUES (r.uid, r.acc, '+55119' || substr(r.uid::text, 36, 1) || '0000001', 'Seed ' || r.label) RETURNING id INTO v_contact;
    INSERT INTO conversations(user_id, account_id, contact_id) VALUES (r.uid, r.acc, v_contact) RETURNING id INTO v_conv;
    INSERT INTO pipelines(user_id, account_id, name) VALUES (r.uid, r.acc, 'Funil ' || r.label) RETURNING id INTO v_pipe;
    INSERT INTO pipeline_stages(pipeline_id, name) VALUES (v_pipe, 'Novo') RETURNING id INTO v_stage;
    INSERT INTO deals(user_id, account_id, pipeline_id, stage_id, contact_id, title) VALUES (r.uid, r.acc, v_pipe, v_stage, v_contact, 'Deal ' || r.label) RETURNING id INTO v_deal;
    SELECT id INTO v_status FROM task_statuses WHERE account_id = r.acc ORDER BY position LIMIT 1;
    IF v_status IS NULL THEN
      INSERT INTO task_statuses(account_id, name, kind, position) VALUES (r.acc, 'A fazer', 'todo', 0) RETURNING id INTO v_status;
    END IF;
    INSERT INTO tasks(account_id, status_id, title) VALUES (r.acc, v_status, 'Tarefa ' || r.label) RETURNING id INTO v_task;
    INSERT INTO tags(user_id, account_id, name) VALUES (r.uid, r.acc, 'Tag ' || r.label) RETURNING id INTO v_tag;
    UPDATE t SET contact = v_contact, conv = v_conv, pipe = v_pipe, stage = v_stage, deal = v_deal, task = v_task, tag = v_tag, status = v_status WHERE label = r.label;
  END LOOP;
  UPDATE conversations SET unread_count = 3;
END $$;

-- ---------- the rule itself (mirrors resolveEntitlements().blocked === false) ----------
SELECT pg_temp.assert_true(NOT public.account_is_writable((SELECT acc FROM t WHERE label = 'R')), 'trial ended: not writable');
SELECT pg_temp.assert_true(NOT public.account_is_writable((SELECT acc FROM t WHERE label = 'P')), 'past_due: not writable');
SELECT pg_temp.assert_true(NOT public.account_is_writable((SELECT acc FROM t WHERE label = 'S')), 'suspended: not writable');
SELECT pg_temp.assert_true(NOT public.account_is_writable((SELECT acc FROM t WHERE label = 'C')), 'canceled: not writable');
SELECT pg_temp.assert_true(public.account_is_writable((SELECT acc FROM t WHERE label = 'A')), 'active with a past valid-until: still writable');
SELECT pg_temp.assert_true(public.account_is_writable((SELECT acc FROM t WHERE label = 'T')), 'trial running: writable');
SELECT pg_temp.assert_true(NOT public.account_is_writable(gen_random_uuid()), 'unknown account: fail closed');
SELECT pg_temp.assert_true(NOT public.account_is_writable(NULL), 'NULL account: fail closed');
-- a running trial with no expiry date is writable (NULL = no expiry)
UPDATE accounts SET plan_expires_at = NULL WHERE id = (SELECT acc FROM t WHERE label = 'T');
SELECT pg_temp.assert_true(public.account_is_writable((SELECT acc FROM t WHERE label = 'T')), 'trial with NULL expiry: writable');
UPDATE accounts SET plan_expires_at = now() + interval '7 days' WHERE id = (SELECT acc FROM t WHERE label = 'T');

SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'public.account_is_writable(uuid)', 'EXECUTE')
                           AND has_function_privilege('authenticated', 'public.account_is_writable(uuid)', 'EXECUTE')
                           AND has_function_privilege('service_role', 'public.account_is_writable(uuid)', 'EXECUTE'),
                           'grants of account_is_writable');

-- ---------- read-only accounts R (trial ended) and P (past due) ----------
-- Same expectations for both; R is the one whose rows are checked afterwards.
DO $$
DECLARE lbl text;
BEGIN
  FOREACH lbl IN ARRAY ARRAY['R', 'P'] LOOP
    PERFORM set_config('test.lbl', lbl, true);
    -- run the block below as the member of that account
    PERFORM set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = lbl), true);
    SET LOCAL ROLE authenticated;

    -- SELECT is never restricted
    PERFORM pg_temp.assert_true((SELECT count(*) FROM contacts) >= 1, lbl || ': can read contacts');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM deals) >= 1, lbl || ': can read deals');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM tasks) >= 1, lbl || ': can read tasks');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM conversations) >= 1, lbl || ': can read conversations');

    -- contacts: INSERT refused, UPDATE refused (guard), consent change still allowed
    PERFORM pg_temp.denied(format($q$INSERT INTO contacts(user_id, account_id, phone) VALUES (%L, %L, '+5511900009999')$q$,
      (SELECT uid FROM t WHERE label = lbl), (SELECT acc FROM t WHERE label = lbl)), lbl || ': insert contact');
    PERFORM pg_temp.denied(format($q$UPDATE contacts SET name = 'Hacked' WHERE id = %L$q$, (SELECT contact FROM t WHERE label = lbl)), lbl || ': update contact name');
    PERFORM pg_temp.ok(format($q$UPDATE contacts SET consent_status = 'revoked', updated_at = now() WHERE id = %L$q$, (SELECT contact FROM t WHERE label = lbl)), lbl || ': LGPD opt-out stays possible');
    PERFORM pg_temp.denied(format($q$UPDATE contacts SET consent_status = 'revoked', name = 'Hacked' WHERE id = %L$q$, (SELECT contact FROM t WHERE label = lbl)), lbl || ': consent + name together');

    -- deals: INSERT refused, UPDATE/DELETE hide the rows (0 affected)
    PERFORM pg_temp.denied(format($q$INSERT INTO deals(user_id, account_id, pipeline_id, stage_id, contact_id, title) VALUES (%L, %L, %L, %L, %L, 'X')$q$,
      (SELECT uid FROM t WHERE label = lbl), (SELECT acc FROM t WHERE label = lbl), (SELECT pipe FROM t WHERE label = lbl),
      (SELECT stage FROM t WHERE label = lbl), (SELECT contact FROM t WHERE label = lbl)), lbl || ': insert deal');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE deals SET title = 'Hacked' WHERE id = %L$q$, (SELECT deal FROM t WHERE label = lbl))), 0, lbl || ': update deal');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$DELETE FROM deals WHERE id = %L$q$, (SELECT deal FROM t WHERE label = lbl))), 0, lbl || ': delete deal');

    -- tasks
    PERFORM pg_temp.denied(format($q$INSERT INTO tasks(account_id, status_id, title) VALUES (%L, %L, 'X')$q$,
      (SELECT acc FROM t WHERE label = lbl), (SELECT status FROM t WHERE label = lbl)), lbl || ': insert task');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE tasks SET title = 'Hacked' WHERE id = %L$q$, (SELECT task FROM t WHERE label = lbl))), 0, lbl || ': update task');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$DELETE FROM tasks WHERE id = %L$q$, (SELECT task FROM t WHERE label = lbl))), 0, lbl || ': delete task');

    -- tags (settings-class, owner can write when active)
    PERFORM pg_temp.denied(format($q$INSERT INTO tags(user_id, account_id, name) VALUES (%L, %L, 'X')$q$,
      (SELECT uid FROM t WHERE label = lbl), (SELECT acc FROM t WHERE label = lbl)), lbl || ': insert tag');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$DELETE FROM tags WHERE id = %L$q$, (SELECT tag FROM t WHERE label = lbl))), 0, lbl || ': delete tag');

    -- derived tables (account found through the parent row)
    PERFORM pg_temp.denied(format($q$INSERT INTO contact_tags(contact_id, tag_id) VALUES (%L, %L)$q$,
      (SELECT contact FROM t WHERE label = lbl), (SELECT tag FROM t WHERE label = lbl)), lbl || ': insert contact_tag');
    PERFORM pg_temp.denied(format($q$INSERT INTO messages(conversation_id, sender_type, content_text) VALUES (%L, 'agent', 'oi')$q$,
      (SELECT conv FROM t WHERE label = lbl)), lbl || ': insert message');
    PERFORM pg_temp.denied(format($q$INSERT INTO pipeline_stages(pipeline_id, name) VALUES (%L, 'X')$q$, (SELECT pipe FROM t WHERE label = lbl)), lbl || ': insert stage');

    -- conversations: only "mark as read" (unread_count) stays possible
    PERFORM pg_temp.denied(format($q$INSERT INTO conversations(user_id, account_id, contact_id) VALUES (%L, %L, %L)$q$,
      (SELECT uid FROM t WHERE label = lbl), (SELECT acc FROM t WHERE label = lbl), (SELECT contact FROM t WHERE label = lbl)), lbl || ': insert conversation');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE conversations SET unread_count = 0 WHERE id = %L$q$, (SELECT conv FROM t WHERE label = lbl))), 1, lbl || ': mark as read works');
    PERFORM pg_temp.denied(format($q$UPDATE conversations SET ai_paused_until = now() + interval '1 hour' WHERE id = %L$q$, (SELECT conv FROM t WHERE label = lbl)), lbl || ': update conversation');
    PERFORM pg_temp.denied(format($q$UPDATE conversations SET unread_count = 0, ai_paused_until = now() + interval '1 hour' WHERE id = %L$q$, (SELECT conv FROM t WHERE label = lbl)), lbl || ': unread + another column together');

    -- must stay writable: profile / preferences, push subscription, account company data
    PERFORM pg_temp.ok(format($q$UPDATE profiles SET notification_prefs = '{"sound":false}'::jsonb WHERE user_id = %L$q$, (SELECT uid FROM t WHERE label = lbl)), lbl || ': profile preferences');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE profiles SET availability = 'away' WHERE user_id = %L$q$, (SELECT uid FROM t WHERE label = lbl))), 1, lbl || ': availability');
    PERFORM pg_temp.ok(format($q$INSERT INTO push_subscriptions(account_id, user_id, endpoint, p256dh, auth) VALUES (%L, %L, 'https://push.example/' || %L, 'k', 'a')$q$,
      (SELECT acc FROM t WHERE label = lbl), (SELECT uid FROM t WHERE label = lbl), lbl), lbl || ': push subscription');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE accounts SET email = 'financeiro@example.com' WHERE id = %L$q$, (SELECT acc FROM t WHERE label = lbl))), 1, lbl || ': company data (to subscribe)');
    -- platform columns stay protected by 076 (still refused, now for the old reason)
    PERFORM pg_temp.denied(format($q$UPDATE accounts SET plan_status = 'active' WHERE id = %L$q$, (SELECT acc FROM t WHERE label = lbl)), lbl || ': cannot self-activate');

    RESET ROLE;
  END LOOP;
END $$;

-- A blocked write left nothing behind (read as the superuser).
SELECT pg_temp.assert_true((SELECT name FROM contacts WHERE id = (SELECT contact FROM t WHERE label = 'R')) = 'Seed R', 'R: contact name untouched');
SELECT pg_temp.assert_true((SELECT title FROM deals WHERE id = (SELECT deal FROM t WHERE label = 'R')) = 'Deal R', 'R: deal untouched');
SELECT pg_temp.assert_true(EXISTS (SELECT 1 FROM tasks WHERE id = (SELECT task FROM t WHERE label = 'R')), 'R: task still there');
SELECT pg_temp.assert_true(EXISTS (SELECT 1 FROM tags WHERE id = (SELECT tag FROM t WHERE label = 'R')), 'R: tag still there');
SELECT pg_temp.assert_true((SELECT ai_paused_until FROM conversations WHERE id = (SELECT conv FROM t WHERE label = 'R')) IS NULL, 'R: conversation untouched');
SELECT pg_temp.assert_true((SELECT consent_status FROM contacts WHERE id = (SELECT contact FROM t WHERE label = 'R')) = 'revoked', 'R: opt-out was saved');
SELECT pg_temp.assert_eq((SELECT unread_count FROM conversations WHERE id = (SELECT conv FROM t WHERE label = 'R')), 0, 'R: mark as read was saved');

-- ---------- fully blocked accounts: suspended (S) and canceled (C) ----------
DO $$
DECLARE lbl text;
BEGIN
  FOREACH lbl IN ARRAY ARRAY['S', 'C'] LOOP
    PERFORM set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = lbl), true);
    SET LOCAL ROLE authenticated;
    PERFORM pg_temp.denied(format($q$INSERT INTO contacts(user_id, account_id, phone) VALUES (%L, %L, '+5511900008888')$q$,
      (SELECT uid FROM t WHERE label = lbl), (SELECT acc FROM t WHERE label = lbl)), lbl || ': insert contact');
    PERFORM pg_temp.denied(format($q$UPDATE contacts SET name = 'Hacked' WHERE id = %L$q$, (SELECT contact FROM t WHERE label = lbl)), lbl || ': update contact');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE deals SET title = 'Hacked' WHERE id = %L$q$, (SELECT deal FROM t WHERE label = lbl))), 0, lbl || ': update deal');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$DELETE FROM tasks WHERE id = %L$q$, (SELECT task FROM t WHERE label = lbl))), 0, lbl || ': delete task');
    PERFORM pg_temp.assert_true((SELECT count(*) FROM contacts) >= 1, lbl || ': SELECT unaffected');
    RESET ROLE;
  END LOOP;
END $$;

-- ---------- writable accounts: A (active, valid-until in the past) and T (running trial) ----------
DO $$
DECLARE lbl text;
BEGIN
  FOREACH lbl IN ARRAY ARRAY['A', 'T'] LOOP
    PERFORM set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = lbl), true);
    SET LOCAL ROLE authenticated;
    PERFORM pg_temp.ok(format($q$INSERT INTO contacts(user_id, account_id, phone) VALUES (%L, %L, '+5511900007777')$q$,
      (SELECT uid FROM t WHERE label = lbl), (SELECT acc FROM t WHERE label = lbl)), lbl || ': insert contact');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE contacts SET name = 'Novo nome' WHERE id = %L$q$, (SELECT contact FROM t WHERE label = lbl))), 1, lbl || ': update contact');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE deals SET title = 'Novo' WHERE id = %L$q$, (SELECT deal FROM t WHERE label = lbl))), 1, lbl || ': update deal');
    PERFORM pg_temp.ok(format($q$INSERT INTO tasks(account_id, status_id, title) VALUES (%L, %L, 'Nova')$q$,
      (SELECT acc FROM t WHERE label = lbl), (SELECT status FROM t WHERE label = lbl)), lbl || ': insert task');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$DELETE FROM tags WHERE id = %L$q$, (SELECT tag FROM t WHERE label = lbl))), 1, lbl || ': delete tag');
    PERFORM pg_temp.ok(format($q$INSERT INTO messages(conversation_id, sender_type, content_text) VALUES (%L, 'agent', 'oi')$q$,
      (SELECT conv FROM t WHERE label = lbl)), lbl || ': insert message');
    PERFORM pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE conversations SET ai_paused_until = now() + interval '1 hour' WHERE id = %L$q$, (SELECT conv FROM t WHERE label = lbl))), 1, lbl || ': close conversation');
    RESET ROLE;
  END LOOP;
END $$;

-- ---------- tenant isolation is unchanged: A's owner cannot touch R's rows ----------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'A'), true);
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE contacts SET name = 'Cross' WHERE id = %L$q$, (SELECT contact FROM t WHERE label = 'R'))), 0, 'cross-tenant update still 0 rows');
RESET ROLE;

-- ---------- a SECURITY DEFINER RPC does not bypass the block (guard uses auth.uid()) ----------
CREATE FUNCTION pg_temp.definer_add_agent(p_account uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  INSERT INTO public.ai_agents(account_id, name, instructions) VALUES (p_account, 'via rpc', 'x')
$$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'R'), true);
SELECT pg_temp.denied(format($q$SELECT pg_temp.definer_add_agent(%L)$q$, (SELECT acc FROM t WHERE label = 'R')), 'definer RPC: read-only account');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'A'), true);
SELECT pg_temp.ok(format($q$SELECT pg_temp.definer_add_agent(%L)$q$, (SELECT acc FROM t WHERE label = 'A')), 'definer RPC: active account');
RESET ROLE;

-- ---------- the server (service role) is not affected ----------
SET ROLE service_role;
SELECT pg_temp.ok(format($q$INSERT INTO contacts(user_id, account_id, phone) VALUES (%L, %L, '+5511900006666')$q$,
  (SELECT uid FROM t WHERE label = 'R'), (SELECT acc FROM t WHERE label = 'R')), 'service role writes to a read-only account (inbound, crons)');
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE conversations SET ai_paused_until = now() + interval '1 hour' WHERE id = %L$q$, (SELECT conv FROM t WHERE label = 'R'))), 1, 'service role updates a conversation of a read-only account');
SELECT pg_temp.ok(format($q$INSERT INTO messages(conversation_id, sender_type, content_text) VALUES (%L, 'customer', 'oi')$q$, (SELECT conv FROM t WHERE label = 'R')), 'service role inserts an inbound message');
RESET ROLE;

-- ---------- back to writable: paying lifts the block at once ----------
UPDATE accounts SET plan_status = 'active', plan_expires_at = now() + interval '30 days' WHERE id = (SELECT acc FROM t WHERE label = 'R');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'R'), true);
SELECT pg_temp.ok(format($q$INSERT INTO contacts(user_id, account_id, phone) VALUES (%L, %L, '+5511900005555')$q$,
  (SELECT uid FROM t WHERE label = 'R'), (SELECT acc FROM t WHERE label = 'R')), 'R after paying: insert contact');
RESET ROLE;

ROLLBACK;
