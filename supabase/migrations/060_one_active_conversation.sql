-- ============================================================
-- 060_one_active_conversation.sql — a resolved conversation is final.
--
-- What this migration does
--   Partial unique index: at most ONE non-closed (open / pending)
--      conversation per contact. A customer who writes after the
--      conversation was resolved now gets a NEW conversation row
--      (src/lib/whatsapp/inbound.ts) instead of reopening the old one;
--      two concurrent deliveries race on this index and the loser
--      re-selects the winner's row. The explicit "Reabrir" in the inbox
--      hits the same index when a newer conversation is already open,
--      and the UI explains it.
--      Contacts are account-scoped, so contact_id alone is per account.
--      The conversation's `channel` follows the customer's latest
--      transport (inbound.ts), so the key is the contact, not
--      contact+channel — one live thread per customer.
--      Created only when the table holds no duplicates: rows are never
--      deleted or modified here. When it is skipped a NOTICE says so and
--      the app still picks the newest non-closed row.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
DECLARE
  v_dupes INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'conversations_one_active_per_contact'
  ) THEN
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_dupes
  FROM (
    SELECT contact_id
    FROM public.conversations
    WHERE status <> 'closed'
    GROUP BY contact_id
    HAVING COUNT(*) > 1
  ) d;

  IF v_dupes > 0 THEN
    RAISE NOTICE
      '060: % contact(s) have more than one open/pending conversation; '
      'conversations_one_active_per_contact NOT created. Resolve the extra '
      'conversations and run this migration again.', v_dupes;
    RETURN;
  END IF;

  CREATE UNIQUE INDEX conversations_one_active_per_contact
    ON public.conversations (contact_id)
    WHERE status <> 'closed';
END;
$$;
