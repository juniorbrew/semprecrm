-- Rollback of 110_meta_capi.sql. NOT a migration: run by hand (as postgres).
-- Roll the APP back first (settings card, cron endpoint). Deletes the outbox and the Meta settings (token included).
BEGIN;
DROP TRIGGER IF EXISTS meta_capi_enqueue ON public.deals;
DROP FUNCTION IF EXISTS public.meta_capi_enqueue();
DROP TRIGGER IF EXISTS deals_account_guard ON public.deals;
DROP FUNCTION IF EXISTS public.deals_account_guard();
DROP FUNCTION IF EXISTS public.meta_capi_claim(integer, integer);
DROP FUNCTION IF EXISTS public.meta_capi_purge(integer, integer);
DROP TABLE IF EXISTS public.meta_capi_events;
DROP TABLE IF EXISTS public.meta_capi_settings;
NOTIFY pgrst, 'reload schema';
COMMIT;
