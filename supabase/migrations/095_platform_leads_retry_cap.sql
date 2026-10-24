-- Platform lead push: stop retrying forever. A lead whose push keeps failing
-- was rescheduled every hour for good (backoff capped at 60 min, no limit).
-- After 12 failed attempts (about 7 hours of backoff) or 24 hours since the
-- lead arrived, the worker gives up and records why; notified_at stays NULL
-- because nothing was delivered. The age cap is only evaluated when an attempt
-- fails or a stale claim is swept, never for a lead that has not been tried.
-- claim_lead_notifications also closes out stale claims already over a cap, so
-- a lead that crashes or times out the worker (no complete call) cannot be
-- reclaimed forever.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS notification_gave_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS notification_give_up_reason text;

-- Leads already stuck in the loop stop now.
UPDATE public.leads
SET notification_gave_up_at = now(),
    notification_give_up_reason = 'backfill: retry cap introduced',
    notification_claimed_at = NULL, notification_claim_token = NULL
WHERE notified_at IS NULL AND notification_gave_up_at IS NULL
  AND (notification_attempts >= 12 OR created_at < now() - interval '24 hours');

CREATE OR REPLACE FUNCTION public.claim_lead_notifications(p_limit integer DEFAULT 1)
RETURNS TABLE(id uuid,kind text,name text,email text,company text,notification_claim_token uuid,
  notification_attempts integer,notification_claimed_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <> 1 THEN RAISE EXCEPTION 'Claim one lead at a time' USING ERRCODE = '22023'; END IF;
  UPDATE public.leads l SET notification_gave_up_at = clock_timestamp(),
    notification_give_up_reason = CASE WHEN l.notification_attempts >= 12
      THEN 'attempts: ' || l.notification_attempts || ' attempts, worker did not finish'
      ELSE 'age: older than 24 hours, worker did not finish' END,
    notification_claimed_at = NULL, notification_claim_token = NULL
  WHERE l.notified_at IS NULL AND l.notification_gave_up_at IS NULL
    AND l.notification_claimed_at < clock_timestamp() - interval '5 minutes'
    AND (l.notification_attempts >= 12 OR l.created_at < clock_timestamp() - interval '24 hours');
  RETURN QUERY
  WITH candidates AS (
    SELECT l.id FROM public.leads l
    WHERE l.notified_at IS NULL AND l.notification_gave_up_at IS NULL
      AND l.notification_next_attempt_at <= clock_timestamp()
      AND (l.notification_claimed_at IS NULL OR l.notification_claimed_at < clock_timestamp() - interval '5 minutes')
    ORDER BY l.notification_next_attempt_at,l.created_at,l.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  )
  UPDATE public.leads l SET notification_claimed_at = clock_timestamp(), notification_claim_token = gen_random_uuid(),
    notification_attempts = l.notification_attempts + 1
  FROM candidates c WHERE l.id = c.id
  RETURNING l.id,l.kind,l.name,l.email,l.company,l.notification_claim_token,l.notification_attempts,l.notification_claimed_at;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_lead_notifications(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lead_notifications(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_lead_notification(p_lead_id uuid,p_claim_token uuid,p_success boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  IF p_success IS NULL THEN RAISE EXCEPTION 'Missing outcome' USING ERRCODE = '22023'; END IF;
  UPDATE public.leads l SET notified_at = CASE WHEN p_success THEN clock_timestamp() ELSE NULL END,
    notification_claimed_at = NULL, notification_claim_token = NULL,
    notification_next_attempt_at = CASE WHEN p_success THEN l.notification_next_attempt_at
      ELSE clock_timestamp() + interval '1 minute' * least(60, power(2,least(l.notification_attempts - 1,6))::integer) END,
    notification_gave_up_at = CASE
      WHEN p_success THEN NULL
      WHEN l.notification_attempts >= 12 OR l.created_at < clock_timestamp() - interval '24 hours' THEN clock_timestamp()
      ELSE NULL END,
    notification_give_up_reason = CASE
      WHEN p_success THEN NULL
      WHEN l.notification_attempts >= 12 THEN 'attempts: ' || l.notification_attempts || ' failed pushes'
      WHEN l.created_at < clock_timestamp() - interval '24 hours' THEN 'age: older than 24 hours'
      ELSE NULL END
  WHERE l.id = p_lead_id AND l.notification_claim_token = p_claim_token AND l.notified_at IS NULL
    AND l.notification_claimed_at >= clock_timestamp() - interval '5 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_lead_notification(uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_lead_notification(uuid,uuid,boolean) TO service_role;
