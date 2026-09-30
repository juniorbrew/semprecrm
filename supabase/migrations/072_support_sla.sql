-- ============================================================
-- 072_support_sla.sql — SempreCRM for support: SLA by priority.
--
-- 1. sla_policies: per account and priority, a first-response target and
--    a resolution target in minutes. Members read, admins write. Nothing
--    is seeded: an account without rows behaves exactly as before (the
--    single `inbox_sla_minutes` of the Radar).
-- 2. conversations: first_response_due_at / first_response_warn_at,
--    resolution_due_at / resolution_warn_at, sla_breached_at. They are
--    computed HERE, by one BEFORE trigger, so every writer (inbound
--    webhooks, the inbox UI, AI triage, automations, imports) gets the
--    same result and none can forget to stamp them.
--      - insert: clock starts at created_at;
--      - priority change: the original start (created_at) is kept, but a
--        deadline that already passed is restarted from the change time
--        (a raise never back-dates a breach);
--      - a target that already happened (first_response_at set, or the
--        conversation closed) is left as it was, for the compliance stat;
--      - reopening restarts the resolution clock from that moment;
--      - the first-response clock starts when the CUSTOMER first writes
--        (agent-started conversations are never "late" before that);
--      - the trigger never blocks a write: malformed preferences simply
--        leave the row without deadlines.
--    "Only count business hours" (accounts.preferences
--    .sla_count_only_business_hours, default true) walks the account's
--    business_hours (timezone + ranges per weekday) in
--    sla_add_business_minutes(); src/lib/support/sla-time.ts is the
--    reference twin (same fixtures in both tests).
--    Changing a policy does not rewrite the deadlines of existing
--    conversations; old rows stay NULL (no backfill).
-- 3. sla_tick(): called by the cron. Emits one `sla_warning` (at 80% of
--    the target) and one `sla_breached` event per conversation, kind AND
--    window (unique index on the deadline: a reopen or a priority change
--    that starts a new window can warn / breach again), stamps
--    sla_breached_at without touching updated_at and raises the
--    automation triggers of the same names. One bad row is skipped, not
--    fatal. Pushes are retried from sla_pending_push / sla_mark_pushed
--    (conversation_events.pushed_at). Server only.
--    sla_compliance() answers the dashboard stat with exact counts.
-- 4. conversation_events: + sla_warning, sla_breached (071 list kept).
-- 5. inbox_conversation_page / inbox_counts get p_sla_breached (filter
--    "SLA estourado"); inbox_counts also returns radar_sla_breached.
--    The 071 signatures are dropped first.
--
-- Idempotent.
-- ============================================================

-- ---- sla_policies ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sla_policies (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id             UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  priority               TEXT NOT NULL,
  first_response_minutes INTEGER,
  resolution_minutes     INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.sla_policies DROP CONSTRAINT IF EXISTS sla_policies_priority_check;
ALTER TABLE public.sla_policies ADD CONSTRAINT sla_policies_priority_check
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
ALTER TABLE public.sla_policies DROP CONSTRAINT IF EXISTS sla_policies_first_response_check;
ALTER TABLE public.sla_policies ADD CONSTRAINT sla_policies_first_response_check
  CHECK (first_response_minutes IS NULL OR first_response_minutes BETWEEN 1 AND 43200);
ALTER TABLE public.sla_policies DROP CONSTRAINT IF EXISTS sla_policies_resolution_check;
ALTER TABLE public.sla_policies ADD CONSTRAINT sla_policies_resolution_check
  CHECK (resolution_minutes IS NULL OR resolution_minutes BETWEEN 1 AND 129600);
ALTER TABLE public.sla_policies DROP CONSTRAINT IF EXISTS sla_policies_target_check;
ALTER TABLE public.sla_policies ADD CONSTRAINT sla_policies_target_check
  CHECK (first_response_minutes IS NOT NULL OR resolution_minutes IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_policies_account_priority
  ON public.sla_policies (account_id, priority);

DROP TRIGGER IF EXISTS set_updated_at ON public.sla_policies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.sla_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.sla_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sla_policies_select ON public.sla_policies;
CREATE POLICY sla_policies_select ON public.sla_policies FOR SELECT
  USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS sla_policies_insert ON public.sla_policies;
CREATE POLICY sla_policies_insert ON public.sla_policies FOR INSERT
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS sla_policies_update ON public.sla_policies;
CREATE POLICY sla_policies_update ON public.sla_policies FOR UPDATE
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS sla_policies_delete ON public.sla_policies;
CREATE POLICY sla_policies_delete ON public.sla_policies FOR DELETE
  USING (public.is_account_member(account_id, 'admin'));

-- ---- conversations columns -----------------------------------------
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS first_response_due_at  TIMESTAMPTZ;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS first_response_warn_at TIMESTAMPTZ;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS resolution_due_at      TIMESTAMPTZ;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS resolution_warn_at     TIMESTAMPTZ;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS sla_breached_at        TIMESTAMPTZ;

-- Partial indexes: only conversations with a pending target are scanned
-- by the cron; plain CREATE INDEX blocks writes while it builds (see the
-- note in 071 for CONCURRENTLY on very large tables).
CREATE INDEX IF NOT EXISTS idx_conversations_sla_first_response
  ON public.conversations (first_response_due_at)
  WHERE first_response_due_at IS NOT NULL AND first_response_at IS NULL AND status <> 'closed';
CREATE INDEX IF NOT EXISTS idx_conversations_sla_resolution
  ON public.conversations (resolution_due_at)
  WHERE resolution_due_at IS NOT NULL AND status <> 'closed';

-- ---- business-hours math -------------------------------------------
-- Wall clock -> instant, with one rule for the two DST oddities (the TS
-- twin in src/lib/support/sla-time.ts follows the same rule):
--   ambiguous local time (clocks go back, it happens twice) -> the FIRST
--     occurrence;
--   nonexistent local time (clocks go forward) -> the first valid instant
--     after it (the moment the clocks jump).
CREATE OR REPLACE FUNCTION public.sla_local_to_instant(p_local timestamp, p_tz text)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_u   timestamptz := p_local AT TIME ZONE 'UTC';
  o1    interval := ((v_u - interval '1 day') AT TIME ZONE p_tz) - ((v_u - interval '1 day') AT TIME ZONE 'UTC');
  o2    interval := ((v_u + interval '1 day') AT TIME ZONE p_tz) - ((v_u + interval '1 day') AT TIME ZONE 'UTC');
  t1    timestamptz := v_u - o1;
  t2    timestamptz := v_u - o2;
  ok1   boolean := (t1 AT TIME ZONE p_tz) = p_local;
  ok2   boolean := (t2 AT TIME ZONE p_tz) = p_local;
  lo    bigint;
  hi    bigint;
  mid   bigint;
BEGIN
  IF ok1 AND ok2 THEN RETURN LEAST(t1, t2); END IF;
  IF ok1 THEN RETURN t1; END IF;
  IF ok2 THEN RETURN t2; END IF;
  -- Inside the gap: first instant whose wall clock reaches p_local (seconds).
  lo := floor(extract(epoch FROM LEAST(t1, t2)))::bigint;
  hi := floor(extract(epoch FROM GREATEST(t1, t2)))::bigint;
  WHILE hi - lo > 1 LOOP
    mid := (lo + hi) / 2;
    IF (to_timestamp(mid) AT TIME ZONE p_tz) >= p_local THEN hi := mid; ELSE lo := mid; END IF;
  END LOOP;
  RETURN to_timestamp(hi);
END;
$$;

-- `p_hours` is accounts.preferences->'business_hours':
--   {"timezone": "America/Sao_Paulo", "days": {"mon": [{"start":"09:00","end":"18:00"}], ...}}
-- Adds `p_minutes` of OPEN time to `p_from`: ranges are half-open, a
-- range whose end <= start runs overnight into the next day, days
-- without ranges are closed. A range whose start or end is not a valid
-- "HH:MM" is skipped on its own (the rest of the schedule still counts);
-- a schedule with no valid range at all (or a bad timezone) falls back
-- to plain elapsed minutes.
CREATE OR REPLACE FUNCTION public.sla_add_business_minutes(
  p_from    timestamptz,
  p_minutes integer,
  p_hours   jsonb
) RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_tz     text := COALESCE(NULLIF(p_hours->>'timezone', ''), 'America/Sao_Paulo');
  v_days   jsonb := CASE WHEN jsonb_typeof(p_hours->'days') = 'object' THEN p_hours->'days' ELSE '{}'::jsonb END;
  v_keys   constant text[] := ARRAY['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  v_re     constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  v_left   numeric := p_minutes;
  v_cur    timestamptz := p_from;
  v_day    date;
  v_ranges jsonb;
  v_r      jsonb;
  v_s_min  integer;
  v_e_min  integer;
  v_s      timestamptz;
  v_e      timestamptz;
  v_from   timestamptz;
  v_avail  numeric;
  v_open   boolean;
  i        integer;
BEGIN
  IF p_minutes IS NULL OR p_minutes <= 0 THEN RETURN p_from; END IF;

  SELECT EXISTS (
    SELECT 1 FROM jsonb_each(v_days) d,
           LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.value) = 'array' THEN d.value ELSE '[]'::jsonb END) AS r
     WHERE (r->>'start') ~ v_re AND (r->>'end') ~ v_re
  ) INTO v_open;
  IF NOT v_open THEN RETURN p_from + make_interval(mins => p_minutes); END IF;

  -- Start a day early: yesterday's overnight range may still be open.
  v_day := (p_from AT TIME ZONE v_tz)::date - 1;
  FOR i IN 0..400 LOOP
    v_ranges := v_days->(v_keys[extract(dow FROM v_day)::integer + 1]);
    IF jsonb_typeof(v_ranges) = 'array' THEN
      FOR v_r IN
        SELECT r FROM jsonb_array_elements(v_ranges) AS t(r)
         WHERE (r->>'start') ~ v_re AND (r->>'end') ~ v_re
         ORDER BY r->>'start'
      LOOP
        v_s_min := split_part(v_r->>'start', ':', 1)::integer * 60 + split_part(v_r->>'start', ':', 2)::integer;
        v_e_min := split_part(v_r->>'end', ':', 1)::integer * 60 + split_part(v_r->>'end', ':', 2)::integer;
        v_s := public.sla_local_to_instant(v_day::timestamp + make_interval(mins => v_s_min), v_tz);
        v_e := public.sla_local_to_instant(
                 v_day::timestamp + make_interval(mins => v_e_min)
                 + CASE WHEN v_e_min <= v_s_min THEN interval '1 day' ELSE interval '0' END, v_tz);
        IF v_e <= v_cur THEN CONTINUE; END IF;
        v_from := GREATEST(v_s, v_cur);
        v_avail := extract(epoch FROM (v_e - v_from)) / 60.0;
        IF v_avail >= v_left THEN
          RETURN v_from + (v_left * interval '1 minute');
        END IF;
        v_left := v_left - v_avail;
        v_cur := v_e;
      END LOOP;
    END IF;
    v_day := v_day + 1;
  END LOOP;
  RETURN p_from + make_interval(mins => p_minutes);
EXCEPTION WHEN OTHERS THEN
  -- Malformed preferences must never block a conversation write.
  RETURN p_from + make_interval(mins => p_minutes);
END;
$$;

-- One target: where does the clock start, when is it due, when is the
-- 80% warning. `p_start` is created_at (or the restart point).
CREATE OR REPLACE FUNCTION public.sla_target(
  p_start    timestamptz,
  p_minutes  integer,
  p_hours    jsonb,         -- NULL = count every minute
  p_now      timestamptz,
  OUT due_at  timestamptz,
  OUT warn_at timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_start timestamptz := p_start;
  v_warn  integer;
BEGIN
  due_at := CASE WHEN p_hours IS NULL THEN v_start + make_interval(mins => p_minutes)
                 ELSE public.sla_add_business_minutes(v_start, p_minutes, p_hours) END;
  -- A deadline already behind us is restarted from now (never back-dated).
  IF due_at <= p_now THEN
    v_start := p_now;
    due_at := CASE WHEN p_hours IS NULL THEN v_start + make_interval(mins => p_minutes)
                   ELSE public.sla_add_business_minutes(v_start, p_minutes, p_hours) END;
  END IF;
  v_warn := floor(p_minutes * 0.8)::integer;
  warn_at := CASE WHEN v_warn < 1 THEN NULL
                  WHEN p_hours IS NULL THEN v_start + make_interval(mins => v_warn)
                  ELSE public.sla_add_business_minutes(v_start, v_warn, p_hours) END;
END;
$$;

-- Never blocks a write: after the cheap early return the whole body runs
-- inside an exception block, so malformed preferences (or anything else)
-- leave the row without deadlines instead of failing the insert/update.
-- First-response deadlines exist only once the customer has written: an
-- agent-started conversation gets its clock from the customer's first
-- message (UPDATE OF last_customer_message_at fires this trigger once).
CREATE OR REPLACE FUNCTION public.conversations_sla_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pol            record;
  v_prefs          jsonb;
  v_hours          jsonb;
  v_only           boolean;
  v_now            timestamptz := clock_timestamp();
  v_reopened       boolean := false;
  v_first_customer boolean := false;
  v_prio_changed   boolean := false;
  v_start          timestamptz;
  t                record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_reopened := OLD.status = 'closed' AND NEW.status <> 'closed';
    v_first_customer := OLD.last_customer_message_at IS NULL AND NEW.last_customer_message_at IS NOT NULL;
    v_prio_changed := NEW.priority IS DISTINCT FROM OLD.priority;
    IF NOT v_prio_changed AND NOT v_reopened AND NOT v_first_customer THEN
      RETURN NEW;
    END IF;
  END IF;

  BEGIN
    SELECT first_response_minutes, resolution_minutes INTO v_pol
      FROM public.sla_policies
     WHERE account_id = NEW.account_id AND priority = NEW.priority;

    IF NOT FOUND THEN
      -- No target for this priority: pending targets disappear, finished
      -- ones stay (they are history for the compliance stat).
      IF NEW.first_response_at IS NULL THEN
        NEW.first_response_due_at := NULL; NEW.first_response_warn_at := NULL;
      END IF;
      IF NEW.status <> 'closed' THEN
        NEW.resolution_due_at := NULL; NEW.resolution_warn_at := NULL;
      END IF;
      RETURN NEW;
    END IF;

    SELECT preferences INTO v_prefs FROM public.accounts WHERE id = NEW.account_id;
    v_only := CASE WHEN jsonb_typeof(v_prefs->'sla_count_only_business_hours') = 'boolean'
                   THEN (v_prefs->>'sla_count_only_business_hours')::boolean
                   ELSE true END;
    IF v_only THEN
      v_hours := COALESCE(v_prefs->'business_hours', jsonb_build_object(
        'timezone', 'America/Sao_Paulo',
        'days', jsonb_build_object(
          'mon', jsonb_build_array(jsonb_build_object('start', '09:00', 'end', '18:00')),
          'tue', jsonb_build_array(jsonb_build_object('start', '09:00', 'end', '18:00')),
          'wed', jsonb_build_array(jsonb_build_object('start', '09:00', 'end', '18:00')),
          'thu', jsonb_build_array(jsonb_build_object('start', '09:00', 'end', '18:00')),
          'fri', jsonb_build_array(jsonb_build_object('start', '09:00', 'end', '18:00')),
          'sat', '[]'::jsonb, 'sun', '[]'::jsonb)));
    END IF;

    IF NEW.first_response_at IS NULL AND NOT v_reopened THEN
      IF v_pol.first_response_minutes IS NULL OR NEW.last_customer_message_at IS NULL THEN
        NEW.first_response_due_at := NULL; NEW.first_response_warn_at := NULL;
      ELSE
        -- The customer's first message starts the clock; later changes keep
        -- the original start (created_at) unless that deadline already passed.
        v_start := CASE WHEN TG_OP = 'INSERT' OR v_first_customer
                        THEN NEW.last_customer_message_at
                        ELSE COALESCE(NEW.created_at, v_now) END;
        SELECT * INTO t FROM public.sla_target(v_start, v_pol.first_response_minutes, v_hours, v_now);
        NEW.first_response_due_at := t.due_at; NEW.first_response_warn_at := t.warn_at;
      END IF;
    END IF;

    IF NEW.status <> 'closed' AND (TG_OP = 'INSERT' OR v_prio_changed OR v_reopened OR NEW.resolution_due_at IS NULL) THEN
      IF v_pol.resolution_minutes IS NULL THEN
        NEW.resolution_due_at := NULL; NEW.resolution_warn_at := NULL;
      ELSE
        -- A reopened conversation gets a fresh window from the reopening.
        SELECT * INTO t FROM public.sla_target(
          CASE WHEN v_reopened THEN v_now ELSE COALESCE(NEW.created_at, v_now) END,
          v_pol.resolution_minutes, v_hours, v_now);
        NEW.resolution_due_at := t.due_at; NEW.resolution_warn_at := t.warn_at;
      END IF;
    END IF;

    -- A new window started: the breach mark belongs to the old one (sla_tick
    -- stamps it again if the new deadline is already missed).
    IF TG_OP = 'UPDATE' AND (v_prio_changed OR v_reopened) THEN
      NEW.sla_breached_at := NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_sla_stamp ON public.conversations;
CREATE TRIGGER conversations_sla_stamp
  BEFORE INSERT OR UPDATE OF priority, status, last_customer_message_at ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_sla_stamp();

-- updated_at is bumped by every UPDATE (001). The SLA tick stamps
-- sla_breached_at in bulk and must not reorder anything that sorts by
-- updated_at, so the conversations trigger honours a transaction-local flag.
CREATE OR REPLACE FUNCTION public.conversations_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.skip_updated_at', true) = '1' THEN
    NEW.updated_at := OLD.updated_at;
  ELSE
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS set_updated_at ON public.conversations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_set_updated_at();

-- ---- events ---------------------------------------------------------
ALTER TABLE public.conversation_events DROP CONSTRAINT IF EXISTS conversation_events_event_type_check;
ALTER TABLE public.conversation_events ADD CONSTRAINT conversation_events_event_type_check
  CHECK (
    event_type IN (
      'assigned',
      'unassigned',
      'status_changed',
      'label_added',
      'label_removed',
      'note_added',
      'contact_opted_out',
      'contact_opted_in',
      'ai_handoff',
      'ai_paused',
      'ai_resumed',
      'deal_stage_changed',
      'category_changed',
      'priority_changed',
      'resolution_set',
      'sla_warning',
      'sla_breached'
    )
  ) NOT VALID;
ALTER TABLE public.conversation_events VALIDATE CONSTRAINT conversation_events_event_type_check;

-- At most one warning and one breach per conversation, target AND window:
-- the key includes the deadline, so a reopen or a priority change that
-- starts a new window can warn / breach again.
ALTER TABLE public.conversation_events ADD COLUMN IF NOT EXISTS pushed_at TIMESTAMPTZ;
DROP INDEX IF EXISTS public.uq_conversation_events_sla;
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_events_sla
  ON public.conversation_events (conversation_id, event_type, (payload->>'kind'), (payload->>'due_at'))
  WHERE event_type IN ('sla_warning', 'sla_breached');

-- ---- cron: warnings and breaches -----------------------------------
-- Returns one row per event created by THIS call (never a repeat) and one
-- 'error' row per conversation that could not be processed (logged, skipped;
-- the rest of the batch goes on). Concurrent ticks are safe: the unique
-- index decides who inserted. Pushes are NOT sent from here: they are
-- retried from sla_pending_push() until sla_mark_pushed() records them.
DROP FUNCTION IF EXISTS public.sla_tick(timestamptz, integer);
CREATE OR REPLACE FUNCTION public.sla_tick(p_now timestamptz DEFAULT clock_timestamp(), p_limit integer DEFAULT 500)
RETURNS TABLE (
  event_id          uuid,
  conversation_id   uuid,
  account_id        uuid,
  contact_id        uuid,
  assigned_agent_id uuid,
  stage             text,   -- 'warning' | 'breached' | 'error'
  kind              text    -- 'first_response' | 'resolution'
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r       record;
  v_stage text;
  v_type  text;
  v_id    uuid;
  v_due   text;
BEGIN
  -- Stamping is bookkeeping: it must not reorder the inbox.
  PERFORM set_config('app.skip_updated_at', '1', true);

  BEGIN
    UPDATE public.conversations c
       SET sla_breached_at = p_now
     WHERE c.sla_breached_at IS NULL AND c.status <> 'closed' AND c.archived_at IS NULL
       AND ((c.first_response_at IS NULL AND c.last_customer_message_at IS NOT NULL AND c.first_response_due_at <= p_now)
            OR c.resolution_due_at <= p_now);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'sla_tick: stamping sla_breached_at failed: %', SQLERRM;
  END;

  FOR r IN
    SELECT c.id, c.account_id, c.contact_id, c.assigned_agent_id, k.kind, k.due_at, k.warn_at
      FROM public.conversations c
      CROSS JOIN LATERAL (VALUES
        ('first_response', CASE WHEN c.first_response_at IS NULL AND c.last_customer_message_at IS NOT NULL THEN c.first_response_due_at END,
                           CASE WHEN c.first_response_at IS NULL AND c.last_customer_message_at IS NOT NULL THEN c.first_response_warn_at END),
        ('resolution',     c.resolution_due_at, c.resolution_warn_at)
      ) AS k(kind, due_at, warn_at)
     WHERE c.status <> 'closed'
       AND c.archived_at IS NULL
       AND k.due_at IS NOT NULL
       AND (k.due_at <= p_now OR (k.warn_at IS NOT NULL AND k.warn_at <= p_now))
       -- Already reported for this window: skipped here so a backlog of old
       -- rows never starves new ones.
       AND NOT EXISTS (
         SELECT 1 FROM public.conversation_events e
          WHERE e.conversation_id = c.id AND e.payload->>'kind' = k.kind
            AND e.payload->>'due_at' = to_char(k.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            AND e.event_type = CASE WHEN k.due_at <= p_now THEN 'sla_breached' ELSE 'sla_warning' END)
     ORDER BY k.due_at
     LIMIT GREATEST(1, LEAST(p_limit, 2000))
  LOOP
    BEGIN
      v_stage := CASE WHEN r.due_at <= p_now THEN 'breached' ELSE 'warning' END;
      v_type := CASE WHEN v_stage = 'breached' THEN 'sla_breached' ELSE 'sla_warning' END;
      v_due := to_char(r.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

      v_id := NULL;
      INSERT INTO public.conversation_events (account_id, conversation_id, actor_user_id, event_type, payload)
      VALUES (r.account_id, r.id, NULL, v_type, jsonb_build_object('kind', r.kind, 'due_at', v_due))
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_id;
      IF v_id IS NULL THEN CONTINUE; END IF;

      PERFORM public.automation_enqueue_event(
        r.account_id, v_type, r.contact_id, r.id,
        jsonb_build_object('kind', r.kind, 'due_at', v_due));

      event_id := v_id; conversation_id := r.id; account_id := r.account_id; contact_id := r.contact_id;
      assigned_agent_id := r.assigned_agent_id; stage := v_stage; kind := r.kind;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      -- The sub-block rolled back this row's event: it is retried next tick.
      RAISE WARNING 'sla_tick: conversation % skipped: %', r.id, SQLERRM;
      event_id := NULL; conversation_id := r.id; account_id := r.account_id; contact_id := r.contact_id;
      assigned_agent_id := r.assigned_agent_id; stage := 'error'; kind := r.kind;
      RETURN NEXT;
    END;
  END LOOP;
  PERFORM set_config('app.skip_updated_at', '', true);
END;
$$;

-- Breach events whose push is still owed (recent, conversation still open).
CREATE OR REPLACE FUNCTION public.sla_pending_push(p_limit integer DEFAULT 100)
RETURNS TABLE (
  event_id          uuid,
  conversation_id   uuid,
  account_id        uuid,
  assigned_agent_id uuid,
  kind              text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.conversation_id, e.account_id, c.assigned_agent_id, e.payload->>'kind'
    FROM public.conversation_events e
    JOIN public.conversations c ON c.id = e.conversation_id
   WHERE e.event_type = 'sla_breached' AND e.pushed_at IS NULL
     AND e.created_at > NOW() - INTERVAL '6 hours'
     AND c.status <> 'closed'
   ORDER BY e.created_at
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
$$;

CREATE OR REPLACE FUNCTION public.sla_mark_pushed(p_event_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.conversation_events SET pushed_at = NOW()
   WHERE id = ANY (p_event_ids) AND event_type = 'sla_breached' AND pushed_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Dashboard "Cumprimento dos prazos": exact counts for any volume. Every
-- deadline that reached a verdict inside [p_since, p_now] counts once:
--   answered / resolved: met when done on time, missed when late;
--   still open past its due date: missed.
-- First-response deadlines only exist once the customer has written.
CREATE OR REPLACE FUNCTION public.sla_compliance(
  p_account_id uuid,
  p_since      timestamptz,
  p_now        timestamptz DEFAULT NOW()
) RETURNS TABLE (met bigint, missed bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH j AS (
    SELECT (c.first_response_at <= c.first_response_due_at) AS ok
      FROM public.conversations c
     WHERE c.account_id = p_account_id AND public.is_account_member(p_account_id)
       AND c.first_response_due_at IS NOT NULL AND c.last_customer_message_at IS NOT NULL
       AND c.first_response_at IS NOT NULL AND c.first_response_at >= p_since
    UNION ALL
    SELECT false
      FROM public.conversations c
     WHERE c.account_id = p_account_id AND public.is_account_member(p_account_id)
       AND c.first_response_due_at IS NOT NULL AND c.last_customer_message_at IS NOT NULL
       AND c.first_response_at IS NULL
       AND c.first_response_due_at >= p_since AND c.first_response_due_at <= p_now
    UNION ALL
    SELECT (c.resolved_at <= c.resolution_due_at)
      FROM public.conversations c
     WHERE c.account_id = p_account_id AND public.is_account_member(p_account_id)
       AND c.resolution_due_at IS NOT NULL AND c.status = 'closed'
       AND c.resolved_at IS NOT NULL AND c.resolved_at >= p_since
    UNION ALL
    SELECT false
      FROM public.conversations c
     WHERE c.account_id = p_account_id AND public.is_account_member(p_account_id)
       AND c.resolution_due_at IS NOT NULL AND c.status <> 'closed'
       AND c.resolution_due_at >= p_since AND c.resolution_due_at <= p_now
  )
  SELECT count(*) FILTER (WHERE ok), count(*) FILTER (WHERE NOT ok) FROM j;
$$;

REVOKE ALL ON FUNCTION public.sla_tick(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sla_tick(timestamptz, integer) TO service_role;
REVOKE ALL ON FUNCTION public.sla_pending_push(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sla_pending_push(integer) TO service_role;
REVOKE ALL ON FUNCTION public.sla_mark_pushed(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sla_mark_pushed(uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.sla_compliance(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sla_compliance(uuid, timestamptz, timestamptz) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.sla_local_to_instant(timestamp, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sla_local_to_instant(timestamp, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.sla_add_business_minutes(timestamptz, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sla_add_business_minutes(timestamptz, integer, jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.sla_target(timestamptz, integer, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sla_target(timestamptz, integer, jsonb, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.conversations_sla_stamp() FROM PUBLIC, anon, authenticated;

-- ---- inbox RPCs: + p_sla_breached ------------------------------------
DROP FUNCTION IF EXISTS public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text);
DROP FUNCTION IF EXISTS public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text);

CREATE OR REPLACE FUNCTION public.inbox_conversation_page(
  p_account_id    uuid,
  p_tab           text,
  p_live          text        DEFAULT 'live',
  p_unread        boolean     DEFAULT false,
  p_radar         text        DEFAULT NULL,
  p_sla_minutes   integer     DEFAULT 15,
  p_cooling_hours integer     DEFAULT 24,
  p_pattern       text        DEFAULT NULL,   -- ILIKE pattern, already escaped by the client
  p_cursor_grp    integer     DEFAULT NULL,   -- queue only: 0 waiting / 1 not waiting
  p_cursor_ts     timestamptz DEFAULT NULL,
  p_cursor_id     uuid        DEFAULT NULL,
  p_limit         integer     DEFAULT 50,
  p_tag_ids       uuid[]      DEFAULT NULL,   -- contact has ANY of these tags
  p_channel       text        DEFAULT NULL,   -- 'official' | 'qr'
  p_category_id   uuid        DEFAULT NULL,   -- 071
  p_priority      text        DEFAULT NULL,   -- 071: low | normal | high | urgent
  p_sla_breached  boolean     DEFAULT false   -- 072: only conversations past a pending target
) RETURNS SETOF public.conversations
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_where  text := 'c.account_id = $1';
  v_sort   text;
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 1000);
  v_grp    constant text :=
    '(CASE WHEN c.last_agent_message_at IS NULL OR c.last_agent_message_at < c.last_customer_message_at THEN 0 ELSE 1 END)';
  v_recent constant text := 'COALESCE(c.last_message_at, c.created_at)';
BEGIN
  IF p_tab NOT IN ('queue', 'mine', 'all', 'closed', 'archived') THEN
    RAISE EXCEPTION 'invalid inbox tab %', p_tab USING ERRCODE = '22023';
  END IF;
  IF p_live NOT IN ('live', 'open', 'pending') THEN
    RAISE EXCEPTION 'invalid live filter %', p_live USING ERRCODE = '22023';
  END IF;
  IF p_radar IS NOT NULL AND p_radar NOT IN ('waiting', 'unassigned', 'cooling') THEN
    RAISE EXCEPTION 'invalid radar key %', p_radar USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NOT NULL AND p_channel NOT IN ('official', 'qr') THEN
    RAISE EXCEPTION 'invalid channel %', p_channel USING ERRCODE = '22023';
  END IF;
  IF p_priority IS NOT NULL AND p_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'invalid priority %', p_priority USING ERRCODE = '22023';
  END IF;

  -- Tab membership (lib/inbox/triage.ts). Only fixed fragments are
  -- concatenated; every caller-supplied value travels as a parameter.
  IF p_tab = 'queue' THEN
    v_where := v_where || ' AND c.status = ''open'' AND c.assigned_agent_id IS NULL AND c.last_customer_message_at IS NOT NULL';
  ELSIF p_tab = 'closed' THEN
    v_where := v_where || ' AND c.archived_at IS NULL AND c.status = ''closed''';
  ELSIF p_tab = 'archived' THEN
    v_where := v_where || ' AND c.archived_at IS NOT NULL';
  ELSE
    v_where := v_where || ' AND c.archived_at IS NULL AND ' || CASE p_live
      WHEN 'live' THEN 'c.status IN (''open'', ''pending'')'
      WHEN 'open' THEN 'c.status = ''open'''
      ELSE 'c.status = ''pending'''
    END;
    IF p_tab = 'mine' THEN
      v_where := v_where || ' AND c.assigned_agent_id = $2';
    END IF;
  END IF;

  IF p_unread IS TRUE THEN
    v_where := v_where || ' AND COALESCE(c.unread_count, 0) > 0';
  END IF;
  IF p_radar IS NOT NULL THEN
    v_where := v_where || ' AND public.inbox_radar_match($3, c.status, c.assigned_agent_id, c.last_customer_message_at, c.last_agent_message_at, $4, $5)';
  END IF;

  IF COALESCE(cardinality(p_tag_ids), 0) > 0 THEN
    v_where := v_where || ' AND EXISTS (SELECT 1 FROM public.contact_tags ct WHERE ct.contact_id = c.contact_id AND ct.tag_id = ANY ($10))';
  END IF;
  IF p_channel IS NOT NULL THEN
    v_where := v_where || ' AND COALESCE(c.channel, ''official'') = $11';
  END IF;
  IF p_category_id IS NOT NULL THEN
    v_where := v_where || ' AND c.category_id = $12';
  END IF;
  IF p_priority IS NOT NULL THEN
    v_where := v_where || ' AND c.priority = $13';
  END IF;
  IF p_sla_breached IS TRUE THEN
    v_where := v_where || ' AND c.status <> ''closed'' AND ((c.first_response_at IS NULL AND c.last_customer_message_at IS NOT NULL AND c.first_response_due_at <= now()) OR c.resolution_due_at <= now())';
  END IF;

  -- Search: contact name / phone / subject, last message preview,
  -- primary company (see inbox_search_ids above).
  IF p_pattern IS NOT NULL AND p_pattern <> '' THEN
    v_where := v_where || ' AND c.id IN (SELECT public.inbox_search_ids($1, $6, $10, $11, $12, $13))';
  END IF;

  -- Keyset cursor + order.
  IF p_tab = 'queue' THEN
    IF p_cursor_id IS NOT NULL THEN
      v_where := v_where || ' AND (' || v_grp || ', c.last_customer_message_at, c.id) > ($7, $8, $9)';
    END IF;
    v_sort := ' ORDER BY ' || v_grp || ', c.last_customer_message_at, c.id';
  ELSE
    IF p_cursor_id IS NOT NULL THEN
      v_where := v_where || ' AND (' || v_recent || ', c.id) < ($8, $9)';
    END IF;
    v_sort := ' ORDER BY ' || v_recent || ' DESC, c.id DESC';
  END IF;

  RETURN QUERY EXECUTE
    'SELECT c.* FROM public.conversations c WHERE ' || v_where || v_sort || ' LIMIT ' || v_limit
    USING p_account_id, auth.uid(), p_radar, p_sla_minutes, p_cooling_hours, p_pattern,
          p_cursor_grp, p_cursor_ts, p_cursor_id, p_tag_ids, p_channel, p_category_id, p_priority;
END;
$$;

CREATE OR REPLACE FUNCTION public.inbox_counts(
  p_account_id    uuid,
  p_live          text    DEFAULT 'live',
  p_unread        boolean DEFAULT false,
  p_radar         text    DEFAULT NULL,
  p_sla_minutes   integer DEFAULT 15,
  p_cooling_hours integer DEFAULT 24,
  p_tag_ids       uuid[]  DEFAULT NULL,
  p_channel       text    DEFAULT NULL,
  p_category_id   uuid    DEFAULT NULL,
  p_priority      text    DEFAULT NULL,
  p_sla_breached  boolean DEFAULT false
) RETURNS TABLE (
  queue_count      bigint,
  mine_count       bigint,
  all_count        bigint,
  closed_count     bigint,
  archived_count   bigint,
  radar_waiting    bigint,
  radar_unassigned bigint,
  radar_cooling    bigint,
  radar_sla_breached bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH c AS (
    SELECT
      x.status, x.archived_at, x.assigned_agent_id,
      (x.status <> 'closed' AND ((x.first_response_at IS NULL AND x.last_customer_message_at IS NOT NULL AND x.first_response_due_at <= now()) OR x.resolution_due_at <= now())) AS breached,
      x.last_customer_message_at AS cust, x.last_agent_message_at AS agent,
      (
        (COALESCE(cardinality(p_tag_ids), 0) = 0 OR EXISTS (
           SELECT 1 FROM public.contact_tags ct WHERE ct.contact_id = x.contact_id AND ct.tag_id = ANY (p_tag_ids)))
        AND (p_channel IS NULL OR COALESCE(x.channel, 'official') = p_channel)
        AND (p_category_id IS NULL OR x.category_id = p_category_id)
        AND (p_priority IS NULL OR x.priority = p_priority)
      ) AS in_facet_nosla,
      (
        (p_unread IS NOT TRUE OR COALESCE(x.unread_count, 0) > 0)
        AND (p_radar IS NULL OR public.inbox_radar_match(
              p_radar, x.status, x.assigned_agent_id,
              x.last_customer_message_at, x.last_agent_message_at,
              p_sla_minutes, p_cooling_hours))
      ) AS in_unread_radar
    FROM public.conversations x
    WHERE x.account_id = p_account_id
      AND public.is_account_member(p_account_id)   -- same rule as the conversations_select policy
  ),
  base AS (
    SELECT c.*, (c.in_facet_nosla AND (p_sla_breached IS NOT TRUE OR c.breached)) AS in_facet,
           (c.in_facet_nosla AND (p_sla_breached IS NOT TRUE OR c.breached) AND c.in_unread_radar) AS in_base
      FROM c
  ),
  live AS (
    SELECT c.*, (
      c.in_base AND c.archived_at IS NULL AND c.status IN ('open', 'pending')
      AND (p_live = 'live' OR c.status = p_live)
    ) AS in_live
    FROM base c
  )
  SELECT
    count(*) FILTER (WHERE in_base AND status = 'open' AND assigned_agent_id IS NULL AND cust IS NOT NULL),
    count(*) FILTER (WHERE in_live AND assigned_agent_id = auth.uid()),
    count(*) FILTER (WHERE in_live),
    count(*) FILTER (WHERE in_base AND archived_at IS NULL AND status = 'closed'),
    count(*) FILTER (WHERE in_base AND archived_at IS NOT NULL),
    count(*) FILTER (WHERE in_facet AND public.inbox_radar_match('waiting', status, assigned_agent_id, cust, agent, p_sla_minutes, p_cooling_hours)),
    count(*) FILTER (WHERE in_facet AND public.inbox_radar_match('unassigned', status, assigned_agent_id, cust, agent, p_sla_minutes, p_cooling_hours)),
    count(*) FILTER (WHERE in_facet AND public.inbox_radar_match('cooling', status, assigned_agent_id, cust, agent, p_sla_minutes, p_cooling_hours)),
    count(*) FILTER (WHERE in_facet_nosla AND breached)
  FROM live;
$$;

REVOKE ALL ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean) TO authenticated, service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean)',
    'public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean)',
    'public.sla_add_business_minutes(timestamptz, integer, jsonb)',
    'public.sla_local_to_instant(timestamp, text)',
    'public.sla_compliance(uuid, timestamptz, timestamptz)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'unexpected EXECUTE privileges on %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.sla_tick(timestamptz, integer)',
    'public.sla_pending_push(integer)',
    'public.sla_mark_pushed(uuid[])',
    'public.sla_target(timestamptz, integer, jsonb, timestamptz)',
    'public.conversations_sla_stamp()'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'unexpected EXECUTE privileges on %', f;
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
