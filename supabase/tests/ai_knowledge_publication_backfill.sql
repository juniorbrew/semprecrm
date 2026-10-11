-- Run inside BEGIN; substitute APPLY_MIGRATION_088 with migration 088.
-- A transaction reconstructs the legacy shape and rolls everything back.
ALTER TABLE ai_knowledge_items DROP COLUMN published_version;
ALTER TABLE ai_knowledge_items DROP COLUMN latest_version;
ALTER TABLE ai_knowledge_items DROP COLUMN published_at;
ALTER TABLE ai_knowledge_items DROP COLUMN published_by;
DROP POLICY ai_knowledge_chunks_select ON ai_knowledge_chunks;
DELETE FROM ai_knowledge_chunks WHERE published;
DROP INDEX uq_ai_knowledge_chunks_item_index;
ALTER TABLE ai_knowledge_chunks DROP COLUMN published;
CREATE UNIQUE INDEX uq_ai_knowledge_chunks_item_index ON ai_knowledge_chunks(item_id, chunk_index);
CREATE POLICY ai_knowledge_chunks_select ON ai_knowledge_chunks FOR SELECT USING (is_account_member(account_id,'agent'));
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 ('88000000-0000-4000-8000-00000000000a','legacy-kb@example.test','{"full_name":"Legacy KB"}');
CREATE TEMP TABLE legacy_account AS SELECT account_id FROM profiles WHERE user_id='88000000-0000-4000-8000-00000000000a';
INSERT INTO ai_knowledge_items(id,account_id,kind,title,content,enabled) SELECT
 '88000000-0000-4000-8000-000000000001',account_id,'text','Current title','Prazo entrega cinco dias',TRUE FROM legacy_account;
INSERT INTO ai_knowledge_item_versions(item_id,account_id,version_no,kind,title,content) SELECT
 '88000000-0000-4000-8000-000000000001',account_id,1,'text','Stale title','Outdated answer' FROM legacy_account;
INSERT INTO ai_knowledge_items(id,account_id,kind,title,content,enabled) SELECT
 '88000000-0000-4000-8000-000000000002',account_id,'text','Disabled title','Prazo entrega dez dias',FALSE FROM legacy_account;
INSERT INTO ai_knowledge_items(id,account_id,kind,title,content) SELECT
 '88000000-0000-4000-8000-000000000003',account_id,'text','No chunks','Missing chunks' FROM legacy_account;
INSERT INTO ai_knowledge_chunks(item_id,account_id,chunk_index,content) SELECT id,account_id,0,content FROM ai_knowledge_items
 WHERE id IN ('88000000-0000-4000-8000-000000000001','88000000-0000-4000-8000-000000000002');
-- APPLY_MIGRATION_088
CREATE FUNCTION pg_temp.assert_true(ok boolean,label text) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $$;
SELECT pg_temp.assert_true((SELECT latest_version=2 AND published_version=2 AND published_by IS NULL
 FROM ai_knowledge_items WHERE id='88000000-0000-4000-8000-000000000001'),'legacy drift snapshots actual item without inventing publisher');
SELECT pg_temp.assert_true((SELECT count(*)=2 FROM ai_knowledge_item_versions WHERE item_id='88000000-0000-4000-8000-000000000001'),'old history preserved');
SELECT pg_temp.assert_true((SELECT count(*)=1 AND bool_and(content='Prazo entrega cinco dias' AND title='Current title')
 FROM ai_knowledge_search_service((SELECT account_id FROM legacy_account),'prazo entrega',5)),'legacy live content unchanged; disabled content remains excluded');
SELECT pg_temp.assert_true((SELECT latest_version=1 AND published_version IS NULL AND published_at IS NULL
 FROM ai_knowledge_items WHERE id='88000000-0000-4000-8000-000000000003'),'missing chunks remain unpublished');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'PASS: legacy backfill, drift snapshot, disabled items, missing history and missing chunks';
ROLLBACK;
