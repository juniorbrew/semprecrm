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
--   2. `contact-avatars` Storage bucket — `public = true`, so the
--      inbox renders plain <img> tags from
--      /storage/v1/object/public/contact-avatars/<path> (public-bucket
--      downloads do not go through storage.objects RLS). 1 MB,
--      jpeg/png/webp. WhatsApp CDN URLs expire, so the gateway
--      downloads the photo and stores a copy at
--      `account-<account_id>/<contact_id>` with the service role.
--      NO policy on storage.objects for this bucket at all: signed-in
--      users and anon can neither write nor LIST objects (a SELECT
--      policy would let anyone enumerate account / contact ids); only
--      the service role (which bypasses RLS) writes and deletes.
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

-- An earlier draft of this migration created a public SELECT policy;
-- make sure it is gone (listing must stay closed).
DROP POLICY IF EXISTS "Contact avatars are publicly readable" ON storage.objects;
