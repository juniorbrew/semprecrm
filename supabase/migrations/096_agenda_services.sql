-- ============================================================
-- 096 — Agenda inteligente, entrega A: serviços, profissionais/recursos,
-- horários e agendamento atômico.
--
-- Spec: docs/superpowers/specs/2026-10-24-agenda-inteligente.md
--
-- O agendamento É um `calendar_events` (040): ganha service_id,
-- resource_id, booking_source e idempotency_key. Nada de tabela paralela:
-- Google/Outlook, push, realtime e o painel da conversa continuam valendo.
--
--   1. agenda_services          serviço (duração, preço, folgas antes/depois)
--   2. agenda_resources         profissional (liga a um membro) ou sala
--   3. agenda_resource_services quais recursos executam quais serviços
--   4. agenda_working_hours     horário semanal (vários intervalos por dia)
--   5. agenda_exceptions        folga do dia / horário extra numa data
--   6. agenda_settings          regras da conta (antecedência, janela, passo)
--   7. calendar_events          + colunas, status ampliado e a GARANTIA de
--      não sobreposição por recurso: EXCLUDE USING gist em
--      (resource_id, tstzrange(block_starts_at, block_ends_at)). O bloco é o
--      horário + folga antes/depois, calculado por trigger — vale para
--      qualquer caminho de escrita (RPC, PostgREST, service_role).
--   8. RPCs SECURITY DEFINER (search_path fixo, EXECUTE só para service_role —
--      o servidor valida sessão/papel/módulo/horário e chama; usuário logado não
--      chama direto, então não há como pular as regras de horário e antecedência;
--      regra 076):
--      agenda_book_appointment / agenda_reschedule_appointment /
--      agenda_set_appointment_status. Travam a linha do recurso (FOR UPDATE),
--      conferem a agenda do profissional (eventos comuns = tempo ocupado) e
--      traduzem a violação da exclusão em 'agenda_slot_taken'.
--
-- Horário de atendimento, antecedência mínima e janela máxima são validados
-- no servidor (src/lib/agenda/availability.ts), com o fuso da conta — o
-- banco garante o que não pode falhar nunca: dois agendamentos no mesmo
-- recurso e horário.
--
-- Escritas diretas de usuário com conta somente-leitura (094) são barradas por
-- políticas RESTRICTIVE; as RPCs conferem private.account_is_writable sempre.
-- Acesso: TODA mudança de agendamento (criar, remarcar, status, cancelar) passa
-- por /api/agenda/appointments -> RPC service-role (agent+ da conta, validado no
-- servidor). Usuário não escreve em service_id / resource_id / horário / status
-- de agendamento (trigger calendar_events_agenda_guard); a política de UPDATE de
-- 040 (dono/criador/admin) segue valendo só para o resto do evento.
-- Verificar num Postgres real: supabase/tests/agenda_booking.sql (termina em
-- ROLLBACK). Reverter: supabase/rollback/096_rollback.sql.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ============================================================
-- Tabelas
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agenda_services (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 120),
  description           TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
  duration_minutes      INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 1440),
  price_cents           INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  buffer_before_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 240),
  buffer_after_minutes  INTEGER NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 240),
  color                 TEXT CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_agenda_services_account ON public.agenda_services(account_id, sort_order, name);

CREATE TABLE IF NOT EXISTS public.agenda_resources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 120),
  kind        TEXT NOT NULL DEFAULT 'professional' CHECK (kind IN ('professional', 'room', 'other')),
  -- Membro da equipe que atende (opcional). O agendamento vai para a agenda
  -- dele (owner_user_id) e os eventos comuns dele contam como tempo ocupado.
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  color       TEXT CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$'),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_agenda_resources_account ON public.agenda_resources(account_id, sort_order, name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agenda_resources_user
  ON public.agenda_resources(account_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.agenda_resource_services (
  resource_id UUID NOT NULL,
  service_id  UUID NOT NULL,
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (resource_id, service_id),
  FOREIGN KEY (resource_id, account_id) REFERENCES public.agenda_resources(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (service_id, account_id)  REFERENCES public.agenda_services(id, account_id)  ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agenda_resource_services_service ON public.agenda_resource_services(service_id);

-- weekday: 0 = domingo … 6 = sábado (igual a Date#getDay). Minutos desde
-- 00:00 no fuso da conta. Intervalos de um mesmo dia não se sobrepõem.
CREATE TABLE IF NOT EXISTS public.agenda_working_hours (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  resource_id  UUID NOT NULL,
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute INTEGER NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   INTEGER NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (end_minute > start_minute),
  FOREIGN KEY (resource_id, account_id) REFERENCES public.agenda_resources(id, account_id) ON DELETE CASCADE,
  EXCLUDE USING gist (
    resource_id WITH =, weekday WITH =, int4range(start_minute, end_minute) WITH &&
  )
);
CREATE INDEX IF NOT EXISTS idx_agenda_working_hours_resource ON public.agenda_working_hours(resource_id, weekday);

-- day_off: o dia todo fechado. extra_hours: intervalo a mais naquela data.
CREATE TABLE IF NOT EXISTS public.agenda_exceptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  resource_id  UUID NOT NULL,
  on_date      DATE NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('day_off', 'extra_hours')),
  start_minute INTEGER CHECK (start_minute IS NULL OR start_minute BETWEEN 0 AND 1439),
  end_minute   INTEGER CHECK (end_minute IS NULL OR end_minute BETWEEN 1 AND 1440),
  note         TEXT CHECK (note IS NULL OR char_length(note) <= 200),
  CHECK (
    (kind = 'day_off' AND start_minute IS NULL AND end_minute IS NULL)
    OR (kind = 'extra_hours' AND start_minute IS NOT NULL AND end_minute IS NOT NULL AND end_minute > start_minute)
  ),
  FOREIGN KEY (resource_id, account_id) REFERENCES public.agenda_resources(id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agenda_exceptions_resource ON public.agenda_exceptions(resource_id, on_date);

CREATE TABLE IF NOT EXISTS public.agenda_settings (
  account_id           UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  min_notice_minutes   INTEGER NOT NULL DEFAULT 120 CHECK (min_notice_minutes BETWEEN 0 AND 43200),
  max_days_ahead       INTEGER NOT NULL DEFAULT 60 CHECK (max_days_ahead BETWEEN 1 AND 365),
  slot_step_minutes    INTEGER NOT NULL DEFAULT 30 CHECK (slot_step_minutes IN (5, 10, 15, 20, 30, 60)),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_updated_at ON public.agenda_services;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.agenda_services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.agenda_resources;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.agenda_resources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON public.agenda_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.agenda_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- O membro ligado a um recurso tem de ser da mesma conta.
CREATE OR REPLACE FUNCTION public.agenda_resources_check_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.user_id = NEW.user_id AND p.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'agenda_resource_user_not_member' USING ERRCODE = 'AG007';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.agenda_resources_check_user() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS agenda_resources_check_user ON public.agenda_resources;
CREATE TRIGGER agenda_resources_check_user BEFORE INSERT OR UPDATE OF user_id, account_id ON public.agenda_resources
  FOR EACH ROW EXECUTE FUNCTION public.agenda_resources_check_user();

-- ============================================================
-- calendar_events: o agendamento
-- ============================================================
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS service_id      UUID;
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS resource_id     UUID;
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS booking_source  TEXT;
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
-- Janela ocupada do recurso = horário ± folgas do serviço (preenchida por trigger).
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS block_starts_at TIMESTAMPTZ;
ALTER TABLE public.calendar_events ADD COLUMN IF NOT EXISTS block_ends_at   TIMESTAMPTZ;

-- Mesma conta garantida pela FK composta (MATCH SIMPLE: NULL não confere).
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_service_fk;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_service_fk
  FOREIGN KEY (service_id, account_id) REFERENCES public.agenda_services(id, account_id) ON DELETE RESTRICT;
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_resource_fk;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_resource_fk
  FOREIGN KEY (resource_id, account_id) REFERENCES public.agenda_resources(id, account_id) ON DELETE RESTRICT;

ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_booking_source_check;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_booking_source_check
  CHECK (booking_source IS NULL OR booking_source IN ('agent', 'ai', 'api'));

-- 'confirmed' continua sendo o evento comum; 'scheduled' = agendado, aguardando confirmação.
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_status_check;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_status_check
  CHECK (status IN ('scheduled', 'confirmed', 'cancelled', 'no_show', 'completed'));

CREATE INDEX IF NOT EXISTS idx_calendar_events_resource_starts
  ON public.calendar_events(resource_id, starts_at) WHERE resource_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_events_service ON public.calendar_events(service_id) WHERE service_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_events_idempotency
  ON public.calendar_events(account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.calendar_events_agenda_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_before INTEGER := 0;
  v_after  INTEGER := 0;
BEGIN
  IF NEW.resource_id IS NULL THEN
    NEW.block_starts_at := NULL;
    NEW.block_ends_at := NULL;
    RETURN NEW;
  END IF;
  IF NEW.service_id IS NOT NULL THEN
    SELECT s.buffer_before_minutes, s.buffer_after_minutes
      INTO v_before, v_after
      FROM public.agenda_services s
     WHERE s.id = NEW.service_id AND s.account_id = NEW.account_id;
  END IF;
  NEW.block_starts_at := NEW.starts_at - make_interval(mins => COALESCE(v_before, 0));
  NEW.block_ends_at   := NEW.ends_at   + make_interval(mins => COALESCE(v_after, 0));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.calendar_events_agenda_block() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS calendar_events_agenda_block ON public.calendar_events;
CREATE TRIGGER calendar_events_agenda_block
  BEFORE INSERT OR UPDATE ON public.calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.calendar_events_agenda_block();

-- block_* e a exclusão valem para qualquer escrita: o trigger roda em TODO
-- INSERT/UPDATE e sempre recalcula (o que o cliente mandar em block_* é descartado).
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_block_check;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_block_check
  CHECK (resource_id IS NULL OR (block_starts_at IS NOT NULL AND block_ends_at IS NOT NULL));

-- Só agendamento (nasce na RPC) ocupa tempo de recurso.
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_resource_needs_service;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_resource_needs_service
  CHECK (resource_id IS NULL OR service_id IS NOT NULL);

-- Só as RPCs (service_role / postgres) criam e mexem em agendamentos. Para um
-- usuário (PostgREST): não pode criar evento com service_id / booking_source /
-- idempotency_key / resource_id, nem alterar essas colunas, nem — em linha que
-- já é agendamento — horário, status, dono, contato, conversa ou bloco.
-- Dono / criador / admin continuam editando o que não é agendamento: título,
-- descrição, local, cor, lembrete, vínculos de negócio/tarefa. Tudo que muda o
-- tempo ocupado passa por /api/agenda/appointments -> RPC. (Excluir a linha
-- continua permitido a dono/criador/admin pela política de 040: libera o
-- horário, não burla nenhuma regra.)
-- SECURITY INVOKER de propósito (current_user precisa ser o chamador); as RPCs
-- rodam como postgres.
CREATE OR REPLACE FUNCTION public.calendar_events_agenda_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT (current_user IN ('authenticated', 'anon') OR auth.uid() IS NOT NULL) THEN
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
    OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
    OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.block_starts_at IS DISTINCT FROM OLD.block_starts_at
    OR NEW.block_ends_at IS DISTINCT FROM OLD.block_ends_at
  ) THEN
    RAISE EXCEPTION 'agenda_use_booking_api' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.calendar_events_agenda_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS calendar_events_agenda_guard ON public.calendar_events;
CREATE TRIGGER calendar_events_agenda_guard
  BEFORE INSERT OR UPDATE ON public.calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.calendar_events_agenda_guard();

-- A garantia: no máximo um agendamento ativo por recurso em cada instante.
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_resource_no_overlap;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_resource_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(block_starts_at, block_ends_at) WITH &&
  ) WHERE (resource_id IS NOT NULL AND status IN ('scheduled', 'confirmed', 'completed'));

-- ============================================================
-- Grants + RLS
--   leitura: qualquer membro; configuração: admin+. Agendar passa pelas RPCs
--   (ou pelo editor de eventos existente, que respeita a exclusão acima).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agenda_services', 'agenda_resources', 'agenda_resource_services',
    'agenda_working_hours', 'agenda_exceptions', 'agenda_settings'
  ] LOOP
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

-- ============================================================
-- Helper: o profissional já tem outro evento nesse horário?
-- (eventos comuns da agenda dele; agendamentos de recurso são cobertos pela
-- exclusão). Chamado só de dentro das RPCs abaixo.
-- ============================================================
CREATE OR REPLACE FUNCTION private.agenda_user_busy(
  p_account_id UUID,
  p_user_id UUID,
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_exclude_event UUID DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.calendar_events e
     WHERE e.account_id = p_account_id
       AND e.owner_user_id = p_user_id
       AND e.resource_id IS NULL
       AND e.status IN ('scheduled', 'confirmed')
       AND NOT e.all_day
       AND e.starts_at < p_to
       AND e.ends_at > p_from
       AND e.id IS DISTINCT FROM p_exclude_event
  );
$$;
REVOKE ALL ON FUNCTION private.agenda_user_busy(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;

-- Quem chama: as RPCs são executáveis SÓ pelo service_role (o servidor, depois de
-- autenticar a sessão, checar papel agent+, módulo e conta gravável; e a IA).
-- A conta tem de estar gravável SEMPRE (inclusive para service_role) e, se algum
-- dia um usuário logado chegar aqui, precisa ser agent+ da conta.
CREATE OR REPLACE FUNCTION private.agenda_assert_caller(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT is_account_member(p_account_id, 'agent') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF NOT private.account_is_writable(p_account_id) THEN
    RAISE EXCEPTION 'read_only_account: this account is read-only (trial ended or payment overdue)'
      USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION private.agenda_assert_caller(UUID) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- agenda_book_appointment
-- Erros (message): agenda_resource_unavailable (AG003), agenda_service_unavailable
-- (AG003), agenda_service_not_offered (AG002), agenda_contact_not_found (AG004),
-- agenda_busy (AG005), agenda_slot_taken (AG001), agenda_bad_status (AG008).
-- Idempotente por (account_id, idempotency_key): repetir devolve o mesmo evento.
-- ============================================================
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
    IF FOUND THEN RETURN v_row; END IF;
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
      p_account_id, COALESCE(v_res.user_id, v_actor),
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
           owner_user_id = COALESCE(v_res.user_id, v_ev.owner_user_id)
     WHERE id = p_event_id
     RETURNING * INTO v_row;
  EXCEPTION
    WHEN exclusion_violation THEN
      RAISE EXCEPTION 'agenda_slot_taken' USING ERRCODE = 'AG001';
  END;
  RETURN v_row;
END;
$$;

-- ============================================================
-- agenda_set_appointment_status — confirmar, cancelar, concluir, faltou.
-- Reabrir (cancelado/faltou -> agendado/confirmado) refaz a checagem de conflito.
-- ============================================================
CREATE OR REPLACE FUNCTION public.agenda_set_appointment_status(
  p_account_id UUID,
  p_event_id UUID,
  p_status TEXT
) RETURNS public.calendar_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ev   public.calendar_events;
  v_res  public.agenda_resources;
  v_svc  public.agenda_services;
  v_row  public.calendar_events;
BEGIN
  PERFORM private.agenda_assert_caller(p_account_id);

  IF p_status NOT IN ('scheduled', 'confirmed', 'cancelled', 'no_show', 'completed') THEN
    RAISE EXCEPTION 'agenda_bad_status' USING ERRCODE = 'AG008';
  END IF;

  SELECT * INTO v_ev FROM public.calendar_events
   WHERE id = p_event_id AND account_id = p_account_id AND service_id IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agenda_appointment_not_found' USING ERRCODE = 'AG009';
  END IF;

  IF p_status IN ('scheduled', 'confirmed') AND v_ev.status IN ('cancelled', 'no_show') THEN
    SELECT * INTO v_res FROM public.agenda_resources WHERE id = v_ev.resource_id FOR UPDATE;
    SELECT * INTO v_svc FROM public.agenda_services WHERE id = v_ev.service_id;
    IF private.agenda_user_busy(
         p_account_id, v_res.user_id,
         v_ev.starts_at - make_interval(mins => v_svc.buffer_before_minutes),
         v_ev.ends_at + make_interval(mins => v_svc.buffer_after_minutes),
         p_event_id
       ) THEN
      RAISE EXCEPTION 'agenda_busy' USING ERRCODE = 'AG005';
    END IF;
  END IF;

  BEGIN
    UPDATE public.calendar_events SET status = p_status WHERE id = p_event_id RETURNING * INTO v_row;
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
    'public.agenda_reschedule_appointment(uuid, uuid, timestamptz, uuid)',
    'public.agenda_set_appointment_status(uuid, uuid, text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$$;

-- Os helpers de private.* rodam dentro das RPCs (definer = postgres).
ALTER FUNCTION private.agenda_user_busy(UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) OWNER TO postgres;
ALTER FUNCTION private.agenda_assert_caller(UUID) OWNER TO postgres;

COMMIT;
