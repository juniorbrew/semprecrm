-- ============================================================
-- 111_indicadores.sql — Reports: ad spend, AI result, team performance ("Indicadores da empresa", part A).
--
-- Spec: docs/superpowers/specs/2026-11-15-indicadores-e-extras.md (Parte A)
--
-- What this migration does
--   1. ad_spend: what the admin typed as spent on an ad / campaign in a month. Key = the bucket the
--      origin report already groups by (origin_type, channel, name, source) + month. Members read; only
--      admin+ (owner counts) writes. The currency is stamped from accounts.default_currency, updated_by /
--      updated_at by a trigger. Billing block (094): RESTRICTIVE INSERT / UPDATE / DELETE policies, like
--      the CRM tables of 094. Grants follow 076: nothing for PUBLIC/anon, then narrow GRANTs.
--   2. origin_report() is recreated with a new last column spend_cents and an optional p_timezone: the
--      spend counts by WHOLE MONTHS the period touches (in that time zone). spend_cents is NULL when no
--      spend was typed for the bucket, and always NULL while a pipeline filter is set (a spend belongs
--      to the ad, not to a pipeline). Every other column / rule of 109 is unchanged.
--   3. ai_report(account, since, until): the AI result (SECURITY INVOKER, members only, <= 400 days).
--   4. team_report(account, since, until): dashboard_team_metrics (086) bounded by an end date, plus the
--      deals of each member (deals.assigned_to -> profiles.id) closed in the period. SECURITY INVOKER.
--
-- Rollback: supabase/rollback/111_rollback.sql. SQL test: supabase/tests/indicadores.sql. Idempotent.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---- ad_spend -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ad_spend (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  origin_type  TEXT NOT NULL,
  channel      TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT '',
  month        DATE NOT NULL,
  amount_cents BIGINT NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'BRL',
  updated_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ad_spend_key UNIQUE (account_id, origin_type, channel, name, source, month)
);

ALTER TABLE public.ad_spend DROP CONSTRAINT IF EXISTS ad_spend_check;
ALTER TABLE public.ad_spend ADD CONSTRAINT ad_spend_check CHECK (
  origin_type IN ('ad', 'campaign', 'referrer', 'paid')
  AND channel IN ('', 'whatsapp', 'whatsapp_qr', 'instagram', 'messenger', 'site_bot', 'webhook')
  AND char_length(name) BETWEEN 1 AND 300
  AND char_length(source) <= 120
  AND month = date_trunc('month', month)::date          -- first day of the month
  AND amount_cents BETWEEN 0 AND 100000000000           -- up to 1 billion in the currency
  AND char_length(currency) = 3
);

CREATE INDEX IF NOT EXISTS idx_ad_spend_account_month ON public.ad_spend (account_id, month);

-- A user session cannot choose who / when / which currency: they are stamped here.
CREATE OR REPLACE FUNCTION public.ad_spend_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF private.is_user_session() THEN
    NEW.updated_by := auth.uid();
    NEW.updated_at := now();
    NEW.currency := coalesce((SELECT a.default_currency FROM public.accounts a WHERE a.id = NEW.account_id), 'BRL');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ad_spend_stamp() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS ad_spend_stamp ON public.ad_spend;
CREATE TRIGGER ad_spend_stamp BEFORE INSERT OR UPDATE ON public.ad_spend
  FOR EACH ROW EXECUTE FUNCTION public.ad_spend_stamp();

REVOKE ALL ON public.ad_spend FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_spend TO authenticated;
GRANT ALL ON public.ad_spend TO service_role;

ALTER TABLE public.ad_spend ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ad_spend_select ON public.ad_spend;
CREATE POLICY ad_spend_select ON public.ad_spend FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS ad_spend_insert ON public.ad_spend;
CREATE POLICY ad_spend_insert ON public.ad_spend FOR INSERT TO authenticated
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ad_spend_update ON public.ad_spend;
CREATE POLICY ad_spend_update ON public.ad_spend FOR UPDATE TO authenticated
  USING (public.is_account_member(account_id, 'admin')) WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ad_spend_delete ON public.ad_spend;
CREATE POLICY ad_spend_delete ON public.ad_spend FOR DELETE TO authenticated
  USING (public.is_account_member(account_id, 'admin'));

-- 094: a read-only account (trial ended / payment overdue) writes nothing.
DROP POLICY IF EXISTS ad_spend_readonly_insert ON public.ad_spend;
CREATE POLICY ad_spend_readonly_insert ON public.ad_spend AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ad_spend_readonly_update ON public.ad_spend;
CREATE POLICY ad_spend_readonly_update ON public.ad_spend AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ad_spend_readonly_delete ON public.ad_spend;
CREATE POLICY ad_spend_readonly_delete ON public.ad_spend AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

-- ---- origin_report + spend_cents ------------------------------------------------
-- Same body as 109 (cohorts, buckets, 400-day guard) plus the spend of the months the period touches.
DROP FUNCTION IF EXISTS public.origin_report(timestamptz, timestamptz, text, uuid);
DROP FUNCTION IF EXISTS public.origin_report(timestamptz, timestamptz, text, uuid, text);
CREATE OR REPLACE FUNCTION public.origin_report(
  p_start       timestamptz,
  p_end         timestamptz,
  p_channel     text DEFAULT NULL,
  p_pipeline_id uuid DEFAULT NULL,
  p_timezone    text DEFAULT NULL
)
RETURNS TABLE (
  origin_type    text,
  channel        text,
  name           text,
  source         text,
  customers      integer,
  deals_created  integer,
  deals_won      integer,
  won_value      numeric,
  conversion_pct numeric,
  avg_ticket     numeric,
  spend_cents    bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tz text := coalesce(nullif(btrim(p_timezone), ''), 'UTC');
  v_m1 date;
  v_m2 date;
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) THEN
    RAISE EXCEPTION 'origin_report needs a finite period' USING ERRCODE = '22023';
  END IF;
  IF p_end - p_start > interval '400 days' THEN
    RAISE EXCEPTION 'origin_report period is limited to 400 days' USING ERRCODE = '22023';
  END IF;
  -- First and last calendar month (in the account's time zone) that the period [p_start, p_end) touches.
  v_m1 := date_trunc('month', p_start AT TIME ZONE v_tz)::date;
  v_m2 := date_trunc('month', (p_end - interval '1 microsecond') AT TIME ZONE v_tz)::date;

  RETURN QUERY
  WITH cust AS (
    SELECT b.t, b.ch, b.nm, b.src, count(*)::integer AS n
      FROM public.contacts c
      LEFT JOIN public.lead_origins o ON o.id = c.first_origin_id
      CROSS JOIN LATERAL (SELECT * FROM private.origin_bucket(o.kind, o.channel, o.headline, o.ad_id, o.source_id,
                                                              o.utm_campaign, o.utm_source, o.referrer_host, o.click_id_type)) b
     WHERE c.created_at >= p_start AND c.created_at < p_end
       AND (p_pipeline_id IS NULL OR EXISTS (
             SELECT 1 FROM public.deals d WHERE d.contact_id = c.id AND d.pipeline_id = p_pipeline_id))
     GROUP BY 1, 2, 3, 4
  ),
  dl AS (
    SELECT b.t, b.ch, b.nm, b.src,
           count(*)::integer AS created,
           (count(*) FILTER (WHERE d.status = 'won'))::integer AS won,
           coalesce(sum(d.value) FILTER (WHERE d.status = 'won'), 0) AS won_value
      FROM public.deals d
      LEFT JOIN public.lead_origins o ON o.id = d.origin_id
      CROSS JOIN LATERAL (SELECT * FROM private.origin_bucket(o.kind, o.channel, o.headline, o.ad_id, o.source_id,
                                                              o.utm_campaign, o.utm_source, o.referrer_host, o.click_id_type)) b
     WHERE d.created_at >= p_start AND d.created_at < p_end
       AND (p_pipeline_id IS NULL OR d.pipeline_id = p_pipeline_id)
     GROUP BY 1, 2, 3, 4
  ),
  sp AS (
    SELECT s.origin_type AS t, s.channel AS ch, s.name AS nm, s.source AS src, sum(s.amount_cents)::bigint AS cents
      FROM public.ad_spend s
     WHERE p_pipeline_id IS NULL AND s.month >= v_m1 AND s.month <= v_m2
     GROUP BY 1, 2, 3, 4
  ),
  joined AS (
    SELECT coalesce(c.t, d.t, s.t) AS t, coalesce(c.ch, d.ch, s.ch) AS ch,
           coalesce(c.nm, d.nm, s.nm) AS nm, coalesce(c.src, d.src, s.src) AS src,
           coalesce(c.n, 0) AS customers, coalesce(d.created, 0) AS created, coalesce(d.won, 0) AS won,
           coalesce(d.won_value, 0) AS won_value, s.cents AS spend
      FROM cust c
      FULL JOIN dl d ON d.t = c.t AND d.ch = c.ch AND d.nm = c.nm AND d.src = c.src
      FULL JOIN sp s ON s.t = coalesce(c.t, d.t) AND s.ch = coalesce(c.ch, d.ch)
                    AND s.nm = coalesce(c.nm, d.nm) AND s.src = coalesce(c.src, d.src)
  )
  SELECT j.t, j.ch, j.nm, j.src, j.customers, j.created, j.won, j.won_value,
         CASE WHEN j.created > 0 THEN round(100.0 * j.won / j.created, 1) ELSE 0 END,
         CASE WHEN j.won > 0 THEN round(j.won_value / j.won, 2) ELSE 0 END,
         j.spend
    FROM joined j
   WHERE p_channel IS NULL OR j.ch = p_channel
   ORDER BY j.won_value DESC, j.won DESC, j.customers DESC, j.nm
   LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION public.origin_report(timestamptz, timestamptz, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.origin_report(timestamptz, timestamptz, text, uuid, text) TO authenticated, service_role;

-- ---- ai_report -----------------------------------------------------------------
-- One row. attended = conversations with at least one AI message (messages.origin = 'ai') in the period.
-- handed_off = attended conversations with an ai_handoff event in the period; top_reason = the most
-- common payload reason of those events. resolved_without_person = attended conversations closed in the
-- period (status_changed -> closed) that never had a message from a person (sender_type = 'agent').
-- cost_by_feature (USD cents per ai_usage.feature, ok/error rows, never 'blocked') is NULL unless the
-- caller is admin+: ai_usage is admin-only (058) and the cost must not leak to agents / viewers.
CREATE OR REPLACE FUNCTION public.ai_report(p_account_id uuid, p_start timestamptz, p_end timestamptz)
RETURNS TABLE (
  ai_enabled              boolean,
  attended                integer,
  handed_off              integer,
  top_reason              text,
  top_reason_count        integer,
  resolved_without_person integer,
  ai_messages             integer,
  cost_by_feature         jsonb
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) THEN
    RAISE EXCEPTION 'ai_report needs a finite period' USING ERRCODE = '22023';
  END IF;
  IF p_end - p_start > interval '400 days' THEN
    RAISE EXCEPTION 'ai_report period is limited to 400 days' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'not a member of this account' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH ai_msgs AS (
    SELECT m.conversation_id
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
     WHERE c.account_id = p_account_id AND m.origin = 'ai'
       AND m.created_at >= p_start AND m.created_at < p_end
  ),
  att AS (SELECT DISTINCT conversation_id FROM ai_msgs),
  hand AS (
    SELECT e.conversation_id, e.payload->>'reason' AS reason
      FROM public.conversation_events e
      JOIN att a ON a.conversation_id = e.conversation_id
     WHERE e.account_id = p_account_id AND e.event_type = 'ai_handoff'
       AND e.created_at >= p_start AND e.created_at < p_end
  ),
  top AS (
    SELECT h.reason, count(*)::integer AS n FROM hand h WHERE h.reason IS NOT NULL
     GROUP BY h.reason ORDER BY count(*) DESC, h.reason LIMIT 1
  ),
  closed_alone AS (
    SELECT DISTINCT e.conversation_id
      FROM public.conversation_events e
      JOIN att a ON a.conversation_id = e.conversation_id
     WHERE e.account_id = p_account_id AND e.event_type = 'status_changed'
       AND e.payload->>'status' = 'closed'
       AND e.created_at >= p_start AND e.created_at < p_end
       AND NOT EXISTS (SELECT 1 FROM public.messages m
                        WHERE m.conversation_id = e.conversation_id AND m.sender_type = 'agent')
  )
  SELECT coalesce((SELECT s.enabled FROM public.ai_settings s WHERE s.account_id = p_account_id), false),
         (SELECT count(*) FROM att)::integer,
         (SELECT count(DISTINCT h.conversation_id) FROM hand h)::integer,
         (SELECT t.reason FROM top t),
         coalesce((SELECT t.n FROM top t), 0),
         (SELECT count(*) FROM closed_alone)::integer,
         (SELECT count(*) FROM ai_msgs)::integer,
         CASE WHEN public.is_account_member(p_account_id, 'admin') THEN
           (SELECT coalesce(jsonb_agg(jsonb_build_object('feature', u.feature, 'calls', u.calls, 'cost_cents', u.cost)
                                      ORDER BY u.cost DESC, u.feature), '[]'::jsonb)
              FROM (SELECT x.feature, count(*) AS calls, coalesce(sum(x.cost_cents), 0) AS cost
                      FROM public.ai_usage x
                     WHERE x.account_id = p_account_id AND x.status IN ('ok', 'error')
                       AND x.created_at >= p_start AND x.created_at < p_end
                     GROUP BY x.feature) u)
         END;
END;
$$;
REVOKE ALL ON FUNCTION public.ai_report(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_report(uuid, timestamptz, timestamptz) TO authenticated, service_role;

-- ---- team_report ---------------------------------------------------------------
-- One row per member of the account (people who left are not in profiles, so they drop out). Same rules
-- as dashboard_team_metrics (086) but bounded by p_end; open_assigned is "right now" (no period).
-- Deals: closed in the period (deals.closed_at, 070), by deals.assigned_to (profiles.id -> user_id).
-- Win rate (won / (won + lost)) is left to the app: it is a division by a possible zero.
CREATE OR REPLACE FUNCTION public.team_report(p_account_id uuid, p_start timestamptz, p_end timestamptz)
RETURNS TABLE (
  user_id                       uuid,
  handled                       integer,
  resolved                      integer,
  first_response_avg_seconds    double precision,
  first_response_median_seconds double precision,
  first_response_samples        integer,
  tasks_completed               integer,
  open_assigned                 integer,
  deals_won                     integer,
  deals_lost                    integer,
  won_value                     numeric
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) THEN
    RAISE EXCEPTION 'team_report needs a finite period' USING ERRCODE = '22023';
  END IF;
  IF p_end - p_start > interval '400 days' THEN
    RAISE EXCEPTION 'team_report period is limited to 400 days' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'not a member of this account' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH handled AS (
    SELECT m.sender_id AS uid, count(DISTINCT m.conversation_id) AS n
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
     WHERE c.account_id = p_account_id AND m.sender_type = 'agent' AND m.sender_id IS NOT NULL
       AND m.created_at >= p_start AND m.created_at < p_end
     GROUP BY m.sender_id
  ),
  resolved AS (
    SELECT e.actor_user_id AS uid, count(*) AS n
      FROM public.conversation_events e
     WHERE e.account_id = p_account_id AND e.event_type = 'status_changed'
       AND e.actor_user_id IS NOT NULL AND e.payload->>'status' = 'closed'
       AND e.created_at >= p_start AND e.created_at < p_end
     GROUP BY e.actor_user_id
  ),
  fr AS (
    SELECT c.first_response_by AS uid,
           avg(c.first_response_seconds)::double precision AS avg_s,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY c.first_response_seconds) AS median_s,
           count(*) AS n
      FROM public.conversations c
     WHERE c.account_id = p_account_id AND c.first_response_by IS NOT NULL AND c.first_response_seconds >= 0
       AND c.first_response_at >= p_start AND c.first_response_at < p_end
     GROUP BY c.first_response_by
  ),
  tasks_done AS (
    SELECT t.assignee_user_id AS uid, count(*) AS n
      FROM public.tasks t
     WHERE t.account_id = p_account_id AND t.assignee_user_id IS NOT NULL
       AND t.completed_at >= p_start AND t.completed_at < p_end
     GROUP BY t.assignee_user_id
  ),
  open_now AS (
    SELECT c.assigned_agent_id AS uid, count(*) AS n
      FROM public.conversations c
     WHERE c.account_id = p_account_id AND c.status = 'open' AND c.assigned_agent_id IS NOT NULL
     GROUP BY c.assigned_agent_id
  ),
  dl AS (
    SELECT p.user_id AS uid,
           (count(*) FILTER (WHERE d.status = 'won'))::integer AS won,
           (count(*) FILTER (WHERE d.status = 'lost'))::integer AS lost,
           coalesce(sum(d.value) FILTER (WHERE d.status = 'won'), 0) AS won_value
      FROM public.deals d
      JOIN public.profiles p ON p.id = d.assigned_to AND p.account_id = p_account_id
     WHERE d.account_id = p_account_id AND d.status IN ('won', 'lost')
       AND d.closed_at >= p_start AND d.closed_at < p_end
     GROUP BY p.user_id
  )
  SELECT p.user_id,
         coalesce(h.n, 0)::integer, coalesce(r.n, 0)::integer,
         fr.avg_s, fr.median_s, coalesce(fr.n, 0)::integer,
         coalesce(t.n, 0)::integer, coalesce(o.n, 0)::integer,
         coalesce(dl.won, 0), coalesce(dl.lost, 0), coalesce(dl.won_value, 0)
    FROM public.profiles p
    LEFT JOIN handled h ON h.uid = p.user_id
    LEFT JOIN resolved r ON r.uid = p.user_id
    LEFT JOIN fr ON fr.uid = p.user_id
    LEFT JOIN tasks_done t ON t.uid = p.user_id
    LEFT JOIN open_now o ON o.uid = p.user_id
    LEFT JOIN dl ON dl.uid = p.user_id
   WHERE p.account_id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.team_report(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.team_report(uuid, timestamptz, timestamptz) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
