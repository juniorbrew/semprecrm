-- ============================================================
-- 079 — "Adiar conversa" (snooze).
--
-- A snooze is five columns on the conversation, orthogonal to `status`
-- (open/pending is preserved): `snoozed_until` IS the state (NULL = not
-- snoozed); the rest is stamped by the trigger below.
--
--   1. columns + CHECKs (a snoozed conversation is always live: never
--      closed, never archived) + a partial index for the wake scan and
--      the "Adiadas" tab;
--   2. conversation_events: + 'snoozed' / 'unsnoozed';
--   3. conversations_snooze_guard (BEFORE INSERT/UPDATE): validates the
--      time (now + 1 min .. now + 366 d), stamps snoozed_at / snoozed_by,
--      zeroes unread_count, keeps the stamped columns read-only from
--      outside, cancels the snooze on customer reply (the
--      last_customer_message_at bump done by conversations_track_last_message
--      inside the message INSERT), resolve, archive and reassignment, and
--      logs one event per transition;
--   4. conversation_snooze_wake_due(p_now, p_limit): service-role RPC for
--      the cron, wakes due conversations (FOR UPDATE SKIP LOCKED,
--      idempotent) and returns them for the push;
--   5. inbox_conversation_page (same 18-arg signature, + tab 'snoozed') and
--      inbox_counts (same 12 args, + snoozed_count): Fila / Minhas / Todas,
--      the Radar chips and "Estourados" exclude snoozed conversations.
--
-- SLA keeps running while snoozed (owner decision): the SLA triggers and
-- sla_tick are untouched; a breach while snoozed fires its event/push
-- and the conversation stays snoozed.
--
-- Additive and compatible with the previous app build (deploy.sh runs
-- `db push` before the build): new columns are NULL, the live tabs gain a
-- filter that is always true until someone snoozes, and the old app
-- ignores the extra counts column. Rollback: supabase/rollback/079_rollback.sql.
-- ============================================================

SET lock_timeout = '5s';

-- ---- 1. columns, constraints, index -----------------------------------
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS snoozed_until  timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_by     uuid,          -- no FK, like assigned_agent_id
  ADD COLUMN IF NOT EXISTS snooze_note    text,          -- kept after waking (marker tooltip)
  ADD COLUMN IF NOT EXISTS snooze_woke_at timestamptz;   -- last wake: "Voltou do adiar" marker

-- BEFORE triggers run before CHECKs: resolving / archiving clears the
-- snooze first (guard below), so this only rejects snoozing a dead one.
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_snooze_live_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_snooze_live_check
  CHECK (snoozed_until IS NULL OR (status <> 'closed' AND archived_at IS NULL)) NOT VALID;
ALTER TABLE public.conversations VALIDATE CONSTRAINT conversations_snooze_live_check;

ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_snooze_note_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_snooze_note_check
  CHECK (snooze_note IS NULL OR char_length(snooze_note) <= 200) NOT VALID;
ALTER TABLE public.conversations VALIDATE CONSTRAINT conversations_snooze_note_check;

-- ponytail: one index for the cross-account wake scan and the Adiadas tab;
-- add (account_id, snoozed_until, id) WHERE snoozed_until IS NOT NULL if
-- the tab gets slow on a big account.
CREATE INDEX IF NOT EXISTS idx_conversations_snoozed_due
  ON public.conversations (snoozed_until) WHERE snoozed_until IS NOT NULL;

-- ---- 2. event types: the 074 list + snoozed / unsnoozed ------------------
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
      'sla_breached',
      'team_changed',
      'csat_sent',
      'csat_answered',
      'snoozed',
      'unsnoozed'
    )
  ) NOT VALID;
ALTER TABLE public.conversation_events VALIDATE CONSTRAINT conversation_events_event_type_check;

-- ---- 3. the guard ------------------------------------------------------
-- Every writer (UI update, automations, inbound, cron) goes through here,
-- so there is no snooze RPC for the client: it updates snoozed_until /
-- snooze_note under the conversations_update policy (agent+).
CREATE OR REPLACE FUNCTION public.conversations_snooze_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor   uuid := COALESCE(auth.uid(), NULLIF(current_setting('app.actor_user', true), '')::uuid);
  v_wake    boolean := COALESCE(current_setting('app.snooze_wake', true), '') = '1';
  v_now     timestamptz := clock_timestamp();
  v_type    text;
  v_payload jsonb;
BEGIN
  -- Conversations are born awake: nobody can insert a pre-stamped snooze.
  IF TG_OP = 'INSERT' THEN
    NEW.snoozed_until := NULL; NEW.snoozed_at := NULL; NEW.snoozed_by := NULL;
    NEW.snooze_woke_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.snoozed_until IS NOT DISTINCT FROM OLD.snoozed_until THEN
    -- The stamped columns are not writable from outside.
    NEW.snoozed_by := OLD.snoozed_by; NEW.snoozed_at := OLD.snoozed_at;
    NEW.snooze_woke_at := OLD.snooze_woke_at;
    IF OLD.snoozed_until IS NULL THEN RETURN NEW; END IF;
    -- Implicit cancellation, first matching cause wins.
    v_payload := jsonb_build_object('cause', CASE
      WHEN NEW.last_customer_message_at IS DISTINCT FROM OLD.last_customer_message_at THEN 'customer_reply'
      WHEN NEW.status = 'closed' AND OLD.status <> 'closed' THEN 'resolved'
      WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN 'archived'
      WHEN NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN 'reassigned'
    END);
    IF v_payload->>'cause' IS NULL THEN RETURN NEW; END IF;   -- team, priority, our own messages…
    NEW.snoozed_until := NULL;
    IF v_payload->>'cause' = 'customer_reply' THEN NEW.snooze_woke_at := v_now; END IF;
    v_type := 'unsnoozed';
  ELSIF NEW.snoozed_until IS NOT NULL THEN
    -- Snooze / change the time. Outside the exception block: must fail the write.
    IF NEW.snoozed_until < v_now + interval '1 minute' OR NEW.snoozed_until > v_now + interval '366 days' THEN
      RAISE EXCEPTION 'snooze_until_out_of_range' USING ERRCODE = '22023';
    END IF;
    NEW.snoozed_at := v_now; NEW.snoozed_by := v_actor; NEW.snooze_woke_at := NULL;
    NEW.unread_count := 0;   -- seen and parked: the global unread badge ignores it
    v_type := 'snoozed';
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'until', NEW.snoozed_until, 'previous_until', OLD.snoozed_until, 'note', NEW.snooze_note));
  ELSE
    -- Explicit resume (manual) or the cron (transaction-local flag).
    NEW.snoozed_by := OLD.snoozed_by; NEW.snoozed_at := OLD.snoozed_at;
    NEW.snooze_woke_at := OLD.snooze_woke_at;
    IF v_wake THEN
      NEW.snooze_woke_at := v_now;
      NEW.unread_count := GREATEST(COALESCE(NEW.unread_count, 0), 1);
    END IF;
    v_type := 'unsnoozed';
    v_payload := jsonb_build_object('cause', CASE WHEN v_wake THEN 'timer' ELSE 'manual' END,
                                    'until', OLD.snoozed_until);
  END IF;

  -- History never blocks the write (same rule as the SLA events in 072).
  BEGIN
    INSERT INTO public.conversation_events (account_id, conversation_id, actor_user_id, event_type, payload)
    VALUES (NEW.account_id, NEW.id, CASE WHEN v_wake THEN NULL ELSE v_actor END, v_type, v_payload);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'conversations_snooze_guard: event skipped for %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.conversations_snooze_guard() OWNER TO postgres;

DROP TRIGGER IF EXISTS conversations_snooze_guard ON public.conversations;
CREATE TRIGGER conversations_snooze_guard
  BEFORE INSERT OR UPDATE OF snoozed_until, snoozed_by, snoozed_at, snooze_woke_at,
                             status, assigned_agent_id, archived_at, last_customer_message_at
  ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_snooze_guard();

-- ---- 4. wake the due ones (cron, service role only) ----------------------
CREATE OR REPLACE FUNCTION public.conversation_snooze_wake_due(
  p_now   timestamptz DEFAULT clock_timestamp(),
  p_limit integer     DEFAULT 500
) RETURNS TABLE (
  conversation_id   uuid,
  account_id        uuid,
  contact_id        uuid,
  assigned_agent_id uuid,
  snoozed_by        uuid,   -- push target when nobody is assigned
  snooze_note       text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.snooze_wake', '1', true);
  RETURN QUERY
  UPDATE public.conversations c
     SET snoozed_until = NULL
   WHERE c.id IN (SELECT x.id FROM public.conversations x
                   WHERE x.snoozed_until <= p_now
                   ORDER BY x.snoozed_until
                   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000))
                   FOR UPDATE SKIP LOCKED)
     AND c.snoozed_until <= p_now   -- re-check after the lock
  RETURNING c.id, c.account_id, c.contact_id, c.assigned_agent_id, c.snoozed_by, c.snooze_note;
  PERFORM set_config('app.snooze_wake', '', true);
END;
$$;
ALTER FUNCTION public.conversation_snooze_wake_due(timestamptz, integer) OWNER TO postgres;

-- ---- 5. inbox RPCs ---------------------------------------------------------
-- inbox_conversation_page: same signature as 073 → CREATE OR REPLACE.
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
  p_cursor_ts     timestamptz DEFAULT NULL,   -- snoozed tab: the cursor row's snoozed_until
  p_cursor_id     uuid        DEFAULT NULL,
  p_limit         integer     DEFAULT 50,
  p_tag_ids       uuid[]      DEFAULT NULL,   -- contact has ANY of these tags
  p_channel       text        DEFAULT NULL,   -- 'official' | 'qr'
  p_category_id   uuid        DEFAULT NULL,   -- 071
  p_priority      text        DEFAULT NULL,   -- 071: low | normal | high | urgent
  p_sla_breached  boolean     DEFAULT false,  -- 072: only conversations past a pending target
  p_team_id       uuid        DEFAULT NULL    -- 073
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
  IF p_tab NOT IN ('queue', 'mine', 'all', 'snoozed', 'closed', 'archived') THEN
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
  -- Snoozed conversations live only in the 'snoozed' tab (never closed /
  -- archived: conversations_snooze_live_check).
  IF p_tab = 'queue' THEN
    v_where := v_where || ' AND c.status = ''open'' AND c.assigned_agent_id IS NULL AND c.last_customer_message_at IS NOT NULL AND c.snoozed_until IS NULL';
  ELSIF p_tab = 'snoozed' THEN
    v_where := v_where || ' AND c.archived_at IS NULL AND c.snoozed_until IS NOT NULL';
  ELSIF p_tab = 'closed' THEN
    v_where := v_where || ' AND c.archived_at IS NULL AND c.status = ''closed''';
  ELSIF p_tab = 'archived' THEN
    v_where := v_where || ' AND c.archived_at IS NOT NULL';
  ELSE
    v_where := v_where || ' AND c.archived_at IS NULL AND c.snoozed_until IS NULL AND ' || CASE p_live
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
  IF p_team_id IS NOT NULL THEN
    v_where := v_where || ' AND c.team_id = $14';
  END IF;
  IF p_sla_breached IS TRUE THEN
    v_where := v_where || ' AND c.status <> ''closed'' AND ((c.first_response_at IS NULL AND c.last_customer_message_at IS NOT NULL AND c.first_response_due_at <= now()) OR c.resolution_due_at <= now())';
  END IF;

  -- Search: contact name / phone / subject, last message preview,
  -- primary company (see inbox_search_ids).
  IF p_pattern IS NOT NULL AND p_pattern <> '' THEN
    v_where := v_where || ' AND c.id IN (SELECT public.inbox_search_ids($1, $6, $10, $11, $12, $13))';
  END IF;

  -- Keyset cursor + order.
  IF p_tab = 'queue' THEN
    IF p_cursor_id IS NOT NULL THEN
      v_where := v_where || ' AND (' || v_grp || ', c.last_customer_message_at, c.id) > ($7, $8, $9)';
    END IF;
    v_sort := ' ORDER BY ' || v_grp || ', c.last_customer_message_at, c.id';
  ELSIF p_tab = 'snoozed' THEN
    -- Next to wake first.
    IF p_cursor_id IS NOT NULL THEN
      v_where := v_where || ' AND (c.snoozed_until, c.id) > ($8, $9)';
    END IF;
    v_sort := ' ORDER BY c.snoozed_until, c.id';
  ELSE
    IF p_cursor_id IS NOT NULL THEN
      v_where := v_where || ' AND (' || v_recent || ', c.id) < ($8, $9)';
    END IF;
    v_sort := ' ORDER BY ' || v_recent || ' DESC, c.id DESC';
  END IF;

  RETURN QUERY EXECUTE
    'SELECT c.* FROM public.conversations c WHERE ' || v_where || v_sort || ' LIMIT ' || v_limit
    USING p_account_id, auth.uid(), p_radar, p_sla_minutes, p_cooling_hours, p_pattern,
          p_cursor_grp, p_cursor_ts, p_cursor_id, p_tag_ids, p_channel, p_category_id, p_priority, p_team_id;
END;
$$;

-- inbox_counts: same 12 args, + snoozed_count → the return type changes,
-- so DROP + CREATE (atomic inside the migration transaction).
DROP FUNCTION IF EXISTS public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean, uuid);
CREATE FUNCTION public.inbox_counts(
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
  p_sla_breached  boolean DEFAULT false,
  p_team_id       uuid    DEFAULT NULL
) RETURNS TABLE (
  queue_count      bigint,
  mine_count       bigint,
  all_count        bigint,
  closed_count     bigint,
  archived_count   bigint,
  radar_waiting    bigint,
  radar_unassigned bigint,
  radar_cooling    bigint,
  radar_sla_breached bigint,
  snoozed_count    bigint   -- 079
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH c AS (
    SELECT
      x.status, x.archived_at, x.assigned_agent_id,
      (x.snoozed_until IS NOT NULL) AS snoozed,
      (x.status <> 'closed' AND ((x.first_response_at IS NULL AND x.last_customer_message_at IS NOT NULL AND x.first_response_due_at <= now()) OR x.resolution_due_at <= now())) AS breached,
      x.last_customer_message_at AS cust, x.last_agent_message_at AS agent,
      (
        (COALESCE(cardinality(p_tag_ids), 0) = 0 OR EXISTS (
           SELECT 1 FROM public.contact_tags ct WHERE ct.contact_id = x.contact_id AND ct.tag_id = ANY (p_tag_ids)))
        AND (p_channel IS NULL OR COALESCE(x.channel, 'official') = p_channel)
        AND (p_category_id IS NULL OR x.category_id = p_category_id)
        AND (p_priority IS NULL OR x.priority = p_priority)
        AND (p_team_id IS NULL OR x.team_id = p_team_id)
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
      c.in_base AND c.archived_at IS NULL AND c.status IN ('open', 'pending') AND NOT c.snoozed
      AND (p_live = 'live' OR c.status = p_live)
    ) AS in_live
    FROM base c
  )
  SELECT
    count(*) FILTER (WHERE in_base AND NOT snoozed AND status = 'open' AND assigned_agent_id IS NULL AND cust IS NOT NULL),
    count(*) FILTER (WHERE in_live AND assigned_agent_id = auth.uid()),
    count(*) FILTER (WHERE in_live),
    count(*) FILTER (WHERE in_base AND archived_at IS NULL AND status = 'closed'),
    count(*) FILTER (WHERE in_base AND archived_at IS NOT NULL),
    count(*) FILTER (WHERE in_facet AND NOT snoozed AND public.inbox_radar_match('waiting', status, assigned_agent_id, cust, agent, p_sla_minutes, p_cooling_hours)),
    count(*) FILTER (WHERE in_facet AND NOT snoozed AND public.inbox_radar_match('unassigned', status, assigned_agent_id, cust, agent, p_sla_minutes, p_cooling_hours)),
    count(*) FILTER (WHERE in_facet AND NOT snoozed AND public.inbox_radar_match('cooling', status, assigned_agent_id, cust, agent, p_sla_minutes, p_cooling_hours)),
    count(*) FILTER (WHERE in_facet_nosla AND breached AND NOT snoozed),
    count(*) FILTER (WHERE in_base AND snoozed)
  FROM live;
$$;
ALTER FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean, uuid) OWNER TO postgres;

-- ---- 6. grants (076: functions are born closed; be explicit) -------------
REVOKE ALL ON FUNCTION public.conversations_snooze_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.conversation_snooze_wake_due(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.conversation_snooze_wake_due(timestamptz, integer) TO service_role;
REVOKE ALL ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean, uuid) TO authenticated, service_role;

DO $$
DECLARE f text;
BEGIN
  -- One function per name: an overload makes PostgREST answer PGRST203
  -- ("function is not unique") to the named-argument calls of the app.
  FOREACH f IN ARRAY ARRAY['inbox_counts', 'inbox_conversation_page', 'conversation_snooze_wake_due'] LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = f) <> 1 THEN
      RAISE EXCEPTION 'expected exactly one public.% in pg_proc', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean, uuid)',
    'public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean, uuid)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'unexpected EXECUTE privileges on %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.conversations_snooze_guard()',
    'public.conversation_snooze_wake_due(timestamptz, integer)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'unexpected EXECUTE privileges on %', f;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.conversation_snooze_wake_due(timestamptz, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot run conversation_snooze_wake_due';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
