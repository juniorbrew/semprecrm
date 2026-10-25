-- Forward rollback of 097_agenda_reminders.sql. NOT a migration: run by hand (as postgres).
-- Roll the APP back first (reminder cron, Settings block, encaixe checkbox, reply hook).
-- Destroys the reminder settings, the reminders outbox and the encaixe / customer-answer columns.
-- Restores, by itself, the 096 guard and the 096 booking RPCs (with their grants).
-- (The conversation_events CHECK keeps agenda_reply allowed; harmless.)
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
DROP FUNCTION IF EXISTS public.agenda_reminder_reserve_quota(uuid, uuid);
DROP FUNCTION IF EXISTS public.agenda_reminder_respond(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid, boolean);
DROP FUNCTION IF EXISTS public.agenda_reschedule_appointment(uuid, uuid, timestamptz, uuid, boolean, text);
DROP FUNCTION IF EXISTS public.agenda_reschedule_appointment(uuid, uuid, timestamptz, uuid, boolean, text, uuid);
-- 096 versions of the two booking RPCs, with their grants.
CREATE OR REPLACE FUNCTION public.agenda_book_appointment(
  p_account_id UUID,
  p_service_id UUID,
  p_resource_id UUID,
  p_contact_id UUID,
  p_starts_at TIMESTAMPTZ,
  p_conversation_id UUID DEFAULT NULL,
  p_source TEXT DEFAULT 'agent',
  p_notes TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_status TEXT DEFAULT 'scheduled',
  p_actor UUID DEFAULT NULL
) RETURNS public.calendar_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   UUID := COALESCE(auth.uid(), p_actor);
  v_svc     public.agenda_services;
  v_res     public.agenda_resources;
  v_contact TEXT;
  v_end     TIMESTAMPTZ;
  v_row     public.calendar_events;
  v_owner   UUID;
BEGIN
  PERFORM private.agenda_assert_caller(p_account_id);

  -- Chamada de servidor: o ator informado tem de ser membro agent+ da conta.
  IF auth.uid() IS NULL AND p_actor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles pr
     WHERE pr.user_id = p_actor AND pr.account_id = p_account_id AND pr.account_role <> 'viewer'
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('scheduled', 'confirmed') OR p_source NOT IN ('agent', 'ai', 'api') THEN
    RAISE EXCEPTION 'agenda_bad_status' USING ERRCODE = 'AG008';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_row FROM public.calendar_events
     WHERE account_id = p_account_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      -- Mesma chave com outro serviço / cliente / horário não é retry: é erro do chamador.
      IF v_row.service_id IS DISTINCT FROM p_service_id
         OR v_row.contact_id IS DISTINCT FROM p_contact_id
         OR v_row.starts_at IS DISTINCT FROM p_starts_at THEN
        RAISE EXCEPTION 'agenda_idempotency_conflict' USING ERRCODE = 'AG010';
      END IF;
      RETURN v_row;
    END IF;
  END IF;

  -- Serializa as reservas do mesmo recurso.
  SELECT * INTO v_res FROM public.agenda_resources
   WHERE id = p_resource_id AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR NOT v_res.is_active THEN
    RAISE EXCEPTION 'agenda_resource_unavailable' USING ERRCODE = 'AG003';
  END IF;

  SELECT * INTO v_svc FROM public.agenda_services
   WHERE id = p_service_id AND account_id = p_account_id;
  IF NOT FOUND OR NOT v_svc.is_active THEN
    RAISE EXCEPTION 'agenda_service_unavailable' USING ERRCODE = 'AG003';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.agenda_resource_services
     WHERE resource_id = p_resource_id AND service_id = p_service_id
  ) THEN
    RAISE EXCEPTION 'agenda_service_not_offered' USING ERRCODE = 'AG002';
  END IF;

  SELECT COALESCE(NULLIF(btrim(c.name), ''), c.phone, '') INTO v_contact FROM public.contacts c
   WHERE c.id = p_contact_id AND c.account_id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agenda_contact_not_found' USING ERRCODE = 'AG004';
  END IF;
  IF p_conversation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.conversations v WHERE v.id = p_conversation_id AND v.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'agenda_contact_not_found' USING ERRCODE = 'AG004';
  END IF;

  v_end := p_starts_at + make_interval(mins => v_svc.duration_minutes);
  v_owner := private.agenda_owner_for(p_account_id, v_res.user_id, v_actor);

  IF private.agenda_user_busy(
       p_account_id, v_res.user_id,
       p_starts_at - make_interval(mins => v_svc.buffer_before_minutes),
       v_end + make_interval(mins => v_svc.buffer_after_minutes)
     ) THEN
    RAISE EXCEPTION 'agenda_busy' USING ERRCODE = 'AG005';
  END IF;

  BEGIN
    INSERT INTO public.calendar_events (
      account_id, owner_user_id, title, description, color,
      starts_at, ends_at, status, contact_id, conversation_id,
      created_by, service_id, resource_id, booking_source, idempotency_key
    ) VALUES (
      p_account_id, v_owner,
      left(v_svc.name || CASE WHEN v_contact <> '' THEN ' — ' || v_contact ELSE '' END, 200),
      NULLIF(btrim(p_notes), ''), COALESCE(v_svc.color, v_res.color),
      p_starts_at, v_end, p_status, p_contact_id, p_conversation_id,
      v_actor, p_service_id, p_resource_id, p_source, p_idempotency_key
    ) RETURNING * INTO v_row;
  EXCEPTION
    WHEN exclusion_violation THEN
      RAISE EXCEPTION 'agenda_slot_taken' USING ERRCODE = 'AG001';
    WHEN unique_violation THEN
      -- Mesma chave de idempotência chegando em paralelo: devolve o já criado.
      SELECT * INTO v_row FROM public.calendar_events
       WHERE account_id = p_account_id AND idempotency_key = p_idempotency_key;
      IF NOT FOUND THEN RAISE; END IF;
      IF v_row.service_id IS DISTINCT FROM p_service_id
         OR v_row.contact_id IS DISTINCT FROM p_contact_id
         OR v_row.starts_at IS DISTINCT FROM p_starts_at THEN
        RAISE EXCEPTION 'agenda_idempotency_conflict' USING ERRCODE = 'AG010';
      END IF;
  END;

  RETURN v_row;
END;
$$;

-- ============================================================
-- agenda_reschedule_appointment — novo horário (e, opcionalmente, outro recurso).
-- AG006: já cancelado / concluído / faltou. Mantém a duração do serviço.
-- ============================================================
CREATE OR REPLACE FUNCTION public.agenda_reschedule_appointment(
  p_account_id UUID,
  p_event_id UUID,
  p_starts_at TIMESTAMPTZ,
  p_resource_id UUID DEFAULT NULL
) RETURNS public.calendar_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ev   public.calendar_events;
  v_svc  public.agenda_services;
  v_res  public.agenda_resources;
  v_end  TIMESTAMPTZ;
  v_row  public.calendar_events;
BEGIN
  PERFORM private.agenda_assert_caller(p_account_id);

  SELECT * INTO v_ev FROM public.calendar_events
   WHERE id = p_event_id AND account_id = p_account_id AND service_id IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agenda_appointment_not_found' USING ERRCODE = 'AG009';
  END IF;
  IF v_ev.status NOT IN ('scheduled', 'confirmed') THEN
    RAISE EXCEPTION 'agenda_not_reschedulable' USING ERRCODE = 'AG006';
  END IF;

  SELECT * INTO v_res FROM public.agenda_resources
   WHERE id = COALESCE(p_resource_id, v_ev.resource_id) AND account_id = p_account_id FOR UPDATE;
  IF NOT FOUND OR NOT v_res.is_active THEN
    RAISE EXCEPTION 'agenda_resource_unavailable' USING ERRCODE = 'AG003';
  END IF;
  SELECT * INTO v_svc FROM public.agenda_services WHERE id = v_ev.service_id AND account_id = p_account_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.agenda_resource_services WHERE resource_id = v_res.id AND service_id = v_ev.service_id
  ) THEN
    RAISE EXCEPTION 'agenda_service_not_offered' USING ERRCODE = 'AG002';
  END IF;

  v_end := p_starts_at + make_interval(mins => v_svc.duration_minutes);
  IF private.agenda_user_busy(
       p_account_id, v_res.user_id,
       p_starts_at - make_interval(mins => v_svc.buffer_before_minutes),
       v_end + make_interval(mins => v_svc.buffer_after_minutes),
       p_event_id
     ) THEN
    RAISE EXCEPTION 'agenda_busy' USING ERRCODE = 'AG005';
  END IF;

  BEGIN
    UPDATE public.calendar_events
       SET starts_at = p_starts_at,
           ends_at = v_end,
           resource_id = v_res.id,
           owner_user_id = COALESCE(private.agenda_owner_for(p_account_id, v_res.user_id, NULL), v_ev.owner_user_id)
     WHERE id = p_event_id
     RETURNING * INTO v_row;
  EXCEPTION
    WHEN exclusion_violation THEN
      RAISE EXCEPTION 'agenda_slot_taken' USING ERRCODE = 'AG001';
  END;
  RETURN v_row;
END;
$$;


DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid)',
    'public.agenda_reschedule_appointment(uuid, uuid, timestamptz, uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;

DROP TABLE IF EXISTS public.agenda_reminders;
DROP TABLE IF EXISTS public.agenda_reminder_settings;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_customer_response_check;
ALTER TABLE public.calendar_events
  DROP COLUMN IF EXISTS booking_override,
  DROP COLUMN IF EXISTS customer_response,
  DROP COLUMN IF EXISTS customer_responded_at;
COMMIT;
