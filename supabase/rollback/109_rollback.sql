-- Rollback of 109_lead_origins.sql. NOT a migration: run by hand (as postgres).
-- Roll the APP back first (inbox panel, deal drawer, contacts and Reports read these columns).
-- Deletes every recorded touch and the origin of every deal (data loss).
BEGIN;
DROP TRIGGER IF EXISTS deals_origin_guard ON public.deals;
DROP TRIGGER IF EXISTS contacts_origin_guard ON public.contacts;
DROP FUNCTION IF EXISTS public.origin_report(timestamptz, timestamptz, text, uuid);
DROP FUNCTION IF EXISTS public.deals_origin_guard();
DROP FUNCTION IF EXISTS public.contacts_origin_guard();
ALTER TABLE public.deals DROP COLUMN IF EXISTS origin_set_at;
ALTER TABLE public.deals DROP COLUMN IF EXISTS origin_set_by;
ALTER TABLE public.deals DROP COLUMN IF EXISTS origin_id;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS last_origin_id;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS first_origin_id;
DROP TABLE IF EXISTS public.lead_origins;  -- takes its policies, triggers and indexes along
DROP FUNCTION IF EXISTS public.lead_origins_guard();
DROP FUNCTION IF EXISTS private.is_user_session();
NOTIFY pgrst, 'reload schema';
COMMIT;
