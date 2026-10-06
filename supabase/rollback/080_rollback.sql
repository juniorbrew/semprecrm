-- Rollback of 080_ai_agent_skills.sql. Drops the action log (history of what
-- the AI did is lost) and the per-agent skills. Safe to run twice.
DROP TABLE IF EXISTS ai_actions;
ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_skills_check;
ALTER TABLE ai_agents DROP COLUMN IF EXISTS skills;
