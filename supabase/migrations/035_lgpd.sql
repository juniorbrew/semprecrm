-- ============================================================
-- 035_lgpd.sql — LGPD: consent status, data export and
-- anonymisation markers on contacts.
--
-- Spec: docs/superpowers/specs/2026-09-13-deskcomm-parity-round2-design.md
--       section "4. LGPD"
--
-- What this migration does
--   1. `contacts.consent_status` — 'unknown' (default) | 'granted' |
--      'revoked', edited from the contact panel; `consent_updated_at`
--      stamps the last change.
--   2. `contacts.anonymized_at` — set by POST /api/contacts/[id]/anonymize
--      (src/lib/lgpd/anonymize.ts). An anonymised contact keeps its
--      row (conversations, deals and tasks stay linked for statistics)
--      but name / phone / email / company / avatar, custom values,
--      message bodies, media and notes are gone. The UI shows a badge
--      and blocks editing / sending.
--   3. Trigger keeps `consent_updated_at` in sync when the status
--      changes (so a plain UPDATE from the client is enough).
--
-- The export route (GET /api/contacts/[id]/export) needs no schema.
-- Does NOT touch `handle_new_user`.
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS consent_updated_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_consent_status_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_consent_status_check
  CHECK (consent_status IN ('unknown', 'granted', 'revoked'));

-- Anonymised contacts are listed separately in a few places; a
-- partial index keeps that cheap without bloating the main table.
CREATE INDEX IF NOT EXISTS idx_contacts_anonymized
  ON contacts(account_id) WHERE anonymized_at IS NOT NULL;

-- ============================================================
-- consent_updated_at — stamped on every status change.
-- ============================================================
CREATE OR REPLACE FUNCTION public.contacts_stamp_consent_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.consent_status IS DISTINCT FROM OLD.consent_status THEN
    NEW.consent_updated_at := NOW();
  ELSIF TG_OP = 'INSERT' AND NEW.consent_status <> 'unknown' AND NEW.consent_updated_at IS NULL THEN
    NEW.consent_updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contacts_stamp_consent_updated_at ON contacts;
CREATE TRIGGER contacts_stamp_consent_updated_at
  BEFORE INSERT OR UPDATE OF consent_status ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_stamp_consent_updated_at();
