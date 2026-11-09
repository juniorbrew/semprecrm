-- Rollback of 108_site_bot.sql. Site bots are DELETED (their rows only
-- make sense with the new columns); webhook sources are untouched.
BEGIN;
DELETE FROM public.lead_sources WHERE kind = 'site_bot';
ALTER TABLE public.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_bot_config_check;
ALTER TABLE public.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_kind_key_check;
ALTER TABLE public.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_public_key_format_check;
ALTER TABLE public.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_public_key_key;
ALTER TABLE public.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_kind_check;
ALTER TABLE public.lead_sources DROP COLUMN IF EXISTS bot_config;
ALTER TABLE public.lead_sources DROP COLUMN IF EXISTS public_key;
ALTER TABLE public.lead_sources DROP COLUMN IF EXISTS kind;
COMMIT;
