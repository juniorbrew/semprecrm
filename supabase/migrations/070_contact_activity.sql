-- ============================================================
-- 070_contact_activity.sql — inbox panel: "Atividade" timeline.
--
-- 1. conversation_events gets 'deal_stage_changed' (the panel moves a
--    deal and leaves "Negócio X movido de A para B" in the thread).
-- 2. deals.closed_at: when the deal was won / lost, stamped by a trigger
--    (the feed must not present updated_at as the close time).
-- 3. contact_activity(p_contact_id, p_limit, p_before, p_before_id): one
--    chronological feed for a contact, merging conversation events, deals
--    (created / won / lost), tasks (created / completed), appointments,
--    notes, company links and broadcasts received. SECURITY INVOKER:
--    every source is read under the caller's RLS, so another tenant's
--    rows never appear. Every source is capped at p_limit BEFORE the
--    merge (conversation events per conversation, via LATERAL), so cost
--    is bounded by index reads no matter how many events a contact has.
--    Keyset paging on (at, cursor): `cursor` is a per-row uuid derived
--    from the row id, so rows sharing a timestamp are all reachable.
-- 4. account_tag_usage(): tag_id -> number of contacts, for the panel's
--    "most used" suggestions (RLS-scoped, SECURITY INVOKER).
-- 5. Indexes for the per-contact lookups above.
--
-- Idempotent. NOTE (large tables): CREATE INDEX below is plain (a
-- migration runs in a transaction, where CONCURRENTLY is not allowed)
-- and blocks writes on the table while it builds. On a table with many
-- millions of rows, create the same indexes first by hand with
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS <same name> ...; this file
-- then skips them.
--
-- LGPD: on anonymisation the app drops deal_title from the
-- deal_stage_changed events (src/lib/lgpd/anonymize.ts). Deal, task and
-- appointment titles shown in the feed stay, exactly as those records
-- themselves do (anonymisation keeps deals / tasks / events rows and
-- their contact link; notes are deleted, so their feed rows vanish).
-- ============================================================

ALTER TABLE conversation_events DROP CONSTRAINT IF EXISTS conversation_events_event_type_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_event_type_check
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
      'deal_stage_changed'
    )
  ) NOT VALID;
ALTER TABLE conversation_events VALIDATE CONSTRAINT conversation_events_event_type_check;

-- ---- deals.closed_at ---------------------------------------------
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.deals_stamp_closed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('won', 'lost') THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR NEW.closed_at IS NULL THEN
      NEW.closed_at := NOW();
    END IF;
  ELSE
    NEW.closed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- One-time backfill from updated_at (best information available). The
-- updated_at trigger is parked so the backfill does not touch updated_at;
-- it runs before the closed_at trigger exists and only fills NULLs, so a
-- re-run changes nothing.
ALTER TABLE public.deals DISABLE TRIGGER set_updated_at;
UPDATE public.deals SET closed_at = updated_at WHERE status IN ('won', 'lost') AND closed_at IS NULL;
ALTER TABLE public.deals ENABLE TRIGGER set_updated_at;

DROP TRIGGER IF EXISTS deals_stamp_closed_at ON public.deals;
CREATE TRIGGER deals_stamp_closed_at
  BEFORE INSERT OR UPDATE OF status ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_stamp_closed_at();

-- ---- indexes ------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_conversation_events_conv_created_desc
  ON public.conversation_events (conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_deals_contact_created
  ON public.deals (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_contact_closed
  ON public.deals (contact_id, closed_at DESC) WHERE closed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_contact_created
  ON public.tasks (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_contact_completed
  ON public.tasks (contact_id, completed_at DESC) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contact_notes_contact_created
  ON public.contact_notes (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_events_contact_created
  ON public.calendar_events (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact_sent
  ON public.broadcast_recipients (contact_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_companies_contact_created
  ON public.contact_companies (contact_id, created_at DESC);

-- ---- contact_activity ---------------------------------------------
DROP FUNCTION IF EXISTS public.contact_activity(uuid, integer, timestamptz);
DROP FUNCTION IF EXISTS public.contact_activity(uuid, integer, timestamptz, uuid);

CREATE OR REPLACE FUNCTION public.activity_cursor(p_row_id text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT md5(p_row_id)::uuid $$;

CREATE OR REPLACE FUNCTION public.contact_activity(
  p_contact_id uuid,
  p_limit      integer     DEFAULT 20,
  p_before     timestamptz DEFAULT NULL,
  p_before_id  uuid        DEFAULT NULL
) RETURNS TABLE (
  id              text,
  type            text,
  at              timestamptz,
  title           text,
  payload         jsonb,
  actor_name      text,
  link_kind       text,
  link_id         uuid,
  conversation_id uuid,
  cursor          uuid
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH lim AS (SELECT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50) AS cap),
  bef AS (
    SELECT COALESCE(p_before, 'infinity'::timestamptz) AS ts,
           COALESCE(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid) AS bid
  ),
  ev AS (
    SELECT q.* FROM (
      SELECT 'ev:' || e.id::text AS id, 'conv_' || e.event_type AS type,
             e.created_at AS at,
             COALESCE(e.payload->>'deal_title', e.payload->>'tag_name', e.payload->>'assignee_name') AS title,
             e.payload AS payload,
             COALESCE((SELECT p.full_name FROM profiles p WHERE p.user_id = e.actor_user_id LIMIT 1),
                      e.payload->>'actor_name') AS actor_name,
             'conversation'::text AS link_kind, e.conversation_id AS link_id,
             e.conversation_id AS conversation_id,
             activity_cursor('ev:' || e.id::text) AS cursor
        FROM conversations c
        CROSS JOIN LATERAL (
          SELECT x.* FROM conversation_events x
           WHERE x.conversation_id = c.id
             AND x.event_type <> 'note_added'
             AND x.created_at <= (SELECT ts FROM bef)
           ORDER BY x.created_at DESC, x.id DESC
           LIMIT (SELECT cap FROM lim)
        ) e
       WHERE c.contact_id = p_contact_id
    ) q
    WHERE (q.at, q.cursor) < ((SELECT ts FROM bef), (SELECT bid FROM bef))
    ORDER BY q.at DESC, q.cursor DESC LIMIT (SELECT cap FROM lim)
  ),
  dc AS (
    SELECT q.* FROM (
      SELECT 'dc:' || d.id::text AS id, 'deal_created'::text AS type, d.created_at AS at, d.title AS title,
             jsonb_build_object('value', d.value) AS payload,
             (SELECT p.full_name FROM profiles p WHERE p.user_id = d.user_id LIMIT 1) AS actor_name,
             'deal'::text AS link_kind, d.id AS link_id, d.conversation_id AS conversation_id,
             activity_cursor('dc:' || d.id::text) AS cursor
        FROM deals d
       WHERE d.contact_id = p_contact_id AND d.created_at <= (SELECT ts FROM bef)
    ) q
    WHERE (q.at, q.cursor) < ((SELECT ts FROM bef), (SELECT bid FROM bef))
    ORDER BY q.at DESC, q.cursor DESC LIMIT (SELECT cap FROM lim)
  ),
  dw AS (
    SELECT q.* FROM (
      SELECT 'dw:' || d.id::text AS id, 'deal_' || d.status AS type, d.closed_at AS at, d.title AS title,
             jsonb_build_object('value', d.value) AS payload,
             NULL::text AS actor_name, 'deal'::text AS link_kind, d.id AS link_id,
             d.conversation_id AS conversation_id,
             activity_cursor('dw:' || d.id::text) AS cursor
        FROM deals d
       WHERE d.contact_id = p_contact_id AND d.status IN ('won', 'lost')
         AND d.closed_at IS NOT NULL AND d.closed_at <= (SELECT ts FROM bef)
    ) q
    WHERE (q.at, q.cursor) < ((SELECT ts FROM bef), (SELECT bid FROM bef))
    ORDER BY q.at DESC, q.cursor DESC LIMIT (SELECT cap FROM lim)
  ),
  tc AS (
    SELECT q.* FROM (
      SELECT 'tc:' || t.id::text AS id, 'task_created'::text AS type, t.created_at AS at, t.title AS title,
             '{}'::jsonb AS payload,
             (SELECT p.full_name FROM profiles p WHERE p.user_id = t.created_by LIMIT 1) AS actor_name,
             'task'::text AS link_kind, t.id AS link_id, t.conversation_id AS conversation_id,
             activity_cursor('tc:' || t.id::text) AS cursor
        FROM tasks t
       WHERE t.contact_id = p_contact_id AND t.created_at <= (SELECT ts FROM bef)
    ) q
    WHERE (q.at, q.cursor) < ((SELECT ts FROM bef), (SELECT bid FROM bef))
    ORDER BY q.at DESC, q.cursor DESC LIMIT (SELECT cap FROM lim)
  ),
  td AS (
    SELECT q.* FROM (
      SELECT 'td:' || t.id::text AS id, 'task_done'::text AS type, t.completed_at AS at, t.title AS title,
             '{}'::jsonb AS payload,
             (SELECT p.full_name FROM profiles p WHERE p.user_id = t.assignee_user_id LIMIT 1) AS actor_name,
             'task'::text AS link_kind, t.id AS link_id, t.conversation_id AS conversation_id,
             activity_cursor('td:' || t.id::text) AS cursor
        FROM tasks t
       WHERE t.contact_id = p_contact_id AND t.completed_at IS NOT NULL
         AND t.completed_at <= (SELECT ts FROM bef)
    ) q
    WHERE (q.at, q.cursor) < ((SELECT ts FROM bef), (SELECT bid FROM bef))
    ORDER BY q.at DESC, q.cursor DESC LIMIT (SELECT cap FROM lim)
  ),
  ap AS (
    SELECT q.* FROM (
      SELECT 'ap:' || a.id::text AS id, 'appointment'::text AS type, a.created_at AS at, a.title AS title,
             jsonb_build_object('starts_at', a.starts_at) AS payload,
             (SELECT p.full_name FROM profiles p WHERE p.user_id = a.created_by LIMIT 1) AS actor_name,
             'event'::text AS link_kind, a.id AS link_id, a.conversation_id AS conversation_id,
             activity_cursor('ap:' || a.id::text) AS cursor
        FROM calendar_events a
       WHERE a.contact_id = p_contact_id AND a.created_at <= (SELECT ts FROM bef)
    ) q
    WHERE (q.at, q.cursor) < ((SELECT ts FROM bef), (SELECT bid FROM bef))
    ORDER BY q.at DESC, q.cursor DESC LIMIT (SELECT cap FROM lim)
  ),
  nt AS (
    SELECT q.* FROM (
      SELECT 'nt:' || n.id::text AS id, 'note'::text AS type, n.created_at AS at, left(n.note_text, 120) AS title,
             '{}'::jsonb AS payload,
             (SELECT p.full_name FROM profiles p WHERE p.user_id = n.user_id LIMIT 1) AS actor_name,
             'note'::text AS link_kind, n.id AS link_id, NULL::uuid AS conversation_id,
             activity_cursor('nt:' || n.id::text) AS cursor
        FROM contact_notes n
       WHERE n.contact_id = p_contact_id AND n.created_at <= (SELECT ts FROM bef)
    ) q
    WHERE (q.at, q.cursor) < ((SELECT ts FROM bef), (SELECT bid FROM bef))
    ORDER BY q.at DESC, q.cursor DESC LIMIT (SELECT cap FROM lim)
  ),
  co AS (
    SELECT q.* FROM (
      SELECT 'co:' || cc.company_id::text AS id, 'company_linked'::text AS type, cc.created_at AS at,
             COALESCE(k.nome_fantasia, k.razao_social) AS title,
             jsonb_build_object('is_primary', cc.is_primary) AS payload,
             NULL::text AS actor_name, 'company'::text AS link_kind, cc.company_id AS link_id,
             NULL::uuid AS conversation_id,
             activity_cursor('co:' || cc.company_id::text) AS cursor
        FROM contact_companies cc
        JOIN companies k ON k.id = cc.company_id
       WHERE cc.contact_id = p_contact_id AND cc.created_at <= (SELECT ts FROM bef)
    ) q
    WHERE (q.at, q.cursor) < ((SELECT ts FROM bef), (SELECT bid FROM bef))
    ORDER BY q.at DESC, q.cursor DESC LIMIT (SELECT cap FROM lim)
  ),
  bc AS (
    SELECT q.* FROM (
      SELECT 'bc:' || r.id::text AS id,
             CASE WHEN r.status = 'failed' THEN 'campaign_failed' ELSE 'campaign_sent' END AS type,
             COALESCE(r.sent_at, r.created_at) AS at, b.name AS title,
             '{}'::jsonb AS payload,
             NULL::text AS actor_name, 'broadcast'::text AS link_kind, b.id AS link_id,
             NULL::uuid AS conversation_id,
             activity_cursor('bc:' || r.id::text) AS cursor
        FROM broadcast_recipients r
        JOIN broadcasts b ON b.id = r.broadcast_id
       WHERE r.contact_id = p_contact_id
         AND (r.sent_at IS NOT NULL OR r.status = 'failed')
         AND COALESCE(r.sent_at, r.created_at) <= (SELECT ts FROM bef)
    ) q
    WHERE (q.at, q.cursor) < ((SELECT ts FROM bef), (SELECT bid FROM bef))
    ORDER BY q.at DESC, q.cursor DESC LIMIT (SELECT cap FROM lim)
  ),
  merged AS (
    SELECT * FROM ev UNION ALL SELECT * FROM dc UNION ALL SELECT * FROM dw
    UNION ALL SELECT * FROM tc UNION ALL SELECT * FROM td UNION ALL SELECT * FROM ap
    UNION ALL SELECT * FROM nt UNION ALL SELECT * FROM co UNION ALL SELECT * FROM bc
  )
  SELECT * FROM merged m ORDER BY m.at DESC, m.cursor DESC LIMIT (SELECT cap FROM lim);
$$;

REVOKE ALL ON FUNCTION public.contact_activity(uuid, integer, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contact_activity(uuid, integer, timestamptz, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.activity_cursor(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activity_cursor(text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.account_tag_usage();

CREATE OR REPLACE FUNCTION public.account_tag_usage()
RETURNS TABLE (tag_id uuid, uses bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT ct.tag_id, count(*) FROM contact_tags ct GROUP BY ct.tag_id;
$$;

REVOKE ALL ON FUNCTION public.account_tag_usage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_tag_usage() TO authenticated, service_role;
