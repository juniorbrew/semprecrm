-- ============================================================
-- 067_inbox_scale.sql — inbox speed and scale.
--
-- What this migration does
--   1. `inbox_conversation_page(...)`: one keyset-paginated page of the
--      inbox list for a tab (queue / mine / all / closed / archived),
--      with the same filters the client used to apply in memory (live
--      status chip, unread-only, Radar bucket, search). Returns rows of
--      `conversations`, so PostgREST can still embed `contact:contacts(*)`.
--        - recency tabs order by COALESCE(last_message_at, created_at)
--          DESC, id DESC (a conversation without a message used to float
--          to the top of the list; it now sorts by when it was created).
--        - the Fila orders like lib/radar/queue.ts: conversations whose
--          customer message is unanswered first (0) by that message's
--          time, then the ones where we spoke last (1), then id.
--      Both are seek ("keyset") cursors: pass the last row's key back.
--   2. `inbox_search_ids(...)`: conversation ids matching a search pattern.
--   3. `inbox_counts(...)`: tab badges and Radar chips in one scan,
--      same population rules as lib/inbox/triage.ts + lib/radar/classify.ts.
--   4. `inbox_radar_match(...)`: SQL twin of classifyConversation().
--   5. Indexes for those queries, trigram (pg_trgm) indexes for the
--      search, and a (conversation_id, created_at DESC, id DESC) index
--      for "latest N messages" / "older messages".
--
-- `inbox_conversation_page` is SECURITY INVOKER: RLS (`is_account_member`) still
-- scopes every row. `inbox_counts` and `inbox_search_ids` are SECURITY DEFINER,
-- each applying the same `is_account_member(account_id)` rule once, up front
-- (non-members get zeros / no ids): counts skip the per-row RLS function call
-- (~25x faster on 5k rows), and search needs the trigram indexes (ILIKE is not
-- leakproof, so RLS forbids using them). `p_account_id` also gives the planner
-- an equality on the indexes' leading column (RLS alone cannot).
--
-- Lock impact: CREATE INDEX (without CONCURRENTLY, so it can run in the
-- migration transaction) takes a SHARE lock — inserts/updates on
-- `conversations` / `messages` / `contacts` / `companies` wait while each
-- index builds. Tables are small today (ms). Before running this on a
-- large table, create the indexes by hand with CREATE INDEX CONCURRENTLY
-- using the same names; the IF NOT EXISTS here then skips them.
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Radar predicate (mirror of lib/radar/classify.ts).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inbox_radar_match(
  p_key           text,
  p_status        text,
  p_assigned      uuid,
  p_customer_at   timestamptz,
  p_agent_at      timestamptz,
  p_sla_minutes   integer,
  p_cooling_hours integer
) RETURNS boolean
LANGUAGE sql
STABLE
-- No SET search_path here on purpose: a SET clause blocks inlining, and this
-- runs per row. It only touches pg_catalog built-ins.
AS $$
  SELECT CASE p_key
    WHEN 'waiting' THEN
      p_status <> 'closed'
      AND p_customer_at IS NOT NULL
      AND (p_agent_at IS NULL OR p_customer_at > p_agent_at)
      AND now() - p_customer_at > make_interval(mins => GREATEST(COALESCE(p_sla_minutes, 0), 0))
    WHEN 'unassigned' THEN
      p_status = 'open' AND p_assigned IS NULL AND p_customer_at IS NOT NULL
    WHEN 'cooling' THEN
      p_status <> 'closed'
      AND p_agent_at IS NOT NULL
      AND (p_customer_at IS NULL OR p_agent_at > p_customer_at)
      AND now() - p_agent_at > make_interval(hours => GREATEST(COALESCE(p_cooling_hours, 0), 0))
    ELSE false
  END;
$$;

-- ------------------------------------------------------------
-- 2. Search: ids of the account's conversations whose contact name /
--    phone, last message preview or primary company matches an ILIKE
--    pattern. SECURITY DEFINER (with the membership check up front)
--    because ILIKE is not leakproof: under RLS the planner may not use
--    the trigram indexes, and every search would scan the tables.
--    Each source is its own indexable subquery (a plain OR across joined
--    tables would force a sequential scan).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inbox_search_ids(
  p_account_id uuid,
  p_pattern    text
) RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id FROM public.conversations s
   WHERE public.is_account_member(p_account_id) AND s.account_id = p_account_id
     AND s.last_message_text ILIKE p_pattern
  UNION
  SELECT s.id FROM public.conversations s
    JOIN public.contacts k ON k.id = s.contact_id
   WHERE public.is_account_member(p_account_id) AND s.account_id = p_account_id
     AND (k.name ILIKE p_pattern OR k.phone ILIKE p_pattern)
  UNION
  SELECT s.id FROM public.conversations s
    JOIN public.contact_companies cc ON cc.contact_id = s.contact_id AND cc.is_primary
    JOIN public.companies co ON co.id = cc.company_id
   WHERE public.is_account_member(p_account_id) AND s.account_id = p_account_id
     AND (co.nome_fantasia ILIKE p_pattern OR co.razao_social ILIKE p_pattern);
$$;

-- ------------------------------------------------------------
-- 3. One page of the conversation list.
-- ------------------------------------------------------------
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
  p_limit         integer     DEFAULT 50
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

  -- Search: contact name / phone, last message preview, primary company
  -- (see inbox_search_ids below).
  IF p_pattern IS NOT NULL AND p_pattern <> '' THEN
    v_where := v_where || ' AND c.id IN (SELECT public.inbox_search_ids($1, $6))';
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
          p_cursor_grp, p_cursor_ts, p_cursor_id;
END;
$$;

-- ------------------------------------------------------------
-- 4. Tab badges + Radar chips.
--    Tab counts honour unread-only / Radar / live filter (the "base
--    pool"); Radar chips count every conversation of the account, like
--    the dashboard card.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inbox_counts(
  p_account_id    uuid,
  p_live          text    DEFAULT 'live',
  p_unread        boolean DEFAULT false,
  p_radar         text    DEFAULT NULL,
  p_sla_minutes   integer DEFAULT 15,
  p_cooling_hours integer DEFAULT 24
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
        (p_unread IS NOT TRUE OR COALESCE(x.unread_count, 0) > 0)
        AND (p_radar IS NULL OR public.inbox_radar_match(
              p_radar, x.status, x.assigned_agent_id,
              x.last_customer_message_at, x.last_agent_message_at,
              p_sla_minutes, p_cooling_hours))
      ) AS in_base
    FROM public.conversations x
    WHERE x.account_id = p_account_id
      AND public.is_account_member(p_account_id)   -- same rule as the conversations_select policy
  ),
  live AS (
    SELECT c.*, (
      c.in_base AND c.archived_at IS NULL AND c.status IN ('open', 'pending')
      AND (p_live = 'live' OR c.status = p_live)
    ) AS in_live
    FROM c
  )
  SELECT
    count(*) FILTER (WHERE in_base AND status = 'open' AND assigned_agent_id IS NULL AND cust IS NOT NULL),
    count(*) FILTER (WHERE in_live AND assigned_agent_id = auth.uid()),
    count(*) FILTER (WHERE in_live),
    count(*) FILTER (WHERE in_base AND archived_at IS NULL AND status = 'closed'),
    count(*) FILTER (WHERE in_base AND archived_at IS NOT NULL),
    count(*) FILTER (WHERE public.inbox_radar_match('waiting', status, assigned_agent_id, cust, agent, p_sla_minutes, p_cooling_hours)),
    count(*) FILTER (WHERE public.inbox_radar_match('unassigned', status, assigned_agent_id, cust, agent, p_sla_minutes, p_cooling_hours)),
    count(*) FILTER (WHERE public.inbox_radar_match('cooling', status, assigned_agent_id, cust, agent, p_sla_minutes, p_cooling_hours))
  FROM live;
$$;

-- Supabase's default privileges grant EXECUTE on new public functions to anon
-- as well, so revoking PUBLIC alone is not enough: revoke anon explicitly.
REVOKE ALL ON FUNCTION public.inbox_radar_match(text, text, uuid, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_radar_match(text, text, uuid, timestamptz, timestamptz, integer, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_search_ids(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_search_ids(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer) TO authenticated, service_role;

-- Smoke check: signed-out callers must not reach any of them.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.inbox_radar_match(text, text, uuid, timestamptz, timestamptz, integer, integer)',
    'public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer)',
    'public.inbox_search_ids(uuid, text)',
    'public.inbox_counts(uuid, text, boolean, text, integer, integer)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'unexpected EXECUTE privileges on %', f;
    END IF;
  END LOOP;
END;
$$;

-- ------------------------------------------------------------
-- 5. Indexes. Partial indexes mirror the tab predicates so each list
--    is an ordered index scan that stops after LIMIT rows.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_conversations_live_recent
  ON public.conversations (account_id, (COALESCE(last_message_at, created_at)) DESC, id DESC)
  WHERE archived_at IS NULL AND status IN ('open', 'pending');

CREATE INDEX IF NOT EXISTS idx_conversations_mine_live_recent
  ON public.conversations (account_id, assigned_agent_id, (COALESCE(last_message_at, created_at)) DESC, id DESC)
  WHERE archived_at IS NULL AND status IN ('open', 'pending');

CREATE INDEX IF NOT EXISTS idx_conversations_closed_recent
  ON public.conversations (account_id, (COALESCE(last_message_at, created_at)) DESC, id DESC)
  WHERE archived_at IS NULL AND status = 'closed';

CREATE INDEX IF NOT EXISTS idx_conversations_archived_recent
  ON public.conversations (account_id, (COALESCE(last_message_at, created_at)) DESC, id DESC)
  WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_queue
  ON public.conversations (
    account_id,
    (CASE WHEN last_agent_message_at IS NULL OR last_agent_message_at < last_customer_message_at THEN 0 ELSE 1 END),
    last_customer_message_at,
    id
  )
  WHERE status = 'open' AND assigned_agent_id IS NULL AND last_customer_message_at IS NOT NULL;

-- Latest N / older-than-cursor messages of one conversation. Supersedes
-- idx_messages_conversation (conversation_id) for these reads; the old
-- index is left in place (still used by FK cascades / other queries).
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON public.messages (conversation_id, created_at DESC, id DESC);

-- Trigram indexes for the inbox search. pg_trgm may live in `public` or
-- `extensions` (see 047 / 063), hence the dynamic operator-class schema.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DO $$
DECLARE v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  EXECUTE pg_catalog.format('CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm ON public.contacts USING gin (name %I.gin_trgm_ops)', v_schema);
  EXECUTE pg_catalog.format('CREATE INDEX IF NOT EXISTS idx_contacts_phone_trgm ON public.contacts USING gin (phone %I.gin_trgm_ops)', v_schema);
  EXECUTE pg_catalog.format('CREATE INDEX IF NOT EXISTS idx_conversations_last_text_trgm ON public.conversations USING gin (last_message_text %I.gin_trgm_ops)', v_schema);
  EXECUTE pg_catalog.format('CREATE INDEX IF NOT EXISTS idx_companies_nome_fantasia_trgm ON public.companies USING gin (nome_fantasia %I.gin_trgm_ops)', v_schema);
  EXECUTE pg_catalog.format('CREATE INDEX IF NOT EXISTS idx_companies_razao_social_trgm ON public.companies USING gin (razao_social %I.gin_trgm_ops)', v_schema);
END;
$$;

NOTIFY pgrst, 'reload schema';
