-- ============================================================
-- 092 — "Agendar mensagem": a text reply the agent queues to go out later.
--
--   1. scheduled_messages: one row per queued message. `scheduled_for` is a
--      timestamptz (absolute instant); `timezone` is only the IANA zone of
--      the agent who scheduled it, kept to show "agendado em America/…".
--      States: pending -> sending -> sent | failed; cancelling deletes the
--      row (the API hands the text back to the composer).
--   2. Cap: at most 100 open (pending/sending/failed) rows per account,
--      enforced by a BEFORE INSERT trigger under an advisory lock so
--      concurrent inserts cannot overshoot.
--   3. scheduled_messages_claim(): the cron's atomic claim. FOR UPDATE SKIP
--      LOCKED + pending->sending in ONE statement, so overlapping ticks (or
--      "enviar agora" racing the cron) can never take the same row. Rows
--      stuck in `sending` for 10 min (crashed worker) are parked as `failed`,
--      NOT re-sent: the send may have happened, a human decides.
--   4. RLS: members read; writes go only through the API (service role),
--      which validates role, horizon and the conversation.
--
-- Additive; the previous app build ignores the table. Idempotent.
-- Rollback: supabase/rollback/092_rollback.sql.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.scheduled_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL,                      -- auth user; no FK, like assigned_agent_id
  content_text    text NOT NULL,
  scheduled_for   timestamptz NOT NULL,
  timezone        text,
  status          text NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  claimed_at      timestamptz,
  sent_at         timestamptz,
  wa_message_id   text,
  error_code      text,
  error_text      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_status_check;
ALTER TABLE public.scheduled_messages ADD CONSTRAINT scheduled_messages_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed'));
ALTER TABLE public.scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_text_check;
ALTER TABLE public.scheduled_messages ADD CONSTRAINT scheduled_messages_text_check
  CHECK (char_length(btrim(content_text)) BETWEEN 1 AND 4096);
ALTER TABLE public.scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_error_check;
ALTER TABLE public.scheduled_messages ADD CONSTRAINT scheduled_messages_error_check
  CHECK (error_text IS NULL OR char_length(error_text) <= 500);

-- cron scan (cross-account) and the per-conversation panel
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON public.scheduled_messages (scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_conversation
  ON public.scheduled_messages (conversation_id, scheduled_for) WHERE status <> 'sent';
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_account_open
  ON public.scheduled_messages (account_id) WHERE status <> 'sent';

-- ---- 2. cap ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.scheduled_messages_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('scheduled_messages:' || NEW.account_id::text, 0));
  IF (SELECT count(*) FROM public.scheduled_messages
       WHERE account_id = NEW.account_id AND status <> 'sent') >= 100 THEN
    RAISE EXCEPTION 'scheduled_messages_cap' USING ERRCODE = '54000';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.scheduled_messages_cap() OWNER TO postgres;

DROP TRIGGER IF EXISTS scheduled_messages_cap ON public.scheduled_messages;
CREATE TRIGGER scheduled_messages_cap
  BEFORE INSERT ON public.scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION public.scheduled_messages_cap();

-- ---- 3. atomic claim -------------------------------------------------------
-- p_id set = "enviar agora" for that one row (only if still pending/failed,
-- ignoring its time); otherwise every pending row due at p_now.
CREATE OR REPLACE FUNCTION public.scheduled_messages_claim(
  p_now   timestamptz DEFAULT clock_timestamp(),
  p_limit integer     DEFAULT 25,
  p_id    uuid        DEFAULT NULL
) RETURNS SETOF public.scheduled_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- crashed worker: never re-send, park for a human
  UPDATE public.scheduled_messages
     SET status = 'failed', error_code = 'interrupted',
         error_text = 'O envio foi interrompido. Confira a conversa antes de reenviar.',
         updated_at = clock_timestamp()
   WHERE status = 'sending' AND claimed_at < p_now - interval '10 minutes';

  RETURN QUERY
  WITH due AS (
    SELECT s.id FROM public.scheduled_messages s
     WHERE CASE WHEN p_id IS NULL
                THEN s.status = 'pending' AND s.scheduled_for <= p_now
                ELSE s.id = p_id AND s.status IN ('pending', 'failed') END
     ORDER BY s.scheduled_for
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 200))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.scheduled_messages m
     SET status = 'sending', claimed_at = p_now, attempts = m.attempts + 1,
         error_code = NULL, error_text = NULL, updated_at = clock_timestamp()
    FROM due
   WHERE m.id = due.id
  RETURNING m.*;
END;
$$;
ALTER FUNCTION public.scheduled_messages_claim(timestamptz, integer, uuid) OWNER TO postgres;
-- 076: new functions are closed by default; only the cron / API (service role) call it.
REVOKE EXECUTE ON FUNCTION public.scheduled_messages_claim(timestamptz, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_messages_claim(timestamptz, integer, uuid) TO service_role;

-- ---- 4. RLS ----------------------------------------------------------------
ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduled_messages_select ON public.scheduled_messages;
CREATE POLICY scheduled_messages_select ON public.scheduled_messages FOR SELECT
  USING (is_account_member(account_id));

REVOKE ALL ON TABLE public.scheduled_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.scheduled_messages TO authenticated;
GRANT ALL ON TABLE public.scheduled_messages TO service_role;
