-- ============================================================
-- 064_ai_memory_agents.sql — AI phase 3: "Memória do contato" and
-- AI agents (profiles). Module `ai`.
--
-- What this migration does
--   1. `ai_contact_memories` — short durable facts about a contact
--      ("prefere entrega à tarde"). Facts extracted by the model start
--      as `proposed` and only an agent's approval makes them `active`;
--      manual facts are `active` at once; `rejected` ones are kept so
--      the model does not propose them again. Members read (viewers
--      too); agent+ write. The contact (and the conversation, when
--      set) must belong to the row's account and the contact must not be
--      anonymised — checked in the policy. A trigger stamps created_by /
--      approved_by from auth.uid() and freezes created_by / source.
--      LGPD: deleted on anonymisation, included in the export (app).
--   2. `ai_agents` — named assistant profiles: instructions, tone,
--      optional model override, knowledge on/off, enabled, one default
--      per account (deferred exclusion constraint + the
--      `ai_agents_set_default` RPC for an atomic swap). Assignment links are plain
--      arrays: `channels` (the conversation's WhatsApp transport,
--      'official' | 'qr' — one number each per account) and `tag_ids`
--      (contact tags). A deleted tag leaves a dangling id that simply
--      never matches. Agent+ read (the composer shows which agent
--      answers); admin+ write.
--   3. `ai_usage.feature` accepts 'memory_extract' and 'agent_test'.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. AI_CONTACT_MEMORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_contact_memories (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  fact             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'proposed',
  source           TEXT NOT NULL DEFAULT 'manual',
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_contact_memories DROP CONSTRAINT IF EXISTS ai_contact_memories_fact_check;
ALTER TABLE ai_contact_memories ADD CONSTRAINT ai_contact_memories_fact_check
  CHECK (char_length(btrim(fact)) BETWEEN 1 AND 300);

ALTER TABLE ai_contact_memories DROP CONSTRAINT IF EXISTS ai_contact_memories_status_check;
ALTER TABLE ai_contact_memories ADD CONSTRAINT ai_contact_memories_status_check
  CHECK (status IN ('proposed', 'active', 'rejected'));

ALTER TABLE ai_contact_memories DROP CONSTRAINT IF EXISTS ai_contact_memories_source_check;
ALTER TABLE ai_contact_memories ADD CONSTRAINT ai_contact_memories_source_check
  CHECK (source IN ('ai', 'manual'));

CREATE INDEX IF NOT EXISTS idx_ai_contact_memories_contact
  ON ai_contact_memories(contact_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_contact_memories_account
  ON ai_contact_memories(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON ai_contact_memories;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_contact_memories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Who approved / created is stamped by the database for app users
-- (auth.uid() set): approved_by follows the status, and created_by /
-- source never change after the insert. The service role (auth.uid()
-- NULL) keeps whatever it writes.
CREATE OR REPLACE FUNCTION public.ai_contact_memories_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := auth.uid();
  ELSE
    NEW.created_by := OLD.created_by;
    NEW.source := OLD.source;
  END IF;
  IF NEW.status = 'active' THEN
    IF TG_OP = 'INSERT' OR OLD.status <> 'active' OR NEW.fact IS DISTINCT FROM OLD.fact THEN
      NEW.approved_by := auth.uid();
    ELSE
      NEW.approved_by := OLD.approved_by;
    END IF;
  ELSE
    NEW.approved_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_contact_memories_stamp ON ai_contact_memories;
CREATE TRIGGER ai_contact_memories_stamp BEFORE INSERT OR UPDATE ON ai_contact_memories
  FOR EACH ROW EXECUTE FUNCTION public.ai_contact_memories_stamp();

ALTER TABLE ai_contact_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_contact_memories_select ON ai_contact_memories;
CREATE POLICY ai_contact_memories_select ON ai_contact_memories FOR SELECT
  USING (is_account_member(account_id));

-- Writes: agent+ of the row's account, and the contact / conversation
-- must be of that same account (no pinning a fact on a foreign contact)
-- and the contact must not be anonymised (LGPD).
DROP POLICY IF EXISTS ai_contact_memories_insert ON ai_contact_memories;
CREATE POLICY ai_contact_memories_insert ON ai_contact_memories FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = ai_contact_memories.contact_id AND c.account_id = ai_contact_memories.account_id AND c.anonymized_at IS NULL)
    AND (conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM conversations v
      WHERE v.id = ai_contact_memories.conversation_id AND v.account_id = ai_contact_memories.account_id AND v.contact_id = ai_contact_memories.contact_id
    ))
  );

DROP POLICY IF EXISTS ai_contact_memories_update ON ai_contact_memories;
CREATE POLICY ai_contact_memories_update ON ai_contact_memories FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = ai_contact_memories.contact_id AND c.account_id = ai_contact_memories.account_id AND c.anonymized_at IS NULL)
    AND (conversation_id IS NULL OR EXISTS (
      SELECT 1 FROM conversations v
      WHERE v.id = ai_contact_memories.conversation_id AND v.account_id = ai_contact_memories.account_id AND v.contact_id = ai_contact_memories.contact_id
    ))
  );

DROP POLICY IF EXISTS ai_contact_memories_delete ON ai_contact_memories;
CREATE POLICY ai_contact_memories_delete ON ai_contact_memories FOR DELETE
  USING (is_account_member(account_id, 'agent'));

REVOKE ALL ON TABLE ai_contact_memories FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ai_contact_memories TO authenticated;
GRANT ALL ON TABLE ai_contact_memories TO service_role;

-- ============================================================
-- 2. AI_AGENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_agents (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  instructions       TEXT NOT NULL,
  tone               TEXT,
  model              TEXT,
  knowledge_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  is_default         BOOLEAN NOT NULL DEFAULT FALSE,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  channels           TEXT[] NOT NULL DEFAULT '{}',
  tag_ids            UUID[] NOT NULL DEFAULT '{}',
  created_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_name_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_name_check
  CHECK (char_length(btrim(name)) BETWEEN 1 AND 80);

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_instructions_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_instructions_check
  CHECK (char_length(btrim(instructions)) BETWEEN 1 AND 4000);

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_tone_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_tone_check
  CHECK (tone IS NULL OR char_length(tone) <= 200);

-- Same shape as ai_settings_model_check (058).
ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_model_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_model_check
  CHECK (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$');

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_channels_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_channels_check
  CHECK (channels <@ ARRAY['official', 'qr']::TEXT[]);

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_tag_ids_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_tag_ids_check
  CHECK (cardinality(tag_ids) <= 50);

-- At most one default agent per account. A DEFERRED exclusion
-- constraint (not a unique index) so the swap is one UPDATE —
-- ai_agents_set_default() — checked at commit, never leaving the
-- account without a default half-way.
DROP INDEX IF EXISTS uq_ai_agents_default;
ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_one_default;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_one_default
  EXCLUDE USING btree (account_id WITH =) WHERE (is_default)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX IF NOT EXISTS idx_ai_agents_account ON ai_agents(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON ai_agents;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_agents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agents_select ON ai_agents;
CREATE POLICY ai_agents_select ON ai_agents FOR SELECT
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS ai_agents_insert ON ai_agents;
CREATE POLICY ai_agents_insert ON ai_agents FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_agents_update ON ai_agents;
CREATE POLICY ai_agents_update ON ai_agents FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_agents_delete ON ai_agents;
CREATE POLICY ai_agents_delete ON ai_agents FOR DELETE
  USING (is_account_member(account_id, 'admin'));

REVOKE ALL ON TABLE ai_agents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ai_agents TO authenticated;
GRANT ALL ON TABLE ai_agents TO service_role;

-- ai_agents_set_default(account, agent) — makes `agent` the only
-- default of the account in ONE statement. SECURITY INVOKER: RLS
-- (admin+) decides; returns false when the agent is not visible.
CREATE OR REPLACE FUNCTION public.ai_agents_set_default(p_account_id UUID, p_agent_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ai_agents WHERE id = p_agent_id AND account_id = p_account_id) THEN
    RETURN FALSE;
  END IF;
  UPDATE ai_agents
     SET is_default = (id = p_agent_id)
   WHERE account_id = p_account_id
     AND (is_default OR id = p_agent_id);
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_agents_set_default(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_agents_set_default(UUID, UUID) TO authenticated, service_role;

-- ============================================================
-- 3. AI_USAGE features
-- ============================================================
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_feature_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_feature_check
  CHECK (feature IN ('suggest_reply', 'memory_extract', 'agent_test'));
