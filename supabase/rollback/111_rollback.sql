-- Rollback of 111_indicadores.sql. NOT a migration: run by hand (as postgres).
-- Roll the APP back first (Reports calls ai_report / team_report and reads ad_spend / spend_cents).
-- Deletes every typed ad spend (data loss). origin_report goes back to its 109 definition.
BEGIN;
DROP FUNCTION IF EXISTS public.team_report(uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.ai_report(uuid, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.origin_report(timestamptz, timestamptz, text, uuid, text);
DROP TABLE IF EXISTS public.ad_spend;  -- takes its policies, trigger and indexes along
DROP FUNCTION IF EXISTS public.ad_spend_stamp();
-- origin_report as 109 defined it
CREATE OR REPLACE FUNCTION public.origin_report(
  p_start       timestamptz,
  p_end         timestamptz,
  p_channel     text DEFAULT NULL,
  p_pipeline_id uuid DEFAULT NULL
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
  avg_ticket     numeric
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) THEN
    RAISE EXCEPTION 'origin_report needs a finite period' USING ERRCODE = '22023';
  END IF;
  IF p_end - p_start > interval '400 days' THEN
    RAISE EXCEPTION 'origin_report period is limited to 400 days' USING ERRCODE = '22023';
  END IF;

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
  joined AS (
    SELECT coalesce(c.t, d.t) AS t, coalesce(c.ch, d.ch) AS ch, coalesce(c.nm, d.nm) AS nm, coalesce(c.src, d.src) AS src,
           coalesce(c.n, 0) AS customers, coalesce(d.created, 0) AS created, coalesce(d.won, 0) AS won,
           coalesce(d.won_value, 0) AS won_value
      FROM cust c
      FULL JOIN dl d ON d.t = c.t AND d.ch = c.ch AND d.nm = c.nm AND d.src = c.src
  )
  SELECT j.t, j.ch, j.nm, j.src, j.customers, j.created, j.won, j.won_value,
         CASE WHEN j.created > 0 THEN round(100.0 * j.won / j.created, 1) ELSE 0 END,
         CASE WHEN j.won > 0 THEN round(j.won_value / j.won, 2) ELSE 0 END
    FROM joined j
   WHERE p_channel IS NULL OR j.ch = p_channel
   ORDER BY j.won_value DESC, j.won DESC, j.customers DESC, j.nm
   LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION public.origin_report(timestamptz, timestamptz, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.origin_report(timestamptz, timestamptz, text, uuid) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
