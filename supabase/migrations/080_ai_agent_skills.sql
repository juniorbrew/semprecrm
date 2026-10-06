-- ============================================================
-- 080_ai_agent_skills.sql — "Skills": what an AI agent may DO besides
-- answering (migration 064/065/066 agents only reply or hand over).
--
--   1. ai_agents.skills — the skills the agent is allowed to use. Empty
--      by default: an agent never acts on its own until an admin turns
--      a skill on. The CHECK keeps it a subset of the known skills.
--   2. ai_actions — one row per action the agent took (or tried), the
--      audit trail and the future "Execuções" screen. UNIQUE
--      (job_id, seq) makes a retried reply job unable to run the same
--      action twice: the server INSERTs first and skips on conflict.
--
-- RLS: members of the account read, only the service role writes (the
-- auto-reply runtime). Same grant model as ai_handoffs (066).
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Skills on the agent
-- ------------------------------------------------------------
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS skills TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_skills_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_skills_check
  CHECK (skills <@ ARRAY['internal_note', 'add_tag', 'create_task', 'move_deal_stage']::TEXT[]);

-- ------------------------------------------------------------
-- 2. Action log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_actions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id       UUID REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id         UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  job_id           UUID REFERENCES ai_reply_jobs(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL DEFAULT 0,
  skill            TEXT NOT NULL,
  params           JSONB NOT NULL DEFAULT '{}'::JSONB,
  status           TEXT NOT NULL DEFAULT 'running',
  detail           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_skill_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_skill_check
  CHECK (skill IN ('internal_note', 'add_tag', 'create_task', 'move_deal_stage'));

ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_status_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_status_check
  CHECK (status IN ('running', 'ok', 'skipped', 'error'));

ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_detail_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_detail_check
  CHECK (detail IS NULL OR char_length(detail) <= 300);

-- One run of a skill per job and position: a retried job cannot repeat it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_actions_job_seq
  ON ai_actions(job_id, seq) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_actions_conversation
  ON ai_actions(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_actions_account_created
  ON ai_actions(account_id, created_at DESC);

ALTER TABLE ai_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_actions_select ON ai_actions;
CREATE POLICY ai_actions_select ON ai_actions FOR SELECT
  USING (is_account_member(account_id));

REVOKE ALL ON TABLE ai_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE ai_actions TO authenticated;
GRANT ALL ON TABLE ai_actions TO service_role;
