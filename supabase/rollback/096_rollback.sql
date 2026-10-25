-- Forward rollback of 096_agenda_services.sql. NOT a migration: run by hand
-- (as postgres). Roll the APP back first (Agenda page, Settings, /api/agenda).
-- Destroys services, resources, hours and exceptions. Appointments that were
-- booked through them stay as plain calendar events (status mapped back to
-- the 040 values) so nothing disappears from the calendar.
BEGIN;
DROP FUNCTION IF EXISTS public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.agenda_reschedule_appointment(uuid, uuid, timestamptz, uuid);
DROP FUNCTION IF EXISTS public.agenda_set_appointment_status(uuid, uuid, text);
DROP FUNCTION IF EXISTS private.agenda_user_busy(uuid, uuid, timestamptz, timestamptz, uuid);
DROP FUNCTION IF EXISTS private.agenda_assert_caller(uuid);
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_resource_no_overlap;
DROP TRIGGER IF EXISTS calendar_events_agenda_guard ON public.calendar_events;
DROP FUNCTION IF EXISTS public.calendar_events_agenda_guard();
DROP POLICY IF EXISTS calendar_events_appointment_update ON public.calendar_events;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_block_check;
DROP TRIGGER IF EXISTS calendar_events_agenda_block ON public.calendar_events;
DROP FUNCTION IF EXISTS public.calendar_events_agenda_block();
UPDATE public.calendar_events SET status = 'confirmed' WHERE status IN ('scheduled', 'completed', 'no_show');
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_status_check;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_status_check
  CHECK (status IN ('confirmed', 'cancelled'));
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_service_fk;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_resource_fk;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_booking_source_check;
DROP INDEX IF EXISTS public.idx_calendar_events_resource_starts;
DROP INDEX IF EXISTS public.idx_calendar_events_service;
DROP INDEX IF EXISTS public.uq_calendar_events_idempotency;
ALTER TABLE public.calendar_events
  DROP COLUMN IF EXISTS service_id, DROP COLUMN IF EXISTS resource_id,
  DROP COLUMN IF EXISTS booking_source, DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS block_starts_at, DROP COLUMN IF EXISTS block_ends_at;
DROP TABLE IF EXISTS public.agenda_exceptions, public.agenda_working_hours,
  public.agenda_resource_services, public.agenda_settings,
  public.agenda_resources, public.agenda_services;
DROP FUNCTION IF EXISTS public.agenda_resources_check_user();
COMMIT;
