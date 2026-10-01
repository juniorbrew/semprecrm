-- ============================================================
-- 078_whatsapp_hardening.sql
--
-- chat-media storage writes (migration 023) only required the path's
-- first segment to be the caller's `account-<id>` — any member, viewers
-- included, could upload, overwrite or delete there, including the
-- `account-<id>/qr/` prefix where the WhatsApp gateway (service role)
-- stores inbound QR media. A viewer could replace a customer's photo.
--
-- Now:
--   - INSERT / UPDATE / DELETE need `is_account_member(<account>, 'agent')`
--     for the account named by the first path segment;
--   - nothing under `account-<id>/qr/` is writable by `authenticated`
--     (the service role bypasses RLS, so the gateway is unaffected);
--   - UPDATE also has a WITH CHECK, so an object cannot be moved into
--     another account's folder or into qr/.
-- Reads stay public (Meta fetches the links).
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE.
-- ============================================================

-- `account-<uuid>` → uuid; NULL for anything else (never a cast error).
CREATE OR REPLACE FUNCTION public.chat_media_account_id(object_name text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (storage.foldername(object_name))[1]
         ~ '^account-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    THEN substr((storage.foldername(object_name))[1], 9)::uuid
  END
$$;

-- True when an authenticated caller may write this chat-media object.
CREATE OR REPLACE FUNCTION public.chat_media_writable(object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE((storage.foldername(object_name))[2], '') <> 'qr'
     AND COALESCE(public.is_account_member(public.chat_media_account_id(object_name), 'agent'), false)
$$;

DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
CREATE POLICY "Members can upload chat media"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'chat-media' AND public.chat_media_writable(name));

DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
CREATE POLICY "Members can update chat media"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'chat-media' AND public.chat_media_writable(name))
  WITH CHECK (bucket_id = 'chat-media' AND public.chat_media_writable(name));

DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
CREATE POLICY "Members can delete chat media"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'chat-media' AND public.chat_media_writable(name));
