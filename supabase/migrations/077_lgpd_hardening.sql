-- ============================================================
-- 077_lgpd_hardening.sql — LGPD: resumable anonymisation, opt-out
-- suppression list, server-only contact delete, retention indexes.
--
-- 1. contacts.anonymization_completed_at — the anonymisation now marks
--    the contact FIRST (anonymized_at + placeholder name / phone, so no
--    in-flight writer re-populates it) and scrubs afterwards in pages.
--    This column is set only when every scrub step succeeded; a contact
--    with anonymized_at but no anonymization_completed_at can be re-run
--    by an admin (POST /api/contacts/[id]/anonymize). Contacts
--    anonymised before this migration stay NULL on purpose: re-running
--    them applies the scrub of the tables added since (deals, tasks,
--    calendar, flows, logs…).
-- 2. contact_suppressions — per-account list of opted-out numbers that
--    were anonymised, stored ONLY as an HMAC (app secret, never the
--    phone). Checked when a contact is created (inbound / CSV import)
--    and when a broadcast audience is built, so a returning opted-out
--    number comes back opted out. Service role only: RLS on, no
--    policies, and no grants to anon / authenticated.
-- 3. contacts DELETE policy dropped: deleting a contact goes through
--    DELETE /api/contacts (admin+, service role), which removes the
--    chat-media files and scrubs the ON DELETE SET NULL tables first.
--    A member session can no longer delete a contact straight through
--    PostgREST (that path left public media files behind).
-- 4. Indexes for the scrub (contact_id lookups that also back the
--    ON DELETE SET NULL of those FKs) and for the retention purge of
--    the automations cron.
--
-- Idempotent. No data is deleted or rewritten here.
-- NOTE (large tables): plain CREATE INDEX blocks writes while it builds;
-- on a very large automation_logs / flow_runs create those by hand with
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS … first.
-- ============================================================

-- 1. Resumable anonymisation -----------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS anonymization_completed_at timestamptz;

-- 2. Suppression list --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.contact_suppressions (
  account_id  uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- hex HMAC-SHA256 of "<account_id>:<phone digits>" (lib/lgpd/suppression.ts)
  phone_hash  text        NOT NULL CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, phone_hash)
);

ALTER TABLE public.contact_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_suppressions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.contact_suppressions TO service_role;

-- 3. Contact delete is server-side only --------------------------------
DROP POLICY IF EXISTS contacts_delete ON public.contacts;

-- 4. Indexes -----------------------------------------------------------
-- Scrub / FK SET NULL lookups by contact.
CREATE INDEX IF NOT EXISTS idx_flow_runs_contact
  ON public.flow_runs (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_source_events_contact
  ON public.lead_source_events (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_logs_contact
  ON public.automation_logs (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_pending_contact
  ON public.automation_pending_executions (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_csat_responses_contact
  ON public.csat_responses (contact_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON public.audit_log (account_id, entity_type, entity_id);

-- Retention purge (api/automations/cron).
CREATE INDEX IF NOT EXISTS idx_flow_runs_ended
  ON public.flow_runs (ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_reply_jobs_finished
  ON public.ai_reply_jobs (updated_at) WHERE status IN ('done', 'skipped', 'failed');
CREATE INDEX IF NOT EXISTS idx_csat_jobs_processed
  ON public.csat_jobs (processed_at) WHERE processed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_handoffs_words_created
  ON public.ai_handoffs (created_at) WHERE last_customer_words IS NOT NULL;

-- 5. Hard delete in one transaction -------------------------------------
-- Called by DELETE /api/contacts (service role) AFTER the contact's media
-- objects were removed from Storage. Detaches deals from the
-- conversations about to cascade (deals.conversation_id has no ON DELETE
-- action and would block the delete), scrubs the personal text of every
-- ON DELETE SET NULL table, then deletes the contact. All or nothing: a
-- failure rolls the scrub back, so a contact is never left wiped but
-- present. Returns false when the contact is not in the account.
-- SECURITY INVOKER + EXECUTE for service_role only (default grants are
-- closed by 076).
CREATE OR REPLACE FUNCTION public.lgpd_delete_contact(p_account_id uuid, p_contact_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_conversations uuid[];
  v_tasks uuid[];
  v_runs uuid[];
BEGIN
  PERFORM 1 FROM public.contacts WHERE id = p_contact_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT coalesce(array_agg(id), '{}') INTO v_conversations
    FROM public.conversations WHERE contact_id = p_contact_id AND account_id = p_account_id;

  UPDATE public.deals SET conversation_id = NULL
   WHERE account_id = p_account_id AND conversation_id = ANY (v_conversations);
  UPDATE public.deals SET title = 'Negócio anonimizado', notes = NULL, lost_note = NULL
   WHERE account_id = p_account_id AND contact_id = p_contact_id;

  SELECT coalesce(array_agg(id), '{}') INTO v_tasks
    FROM public.tasks
   WHERE account_id = p_account_id
     AND (contact_id = p_contact_id OR conversation_id = ANY (v_conversations));
  UPDATE public.tasks SET title = 'Tarefa anonimizada', description = NULL WHERE id = ANY (v_tasks);
  UPDATE public.task_comments SET body = '[conteúdo removido]' WHERE task_id = ANY (v_tasks);

  UPDATE public.calendar_events
     SET title = 'Compromisso anonimizado', description = NULL, location = NULL
   WHERE account_id = p_account_id
     AND (contact_id = p_contact_id OR conversation_id = ANY (v_conversations));

  SELECT coalesce(array_agg(id), '{}') INTO v_runs
    FROM public.flow_runs WHERE account_id = p_account_id AND contact_id = p_contact_id;
  UPDATE public.flow_runs SET vars = '{}'::jsonb WHERE id = ANY (v_runs);
  UPDATE public.flow_run_events SET payload = '{}'::jsonb WHERE flow_run_id = ANY (v_runs);

  UPDATE public.lead_source_events SET payload = '{}'::jsonb
   WHERE account_id = p_account_id AND contact_id = p_contact_id;
  UPDATE public.broadcast_recipients SET template_params = NULL WHERE contact_id = p_contact_id;
  UPDATE public.automation_pending_executions
     SET context = '{}'::jsonb,
         status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END
   WHERE account_id = p_account_id AND contact_id = p_contact_id;
  UPDATE public.automation_logs SET error_message = NULL
   WHERE account_id = p_account_id AND contact_id = p_contact_id AND error_message IS NOT NULL;

  UPDATE public.audit_log SET metadata = metadata - 'contact_name' - 'phone' - 'email' - 'name'
   WHERE account_id = p_account_id
     AND ((entity_type = 'contact' AND entity_id = p_contact_id::text)
          OR metadata->>'contact_id' = p_contact_id::text)
     AND metadata ?| ARRAY['contact_name', 'phone', 'email', 'name'];

  DELETE FROM public.contacts WHERE id = p_contact_id AND account_id = p_account_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.lgpd_delete_contact(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lgpd_delete_contact(uuid, uuid) TO service_role;
