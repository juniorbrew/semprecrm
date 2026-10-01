-- ============================================================
-- 075_support_reports.sql — SempreCRM for support: reports.
--
-- support_report(): ONE aggregated, exact query (no row limits, no
-- sampling) behind every table of /reports. p_group picks the grouping:
--   'all' | 'category' | 'team' | 'agent' | 'priority'
-- and returns, per group key (the id as text, or the priority; NULL = none,
-- internally '~'):
--   opened / resolved in the period, backlog now (open + pending),
--   first-response and resolution times (count, average, median, p90, in
--   seconds), SLA met / missed (first-response and resolution targets of
--   the conversations OPENED in the period; a target still in the future
--   is not judged), reopened (service_count > 1, of those opened) and the
--   satisfaction survey (csat_sent / csat_answered / csat_avg of the
--   surveys SENT in the period, grouped by the snapshot taken at send).
-- support_report_backlog(): open + pending conversations by age.
--
-- Period: p_from..p_to are CALENDAR DAYS (inclusive) in the account's time
-- zone (accounts.preferences.business_hours.timezone, default
-- America/Sao_Paulo); the bounds are converted once, so a day is a day for
-- the account, not for the server.
-- Filters (all optional): team, category, agent (assigned), channel.
--
-- SECURITY INVOKER: every row is read under the caller's RLS, and the
-- function also requires an admin / owner of p_account_id (the reports page
-- is admin-gated; this is the same rule in the database). The account id
-- is part of every WHERE, so another tenant's rows can never appear.
-- No personal data is returned: no contact, no message, no comment.
--
-- Index: (account_id, created_at) for "opened in the period".
-- NOTE (large tables): plain CREATE INDEX blocks writes while it builds;
-- on a very large conversations table create it first by hand with
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_account_created ...
--
-- Idempotent.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_conversations_account_created
  ON public.conversations (account_id, created_at);

-- The account's time zone; an unknown name falls back to the default.
CREATE OR REPLACE FUNCTION public.report_timezone(p_account_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT n.name FROM public.accounts a
       JOIN pg_catalog.pg_timezone_names n ON n.name = a.preferences->'business_hours'->>'timezone'
      WHERE a.id = p_account_id),
    'America/Sao_Paulo');
$$;

DROP FUNCTION IF EXISTS public.support_report(uuid, date, date, text, uuid, uuid, uuid, text);
CREATE OR REPLACE FUNCTION public.support_report(
  p_account_id  uuid,
  p_from        date,
  p_to          date,
  p_group       text DEFAULT 'all',
  p_team_id     uuid DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_agent_id    uuid DEFAULT NULL,
  p_channel     text DEFAULT NULL
) RETURNS TABLE (
  group_key         text,
  opened            bigint,
  resolved          bigint,
  backlog           bigint,
  fr_count          bigint,
  fr_avg_seconds    double precision,
  fr_median_seconds double precision,
  fr_p90_seconds    double precision,
  res_count         bigint,
  res_avg_seconds   double precision,
  res_median_seconds double precision,
  res_p90_seconds   double precision,
  sla_met           bigint,
  sla_missed        bigint,
  reopened          bigint,
  csat_sent         bigint,
  csat_answered     bigint,
  csat_avg          numeric
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tz   text;
  v_from timestamptz;
  v_to   timestamptz;
  v_now  timestamptz := now();
BEGIN
  IF NOT public.is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'reports are for account admins' USING ERRCODE = '42501';
  END IF;
  IF p_group IS NULL OR p_group NOT IN ('all', 'category', 'team', 'agent', 'priority') THEN
    RAISE EXCEPTION 'invalid group %', p_group USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NOT NULL AND p_channel NOT IN ('official', 'qr') THEN
    RAISE EXCEPTION 'invalid channel %', p_channel USING ERRCODE = '22023';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'invalid period' USING ERRCODE = '22023';
  END IF;

  v_tz   := public.report_timezone(p_account_id);
  v_from := p_from::timestamp AT TIME ZONE v_tz;
  v_to   := (p_to + 1)::timestamp AT TIME ZONE v_tz;

  RETURN QUERY
  WITH conv AS (
    SELECT
      COALESCE(
      CASE p_group
        WHEN 'category' THEN c.category_id::text
        WHEN 'team'     THEN c.team_id::text
        WHEN 'agent'    THEN c.assigned_agent_id::text
        WHEN 'priority' THEN c.priority
        ELSE 'all'
      END,
        '~') AS k,
      c.status, c.created_at, c.resolved_at, c.service_count,
      c.first_response_at, c.first_response_seconds, c.first_response_due_at,
      c.last_customer_message_at, c.resolution_due_at,
      (c.created_at >= v_from AND c.created_at < v_to) AS in_opened,
      (c.status = 'closed' AND c.resolved_at >= v_from AND c.resolved_at < v_to) AS in_resolved,
      (c.first_response_at >= v_from AND c.first_response_at < v_to AND c.first_response_seconds IS NOT NULL) AS in_fr
    FROM public.conversations c
    WHERE c.account_id = p_account_id
      AND (p_team_id IS NULL OR c.team_id = p_team_id)
      AND (p_category_id IS NULL OR c.category_id = p_category_id)
      AND (p_agent_id IS NULL OR c.assigned_agent_id = p_agent_id)
      AND (p_channel IS NULL OR c.channel = p_channel)
      AND ((c.created_at >= v_from AND c.created_at < v_to)
           OR (c.resolved_at >= v_from AND c.resolved_at < v_to)
           OR (c.first_response_at >= v_from AND c.first_response_at < v_to)
           OR c.status <> 'closed')
  ),
  agg AS (
    SELECT
      k,
      count(*) FILTER (WHERE in_opened) AS opened,
      count(*) FILTER (WHERE in_resolved) AS resolved,
      count(*) FILTER (WHERE status <> 'closed') AS backlog,
      count(*) FILTER (WHERE in_fr) AS fr_count,
      avg(first_response_seconds) FILTER (WHERE in_fr)::double precision AS fr_avg,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY first_response_seconds) FILTER (WHERE in_fr))::double precision AS fr_med,
      (percentile_cont(0.9) WITHIN GROUP (ORDER BY first_response_seconds) FILTER (WHERE in_fr))::double precision AS fr_p90,
      count(*) FILTER (WHERE in_resolved) AS res_count,
      avg(extract(epoch FROM resolved_at - created_at)) FILTER (WHERE in_resolved)::double precision AS res_avg,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at)) FILTER (WHERE in_resolved))::double precision AS res_med,
      (percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at)) FILTER (WHERE in_resolved))::double precision AS res_p90,
      -- first-response target
      count(*) FILTER (WHERE in_opened AND first_response_due_at IS NOT NULL AND last_customer_message_at IS NOT NULL
                        AND first_response_at IS NOT NULL AND first_response_at <= first_response_due_at)
      -- resolution target
      + count(*) FILTER (WHERE in_opened AND resolution_due_at IS NOT NULL AND status = 'closed'
                          AND resolved_at IS NOT NULL AND resolved_at <= resolution_due_at) AS sla_met,
      count(*) FILTER (WHERE in_opened AND first_response_due_at IS NOT NULL AND last_customer_message_at IS NOT NULL
                        AND ((first_response_at IS NOT NULL AND first_response_at > first_response_due_at)
                             OR (first_response_at IS NULL AND first_response_due_at <= v_now)))
      + count(*) FILTER (WHERE in_opened AND resolution_due_at IS NOT NULL
                          AND ((status = 'closed' AND resolved_at IS NOT NULL AND resolved_at > resolution_due_at)
                               OR (status <> 'closed' AND resolution_due_at <= v_now))) AS sla_missed,
      count(*) FILTER (WHERE in_opened AND service_count > 1) AS reopened
    FROM conv
    GROUP BY k
  ),
  sat AS (
    SELECT
      COALESCE(
      CASE p_group
        WHEN 'category' THEN s.category_id::text
        WHEN 'team'     THEN s.team_id::text
        WHEN 'agent'    THEN s.assigned_agent_id::text
        WHEN 'priority' THEN s.priority
        ELSE 'all'
      END,
        '~') AS k,
      count(*) AS sent,
      count(*) FILTER (WHERE s.status = 'answered') AS answered,
      avg(s.score) FILTER (WHERE s.status = 'answered') AS avg_score
    FROM public.csat_responses s
    JOIN public.conversations c2 ON c2.id = s.conversation_id
    WHERE s.account_id = p_account_id
      AND s.status <> 'skipped'
      AND s.sent_at >= v_from AND s.sent_at < v_to
      AND (p_team_id IS NULL OR s.team_id = p_team_id)
      AND (p_category_id IS NULL OR s.category_id = p_category_id)
      AND (p_agent_id IS NULL OR s.assigned_agent_id = p_agent_id)
      AND (p_channel IS NULL OR c2.channel = p_channel)
    GROUP BY 1
  )
  SELECT
    NULLIF(COALESCE(a.k, s2.k), '~'),
    COALESCE(a.opened, 0), COALESCE(a.resolved, 0), COALESCE(a.backlog, 0),
    COALESCE(a.fr_count, 0), a.fr_avg, a.fr_med, a.fr_p90,
    COALESCE(a.res_count, 0), a.res_avg, a.res_med, a.res_p90,
    COALESCE(a.sla_met, 0), COALESCE(a.sla_missed, 0), COALESCE(a.reopened, 0),
    COALESCE(s2.sent, 0), COALESCE(s2.answered, 0), round(s2.avg_score, 2)
  FROM agg a
  FULL OUTER JOIN sat s2 ON s2.k = a.k
  ORDER BY COALESCE(a.opened, 0) DESC, COALESCE(a.k, s2.k) NULLS LAST;
END;
$$;

DROP FUNCTION IF EXISTS public.support_report_backlog(uuid, uuid, uuid, uuid, text);
CREATE OR REPLACE FUNCTION public.support_report_backlog(
  p_account_id  uuid,
  p_team_id     uuid DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_agent_id    uuid DEFAULT NULL,
  p_channel     text DEFAULT NULL
) RETURNS TABLE (bucket text, total bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'reports are for account admins' USING ERRCODE = '42501';
  END IF;
  IF p_channel IS NOT NULL AND p_channel NOT IN ('official', 'qr') THEN
    RAISE EXCEPTION 'invalid channel %', p_channel USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH live AS (
    SELECT CASE
             WHEN now() - c.created_at < INTERVAL '1 day'  THEN 'lt1d'
             WHEN now() - c.created_at < INTERVAL '3 days' THEN 'd1_3'
             WHEN now() - c.created_at < INTERVAL '7 days' THEN 'd3_7'
             ELSE 'gt7'
           END AS b
      FROM public.conversations c
     WHERE c.account_id = p_account_id
       AND c.status <> 'closed' AND c.archived_at IS NULL
       AND (p_team_id IS NULL OR c.team_id = p_team_id)
       AND (p_category_id IS NULL OR c.category_id = p_category_id)
       AND (p_agent_id IS NULL OR c.assigned_agent_id = p_agent_id)
       AND (p_channel IS NULL OR c.channel = p_channel)
  )
  SELECT v.bucket, count(l.b)
    FROM (VALUES ('lt1d', 1), ('d1_3', 2), ('d3_7', 3), ('gt7', 4)) AS v(bucket, ord)
    LEFT JOIN live l ON l.b = v.bucket
   GROUP BY v.bucket, v.ord
   ORDER BY v.ord;
END;
$$;

REVOKE ALL ON FUNCTION public.report_timezone(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_timezone(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.support_report(uuid, date, date, text, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.support_report(uuid, date, date, text, uuid, uuid, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.support_report_backlog(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.support_report_backlog(uuid, uuid, uuid, uuid, text) TO authenticated, service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.report_timezone(uuid)',
    'public.support_report(uuid, date, date, text, uuid, uuid, uuid, text)',
    'public.support_report_backlog(uuid, uuid, uuid, uuid, text)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'unexpected EXECUTE privileges on %', f;
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
