-- ============================================================
-- 032_first_response.sql — first response per conversation
-- (team metrics, "Métricas por atendente").
--
-- Spec: docs/superpowers/specs/2026-09-13-deskcomm-parity-round2-design.md
--       section "1. Métricas por atendente"
--
-- What this migration does
--   1. conversations.first_response_at / first_response_seconds /
--      first_response_by — when the FIRST agent or bot message landed
--      after a customer wrote, how long the customer waited for it and
--      who sent it (messages.sender_id; NULL for bots / unknown).
--   2. Redefines `conversations_track_last_message()` (migration 030,
--      AFTER INSERT on messages) so, besides last_customer_message_at /
--      last_agent_message_at, it fills the three columns above on the
--      first agent/bot message that follows a customer message while
--      first_response_at is still NULL.
--   3. Backfill from the message history: per conversation, the first
--      customer message and the first agent/bot message after it —
--      the same pairing `loadResponseTime` does in JS.
--   4. Index (account_id, first_response_by, first_response_at) for the
--      per-member aggregation.
--
-- Does NOT touch handle_new_user.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. CONVERSATIONS — first response columns
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS first_response_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_response_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS first_response_by      UUID;

-- ============================================================
-- 2. TRIGGER — extend the 030 function
-- ============================================================
CREATE OR REPLACE FUNCTION public.conversations_track_last_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_customer TIMESTAMPTZ;
  v_first_response TIMESTAMPTZ;
BEGIN
  IF NEW.sender_type = 'customer' THEN
    UPDATE conversations
    SET last_customer_message_at = GREATEST(COALESCE(last_customer_message_at, NEW.created_at), NEW.created_at)
    WHERE id = NEW.conversation_id;
  ELSIF NEW.sender_type IN ('agent', 'bot') THEN
    SELECT last_customer_message_at, first_response_at
      INTO v_last_customer, v_first_response
    FROM conversations
    WHERE id = NEW.conversation_id;

    UPDATE conversations
    SET last_agent_message_at = GREATEST(COALESCE(last_agent_message_at, NEW.created_at), NEW.created_at)
    WHERE id = NEW.conversation_id;

    -- First reply: the customer has written, nobody answered yet, and
    -- this message comes after (or at) the customer's message.
    IF v_first_response IS NULL
       AND v_last_customer IS NOT NULL
       AND NEW.created_at >= v_last_customer THEN
      UPDATE conversations
      SET first_response_at      = NEW.created_at,
          first_response_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NEW.created_at - v_last_customer)))::INTEGER),
          first_response_by      = NEW.sender_id
      WHERE id = NEW.conversation_id
        AND first_response_at IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.conversations_track_last_message() OWNER TO postgres;

DROP TRIGGER IF EXISTS conversations_track_last_message ON messages;
CREATE TRIGGER conversations_track_last_message
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.conversations_track_last_message();

-- ============================================================
-- 3. BACKFILL — first customer message → first agent/bot reply after it
-- ============================================================
WITH first_customer AS (
  SELECT conversation_id, MIN(created_at) AS customer_at
  FROM messages
  WHERE sender_type = 'customer'
  GROUP BY conversation_id
),
first_reply AS (
  SELECT DISTINCT ON (m.conversation_id)
         m.conversation_id, m.created_at AS reply_at, m.sender_id, fc.customer_at
  FROM messages m
  JOIN first_customer fc ON fc.conversation_id = m.conversation_id
  WHERE m.sender_type IN ('agent', 'bot')
    AND m.created_at >= fc.customer_at
  ORDER BY m.conversation_id, m.created_at ASC, m.id ASC
)
UPDATE conversations c
SET first_response_at      = fr.reply_at,
    first_response_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (fr.reply_at - fr.customer_at))))::INTEGER,
    first_response_by      = fr.sender_id
FROM first_reply fr
WHERE fr.conversation_id = c.id
  AND c.first_response_at IS NULL;

-- ============================================================
-- 4. INDEX
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_conversations_account_first_response
  ON conversations(account_id, first_response_by, first_response_at)
  WHERE first_response_at IS NOT NULL;
