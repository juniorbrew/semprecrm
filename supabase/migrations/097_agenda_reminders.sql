-- ============================================================
-- 097 — Agenda inteligente, entrega B: lembretes e confirmação por WhatsApp
-- + "encaixe" (agendar ignorando antecedência mínima e janela de dias).
--
-- Spec: docs/superpowers/specs/2026-10-24-agenda-inteligente.md (seção B).
--
--   1. calendar_events + booking_override (encaixe, auditoria),
--      customer_response / customer_responded_at (resposta do cliente ao
--      lembrete). Só as RPCs gravam essas colunas (guard).
--   2. agenda_reminder_settings: por conta — ligado, até 2 antecedências
--      (padrão 24 h e 2 h), texto, modelo aprovado do canal oficial.
--   3. agenda_reminders: a fila/caixa de saída — uma linha por
--      (agendamento, posição 1|2, horário do agendamento). A unicidade é a
--      garantia de que o mesmo lembrete nunca é gerado nem enviado duas vezes;
--      agenda_reminders_claim() faz pending->sending com FOR UPDATE SKIP LOCKED.
--   4. Trigger em calendar_events: cria os lembretes pendentes quando o
--      agendamento nasce / muda de horário / status / contato; remarcar
--      cancela os pendentes antigos e cria os novos; cancelar / faltou /
--      concluir cancela. Antecedência já vencida nasce 'skipped' (past).
--   5. agenda_reminder_respond(): a resposta do cliente (confirmar / pedir
--      para remarcar), atômica; confirmar usa agenda_set_appointment_status.
--   6. agenda_book_appointment / agenda_reschedule_appointment ganham
--      p_override (encaixe): só com source 'agent'.
--   7. conversation_events.event_type + 'agenda_reply'.
--
-- Aditiva, exceto: as duas RPCs do item 6 são recriadas com parâmetros a mais
-- (as assinaturas antigas são removidas; o app novo chama as novas).
-- Reverter: supabase/rollback/097_rollback.sql.
-- Verificar num Postgres real: supabase/tests/agenda_reminders.sql (ROLLBACK).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---- 1. colunas ---------------------------------------------------------
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS booking_override      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS customer_response     TEXT;
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS customer_responded_at TIMESTAMPTZ;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_customer_response_check;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_customer_response_check
  CHECK (customer_response IS NULL OR customer_response IN ('confirmed', 'reschedule_requested'));

-- Guard (096) + as colunas novas: usuário não grava encaixe nem resposta do cliente.
CREATE OR REPLACE FUNCTION public.calendar_events_agenda_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT (current_user IN ('authenticated', 'anon') OR auth.uid() IS NOT NULL) THEN
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
       OR NEW.booking_source IS NOT NULL OR NEW.idempotency_key IS NOT NULL
       OR NEW.booking_override OR NEW.customer_response IS NOT NULL
       OR NEW.customer_responded_at IS NOT NULL THEN
      RAISE EXCEPTION 'agenda_fields_reserved' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
     OR NEW.booking_source IS DISTINCT FROM OLD.booking_source
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.booking_override IS DISTINCT FROM OLD.booking_override
     OR NEW.customer_response IS DISTINCT FROM OLD.customer_response
     OR NEW.customer_responded_at IS DISTINCT FROM OLD.customer_responded_at THEN
    RAISE EXCEPTION 'agenda_fields_reserved' USING ERRCODE = '42501';
  ELSIF OLD.service_id IS NOT NULL AND (
       NEW.starts_at IS DISTINCT FROM OLD.starts_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
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

-- Remarcar zera a resposta do cliente: ela valia para o horário antigo.
-- (BEFORE, depois do guard na ordem alfabética: o guard já comparou NEW com OLD.)
CREATE OR REPLACE FUNCTION public.calendar_events_agenda_reset_response()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.customer_response := NULL;
  NEW.customer_responded_at := NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.calendar_events_agenda_reset_response() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS calendar_events_agenda_reset_response ON public.calendar_events;
CREATE TRIGGER calendar_events_agenda_reset_response
  BEFORE UPDATE OF starts_at ON public.calendar_events
  FOR EACH ROW WHEN (OLD.starts_at IS DISTINCT FROM NEW.starts_at AND NEW.customer_response IS NOT NULL)
  EXECUTE FUNCTION public.calendar_events_agenda_reset_response();

-- ---- 2. configuração por conta -------------------------------------------
CREATE TABLE IF NOT EXISTS public.agenda_reminder_settings (
  account_id            UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  enabled               BOOLEAN NOT NULL DEFAULT false,
  -- minutos antes do horário; NULL = esse lembrete está desligado
  first_offset_minutes  INTEGER DEFAULT 1440 CHECK (first_offset_minutes IS NULL OR first_offset_minutes BETWEEN 5 AND 20160),
  second_offset_minutes INTEGER DEFAULT 120  CHECK (second_offset_minutes IS NULL OR second_offset_minutes BETWEEN 5 AND 20160),
  -- NULL = texto padrão do app. Variáveis: {cliente} {servico} {profissional} {data} {hora}
  message_text          TEXT CHECK (message_text IS NULL OR (btrim(message_text) <> '' AND char_length(message_text) <= 1000)),
  -- modelo aprovado (canal oficial, fora da janela de 24 h). Corpo: {{1}} cliente, {{2}} serviço,
  -- {{3}} profissional, {{4}} data, {{5}} hora.
  template_name         TEXT CHECK (template_name IS NULL OR char_length(template_name) <= 512),
  template_language     TEXT NOT NULL DEFAULT 'pt_BR' CHECK (char_length(template_language) <= 16),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (first_offset_minutes IS NULL OR second_offset_minutes IS NULL OR first_offset_minutes <> second_offset_minutes)
);
DROP TRIGGER IF EXISTS set_updated_at ON public.agenda_reminder_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.agenda_reminder_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- 3. fila / caixa de saída -------------------------------------------
CREATE TABLE IF NOT EXISTS public.agenda_reminders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  event_id       UUID NOT NULL REFERENCES public.calendar_events(id) ON DELETE CASCADE,
  slot           SMALLINT NOT NULL CHECK (slot IN (1, 2)),
  offset_minutes INTEGER NOT NULL CHECK (offset_minutes BETWEEN 5 AND 20160),
  -- o horário do agendamento para o qual este lembrete vale (remarcar = nova linha)
  for_starts_at  TIMESTAMPTZ NOT NULL,
  due_at         TIMESTAMPTZ NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending', 'sending', 'sent', 'skipped', 'failed', 'cancelled')),
  -- código curto do motivo (past, read_only, window_closed, no_phone, opted_out, ...)
  reason         TEXT CHECK (reason IS NULL OR char_length(reason) <= 60),
  error_text     TEXT CHECK (error_text IS NULL OR char_length(error_text) <= 500),
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_try_at    TIMESTAMPTZ,
  claimed_at     TIMESTAMPTZ,
  sent_at        TIMESTAMPTZ,
  wa_message_id  TEXT,
  channel        TEXT,
  response       TEXT CHECK (response IS NULL OR response IN ('confirmed', 'reschedule_requested')),
  responded_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_agenda_reminders_event_slot UNIQUE (event_id, slot, for_starts_at)
);
CREATE INDEX IF NOT EXISTS idx_agenda_reminders_due
  ON public.agenda_reminders (due_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_agenda_reminders_sending
  ON public.agenda_reminders (claimed_at) WHERE state = 'sending';
CREATE INDEX IF NOT EXISTS idx_agenda_reminders_awaiting_reply
  ON public.agenda_reminders (account_id, sent_at DESC) WHERE state = 'sent' AND response IS NULL;

-- ---- 4. planejar os lembretes de um agendamento ---------------------------
-- Idempotente: pode rodar quantas vezes quiser (trigger, mudança de configuração).
CREATE OR REPLACE FUNCTION private.agenda_reminders_plan(p_event_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ev   public.calendar_events;
  v_set  public.agenda_reminder_settings;
  v_want BOOLEAN;
  v_slot SMALLINT;
  v_off  INTEGER;
  v_due  TIMESTAMPTZ;
  v_now  TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_ev FROM public.calendar_events WHERE id = p_event_id;
  IF NOT FOUND OR v_ev.service_id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_set FROM public.agenda_reminder_settings WHERE account_id = v_ev.account_id;
  v_want := FOUND AND v_set.enabled
            AND v_ev.status IN ('scheduled', 'confirmed')
            AND v_ev.contact_id IS NOT NULL
            AND v_ev.starts_at > v_now;

  -- O que não vale mais é cancelado (nunca apagado: o histórico fica).
  UPDATE public.agenda_reminders r
     SET state = 'cancelled',
         reason = CASE
           WHEN v_ev.status NOT IN ('scheduled', 'confirmed') OR v_ev.contact_id IS NULL OR v_ev.starts_at <= v_now THEN 'appointment_closed'
           WHEN r.for_starts_at <> v_ev.starts_at THEN 'rescheduled'
           ELSE 'settings_changed' END,
         updated_at = v_now
   WHERE r.event_id = p_event_id AND r.state = 'pending'
     AND (NOT v_want
          OR r.for_starts_at <> v_ev.starts_at
          OR (r.slot = 1 AND v_set.first_offset_minutes IS NULL)
          OR (r.slot = 2 AND v_set.second_offset_minutes IS NULL));
  IF NOT v_want THEN RETURN; END IF;

  FOR v_slot, v_off IN
    SELECT 1::smallint, v_set.first_offset_minutes
    UNION ALL
    SELECT 2::smallint, v_set.second_offset_minutes
  LOOP
    CONTINUE WHEN v_off IS NULL;
    v_due := v_ev.starts_at - make_interval(mins => v_off);
    INSERT INTO public.agenda_reminders (account_id, event_id, slot, offset_minutes, for_starts_at, due_at, state, reason)
    VALUES (v_ev.account_id, v_ev.id, v_slot, v_off, v_ev.starts_at, v_due,
            CASE WHEN v_due > v_now THEN 'pending' ELSE 'skipped' END,
            CASE WHEN v_due > v_now THEN NULL ELSE 'past' END)
    ON CONFLICT (event_id, slot, for_starts_at) DO UPDATE
       SET offset_minutes = EXCLUDED.offset_minutes, due_at = EXCLUDED.due_at,
           state = EXCLUDED.state, reason = EXCLUDED.reason,
           attempts = 0, next_try_at = NULL, error_text = NULL, updated_at = v_now
     WHERE public.agenda_reminders.state IN ('pending', 'cancelled')
        OR (public.agenda_reminders.state = 'skipped' AND public.agenda_reminders.reason = 'past');
  END LOOP;
END;
$$;
ALTER FUNCTION private.agenda_reminders_plan(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.agenda_reminders_plan(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.agenda_reminders_event_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM private.agenda_reminders_plan(NEW.id);
  RETURN NULL;
END;
$$;
ALTER FUNCTION private.agenda_reminders_event_trg() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.agenda_reminders_event_trg() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS calendar_events_agenda_reminders ON public.calendar_events;
CREATE TRIGGER calendar_events_agenda_reminders
  AFTER INSERT OR UPDATE OF starts_at, status, contact_id ON public.calendar_events
  FOR EACH ROW WHEN (NEW.service_id IS NOT NULL)
  EXECUTE FUNCTION private.agenda_reminders_event_trg();

-- Ligar / desligar / mudar antecedências: replaneja os agendamentos futuros da conta.
CREATE OR REPLACE FUNCTION private.agenda_reminders_settings_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT e.id FROM public.calendar_events e
     WHERE e.account_id = NEW.account_id AND e.service_id IS NOT NULL
       AND (e.starts_at > now() OR EXISTS (
              SELECT 1 FROM public.agenda_reminders x WHERE x.event_id = e.id AND x.state = 'pending'))
  LOOP
    PERFORM private.agenda_reminders_plan(r.id);
  END LOOP;
  RETURN NULL;
END;
$$;
ALTER FUNCTION private.agenda_reminders_settings_trg() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.agenda_reminders_settings_trg() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS agenda_reminder_settings_replan ON public.agenda_reminder_settings;
CREATE TRIGGER agenda_reminder_settings_replan
  AFTER INSERT OR UPDATE OF enabled, first_offset_minutes, second_offset_minutes ON public.agenda_reminder_settings
  FOR EACH ROW EXECUTE FUNCTION private.agenda_reminders_settings_trg();

-- ---- grants + RLS ---------------------------------------------------------
-- settings: membro lê, admin+ escreve (096); conta somente-leitura não escreve (094).
-- agenda_reminders: membro lê; ninguém escreve por PostgREST (só trigger / RPC / cron).
-- Same policy set as the 096 tables (built with format(), one loop for the tables a user can write).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['agenda_reminder_settings'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (is_account_member(account_id))', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (is_account_member(account_id, ''admin''))', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (is_account_member(account_id, ''admin'')) WITH CHECK (is_account_member(account_id, ''admin''))', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (is_account_member(account_id, ''admin''))', t || '_delete', t);

    -- 094: conta somente-leitura não escreve (SELECT nunca é tocado).
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_readonly_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (private.account_is_writable(account_id))', t || '_readonly_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_readonly_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id))', t || '_readonly_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_readonly_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated USING (private.account_is_writable(account_id))', t || '_readonly_delete', t);
  END LOOP;
END;
$$;

ALTER TABLE public.agenda_reminders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agenda_reminders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.agenda_reminders TO authenticated;
GRANT ALL ON TABLE public.agenda_reminders TO service_role;
DROP POLICY IF EXISTS agenda_reminders_select ON public.agenda_reminders;
CREATE POLICY agenda_reminders_select ON public.agenda_reminders FOR SELECT USING (is_account_member(account_id));

-- ---- 7. tipo de evento da conversa -----------------------------------------
ALTER TABLE public.conversation_events DROP CONSTRAINT IF EXISTS conversation_events_event_type_check;
ALTER TABLE public.conversation_events ADD CONSTRAINT conversation_events_event_type_check
  CHECK (
    event_type IN (
      'assigned', 'unassigned', 'status_changed', 'label_added', 'label_removed', 'note_added',
      'contact_opted_out', 'contact_opted_in', 'ai_handoff', 'ai_paused', 'ai_resumed',
      'deal_stage_changed', 'category_changed', 'priority_changed', 'resolution_set',
      'sla_warning', 'sla_breached', 'team_changed', 'csat_sent', 'csat_answered',
      'snoozed', 'unsnoozed', 'agenda_reply'
    )
  ) NOT VALID;
ALTER TABLE public.conversation_events VALIDATE CONSTRAINT conversation_events_event_type_check;

-- ---- 6. RPCs de agendamento com encaixe ------------------------------------
-- As assinaturas antigas saem; só o app novo chama (service_role).
DROP FUNCTION IF EXISTS public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.agenda_reschedule_appointment(uuid, uuid, timestamptz, uuid);

-- agenda_book_appointment — igual a 096 + p_override (encaixe): AG011 se a origem
-- não for 'agent' (a IA e a API pública nunca fazem encaixe).
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
  p_actor UUID DEFAULT NULL,
  p_override BOOLEAN DEFAULT false
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

  -- Encaixe: só pessoa (origem 'agent') e com ator identificado.
  IF p_override AND (p_source <> 'agent' OR v_actor IS NULL) THEN
    RAISE EXCEPTION 'agenda_override_forbidden' USING ERRCODE = 'AG011';
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
      created_by, service_id, resource_id, booking_source, idempotency_key, booking_override
    ) VALUES (
      p_account_id, v_owner,
      left(v_svc.name || CASE WHEN v_contact <> '' THEN ' — ' || v_contact ELSE '' END, 200),
      NULLIF(btrim(p_notes), ''), COALESCE(v_svc.color, v_res.color),
      p_starts_at, v_end, p_status, p_contact_id, p_conversation_id,
      v_actor, p_service_id, p_resource_id, p_source, p_idempotency_key, COALESCE(p_override, false)
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

-- agenda_reschedule_appointment — igual a 096 + p_override / p_source.
CREATE OR REPLACE FUNCTION public.agenda_reschedule_appointment(
  p_account_id UUID,
  p_event_id UUID,
  p_starts_at TIMESTAMPTZ,
  p_resource_id UUID DEFAULT NULL,
  p_override BOOLEAN DEFAULT false,
  p_source TEXT DEFAULT 'agent'
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

  IF p_override AND p_source <> 'agent' THEN
    RAISE EXCEPTION 'agenda_override_forbidden' USING ERRCODE = 'AG011';
  END IF;

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
           owner_user_id = COALESCE(private.agenda_owner_for(p_account_id, v_res.user_id, NULL), v_ev.owner_user_id),
           booking_override = booking_override OR COALESCE(p_override, false)
     WHERE id = p_event_id
     RETURNING * INTO v_row;
  EXCEPTION
    WHEN exclusion_violation THEN
      RAISE EXCEPTION 'agenda_slot_taken' USING ERRCODE = 'AG001';
  END;
  RETURN v_row;
END;
$$;

-- ---- 5. resposta do cliente ao lembrete --------------------------------------
-- Atômica: marca o lembrete (e os outros já enviados para o mesmo horário), grava
-- a resposta no agendamento e, se confirmou, passa de 'scheduled' para 'confirmed'
-- pela mesma RPC de status. AG009: nada aguardando resposta (já respondido, horário
-- mudou, agendamento encerrado ou já começou).
CREATE OR REPLACE FUNCTION public.agenda_reminder_respond(
  p_account_id UUID,
  p_reminder_id UUID,
  p_action TEXT
) RETURNS public.calendar_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rem public.agenda_reminders;
  v_ev  public.calendar_events;
  v_row public.calendar_events;
BEGIN
  PERFORM private.agenda_assert_caller(p_account_id);
  IF p_action NOT IN ('confirmed', 'reschedule_requested') THEN
    RAISE EXCEPTION 'agenda_bad_status' USING ERRCODE = 'AG008';
  END IF;

  SELECT * INTO v_rem FROM public.agenda_reminders
   WHERE id = p_reminder_id AND account_id = p_account_id AND state = 'sent' AND response IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agenda_appointment_not_found' USING ERRCODE = 'AG009';
  END IF;

  SELECT * INTO v_ev FROM public.calendar_events
   WHERE id = v_rem.event_id AND account_id = p_account_id AND service_id IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR v_ev.status NOT IN ('scheduled', 'confirmed')
     OR v_ev.starts_at <= now() OR v_ev.starts_at <> v_rem.for_starts_at THEN
    RAISE EXCEPTION 'agenda_appointment_not_found' USING ERRCODE = 'AG009';
  END IF;

  IF p_action = 'confirmed' AND v_ev.status = 'scheduled' THEN
    PERFORM public.agenda_set_appointment_status(p_account_id, v_ev.id, 'confirmed');
  END IF;

  UPDATE public.agenda_reminders
     SET response = p_action, responded_at = now(), updated_at = now()
   WHERE event_id = v_ev.id AND for_starts_at = v_ev.starts_at AND state = 'sent' AND response IS NULL;

  UPDATE public.calendar_events
     SET customer_response = p_action, customer_responded_at = now()
   WHERE id = v_ev.id
   RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- ---- cron: claim atômico -----------------------------------------------------
-- pending -> sending num único comando (FOR UPDATE SKIP LOCKED): ticks sobrepostos
-- dividem as linhas e uma linha reivindicada nunca é reivindicada de novo. Linha presa
-- em 'sending' há 10 min (worker caiu) vira 'failed'/'maybe_sent': pode ter saído, NÃO
-- reenvia. Devolução por 'throttled' volta a 'pending' com next_try_at (o app faz).
CREATE OR REPLACE FUNCTION public.agenda_reminders_claim(
  p_now   TIMESTAMPTZ DEFAULT clock_timestamp(),
  p_limit INTEGER     DEFAULT 25
) RETURNS SETOF public.agenda_reminders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.agenda_reminders
     SET state = 'failed', reason = 'maybe_sent',
         error_text = 'Pode ter sido enviado — confira a conversa.',
         updated_at = clock_timestamp()
   WHERE state = 'sending' AND claimed_at < clock_timestamp() - interval '10 minutes';

  RETURN QUERY
  WITH due AS (
    SELECT r.id FROM public.agenda_reminders r
     WHERE r.state = 'pending' AND COALESCE(r.next_try_at, r.due_at) <= p_now
     ORDER BY r.due_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 200))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.agenda_reminders m
     SET state = 'sending', claimed_at = clock_timestamp(), attempts = m.attempts + 1,
         updated_at = clock_timestamp()
    FROM due
   WHERE m.id = due.id
  RETURNING m.*;
END;
$$;

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid, boolean)',
    'public.agenda_reschedule_appointment(uuid, uuid, timestamptz, uuid, boolean, text)',
    'public.agenda_reminder_respond(uuid, uuid, text)',
    'public.agenda_reminders_claim(timestamptz, integer)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;

COMMIT;
