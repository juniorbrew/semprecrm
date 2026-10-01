-- ============================================================
-- 074_support_csat.sql — SempreCRM for support: satisfaction survey (CSAT).
--
-- 1. csat_settings: one row per account (members read, admins write).
--    No row = the survey is off.
-- 2. csat_responses: one row per conversation (unique), written ONLY by the
--    service role (cron sends, inbound pipeline records the answer).
--    Members read. The row snapshots team / category / priority / agent
--    at send time so the reports keep their meaning if the conversation
--    changes later. status: sent -> answered | expired; or skipped (final
--    reason in skip_reason, no message sent).
-- 3. csat_jobs: the small queue behind the survey. A trigger on
--    conversations enqueues one job when a conversation is closed (when the
--    survey is enabled) `delay_minutes` ahead; reopening cancels it. The
--    cron (/api/support/csat/cron) claims due jobs with SKIP LOCKED and
--    decides eligibility at send time (resolution, cooldown, opt-out, 24 h
--    window...). The trigger never blocks a resolve.
-- 4. csat_claim_jobs / csat_expire / csat_record_answer /
--    csat_record_comment: service role only. Recording an answer is ONE
--    atomic statement (status sent -> answered, event, automation trigger)
--    so two deliveries of the same reply cannot both win.
-- 5. messages.origin: + 'csat' (059 + 066 list kept).
--    conversation_events: + csat_sent, csat_answered (073 list kept).
--    Automation trigger `csat_received` (context: score) is raised from
--    the existing automation_event_queue (migration 048).
--
-- LGPD: `comment` may hold personal data. The app clears it on
-- anonymisation and exports it with the contact's data (src/lib/lgpd).
-- Idempotent.
-- ============================================================

-- ---- csat_settings ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.csat_settings (
  account_id       UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  scale            TEXT NOT NULL DEFAULT 'stars5',
  delay_minutes    INTEGER NOT NULL DEFAULT 5,
  message_text     TEXT NOT NULL DEFAULT 'Como foi o atendimento? Responda de 1 a 5, sendo 5 muito bom.',
  thanks_text      TEXT NOT NULL DEFAULT 'Obrigado pela sua avaliação!',
  ask_comment      BOOLEAN NOT NULL DEFAULT true,
  cooldown_days    INTEGER NOT NULL DEFAULT 7,
  only_categories  UUID[] NOT NULL DEFAULT '{}',
  skip_resolutions TEXT[] NOT NULL DEFAULT ARRAY['not_applicable', 'duplicate', 'expired'],
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.csat_settings DROP CONSTRAINT IF EXISTS csat_settings_scale_check;
ALTER TABLE public.csat_settings ADD CONSTRAINT csat_settings_scale_check CHECK (scale IN ('stars5', 'thumbs'));
ALTER TABLE public.csat_settings DROP CONSTRAINT IF EXISTS csat_settings_delay_check;
ALTER TABLE public.csat_settings ADD CONSTRAINT csat_settings_delay_check CHECK (delay_minutes BETWEEN 0 AND 1440);
ALTER TABLE public.csat_settings DROP CONSTRAINT IF EXISTS csat_settings_cooldown_check;
ALTER TABLE public.csat_settings ADD CONSTRAINT csat_settings_cooldown_check CHECK (cooldown_days BETWEEN 0 AND 365);
ALTER TABLE public.csat_settings DROP CONSTRAINT IF EXISTS csat_settings_message_check;
ALTER TABLE public.csat_settings ADD CONSTRAINT csat_settings_message_check CHECK (char_length(btrim(message_text)) BETWEEN 1 AND 1000);
ALTER TABLE public.csat_settings DROP CONSTRAINT IF EXISTS csat_settings_thanks_check;
ALTER TABLE public.csat_settings ADD CONSTRAINT csat_settings_thanks_check CHECK (char_length(thanks_text) <= 500);
ALTER TABLE public.csat_settings DROP CONSTRAINT IF EXISTS csat_settings_skip_check;
ALTER TABLE public.csat_settings ADD CONSTRAINT csat_settings_skip_check
  CHECK (skip_resolutions <@ ARRAY['resolved', 'not_applicable', 'closed_by_customer', 'expired', 'duplicate']);

DROP TRIGGER IF EXISTS set_updated_at ON public.csat_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.csat_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.csat_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS csat_settings_select ON public.csat_settings;
CREATE POLICY csat_settings_select ON public.csat_settings FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS csat_settings_insert ON public.csat_settings;
CREATE POLICY csat_settings_insert ON public.csat_settings FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS csat_settings_update ON public.csat_settings;
CREATE POLICY csat_settings_update ON public.csat_settings FOR UPDATE
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS csat_settings_delete ON public.csat_settings;
CREATE POLICY csat_settings_delete ON public.csat_settings FOR DELETE USING (public.is_account_member(account_id, 'admin'));

-- ---- csat_responses ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.csat_responses (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id           UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id      UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id           UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  team_id              UUID REFERENCES public.teams(id) ON DELETE SET NULL,
  category_id          UUID REFERENCES public.conversation_categories(id) ON DELETE SET NULL,
  priority             TEXT,
  assigned_agent_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  score                SMALLINT,
  comment              TEXT,
  status               TEXT NOT NULL DEFAULT 'sent',
  skip_reason          TEXT,
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at          TIMESTAMPTZ,
  comment_requested_at TIMESTAMPTZ,
  comment_received_at  TIMESTAMPTZ,
  message_id           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.csat_responses DROP CONSTRAINT IF EXISTS csat_responses_score_check;
ALTER TABLE public.csat_responses ADD CONSTRAINT csat_responses_score_check CHECK (score IS NULL OR score BETWEEN 1 AND 5);
ALTER TABLE public.csat_responses DROP CONSTRAINT IF EXISTS csat_responses_comment_check;
ALTER TABLE public.csat_responses ADD CONSTRAINT csat_responses_comment_check CHECK (comment IS NULL OR char_length(comment) <= 500);
ALTER TABLE public.csat_responses DROP CONSTRAINT IF EXISTS csat_responses_status_check;
ALTER TABLE public.csat_responses ADD CONSTRAINT csat_responses_status_check CHECK (status IN ('sent', 'answered', 'expired', 'skipped'));
ALTER TABLE public.csat_responses DROP CONSTRAINT IF EXISTS csat_responses_answered_check;
ALTER TABLE public.csat_responses ADD CONSTRAINT csat_responses_answered_check CHECK (status <> 'answered' OR score IS NOT NULL);
ALTER TABLE public.csat_responses DROP CONSTRAINT IF EXISTS csat_responses_priority_check;
ALTER TABLE public.csat_responses ADD CONSTRAINT csat_responses_priority_check
  CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high', 'urgent'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_csat_responses_conversation ON public.csat_responses (conversation_id);
-- Inbound lookup: the contact's survey that still waits for an answer / comment.
CREATE INDEX IF NOT EXISTS idx_csat_responses_pending
  ON public.csat_responses (contact_id, sent_at DESC) WHERE status IN ('sent', 'answered');
-- Cooldown + reports.
CREATE INDEX IF NOT EXISTS idx_csat_responses_account_sent
  ON public.csat_responses (account_id, sent_at) WHERE status <> 'skipped';

ALTER TABLE public.csat_responses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS csat_responses_select ON public.csat_responses;
CREATE POLICY csat_responses_select ON public.csat_responses FOR SELECT USING (public.is_account_member(account_id));
-- No insert / update / delete policies: the service role writes.

-- ---- csat_jobs --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.csat_jobs (
  id              BIGSERIAL PRIMARY KEY,
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  service_count   INTEGER NOT NULL DEFAULT 1,
  run_at          TIMESTAMPTZ NOT NULL,
  claimed_at      TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0,
  processed_at    TIMESTAMPTZ,
  result          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One job per conversation attendance: a repeated enqueue changes nothing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_csat_jobs_attendance ON public.csat_jobs (conversation_id, service_count);
CREATE INDEX IF NOT EXISTS idx_csat_jobs_due ON public.csat_jobs (run_at) WHERE processed_at IS NULL;
ALTER TABLE public.csat_jobs ENABLE ROW LEVEL SECURITY;
-- No policies: service role only.

-- ---- enqueue on resolve / cancel on reopen ------------------------------
CREATE OR REPLACE FUNCTION public.conversations_csat_enqueue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
BEGIN
  BEGIN
    IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
      -- Archiving an open conversation is not a resolution (see 071).
      IF NEW.resolved_at IS NULL OR NEW.archived_at IS NOT NULL THEN RETURN NULL; END IF;
      SELECT enabled, delay_minutes INTO s FROM public.csat_settings WHERE account_id = NEW.account_id;
      IF FOUND AND s.enabled THEN
        INSERT INTO public.csat_jobs (account_id, conversation_id, service_count, run_at)
        VALUES (NEW.account_id, NEW.id, COALESCE(NEW.service_count, 1), NOW() + make_interval(mins => s.delay_minutes))
        ON CONFLICT (conversation_id, service_count) DO NOTHING;
      END IF;
    ELSIF OLD.status = 'closed' AND NEW.status IS DISTINCT FROM 'closed' THEN
      UPDATE public.csat_jobs SET processed_at = NOW(), result = 'reopened'
       WHERE conversation_id = NEW.id AND processed_at IS NULL;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- The survey is optional: it must never block resolving a conversation.
    RAISE WARNING 'conversations_csat_enqueue: conversation % skipped: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS conversations_csat_enqueue ON public.conversations;
CREATE TRIGGER conversations_csat_enqueue
  AFTER UPDATE OF status ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.conversations_csat_enqueue();

-- ---- cron + inbound helpers (service role) -------------------------------
DROP FUNCTION IF EXISTS public.csat_claim_jobs(timestamptz, integer);
CREATE OR REPLACE FUNCTION public.csat_claim_jobs(p_now timestamptz DEFAULT clock_timestamp(), p_limit integer DEFAULT 50)
RETURNS SETOF public.csat_jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.csat_jobs j
     SET claimed_at = p_now, attempts = j.attempts + 1
   WHERE j.id IN (
     SELECT id FROM public.csat_jobs
      WHERE processed_at IS NULL AND run_at <= p_now AND attempts < 3
        AND (claimed_at IS NULL OR claimed_at < p_now - INTERVAL '5 minutes')
      ORDER BY run_at
      LIMIT GREATEST(1, LEAST(p_limit, 200))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING j.*;
$$;

-- Surveys unanswered after 48 h expire; jobs that kept failing are closed;
-- old finished jobs are dropped. Returns how many surveys expired.
DROP FUNCTION IF EXISTS public.csat_expire(timestamptz);
CREATE OR REPLACE FUNCTION public.csat_expire(p_now timestamptz DEFAULT clock_timestamp())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expired integer;
BEGIN
  UPDATE public.csat_responses SET status = 'expired'
   WHERE status = 'sent' AND sent_at < p_now - INTERVAL '48 hours';
  GET DIAGNOSTICS v_expired = ROW_COUNT;
  UPDATE public.csat_jobs SET processed_at = p_now, result = 'failed'
   WHERE processed_at IS NULL AND attempts >= 3 AND (claimed_at IS NULL OR claimed_at < p_now - INTERVAL '5 minutes');
  DELETE FROM public.csat_jobs WHERE processed_at IS NOT NULL AND processed_at < p_now - INTERVAL '30 days';
  RETURN v_expired;
END;
$$;

-- The score: sent -> answered in ONE statement (a second delivery of the
-- same reply finds nothing to update). The event and the automation
-- trigger are best effort: they never undo the score.
DROP FUNCTION IF EXISTS public.csat_record_answer(uuid, integer, boolean, timestamptz);
CREATE OR REPLACE FUNCTION public.csat_record_answer(
  p_response_id uuid,
  p_score       integer,
  p_ask_comment boolean,
  p_now         timestamptz DEFAULT clock_timestamp()
) RETURNS SETOF public.csat_responses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.csat_responses;
BEGIN
  IF p_score IS NULL OR p_score < 1 OR p_score > 5 THEN RETURN; END IF;
  UPDATE public.csat_responses r
     SET status = 'answered', score = p_score, answered_at = p_now,
         comment_requested_at = CASE WHEN p_ask_comment THEN p_now END
   WHERE r.id = p_response_id AND r.status = 'sent' AND r.sent_at > p_now - INTERVAL '48 hours'
  RETURNING r.* INTO v;
  IF NOT FOUND THEN RETURN; END IF;
  BEGIN
    INSERT INTO public.conversation_events (account_id, conversation_id, actor_user_id, event_type, payload)
    VALUES (v.account_id, v.conversation_id, NULL, 'csat_answered', jsonb_build_object('score', p_score));
    PERFORM public.automation_enqueue_event(
      v.account_id, 'csat_received', v.contact_id, v.conversation_id,
      jsonb_build_object('score', p_score, 'team_id', v.team_id, 'category_id', v.category_id));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'csat_record_answer: side effects of % skipped: %', v.id, SQLERRM;
  END;
  RETURN NEXT v;
END;
$$;

-- The optional comment, once, within 24 h of being asked. NULL / blank =
-- the customer declined; either way the question is closed.
DROP FUNCTION IF EXISTS public.csat_record_comment(uuid, text, timestamptz);
CREATE OR REPLACE FUNCTION public.csat_record_comment(
  p_response_id uuid,
  p_comment     text,
  p_now         timestamptz DEFAULT clock_timestamp()
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH u AS (
    UPDATE public.csat_responses r
       SET comment = left(NULLIF(btrim(p_comment), ''), 500), comment_received_at = p_now
     WHERE r.id = p_response_id AND r.status = 'answered'
       AND r.comment_requested_at IS NOT NULL AND r.comment_received_at IS NULL
       AND r.comment_requested_at > p_now - INTERVAL '24 hours'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- ---- CHECK lists --------------------------------------------------------
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_origin_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_origin_check
  CHECK (origin IS NULL OR origin IN ('phone', 'automation', 'flow', 'system', 'ai', 'csat')) NOT VALID;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_origin_check;

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
      'csat_answered'
    )
  ) NOT VALID;
ALTER TABLE public.conversation_events VALIDATE CONSTRAINT conversation_events_event_type_check;

-- ---- grants -------------------------------------------------------------
REVOKE ALL ON FUNCTION public.conversations_csat_enqueue() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.csat_claim_jobs(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.csat_claim_jobs(timestamptz, integer) TO service_role;
REVOKE ALL ON FUNCTION public.csat_expire(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.csat_expire(timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.csat_record_answer(uuid, integer, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.csat_record_answer(uuid, integer, boolean, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.csat_record_comment(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.csat_record_comment(uuid, text, timestamptz) TO service_role;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.conversations_csat_enqueue()',
    'public.csat_claim_jobs(timestamptz, integer)',
    'public.csat_expire(timestamptz)',
    'public.csat_record_answer(uuid, integer, boolean, timestamptz)',
    'public.csat_record_comment(uuid, text, timestamptz)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'unexpected EXECUTE privileges on %', f;
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
