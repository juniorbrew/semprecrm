-- Only recorded disconnections with evidence of configuration or an error.
-- A single JSON result avoids PostgREST's row limit for this aggregate.
CREATE FUNCTION public.platform_channel_alerts()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE result JSONB;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin only' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_object_agg(account_id, flags), '{}'::jsonb)
  INTO result
  FROM (
    SELECT a.id AS account_id,
      jsonb_build_object(
        'official_disconnected', COALESCE(w.status = 'disconnected', false),
        'qr_disconnected', COALESCE(q.status = 'disconnected' AND (
          NULLIF(btrim(q.phone_number), '') IS NOT NULL OR
          NULLIF(btrim(q.display_name), '') IS NOT NULL OR
          NULLIF(btrim(q.last_error), '') IS NOT NULL
        ), false)
      ) AS flags
    FROM public.accounts a
    LEFT JOIN public.whatsapp_config w ON w.account_id = a.id
    LEFT JOIN public.wa_qr_sessions q ON q.account_id = a.id
  ) channels
  WHERE flags->>'official_disconnected' = 'true'
     OR flags->>'qr_disconnected' = 'true';

  RETURN result;
END;
$$;

ALTER FUNCTION public.platform_channel_alerts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_channel_alerts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_channel_alerts() TO authenticated;
