-- ============================================================
-- 024_conversation_events.sql — Shared conversation activity log
--
-- The inbox thread shows centred "system pills" between messages
-- ("Ana Ribeiro atribuiu para si", "Conversa resolvida", "Etiqueta
-- VIP adicionada"). Until now that log lived in localStorage, so a
-- fresh tab showed nothing and teammates never saw each other's
-- actions. This table makes the log server-backed and account-shared.
--
-- One row per action. `event_type` is a closed list (CHECK) so the
-- client can switch on it exhaustively; `payload` carries the
-- type-specific details:
--
--   assigned       { assignee_user_id, assignee_name, self_assigned }
--   unassigned     { }
--   status_changed { status, previous_status }
--   label_added    { tag_id, tag_name }
--   label_removed  { tag_id, tag_name }
--   note_added     { note_id }
--
-- `actor_user_id` is nullable so automations / webhooks (no session)
-- and events whose actor was later deleted still render, in the
-- passive voice. `payload.actor_name` is a display snapshot the
-- client prefers the live profile name over.
--
-- RLS mirrors migration 017: viewers may read, agents+ may insert.
-- Rows are immutable from the client (no UPDATE/DELETE policy); the
-- conversation's ON DELETE CASCADE is the only way they go away.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'assigned',
      'unassigned',
      'status_changed',
      'label_added',
      'label_removed',
      'note_added'
    )
  ),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- The thread reads one conversation's log in time order.
CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation_created
  ON conversation_events(conversation_id, created_at);

-- Account-wide reporting ("who resolved what this week") later.
CREATE INDEX IF NOT EXISTS idx_conversation_events_account_created
  ON conversation_events(account_id, created_at);

-- ============================================================
-- RLS — same predicate shape as migration 017's conversations
-- ============================================================
ALTER TABLE conversation_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_events_select ON conversation_events;
DROP POLICY IF EXISTS conversation_events_insert ON conversation_events;

CREATE POLICY conversation_events_select ON conversation_events FOR SELECT
  USING (is_account_member(account_id));

-- Agents+ may log events, but only on conversations of the same
-- account (the FK alone would let an agent point at another tenant's
-- conversation id) and only as themselves or anonymously.
CREATE POLICY conversation_events_insert ON conversation_events FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND (actor_user_id IS NULL OR actor_user_id = auth.uid())
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_events.conversation_id
        AND c.account_id = conversation_events.account_id
    )
  );

-- ============================================================
-- Realtime — let the open thread subscribe filtered by conversation_id
-- (same DO-block pattern as messages / conversations in 001 and
-- message_reactions in 009).
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'conversation_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE conversation_events;
  END IF;
END $$;
