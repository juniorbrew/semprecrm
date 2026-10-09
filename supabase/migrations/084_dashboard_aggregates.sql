-- ============================================================
-- 084: dashboard aggregates in SQL.
--
-- src/lib/dashboard/queries.ts pulled raw rows (every message of the
-- last 7/30/90 days, 14 days for response time, every open deal) and
-- summed them in the browser. PostgREST caps a read at max_rows (1000),
-- so past that the charts silently undercounted — and the payload grew
-- with the account. These return the aggregates instead.
--
-- SECURITY INVOKER (default): RLS scopes the rows exactly as the old
-- table reads did. p_tz is the browser's IANA zone (the old code bucketed
-- by the browser's local day); an unknown zone falls back to UTC.
-- Grants are explicit (076 revokes default EXECUTE).
-- ============================================================

CREATE OR REPLACE FUNCTION public.dashboard_tz(p_tz text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_tz IS NULL OR p_tz !~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$' THEN
    RETURN 'UTC';
  END IF;
  PERFORM now() AT TIME ZONE p_tz;
  RETURN p_tz;
EXCEPTION
  WHEN invalid_parameter_value THEN
    RETURN 'UTC';
END;
$$;

-- Messages per local day since p_start: customer = incoming, agent/bot = outgoing.
CREATE OR REPLACE FUNCTION public.dashboard_message_series(p_start timestamptz, p_tz text)
RETURNS TABLE (day date, incoming integer, outgoing integer)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (m.created_at AT TIME ZONE public.dashboard_tz(p_tz))::date,
         (count(*) FILTER (WHERE m.sender_type = 'customer'))::integer,
         (count(*) FILTER (WHERE m.sender_type IS DISTINCT FROM 'customer'))::integer
    FROM public.messages m
   WHERE m.created_at >= p_start
   GROUP BY 1
   ORDER BY 1;
$$;

-- First-response samples since p_start, same pairing as the old client
-- loop: per conversation, the first customer message after the last
-- outbound pairs with the next outbound. `grp` = outbounds strictly
-- before the row, so a group holds the waiting customer messages plus
-- the one outbound that answers them.
-- Returns { buckets: [{dow, sum_minutes, samples}] (0 = Monday),
--           this_week: {sum_minutes, samples}, last_week: {...} }.
CREATE OR REPLACE FUNCTION public.dashboard_response_time(
  p_start           timestamptz,
  p_tz              text,
  p_this_week_start timestamptz,
  p_last_week_start timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH m AS (
    SELECT m.conversation_id,
           m.sender_type,
           m.created_at,
           count(*) FILTER (WHERE m.sender_type IS DISTINCT FROM 'customer') OVER (
             PARTITION BY m.conversation_id
             ORDER BY m.created_at, m.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ) AS grp
      FROM public.messages m
     WHERE m.created_at >= p_start
  ),
  pairs AS (
    SELECT min(created_at) FILTER (WHERE sender_type = 'customer') AS customer_at,
           min(created_at) FILTER (WHERE sender_type IS DISTINCT FROM 'customer') AS response_at
      FROM m
     GROUP BY conversation_id, coalesce(grp, 0)
  ),
  samples AS (
    SELECT customer_at,
           (extract(epoch FROM response_at - customer_at) / 60.0)::double precision AS minutes,
           (extract(isodow FROM customer_at AT TIME ZONE public.dashboard_tz(p_tz)) - 1)::integer AS dow
      FROM pairs
     WHERE customer_at IS NOT NULL
       AND response_at IS NOT NULL
       AND response_at >= customer_at
  )
  SELECT jsonb_build_object(
    'buckets', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'sum_minutes', s, 'samples', n) ORDER BY dow), '[]'::jsonb)
        FROM (SELECT dow, sum(minutes) AS s, count(*) AS n FROM samples GROUP BY dow) b
    ),
    'this_week', (
      SELECT jsonb_build_object('sum_minutes', coalesce(sum(minutes), 0), 'samples', count(*))
        FROM samples WHERE customer_at >= p_this_week_start
    ),
    'last_week', (
      SELECT jsonb_build_object('sum_minutes', coalesce(sum(minutes), 0), 'samples', count(*))
        FROM samples WHERE customer_at >= p_last_week_start AND customer_at < p_this_week_start
    )
  );
$$;

-- Open deals per stage (count and value): the metric card sums all rows,
-- the pipeline donut joins them to the stages.
CREATE OR REPLACE FUNCTION public.dashboard_open_deals_by_stage()
RETURNS TABLE (stage_id uuid, deal_count integer, total_value numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT d.stage_id, count(*)::integer, coalesce(sum(d.value), 0)
    FROM public.deals d
   WHERE d.status = 'open'
   GROUP BY d.stage_id;
$$;

REVOKE ALL ON FUNCTION public.dashboard_tz(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_tz(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.dashboard_message_series(timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_message_series(timestamptz, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.dashboard_response_time(timestamptz, text, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_response_time(timestamptz, text, timestamptz, timestamptz) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.dashboard_open_deals_by_stage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_open_deals_by_stage() TO authenticated, service_role;
