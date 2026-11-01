-- Rollback of 103_sales_goals.sql. NOT a migration: run by hand (as postgres).
-- Roll the APP back first (the dashboard card calls these functions).
-- Drops the goals (data loss: every goal ever set); deals are untouched.
BEGIN;
DROP FUNCTION IF EXISTS public.sales_goal_set(uuid, text, uuid, uuid, text, date, numeric);
DROP FUNCTION IF EXISTS public.sales_goal_progress(uuid, date);
DROP TABLE IF EXISTS public.sales_goals;  -- takes its policies, triggers and indexes along
DROP FUNCTION IF EXISTS public.sales_goals_guard();
DROP INDEX IF EXISTS public.idx_deals_account_won_closed;
NOTIFY pgrst, 'reload schema';
COMMIT;
