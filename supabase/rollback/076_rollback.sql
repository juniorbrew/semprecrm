-- ============================================================
-- Forward rollback of migration 076_security_hardening.sql.
-- NOT a migration: run by hand (as postgres) only if 076 breaks
-- production and the app cannot be fixed forward quickly. It restores the
-- pre-076 behaviour — i.e. it REOPENS the audited holes. Prefer reverting
-- one section at a time.
--
-- Deliberately not reverted (no legitimate flow needs them):
--   * calendar_connections_public stays read-only (writes were the hole).
--   * account-branding keeps SVG out of allowed_mime_types.
-- Chat-media write policies are owned by 078 (076 never touched them).
-- ============================================================
BEGIN;
SET lock_timeout = '5s';

-- 1. accounts
DROP TRIGGER IF EXISTS enforce_account_platform_columns ON public.accounts;
DROP FUNCTION IF EXISTS public.enforce_account_platform_columns();
GRANT SELECT ON public.accounts TO anon, authenticated;

-- 2. storage: public SELECT policies back, scoped ones out, flow-media writes as before
DROP POLICY IF EXISTS "Members read own chat media" ON storage.objects;
DROP POLICY IF EXISTS "Members read own flow media" ON storage.objects;
DROP POLICY IF EXISTS "Users read own avatar" ON storage.objects;
DROP POLICY IF EXISTS "Admins read own account branding" ON storage.objects;
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
CREATE POLICY "Chat media is publicly readable" ON storage.objects FOR SELECT USING (bucket_id = 'chat-media');
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
CREATE POLICY "Flow media is publicly readable" ON storage.objects FOR SELECT USING (bucket_id = 'flow-media');
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;
CREATE POLICY "Avatars are publicly readable" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
DROP POLICY IF EXISTS "Account branding is publicly readable" ON storage.objects;
CREATE POLICY "Account branding is publicly readable" ON storage.objects FOR SELECT USING (bucket_id = 'account-branding');

DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'flow-media' AND (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
             AND ('account-' || p.account_id::text) = (storage.foldername(objects.name))[1])
    OR (auth.uid())::text = (storage.foldername(name))[1]));
DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media" ON storage.objects FOR UPDATE
  USING (bucket_id = 'flow-media' AND (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
             AND ('account-' || p.account_id::text) = (storage.foldername(objects.name))[1])
    OR (auth.uid())::text = (storage.foldername(name))[1]));
DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media" ON storage.objects FOR DELETE
  USING (bucket_id = 'flow-media' AND (
    EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid()
             AND ('account-' || p.account_id::text) = (storage.foldername(objects.name))[1])
    OR (auth.uid())::text = (storage.foldername(name))[1]));

-- 3. function and table privileges
GRANT EXECUTE ON FUNCTION public._bcast_bump(uuid, text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_insert_system_message(uuid, uuid, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_contacts() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_task_statuses(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_deal_loss_reasons(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_member_role(uuid, account_role_enum) TO anon;
GRANT EXECUTE ON FUNCTION public.remove_account_member(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(text) TO anon;
GRANT EXECUTE ON FUNCTION public.platform_list_accounts() TO anon;
GRANT EXECUTE ON FUNCTION public.platform_update_account(uuid, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.chat_get_or_create_direct_thread(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.chat_can_manage_group(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.chat_create_group(text, uuid[]) TO anon;
GRANT EXECUTE ON FUNCTION public.chat_add_members(uuid, uuid[]) TO anon;
GRANT EXECUTE ON FUNCTION public.chat_remove_member(uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.chat_leave_group(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.chat_mark_delivered(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.chat_mark_read(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.chat_unread_counts() TO anon;
-- Trigger functions: EXECUTE is never checked when a trigger fires, so the
-- 076 revoke on them is harmless and is not undone here.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
GRANT TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT TRUNCATE, TRIGGER, REFERENCES ON TABLES TO anon, authenticated;

-- 5. lead_sources
DROP VIEW IF EXISTS public.lead_sources_public;  -- app falls back to the table
DROP POLICY IF EXISTS lead_sources_select ON public.lead_sources;
CREATE POLICY lead_sources_select ON public.lead_sources
  FOR SELECT USING (is_account_member(account_id));

-- 6. profiles
DROP POLICY IF EXISTS profiles_insert ON public.profiles;
CREATE POLICY profiles_insert ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- 7. cross-tenant guard
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tgname, tgrelid::regclass AS tbl FROM pg_trigger
     WHERE tgfoid = 'public.enforce_same_account()'::regprocedure AND NOT tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', r.tgname, r.tbl);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.enforce_same_account();

-- 8. contacts LGPD markers
DROP TRIGGER IF EXISTS enforce_contact_lgpd_markers ON public.contacts;
DROP FUNCTION IF EXISTS public.enforce_contact_lgpd_markers();

-- 9. whatsapp_config
GRANT SELECT ON public.whatsapp_config TO anon, authenticated;

-- 10. ai_contact_memories
DROP TRIGGER IF EXISTS ai_contact_memories_guard ON public.ai_contact_memories;
DROP FUNCTION IF EXISTS public.ai_contact_memories_guard();
DROP FUNCTION IF EXISTS public.ai_fact_has_document_number(text);

NOTIFY pgrst, 'reload schema';
COMMIT;
