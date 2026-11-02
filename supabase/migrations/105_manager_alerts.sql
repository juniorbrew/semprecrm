-- ============================================================
-- 105_manager_alerts.sql — team monitoring pushes for owners/admins.
--
-- Settings → Notificações gains two opt-in alerts for managers
-- (profiles.notification_prefs, keys default OFF — src/lib/push/prefs.ts):
--   manager_waiting     a customer has gone unanswered for longer than
--                       accounts.preferences.inbox_sla_minutes (the Radar's
--                       "waiting" rule), in anyone's conversation;
--   manager_unassigned  the same wait with nobody assigned, after
--                       accounts.preferences.unassigned_alert_minutes.
--
-- What this migration does
--   1. conversation_alerts — one row per (conversation, kind, wait) already
--      pushed. A wait is identified by its first unanswered customer
--      message, so a long wait (or a customer writing again) is pushed once.
--      Service-role only: RLS on, no policies, no grants to app roles.
--   2. manager_alerts_due(p_now, p_limit): service-role RPC for the cron
--      tick. Claims the due waits with INSERT … ON CONFLICT DO NOTHING
--      RETURNING (overlapping ticks never claim the same wait twice) and
--      only for accounts where some owner/admin turned the alert on.
--      Waits older than two days are ignored (no burst of stale alerts on
--      the first run; the longest limit is one day); rows older than 7 days
--      are pruned.
--   3. Partial index for the live-conversation scan.
--
-- Does NOT touch handle_new_user.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---- 1. table ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_alerts (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('waiting', 'unassigned')),
  -- First unanswered customer message of the wait that was pushed.
  wait_started_at TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, kind, wait_started_at)
);
CREATE INDEX IF NOT EXISTS idx_conversation_alerts_created ON public.conversation_alerts(created_at);

ALTER TABLE public.conversation_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversation_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.conversation_alerts TO service_role;

-- ---- 2. index ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_conversations_live_last_customer
  ON public.conversations(last_customer_message_at)
  WHERE status <> 'closed' AND snoozed_until IS NULL;

-- ---- 3. claim RPC -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.manager_alerts_due(p_now timestamptz, p_limit integer)
RETURNS TABLE (
  conversation_id   uuid,
  account_id        uuid,
  contact_id        uuid,
  assigned_agent_id uuid,
  kind              text,
  wait_started_at   timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  DELETE FROM conversation_alerts a WHERE a.created_at < p_now - interval '7 days';

  RETURN QUERY
  WITH watched AS (
    -- Accounts with at least one manager who wants each kind.
    -- Compared as jsonb, never cast: a malformed value is just "off".
    SELECT p.account_id,
           bool_or(COALESCE(p.notification_prefs->'manager_waiting' = 'true'::jsonb, false)) AS want_waiting,
           bool_or(COALESCE(p.notification_prefs->'manager_unassigned' = 'true'::jsonb, false)) AS want_unassigned
      FROM profiles p
     WHERE p.account_role IN ('owner', 'admin')
       AND p.account_id IS NOT NULL
     GROUP BY p.account_id
    HAVING bool_or(COALESCE(p.notification_prefs->'manager_waiting' = 'true'::jsonb, false))
        OR bool_or(COALESCE(p.notification_prefs->'manager_unassigned' = 'true'::jsonb, false))
  ),
  live AS (
    -- The Radar's "customer spoke last" rule (src/lib/radar/classify.ts).
    -- Unlike the Radar (latest customer message), the wait is measured from
    -- the FIRST unanswered customer message — see `waits`.
    -- Minutes are clamped to PREFERENCE_LIMITS (1..1440) before any cast.
    SELECT c.id, c.account_id, c.contact_id, c.assigned_agent_id, c.status,
           c.last_agent_message_at, c.last_customer_message_at,
           w.want_waiting, w.want_unassigned,
           COALESCE(
             CASE WHEN jsonb_typeof(a.preferences->'inbox_sla_minutes') = 'number'
                  THEN LEAST(GREATEST((a.preferences->>'inbox_sla_minutes')::numeric, 1), 1440) END, 15)::int AS sla_minutes,
           COALESCE(
             CASE WHEN jsonb_typeof(a.preferences->'unassigned_alert_minutes') = 'number'
                  THEN LEAST(GREATEST((a.preferences->>'unassigned_alert_minutes')::numeric, 1), 1440) END, 5)::int AS unassigned_minutes
      FROM conversations c
      JOIN watched w ON w.account_id = c.account_id
      JOIN accounts a ON a.id = c.account_id
     WHERE c.status <> 'closed'
       AND c.snoozed_until IS NULL
       AND c.last_customer_message_at > p_now - interval '2 days'
       AND (c.last_agent_message_at IS NULL OR c.last_agent_message_at < c.last_customer_message_at)
  ),
  waits AS (
    SELECT l.*,
           COALESCE(
             (SELECT min(m.created_at) FROM messages m
               WHERE m.conversation_id = l.id
                 AND m.sender_type = 'customer'
                 AND m.created_at > COALESCE(l.last_agent_message_at, '-infinity'::timestamptz)),
             l.last_customer_message_at) AS started
      FROM live l
  ),
  due AS (
    SELECT w.id, w.account_id, 'waiting'::text AS kind, w.started
      FROM waits w
     WHERE w.want_waiting
       AND w.started <= p_now - make_interval(mins => w.sla_minutes)
       -- Already pushed as "nobody assigned": one push per wait is enough.
       AND NOT EXISTS (SELECT 1 FROM conversation_alerts x
                        WHERE x.conversation_id = w.id AND x.kind = 'unassigned'
                          AND x.wait_started_at = w.started)
    UNION ALL
    SELECT w.id, w.account_id, 'unassigned'::text, w.started
      FROM waits w
     WHERE w.want_unassigned
       AND w.status = 'open'
       AND w.assigned_agent_id IS NULL
       AND w.started <= p_now - make_interval(mins => w.unassigned_minutes)
  ),
  claimed AS (
    INSERT INTO conversation_alerts AS ca (conversation_id, account_id, kind, wait_started_at)
    SELECT d.id, d.account_id, d.kind, d.started
      FROM due d
     WHERE d.started > p_now - interval '2 days'
       -- Skip what is already claimed BEFORE the limit, or old waits that are
       -- still open would fill every batch and starve the new ones. ON
       -- CONFLICT still guards overlapping ticks.
       AND NOT EXISTS (SELECT 1 FROM conversation_alerts x
                        WHERE x.conversation_id = d.id AND x.kind = d.kind
                          AND x.wait_started_at = d.started)
     ORDER BY d.started
     LIMIT GREATEST(p_limit, 0)
    ON CONFLICT DO NOTHING
    RETURNING ca.conversation_id, ca.account_id, ca.kind, ca.wait_started_at
  )
  SELECT cl.conversation_id, cl.account_id, c.contact_id, c.assigned_agent_id, cl.kind, cl.wait_started_at
    FROM claimed cl
    JOIN conversations c ON c.id = cl.conversation_id;
END;
$$;
ALTER FUNCTION public.manager_alerts_due(timestamptz, integer) OWNER TO postgres;

-- ---- 4. grants (076: functions are born closed; be explicit) -------------
REVOKE ALL ON FUNCTION public.manager_alerts_due(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manager_alerts_due(timestamptz, integer) TO service_role;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'manager_alerts_due') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one public.manager_alerts_due in pg_proc';
  END IF;
  IF has_function_privilege('anon', 'public.manager_alerts_due(timestamptz, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.manager_alerts_due(timestamptz, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.manager_alerts_due(timestamptz, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'unexpected EXECUTE privileges on manager_alerts_due';
  END IF;
  IF has_table_privilege('authenticated', 'public.conversation_alerts', 'SELECT')
     OR has_table_privilege('anon', 'public.conversation_alerts', 'SELECT') THEN
    RAISE EXCEPTION 'conversation_alerts must be service-role only';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
