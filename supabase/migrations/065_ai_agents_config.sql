-- ============================================================
-- 065_ai_agents_config.sql — AI agents get their own page (/ai/agents)
-- and the settings the upcoming automatic-reply runtime reads. Module `ai`.
--
-- New `ai_agents` columns (all with defaults, so rows from 064 stay valid):
--   description              short text shown on the agent card
--   mode                     'suggest' (an agent reviews) | 'auto' (answers alone)
--   paused_at                auto replies paused since (NULL = running)
--   business_hours           { enabled, timezone, start "HH:MM", end "HH:MM",
--                              days [0..6, 0 = Sunday] } — auto mode only
--                              answers inside it when enabled
--   ignore_groups            never auto-reply in WhatsApp groups
--   split_messages           send the reply as several short messages
--   max_chars_per_message    80..1000 per message
--   handoff_enabled          the agent may hand the conversation to a person
--   handoff_keywords         customer words that hand over at once
--   handoff_message          what the customer is told on hand-over
--   max_messages_per_turn    1..5 messages per automatic reply
--   max_auto_replies_per_day 1..200 automatic replies per conversation per day
--
-- RLS and grants are unchanged (064: agent+ read, admin+ write).
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Shape of `business_hours`. IMMUTABLE so it can back a CHECK.
CREATE OR REPLACE FUNCTION public.ai_agents_business_hours_valid(bh JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  -- COALESCE: a missing key makes the chain NULL, which a CHECK would accept.
  SELECT COALESCE(
     jsonb_typeof(bh) = 'object'
     AND jsonb_typeof(bh -> 'enabled') = 'boolean'
     AND jsonb_typeof(bh -> 'timezone') = 'string'
     AND (bh ->> 'timezone') ~ '^[A-Za-z_]+(/[A-Za-z0-9_+-]+){0,2}$'
     AND jsonb_typeof(bh -> 'start') = 'string'
     AND (bh ->> 'start') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     AND jsonb_typeof(bh -> 'end') = 'string'
     AND (bh ->> 'end') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     AND jsonb_typeof(bh -> 'days') = 'array'
     AND jsonb_array_length(bh -> 'days') BETWEEN 1 AND 7
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(bh -> 'days') d
        WHERE jsonb_typeof(d) <> 'number' OR d::text !~ '^[0-6]$'
     ), FALSE)
$$;

ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'suggest';
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS business_hours JSONB NOT NULL
  DEFAULT '{"enabled": false, "timezone": "America/Sao_Paulo", "start": "08:00", "end": "18:00", "days": [1, 2, 3, 4, 5]}'::jsonb;
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS ignore_groups BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS split_messages BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS max_chars_per_message INT NOT NULL DEFAULT 400;
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS handoff_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS handoff_keywords TEXT[] NOT NULL
  DEFAULT ARRAY['falar com atendente', 'atendente', 'humano', 'pessoa real']::TEXT[];
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS handoff_message TEXT
  DEFAULT 'Vou te passar para uma pessoa da nossa equipe. Em instantes alguém continua o atendimento por aqui.';
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS max_messages_per_turn INT NOT NULL DEFAULT 3;
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS max_auto_replies_per_day INT NOT NULL DEFAULT 20;

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_description_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_description_check
  CHECK (description IS NULL OR char_length(description) <= 300);

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_mode_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_mode_check
  CHECK (mode IN ('suggest', 'auto'));

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_business_hours_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_business_hours_check
  CHECK (public.ai_agents_business_hours_valid(business_hours));

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_max_chars_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_max_chars_check
  CHECK (max_chars_per_message BETWEEN 80 AND 1000);

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_handoff_keywords_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_handoff_keywords_check
  CHECK (cardinality(handoff_keywords) <= 20);

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_handoff_message_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_handoff_message_check
  CHECK (handoff_message IS NULL OR char_length(handoff_message) <= 500);

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_max_messages_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_max_messages_check
  CHECK (max_messages_per_turn BETWEEN 1 AND 5);

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_max_auto_replies_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_max_auto_replies_check
  CHECK (max_auto_replies_per_day BETWEEN 1 AND 200);
