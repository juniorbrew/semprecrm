-- ============================================================
-- 057_task_reminders.sql — "Lembrar" in the inbox header.
--
-- A reminder is a task (migration 027) linked to the conversation and
-- the contact, assigned to the agent who set it, with an exact
-- notification time.
--
-- What this migration does
--   1. `tasks.remind_at` — when to push the reminder. The cron
--      (/api/automations/cron → notifyTaskReminders) pushes at that
--      time instead of the generic "due in 15 min" warning, and claims
--      the row through the existing `reminded_at` column (036).
--   2. BEFORE UPDATE trigger:
--      a. A reminder task's due date edited elsewhere (/tasks, the task
--         drawer) moves the reminder with it: when `remind_at` equalled
--         the old `due_at` and the statement leaves `remind_at` alone,
--         `remind_at` follows the new `due_at` (NULL when the due date is
--         cleared — it becomes a plain task again). Otherwise a stale
--         `remind_at` would push at the old time and also keep the task
--         out of the "due in 15 min" scan.
--      b. Moving `remind_at` re-arms the reminder (`reminded_at` → NULL)
--         unless the same statement stamps `reminded_at` (the cron's
--         claim).
--   3. Partial index for the cron scan.
--
-- RLS is unchanged: tasks are agent+ writes / viewer+ reads (027).
-- Idempotent.
-- ============================================================

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS remind_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.tasks_rearm_reminder()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.due_at IS DISTINCT FROM OLD.due_at
     AND NEW.remind_at IS NOT DISTINCT FROM OLD.remind_at
     AND OLD.remind_at IS NOT NULL
     AND OLD.remind_at IS NOT DISTINCT FROM OLD.due_at THEN
    NEW.remind_at := NEW.due_at;
  END IF;
  IF NEW.remind_at IS DISTINCT FROM OLD.remind_at
     AND NEW.reminded_at IS NOT DISTINCT FROM OLD.reminded_at THEN
    NEW.reminded_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_rearm_reminder ON tasks;
CREATE TRIGGER trg_tasks_rearm_reminder
  BEFORE UPDATE OF remind_at, due_at ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.tasks_rearm_reminder();

CREATE INDEX IF NOT EXISTS idx_tasks_remind_pending
  ON tasks(remind_at)
  WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND completed_at IS NULL;
