-- ============================================================
-- 061_contacts_realtime.sql — contact photo shows up live in the inbox.
--
-- contacts joins the supabase_realtime publication so the inbox can
-- patch a contact (contacts.avatar_url, filled by the QR gateway
-- seconds after a message) without a reload. The inbox subscribes to
-- UPDATEs filtered by account_id; RLS (017) still decides who receives
-- each row. Idempotent.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'contacts'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.contacts;
  END IF;
END;
$$;
