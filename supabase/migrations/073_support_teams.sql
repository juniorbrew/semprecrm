-- ============================================================
-- 073_support_teams.sql — SempreCRM for support: teams and routing.
--
-- 1. teams / team_members: named groups of the account's members.
--    Members read, admins write. A member must belong to the account
--    (trigger; the FK alone would accept any user id).
-- 2. routing_rules: category -> team (one rule per category, optional
--    minimum priority). Category and team must belong to the account.
-- 3. conversations.team_id (FK ON DELETE SET NULL, same-account guard),
--    plus two provenance columns kept by ONE trigger from who wrote:
--      assignment_source  'auto' | 'manual' | NULL
--      team_source        'auto' | 'manual' | NULL
--    A signed-in user (auth.uid() set) writes 'manual'; the service
--    role (webhooks, round-robin, routing, automations) writes 'auto';
--    a writer may also set the column explicitly in the same UPDATE.
--    Rows assigned before this migration stay NULL, which routing reads
--    as "a person did it" (never reassigned).
-- 4. conversation_events: + team_changed (071 + 072 list kept).
-- 5. Automation triggers category_set / priority_changed / team_changed
--    are raised from the existing automation_event_queue (migration 048).
--    automation_set_conversation() is the RPC the engine actions use, so
--    the events they cause inherit the run's depth (loop protection).
-- 6. inbox_conversation_page / inbox_counts get p_team_id; the 072
--    signatures are dropped first.
--
-- LGPD: nothing personal is added.
-- Idempotent.
-- ============================================================

-- ---- teams ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.teams (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.teams DROP CONSTRAINT IF EXISTS teams_name_check;
ALTER TABLE public.teams ADD CONSTRAINT teams_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 40);
ALTER TABLE public.teams DROP CONSTRAINT IF EXISTS teams_description_check;
ALTER TABLE public.teams ADD CONSTRAINT teams_description_check CHECK (description IS NULL OR char_length(description) <= 200);
CREATE UNIQUE INDEX IF NOT EXISTS uq_teams_name ON public.teams (account_id, lower(btrim(name))) WHERE archived_at IS NULL;
DROP TRIGGER IF EXISTS set_updated_at ON public.teams;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS teams_select ON public.teams;
CREATE POLICY teams_select ON public.teams FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS teams_insert ON public.teams;
CREATE POLICY teams_insert ON public.teams FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS teams_update ON public.teams;
CREATE POLICY teams_update ON public.teams FOR UPDATE
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS teams_delete ON public.teams;
CREATE POLICY teams_delete ON public.teams FOR DELETE USING (public.is_account_member(account_id, 'admin'));

-- ---- team_members ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_members (
  team_id    UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_account ON public.team_members (account_id, user_id);

CREATE OR REPLACE FUNCTION public.team_members_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id = NEW.team_id AND t.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'team does not belong to this account' USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = NEW.user_id AND p.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'user is not a member of this account' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS team_members_check ON public.team_members;
CREATE TRIGGER team_members_check BEFORE INSERT OR UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.team_members_check();
REVOKE ALL ON FUNCTION public.team_members_check() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_members_select ON public.team_members;
CREATE POLICY team_members_select ON public.team_members FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS team_members_insert ON public.team_members;
CREATE POLICY team_members_insert ON public.team_members FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS team_members_update ON public.team_members;
CREATE POLICY team_members_update ON public.team_members FOR UPDATE
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS team_members_delete ON public.team_members;
CREATE POLICY team_members_delete ON public.team_members FOR DELETE USING (public.is_account_member(account_id, 'admin'));

-- ---- routing_rules --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.routing_rules (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  category_id  UUID NOT NULL REFERENCES public.conversation_categories(id) ON DELETE CASCADE,
  team_id      UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  priority_min TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.routing_rules DROP CONSTRAINT IF EXISTS routing_rules_priority_min_check;
ALTER TABLE public.routing_rules ADD CONSTRAINT routing_rules_priority_min_check
  CHECK (priority_min IS NULL OR priority_min IN ('low', 'normal', 'high', 'urgent'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_routing_rules_category ON public.routing_rules (account_id, category_id);
CREATE INDEX IF NOT EXISTS idx_routing_rules_team ON public.routing_rules (team_id);
DROP TRIGGER IF EXISTS set_updated_at ON public.routing_rules;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.routing_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.routing_rules_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.conversation_categories k WHERE k.id = NEW.category_id AND k.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'category does not belong to this account' USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id = NEW.team_id AND t.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'team does not belong to this account' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS routing_rules_check ON public.routing_rules;
CREATE TRIGGER routing_rules_check BEFORE INSERT OR UPDATE ON public.routing_rules
  FOR EACH ROW EXECUTE FUNCTION public.routing_rules_check();
REVOKE ALL ON FUNCTION public.routing_rules_check() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.routing_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS routing_rules_select ON public.routing_rules;
CREATE POLICY routing_rules_select ON public.routing_rules FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS routing_rules_insert ON public.routing_rules;
CREATE POLICY routing_rules_insert ON public.routing_rules FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS routing_rules_update ON public.routing_rules;
CREATE POLICY routing_rules_update ON public.routing_rules FOR UPDATE
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS routing_rules_delete ON public.routing_rules;
CREATE POLICY routing_rules_delete ON public.routing_rules FOR DELETE USING (public.is_account_member(account_id, 'admin'));

-- ---- conversations: team + provenance -------------------------------
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES public.teams(id) ON DELETE SET NULL;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS assignment_source TEXT;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS team_source TEXT;
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_assignment_source_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_assignment_source_check
  CHECK (assignment_source IS NULL OR assignment_source IN ('auto', 'manual'));
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_team_source_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_team_source_check
  CHECK (team_source IS NULL OR team_source IN ('auto', 'manual'));
CREATE INDEX IF NOT EXISTS idx_conversations_account_team
  ON public.conversations (account_id, team_id) WHERE team_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.conversations_check_team()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.team_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.teams t WHERE t.id = NEW.team_id AND t.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'team does not belong to this account' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS conversations_check_team ON public.conversations;
CREATE TRIGGER conversations_check_team BEFORE INSERT OR UPDATE OF team_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_check_team();
REVOKE ALL ON FUNCTION public.conversations_check_team() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.conversations_stamp_sources()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  -- Who is acting: the signed-in user, or (service-role writes made on a
  -- person's behalf, e.g. "Transferir para equipe") the transaction-local
  -- actor support_set_conversation_team() sets. Nobody = an automatic write.
  v_actor uuid := COALESCE(auth.uid(), NULLIF(current_setting('app.actor_user', true), '')::uuid);
  v_who   text := CASE WHEN v_actor IS NOT NULL THEN 'manual' ELSE 'auto' END;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NOT NULL AND NEW.assignment_source IS NULL THEN NEW.assignment_source := v_who; END IF;
    IF NEW.team_id IS NOT NULL AND NEW.team_source IS NULL THEN NEW.team_source := v_who; END IF;
    RETURN NEW;
  END IF;
  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    NEW.assignment_source := CASE WHEN NEW.assigned_agent_id IS NULL THEN NULL ELSE v_who END;
  END IF;
  IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    NEW.team_source := CASE WHEN NEW.team_id IS NULL THEN NULL ELSE v_who END;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS conversations_stamp_sources ON public.conversations;
CREATE TRIGGER conversations_stamp_sources BEFORE INSERT OR UPDATE OF assigned_agent_id, team_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_stamp_sources();

-- Teams are cached by open inboxes: realtime keeps them in step.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'teams') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.teams;
  END IF;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

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
      'sla_breached',
      'team_changed'
    )
  ) NOT VALID;
ALTER TABLE public.conversation_events VALIDATE CONSTRAINT conversation_events_event_type_check;

-- ---- automation triggers: category_set / priority_changed / team_changed
CREATE OR REPLACE FUNCTION public.conversations_enqueue_support_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.category_id IS NOT NULL AND NEW.category_id IS DISTINCT FROM OLD.category_id THEN
    PERFORM public.automation_enqueue_event(
      NEW.account_id, 'category_set', NEW.contact_id, NEW.id,
      jsonb_build_object('category_id', NEW.category_id));
  END IF;
  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    PERFORM public.automation_enqueue_event(
      NEW.account_id, 'priority_changed', NEW.contact_id, NEW.id,
      jsonb_build_object('priority', NEW.priority, 'previous_priority', OLD.priority));
  END IF;
  IF NEW.team_id IS NOT NULL AND NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    PERFORM public.automation_enqueue_event(
      NEW.account_id, 'team_changed', NEW.contact_id, NEW.id,
      jsonb_build_object('team_id', NEW.team_id));
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS conversations_support_events ON public.conversations;
CREATE TRIGGER conversations_support_events
  AFTER UPDATE OF category_id, priority, team_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_enqueue_support_events();
REVOKE ALL ON FUNCTION public.conversations_enqueue_support_events() FROM PUBLIC, anon, authenticated;

-- Engine actions set_category / set_priority / assign_team. Only the
-- non-NULL arguments are written; depth/origin make the events they
-- cause one level deeper than the run (same scheme as 048).
CREATE OR REPLACE FUNCTION public.automation_set_conversation(
  p_account_id      uuid,
  p_conversation_id uuid,
  p_category_id     uuid,
  p_priority        text,
  p_team_id         uuid,
  p_depth           integer,
  p_origin          uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  IF p_priority IS NOT NULL AND p_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'invalid priority %', p_priority;
  END IF;
  PERFORM set_config('app.automation_depth', p_depth::text, true);
  PERFORM set_config('app.automation_origin', COALESCE(p_origin::text, ''), true);
  UPDATE public.conversations c
     SET category_id = COALESCE(p_category_id, c.category_id),
         priority    = COALESCE(p_priority, c.priority),
         team_id     = COALESCE(p_team_id, c.team_id)
   WHERE c.id = p_conversation_id AND c.account_id = p_account_id
  RETURNING c.id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.automation_set_conversation(uuid, uuid, uuid, text, uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automation_set_conversation(uuid, uuid, uuid, text, uuid, integer, uuid) TO service_role;

-- The one write path for team / assignee changes made by the routing rules
-- and by "Transferir para equipe" (service role). `p_actor_user` is the
-- person on whose behalf it runs (NULL = automatic): it is set as a
-- transaction-local actor so conversations_stamp_sources() records
-- 'manual' vs 'auto' correctly, without the caller ever writing the
-- provenance columns. depth/origin carry the automation loop protection
-- (events raised by this update are one level deeper than the run).
--   p_check_assignee  compare-and-set on the assignee the caller last saw
--   p_require_auto    routing mode: never replace a person's assignment or
--                     a team a person chose (guards read the provenance)
-- Returns false when a guard stopped the write (nothing changed).
CREATE OR REPLACE FUNCTION public.support_set_conversation_team(
  p_conversation    uuid,
  p_account         uuid,
  p_team            uuid,
  p_change_team     boolean,
  p_assignee        uuid,
  p_change_assignee boolean,
  p_actor_user      uuid    DEFAULT NULL,
  p_check_assignee  boolean DEFAULT false,
  p_expect_assignee uuid    DEFAULT NULL,
  p_require_auto    boolean DEFAULT false,
  p_depth           integer DEFAULT 0,
  p_origin          uuid    DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  IF p_assignee IS NOT NULL AND p_change_assignee AND NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.user_id = p_assignee AND p.account_id = p_account
  ) THEN
    RAISE EXCEPTION 'assignee is not a member of this account' USING ERRCODE = '23503';
  END IF;
  PERFORM set_config('app.actor_user', COALESCE(p_actor_user::text, ''), true);
  PERFORM set_config('app.automation_depth', COALESCE(p_depth, 0)::text, true);
  PERFORM set_config('app.automation_origin', COALESCE(p_origin::text, ''), true);
  UPDATE public.conversations c
     SET team_id           = CASE WHEN p_change_team THEN p_team ELSE c.team_id END,
         assigned_agent_id = CASE WHEN p_change_assignee THEN p_assignee ELSE c.assigned_agent_id END
   WHERE c.id = p_conversation AND c.account_id = p_account
     AND c.status <> 'closed' AND c.archived_at IS NULL
     AND (NOT p_check_assignee OR c.assigned_agent_id IS NOT DISTINCT FROM p_expect_assignee)
     AND (NOT p_require_auto OR NOT p_change_team OR c.team_source IS NULL OR c.team_source = 'auto')
     AND (NOT p_require_auto OR NOT p_change_assignee OR c.assigned_agent_id IS NULL OR c.assignment_source = 'auto')
  RETURNING c.id INTO v_id;
  PERFORM set_config('app.actor_user', '', true);
  RETURN v_id IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.support_set_conversation_team(uuid, uuid, uuid, boolean, uuid, boolean, uuid, boolean, uuid, boolean, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_set_conversation_team(uuid, uuid, uuid, boolean, uuid, boolean, uuid, boolean, uuid, boolean, integer, uuid) TO service_role;

-- ---- inbox RPCs: + p_team_id ----------------------------------------
DROP FUNCTION IF EXISTS public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean);
DROP FUNCTION IF EXISTS public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean);

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
  IF p_team_id IS NOT NULL THEN
    v_where := v_where || ' AND c.team_id = $14';
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
          p_cursor_grp, p_cursor_ts, p_cursor_id, p_tag_ids, p_channel, p_category_id, p_priority, p_team_id;
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

REVOKE ALL ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean, uuid) TO authenticated, service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text, uuid, text, boolean, uuid)',
    'public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text, uuid, text, boolean, uuid)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'unexpected EXECUTE privileges on %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.automation_set_conversation(uuid, uuid, uuid, text, uuid, integer, uuid)',
    'public.support_set_conversation_team(uuid, uuid, uuid, boolean, uuid, boolean, uuid, boolean, uuid, boolean, integer, uuid)',
    'public.conversations_check_team()',
    'public.conversations_enqueue_support_events()',
    'public.team_members_check()',
    'public.routing_rules_check()'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'unexpected EXECUTE privileges on %', f;
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
