-- ============================================================
-- 030_radar_followup_optout.sql — Radar (conversations at risk),
-- inactivity follow-up trigger and contact opt-out.
--
-- Spec: docs/superpowers/specs/2026-09-13-parity-round1-design.md
--       sections "3. Radar e follow-up" and "5. Opt-out"
--
-- What this migration does
--   1. conversations.last_customer_message_at / last_agent_message_at,
--      kept by an AFTER INSERT trigger on `messages` and backfilled
--      from the existing rows. Index for the radar / inactivity scans.
--   2. accounts.preferences jsonb — free-form per-account settings
--      (inbox_sla_minutes, cooling_hours, opt_out_keywords). Typed
--      access lives in src/lib/account-preferences.ts. Admin+ already
--      may UPDATE accounts (policy accounts_update, migration 017).
--   3. automation_inactivity_fires — one row per (automation,
--      conversation) recording the silence the follow-up already
--      fired for, so a conversation nudges once per silence.
--   4. contacts.opted_out_at — customer asked to stop ("PARAR").
--   5. conversation_events.event_type gains 'contact_opted_out' and
--      'contact_opted_in'.
--
-- Does NOT touch handle_new_user.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. CONVERSATIONS — last message per side
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_agent_message_at    TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.conversations_track_last_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_type = 'customer' THEN
    UPDATE conversations
    SET last_customer_message_at = GREATEST(COALESCE(last_customer_message_at, NEW.created_at), NEW.created_at)
    WHERE id = NEW.conversation_id;
  ELSIF NEW.sender_type IN ('agent', 'bot') THEN
    UPDATE conversations
    SET last_agent_message_at = GREATEST(COALESCE(last_agent_message_at, NEW.created_at), NEW.created_at)
    WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.conversations_track_last_message() OWNER TO postgres;

DROP TRIGGER IF EXISTS conversations_track_last_message ON messages;
CREATE TRIGGER conversations_track_last_message
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.conversations_track_last_message();

-- Backfill from the message history (only rows still NULL, so a
-- re-run never rewinds a value the trigger has since advanced).
UPDATE conversations c
SET last_customer_message_at = m.last_at
FROM (
  SELECT conversation_id, MAX(created_at) AS last_at
  FROM messages
  WHERE sender_type = 'customer'
  GROUP BY conversation_id
) m
WHERE m.conversation_id = c.id
  AND c.last_customer_message_at IS NULL;

UPDATE conversations c
SET last_agent_message_at = m.last_at
FROM (
  SELECT conversation_id, MAX(created_at) AS last_at
  FROM messages
  WHERE sender_type IN ('agent', 'bot')
  GROUP BY conversation_id
) m
WHERE m.conversation_id = c.id
  AND c.last_agent_message_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_account_status_last_customer
  ON conversations(account_id, status, last_customer_message_at);

-- ============================================================
-- 2. ACCOUNTS — preferences
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_preferences_object;
ALTER TABLE accounts ADD CONSTRAINT accounts_preferences_object
  CHECK (jsonb_typeof(preferences) = 'object');

-- ============================================================
-- 3. AUTOMATION_INACTIVITY_FIRES
-- ============================================================
CREATE TABLE IF NOT EXISTS automation_inactivity_fires (
  automation_id   UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  fired_for       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (automation_id, conversation_id)
);

-- Written only by the service role (the cron scan). Members may read
-- their account's rows through the automation's account.
ALTER TABLE automation_inactivity_fires ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS automation_inactivity_fires_select ON automation_inactivity_fires;
CREATE POLICY automation_inactivity_fires_select ON automation_inactivity_fires FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM automations a
      WHERE a.id = automation_inactivity_fires.automation_id
        AND is_account_member(a.account_id)
    )
  );

-- ============================================================
-- 4. CONTACTS — opt-out
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_account_opted_out
  ON contacts(account_id) WHERE opted_out_at IS NOT NULL;

-- ============================================================
-- 5. CONVERSATION_EVENTS — new event types
-- ============================================================
ALTER TABLE conversation_events DROP CONSTRAINT IF EXISTS conversation_events_event_type_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_event_type_check
  CHECK (
    event_type IN (
      'assigned',
      'unassigned',
      'status_changed',
      'label_added',
      'label_removed',
      'note_added',
      'contact_opted_out',
      'contact_opted_in'
    )
  );
