-- ============================================================
-- 055_contact_avatars.sql — WhatsApp profile photos for contacts.
--
-- What this migration does
--   1. `contacts.avatar_checked_at` — when the app last asked the QR
--      gateway for the contact's profile photo (successful or not).
--      The app refreshes a contact when it is NULL or older than
--      ~7 days; the column doubles as an atomic claim so a burst of
--      inbound messages triggers one lookup (src/lib/whatsapp/
--      contact-avatar.ts). `contacts.avatar_url` already exists.
--   2. `contact-avatars` Storage bucket — public reads (the inbox
--      renders plain <img> tags), 1 MB, jpeg/png/webp. WhatsApp CDN
--      URLs expire, so the gateway downloads the photo and stores a
--      copy at `account-<account_id>/<contact_id>` with the service
--      role. No INSERT/UPDATE/DELETE policy for signed-in users: only
--      the service role (which bypasses RLS) writes here.
--
-- The Meta Cloud API does not expose profile photos; only the QR
-- channel fills avatars. Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. contacts.avatar_checked_at
-- ============================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar_checked_at TIMESTAMPTZ;

-- ============================================================
-- 2. contact-avatars bucket (public read, service-role writes)
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'contact-avatars',
  'contact-avatars',
  TRUE,
  1048576, -- 1 MB (WhatsApp profile photos are ~640x640 JPEGs)
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Contact avatars are publicly readable" ON storage.objects;
CREATE POLICY "Contact avatars are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'contact-avatars');
