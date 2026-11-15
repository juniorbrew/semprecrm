-- ============================================================
-- 114 — Página de agendamento: o cliente marca sozinho pelo link
-- (módulo hora marcada, parte 1; spec docs/superpowers/specs/2026-11-15-agendamento-pelo-cliente.md).
--
--   * Módulo novo `booking_page` (exige `calendar`, checado no servidor). Entra em
--     valid_plan_definition e platform_update_account_v2 (cópias da 101 só com o
--     nome novo). trial, pro e empresa ganham o módulo (nova revisão, igual à 101).
--   * booking_pages: uma página por conta (endereço público, textos, regras).
--     Membros leem, admin escreve, anon nada. O público só chega pelo servidor.
--   * booking_phone_checks: confirmação do celular. O cliente MANDA o código para
--     a empresa pelo WhatsApp; a entrada de mensagens confere conta + código +
--     validade + uso único + tentativas + o telefone REAL do remetente igual ao
--     digitado. Só service role.
--   * calendar_events.booking_source aceita 'client' (agenda_book_appointment da
--     097 copiada só com a lista nova). Reagendar não precisa mudar.
--
-- Keep the lists in sync with OPTIONAL_MODULES in src/lib/plans.ts.
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.valid_plan_definition(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE item jsonb; key text; capacity jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
     OR NOT value ?& ARRAY['modules','limits']
     OR value - ARRAY['modules','limits'] <> '{}'
     OR jsonb_typeof(value->'modules') IS DISTINCT FROM 'array'
     OR jsonb_typeof(value->'limits') IS DISTINCT FROM 'object'
     OR NOT (value->'limits') ?& ARRAY['max_users','max_channels']
     OR (value->'limits') - ARRAY['max_users','max_channels'] <> '{}' THEN
    RETURN false;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value->'modules') LOOP
    IF jsonb_typeof(item) <> 'string' OR NOT (item #>> '{}') = ANY(ARRAY[
      'dashboard','pipelines','tasks','broadcasts','automations','flows',
      'channel_official','channel_qr','lead_capture','white_label','internal_chat','calendar','ai',
      'reports','api','support','ai_actions','channel_instagram','channel_messenger','booking_page'
    ]) THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(*) <> count(DISTINCT x) FROM jsonb_array_elements(value->'modules') x)
     THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['max_users','max_channels'] LOOP
    capacity := value->'limits'->key;
    IF capacity <> 'null'::jsonb THEN
      IF jsonb_typeof(capacity) <> 'number' THEN RETURN false; END IF;
      IF (capacity #>> '{}')::numeric < 0 OR (capacity #>> '{}')::numeric > 9007199254740991
         OR trunc((capacity #>> '{}')::numeric) <> (capacity #>> '{}')::numeric
         THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.valid_plan_definition(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.valid_plan_definition(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.platform_update_account_v2(
  p_account_id UUID,
  p_patch JSONB,
  p_actor_user_id UUID,
  p_expected_version_id UUID DEFAULT NULL,
  p_adopt_current BOOLEAN DEFAULT false
) RETURNS accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row     accounts;
  v_before accounts; v_pointer uuid; v_actor_name text;
  v_changes jsonb := '{}'::jsonb; v_metadata jsonb := '{}'::jsonb;
  v_old_version public.platform_plan_versions; v_new_version public.platform_plan_versions; v_old_modules jsonb; v_new_modules jsonb;
  v_key     TEXT;
  v_val     JSONB;
  v_allowed_modules TEXT[] := ARRAY[
    'dashboard', 'pipelines', 'tasks', 'broadcasts', 'automations', 'flows',
    'channel_official', 'channel_qr', 'lead_capture', 'white_label', 'internal_chat',
    'calendar', 'ai', 'reports', 'api', 'support', 'ai_actions', 'channel_instagram', 'channel_messenger', 'booking_page'
  ];
  v_allowed_limits TEXT[] := ARRAY['max_users', 'max_channels'];
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.platform_admins WHERE user_id=p_actor_user_id) THEN
    RAISE EXCEPTION 'Platform admin only' USING ERRCODE = '42501';
  END IF;

  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be a JSON object' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM accounts WHERE id = p_account_id FOR UPDATE;
  v_before := v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = '22023';
  END IF;

  -- plan --------------------------------------------------------
  IF p_patch ? 'plan' THEN
    IF jsonb_typeof(p_patch->'plan') <> 'string'
       OR (p_patch->>'plan') NOT IN ('trial', 'basico', 'pro', 'empresa') THEN
      RAISE EXCEPTION 'plan must be one of trial, basico, pro, empresa'
        USING ERRCODE = '22023';
    END IF;
    v_row.plan := p_patch->>'plan';
  END IF;

  -- plan_status -------------------------------------------------
  IF p_patch ? 'plan_status' THEN
    IF jsonb_typeof(p_patch->'plan_status') <> 'string'
       OR (p_patch->>'plan_status') NOT IN ('trial', 'active', 'past_due', 'canceled', 'suspended') THEN
      RAISE EXCEPTION 'plan_status must be one of trial, active, past_due, canceled, suspended'
        USING ERRCODE = '22023';
    END IF;
    v_row.plan_status := p_patch->>'plan_status';
  END IF;

  -- plan_expires_at (null clears) --------------------------------
  IF p_patch ? 'plan_expires_at' THEN
    IF jsonb_typeof(p_patch->'plan_expires_at') = 'null' THEN
      v_row.plan_expires_at := NULL;
    ELSIF jsonb_typeof(p_patch->'plan_expires_at') = 'string' THEN
      BEGIN
        v_row.plan_expires_at := (p_patch->>'plan_expires_at')::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'plan_expires_at must be an ISO-8601 timestamp or null'
          USING ERRCODE = '22023';
      END;
    ELSE
      RAISE EXCEPTION 'plan_expires_at must be an ISO-8601 timestamp or null'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- module_overrides: {module: boolean} over the known modules ---
  IF p_patch ? 'module_overrides' THEN
    v_val := p_patch->'module_overrides';
    IF v_val IS NULL OR jsonb_typeof(v_val) <> 'object' THEN
      RAISE EXCEPTION 'module_overrides must be a JSON object' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_val) LOOP
      IF NOT (v_key = ANY (v_allowed_modules)) THEN
        RAISE EXCEPTION 'Unknown module in module_overrides: %', v_key
          USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(v_val->v_key) <> 'boolean' THEN
        RAISE EXCEPTION 'module_overrides.% must be true or false', v_key
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
    v_row.module_overrides := v_val;
  END IF;

  -- limit_overrides: {max_users|max_channels: int >= 0 | null} ---
  IF p_patch ? 'limit_overrides' THEN
    v_val := p_patch->'limit_overrides';
    IF v_val IS NULL OR jsonb_typeof(v_val) <> 'object' THEN
      RAISE EXCEPTION 'limit_overrides must be a JSON object' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_val) LOOP
      IF NOT (v_key = ANY (v_allowed_limits)) THEN
        RAISE EXCEPTION 'Unknown limit in limit_overrides: %', v_key
          USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(v_val->v_key) NOT IN ('number', 'null') THEN
        RAISE EXCEPTION 'limit_overrides.% must be a number or null', v_key
          USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(v_val->v_key) = 'number'
         AND ((v_val->>v_key)::numeric < 0 OR (v_val->>v_key)::numeric <> floor((v_val->>v_key)::numeric)) THEN
        RAISE EXCEPTION 'limit_overrides.% must be a non-negative integer', v_key
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
    v_row.limit_overrides := v_val;
  END IF;

  -- platform_notes (null clears) ---------------------------------
  IF p_patch ? 'platform_notes' THEN
    IF jsonb_typeof(p_patch->'platform_notes') = 'null' THEN
      v_row.platform_notes := NULL;
    ELSIF jsonb_typeof(p_patch->'platform_notes') = 'string' THEN
      v_row.platform_notes := NULLIF(btrim(p_patch->>'platform_notes'), '');
    ELSE
      RAISE EXCEPTION 'platform_notes must be a string or null' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF p_patch - ARRAY['plan','plan_status','plan_expires_at','module_overrides','limit_overrides','platform_notes'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Unknown account field' USING ERRCODE='22023';
  END IF;
  IF p_adopt_current IS NULL THEN RAISE EXCEPTION 'Invalid adoption flag' USING ERRCODE='22023'; END IF;
  IF v_before.plan IS DISTINCT FROM v_row.plan OR p_adopt_current THEN
    SELECT current_version_id INTO v_pointer FROM public.platform_plan_catalog WHERE plan=v_row.plan FOR SHARE;
    IF v_pointer IS NULL OR v_pointer IS DISTINCT FROM p_expected_version_id THEN
      RAISE EXCEPTION 'Plan changed; reload current terms' USING ERRCODE='40001';
    END IF;
    v_row.plan_version_id := v_pointer;
  END IF;


  UPDATE accounts
  SET plan_version_id  = v_row.plan_version_id,
      plan             = v_row.plan,
      plan_status      = v_row.plan_status,
      plan_expires_at  = v_row.plan_expires_at,
      module_overrides = v_row.module_overrides,
      limit_overrides  = v_row.limit_overrides,
      platform_notes   = v_row.platform_notes
  WHERE id = p_account_id
  RETURNING * INTO v_row;

  FOREACH v_key IN ARRAY ARRAY['plan','plan_status','plan_expires_at','module_overrides','limit_overrides'] LOOP
    IF to_jsonb(v_before)->v_key IS DISTINCT FROM to_jsonb(v_row)->v_key THEN
      v_changes := v_changes || jsonb_build_object(v_key,jsonb_build_object('from',to_jsonb(v_before)->v_key,'to',to_jsonb(v_row)->v_key));
    END IF;
  END LOOP;
  IF v_before.plan_version_id IS DISTINCT FROM v_row.plan_version_id THEN
    SELECT * INTO v_old_version FROM public.platform_plan_versions WHERE id=v_before.plan_version_id;
    SELECT * INTO v_new_version FROM public.platform_plan_versions WHERE id=v_row.plan_version_id;
    v_metadata := jsonb_build_object('plan_version_change', jsonb_build_object('from_revision',v_old_version.revision,'to_revision',v_new_version.revision));
    SELECT jsonb_object_agg(m,coalesce(v_before.module_overrides->m,to_jsonb(v_old_version.definition->'modules' ? m))) INTO v_old_modules FROM unnest(v_allowed_modules) m;
    SELECT jsonb_object_agg(m,coalesce(v_row.module_overrides->m,to_jsonb(v_new_version.definition->'modules' ? m))) INTO v_new_modules FROM unnest(v_allowed_modules) m;
    IF v_old_modules IS DISTINCT FROM v_new_modules THEN
      v_changes := v_changes || jsonb_build_object('module_overrides',jsonb_build_object('from',v_old_modules,'to',v_new_modules));
    END IF;
    IF (v_old_version.definition->'limits' || v_before.limit_overrides) IS DISTINCT FROM (v_new_version.definition->'limits' || v_row.limit_overrides) THEN
      v_changes := v_changes || jsonb_build_object('limit_overrides',jsonb_build_object('from',v_old_version.definition->'limits' || v_before.limit_overrides,'to',v_new_version.definition->'limits' || v_row.limit_overrides));
    END IF;
  END IF;
  IF v_changes <> '{}'::jsonb OR v_metadata <> '{}'::jsonb THEN
    SELECT coalesce(nullif(btrim(full_name),''),email,'Administrador') INTO v_actor_name FROM public.profiles WHERE user_id=p_actor_user_id;
    INSERT INTO public.audit_log(account_id,actor_user_id,actor_name,action,entity_type,entity_id,metadata)
    VALUES (p_account_id,p_actor_user_id,coalesce(v_actor_name,'Administrador') || ' (platform)','plan.changed','plan',p_account_id,v_metadata || jsonb_build_object('changes',v_changes));
  END IF;


  RETURN v_row;
END;
$$;

ALTER FUNCTION public.platform_update_account_v2(UUID,JSONB,UUID,UUID,BOOLEAN) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.platform_update_account_v2(UUID,JSONB,UUID,UUID,BOOLEAN) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.platform_update_account_v2(UUID,JSONB,UUID,UUID,BOOLEAN) TO service_role;

-- ---- Origem 'client' ---------------------------------------------------------
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_booking_source_check;
ALTER TABLE public.calendar_events ADD CONSTRAINT calendar_events_booking_source_check
  CHECK (booking_source IS NULL OR booking_source IN ('agent', 'ai', 'api', 'client'));

-- agenda_book_appointment — igual à 097, só aceita p_source 'client'.
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

  IF p_status NOT IN ('scheduled', 'confirmed') OR p_source NOT IN ('agent', 'ai', 'api', 'client') THEN
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

ALTER FUNCTION public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid, boolean) TO service_role;

-- ---- booking_client_book ---------------------------------------------------------
-- The booking page's own limit ("até N horários futuros por cliente") must hold
-- under parallel requests: one lock per contact, count and book in the same
-- transaction. Everything else is agenda_book_appointment unchanged.
CREATE OR REPLACE FUNCTION public.booking_client_book(
  p_account_id UUID,
  p_service_id UUID,
  p_resource_id UUID,
  p_contact_id UUID,
  p_starts_at TIMESTAMPTZ,
  p_max_future INTEGER,
  p_idempotency_key TEXT
) RETURNS public.calendar_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_open INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('booking-client:' || p_contact_id::text, 0));
  SELECT count(*) INTO v_open FROM public.calendar_events
   WHERE account_id = p_account_id AND contact_id = p_contact_id AND service_id IS NOT NULL
     AND status IN ('scheduled', 'confirmed') AND ends_at >= now()
     AND idempotency_key IS DISTINCT FROM p_idempotency_key;
  IF v_open >= p_max_future THEN
    RAISE EXCEPTION 'booking_client_limit' USING ERRCODE = 'AG012';
  END IF;
  RETURN public.agenda_book_appointment(
    p_account_id, p_service_id, p_resource_id, p_contact_id, p_starts_at,
    NULL, 'client', NULL, p_idempotency_key, 'scheduled', NULL, false);
END;
$$;
ALTER FUNCTION public.booking_client_book(uuid, uuid, uuid, uuid, timestamptz, integer, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.booking_client_book(uuid, uuid, uuid, uuid, timestamptz, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_client_book(uuid, uuid, uuid, uuid, timestamptz, integer, text) TO service_role;

-- ---- booking_pages -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.booking_pages (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             UUID NOT NULL UNIQUE REFERENCES public.accounts(id) ON DELETE CASCADE,
  slug                   TEXT NOT NULL,
  enabled                BOOLEAN NOT NULL DEFAULT false,
  title                  TEXT,
  intro                  TEXT,
  -- Número do WhatsApp conectado que recebe o código (wa.me). Só dígitos com DDI.
  whatsapp_number        TEXT,
  show_prices            BOOLEAN NOT NULL DEFAULT true,
  -- NULL = todos os serviços / profissionais ativos da agenda.
  service_ids            UUID[],
  resource_ids           UUID[],
  -- NULL = usa a regra da agenda. Valem as duas: a mais rígida ganha.
  min_notice_minutes     INTEGER,
  max_days_ahead         INTEGER,
  max_future_per_contact INTEGER NOT NULL DEFAULT 2,
  allow_cancel           BOOLEAN NOT NULL DEFAULT true,
  allow_reschedule       BOOLEAN NOT NULL DEFAULT true,
  change_limit_hours     INTEGER NOT NULL DEFAULT 2,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_pages_slug_check CHECK (slug ~ '^[a-z0-9](-?[a-z0-9])+$' AND length(slug) BETWEEN 3 AND 40),
  CONSTRAINT booking_pages_title_check CHECK (title IS NULL OR length(title) <= 80),
  CONSTRAINT booking_pages_intro_check CHECK (intro IS NULL OR length(intro) <= 500),
  CONSTRAINT booking_pages_whatsapp_check CHECK (whatsapp_number IS NULL OR whatsapp_number ~ '^[1-9][0-9]{9,14}$'),
  CONSTRAINT booking_pages_notice_check CHECK (min_notice_minutes IS NULL OR min_notice_minutes BETWEEN 0 AND 43200),
  CONSTRAINT booking_pages_days_check CHECK (max_days_ahead IS NULL OR max_days_ahead BETWEEN 1 AND 365),
  CONSTRAINT booking_pages_future_check CHECK (max_future_per_contact BETWEEN 1 AND 10),
  CONSTRAINT booking_pages_change_check CHECK (change_limit_hours BETWEEN 0 AND 720),
  CONSTRAINT booking_pages_lists_check CHECK (
    (service_ids IS NULL OR cardinality(service_ids) <= 200) AND (resource_ids IS NULL OR cardinality(resource_ids) <= 200))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_pages_slug ON public.booking_pages (slug);

DROP TRIGGER IF EXISTS set_updated_at ON public.booking_pages;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.booking_pages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.booking_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_pages_select ON public.booking_pages;
CREATE POLICY booking_pages_select ON public.booking_pages FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS booking_pages_insert ON public.booking_pages;
CREATE POLICY booking_pages_insert ON public.booking_pages FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_pages_update ON public.booking_pages;
CREATE POLICY booking_pages_update ON public.booking_pages FOR UPDATE
  USING (public.is_account_member(account_id, 'admin')) WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS booking_pages_delete ON public.booking_pages;
CREATE POLICY booking_pages_delete ON public.booking_pages FOR DELETE USING (public.is_account_member(account_id, 'admin'));
-- 094: conta só leitura não escreve.
DROP POLICY IF EXISTS booking_pages_readonly_insert ON public.booking_pages;
CREATE POLICY booking_pages_readonly_insert ON public.booking_pages AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS booking_pages_readonly_update ON public.booking_pages;
CREATE POLICY booking_pages_readonly_update ON public.booking_pages AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS booking_pages_readonly_delete ON public.booking_pages;
CREATE POLICY booking_pages_readonly_delete ON public.booking_pages AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

REVOKE ALL ON TABLE public.booking_pages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_pages TO authenticated;
GRANT ALL ON TABLE public.booking_pages TO service_role;

-- ---- booking_phone_checks ------------------------------------------------------
-- Vida curta (10 min): apagada ao ser usada; as vencidas somem no próximo pedido.
CREATE TABLE IF NOT EXISTS public.booking_phone_checks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  page_id          UUID NOT NULL REFERENCES public.booking_pages(id) ON DELETE CASCADE,
  code             TEXT NOT NULL CHECK (code ~ '^[0-9]{6}$'),
  -- Celular digitado (só dígitos com DDI): comparado com o remetente real.
  phone            TEXT NOT NULL CHECK (phone ~ '^[1-9][0-9]{9,14}$'),
  name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  -- SHA-256 do segredo guardado em cookie HttpOnly no aparelho que pediu.
  browser_hash     TEXT NOT NULL CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  attempts         INTEGER NOT NULL DEFAULT 0,
  contact_id       UUID REFERENCES public.contacts(id) ON DELETE CASCADE,
  confirmed_at     TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Um código vale para uma conta por vez (enquanto existe a linha).
CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_phone_checks_code ON public.booking_phone_checks (account_id, code);
CREATE INDEX IF NOT EXISTS idx_booking_phone_checks_expires ON public.booking_phone_checks (expires_at);
CREATE INDEX IF NOT EXISTS idx_booking_phone_checks_browser ON public.booking_phone_checks (browser_hash);

ALTER TABLE public.booking_phone_checks ENABLE ROW LEVEL SECURITY;
-- (grants below)

-- ---- booking_session_revocations ------------------------------------------------
-- The customer's session is a signed cookie (30 days). "Sair de todos os aparelhos"
-- stores the moment here: sessions issued before it stop working. Only service role.
CREATE TABLE IF NOT EXISTS public.booking_session_revocations (
  account_id     UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id     UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  revoked_before TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, contact_id)
);
ALTER TABLE public.booking_session_revocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_session_revocations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.booking_session_revocations TO service_role;

REVOKE ALL ON TABLE public.booking_phone_checks FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.booking_phone_checks TO service_role;

-- Grandfather: trial, pro e empresa ganham booking_page; basico não. Igual à 101.
DO $$
DECLARE v record; mods jsonb; new_id uuid; rev int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.platform_plan_versions WHERE actor_name = 'Sistema (114: página de agendamento)') THEN
    RETURN;
  END IF;
  LOCK TABLE public.accounts, public.account_billing IN SHARE ROW EXCLUSIVE MODE;
  CREATE TEMP TABLE version_map_114(old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP;
  FOR v IN
    SELECT pv.*, (c.current_version_id = pv.id) AS is_current
    FROM public.platform_plan_versions pv
    JOIN public.platform_plan_catalog c ON c.plan = pv.plan
    WHERE pv.plan IN ('trial', 'pro', 'empresa')
      AND (c.current_version_id = pv.id
       OR EXISTS (SELECT 1 FROM public.accounts a WHERE a.plan_version_id = pv.id)
       OR EXISTS (SELECT 1 FROM public.account_billing b WHERE b.plan_version_id = pv.id))
    ORDER BY pv.plan, (c.current_version_id = pv.id), pv.revision
  LOOP
    mods := v.definition->'modules';
    IF mods ? 'booking_page' THEN CONTINUE; END IF;
    mods := mods || '["booking_page"]';
    SELECT max(revision) + 1 INTO rev FROM public.platform_plan_versions WHERE plan = v.plan;
    INSERT INTO public.platform_plan_versions(plan, revision, definition, price_monthly_cents, currency, actor_name)
      VALUES (v.plan, rev, jsonb_set(v.definition, '{modules}', mods), v.price_monthly_cents, v.currency,
              'Sistema (114: página de agendamento)')
      RETURNING id INTO new_id;
    INSERT INTO version_map_114 VALUES (v.id, new_id);
    IF v.is_current THEN
      UPDATE public.platform_plan_catalog SET current_version_id = new_id WHERE plan = v.plan;
    END IF;
  END LOOP;

  -- Bookkeeping, not a customer edit: keep updated_at (same as 081 / 099 / 101).
  ALTER TABLE public.accounts DISABLE TRIGGER set_updated_at;
  UPDATE public.accounts a SET plan_version_id = m.new_id FROM version_map_114 m WHERE a.plan_version_id = m.old_id;
  ALTER TABLE public.accounts ENABLE TRIGGER set_updated_at;
  ALTER TABLE public.account_billing DISABLE TRIGGER set_updated_at;
  UPDATE public.account_billing b SET plan_version_id = m.new_id FROM version_map_114 m WHERE b.plan_version_id = m.old_id;
  ALTER TABLE public.account_billing ENABLE TRIGGER set_updated_at;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
