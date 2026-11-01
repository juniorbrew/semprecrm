-- ============================================================
-- 103 — Sales goals ("Metas do mês"): company / team / member, monthly,
-- "valid until changed".
--
-- 1. sales_goals: one row per (account, target, metric, month). A month's
--    goal is its own row or, when there is none, the most recent earlier
--    row. target NULL = the goal was removed from that month on.
--      scope  'account' | 'team' (team_id) | 'member' (user_id = auth uid)
--      metric 'won_value' (sum of deals.value in the account currency)
--             'won_count' (number of won deals)
-- 2. Writes: owner/admin only (RLS) AND only for the current month onward
--    in the account time zone (trigger, so it holds for any client). The
--    row's key never changes (trigger). Team must belong to the account and
--    the user must be a member of it (trigger; the FKs alone accept any id).
--    Past months are therefore frozen history.
-- 3. Reads: owner/admin see every goal; everyone else sees the company
--    goal, the goals of teams they are in and their own. RLS decides, so no
--    client can read another seller's goal.
-- 4. Billing block (094): RESTRICTIVE INSERT/UPDATE/DELETE policies with
--    private.account_is_writable, same shape as every other CRM table.
-- 5. sales_goal_progress(account, month): exact SQL aggregate over won
--    deals (status 'won', closed_at inside the month in the account time
--    zone), one row per effective goal. SECURITY INVOKER: goals are read
--    under the caller's RLS (so an agent only gets what they may see) and
--    deals under the caller's deals RLS (any account member reads them).
--    A won deal without assignee counts only for the company. deals.assigned_to
--    is a profiles.id; goals and team_members hold the auth user id, so the
--    function joins through profiles.
-- 6. sales_goal_set(...): upsert "from this month on" (NULL target removes).
--
-- Grants follow 076: new functions are closed by default; EXECUTE is
-- granted explicitly. Nothing personal is added.
-- Rollback: supabase/rollback/103_rollback.sql. SQL test: supabase/tests/sales_goals.sql.
-- Idempotent.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.sales_goals (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL,
  team_id    UUID REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  metric     TEXT NOT NULL,
  month      DATE NOT NULL,
  target     NUMERIC(14, 2),
  created_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.sales_goals DROP CONSTRAINT IF EXISTS sales_goals_scope_check;
ALTER TABLE public.sales_goals ADD CONSTRAINT sales_goals_scope_check CHECK (scope IN ('account', 'team', 'member'));
ALTER TABLE public.sales_goals DROP CONSTRAINT IF EXISTS sales_goals_metric_check;
ALTER TABLE public.sales_goals ADD CONSTRAINT sales_goals_metric_check CHECK (metric IN ('won_value', 'won_count'));
ALTER TABLE public.sales_goals DROP CONSTRAINT IF EXISTS sales_goals_month_check;
ALTER TABLE public.sales_goals ADD CONSTRAINT sales_goals_month_check CHECK (month = date_trunc('month', month)::date);
ALTER TABLE public.sales_goals DROP CONSTRAINT IF EXISTS sales_goals_target_check;
ALTER TABLE public.sales_goals ADD CONSTRAINT sales_goals_target_check CHECK (target IS NULL OR (target > 0 AND target <= 1000000000));
ALTER TABLE public.sales_goals DROP CONSTRAINT IF EXISTS sales_goals_scope_ref_check;
ALTER TABLE public.sales_goals ADD CONSTRAINT sales_goals_scope_ref_check CHECK (
  (scope = 'account' AND team_id IS NULL AND user_id IS NULL)
  OR (scope = 'team' AND team_id IS NOT NULL AND user_id IS NULL)
  OR (scope = 'member' AND team_id IS NULL AND user_id IS NOT NULL)
);
-- A count goal is a whole number of deals.
ALTER TABLE public.sales_goals DROP CONSTRAINT IF EXISTS sales_goals_count_whole_check;
ALTER TABLE public.sales_goals ADD CONSTRAINT sales_goals_count_whole_check CHECK (metric <> 'won_count' OR target IS NULL OR target = trunc(target));

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_goals_key ON public.sales_goals (
  account_id, scope,
  COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
  metric, month
);
CREATE INDEX IF NOT EXISTS idx_sales_goals_team ON public.sales_goals (team_id) WHERE team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_goals_user ON public.sales_goals (account_id, user_id) WHERE user_id IS NOT NULL;
-- "won in the month" aggregate.
CREATE INDEX IF NOT EXISTS idx_deals_account_won_closed ON public.deals (account_id, closed_at) WHERE status = 'won';

DROP TRIGGER IF EXISTS set_updated_at ON public.sales_goals;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.sales_goals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Guard: same-account team / member, immutable key, current month onward.
-- SECURITY DEFINER only to read teams / profiles regardless of the caller's
-- policies; the "user context" test mirrors readonly_guard (094): service
-- role and postgres jobs (backfills, tests seeding history) pass the
-- month rule, the same-account rules always apply.
CREATE OR REPLACE FUNCTION public.sales_goals_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current date;
  v_user_ctx boolean := current_user IN ('authenticated', 'anon') OR auth.uid() IS NOT NULL;
  v_row public.sales_goals;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  IF TG_OP <> 'DELETE' THEN
    IF NEW.team_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.teams t WHERE t.id = NEW.team_id AND t.account_id = NEW.account_id
    ) THEN
      RAISE EXCEPTION 'team does not belong to this account' USING ERRCODE = '23503';
    END IF;
    IF NEW.user_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.user_id = NEW.user_id AND p.account_id = NEW.account_id
    ) THEN
      RAISE EXCEPTION 'user is not a member of this account' USING ERRCODE = '23503';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.metric IS DISTINCT FROM OLD.metric OR NEW.month IS DISTINCT FROM OLD.month
  ) THEN
    RAISE EXCEPTION 'only the target of a goal can change' USING ERRCODE = '23514';
  END IF;

  IF v_user_ctx THEN
    v_current := date_trunc('month', now() AT TIME ZONE public.report_timezone(v_row.account_id))::date;
    IF v_row.month < v_current THEN
      RAISE EXCEPTION 'sales_goal_past_month: goals of past months are read-only' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.sales_goals_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS sales_goals_guard ON public.sales_goals;
CREATE TRIGGER sales_goals_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sales_goals
  FOR EACH ROW EXECUTE FUNCTION public.sales_goals_guard();

-- ---- RLS ------------------------------------------------------------
ALTER TABLE public.sales_goals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_goals_select ON public.sales_goals;
CREATE POLICY sales_goals_select ON public.sales_goals FOR SELECT USING (
  public.is_account_member(account_id, 'admin')
  OR (
    public.is_account_member(account_id)
    AND (
      scope = 'account'
      OR (scope = 'member' AND user_id = (SELECT auth.uid()))
      OR (scope = 'team' AND EXISTS (
        SELECT 1 FROM public.team_members tm
         WHERE tm.team_id = sales_goals.team_id AND tm.user_id = (SELECT auth.uid())
      ))
    )
  )
);
DROP POLICY IF EXISTS sales_goals_insert ON public.sales_goals;
CREATE POLICY sales_goals_insert ON public.sales_goals FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS sales_goals_update ON public.sales_goals;
CREATE POLICY sales_goals_update ON public.sales_goals FOR UPDATE
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS sales_goals_delete ON public.sales_goals;
CREATE POLICY sales_goals_delete ON public.sales_goals FOR DELETE USING (public.is_account_member(account_id, 'admin'));

-- 094: a read-only (billing) account does not write.
DROP POLICY IF EXISTS sales_goals_readonly_insert ON public.sales_goals;
CREATE POLICY sales_goals_readonly_insert ON public.sales_goals AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS sales_goals_readonly_update ON public.sales_goals;
CREATE POLICY sales_goals_readonly_update ON public.sales_goals AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS sales_goals_readonly_delete ON public.sales_goals;
CREATE POLICY sales_goals_readonly_delete ON public.sales_goals AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

-- ---- progress ---------------------------------------------------------
-- Column names of the result are the table's; every reference in the body
-- is qualified with an alias so plpgsql never reads them as variables.
CREATE OR REPLACE FUNCTION public.sales_goal_progress(p_account_id uuid, p_month date)
RETURNS TABLE (
  scope      text,
  team_id    uuid,
  user_id    uuid,
  metric     text,
  target     numeric,
  achieved   numeric,
  since      date
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tz       text;
  v_month    date;
  v_from     timestamptz;
  v_to       timestamptz;
  v_currency text;
BEGIN
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'month is required' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'not a member of this account' USING ERRCODE = '42501';
  END IF;

  v_tz := public.report_timezone(p_account_id);
  v_month := date_trunc('month', p_month)::date;
  v_from := v_month::timestamp AT TIME ZONE v_tz;
  v_to := (v_month + INTERVAL '1 month')::timestamp AT TIME ZONE v_tz;
  SELECT a.default_currency INTO v_currency FROM public.accounts a WHERE a.id = p_account_id;

  RETURN QUERY
  WITH resolved AS (
    SELECT DISTINCT ON (g.scope, g.team_id, g.user_id, g.metric)
           g.scope, g.team_id, g.user_id, g.metric, g.target, g.month
      FROM public.sales_goals g
     WHERE g.account_id = p_account_id AND g.month <= v_month
     ORDER BY g.scope, g.team_id, g.user_id, g.metric, g.month DESC
  ), live AS (
    SELECT r.*
      FROM resolved r
     WHERE r.target IS NOT NULL
       AND (r.scope <> 'team' OR EXISTS (
              SELECT 1 FROM public.teams t WHERE t.id = r.team_id AND t.archived_at IS NULL))
       AND (r.scope <> 'member' OR EXISTS (
              SELECT 1 FROM public.profiles p WHERE p.user_id = r.user_id AND p.account_id = p_account_id))
  )
  SELECT l.scope, l.team_id, l.user_id, l.metric, l.target, x.achieved, l.month
    FROM live l
    CROSS JOIN LATERAL (
      SELECT COALESCE(CASE WHEN l.metric = 'won_count' THEN count(*)::numeric ELSE sum(d.value) END, 0) AS achieved
        FROM public.deals d
       WHERE d.account_id = p_account_id
         AND d.status = 'won'
         AND d.closed_at >= v_from AND d.closed_at < v_to
         AND (l.metric = 'won_count' OR d.currency = v_currency)
         AND (
           l.scope = 'account'
           OR (l.scope = 'member' AND d.assigned_to = (
                 SELECT p.id FROM public.profiles p WHERE p.user_id = l.user_id AND p.account_id = p_account_id))
           OR (l.scope = 'team' AND d.assigned_to IN (
                 SELECT p.id FROM public.team_members tm
                   JOIN public.profiles p ON p.user_id = tm.user_id AND p.account_id = p_account_id
                  WHERE tm.team_id = l.team_id))
         )
    ) x
   ORDER BY CASE l.scope WHEN 'account' THEN 0 WHEN 'team' THEN 1 ELSE 2 END, l.metric;
END;
$$;

-- Upsert "from this month on". NULL target removes the goal from p_month on.
-- SECURITY INVOKER: RLS (admin) and the guard trigger (current month onward)
-- decide; the explicit check just gives a clear error.
CREATE OR REPLACE FUNCTION public.sales_goal_set(
  p_account_id uuid,
  p_scope      text,
  p_team_id    uuid,
  p_user_id    uuid,
  p_metric     text,
  p_month      date,
  p_target     numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'goals are set by account admins' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.sales_goals (account_id, scope, team_id, user_id, metric, month, target)
  VALUES (p_account_id, p_scope, p_team_id, p_user_id, p_metric, date_trunc('month', p_month)::date, p_target)
  ON CONFLICT (
    account_id, scope,
    COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    metric, month
  ) DO UPDATE SET target = EXCLUDED.target;
END;
$$;

REVOKE ALL ON FUNCTION public.sales_goal_progress(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_goal_progress(uuid, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.sales_goal_set(uuid, text, uuid, uuid, text, date, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_goal_set(uuid, text, uuid, uuid, text, date, numeric) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
