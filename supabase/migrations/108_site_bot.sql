-- ============================================================
-- 108_site_bot.sql — Website chat bot (feature 4.7): a lead source
-- whose "endpoint" is an embeddable script (public/robo.js) instead
-- of a webhook URL.
--
-- Spec: docs/superpowers/specs/2026-11-09-robo-no-site.md
--
-- What this migration does
--   1. lead_sources.kind: 'webhook' (default — every existing row) or
--      'site_bot'.
--   2. lead_sources.public_key: the bot's public id (32 hex chars,
--      minted by the app server, unique). NULL for webhooks, required
--      for bots. It appears in the customer's HTML, so it only reads
--      the bot's public config and posts answers for that bot — the
--      secret `token` column keeps existing but is unused by bots.
--   3. lead_sources.bot_config: JSONB (appearance, greeting, questions,
--      end screen, LGPD text, allowed domains). Object, <= 16 KB.
--
-- RLS is untouched: 029/076 (admin+ reads and writes) and the 094
-- read-only RESTRICTIVE policies already cover the table, new columns
-- included. The public routes read through the service role.
--
-- Does NOT touch `handle_new_user`.
-- Idempotent — safe to run multiple times.
-- ============================================================

BEGIN;

ALTER TABLE public.lead_sources ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'webhook';
ALTER TABLE public.lead_sources ADD COLUMN IF NOT EXISTS public_key TEXT;
ALTER TABLE public.lead_sources ADD COLUMN IF NOT EXISTS bot_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_kind_check;
ALTER TABLE public.lead_sources ADD CONSTRAINT lead_sources_kind_check
  CHECK (kind IN ('webhook', 'site_bot'));

ALTER TABLE public.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_public_key_key;
ALTER TABLE public.lead_sources ADD CONSTRAINT lead_sources_public_key_key UNIQUE (public_key);

ALTER TABLE public.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_public_key_format_check;
ALTER TABLE public.lead_sources ADD CONSTRAINT lead_sources_public_key_format_check
  CHECK (public_key IS NULL OR public_key ~ '^[0-9a-f]{32}$');

-- Bots must carry a key; webhooks must not.
ALTER TABLE public.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_kind_key_check;
ALTER TABLE public.lead_sources ADD CONSTRAINT lead_sources_kind_key_check
  CHECK ((kind = 'site_bot') = (public_key IS NOT NULL));

ALTER TABLE public.lead_sources DROP CONSTRAINT IF EXISTS lead_sources_bot_config_check;
ALTER TABLE public.lead_sources ADD CONSTRAINT lead_sources_bot_config_check
  CHECK (jsonb_typeof(bot_config) = 'object' AND pg_column_size(bot_config) <= 16384);

NOTIFY pgrst, 'reload schema';
COMMIT;
