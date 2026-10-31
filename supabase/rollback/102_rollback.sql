-- Forward rollback of 102_ai_usage_deal_summary.sql. NOT a migration: run by
-- hand (as postgres). Roll the APP back first. The usage rows labelled
-- 'deal_summary' are relabelled 'suggest_reply' (same kind of call) so the
-- narrower CHECK can be validated; their cost stays in the monthly total.
BEGIN;
UPDATE public.ai_usage SET feature = 'suggest_reply' WHERE feature = 'deal_summary';
ALTER TABLE public.ai_usage DROP CONSTRAINT IF EXISTS ai_usage_feature_check;
ALTER TABLE public.ai_usage ADD CONSTRAINT ai_usage_feature_check
  CHECK (feature IN ('suggest_reply', 'memory_extract', 'agent_test', 'auto_reply', 'triage')) NOT VALID;
ALTER TABLE public.ai_usage VALIDATE CONSTRAINT ai_usage_feature_check;
COMMIT;
