-- ============================================================
-- Migration 087 (knowledge categories + immutable versions): save,
-- edit, restore, immutability, roles, tenant isolation, search.
-- Nothing is committed (ends in ROLLBACK):
--   (echo "BEGIN;"; cat supabase/migrations/087_*.sql supabase/tests/ai_knowledge_versions.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual numeric, expected numeric, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
CREATE FUNCTION pg_temp.assert_fails(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN RETURN;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- tenants: A (ana owner, bia agent) and B (outro owner) -------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('87000000-0000-4000-8000-00000000000a', 'ana@kb.test', '{"full_name":"Ana"}'),
 ('87000000-0000-4000-8000-00000000000b', 'bia@kb.test', '{"full_name":"Bia"}'),
 ('87000000-0000-4000-8000-00000000000c', 'outro@kb.test', '{"full_name":"Outro"}');
CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '87000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '87000000-0000-4000-8000-00000000000c') AS acc_b;
GRANT SELECT ON ids TO authenticated;
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id = '87000000-0000-4000-8000-00000000000b';
CREATE TEMP TABLE st (item uuid);
GRANT SELECT, INSERT, UPDATE ON st TO authenticated;

-- ---- Ana: create, edit, restore ----------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '87000000-0000-4000-8000-00000000000a', true);
INSERT INTO st SELECT public.ai_knowledge_save_item(
  (SELECT acc_a FROM ids), NULL, 'faq', 'Prazo de entrega', 'Qual o prazo de entrega?',
  'Entregamos em até 5 dias úteis.', NULL, ARRAY['Entregamos em até 5 dias úteis.'], '  Entrega  ');
SELECT pg_temp.assert_true((SELECT category = 'Entrega' FROM ai_knowledge_items WHERE id = (SELECT item FROM st)), 'category is trimmed');
SELECT pg_temp.assert_true((SELECT version_no = 1 AND restored_from IS NULL AND category = 'Entrega'
                              AND created_by = '87000000-0000-4000-8000-00000000000a'
                              FROM ai_knowledge_item_versions WHERE item_id = (SELECT item FROM st)), 'create = version 1 by its author');

SELECT public.ai_knowledge_save_item(
  (SELECT acc_a FROM ids), (SELECT item FROM st), 'faq', 'Prazo de entrega', 'Qual o prazo de entrega?',
  'Entregamos em até 3 dias úteis.', NULL, ARRAY['Entregamos em até 3 dias úteis.'], '');
SELECT pg_temp.assert_true((SELECT content LIKE '%3 dias%' AND category IS NULL FROM ai_knowledge_items WHERE id = (SELECT item FROM st)),
                           'edit updates the item; empty category = none');
SELECT pg_temp.assert_eq((SELECT count(*) FROM ai_knowledge_item_versions WHERE item_id = (SELECT item FROM st)), 2, 'edit = version 2');
SELECT pg_temp.assert_true((SELECT content LIKE '%5 dias%' FROM ai_knowledge_item_versions WHERE item_id = (SELECT item FROM st) AND version_no = 1),
                           'version 1 keeps the old text');

-- Search reads the current item only.
SELECT pg_temp.assert_true((SELECT bool_and(content LIKE '%3 dias%') AND count(*) >= 1
                              FROM public.ai_knowledge_search((SELECT acc_a FROM ids), 'prazo de entrega dias', 5)),
                           'search returns the current text, not old versions');

-- Restore version 1 (the app re-chunks it) = version 3, marked restored_from 1.
SELECT public.ai_knowledge_save_item(
  (SELECT acc_a FROM ids), (SELECT item FROM st), v.kind, v.title, v.question, v.content, NULL, ARRAY[v.content], v.category, 1)
  FROM ai_knowledge_item_versions v WHERE v.item_id = (SELECT item FROM st) AND v.version_no = 1;
SELECT pg_temp.assert_true((SELECT version_no = 3 AND restored_from = 1 AND content LIKE '%5 dias%' AND category = 'Entrega'
                              FROM ai_knowledge_item_versions WHERE item_id = (SELECT item FROM st) ORDER BY version_no DESC LIMIT 1),
                           'restore = new version 3 with the old content');
SELECT pg_temp.assert_true((SELECT content LIKE '%5 dias%' FROM ai_knowledge_items WHERE id = (SELECT item FROM st)), 'restore updates the item');

-- History is immutable, even for the owner.
SELECT pg_temp.assert_fails(format('UPDATE ai_knowledge_item_versions SET content = %L WHERE item_id = %L', 'x', (SELECT item FROM st)), 'versions cannot be updated');
SELECT pg_temp.assert_fails(format('DELETE FROM ai_knowledge_item_versions WHERE item_id = %L', (SELECT item FROM st)), 'versions cannot be deleted');
SELECT pg_temp.assert_fails(format('SELECT public.ai_knowledge_save_item(%L, %L, %L, %L, NULL, %L, NULL, ARRAY[%L], %L)',
  (SELECT acc_a FROM ids), (SELECT item FROM st), 'faq', 'T', 'c', 'c', repeat('x', 61)), 'category longer than 60 is rejected');
RESET ROLE;

-- ---- Bia (agent, not admin) --------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '87000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM ai_knowledge_item_versions), 0, 'agents do not read versions');
SELECT pg_temp.assert_fails(format('SELECT public.ai_knowledge_save_item(%L, %L, %L, %L, NULL, %L, NULL, ARRAY[%L])',
  (SELECT acc_a FROM ids), (SELECT item FROM st), 'faq', 'T', 'c', 'c'), 'agents cannot save');
RESET ROLE;

-- ---- Outro (tenant B) ----------------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '87000000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM ai_knowledge_item_versions WHERE item_id = (SELECT item FROM st)), 0, 'tenant B reads nothing of A');
SELECT pg_temp.assert_fails(format(
  'INSERT INTO ai_knowledge_item_versions(item_id, account_id, version_no, kind, title, content) VALUES (%L, %L, 99, %L, %L, %L)',
  (SELECT item FROM st), (SELECT acc_a FROM ids), 'text', 'x', 'x'), 'tenant B cannot write into A');
SELECT pg_temp.assert_fails(format(
  'INSERT INTO ai_knowledge_item_versions(item_id, account_id, version_no, kind, title, content) VALUES (%L, %L, 99, %L, %L, %L)',
  (SELECT item FROM st), (SELECT acc_b FROM ids), 'text', 'x', 'x'), 'tenant B cannot attach a version to A''s item');
SELECT pg_temp.assert_fails(format('SELECT public.ai_knowledge_save_item(%L, %L, %L, %L, NULL, %L, NULL, ARRAY[%L])',
  (SELECT acc_a FROM ids), (SELECT item FROM st), 'faq', 'T', 'c', 'c'), 'tenant B cannot save into A');
RESET ROLE;

-- ---- delete takes the history with it -------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '87000000-0000-4000-8000-00000000000a', true);
DELETE FROM ai_knowledge_items WHERE id = (SELECT item FROM st);
RESET ROLE;
SELECT pg_temp.assert_eq((SELECT count(*) FROM ai_knowledge_item_versions WHERE item_id = (SELECT item FROM st)), 0, 'versions go with the item');

SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated', 'ai_knowledge_item_versions', 'UPDATE'), 'no UPDATE grant');
SELECT pg_temp.assert_true(NOT has_table_privilege('anon', 'ai_knowledge_item_versions', 'SELECT'), 'anon reads nothing');

ROLLBACK;
