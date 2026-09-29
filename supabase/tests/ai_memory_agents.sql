-- ============================================================
-- Migration 064 (contact memory + AI agents) — behaviour + RLS smoke test.
--
-- Run against a database that already has 064 applied, or apply the
-- missing migrations in the same transaction first (nothing is
-- committed — the script ends in ROLLBACK):
--   (echo 'BEGIN;'; cat supabase/migrations/05[4-9]_*.sql supabase/migrations/06[0-4]_*.sql supabase/tests/ai_memory_agents.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;

INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('64000000-0000-4000-8000-00000000000a', 'owner-a@mem.test', '{"full_name":"Owner A"}'),
 ('64000000-0000-4000-8000-00000000000b', 'owner-b@mem.test', '{"full_name":"Owner B"}'),
 ('64000000-0000-4000-8000-00000000000d', 'agent-a@mem.test', '{"full_name":"Agent A"}'),
 ('64000000-0000-4000-8000-00000000000e', 'viewer-a@mem.test', '{"full_name":"Viewer A"}');

CREATE TEMP TABLE ids AS
SELECT
  (SELECT account_id FROM profiles WHERE user_id = '64000000-0000-4000-8000-00000000000a') AS acc_a,
  (SELECT account_id FROM profiles WHERE user_id = '64000000-0000-4000-8000-00000000000b') AS acc_b,
  '64000000-0000-4000-8000-0000000000c1'::uuid AS contact_a,
  '64000000-0000-4000-8000-0000000000c2'::uuid AS contact_b,
  '64000000-0000-4000-8000-0000000000f1'::uuid AS conv_a,
  '64000000-0000-4000-8000-0000000000f2'::uuid AS conv_b;
GRANT SELECT ON ids TO authenticated;

UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id = '64000000-0000-4000-8000-00000000000d';
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'viewer'
 WHERE user_id = '64000000-0000-4000-8000-00000000000e';

INSERT INTO contacts(id, user_id, account_id, phone, name)
SELECT contact_a, '64000000-0000-4000-8000-00000000000a'::uuid, acc_a, '5511900000001', 'Maria' FROM ids
UNION ALL
SELECT contact_b, '64000000-0000-4000-8000-00000000000b', acc_b, '5511900000002', 'Zoe' FROM ids;
INSERT INTO conversations(id, user_id, account_id, contact_id)
SELECT conv_a, '64000000-0000-4000-8000-00000000000a'::uuid, acc_a, contact_a FROM ids
UNION ALL
SELECT conv_b, '64000000-0000-4000-8000-00000000000b', acc_b, contact_b FROM ids;

-- ---- constraints (service path) ------------------------------
DO $$ BEGIN
  INSERT INTO ai_contact_memories(account_id, contact_id, fact) SELECT acc_a, contact_a, repeat('x', 301) FROM ids;
  RAISE EXCEPTION 'fact over 300 chars accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_contact_memories(account_id, contact_id, fact, status) SELECT acc_a, contact_a, 'x', 'maybe' FROM ids;
  RAISE EXCEPTION 'unknown status accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_agents(account_id, name, instructions, channels) SELECT acc_a, 'X', 'y', ARRAY['sms'] FROM ids;
  RAISE EXCEPTION 'unknown channel accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_usage(account_id, feature, provider, model, status) SELECT acc_a, 'chat', 'openai', 'm', 'ok' FROM ids;
  RAISE EXCEPTION 'unknown ai_usage feature accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
INSERT INTO ai_usage(account_id, feature, provider, model, status)
SELECT acc_a, f, 'openai', 'gpt-4.1-mini', 'ok' FROM ids, unnest(ARRAY['memory_extract', 'agent_test']) f;

-- Account B fixtures.
INSERT INTO ai_contact_memories(account_id, contact_id, fact, status, source)
SELECT acc_b, contact_b, 'SEGREDO B: cliente VIP', 'active', 'manual' FROM ids;
INSERT INTO ai_agents(account_id, name, instructions, is_default)
SELECT acc_b, 'Agente B', 'SEGREDO B', true FROM ids;

-- ---- privileges ----------------------------------------------
SELECT pg_temp.assert_true(
  NOT has_table_privilege('anon', 'ai_contact_memories', 'SELECT')
  AND NOT has_table_privilege('anon', 'ai_agents', 'SELECT'),
  'anon has no access');

-- ---- agent A: memories -----------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '64000000-0000-4000-8000-00000000000d', true);

INSERT INTO ai_contact_memories(account_id, contact_id, fact, status, source, conversation_id, created_by)
SELECT acc_a, contact_a, 'Prefere entrega à tarde', 'proposed', 'ai', conv_a, '64000000-0000-4000-8000-00000000000d' FROM ids;
UPDATE ai_contact_memories SET status = 'active', approved_by = '64000000-0000-4000-8000-00000000000d'
 WHERE fact = 'Prefere entrega à tarde';
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM ai_contact_memories), 'agent sees only own account memories');

DO $$ BEGIN
  INSERT INTO ai_contact_memories(account_id, contact_id, fact) SELECT acc_b, contact_b, 'forged' FROM ids;
  RAISE EXCEPTION 'agent wrote into account B';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_contact_memories(account_id, contact_id, fact) SELECT acc_a, contact_b, 'forged' FROM ids;
  RAISE EXCEPTION 'agent pinned a fact on a foreign contact';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_contact_memories(account_id, contact_id, fact, conversation_id) SELECT acc_a, contact_a, 'forged', conv_b FROM ids;
  RAISE EXCEPTION 'agent linked a foreign conversation';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
-- Moving an own row to another account is refused by WITH CHECK.
DO $$ BEGIN
  UPDATE ai_contact_memories SET account_id = (SELECT acc_b FROM ids) WHERE fact = 'Prefere entrega à tarde';
  RAISE EXCEPTION 'agent moved a memory to account B';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
UPDATE ai_contact_memories SET fact = 'hijack' WHERE fact LIKE 'SEGREDO B%';
DELETE FROM ai_contact_memories WHERE fact LIKE 'SEGREDO B%';

-- ---- agent A: agents (read yes, write no) ------------------------
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM ai_agents), 'agent does not see account B agents');
DO $$ BEGIN
  INSERT INTO ai_agents(account_id, name, instructions) SELECT acc_a, 'X', 'y' FROM ids;
  RAISE EXCEPTION 'agent created an AI agent';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT fact = 'SEGREDO B: cliente VIP' FROM ai_contact_memories WHERE account_id = (SELECT acc_b FROM ids)),
  'account B memory untouched by agent A');

-- ---- viewer A: read only ----------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '64000000-0000-4000-8000-00000000000e', true);
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM ai_contact_memories), 'viewer reads memories');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM ai_agents), 'viewer does not read agents');
DO $$ BEGIN
  INSERT INTO ai_contact_memories(account_id, contact_id, fact) SELECT acc_a, contact_a, 'viewer fact' FROM ids;
  RAISE EXCEPTION 'viewer wrote a memory';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
UPDATE ai_contact_memories SET status = 'rejected';
DELETE FROM ai_contact_memories;
RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM ai_contact_memories WHERE account_id = (SELECT acc_a FROM ids) AND status = 'active'),
  'viewer update/delete had no effect');

-- ---- owner A: agents + default uniqueness -------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '64000000-0000-4000-8000-00000000000a', true);
INSERT INTO ai_agents(account_id, name, instructions, is_default, channels)
SELECT acc_a, 'Vendas', 'Foque em vendas', true, ARRAY['official'] FROM ids;
INSERT INTO ai_agents(account_id, name, instructions) SELECT acc_a, 'Suporte', 'Foque em suporte' FROM ids;
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM ai_agents), 'owner sees only own agents');
DO $$ BEGIN
  UPDATE ai_agents SET is_default = true WHERE name = 'Suporte';
  RAISE EXCEPTION 'second default agent accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
-- Swapping the default: clear, then set.
UPDATE ai_agents SET is_default = false WHERE is_default AND name <> 'Suporte';
UPDATE ai_agents SET is_default = true WHERE name = 'Suporte';
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM ai_agents WHERE is_default) AND (SELECT is_default FROM ai_agents WHERE name = 'Suporte'),
  'default swapped');
UPDATE ai_agents SET instructions = 'hijack' WHERE name = 'Agente B';
DO $$ BEGIN
  INSERT INTO ai_agents(account_id, name, instructions) SELECT acc_b, 'X', 'y' FROM ids;
  RAISE EXCEPTION 'owner A created an agent in account B';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DELETE FROM ai_agents WHERE name = 'Vendas';
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM ai_agents), 'owner deletes own agent');
RESET ROLE;

SELECT pg_temp.assert_true(
  (SELECT instructions = 'SEGREDO B' AND is_default FROM ai_agents WHERE account_id = (SELECT acc_b FROM ids)),
  'account B agent untouched; one default per account (A and B each have one)');

-- ---- cascade: deleting the contact removes its memories -----------
DELETE FROM contacts WHERE id = (SELECT contact_a FROM ids);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM ai_contact_memories WHERE account_id = (SELECT acc_a FROM ids)),
  'memories cascade with the contact');

\echo 'ai_memory_agents: ALL OK'
ROLLBACK;
