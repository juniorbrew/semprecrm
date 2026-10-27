-- ============================================================
-- 100 — Instagram Direct e Facebook Messenger no inbox (parte A, omni-base).
--
--   * contacts.phone deixa de ser obrigatório; entram instagram_id (IGSID)
--     e messenger_id (PSID), únicos por conta. Todo contato tem pelo menos
--     uma das três identidades.
--   * conversations.channel / messages.channel / ai_agents.channels passam a
--     aceitar 'instagram' e 'messenger'.
--   * inbox_conversation_page (079) e support_report* (075) aceitam os canais
--     novos em p_channel (inbox_counts não valida o canal, nada a mudar).
--   * meta_messaging_channels: uma conexão de cada tipo por conta; o token
--     (cifrado com encryption.ts) só é legível pelo servidor (regra da 076).
--
-- phone_normalized (022) vira NULL quando phone é NULL e o índice único
-- parcial (WHERE phone_normalized <> '') ignora essas linhas.
-- Idempotente. Mantenha as listas de canais em sync com src/types/index.ts.
-- ============================================================
BEGIN;

-- ---- 1. contatos ------------------------------------------------------
ALTER TABLE public.contacts ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS instagram_id TEXT;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS messenger_id TEXT;

ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_instagram_id_check;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_instagram_id_check
  CHECK (instagram_id IS NULL OR btrim(instagram_id) <> '');
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_messenger_id_check;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_messenger_id_check
  CHECK (messenger_id IS NULL OR btrim(messenger_id) <> '');
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_identity_check;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_identity_check
  CHECK (phone IS NOT NULL OR instagram_id IS NOT NULL OR messenger_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_instagram_id
  ON public.contacts (account_id, instagram_id) WHERE instagram_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_messenger_id
  ON public.contacts (account_id, messenger_id) WHERE messenger_id IS NOT NULL;

-- ---- 2. canais aceitos ------------------------------------------------
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('official', 'qr', 'instagram', 'messenger'));
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_channel_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_channel_check
  CHECK (channel IN ('official', 'qr', 'instagram', 'messenger'));
ALTER TABLE public.ai_agents DROP CONSTRAINT IF EXISTS ai_agents_channels_check;
ALTER TABLE public.ai_agents ADD CONSTRAINT ai_agents_channels_check
  CHECK (channels <@ ARRAY['official', 'qr', 'instagram', 'messenger']::TEXT[]);

-- ---- 3. conexões Meta -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meta_messaging_channels (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('instagram', 'messenger')),
  external_id      TEXT NOT NULL CHECK (btrim(external_id) <> ''),  -- IG user id / Page id (entry.id)
  name             TEXT,
  picture_url      TEXT,
  access_token     TEXT NOT NULL,                                   -- ciphertext (encryption.ts)
  token_expires_at TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  connected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, kind),
  UNIQUE (kind, external_id)
);

DROP TRIGGER IF EXISTS set_updated_at ON public.meta_messaging_channels;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_messaging_channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.meta_messaging_channels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.meta_messaging_channels FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.meta_messaging_channels TO service_role;
-- 076: o navegador lê tudo menos o token; escrever é só pelo servidor.
GRANT SELECT (
  id, account_id, kind, external_id, name, picture_url, token_expires_at,
  status, connected_at, created_at, updated_at
) ON public.meta_messaging_channels TO authenticated;

DROP POLICY IF EXISTS meta_messaging_channels_select ON public.meta_messaging_channels;
CREATE POLICY meta_messaging_channels_select ON public.meta_messaging_channels
  FOR SELECT USING (is_account_member(account_id));

-- ---- 4. RPCs com p_channel (última definição de cada uma) --------------
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
  p_channel       text        DEFAULT NULL,   -- 'official' | 'qr' | 'instagram' | 'messenger'
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
  IF p_channel IS NOT NULL AND p_channel NOT IN ('official', 'qr', 'instagram', 'messenger') THEN
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

CREATE OR REPLACE FUNCTION public.support_report(
  p_account_id  uuid,
  p_from        date,
  p_to          date,
  p_group       text DEFAULT 'all',
  p_team_id     uuid DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_agent_id    uuid DEFAULT NULL,
  p_channel     text DEFAULT NULL
) RETURNS TABLE (
  group_key         text,
  opened            bigint,
  resolved          bigint,
  backlog           bigint,
  fr_count          bigint,
  fr_avg_seconds    double precision,
  fr_median_seconds double precision,
  fr_p90_seconds    double precision,
  res_count         bigint,
  res_avg_seconds   double precision,
  res_median_seconds double precision,
  res_p90_seconds   double precision,
  sla_met           bigint,
  sla_missed        bigint,
  reopened          bigint,
  csat_sent         bigint,
  csat_answered     bigint,
  csat_avg          numeric
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tz   text;
  v_from timestamptz;
  v_to   timestamptz;
  v_now  timestamptz := now();
BEGIN
  IF NOT public.is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'reports are for account admins' USING ERRCODE = '42501';
  END IF;
  IF p_group IS NULL OR p_group NOT IN ('all', 'category', 'team', 'agent', 'priority') THEN
    RAISE EXCEPTION 'invalid group %', p_group USING ERRCODE = '22023';
  END IF;
  IF p_channel IS NOT NULL AND p_channel NOT IN ('official', 'qr', 'instagram', 'messenger') THEN
    RAISE EXCEPTION 'invalid channel %', p_channel USING ERRCODE = '22023';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'invalid period' USING ERRCODE = '22023';
  END IF;

  v_tz   := public.report_timezone(p_account_id);
  v_from := p_from::timestamp AT TIME ZONE v_tz;
  v_to   := (p_to + 1)::timestamp AT TIME ZONE v_tz;

  RETURN QUERY
  WITH conv AS (
    SELECT
      COALESCE(
      CASE p_group
        WHEN 'category' THEN c.category_id::text
        WHEN 'team'     THEN c.team_id::text
        WHEN 'agent'    THEN c.assigned_agent_id::text
        WHEN 'priority' THEN c.priority
        ELSE 'all'
      END,
        '~') AS k,
      c.status, c.created_at, c.resolved_at, c.service_count,
      c.first_response_at, c.first_response_seconds, c.first_response_due_at,
      c.last_customer_message_at, c.resolution_due_at,
      (c.created_at >= v_from AND c.created_at < v_to) AS in_opened,
      (c.status = 'closed' AND c.resolved_at >= v_from AND c.resolved_at < v_to) AS in_resolved,
      (c.first_response_at >= v_from AND c.first_response_at < v_to AND c.first_response_seconds IS NOT NULL) AS in_fr
    FROM public.conversations c
    WHERE c.account_id = p_account_id
      AND (p_team_id IS NULL OR c.team_id = p_team_id)
      AND (p_category_id IS NULL OR c.category_id = p_category_id)
      AND (p_agent_id IS NULL OR c.assigned_agent_id = p_agent_id)
      AND (p_channel IS NULL OR c.channel = p_channel)
      AND ((c.created_at >= v_from AND c.created_at < v_to)
           OR (c.resolved_at >= v_from AND c.resolved_at < v_to)
           OR (c.first_response_at >= v_from AND c.first_response_at < v_to)
           OR c.status <> 'closed')
  ),
  agg AS (
    SELECT
      k,
      count(*) FILTER (WHERE in_opened) AS opened,
      count(*) FILTER (WHERE in_resolved) AS resolved,
      count(*) FILTER (WHERE status <> 'closed') AS backlog,
      count(*) FILTER (WHERE in_fr) AS fr_count,
      avg(first_response_seconds) FILTER (WHERE in_fr)::double precision AS fr_avg,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY first_response_seconds) FILTER (WHERE in_fr))::double precision AS fr_med,
      (percentile_cont(0.9) WITHIN GROUP (ORDER BY first_response_seconds) FILTER (WHERE in_fr))::double precision AS fr_p90,
      count(*) FILTER (WHERE in_resolved) AS res_count,
      avg(extract(epoch FROM resolved_at - created_at)) FILTER (WHERE in_resolved)::double precision AS res_avg,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at)) FILTER (WHERE in_resolved))::double precision AS res_med,
      (percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM resolved_at - created_at)) FILTER (WHERE in_resolved))::double precision AS res_p90,
      -- first-response target
      count(*) FILTER (WHERE in_opened AND first_response_due_at IS NOT NULL AND last_customer_message_at IS NOT NULL
                        AND first_response_at IS NOT NULL AND first_response_at <= first_response_due_at)
      -- resolution target
      + count(*) FILTER (WHERE in_opened AND resolution_due_at IS NOT NULL AND status = 'closed'
                          AND resolved_at IS NOT NULL AND resolved_at <= resolution_due_at) AS sla_met,
      count(*) FILTER (WHERE in_opened AND first_response_due_at IS NOT NULL AND last_customer_message_at IS NOT NULL
                        AND ((first_response_at IS NOT NULL AND first_response_at > first_response_due_at)
                             OR (first_response_at IS NULL AND first_response_due_at <= v_now)))
      + count(*) FILTER (WHERE in_opened AND resolution_due_at IS NOT NULL
                          AND ((status = 'closed' AND resolved_at IS NOT NULL AND resolved_at > resolution_due_at)
                               OR (status <> 'closed' AND resolution_due_at <= v_now))) AS sla_missed,
      count(*) FILTER (WHERE in_opened AND service_count > 1) AS reopened
    FROM conv
    GROUP BY k
  ),
  sat AS (
    SELECT
      COALESCE(
      CASE p_group
        WHEN 'category' THEN s.category_id::text
        WHEN 'team'     THEN s.team_id::text
        WHEN 'agent'    THEN s.assigned_agent_id::text
        WHEN 'priority' THEN s.priority
        ELSE 'all'
      END,
        '~') AS k,
      count(*) AS sent,
      count(*) FILTER (WHERE s.status = 'answered') AS answered,
      avg(s.score) FILTER (WHERE s.status = 'answered') AS avg_score
    FROM public.csat_responses s
    JOIN public.conversations c2 ON c2.id = s.conversation_id
    WHERE s.account_id = p_account_id
      AND s.status IN ('sent', 'answered', 'expired')
      AND s.sent_at >= v_from AND s.sent_at < v_to
      AND (p_team_id IS NULL OR s.team_id = p_team_id)
      AND (p_category_id IS NULL OR s.category_id = p_category_id)
      AND (p_agent_id IS NULL OR s.assigned_agent_id = p_agent_id)
      AND (p_channel IS NULL OR c2.channel = p_channel)
    GROUP BY 1
  )
  SELECT
    NULLIF(COALESCE(a.k, s2.k), '~'),
    COALESCE(a.opened, 0), COALESCE(a.resolved, 0), COALESCE(a.backlog, 0),
    COALESCE(a.fr_count, 0), a.fr_avg, a.fr_med, a.fr_p90,
    COALESCE(a.res_count, 0), a.res_avg, a.res_med, a.res_p90,
    COALESCE(a.sla_met, 0), COALESCE(a.sla_missed, 0), COALESCE(a.reopened, 0),
    COALESCE(s2.sent, 0), COALESCE(s2.answered, 0), round(s2.avg_score, 2)
  FROM agg a
  FULL OUTER JOIN sat s2 ON s2.k = a.k
  ORDER BY COALESCE(a.opened, 0) DESC, COALESCE(a.k, s2.k) NULLS LAST;
END;
$$;

CREATE OR REPLACE FUNCTION public.support_report_backlog(
  p_account_id  uuid,
  p_team_id     uuid DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_agent_id    uuid DEFAULT NULL,
  p_channel     text DEFAULT NULL
) RETURNS TABLE (bucket text, total bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_account_member(p_account_id, 'admin') THEN
    RAISE EXCEPTION 'reports are for account admins' USING ERRCODE = '42501';
  END IF;
  IF p_channel IS NOT NULL AND p_channel NOT IN ('official', 'qr', 'instagram', 'messenger') THEN
    RAISE EXCEPTION 'invalid channel %', p_channel USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH live AS (
    SELECT CASE
             WHEN now() - c.created_at < INTERVAL '1 day'  THEN 'lt1d'
             WHEN now() - c.created_at < INTERVAL '3 days' THEN 'd1_3'
             WHEN now() - c.created_at < INTERVAL '7 days' THEN 'd3_7'
             ELSE 'gt7'
           END AS b
      FROM public.conversations c
     WHERE c.account_id = p_account_id
       AND c.status <> 'closed' AND c.archived_at IS NULL
       AND (p_team_id IS NULL OR c.team_id = p_team_id)
       AND (p_category_id IS NULL OR c.category_id = p_category_id)
       AND (p_agent_id IS NULL OR c.assigned_agent_id = p_agent_id)
       AND (p_channel IS NULL OR c.channel = p_channel)
  )
  SELECT v.bucket, count(l.b)
    FROM (VALUES ('lt1d', 1), ('d1_3', 2), ('d3_7', 3), ('gt7', 4)) AS v(bucket, ord)
    LEFT JOIN live l ON l.b = v.bucket
   GROUP BY v.bucket, v.ord
   ORDER BY v.ord;
END;
$$;

COMMIT;
