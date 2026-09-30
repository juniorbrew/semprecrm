-- ============================================================
-- 069_transfer_reason_limit.sql — server-side bound for the optional
-- transfer reason (`conversation_events.payload->>'reason'` of an
-- `assigned` event, written by the inbox "Transferir" dialog).
--
-- The UI and eventFromRecord cap it at 200 characters; this constraint
-- makes the same limit hold for any client. Only `assigned` events are
-- bound (`ai_handoff` events keep their own, longer `reason`). A missing
-- reason (NULL) always passes, so existing rows are unaffected.
-- Idempotent.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'conversation_events_transfer_reason_len'
       AND conrelid = 'public.conversation_events'::regclass
  ) THEN
    ALTER TABLE public.conversation_events
      ADD CONSTRAINT conversation_events_transfer_reason_len
      CHECK (event_type <> 'assigned' OR char_length(payload ->> 'reason') <= 200);
  END IF;
END;
$$;
