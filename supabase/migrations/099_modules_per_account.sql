-- ============================================================
-- 099 — Módulos por empresa: quatro funções ganham botão próprio.
--
--   reports     — Relatórios (antes vinha junto com `dashboard`)
--   api         — chaves de API + webhooks (antes sempre ligado)
--   support     — SLA, pesquisa de satisfação, equipes/distribuição
--                 (antes sempre ligado)
--   ai_actions  — a IA executa ações (080/098); exige também `ai`
--
-- Ninguém perde nada: cada versão de plano em uso ganha uma revisão nova
-- com os módulos novos onde a função já funcionava (api/support sempre;
-- reports onde há dashboard; ai_actions onde há ai), as empresas passam
-- para ela, e um override de dashboard/ai é copiado para reports/ai_actions.
-- account_billing também é repontada: billing_activate (090) copia a versão
-- assinada para a empresa a cada pagamento e a devolveria à versão antiga.
-- Versões são imutáveis (081): só inserimos linhas novas.
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
      'reports','api','support','ai_actions'
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
    'calendar', 'ai', 'reports', 'api', 'support', 'ai_actions'
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

-- Grandfather: one new revision per version in use, current one last so it
-- keeps the highest revision (platform_save_plan_version uses revision+1).
DO $$
DECLARE v record; mods jsonb; new_id uuid; rev int;
BEGIN
  CREATE TEMP TABLE version_map(old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP;
  FOR v IN
    SELECT pv.*, (c.current_version_id = pv.id) AS is_current
    FROM public.platform_plan_versions pv
    JOIN public.platform_plan_catalog c ON c.plan = pv.plan
    WHERE c.current_version_id = pv.id
       OR EXISTS (SELECT 1 FROM public.accounts a WHERE a.plan_version_id = pv.id)
       OR EXISTS (SELECT 1 FROM public.account_billing b WHERE b.plan_version_id = pv.id)
    ORDER BY pv.plan, (c.current_version_id = pv.id), pv.revision
  LOOP
    mods := v.definition->'modules';
    IF NOT mods ? 'api' THEN mods := mods || '["api"]'; END IF;
    IF NOT mods ? 'support' THEN mods := mods || '["support"]'; END IF;
    IF mods ? 'dashboard' AND NOT mods ? 'reports' THEN mods := mods || '["reports"]'; END IF;
    IF mods ? 'ai' AND NOT mods ? 'ai_actions' THEN mods := mods || '["ai_actions"]'; END IF;
    SELECT max(revision) + 1 INTO rev FROM public.platform_plan_versions WHERE plan = v.plan;
    INSERT INTO public.platform_plan_versions(plan, revision, definition, price_monthly_cents, currency, actor_name)
      VALUES (v.plan, rev, jsonb_set(v.definition, '{modules}', mods), v.price_monthly_cents, v.currency,
              'Sistema (099: módulos novos)')
      RETURNING id INTO new_id;
    INSERT INTO version_map VALUES (v.id, new_id);
    IF v.is_current THEN
      UPDATE public.platform_plan_catalog SET current_version_id = new_id WHERE plan = v.plan;
    END IF;
  END LOOP;

  -- Bookkeeping, not a customer edit: keep updated_at (same as 081).
  ALTER TABLE public.accounts DISABLE TRIGGER set_updated_at;
  UPDATE public.accounts a SET plan_version_id = m.new_id FROM version_map m WHERE a.plan_version_id = m.old_id;
  ALTER TABLE public.account_billing DISABLE TRIGGER set_updated_at;
  UPDATE public.account_billing b SET plan_version_id = m.new_id FROM version_map m WHERE b.plan_version_id = m.old_id;
  ALTER TABLE public.account_billing ENABLE TRIGGER set_updated_at;
  UPDATE public.accounts SET module_overrides = module_overrides
      || CASE WHEN module_overrides ? 'dashboard' AND NOT module_overrides ? 'reports'
              THEN jsonb_build_object('reports', module_overrides->'dashboard') ELSE '{}' END
      || CASE WHEN module_overrides ? 'ai' AND NOT module_overrides ? 'ai_actions'
              THEN jsonb_build_object('ai_actions', module_overrides->'ai') ELSE '{}' END
    WHERE module_overrides ?| ARRAY['dashboard','ai'];
  ALTER TABLE public.accounts ENABLE TRIGGER set_updated_at;
END $$;

COMMIT;
