-- ============================================================
-- Migration 102 — "Resumir com IA" (resumo da conversa + sugestão de
-- atualizar o negócio). The only database change: ai_usage.feature
-- accepts 'deal_summary', so the call is metered under its own label.
-- Same drop / add NOT VALID / VALIDATE shape as 071.
-- ============================================================
ALTER TABLE public.ai_usage DROP CONSTRAINT IF EXISTS ai_usage_feature_check;
ALTER TABLE public.ai_usage ADD CONSTRAINT ai_usage_feature_check
  CHECK (feature IN ('suggest_reply', 'memory_extract', 'agent_test', 'auto_reply', 'triage', 'deal_summary')) NOT VALID;
ALTER TABLE public.ai_usage VALIDATE CONSTRAINT ai_usage_feature_check;
