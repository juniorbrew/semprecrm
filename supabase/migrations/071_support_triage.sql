-- ============================================================
-- 071_support_triage.sql — SempreCRM for support: conversation triage.
--
-- 1. conversation_categories: the account's own support categories
--    (name, description the AI reads, colour key, default priority).
--    Members read, admins write. Nothing is seeded.
-- 2. conversations: category_id, priority, subject, sentiment,
--    triage_source / triage_at (who classified last), resolution and
--    resolved_at. A trigger stamps resolved_at when the status becomes
--    'closed' and clears it (and the resolution) when it leaves 'closed';
--    a closed row without an outcome gets 'resolved'.
-- 3. conversation_events: + category_changed, priority_changed,
--    resolution_set (the full 070 list is kept).
-- 4. ai_settings.triage_enabled (default false) and ai_usage.feature
--    accepts 'triage' (the 066 list is kept).
-- 5. inbox_conversation_page / inbox_counts / inbox_search_ids get the
--    optional p_category_id / p_priority filters (NULL = no filter).
--    The 068 signatures are dropped first (two overloads would make
--    PostgREST reject calls as ambiguous).
--
-- LGPD: `subject` may contain personal data; the app clears the triage
-- fields on anonymisation (src/lib/lgpd/anonymize.ts) and exports them
-- with the contact's data (src/lib/lgpd/export.ts).
--
-- Idempotent.
-- ============================================================

-- ---- conversation_categories --------------------------------------
CREATE TABLE IF NOT EXISTS public.conversation_categories (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  color            TEXT NOT NULL DEFAULT 'gray',
  default_priority TEXT NOT NULL DEFAULT 'normal',
  position         INTEGER NOT NULL DEFAULT 0,
  archived_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.conversation_categories DROP CONSTRAINT IF EXISTS conversation_categories_name_check;
ALTER TABLE public.conversation_categories ADD CONSTRAINT conversation_categories_name_check
  CHECK (char_length(btrim(name)) BETWEEN 1 AND 40);
ALTER TABLE public.conversation_categories DROP CONSTRAINT IF EXISTS conversation_categories_description_check;
ALTER TABLE public.conversation_categories ADD CONSTRAINT conversation_categories_description_check
  CHECK (description IS NULL OR char_length(description) <= 200);
ALTER TABLE public.conversation_categories DROP CONSTRAINT IF EXISTS conversation_categories_color_check;
ALTER TABLE public.conversation_categories ADD CONSTRAINT conversation_categories_color_check
  CHECK (color IN ('gray', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'));
ALTER TABLE public.conversation_categories DROP CONSTRAINT IF EXISTS conversation_categories_priority_check;
ALTER TABLE public.conversation_categories ADD CONSTRAINT conversation_categories_priority_check
  CHECK (default_priority IN ('low', 'normal', 'high', 'urgent'));

-- Unique among the live (non-archived) ones, case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_categories_name
  ON public.conversation_categories (account_id, lower(btrim(name))) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_categories_account
  ON public.conversation_categories (account_id, position);

DROP TRIGGER IF EXISTS set_updated_at ON public.conversation_categories;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.conversation_categories
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.conversation_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_categories_select ON public.conversation_categories;
CREATE POLICY conversation_categories_select ON public.conversation_categories FOR SELECT
  USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS conversation_categories_insert ON public.conversation_categories;
CREATE POLICY conversation_categories_insert ON public.conversation_categories FOR INSERT
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS conversation_categories_update ON public.conversation_categories;
CREATE POLICY conversation_categories_update ON public.conversation_categories FOR UPDATE
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS conversation_categories_delete ON public.conversation_categories;
CREATE POLICY conversation_categories_delete ON public.conversation_categories FOR DELETE
  USING (public.is_account_member(account_id, 'admin'));

-- ---- conversations columns ----------------------------------------
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS category_id UUID
  REFERENCES public.conversation_categories(id) ON DELETE SET NULL;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS sentiment TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS triage_source TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS triage_at TIMESTAMPTZ;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS resolution TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
-- resolved_at backfilled from updated_at (no closing event): not a real measure.
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS resolved_at_estimated BOOLEAN NOT NULL DEFAULT FALSE;
-- An agent chose the priority by hand: a category change no longer moves it.
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS priority_manual BOOLEAN NOT NULL DEFAULT FALSE;
-- Automatic triage runs claimed (cost cap) and when the last claim happened (dedupe).
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS triage_runs SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS triage_claimed_at TIMESTAMPTZ;

ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_priority_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_priority_check
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_subject_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_subject_check
  CHECK (subject IS NULL OR char_length(subject) <= 120);
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_sentiment_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_sentiment_check
  CHECK (sentiment IS NULL OR sentiment IN ('negative', 'neutral', 'positive'));
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_triage_source_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_triage_source_check
  CHECK (triage_source IS NULL OR triage_source IN ('ai', 'manual'));
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_resolution_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_resolution_check
  CHECK (resolution IS NULL OR resolution IN ('resolved', 'not_applicable', 'closed_by_customer', 'expired', 'duplicate'));

-- A category of another account can never be attached (the FK alone
-- would accept any category id).
CREATE OR REPLACE FUNCTION public.conversations_check_category()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.conversation_categories k
     WHERE k.id = NEW.category_id AND k.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'category does not belong to this account' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_check_category ON public.conversations;
CREATE TRIGGER conversations_check_category
  BEFORE INSERT OR UPDATE OF category_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_check_category();

-- resolved_at / resolution follow the status.
CREATE OR REPLACE FUNCTION public.conversations_stamp_resolved()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'closed' THEN
    -- Archiving an open conversation is not a resolution (migration 056
    -- writes status closed + archived_at together).
    IF NEW.archived_at IS NOT NULL AND NEW.resolved_at IS NULL THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR NEW.resolved_at IS NULL THEN
      NEW.resolved_at := NOW();
    END IF;
    IF NEW.resolution IS NULL THEN
      NEW.resolution := 'resolved';
    END IF;
  ELSE
    NEW.resolved_at := NULL;
    NEW.resolution := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- One-time backfill: last status_changed -> closed event, else updated_at.
-- updated_at is parked so the backfill does not bump it; it runs before
-- the trigger exists and only fills NULLs, so a re-run changes nothing.
ALTER TABLE public.conversations DISABLE TRIGGER set_updated_at;
UPDATE public.conversations c
   SET resolved_at = COALESCE(ev.at, c.updated_at),
       resolved_at_estimated = (ev.at IS NULL)
  FROM (SELECT c2.id, (SELECT max(e.created_at) FROM public.conversation_events e
           WHERE e.conversation_id = c2.id AND e.event_type = 'status_changed'
             AND e.payload->>'status' = 'closed') AS at
          FROM public.conversations c2) ev
 WHERE ev.id = c.id AND c.status = 'closed' AND c.resolved_at IS NULL;
ALTER TABLE public.conversations ENABLE TRIGGER set_updated_at;

DROP TRIGGER IF EXISTS conversations_stamp_resolved ON public.conversations;
CREATE TRIGGER conversations_stamp_resolved
  BEFORE INSERT OR UPDATE OF status ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_stamp_resolved();

-- NOTE (large tables): plain CREATE INDEX blocks writes while it builds;
-- on a very large conversations table create the same indexes first by
-- hand with CREATE INDEX CONCURRENTLY IF NOT EXISTS <same name> ...
CREATE INDEX IF NOT EXISTS idx_conversations_account_category
  ON public.conversations (account_id, category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_account_priority
  ON public.conversations (account_id, priority) WHERE priority <> 'normal';
CREATE INDEX IF NOT EXISTS idx_conversations_account_resolved
  ON public.conversations (account_id, resolved_at) WHERE resolved_at IS NOT NULL;

-- Claim one automatic triage run (cost cap + dedupe), atomically: at most
-- 2 automatic runs per conversation (1st and 3rd customer message), none
-- within 60 s of the previous claim / applied triage / 'triage' usage row.
-- Two parallel inbound messages cannot both win. Server only.
CREATE OR REPLACE FUNCTION public.claim_triage_run(p_conversation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  UPDATE public.conversations c
     SET triage_runs = c.triage_runs + 1, triage_claimed_at = NOW()
   WHERE c.id = p_conversation_id
     AND c.triage_runs < 2
     AND (c.triage_claimed_at IS NULL OR c.triage_claimed_at < NOW() - INTERVAL '60 seconds')
     AND (c.triage_at IS NULL OR c.triage_at < NOW() - INTERVAL '60 seconds')
     AND NOT EXISTS (
       SELECT 1 FROM public.ai_usage u
        WHERE u.conversation_id = c.id AND u.feature = 'triage'
          AND u.created_at > NOW() - INTERVAL '60 seconds')
  RETURNING c.id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_triage_run(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_triage_run(uuid) TO service_role;

-- Categories are cached by open inboxes: realtime keeps them in step.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'conversation_categories') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_categories;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- ---- conversation_events types (070 list + 3) ----------------------
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
      'resolution_set'
    )
  ) NOT VALID;
ALTER TABLE public.conversation_events VALIDATE CONSTRAINT conversation_events_event_type_check;

-- ---- AI: opt-in flag + usage feature --------------------------------
ALTER TABLE public.ai_settings ADD COLUMN IF NOT EXISTS triage_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.ai_usage DROP CONSTRAINT IF EXISTS ai_usage_feature_check;
ALTER TABLE public.ai_usage ADD CONSTRAINT ai_usage_feature_check
  CHECK (feature IN ('suggest_reply', 'memory_extract', 'agent_test', 'auto_reply', 'triage')) NOT VALID;
ALTER TABLE public.ai_usage VALIDATE CONSTRAINT ai_usage_feature_check;

-- ---- inbox RPCs: + p_category_id / p_priority -----------------------
DROP FUNCTION IF EXISTS public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text);
DROP FUNCTION IF EXISTS public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text);
DROP FUNCTION IF EXISTS public.inbox_search_ids(uuid, text, uuid[], text);

CREATE OR REPLACE FUNCTION public.inbox_search_ids(
  p_account_id  uuid,
  p_pattern     text,
  p_tag_ids     uuid[] DEFAULT NULL,
  p_channel     text   DEFAULT NULL,
  p_category_id uuid   DEFAULT NULL,
  p_priority    text   DEFAULT NULL
) RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id FROM public.conversations s
   WHERE public.is_account_member(p_account_id) AND s.account_id = p_account_id
     AND s.last_message_text ILIKE p_pattern
     AND (COALESCE(cardinality(p_tag_ids), 0) = 0 OR EXISTS (SELECT 1 FROM public.contact_tags ct WHERE ct.contact_id = s.contact_id AND ct.tag_id = ANY (p_tag_ids)))
     AND (p_channel IS NULL OR COALESCE(s.channel, 'official') = p_channel)
     AND (p_category_id IS NULL OR s.category_id = p_category_id)
     AND (p_priority IS NULL OR s.priority = p_priority)
  UNION
  SELECT s.id FROM public.conversations s
    JOIN public.contacts k ON k.id = s.contact_id
   WHERE public.is_account_member(p_account_id) AND s.account_id = p_account_id
     AND (k.name ILIKE p_pattern OR k.phone ILIKE p_pattern OR s.subject ILIKE p_pattern)
     AND (COALESCE(cardinality(p_tag_ids), 0) = 0 OR EXISTS (SELECT 1 FROM public.contact_tags ct WHERE ct.contact_id = s.contact_id AND ct.tag_id = ANY (p_tag_ids)))
     AND (p_channel IS NULL OR COALESCE(s.channel, 'official') = p_channel)
     AND (p_category_id IS NULL OR s.category_id = p_category_id)
     AND (p_priority IS NULL OR s.priority = p_priority)
  UNION
  SELECT s.id FROM public.conversations s
    JOIN public.contact_companies cc ON cc.contact_id = s.contact_id AND cc.is_primary
    JOIN public.companies co ON co.id = cc.company_id
   WHERE public.is_account_member(p_account_id) AND s.account_id = p_account_id
     AND (co.nome_fantasia ILIKE p_pattern OR co.razao_social ILIKE p_pattern)
     AND (COALESCE(cardinality(p_tag_ids), 0) = 0 OR EXISTS (SELECT 1 FROM public.contact_tags ct WHERE ct.contact_id = s.contact_id AND ct.tag_id = ANY (p_tag_ids)))
     AND (p_channel IS NULL OR COALESCE(s.channel, 'official') = p_channel)
     AND (p_category_id IS NULL OR s.category_id = p_category_id)
     AND (p_priority IS NULL OR s.priority = p_priority);
$$;

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
  p_priority      text        DEFAULT NULL    -- 071: low | normal | high | urgent
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
  p_priority      text    DEFAULT NULL
) RETURNS TABLE (
  queue_count      bigint,
  mine_count       bigint,
  all_count        bigint,
  closed_count     bigint,
  archived_count   bigint,
  radar_waiting    bigint,
  radar_unassigned bigint,
  radar_cooling    bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH c AS (
    SELECT
      x.status, x.archived_at, x.assigned_agent_id,
      x.last_customer_message_at AS cust, x.last_agent_message_at AS agent,
      (
        (COALESCE(cardinality(p_tag_ids), 0) = 0 OR EXISTS (
           SELECT 1 FROM public.contact_tags ct WHERE ct.contact_id = x.contact_id AND ct.tag_id = ANY (p_tag_ids)))
        AND (p_channel IS NULL OR COALESCE(x.channel, 'official') = p_channel)
        AND (p_category_id IS NULL OR x.category_id = p_category_id)
        AND (p_priority IS NULL OR x.priority = p_priority)
      ) AS in_facet,
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
    SELECT c.*, (c.in_facet AND c.in_unread_radar) AS in_base FROM c
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
    count(*) FILTER (WHERE in_facet AND public.inbox_radar_match('cooling', status, assigned_agent_id, cust, agent, p_sla_minutes, p_cooling_hours))
  FROM live;
$$;

REVOKE ALL ON FUNCTION public.inbox_search_ids(uuid, text, uuid[], text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_search_ids(uuid, text, uuid[], text, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text) TO authenticated, service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.inbox_search_ids(uuid, text, uuid[], text, uuid, text)',
    'public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text)',
    'public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'unexpected EXECUTE privileges on %', f;
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
