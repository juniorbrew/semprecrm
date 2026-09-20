-- ============================================================
-- 046_contact_phone.sql — Phone number on /contato submissions.
--
-- The marketing form now asks for a phone (this is a WhatsApp CRM;
-- the sales follow-up happens there). Stored as digits only
-- (DDD + number, 10–11), formatted for display by the app.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contact_submissions ADD COLUMN IF NOT EXISTS phone TEXT;

COMMENT ON COLUMN contact_submissions.phone IS 'Digits only (DDD + number), as normalised by src/lib/br/lookup.ts.';
