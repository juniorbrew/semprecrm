-- ============================================================
-- 052_message_failure_reason
--
-- Ported from wacrm #535 (upstream migration 042). When Meta cannot
-- deliver an outbound message it posts a `failed` status webhook whose
-- `errors[0]` carries the reason — a stable numeric `code` (131049
-- "per-user marketing limit", 131026 "undeliverable", 131047
-- "re-engagement window closed", ...), a short `title`, and a
-- human-readable `error_data.details`. The webhook wrote only
-- `status = 'failed'` and dropped the rest, so an agent looking at a
-- red X in the inbox could not tell a blocked number from an expired
-- template from an account-level cap.
--
--   1. `messages.error_code` / `error_title` / `error_details` — the
--      three pieces Meta sends, stored separately so the code stays
--      filterable. All nullable: only populated on a `failed` status
--      and deliberately NOT cleared if a later non-failed status
--      arrives for the same wamid (Meta does not promise ordering).
--
--   2. Nothing on `broadcast_recipients`: its free-text `error_message`
--      (migration 001) now also receives "[code] title: details" from
--      the webhook for asynchronous failures.
--
-- No backfill is possible: earlier failure payloads were discarded.
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS error_code INTEGER,
  ADD COLUMN IF NOT EXISTS error_title TEXT,
  ADD COLUMN IF NOT EXISTS error_details TEXT;

COMMENT ON COLUMN public.messages.error_code IS
  'Meta''s numeric error code from a failed status webhook (errors[0].code). '
  'NULL unless the message failed. Not cleared by a later status update.';

COMMENT ON COLUMN public.messages.error_title IS
  'Meta''s short error label from a failed status webhook (errors[0].title). '
  'NULL unless the message failed.';

COMMENT ON COLUMN public.messages.error_details IS
  'Meta''s human-readable explanation from a failed status webhook '
  '(errors[0].error_data.details). NULL unless the message failed and Meta '
  'supplied details.';
