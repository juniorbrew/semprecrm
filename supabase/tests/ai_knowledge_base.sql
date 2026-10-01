-- ============================================================
-- Migration 063 (AI knowledge base) — behaviour + RLS smoke test.
--
-- Run against a database that already has 063 applied, or apply the
-- missing migrations in the same transaction first (nothing is
-- committed — the script ends in ROLLBACK):
--   (echo 'BEGIN;'; cat supabase/migrations/05[4-9]_*.sql supabase/migrations/06[0-3]_*.sql supabase/tests/ai_knowledge_base.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;

INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('63000000-0000-4000-8000-00000000000a', 'owner-a@kb.test', '{"full_name":"Owner A"}'),
 ('63000000-0000-4000-8000-00000000000b', 'owner-b@kb.test', '{"full_name":"Owner B"}'),
 ('63000000-0000-4000-8000-00000000000d', 'agent-a@kb.test', '{"full_name":"Agent A"}'),
 ('63000000-0000-4000-8000-00000000000e', 'viewer-a@kb.test', '{"full_name":"Viewer A"}');

CREATE TEMP TABLE ids AS
SELECT
  (SELECT account_id FROM profiles WHERE user_id = '63000000-0000-4000-8000-00000000000a') AS acc_a,
  (SELECT account_id FROM profiles WHERE user_id = '63000000-0000-4000-8000-00000000000b') AS acc_b;
GRANT SELECT ON ids TO authenticated;

UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id = '63000000-0000-4000-8000-00000000000d';
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'viewer'
 WHERE user_id = '63000000-0000-4000-8000-00000000000e';

-- ---- helpers --------------------------------------------------
SELECT pg_temp.assert_true(ai_kb_norm('Preço AÇÚCAR') = 'preco acucar', 'ai_kb_norm lowers + unaccents');
SELECT pg_temp.assert_true(
  (SELECT provolatile = 'i' FROM pg_proc WHERE proname = 'ai_kb_norm'),
  'ai_kb_norm is immutable');

-- ---- constraints (service path) ------------------------------
DO $$ BEGIN
  INSERT INTO ai_knowledge_items(account_id, kind, title, content) SELECT acc_a, 'video', 't', 'c' FROM ids;
  RAISE EXCEPTION 'unknown kind accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_knowledge_items(account_id, kind, title, content) SELECT acc_a, 'faq', 't', 'c' FROM ids;
  RAISE EXCEPTION 'faq without question accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_knowledge_items(account_id, kind, title, content) SELECT acc_a, 'text', 't', repeat('x', 20001) FROM ids;
  RAISE EXCEPTION 'text over 20k accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;

-- Account B fixture (service path).
INSERT INTO ai_knowledge_items(id, account_id, kind, title, content)
SELECT '63000000-0000-4000-8000-0000000000b1', acc_b, 'text', 'Tabela B', 'SEGREDO B: preço da entrega é R$ 99' FROM ids;
INSERT INTO ai_knowledge_chunks(item_id, account_id, chunk_index, content)
SELECT '63000000-0000-4000-8000-0000000000b1', acc_b, 0, 'SEGREDO B: preço da entrega é R$ 99' FROM ids;

DO $$ BEGIN
  INSERT INTO ai_knowledge_chunks(item_id, account_id, chunk_index, content)
  SELECT '63000000-0000-4000-8000-0000000000b1', acc_a, 1, 'forged' FROM ids;
  RAISE EXCEPTION 'chunk with another account than its item accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;

-- ---- privileges ----------------------------------------------
SELECT pg_temp.assert_true(
  NOT has_table_privilege('anon', 'ai_knowledge_items', 'SELECT')
  AND NOT has_table_privilege('anon', 'ai_knowledge_chunks', 'SELECT')
  AND NOT has_function_privilege('anon', 'public.ai_knowledge_search(uuid, text, integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.ai_knowledge_save_item(uuid, uuid, text, text, text, text, text, text[])', 'EXECUTE'),
  'anon has no access');

-- Service role / no session: search returns nothing (membership check).
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM ai_knowledge_search((SELECT acc_b FROM ids), 'preço entrega', 5)),
  'search without a session returns nothing');

-- ---- admin (owner A) -----------------------------------------
-- 076 closes new functions by default: open this script's pg_temp helpers.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '63000000-0000-4000-8000-00000000000a', true);

CREATE TEMP TABLE a_items(name text, id uuid);
GRANT ALL ON a_items TO authenticated;
INSERT INTO a_items SELECT 'faq', ai_knowledge_save_item((SELECT acc_a FROM ids), NULL, 'faq', 'Frete',
  'Quanto custa a entrega?', 'A entrega custa R$ 10 no centro.',
  NULL, ARRAY['Pergunta: Quanto custa a entrega?' || chr(10) || 'Resposta: A entrega custa R$ 10 no centro.']);
INSERT INTO a_items SELECT 'precos', ai_knowledge_save_item((SELECT acc_a FROM ids), NULL, 'text', 'Tabela de precos',
  NULL, 'Precos: pao frances R$ 1,00; bolo R$ 30.', NULL, ARRAY['Precos: pao frances R$ 1,00; bolo R$ 30.']);
INSERT INTO a_items SELECT 'horario', ai_knowledge_save_item((SELECT acc_a FROM ids), NULL, 'text', 'Horário',
  NULL, 'Abrimos de segunda a sábado, das 7h às 19h. Entregamos só na cidade.', NULL,
  ARRAY['Abrimos de segunda a sábado, das 7h às 19h.', 'Entregamos só na cidade.']);

SELECT pg_temp.assert_true(
  (SELECT count(*) = 3 FROM ai_knowledge_items) AND (SELECT count(*) = 4 FROM ai_knowledge_chunks),
  'admin sees only own items/chunks');
SELECT pg_temp.assert_true(
  (SELECT created_by = '63000000-0000-4000-8000-00000000000a' FROM ai_knowledge_items i JOIN a_items a ON a.id = i.id WHERE a.name = 'faq'),
  'created_by stamped from the session');

-- Accent-insensitive: "preço" finds "Precos" (stemmed + unaccented).
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'qual o preço do bolo?', 5) s
           JOIN a_items a ON a.id = s.item_id WHERE a.name = 'precos'),
  '"preço" finds "Precos"');
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'preços', 5) s
           JOIN a_items a ON a.id = s.item_id WHERE a.name = 'precos'),
  '"preços" finds "Precos"');
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'sabado', 5) s
           JOIN a_items a ON a.id = s.item_id WHERE a.name = 'horario'),
  '"sabado" finds "sábado"');
-- Typo fallback (short query, trigram).
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'entrga', 5)),
  'typo "entrga" still finds something');
-- Ranking: the FAQ about delivery price beats a chunk only about delivery area.
SELECT pg_temp.assert_true(
  (SELECT a.name FROM ai_knowledge_search((SELECT acc_a FROM ids), 'quanto custa a entrega?', 5) s
     JOIN a_items a ON a.id = s.item_id ORDER BY s.rank DESC LIMIT 1) = 'faq',
  'delivery-price FAQ ranks first');
-- Small talk finds nothing (greetings stripped + rank floor).
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'oi, bom dia', 5))
  AND (SELECT count(*) = 0 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'Obrigado! Tudo bem?', 5)),
  'greetings yield no snippets');
SELECT pg_temp.assert_true(
  (SELECT bool_and(rank >= 0.2) FROM ai_knowledge_search((SELECT acc_a FROM ids), 'quanto custa a entrega?', 20)),
  'every hit is above the rank floor');
-- Never another account's rows, even when asking for them.
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'segredo preço entrega', 20) WHERE content LIKE '%SEGREDO B%'),
  'search never returns account B rows');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM ai_knowledge_search((SELECT acc_b FROM ids), 'preço entrega', 5)),
  'search on a foreign account returns nothing');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM ai_knowledge_search((SELECT acc_a FROM ids), '   ', 5)),
  'blank query returns nothing');

-- Disabled items are not searched.
UPDATE ai_knowledge_items SET enabled = false WHERE id = (SELECT id FROM a_items WHERE name = 'precos');
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'preços bolo', 5) s
               JOIN a_items a ON a.id = s.item_id WHERE a.name = 'precos'),
  'disabled item is not searched');

-- Edit replaces chunks atomically.
SELECT ai_knowledge_save_item((SELECT acc_a FROM ids), (SELECT id FROM a_items WHERE name = 'horario'), 'text', 'Horário',
  NULL, 'Abrimos todos os dias.', NULL, ARRAY['Abrimos todos os dias.']);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM ai_knowledge_chunks WHERE item_id = (SELECT id FROM a_items WHERE name = 'horario')),
  'edit replaced the chunks');

-- Admin A cannot write into account B.
DO $$ BEGIN
  PERFORM ai_knowledge_save_item((SELECT acc_b FROM ids), NULL, 'text', 'x', NULL, 'x', NULL, ARRAY['x']);
  RAISE EXCEPTION 'admin A wrote into account B';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_knowledge_items(account_id, kind, title, content) SELECT acc_b, 'text', 'x', 'x' FROM ids;
  RAISE EXCEPTION 'admin A inserted into account B';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DELETE FROM ai_knowledge_items WHERE id = '63000000-0000-4000-8000-0000000000b1';
RESET ROLE;
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM ai_knowledge_items WHERE id = '63000000-0000-4000-8000-0000000000b1'),
  'admin A cannot delete account B items');

-- ---- agent (account A): reads + searches, never writes ---------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '63000000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM ai_knowledge_items), 'agent cannot read items (admin-only)');
SELECT pg_temp.assert_true((SELECT count(*) = 3 FROM ai_knowledge_chunks), 'agent reads own account chunks');
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'quanto custa a entrega', 5)),
  'agent can search (used by Sugerir resposta)');
DO $$ BEGIN
  PERFORM ai_knowledge_save_item((SELECT acc_a FROM ids), NULL, 'text', 'x', NULL, 'x', NULL, ARRAY['x']);
  RAISE EXCEPTION 'agent saved an item';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ai_knowledge_items(account_id, kind, title, content) SELECT acc_a, 'text', 'x', 'x' FROM ids;
  RAISE EXCEPTION 'agent inserted an item';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
UPDATE ai_knowledge_items SET enabled = false;
DELETE FROM ai_knowledge_chunks;
RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT count(*) = 3 FROM ai_knowledge_chunks c JOIN ai_knowledge_items i ON i.id = c.item_id
    WHERE i.account_id = (SELECT acc_a FROM ids))
  AND (SELECT count(*) = 2 FROM ai_knowledge_items WHERE account_id = (SELECT acc_a FROM ids) AND enabled),
  'agent update/delete touched nothing');

-- ---- viewer (account A): nothing at all --------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '63000000-0000-4000-8000-00000000000e', true);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM ai_knowledge_items) AND (SELECT count(*) = 0 FROM ai_knowledge_chunks)
  AND (SELECT count(*) = 0 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'quanto custa a entrega', 5)),
  'viewer reads and searches nothing');
RESET ROLE;

-- ---- owner B sees nothing of A ---------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '63000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM ai_knowledge_items) AND (SELECT count(*) = 1 FROM ai_knowledge_chunks),
  'owner B sees only own rows');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'entrega', 5)),
  'owner B cannot search account A');
RESET ROLE;

-- ---- anon ------------------------------------------------------
SET LOCAL ROLE anon;
DO $$ BEGIN
  PERFORM 1 FROM ai_knowledge_items;
  RAISE EXCEPTION 'anon read items';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

-- ---- usage flag ------------------------------------------------
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_usage' AND column_name = 'kb_used'),
  'ai_usage.kb_used exists');

\echo 'ai_knowledge_base: ALL OK'
ROLLBACK;
