-- ============================================================
-- 059_message_origin_revoke.sql — inbox package 1: messages sent
-- from the phone ("Celular"), sender label on every bubble, and
-- messages the customer deleted for everyone.
--
-- What this migration does
--   1. `messages.origin` — where an outbound message came from, beyond
--      `sender_type`:
--        'phone'      sent from the connected phone / WhatsApp Web /
--                     another linked device (QR channel echo). Stored
--                     as sender_type 'agent' with sender_id NULL, so the
--                     last-message trigger (030/032) counts it as an
--                     agent reply: the customer is no longer waiting.
--        'automation' automations engine (incl. out-of-hours reply)
--        'flow'       flow (chatbot) engine
--        'system'     reserved for platform-generated messages
--      NULL = legacy / manual send; the bubble falls back to
--      sender_type + sender_id. No backfill.
--   2. `messages.revoked_at` / `revoked_by` — the message was deleted
--      for everyone on WhatsApp ('customer' = the contact deleted it,
--      'phone' = deleted from our own phone). The row and its content
--      are kept: agents still see it, struck through, with a label.
--   3. Unique (conversation_id, message_id) — the provider id is unique
--      inside a conversation (one conversation per contact per
--      account). Makes ingestion idempotent even when the phone echo of
--      a message races the row our own send writes. Created only when
--      the table holds no duplicates (never deletes rows); when it is
--      skipped the app still dedupes by lookup.
--
-- RLS is unchanged (017): messages follow their conversation's account.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. ORIGIN
-- ============================================================
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS origin TEXT;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_origin_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_origin_check
  CHECK (origin IS NULL OR origin IN ('phone', 'automation', 'flow', 'system'));

COMMENT ON COLUMN public.messages.origin IS
  'Where an outbound message came from: phone (sent from the connected '
  'phone/linked device, QR echo), automation, flow, system. NULL = manual '
  'send from the inbox (sender_id) or legacy row.';

-- ============================================================
-- 2. REVOKED (deleted for everyone)
-- ============================================================
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_by TEXT;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_revoked_by_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_revoked_by_check
  CHECK (revoked_by IS NULL OR revoked_by IN ('customer', 'phone'));

COMMENT ON COLUMN public.messages.revoked_at IS
  'When the message was deleted for everyone on WhatsApp. The row and its '
  'content are kept so agents can still read it.';
COMMENT ON COLUMN public.messages.revoked_by IS
  'customer = the contact deleted it; phone = deleted from our own phone.';

-- ============================================================
-- 3. UNIQUE (conversation_id, message_id)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'uq_messages_conversation_message_id'
  ) THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.messages
    WHERE message_id IS NOT NULL AND message_id <> ''
    GROUP BY conversation_id, message_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE '059: duplicate (conversation_id, message_id) rows exist — unique index skipped; the app dedupes by lookup';
    RETURN;
  END IF;

  CREATE UNIQUE INDEX uq_messages_conversation_message_id
    ON public.messages (conversation_id, message_id)
    WHERE message_id IS NOT NULL AND message_id <> '';
END;
$$;
