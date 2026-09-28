-- ============================================================
-- 056_conversation_archive.sql — "Arquivar" in the inbox header.
--
-- What this migration does
--   1. `conversations.archived_at` — set by the inbox when an agent
--      archives a conversation (together with status = 'closed': an
--      archived conversation is a resolved one moved out of the way).
--      The inbox lists hide archived rows except under the
--      "Arquivadas" status filter.
--   2. BEFORE UPDATE trigger: an archived conversation comes back by
--      itself — `archived_at` is cleared when the status leaves
--      'closed' (reopen, including the inbound auto-reopen) or when
--      the customer writes again (`last_customer_message_at` moves,
--      maintained by the migration-030 trigger), so a new message is
--      never hidden in the archive even when auto-reopen is off. A
--      statement that sets `archived_at` itself is left alone.
--
-- RLS is unchanged: `conversations_update` already requires agent+
-- (migration 017), so viewers cannot archive. Idempotent.
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.conversations_unarchive_on_activity()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL
     AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at
     AND (
       NEW.status IS DISTINCT FROM 'closed'
       OR NEW.last_customer_message_at IS DISTINCT FROM OLD.last_customer_message_at
     ) THEN
    NEW.archived_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversations_unarchive_on_activity ON conversations;
CREATE TRIGGER trg_conversations_unarchive_on_activity
  BEFORE UPDATE OF status, last_customer_message_at, archived_at ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.conversations_unarchive_on_activity();
