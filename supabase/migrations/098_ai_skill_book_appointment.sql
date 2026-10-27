-- ============================================================
-- 098 — Agenda inteligente, entrega C: a IA marca horários.
--
-- Spec: docs/superpowers/specs/2026-10-24-agenda-inteligente.md (seção C).
--
-- Só amplia as listas de habilidades conhecidas (080) com
-- 'book_appointment'. A marcação em si usa a RPC agenda_book_appointment
-- (096) com p_source = 'ai': mesmas regras, sem encaixe, e a restrição de
-- exclusão do banco decide a corrida.
-- ============================================================

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_skills_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_skills_check
  CHECK (skills <@ ARRAY['internal_note', 'add_tag', 'create_task', 'move_deal_stage', 'book_appointment']::TEXT[]);

ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_skill_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_skill_check
  CHECK (skill IN ('internal_note', 'add_tag', 'create_task', 'move_deal_stage', 'book_appointment'));
