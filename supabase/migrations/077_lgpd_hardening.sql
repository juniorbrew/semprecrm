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
