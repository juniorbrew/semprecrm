-- ============================================================
-- 106 — Sales forecast ("Previsão de vendas", item 4.4).
--
-- 1. pipeline_stages.win_probability: chance (0-100) of closing a deal that
--    sits in the stage, set by the account admin (same RLS as any stage edit).
--    NULL = automatic, exactly the rule the Funil always used (board.ts
--    stageProbability): 1 stage -> 100; last stage -> 100; otherwise
--    10 + 80 * index / (n - 2) for the stage at 0-based index (first is 10,
--    the one before the last is 90); with only 2 stages the first is 10.
--    The rule is mirrored in TypeScript and both are tested with the same cases.
-- 2. private.stage_probs(account) / private.stage_win_probability(stage):
--    the chance of each stage (defined or automatic), a numeric 0-100.
-- 3. sales_forecast(account, pipeline | NULL = all, month, months): one row
--    per month x seller, plus month NULL = "no date". SECURITY INVOKER: deals
--    and stages are read under the caller's RLS; the caller must be a member
--    of the account (same check and error as sales_goal_progress, 103).
--      won_value       status 'won', closed_at inside the month (account time zone)
--      weighted_value  open deals with expected_close_date in the month x stage chance
--      best_case_value won_value + full value of those open deals
--      open_count      those open deals
--      overdue_*       open deals dated BEFORE the current month: they count in
--                      the CURRENT month (and are also in open_count/weighted/best case)
--      other_currency_count  deals (won or open) not in the account currency: counted, never summed
--    The "no date" row (month NULL) holds open deals without expected_close_date:
--    open_count, weighted_value and best_case_value (= full value); won_value 0.
--    Lost deals never count. assigned_to is a profiles.id (NULL = unassigned).
--
-- Grants follow 076/096/103: functions closed by default, EXECUTE granted
-- explicitly. private.* helpers are used by the invoker, so authenticated needs EXECUTE (as 104).
-- No new table: the billing block (094) already covers pipeline_stages.
-- Rollback: supabase/rollback/106_rollback.sql. SQL test: supabase/tests/sales_forecast.sql.
-- Idempotent.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.pipeline_stages ADD COLUMN IF NOT EXISTS win_probability INTEGER;
ALTER TABLE public.pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_win_probability_check;
ALTER TABLE public.pipeline_stages ADD CONSTRAINT pipeline_stages_win_probability_check
  CHECK (win_probability IS NULL OR (win_probability BETWEEN 0 AND 100));

CREATE INDEX IF NOT EXISTS idx_deals_account_open_expected ON public.deals (account_id, expected_close_date) WHERE status = 'open';

-- Chance (0-100) of every stage of the account's pipelines.
CREATE OR REPLACE FUNCTION private.stage_probs(p_account_id uuid)
RETURNS TABLE (stage_id uuid, pipeline_id uuid, probability numeric)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT x.id, x.pipeline_id,
         CASE
           WHEN x.win_probability IS NOT NULL THEN x.win_probability::numeric
           WHEN x.n <= 1 OR x.idx = x.n THEN 100::numeric
           WHEN x.n = 2 THEN 10::numeric
           ELSE 10 + 80 * (x.idx - 1)::numeric / (x.n - 2)
         END
    FROM (
      SELECT s.id, s.pipeline_id, s.win_probability,
             row_number() OVER (PARTITION BY s.pipeline_id ORDER BY s.position, s.created_at, s.id) AS idx,
             count(*) OVER (PARTITION BY s.pipeline_id) AS n
        FROM public.pipeline_stages s
        JOIN public.pipelines p ON p.id = s.pipeline_id
       WHERE p.account_id = p_account_id
    ) x;
$$;
REVOKE ALL ON FUNCTION private.stage_probs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.stage_probs(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.stage_win_probability(p_stage_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT sp.probability
    FROM public.pipeline_stages s
    JOIN public.pipelines p ON p.id = s.pipeline_id
    CROSS JOIN LATERAL private.stage_probs(p.account_id) sp
   WHERE s.id = p_stage_id AND sp.stage_id = s.id;
$$;
REVOKE ALL ON FUNCTION private.stage_win_probability(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.stage_win_probability(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sales_forecast(
  p_account_id  uuid,
  p_pipeline_id uuid,
  p_month       date,
  p_months      int
)
RETURNS TABLE (
  month                 date,
  assigned_to           uuid,
  won_value             numeric,
  weighted_value        numeric,
  best_case_value       numeric,
  open_count            bigint,
  overdue_count         bigint,
  overdue_value         numeric,
  other_currency_count  bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tz       text;
  v_cur      date;
  v_first    date;
  v_last     date;
  v_months   int := LEAST(GREATEST(COALESCE(p_months, 3), 1), 6);
  v_currency text;
BEGIN
  IF NOT public.is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'not a member of this account' USING ERRCODE = '42501';
  END IF;

  v_tz := public.report_timezone(p_account_id);
  v_cur := date_trunc('month', now() AT TIME ZONE v_tz)::date;
  v_first := date_trunc('month', COALESCE(p_month, v_cur))::date;
  v_last := (v_first + ((v_months - 1) * INTERVAL '1 month'))::date;
  SELECT a.default_currency INTO v_currency FROM public.accounts a WHERE a.id = p_account_id;

  -- Output columns share names with the CTE columns, so every reference is aliased.
  RETURN QUERY
  WITH sp AS (
    SELECT q.stage_id AS sid, q.probability AS prob FROM private.stage_probs(p_account_id) q
  ), base AS (
    SELECT d.assigned_to AS seller,
           d.status AS st,
           d.value AS val,
           (d.currency IS NOT DISTINCT FROM v_currency) AS same_cur,
           CASE
             WHEN d.status = 'won' THEN date_trunc('month', d.closed_at AT TIME ZONE v_tz)::date
             WHEN d.expected_close_date IS NULL THEN NULL
             ELSE GREATEST(date_trunc('month', d.expected_close_date)::date, v_cur)
           END AS mth,
           (d.status = 'open' AND d.expected_close_date IS NOT NULL
              AND date_trunc('month', d.expected_close_date)::date < v_cur) AS is_overdue,
           COALESCE(sp.prob, 0) AS prob
      FROM public.deals d
      LEFT JOIN sp ON sp.sid = d.stage_id
     WHERE d.account_id = p_account_id
       AND d.status IN ('open', 'won')
       AND (p_pipeline_id IS NULL OR d.pipeline_id = p_pipeline_id)
  )
  SELECT b.mth,
         b.seller,
         COALESCE(sum(b.val) FILTER (WHERE b.st = 'won' AND b.same_cur), 0)::numeric,
         round(COALESCE(sum(b.val * b.prob / 100) FILTER (WHERE b.st = 'open' AND b.same_cur), 0), 2)::numeric,
         COALESCE(sum(b.val) FILTER (WHERE b.same_cur), 0)::numeric,
         count(*) FILTER (WHERE b.st = 'open' AND b.same_cur),
         count(*) FILTER (WHERE b.is_overdue AND b.same_cur),
         COALESCE(sum(b.val) FILTER (WHERE b.is_overdue AND b.same_cur), 0)::numeric,
         count(*) FILTER (WHERE NOT b.same_cur)
    FROM base b
   WHERE (b.mth IS NULL AND b.st = 'open') OR (b.mth >= v_first AND b.mth <= v_last)
   GROUP BY b.mth, b.seller
   ORDER BY b.mth NULLS LAST, b.seller NULLS FIRST;
END;
$$;

REVOKE ALL ON FUNCTION public.sales_forecast(uuid, uuid, date, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_forecast(uuid, uuid, date, int) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
