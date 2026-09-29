-- ============================================================
-- 063_ai_knowledge_base.sql — AI phase 2: "Base de conhecimento".
--
-- Admins store FAQs, texts and uploaded files (extracted text only);
-- "Sugerir resposta" searches them with the customer's latest
-- messages and hands the best snippets to the model.
--
-- No embeddings (BYOK: an account may only have an Anthropic key, which
-- has no embeddings API). Retrieval is Postgres full-text search in
-- Portuguese over unaccented text, with pg_trgm word similarity as a
-- fallback for short queries / typos.
--
-- What this migration does
--   1. `unaccent` extension (schema `extensions`) + IMMUTABLE wrappers
--      `ai_kb_norm(text)` (lower + unaccent) and `ai_kb_tsv(text)` so
--      they can back a generated column and indexes.
--   2. `ai_knowledge_items` — one row per FAQ / text / file.
--   3. `ai_knowledge_chunks` — searchable pieces of an item, with a
--      generated `tsv` column (GIN) and a trigram GIN index.
--   4. RLS: items are read and written by admin+ only (Settings);
--      chunks are readable by agent+ (what a suggestion may show);
--      viewers and anon get nothing.
--   5. `ai_knowledge_save_item(...)` — creates/updates an item and
--      replaces its chunks in ONE transaction (SECURITY INVOKER: RLS
--      decides, so only admin+ of that account can write).
--   6. `ai_knowledge_search(account, query, limit)` — SECURITY DEFINER
--      with an explicit agent+ membership check; returns top chunks of
--      ENABLED items of that account only, above a relevance floor.
--   7. `ai_usage.kb_used` — whether a suggestion used the knowledge
--      base (a flag only; no text is stored).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Extensions + normalisation helpers
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() is only STABLE (it reads a dictionary); pinning the
-- dictionary and the search_path makes this wrapper safe to declare
-- IMMUTABLE. Works whether the extension lives in `extensions` or
-- `public`.
CREATE OR REPLACE FUNCTION public.ai_kb_norm(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = public, extensions, pg_catalog
AS $$
  SELECT lower(unaccent('unaccent'::regdictionary, p_text));
$$;

CREATE OR REPLACE FUNCTION public.ai_kb_tsv(p_text TEXT)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_catalog
AS $$
  SELECT to_tsvector('pg_catalog.portuguese'::regconfig, coalesce(public.ai_kb_norm(p_text), ''));
$$;

-- ------------------------------------------------------------
-- 2. Items
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_knowledge_items (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  question         TEXT,
  content          TEXT NOT NULL,
  source_filename  TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_knowledge_items DROP CONSTRAINT IF EXISTS ai_knowledge_items_kind_check;
ALTER TABLE ai_knowledge_items ADD CONSTRAINT ai_knowledge_items_kind_check
  CHECK (kind IN ('faq', 'text', 'file'));

ALTER TABLE ai_knowledge_items DROP CONSTRAINT IF EXISTS ai_knowledge_items_title_check;
ALTER TABLE ai_knowledge_items ADD CONSTRAINT ai_knowledge_items_title_check
  CHECK (char_length(btrim(title)) BETWEEN 1 AND 200);

-- Keep in sync with KB_LIMITS in src/lib/ai/knowledge.ts.
ALTER TABLE ai_knowledge_items DROP CONSTRAINT IF EXISTS ai_knowledge_items_content_check;
ALTER TABLE ai_knowledge_items ADD CONSTRAINT ai_knowledge_items_content_check
  CHECK (
    char_length(btrim(content)) >= 1
    AND char_length(content) <= CASE WHEN kind = 'file' THEN 200000 ELSE 20000 END
  );

ALTER TABLE ai_knowledge_items DROP CONSTRAINT IF EXISTS ai_knowledge_items_question_check;
ALTER TABLE ai_knowledge_items ADD CONSTRAINT ai_knowledge_items_question_check
  CHECK (
    (kind = 'faq' AND question IS NOT NULL AND char_length(btrim(question)) BETWEEN 1 AND 1000)
    OR (kind <> 'faq' AND question IS NULL)
  );

ALTER TABLE ai_knowledge_items DROP CONSTRAINT IF EXISTS ai_knowledge_items_filename_check;
ALTER TABLE ai_knowledge_items ADD CONSTRAINT ai_knowledge_items_filename_check
  CHECK (source_filename IS NULL OR char_length(source_filename) <= 255);

-- Size for the Settings list without shipping the whole text.
ALTER TABLE ai_knowledge_items
  ADD COLUMN IF NOT EXISTS content_chars INTEGER GENERATED ALWAYS AS (char_length(content)) STORED;

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_items_account
  ON ai_knowledge_items(account_id, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON ai_knowledge_items;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_knowledge_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 3. Chunks
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id      UUID NOT NULL REFERENCES ai_knowledge_items(id) ON DELETE CASCADE,
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_knowledge_chunks
  ADD COLUMN IF NOT EXISTS tsv tsvector GENERATED ALWAYS AS (public.ai_kb_tsv(content)) STORED;

ALTER TABLE ai_knowledge_chunks DROP CONSTRAINT IF EXISTS ai_knowledge_chunks_content_check;
ALTER TABLE ai_knowledge_chunks ADD CONSTRAINT ai_knowledge_chunks_content_check
  CHECK (char_length(content) BETWEEN 1 AND 4000 AND chunk_index >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_knowledge_chunks_item_index
  ON ai_knowledge_chunks(item_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_account
  ON ai_knowledge_chunks(account_id);
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_tsv
  ON ai_knowledge_chunks USING gin (tsv);

-- pg_trgm may live in `public` or `extensions` (see 047).
DO $$
DECLARE v_schema TEXT;
BEGIN
  SELECT n.nspname INTO v_schema FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_trgm ON public.ai_knowledge_chunks USING gin ((public.ai_kb_norm(content)) %I.gin_trgm_ops)',
    v_schema
  );
END;
$$;

-- A chunk always belongs to an item of the same account.
CREATE OR REPLACE FUNCTION public.ai_knowledge_chunks_check_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ai_knowledge_items i WHERE i.id = NEW.item_id AND i.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'chunk account does not match its item' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_knowledge_chunks_check_account ON ai_knowledge_chunks;
CREATE TRIGGER ai_knowledge_chunks_check_account BEFORE INSERT OR UPDATE ON ai_knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION public.ai_knowledge_chunks_check_account();

-- ------------------------------------------------------------
-- 4. RLS
-- ------------------------------------------------------------
ALTER TABLE ai_knowledge_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_knowledge_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_knowledge_items_select ON ai_knowledge_items;
CREATE POLICY ai_knowledge_items_select ON ai_knowledge_items FOR SELECT
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_knowledge_items_insert ON ai_knowledge_items;
CREATE POLICY ai_knowledge_items_insert ON ai_knowledge_items FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_knowledge_items_update ON ai_knowledge_items;
CREATE POLICY ai_knowledge_items_update ON ai_knowledge_items FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_knowledge_items_delete ON ai_knowledge_items;
CREATE POLICY ai_knowledge_items_delete ON ai_knowledge_items FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_knowledge_chunks_select ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_select ON ai_knowledge_chunks FOR SELECT
  USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS ai_knowledge_chunks_insert ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_insert ON ai_knowledge_chunks FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_knowledge_chunks_update ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_update ON ai_knowledge_chunks FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_knowledge_chunks_delete ON ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_delete ON ai_knowledge_chunks FOR DELETE
  USING (is_account_member(account_id, 'admin'));

REVOKE ALL ON TABLE ai_knowledge_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE ai_knowledge_chunks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ai_knowledge_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ai_knowledge_chunks TO authenticated;
GRANT ALL ON TABLE ai_knowledge_items TO service_role;
GRANT ALL ON TABLE ai_knowledge_chunks TO service_role;

-- ------------------------------------------------------------
-- 5. Save item + chunks atomically (RLS applies: invoker)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_knowledge_save_item(
  p_account_id       UUID,
  p_item_id          UUID,
  p_kind             TEXT,
  p_title            TEXT,
  p_question         TEXT,
  p_content          TEXT,
  p_source_filename  TEXT,
  p_chunks           TEXT[]
) RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'Admins only' USING ERRCODE = '42501';
  END IF;
  IF p_chunks IS NULL OR cardinality(p_chunks) = 0 THEN
    RAISE EXCEPTION 'at least one chunk is required' USING ERRCODE = '22023';
  END IF;

  IF p_item_id IS NULL THEN
    INSERT INTO ai_knowledge_items (account_id, kind, title, question, content, source_filename, created_by)
    VALUES (p_account_id, p_kind, p_title, p_question, p_content, p_source_filename, auth.uid())
    RETURNING id INTO v_id;
  ELSE
    -- kind and source_filename never change on edit.
    UPDATE ai_knowledge_items
       SET title = p_title, question = p_question, content = p_content
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

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_knowledge_save_item(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_knowledge_save_item(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 6. Search
-- ------------------------------------------------------------
-- OR-combines the query's Portuguese stems (a customer message is a
-- sentence, not a keyword list), ranks with ts_rank_cd, and for short
-- queries (<= 60 chars) also accepts trigram word-similarity matches so
-- a typo ("preso", "entrga") still finds something.
--
-- Greetings and courtesies ("oi, bom dia", "obrigado") are stripped
-- first, and only hits with rank >= 0.2 come back, so small talk does
-- not drag random snippets into a suggestion.
--
-- SECURITY DEFINER (agents cannot read `ai_knowledge_items`, but a
-- suggestion needs the item title / enabled flag) with an explicit
-- agent+ membership check and account filter: another account's rows
-- are never returned, and the service role (no auth.uid()) gets nothing.
CREATE OR REPLACE FUNCTION public.ai_knowledge_search(
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
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_query TEXT := left(coalesce(p_query, ''), 2000);
  v_norm  TEXT;
  v_ts    tsquery;
  v_short BOOLEAN;
BEGIN
  IF NOT is_account_member(p_account_id, 'agent') OR btrim(v_query) = '' THEN
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

  -- Transaction-local; lets `<%` use the trigram index at 0.5.
  PERFORM set_config('pg_trgm.word_similarity_threshold', '0.5', true);

  RETURN QUERY
  SELECT r.chunk_id, r.item_id, r.title, r.kind, r.content, r.rank
    FROM (
      SELECT c.id AS chunk_id, c.item_id, i.title, i.kind, c.content, c.chunk_index,
             (COALESCE(ts_rank_cd(c.tsv, v_ts, 32), 0)
              + CASE WHEN v_short THEN word_similarity(v_norm, public.ai_kb_norm(c.content)) * 0.5 ELSE 0 END
             )::REAL AS rank
        FROM ai_knowledge_chunks c
        JOIN ai_knowledge_items i ON i.id = c.item_id AND i.account_id = c.account_id
       WHERE c.account_id = p_account_id
         AND i.enabled
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

ALTER FUNCTION public.ai_knowledge_search(UUID, TEXT, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ai_knowledge_search(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_knowledge_search(UUID, TEXT, INTEGER) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 7. Usage flag
-- ------------------------------------------------------------
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS kb_used BOOLEAN NOT NULL DEFAULT FALSE;
