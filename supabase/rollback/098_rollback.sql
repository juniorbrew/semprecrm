-- Rollback of 098_ai_skill_book_appointment.sql. Takes 'book_appointment' off
-- every agent first (the old CHECK would reject it); the ai_actions log keeps
-- its booking rows, so that CHECK is restored NOT VALID. Safe to run twice.
UPDATE ai_agents SET skills = array_remove(skills, 'book_appointment') WHERE 'book_appointment' = ANY (skills);

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_skills_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_skills_check
  CHECK (skills <@ ARRAY['internal_note', 'add_tag', 'create_task', 'move_deal_stage']::TEXT[]);

ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_skill_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_skill_check
  CHECK (skill IN ('internal_note', 'add_tag', 'create_task', 'move_deal_stage')) NOT VALID;
