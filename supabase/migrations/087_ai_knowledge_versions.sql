-- ============================================================
-- 087: knowledge base categories and immutable version history
-- (roadmap docs/verification/vocero-evolution/ROADMAP.md, Entrega 4, part A).
--
-- Additive only:
--   * ai_knowledge_items.category — optional free-text group (1..60).
--   * ai_knowledge_item_versions — one row per saved state of an item
--     (create, edit, restore). Admins read it; authenticated can only
--     INSERT through ai_knowledge_save_item (no UPDATE/DELETE grant), so
--     history is immutable. Versions go with their item on delete.
--   * ai_knowledge_save_item gains p_category and p_restored_from
--     (defaults NULL) and writes the version in the same transaction as
--     the item and its chunks.
--   * Backfill: every existing item gets version 1 = its current state.
--
-- What the AI reads does not change: search still joins the current
-- (enabled) item and its chunks. Restoring an old version goes through
-- the app (it re-chunks) and is recorded as a new version.
--
-- Rollback: DROP TABLE ai_knowledge_item_versions; ALTER TABLE
-- ai_knowledge_items DROP COLUMN category; recreate the 063
-- ai_knowledge_save_item. No existing row is modified except by the
-- category column being added (NULL).
-- ============================================================

ALTER TABLE ai_knowledge_items ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE ai_knowledge_items DROP CONSTRAINT IF EXISTS ai_knowledge_items_category_check;
ALTER TABLE ai_knowledge_items ADD CONSTRAINT ai_knowledge_items_category_check
  CHECK (category IS NULL OR char_length(btrim(category)) BETWEEN 1 AND 60);

CREATE TABLE IF NOT EXISTS ai_knowledge_item_versions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id          UUID NOT NULL REFERENCES ai_knowledge_items(id) ON DELETE CASCADE,
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  version_no       INTEGER NOT NULL CHECK (version_no >= 1),
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  question         TEXT,
  content          TEXT NOT NULL,
  category         TEXT,
  source_filename  TEXT,
  restored_from    INTEGER CHECK (restored_from IS NULL OR restored_from >= 1),
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, version_no)
);
ALTER TABLE ai_knowledge_item_versions
  ADD COLUMN IF NOT EXISTS content_chars INTEGER GENERATED ALWAYS AS (char_length(content)) STORED;
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_item_versions_account
  ON ai_knowledge_item_versions(account_id);

-- A version always belongs to its item's account (same guard as chunks).
CREATE OR REPLACE FUNCTION public.ai_knowledge_versions_check_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ai_knowledge_items i WHERE i.id = NEW.item_id AND i.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'version account does not match its item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_knowledge_versions_check_account() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ai_knowledge_versions_check_account ON ai_knowledge_item_versions;
CREATE TRIGGER ai_knowledge_versions_check_account BEFORE INSERT ON ai_knowledge_item_versions
  FOR EACH ROW EXECUTE FUNCTION public.ai_knowledge_versions_check_account();

ALTER TABLE ai_knowledge_item_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_knowledge_item_versions_select ON ai_knowledge_item_versions;
CREATE POLICY ai_knowledge_item_versions_select ON ai_knowledge_item_versions FOR SELECT
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_knowledge_item_versions_insert ON ai_knowledge_item_versions;
CREATE POLICY ai_knowledge_item_versions_insert ON ai_knowledge_item_versions FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
REVOKE ALL ON TABLE ai_knowledge_item_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE ai_knowledge_item_versions TO authenticated;
GRANT ALL ON TABLE ai_knowledge_item_versions TO service_role;

-- Backfill: the current state of every item is its version 1.
INSERT INTO ai_knowledge_item_versions
  (item_id, account_id, version_no, kind, title, question, content, category, source_filename, created_by, created_at)
SELECT i.id, i.account_id, 1, i.kind, i.title, i.question, i.content, i.category, i.source_filename, i.created_by, i.updated_at
  FROM ai_knowledge_items i
 WHERE NOT EXISTS (SELECT 1 FROM ai_knowledge_item_versions v WHERE v.item_id = i.id);

-- Save = item + chunks + version, one transaction. The UPDATE locks the
-- item row, so concurrent saves of one item get consecutive versions.
DROP FUNCTION IF EXISTS public.ai_knowledge_save_item(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]);
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
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_id       UUID;
  v_category TEXT := NULLIF(btrim(p_category), '');
  v_next     INTEGER;
BEGIN
  IF NOT is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501';
  END IF;
  IF p_chunks IS NULL OR cardinality(p_chunks) = 0 THEN
    RAISE EXCEPTION 'at least one chunk is required' USING ERRCODE = '22023';
  END IF;
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
    DELETE FROM ai_knowledge_chunks WHERE item_id = v_id;
  END IF;
  INSERT INTO ai_knowledge_chunks (item_id, account_id, chunk_index, content)
  SELECT v_id, p_account_id, t.ord - 1, t.c
    FROM unnest(p_chunks) WITH ORDINALITY AS t(c, ord);

  SELECT coalesce(max(version_no), 0) + 1 INTO v_next
    FROM ai_knowledge_item_versions WHERE item_id = v_id;
  INSERT INTO ai_knowledge_item_versions
    (item_id, account_id, version_no, kind, title, question, content, category, source_filename, restored_from, created_by)
  SELECT i.id, i.account_id, v_next, i.kind, i.title, i.question, i.content, i.category, i.source_filename,
         p_restored_from, auth.uid()
    FROM ai_knowledge_items i
   WHERE i.id = v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_knowledge_save_item(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_knowledge_save_item(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT, INTEGER) TO authenticated, service_role;
