-- 088: drafts stay isolated from the published knowledge used by AI.
-- Existing content is published unchanged; future saves/restores are drafts.
-- Apply after backup. Prefer a code rollback retaining this schema and
-- disabling knowledge edits until the publication UI is restored. A full
-- schema rollback must first restore the approved snapshot/chunks as live
-- content, retain drafts in version history, then restore the old functions,
-- grants/index and drop publication columns. Never expose a pending draft.

-- The shared membership guard must also ignore caller-controlled temp tables.
ALTER FUNCTION public.is_account_member(UUID, public.account_role_enum) SET search_path = public, pg_temp;

ALTER TABLE ai_knowledge_items ADD COLUMN latest_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ai_knowledge_items ADD COLUMN published_version INTEGER;
ALTER TABLE ai_knowledge_items ADD COLUMN published_at TIMESTAMPTZ;
ALTER TABLE ai_knowledge_items ADD COLUMN published_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE ai_knowledge_items ADD CONSTRAINT ai_knowledge_publication_version_check
  CHECK (published_version IS NULL OR (published_version > 0 AND published_version <= latest_version));
ALTER TABLE ai_knowledge_chunks ADD COLUMN published BOOLEAN NOT NULL DEFAULT FALSE;
DROP INDEX uq_ai_knowledge_chunks_item_index;
CREATE UNIQUE INDEX uq_ai_knowledge_chunks_item_index
  ON ai_knowledge_chunks(item_id, published, chunk_index);

-- Snapshot the actual legacy item, including direct edits made before versioning.
INSERT INTO ai_knowledge_item_versions
  (item_id, account_id, version_no, kind, title, question, content, category, source_filename)
SELECT i.id, i.account_id, coalesce(v.version_no, 0) + 1,
  i.kind, i.title, i.question, i.content, i.category, i.source_filename
FROM ai_knowledge_items i
LEFT JOIN LATERAL (SELECT * FROM ai_knowledge_item_versions WHERE item_id = i.id ORDER BY version_no DESC LIMIT 1) v ON TRUE
WHERE v.id IS NULL OR ROW(i.kind,i.title,i.question,i.content,i.category,i.source_filename)
  IS DISTINCT FROM ROW(v.kind,v.title,v.question,v.content,v.category,v.source_filename);

UPDATE ai_knowledge_items i SET latest_version = v.version_no,
  published_version = CASE WHEN EXISTS (SELECT 1 FROM ai_knowledge_chunks c WHERE c.item_id = i.id) THEN v.version_no END,
  published_at = CASE WHEN EXISTS (SELECT 1 FROM ai_knowledge_chunks c WHERE c.item_id = i.id) THEN NOW() END,
  published_by = NULL
FROM (SELECT item_id, max(version_no) AS version_no FROM ai_knowledge_item_versions GROUP BY item_id) v
WHERE v.item_id = i.id;
ALTER TABLE ai_knowledge_items ADD CONSTRAINT ai_knowledge_latest_version_fk
  FOREIGN KEY (id, latest_version) REFERENCES ai_knowledge_item_versions(item_id, version_no)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE ai_knowledge_items ADD CONSTRAINT ai_knowledge_published_version_fk
  FOREIGN KEY (id, published_version) REFERENCES ai_knowledge_item_versions(item_id, version_no)
  DEFERRABLE INITIALLY DEFERRED;

-- Abort legacy drift rather than silently approving text absent from the item.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM ai_knowledge_chunks c JOIN ai_knowledge_items i ON i.id = c.item_id
    WHERE strpos(regexp_replace(i.content, '\s+', ' ', 'g'),
      regexp_replace(CASE WHEN i.kind = 'faq' AND left(c.content, char_length('Pergunta: ' || i.question || E'\nResposta: ')) = 'Pergunta: ' || i.question || E'\nResposta: '
        THEN substr(c.content, char_length('Pergunta: ' || i.question || E'\nResposta: ') + 1)
        ELSE c.content END, '\s+', ' ', 'g')) = 0
  ) THEN RAISE EXCEPTION 'Legacy knowledge chunks differ from their items; reconcile before migration'; END IF;
END $$;

INSERT INTO ai_knowledge_chunks(item_id, account_id, chunk_index, content, published)
SELECT item_id, account_id, chunk_index, content, TRUE FROM ai_knowledge_chunks;

DROP POLICY ai_knowledge_chunks_select ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_select ON ai_knowledge_chunks FOR SELECT
  USING (is_account_member(account_id, 'admin') OR (published AND is_account_member(account_id, 'agent')));

-- Only the save/publish RPCs can mutate content or publication metadata.
REVOKE INSERT, UPDATE ON ai_knowledge_items FROM authenticated;
GRANT UPDATE(enabled) ON ai_knowledge_items TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON ai_knowledge_chunks FROM authenticated;

CREATE OR REPLACE FUNCTION public.ai_knowledge_record_version(p_item_id UUID, p_restored_from INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account UUID;
  v_next    INTEGER;
BEGIN
  SELECT account_id INTO v_account FROM ai_knowledge_items WHERE id = p_item_id FOR UPDATE;
  IF v_account IS NULL OR NOT is_account_member(v_account, 'admin') THEN
    RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_restored_from IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ai_knowledge_item_versions WHERE item_id = p_item_id AND version_no = p_restored_from
  ) THEN
    RAISE EXCEPTION 'Unknown version' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(max(version_no), 0) + 1 INTO v_next
    FROM ai_knowledge_item_versions WHERE item_id = p_item_id;
  INSERT INTO ai_knowledge_item_versions
    (item_id, account_id, version_no, kind, title, question, content, category, source_filename, restored_from, created_by)
  SELECT i.id, i.account_id, v_next, i.kind, i.title, i.question, i.content, i.category, i.source_filename,
         p_restored_from, auth.uid()
    FROM ai_knowledge_items i
   WHERE i.id = p_item_id;
  UPDATE ai_knowledge_items SET latest_version = v_next WHERE id = p_item_id;
  RETURN v_next;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_knowledge_record_version(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_knowledge_record_version(UUID, INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.ai_knowledge_save_item(
  p_account_id       UUID,
  p_item_id          UUID,
  p_kind             TEXT,
  p_title            TEXT,
  p_question         TEXT,
  p_content          TEXT,
  p_source_filename  TEXT,
  p_chunks           TEXT[],
  p_category         TEXT DEFAULT NULL,
  p_restored_from    INTEGER DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id       UUID;
  v_chunk TEXT;
  v_answer TEXT;
  v_canonical TEXT := btrim(regexp_replace(p_content, '\s+', ' ', 'g'));
  -- Same normalisation as parseKbItemInput: collapse whitespace, trim.
  v_category TEXT := NULLIF(btrim(regexp_replace(p_category, '\s+', ' ', 'g')), '');
BEGIN
  IF NOT is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501';
  END IF;
  IF p_chunks IS NULL OR cardinality(p_chunks) = 0 THEN
    RAISE EXCEPTION 'at least one chunk is required' USING ERRCODE = '22023';
  END IF;
  -- Every retrieved snippet must come from the reviewed canonical answer.
  FOREACH v_chunk IN ARRAY p_chunks LOOP
    v_answer := v_chunk;
    IF p_kind = 'faq' AND left(v_chunk, char_length('Pergunta: ' || p_question || E'\nResposta: ')) =
      'Pergunta: ' || p_question || E'\nResposta: ' THEN
      v_answer := substr(v_chunk, char_length('Pergunta: ' || p_question || E'\nResposta: ') + 1);
    END IF;
    v_answer := btrim(regexp_replace(v_answer, '\s+', ' ', 'g'));
    IF v_answer IS NULL OR v_answer = '' OR strpos(v_canonical, v_answer) = 0 THEN
      RAISE EXCEPTION 'Chunks must match the reviewed content' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF p_item_id IS NULL THEN
    INSERT INTO ai_knowledge_items (account_id, kind, title, question, content, source_filename, category, created_by)
    VALUES (p_account_id, p_kind, p_title, p_question, p_content, p_source_filename, v_category, auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE ai_knowledge_items
       SET title = p_title, question = p_question, content = p_content, category = v_category
     WHERE id = p_item_id AND account_id = p_account_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002';
    END IF;
    DELETE FROM ai_knowledge_chunks WHERE item_id = v_id AND NOT published;
  END IF;
  INSERT INTO ai_knowledge_chunks (item_id, account_id, chunk_index, content)
  SELECT v_id, p_account_id, t.ord - 1, t.c
    FROM unnest(p_chunks) WITH ORDINALITY AS t(c, ord);

  PERFORM public.ai_knowledge_record_version(v_id, p_restored_from);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_knowledge_save_item(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_knowledge_save_item(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, INTEGER) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ai_knowledge_publish_item(
  p_account_id UUID, p_item_id UUID, p_version INTEGER
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_item ai_knowledge_items%ROWTYPE;
BEGIN
  IF NOT is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_item FROM ai_knowledge_items
    WHERE id = p_item_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_version IS NULL OR p_version IS DISTINCT FROM v_item.latest_version THEN
    RAISE EXCEPTION 'Draft changed; review the latest version' USING ERRCODE = '40001';
  END IF;
  IF v_item.published_version = p_version THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM ai_knowledge_chunks WHERE item_id = p_item_id AND NOT published) THEN
    RAISE EXCEPTION 'Draft has no chunks' USING ERRCODE = '22023';
  END IF;
  DELETE FROM ai_knowledge_chunks WHERE item_id = p_item_id AND published;
  INSERT INTO ai_knowledge_chunks(item_id, account_id, chunk_index, content, published)
    SELECT item_id, account_id, chunk_index, content, TRUE FROM ai_knowledge_chunks
     WHERE item_id = p_item_id AND NOT published;
  UPDATE ai_knowledge_items SET published_version = p_version,
    published_at = NOW(), published_by = auth.uid() WHERE id = p_item_id;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_knowledge_publish_item(UUID, UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_knowledge_publish_item(UUID, UUID, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.ai_knowledge_search_service(
  p_account_id UUID,
  p_query      TEXT,
  p_limit      INTEGER DEFAULT 5
) RETURNS TABLE (
  chunk_id  UUID,
  item_id   UUID,
  title     TEXT,
  kind      TEXT,
  content   TEXT,
  rank      REAL
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_query TEXT := left(coalesce(p_query, ''), 2000);
  v_norm  TEXT;
  v_ts    tsquery;
  v_short BOOLEAN;
BEGIN
  IF p_account_id IS NULL OR btrim(v_query) = '' THEN
    RETURN;
  END IF;

  v_norm := regexp_replace(
    public.ai_kb_norm(v_query),
    '\m(oi+|ola|ole|opa|eai|bom|boa|bons|boas|dia|tarde|noite|tudo|bem|td|blz|beleza|obrigad[oa]s?|obg|valeu|vlw|ok|okay|pfv|pf|grat[oa])\M',
    ' ', 'g');
  v_norm := btrim(regexp_replace(v_norm, '[^[:alnum:]]+', ' ', 'g'));
  IF v_norm = '' THEN
    RETURN;
  END IF;
  v_short := char_length(v_norm) BETWEEN 3 AND 60;

  SELECT (string_agg('''' || replace(replace(lex, '\', '\\'), '''', '''''') || '''', ' | '))::tsquery
    INTO v_ts
    FROM unnest(tsvector_to_array(public.ai_kb_tsv(v_norm))) AS lex;

  IF v_ts IS NULL AND NOT v_short THEN
    RETURN;
  END IF;

  PERFORM set_config('pg_trgm.word_similarity_threshold', '0.5', true);

  RETURN QUERY
  SELECT r.chunk_id, r.item_id, r.title, r.kind, r.content, r.rank
    FROM (
      SELECT c.id AS chunk_id, c.item_id, v.title, v.kind, c.content, c.chunk_index,
             (COALESCE(ts_rank_cd(c.tsv, v_ts, 32), 0)
              + CASE WHEN v_short THEN word_similarity(v_norm, public.ai_kb_norm(c.content)) * 0.5 ELSE 0 END
             )::REAL AS rank
        FROM ai_knowledge_chunks c
        JOIN ai_knowledge_items i ON i.id = c.item_id AND i.account_id = c.account_id
        JOIN ai_knowledge_item_versions v ON v.item_id = i.id AND v.account_id = i.account_id
          AND v.version_no = i.published_version
       WHERE c.account_id = p_account_id
         AND i.enabled AND c.published
         AND (
           (v_ts IS NOT NULL AND c.tsv @@ v_ts)
           OR (v_short AND v_norm <% public.ai_kb_norm(c.content))
         )
    ) r
   WHERE r.rank >= 0.2
   ORDER BY r.rank DESC, r.item_id, r.chunk_index
   LIMIT least(greatest(coalesce(p_limit, 5), 1), 20);
END;
$$;

ALTER FUNCTION public.ai_knowledge_search_service(UUID, TEXT, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ai_knowledge_search_service(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_knowledge_search_service(UUID, TEXT, INTEGER) TO service_role;

NOTIFY pgrst, 'reload schema';
