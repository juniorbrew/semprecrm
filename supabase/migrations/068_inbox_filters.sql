-- ============================================================
-- 068_inbox_filters.sql — inbox filters by contact tag and WhatsApp channel.
--
-- Extends the 067 functions with two optional, trailing parameters
-- (both default NULL = no filter, so old callers keep working):
--   p_tag_ids  uuid[]  the contact has ANY of these tags (empty = none)
--   p_channel  text    'official' | 'qr'
--     - inbox_conversation_page: filters the rows.
--     - inbox_counts: filters the tab badges AND the Radar chips (a tag /
--       channel narrows everything the list shows).
--     - inbox_search_ids: same two filters on every search source.
-- The old signatures are dropped first: keeping both would make
-- PostgREST reject calls that omit the new arguments as ambiguous.
-- Also indexes contact_tags by (tag_id, contact_id) for the tag filter.
-- Idempotent.
-- ============================================================

DROP FUNCTION IF EXISTS public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer);
DROP FUNCTION IF EXISTS public.inbox_counts(uuid, text, boolean, text, integer, integer);
DROP FUNCTION IF EXISTS public.inbox_search_ids(uuid, text);

CREATE INDEX IF NOT EXISTS idx_contact_tags_tag_contact
  ON public.contact_tags (tag_id, contact_id);

CREATE OR REPLACE FUNCTION public.inbox_search_ids(
  p_account_id uuid,
  p_pattern    text,
  p_tag_ids    uuid[] DEFAULT NULL,
  p_channel    text   DEFAULT NULL
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
  UNION
  SELECT s.id FROM public.conversations s
    JOIN public.contacts k ON k.id = s.contact_id
   WHERE public.is_account_member(p_account_id) AND s.account_id = p_account_id
     AND (k.name ILIKE p_pattern OR k.phone ILIKE p_pattern)
     AND (COALESCE(cardinality(p_tag_ids), 0) = 0 OR EXISTS (SELECT 1 FROM public.contact_tags ct WHERE ct.contact_id = s.contact_id AND ct.tag_id = ANY (p_tag_ids)))
     AND (p_channel IS NULL OR COALESCE(s.channel, 'official') = p_channel)
  UNION
  SELECT s.id FROM public.conversations s
    JOIN public.contact_companies cc ON cc.contact_id = s.contact_id AND cc.is_primary
    JOIN public.companies co ON co.id = cc.company_id
   WHERE public.is_account_member(p_account_id) AND s.account_id = p_account_id
     AND (co.nome_fantasia ILIKE p_pattern OR co.razao_social ILIKE p_pattern)
     AND (COALESCE(cardinality(p_tag_ids), 0) = 0 OR EXISTS (SELECT 1 FROM public.contact_tags ct WHERE ct.contact_id = s.contact_id AND ct.tag_id = ANY (p_tag_ids)))
     AND (p_channel IS NULL OR COALESCE(s.channel, 'official') = p_channel);
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
  p_channel       text        DEFAULT NULL    -- 'official' | 'qr'
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

  -- Search: contact name / phone, last message preview, primary company
  -- (see inbox_search_ids below).
  IF p_pattern IS NOT NULL AND p_pattern <> '' THEN
    v_where := v_where || ' AND c.id IN (SELECT public.inbox_search_ids($1, $6, $10, $11))';
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
          p_cursor_grp, p_cursor_ts, p_cursor_id, p_tag_ids, p_channel;
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
  p_channel       text    DEFAULT NULL
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

REVOKE ALL ON FUNCTION public.inbox_search_ids(uuid, text, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_search_ids(uuid, text, uuid[], text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text) TO authenticated, service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.inbox_search_ids(uuid, text, uuid[], text)',
    'public.inbox_conversation_page(uuid, text, text, boolean, text, integer, integer, text, integer, timestamptz, uuid, integer, uuid[], text)',
    'public.inbox_counts(uuid, text, boolean, text, integer, integer, uuid[], text)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'unexpected EXECUTE privileges on %', f;
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
