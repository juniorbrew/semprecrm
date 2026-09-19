-- ============================================================
-- 044_marketing_contact.sql — Contact form submissions from the
-- public marketing site (/contato).
--
-- What this migration does
--   1. Creates `contact_submissions` — one row per form
--      submission (name, email, company, message, source). Not
--      tenant-scoped: this table has no `account_id`, it exists
--      outside any customer account, fed only by the
--      unauthenticated POST /api/marketing/contact route.
--   2. RLS: enabled with NO policies — anon and authenticated
--      roles get zero access (select/insert/update/delete all
--      denied). The API route writes exclusively through the
--      service-role client, which bypasses RLS entirely — same
--      model as `lead_source_events` (029): nobody writes
--      through RLS, the route uses the service role.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_submissions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  company     TEXT,
  message     TEXT NOT NULL,
  source      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE contact_submissions DROP CONSTRAINT IF EXISTS contact_submissions_name_check;
ALTER TABLE contact_submissions ADD CONSTRAINT contact_submissions_name_check
  CHECK (length(btrim(name)) > 0);

ALTER TABLE contact_submissions DROP CONSTRAINT IF EXISTS contact_submissions_message_check;
ALTER TABLE contact_submissions ADD CONSTRAINT contact_submissions_message_check
  CHECK (length(btrim(message)) > 0);

CREATE INDEX IF NOT EXISTS idx_contact_submissions_created ON contact_submissions(created_at DESC);

ALTER TABLE contact_submissions ENABLE ROW LEVEL SECURITY;
-- No policies: RLS enabled with zero grants blocks anon and
-- authenticated entirely. Only the service-role client (used by
-- POST /api/marketing/contact) can read or write this table.

COMMENT ON TABLE contact_submissions IS 'Public /contato form submissions. No RLS policies — service role only.';
