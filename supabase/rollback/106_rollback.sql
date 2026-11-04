-- Rollback of 106_sales_forecast.sql. NOT a migration: run by hand (as postgres).
-- Roll the APP back first (the Funil forecast view, the goals card and the stage settings read these).
-- Drops the chance chosen for each stage (data loss); stages fall back to the automatic rule.
BEGIN;
DROP FUNCTION IF EXISTS public.sales_forecast(uuid, uuid, date, int);
DROP FUNCTION IF EXISTS private.stage_win_probability(uuid);
DROP FUNCTION IF EXISTS private.stage_probs(uuid);
DROP INDEX IF EXISTS public.idx_deals_account_open_expected;
ALTER TABLE public.pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_win_probability_check;
ALTER TABLE public.pipeline_stages DROP COLUMN IF EXISTS win_probability;
NOTIFY pgrst, 'reload schema';
COMMIT;
