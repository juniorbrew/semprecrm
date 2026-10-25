-- Forward rollback of 097_agenda_reminders.sql. NOT a migration: run by hand (as postgres).
-- Roll the APP back first (reminder cron, Settings block, encaixe checkbox, reply hook).
-- Destroys the reminder settings, the reminders outbox and the encaixe / customer-answer columns.
-- The 096 guard is restored below. AFTER this script, re-run from 096_agenda_services.sql ONLY
-- agenda_book_appointment(), agenda_reschedule_appointment() and the final DO block that grants
-- EXECUTE to service_role, to get the previous booking RPCs back.
-- (The conversation_events CHECK keeps 'agenda_reply' allowed; harmless.)
BEGIN;
-- 096 version of the guard (without the 097 columns), before the columns go away.
CREATE OR REPLACE FUNCTION public.calendar_events_agenda_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT (current_user IN ('authenticated', 'anon') OR auth.uid() IS NOT NULL) THEN
    -- Nem o service_role (sync Google/Outlook, jobs) muda tempo / status / recurso
    -- de um agendamento direto: só as RPCs, que rodam como postgres.
    IF TG_OP = 'UPDATE' AND current_user <> 'postgres' AND OLD.service_id IS NOT NULL AND (
         NEW.starts_at IS DISTINCT FROM OLD.starts_at
      OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
      OR NEW.service_id IS DISTINCT FROM OLD.service_id
    ) THEN
      RAISE EXCEPTION 'agenda_use_booking_api' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.service_id IS NOT NULL OR NEW.resource_id IS NOT NULL
       OR NEW.booking_source IS NOT NULL OR NEW.idempotency_key IS NOT NULL THEN
      RAISE EXCEPTION 'agenda_fields_reserved' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
     OR NEW.booking_source IS DISTINCT FROM OLD.booking_source
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'agenda_fields_reserved' USING ERRCODE = '42501';
  ELSIF OLD.service_id IS NOT NULL AND (
       NEW.starts_at IS DISTINCT FROM OLD.starts_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    -- Para NULL pode: é o ON DELETE SET NULL de apagar contato / conversa numa sessão de usuário.
    OR (NEW.contact_id IS NOT NULL AND NEW.contact_id IS DISTINCT FROM OLD.contact_id)
    OR (NEW.conversation_id IS NOT NULL AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id)
    OR NEW.block_starts_at IS DISTINCT FROM OLD.block_starts_at
    OR NEW.block_ends_at IS DISTINCT FROM OLD.block_ends_at
  ) THEN
    RAISE EXCEPTION 'agenda_use_booking_api' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.calendar_events_agenda_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS calendar_events_agenda_reminders ON public.calendar_events;
DROP TRIGGER IF EXISTS calendar_events_agenda_reset_response ON public.calendar_events;
DROP TRIGGER IF EXISTS agenda_reminder_settings_replan ON public.agenda_reminder_settings;
DROP FUNCTION IF EXISTS private.agenda_reminders_event_trg();
DROP FUNCTION IF EXISTS private.agenda_reminders_settings_trg();
DROP FUNCTION IF EXISTS private.agenda_reminders_plan(uuid);
DROP FUNCTION IF EXISTS public.calendar_events_agenda_reset_response();
DROP FUNCTION IF EXISTS public.agenda_reminders_claim(timestamptz, integer);
DROP FUNCTION IF EXISTS public.agenda_reminder_respond(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid, boolean);
DROP FUNCTION IF EXISTS public.agenda_reschedule_appointment(uuid, uuid, timestamptz, uuid, boolean, text);
DROP TABLE IF EXISTS public.agenda_reminders;
DROP TABLE IF EXISTS public.agenda_reminder_settings;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_customer_response_check;
ALTER TABLE public.calendar_events
  DROP COLUMN IF EXISTS booking_override,
  DROP COLUMN IF EXISTS customer_response,
  DROP COLUMN IF EXISTS customer_responded_at;
COMMIT;
