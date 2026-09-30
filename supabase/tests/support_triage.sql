-- ============================================================
-- Migration 071 (support triage) — behaviour + RLS smoke test.
--
-- Nothing is committed (ends in ROLLBACK). The local DB is migrated
-- through 067: apply 068-071 in the same transaction:
--   (echo "BEGIN;"; cat supabase/migrations/06[89]_*.sql supabase/migrations/07[01]_*.sql supabase/tests/support_triage.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual bigint, expected bigint, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
-- Runs `stmt` and demands it to fail (any error).
CREATE FUNCTION pg_temp.assert_fails(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN RETURN;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;

INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('71000000-0000-4000-8000-00000000000a', 'owner-a@triage.test', '{"full_name":"Owner A"}'),
 ('71000000-0000-4000-8000-00000000000b', 'owner-b@triage.test', '{"full_name":"Owner B"}'),
 ('71000000-0000-4000-8000-00000000000d', 'agent-a@triage.test', '{"full_name":"Agent A"}');

CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '71000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '71000000-0000-4000-8000-00000000000b') AS acc_b,
       '71000000-0000-4000-8000-0000000000c1'::uuid AS cat_a,
       '71000000-0000-4000-8000-0000000000c2'::uuid AS cat_a2,
       '71000000-0000-4000-8000-0000000000c3'::uuid AS cat_b,
       '71000000-0000-4000-8000-0000000000f1'::uuid AS conv_1,
       '71000000-0000-4000-8000-0000000000f2'::uuid AS conv_2,
       '71000000-0000-4000-8000-0000000000f3'::uuid AS conv_3,
       '71000000-0000-4000-8000-0000000000f4'::uuid AS conv_b;
GRANT SELECT ON ids TO authenticated, service_role;

UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id = '71000000-0000-4000-8000-00000000000d';

INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
 ('71000000-0000-4000-8000-0000000000d1', '71000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511971000001', 'Ana'),
 ('71000000-0000-4000-8000-0000000000d2', '71000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511971000002', 'Bruno'),
 ('71000000-0000-4000-8000-0000000000d3', '71000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511971000003', 'Carla'),
 ('71000000-0000-4000-8000-0000000000d4', '71000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '5511971000004', 'Outro');

-- A closed conversation that predates the trigger is backfilled by the
-- migration itself; here we only exercise the live behaviour.
INSERT INTO conversations(id, user_id, account_id, contact_id, status, last_message_at, last_customer_message_at) VALUES
 ((SELECT conv_1 FROM ids), '71000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '71000000-0000-4000-8000-0000000000d1', 'open', now() - interval '1 hour', now() - interval '1 hour'),
 ((SELECT conv_2 FROM ids), '71000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '71000000-0000-4000-8000-0000000000d2', 'open', now() - interval '2 hour', now() - interval '2 hour'),
 ((SELECT conv_3 FROM ids), '71000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '71000000-0000-4000-8000-0000000000d3', 'open', now() - interval '3 hour', now() - interval '3 hour'),
 ((SELECT conv_b FROM ids), '71000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '71000000-0000-4000-8000-0000000000d4', 'open', now(), now());

-- ---- categories: RLS ------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-00000000000a', true);
INSERT INTO conversation_categories(id, account_id, name, description, color, default_priority) VALUES
 ((SELECT cat_a FROM ids), (SELECT acc_a FROM ids), 'Cobrança', 'Boletos, 2ª via e cobranças indevidas', 'amber', 'high'),
 ((SELECT cat_a2 FROM ids), (SELECT acc_a FROM ids), 'Dúvida', NULL, 'blue', 'normal');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-00000000000b', true);
INSERT INTO conversation_categories(id, account_id, name) VALUES ((SELECT cat_b FROM ids), (SELECT acc_b FROM ids), 'Cobrança');
SELECT pg_temp.assert_eq((SELECT count(*) FROM conversation_categories), 1, 'tenant B sees only its own category');
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_categories(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ids), 'Invasor'), 'tenant B cannot insert into A');
RESET ROLE;

-- Agent: reads, cannot write.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM conversation_categories), 2, 'agent reads A categories');
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_categories(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ids), 'Nova'), 'agent cannot insert a category');
UPDATE conversation_categories SET name = 'Hack' WHERE id = (SELECT cat_a FROM ids);
SELECT pg_temp.assert_true((SELECT name FROM conversation_categories WHERE id = (SELECT cat_a FROM ids)) = 'Cobrança', 'agent cannot rename (0 rows updated by RLS)');
RESET ROLE;

-- CHECKs and uniqueness.
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_categories(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ids), repeat('x', 41)), 'name > 40');
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_categories(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ids), '  '), 'blank name');
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_categories(account_id, name, description) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), 'D', repeat('x', 201)), 'description > 200');
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_categories(account_id, name, color) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), 'C', 'chartreuse'), 'colour outside the palette');
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_categories(account_id, name, default_priority) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), 'P', 'critical'), 'bad default priority');
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_categories(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ids), ' cobrança '), 'duplicate name (case-insensitive, trimmed)');
-- Archived frees the name.
UPDATE conversation_categories SET archived_at = now() WHERE id = (SELECT cat_a2 FROM ids);
INSERT INTO conversation_categories(account_id, name) VALUES ((SELECT acc_a FROM ids), 'DÚVIDA'::text);
SELECT pg_temp.assert_fails(format('UPDATE conversation_categories SET archived_at = NULL WHERE id = %L', (SELECT cat_a2 FROM ids)), 'restoring a name that is taken again');

-- ---- conversations columns ------------------------------------------
SELECT pg_temp.assert_true((SELECT priority = 'normal' AND category_id IS NULL AND resolved_at IS NULL AND resolution IS NULL FROM conversations WHERE id = (SELECT conv_1 FROM ids)), 'defaults');
SELECT pg_temp.assert_fails(format('UPDATE conversations SET priority = %L WHERE id = %L', 'critical', (SELECT conv_1 FROM ids)), 'priority CHECK');
SELECT pg_temp.assert_fails(format('UPDATE conversations SET sentiment = %L WHERE id = %L', 'angry', (SELECT conv_1 FROM ids)), 'sentiment CHECK');
SELECT pg_temp.assert_fails(format('UPDATE conversations SET triage_source = %L WHERE id = %L', 'bot', (SELECT conv_1 FROM ids)), 'triage_source CHECK');
SELECT pg_temp.assert_fails(format('UPDATE conversations SET resolution = %L WHERE id = %L', 'won', (SELECT conv_1 FROM ids)), 'resolution CHECK');
SELECT pg_temp.assert_fails(format('UPDATE conversations SET subject = %L WHERE id = %L', repeat('s', 121), (SELECT conv_1 FROM ids)), 'subject > 120');
UPDATE conversations SET subject = repeat('s', 120), sentiment = 'negative', triage_source = 'ai', triage_at = now() WHERE id = (SELECT conv_1 FROM ids);
-- Another account's category cannot be attached.
SELECT pg_temp.assert_fails(format('UPDATE conversations SET category_id = %L WHERE id = %L', (SELECT cat_b FROM ids), (SELECT conv_1 FROM ids)), 'cross-tenant category');
UPDATE conversations SET category_id = (SELECT cat_a FROM ids) WHERE id = (SELECT conv_1 FROM ids);
-- Deleting the category detaches it.
INSERT INTO conversation_categories(id, account_id, name) VALUES ('71000000-0000-4000-8000-0000000000c9', (SELECT acc_a FROM ids), 'Temporária');
UPDATE conversations SET category_id = '71000000-0000-4000-8000-0000000000c9' WHERE id = (SELECT conv_3 FROM ids);
DELETE FROM conversation_categories WHERE id = '71000000-0000-4000-8000-0000000000c9';
SELECT pg_temp.assert_true((SELECT category_id IS NULL FROM conversations WHERE id = (SELECT conv_3 FROM ids)), 'ON DELETE SET NULL');

-- ---- resolved_at trigger ----------------------------------------------
UPDATE conversations SET status = 'closed' WHERE id = (SELECT conv_2 FROM ids);
SELECT pg_temp.assert_true((SELECT resolved_at IS NOT NULL AND resolution = 'resolved' FROM conversations WHERE id = (SELECT conv_2 FROM ids)), 'closing stamps resolved_at + default resolution');
UPDATE conversations SET status = 'closed', resolution = 'duplicate' WHERE id = (SELECT conv_3 FROM ids);
SELECT pg_temp.assert_true((SELECT resolved_at IS NOT NULL AND resolution = 'duplicate' FROM conversations WHERE id = (SELECT conv_3 FROM ids)), 'closing with an explicit outcome keeps it');
-- resolved_at stays put when the status is re-written without change.
DO $$
DECLARE before_ts timestamptz;
BEGIN
  SELECT resolved_at INTO before_ts FROM conversations WHERE id = (SELECT conv_2 FROM ids);
  PERFORM pg_sleep(0.05);
  UPDATE conversations SET status = 'closed' WHERE id = (SELECT conv_2 FROM ids);
  IF (SELECT resolved_at FROM conversations WHERE id = (SELECT conv_2 FROM ids)) IS DISTINCT FROM before_ts THEN
    RAISE EXCEPTION 'FAIL: resolved_at moved on a no-op status write';
  END IF;
END $$;
-- Reopen clears both.
UPDATE conversations SET status = 'open' WHERE id = (SELECT conv_2 FROM ids);
SELECT pg_temp.assert_true((SELECT resolved_at IS NULL AND resolution IS NULL FROM conversations WHERE id = (SELECT conv_2 FROM ids)), 'reopen clears resolved_at + resolution');
UPDATE conversations SET status = 'pending' WHERE id = (SELECT conv_3 FROM ids);
SELECT pg_temp.assert_true((SELECT resolved_at IS NULL AND resolution IS NULL FROM conversations WHERE id = (SELECT conv_3 FROM ids)), 'pending clears too');
-- Closing again stamps a fresh one.
UPDATE conversations SET status = 'closed' WHERE id = (SELECT conv_3 FROM ids);
SELECT pg_temp.assert_true((SELECT resolved_at IS NOT NULL FROM conversations WHERE id = (SELECT conv_3 FROM ids)), 'second close stamps again');

-- ---- conversation_events: every 070 type + the 3 new ones ----------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assigned','unassigned','status_changed','label_added','label_removed','note_added','contact_opted_out','contact_opted_in','ai_handoff','ai_paused','ai_resumed','deal_stage_changed','category_changed','priority_changed','resolution_set'] LOOP
    INSERT INTO conversation_events(account_id, conversation_id, event_type, payload)
    VALUES ((SELECT acc_a FROM ids), (SELECT conv_1 FROM ids), t, '{}'::jsonb);
  END LOOP;
END $$;
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_events(account_id, conversation_id, event_type) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), (SELECT conv_1 FROM ids), 'sla_breached'), 'unknown event type rejected');

-- ---- ai_settings / ai_usage ---------------------------------------------
INSERT INTO ai_settings(account_id) VALUES ((SELECT acc_a FROM ids)) ON CONFLICT (account_id) DO NOTHING;
SELECT pg_temp.assert_true((SELECT triage_enabled = false FROM ai_settings WHERE account_id = (SELECT acc_a FROM ids)), 'triage_enabled defaults to false');
INSERT INTO ai_usage(account_id, feature, provider, model, status) VALUES ((SELECT acc_a FROM ids), 'triage', 'openai', 'gpt-5-mini', 'ok');
INSERT INTO ai_usage(account_id, feature, provider, model, status) VALUES ((SELECT acc_a FROM ids), 'auto_reply', 'openai', 'gpt-5-mini', 'ok');
SELECT pg_temp.assert_fails(format('INSERT INTO ai_usage(account_id, feature, provider, model, status) VALUES (%L, %L, %L, %L, %L)', (SELECT acc_a FROM ids), 'nope', 'openai', 'gpt-5-mini', 'ok'), 'unknown ai_usage feature');

-- ---- inbox RPCs ---------------------------------------------------------------
-- State now: conv_1 open, category Cobrança, urgent below; conv_2 open; conv_3 closed.
UPDATE conversations SET priority = 'urgent' WHERE id = (SELECT conv_1 FROM ids);
INSERT INTO conversation_categories(id, account_id, name) VALUES ('71000000-0000-4000-8000-0000000000ca', (SELECT acc_a FROM ids), 'Técnico');
UPDATE conversations SET priority = 'low', category_id = '71000000-0000-4000-8000-0000000000ca', subject = 'Erro ao entrar' WHERE id = (SELECT conv_2 FROM ids);

CREATE FUNCTION pg_temp.page_n(cat uuid, prio text, pat text DEFAULT NULL, tab text DEFAULT 'all') RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.inbox_conversation_page(
    p_account_id => (SELECT acc_a FROM ids), p_tab => tab, p_pattern => pat, p_category_id => cat, p_priority => prio)
$$;
CREATE FUNCTION pg_temp.count_of(col text, cat uuid, prio text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  EXECUTE format('SELECT %I FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids), p_category_id => $1, p_priority => $2)', col)
    INTO v USING cat, prio;
  RETURN v;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.page_n(uuid, text, text, text), pg_temp.count_of(text, uuid, text) TO authenticated;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, NULL), 2, 'no filter: 2 live');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all')), 2, 'old-style call still works');
SELECT pg_temp.assert_eq(pg_temp.page_n((SELECT cat_a FROM ids), NULL), 1, 'category filter');
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, 'urgent'), 1, 'priority filter');
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, 'low'), 1, 'priority low');
SELECT pg_temp.assert_eq(pg_temp.page_n((SELECT cat_a FROM ids), 'low'), 0, 'category + priority intersect');
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, NULL, NULL, 'closed'), 1, 'closed tab');
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, 'normal', NULL, 'closed'), 1, 'closed tab + priority');
SELECT pg_temp.assert_eq(pg_temp.count_of('all_count', NULL, NULL), 2, 'counts: none');
SELECT pg_temp.assert_eq(pg_temp.count_of('all_count', (SELECT cat_a FROM ids), NULL), 1, 'counts: category');
SELECT pg_temp.assert_eq(pg_temp.count_of('all_count', NULL, 'urgent'), 1, 'counts: priority');
SELECT pg_temp.assert_eq(pg_temp.count_of('closed_count', NULL, 'urgent'), 0, 'counts: closed respects priority');
SELECT pg_temp.assert_eq(pg_temp.count_of('radar_unassigned', NULL, 'low'), 1, 'radar chip respects priority');
-- Search finds the subject, and keeps the filters.
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, NULL, '%Erro ao entrar%'), 1, 'search by subject');
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, 'urgent', '%Erro ao entrar%'), 0, 'search by subject + priority');
DO $$ BEGIN
  PERFORM count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_priority => 'critical');
  RAISE EXCEPTION 'FAIL: invalid priority accepted';
EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END $$;
-- Tenant isolation.
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq(pg_temp.page_n((SELECT cat_a FROM ids), NULL), 0, 'other tenant: page empty');
SELECT pg_temp.assert_eq(pg_temp.count_of('all_count', (SELECT cat_a FROM ids), NULL), 0, 'other tenant: counts zero');
RESET ROLE;

-- ---- grants DO check (as in the migration) + no stale overloads -------------------
SELECT pg_temp.assert_eq((SELECT count(*) FROM pg_proc WHERE proname IN ('inbox_conversation_page', 'inbox_counts', 'inbox_search_ids')), 3, 'one signature per inbox function');
SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text)', 'EXECUTE'), 'anon cannot execute counts');
SELECT pg_temp.assert_true(has_function_privilege('authenticated', 'public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text)', 'EXECUTE'), 'authenticated can execute page');

-- ---- archive is not a resolution; estimated flag; claim_triage_run -------------
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES ('71000000-0000-4000-8000-0000000000d5', '71000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511971000005', 'Dora');
INSERT INTO conversations(id, user_id, account_id, contact_id, status) VALUES
 ('71000000-0000-4000-8000-0000000000f9', '71000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '71000000-0000-4000-8000-0000000000d5', 'open');
UPDATE conversations SET status = 'closed', archived_at = now() WHERE id = '71000000-0000-4000-8000-0000000000f9';
SELECT pg_temp.assert_true((SELECT resolved_at IS NULL AND resolution IS NULL FROM conversations WHERE id = '71000000-0000-4000-8000-0000000000f9'), 'archiving an open conversation does not stamp a resolution');
SELECT pg_temp.assert_true((SELECT resolved_at_estimated = false FROM conversations WHERE id = (SELECT conv_2 FROM ids)), 'live rows are not estimated');
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_categories(account_id, name, color) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), 'Vermelha', 'red'), 'red left the palette');
SELECT pg_temp.assert_true(NOT public.claim_triage_run((SELECT conv_1 FROM ids)), 'a triage applied within 60 s blocks the claim');
UPDATE conversations SET triage_at = now() - interval '5 minutes' WHERE id = (SELECT conv_1 FROM ids);
INSERT INTO ai_usage(account_id, conversation_id, feature, provider, model, status) VALUES ((SELECT acc_a FROM ids), (SELECT conv_1 FROM ids), 'triage', 'openai', 'gpt-5-mini', 'ok');
SELECT pg_temp.assert_true(NOT public.claim_triage_run((SELECT conv_1 FROM ids)), 'a recent triage usage row blocks the claim');
DELETE FROM ai_usage WHERE conversation_id = (SELECT conv_1 FROM ids);
SELECT pg_temp.assert_true(public.claim_triage_run((SELECT conv_1 FROM ids)), 'first claim wins');
SELECT pg_temp.assert_true(NOT public.claim_triage_run((SELECT conv_1 FROM ids)), 'second claim within 60 s loses');
UPDATE conversations SET triage_claimed_at = now() - interval '2 minutes' WHERE id = (SELECT conv_1 FROM ids);
SELECT pg_temp.assert_true(public.claim_triage_run((SELECT conv_1 FROM ids)), 'third message claim after the gap');
UPDATE conversations SET triage_claimed_at = now() - interval '2 minutes' WHERE id = (SELECT conv_1 FROM ids);
SELECT pg_temp.assert_true(NOT public.claim_triage_run((SELECT conv_1 FROM ids)), 'cost cap: 2 automatic runs max');
SELECT pg_temp.assert_true(NOT has_function_privilege('authenticated', 'public.claim_triage_run(uuid)', 'EXECUTE'), 'claim is server only');

SELECT 'OK support triage smoke' AS result;
ROLLBACK;
