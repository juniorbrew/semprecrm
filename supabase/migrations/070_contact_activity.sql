-- ============================================================
-- 070_contact_activity.sql — inbox panel: "Atividade" timeline.
--
-- 1. conversation_events gets 'deal_stage_changed' (the panel moves a
--    deal and leaves "Negócio X movido de A para B" in the thread).
-- 2. contact_activity(p_contact_id, p_limit, p_before): one chronological
--    feed for a contact, merging conversation events, deals (created /
--    won / lost), tasks (created / completed), appointments, notes,
--    company links and broadcasts received. SECURITY INVOKER: every
--    source table is read under the caller's RLS, so another tenant's
--    rows never appear. Each source is capped at p_limit before the
--    merge, so the cost is bounded by 9 * p_limit index reads.
-- 3. account_tag_usage(): tag_id -> number of contacts, for the panel's
--    "most used" suggestions (RLS-scoped, SECURITY INVOKER).
-- 4. Indexes for the per-contact lookups above.
-- Idempotent.
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

CREATE INDEX IF NOT EXISTS idx_deals_contact_created
  ON public.deals (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_contact_created
  ON public.tasks (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_notes_contact_created
  ON public.contact_notes (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_events_contact_created
  ON public.calendar_events (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact_sent
  ON public.broadcast_recipients (contact_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_companies_contact_created
  ON public.contact_companies (contact_id, created_at DESC);

DROP FUNCTION IF EXISTS public.contact_activity(uuid, integer, timestamptz);

CREATE OR REPLACE FUNCTION public.contact_activity(
  p_contact_id uuid,
  p_limit      integer     DEFAULT 20,
  p_before     timestamptz DEFAULT NULL
) RETURNS TABLE (
  id              text,
  type            text,
  at              timestamptz,
  title           text,
  payload         jsonb,
  actor_name      text,
  link_kind       text,
  link_id         uuid,
  conversation_id uuid
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH lim AS (SELECT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50) AS cap),
  bef AS (SELECT COALESCE(p_before, 'infinity'::timestamptz) AS ts),
  ev AS (
    SELECT 'ev:' || e.id::text AS id, 'conv_' || e.event_type AS type,
           e.created_at AS at,
           COALESCE(e.payload->>'deal_title', e.payload->>'tag_name', e.payload->>'assignee_name') AS title,
           e.payload AS payload,
           COALESCE((SELECT p.full_name FROM profiles p WHERE p.user_id = e.actor_user_id LIMIT 1),
                    e.payload->>'actor_name') AS actor_name,
           'conversation'::text AS link_kind, e.conversation_id AS link_id, e.conversation_id AS conversation_id
      FROM conversation_events e
      JOIN conversations c ON c.id = e.conversation_id
     WHERE c.contact_id = p_contact_id
       AND e.event_type <> 'note_added'
       AND e.created_at < (SELECT ts FROM bef)
     ORDER BY e.created_at DESC LIMIT (SELECT cap FROM lim)
  ),
  dc AS (
    SELECT 'dc:' || d.id::text, 'deal_created', d.created_at, d.title,
           jsonb_build_object('value', d.value),
           (SELECT p.full_name FROM profiles p WHERE p.user_id = d.user_id LIMIT 1),
           'deal', d.id, d.conversation_id
      FROM deals d
     WHERE d.contact_id = p_contact_id AND d.created_at < (SELECT ts FROM bef)
     ORDER BY d.created_at DESC LIMIT (SELECT cap FROM lim)
  ),
  dw AS (
    SELECT 'dw:' || d.id::text, 'deal_' || d.status, d.updated_at, d.title,
           jsonb_build_object('value', d.value),
           NULL::text, 'deal', d.id, d.conversation_id
      FROM deals d
     WHERE d.contact_id = p_contact_id AND d.status IN ('won', 'lost')
       AND d.updated_at < (SELECT ts FROM bef)
     ORDER BY d.updated_at DESC LIMIT (SELECT cap FROM lim)
  ),
  tc AS (
    SELECT 'tc:' || t.id::text, 'task_created', t.created_at, t.title,
           '{}'::jsonb,
           (SELECT p.full_name FROM profiles p WHERE p.user_id = t.created_by LIMIT 1),
           'task', t.id, t.conversation_id
      FROM tasks t
     WHERE t.contact_id = p_contact_id AND t.created_at < (SELECT ts FROM bef)
     ORDER BY t.created_at DESC LIMIT (SELECT cap FROM lim)
  ),
  td AS (
    SELECT 'td:' || t.id::text, 'task_done', t.completed_at, t.title,
           '{}'::jsonb,
           (SELECT p.full_name FROM profiles p WHERE p.user_id = t.assignee_user_id LIMIT 1),
           'task', t.id, t.conversation_id
      FROM tasks t
     WHERE t.contact_id = p_contact_id AND t.completed_at IS NOT NULL
       AND t.completed_at < (SELECT ts FROM bef)
     ORDER BY t.completed_at DESC LIMIT (SELECT cap FROM lim)
  ),
  ap AS (
    SELECT 'ap:' || a.id::text, 'appointment', a.created_at, a.title,
           jsonb_build_object('starts_at', a.starts_at),
           (SELECT p.full_name FROM profiles p WHERE p.user_id = a.created_by LIMIT 1),
           'event', a.id, a.conversation_id
      FROM calendar_events a
     WHERE a.contact_id = p_contact_id AND a.created_at < (SELECT ts FROM bef)
     ORDER BY a.created_at DESC LIMIT (SELECT cap FROM lim)
  ),
  nt AS (
    SELECT 'nt:' || n.id::text, 'note', n.created_at, left(n.note_text, 120),
           '{}'::jsonb,
           (SELECT p.full_name FROM profiles p WHERE p.user_id = n.user_id LIMIT 1),
           'note', n.id, NULL::uuid
      FROM contact_notes n
     WHERE n.contact_id = p_contact_id AND n.created_at < (SELECT ts FROM bef)
     ORDER BY n.created_at DESC LIMIT (SELECT cap FROM lim)
  ),
  co AS (
    SELECT 'co:' || cc.company_id::text, 'company_linked', cc.created_at,
           COALESCE(k.nome_fantasia, k.razao_social),
           jsonb_build_object('is_primary', cc.is_primary),
           NULL::text, 'company', cc.company_id, NULL::uuid
      FROM contact_companies cc
      JOIN companies k ON k.id = cc.company_id
     WHERE cc.contact_id = p_contact_id AND cc.created_at < (SELECT ts FROM bef)
     ORDER BY cc.created_at DESC LIMIT (SELECT cap FROM lim)
  ),
  bc AS (
    SELECT 'bc:' || r.id::text,
           CASE WHEN r.status = 'failed' THEN 'campaign_failed' ELSE 'campaign_sent' END,
           COALESCE(r.sent_at, r.created_at), b.name,
           '{}'::jsonb,
           NULL::text, 'broadcast', b.id, NULL::uuid
      FROM broadcast_recipients r
      JOIN broadcasts b ON b.id = r.broadcast_id
     WHERE r.contact_id = p_contact_id
       AND (r.sent_at IS NOT NULL OR r.status = 'failed')
       AND COALESCE(r.sent_at, r.created_at) < (SELECT ts FROM bef)
     ORDER BY COALESCE(r.sent_at, r.created_at) DESC LIMIT (SELECT cap FROM lim)
  ),
  merged AS (
    SELECT * FROM ev UNION ALL SELECT * FROM dc UNION ALL SELECT * FROM dw
    UNION ALL SELECT * FROM tc UNION ALL SELECT * FROM td UNION ALL SELECT * FROM ap
    UNION ALL SELECT * FROM nt UNION ALL SELECT * FROM co UNION ALL SELECT * FROM bc
  )
  SELECT * FROM merged m ORDER BY m.at DESC LIMIT (SELECT cap FROM lim);
$$;

GRANT EXECUTE ON FUNCTION public.contact_activity(uuid, integer, timestamptz) TO authenticated;

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

GRANT EXECUTE ON FUNCTION public.account_tag_usage() TO authenticated;
