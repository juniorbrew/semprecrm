-- Install before the application cutover; revoke the legacy writer with 080 last.
BEGIN;

CREATE FUNCTION public.valid_plan_definition(value jsonb) RETURNS boolean
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
      'channel_official','channel_qr','lead_capture','white_label','internal_chat','calendar','ai'
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

CREATE TABLE public.platform_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan text NOT NULL CHECK (plan IN ('trial','basico','pro','empresa')),
  revision integer NOT NULL CHECK (revision > 0),
  definition jsonb NOT NULL CHECK (public.valid_plan_definition(definition)),
  price_monthly_cents bigint CHECK (price_monthly_cents BETWEEN 0 AND 9007199254740991),
  currency text NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_name text,
  UNIQUE (plan, revision), UNIQUE (plan, id),
  CHECK (plan <> 'trial' OR price_monthly_cents IS NOT DISTINCT FROM 0)
);
CREATE TABLE public.platform_plan_catalog (
  plan text PRIMARY KEY,
  current_version_id uuid NOT NULL,
  FOREIGN KEY (plan,current_version_id) REFERENCES public.platform_plan_versions(plan,id)
);

WITH optional AS (
  SELECT '["dashboard","pipelines","tasks","broadcasts","automations","flows","channel_official","channel_qr","lead_capture","white_label","internal_chat","calendar","ai"]'::jsonb AS modules
)
INSERT INTO public.platform_plan_versions(plan,revision,definition,price_monthly_cents)
SELECT 'trial',1,jsonb_build_object('modules',modules,'limits',jsonb_build_object('max_users',2,'max_channels',1)),0 FROM optional
UNION ALL SELECT 'basico',1,'{"modules":["dashboard","pipelines","tasks","channel_qr"],"limits":{"max_users":3,"max_channels":1}}',5990
UNION ALL SELECT 'pro',1,jsonb_build_object('modules',modules - 'flows','limits',jsonb_build_object('max_users',10,'max_channels',2)),8990 FROM optional
UNION ALL SELECT 'empresa',1,jsonb_build_object('modules',modules,'limits',jsonb_build_object('max_users',NULL,'max_channels',5)),NULL FROM optional;
INSERT INTO public.platform_plan_catalog SELECT plan,id FROM public.platform_plan_versions WHERE revision=1;

ALTER TABLE public.accounts ADD COLUMN plan_version_id uuid;
UPDATE public.accounts a SET plan_version_id=c.current_version_id FROM public.platform_plan_catalog c WHERE c.plan=a.plan;
ALTER TABLE public.accounts ALTER COLUMN plan_version_id SET NOT NULL;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_plan_version_fk
  FOREIGN KEY (plan,plan_version_id) REFERENCES public.platform_plan_versions(plan,id);
GRANT SELECT (plan_version_id) ON public.accounts TO authenticated;

CREATE FUNCTION public.assign_account_plan_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- New accounts always receive current terms; clients cannot choose a revision.
  SELECT current_version_id INTO NEW.plan_version_id FROM public.platform_plan_catalog WHERE plan=NEW.plan;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.assign_account_plan_version() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER assign_account_plan_version BEFORE INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.assign_account_plan_version();

CREATE OR REPLACE FUNCTION public.enforce_account_platform_columns() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_user IN ('authenticated','anon') AND (
    NEW.plan IS DISTINCT FROM OLD.plan OR NEW.plan_status IS DISTINCT FROM OLD.plan_status
    OR NEW.plan_expires_at IS DISTINCT FROM OLD.plan_expires_at
    OR NEW.module_overrides IS DISTINCT FROM OLD.module_overrides
    OR NEW.limit_overrides IS DISTINCT FROM OLD.limit_overrides
    OR NEW.platform_notes IS DISTINCT FROM OLD.platform_notes
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.plan_version_id IS DISTINCT FROM OLD.plan_version_id) THEN
    RAISE EXCEPTION 'Account conditions are managed by the platform' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enforce_account_platform_columns ON public.accounts;
CREATE TRIGGER enforce_account_platform_columns BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_platform_columns();

CREATE FUNCTION public.reject_plan_version_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Plan versions are immutable' USING ERRCODE='42501'; END $$;
REVOKE ALL ON FUNCTION public.reject_plan_version_mutation() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER immutable_plan_version BEFORE UPDATE OR DELETE ON public.platform_plan_versions
  FOR EACH ROW EXECUTE FUNCTION public.reject_plan_version_mutation();

ALTER TABLE public.platform_plan_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_plan_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_plan_versions,public.platform_plan_catalog FROM PUBLIC,anon,authenticated;
GRANT SELECT(id,plan,revision,definition,price_monthly_cents) ON public.platform_plan_versions TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.platform_plan_versions,public.platform_plan_catalog TO service_role;
CREATE POLICY assigned_plan_version_read ON public.platform_plan_versions FOR SELECT TO authenticated
  USING (public.is_platform_admin() OR EXISTS (
    SELECT 1 FROM public.accounts a WHERE a.plan_version_id=platform_plan_versions.id AND public.is_account_member(a.id)
  ));

CREATE FUNCTION public.public_plan_catalog()
RETURNS TABLE(id uuid,plan text,revision integer,definition jsonb,price_monthly_cents bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT v.id,v.plan,v.revision,v.definition,v.price_monthly_cents
  FROM public.platform_plan_catalog c JOIN public.platform_plan_versions v ON v.id=c.current_version_id AND v.plan=c.plan
$$;
REVOKE ALL ON FUNCTION public.public_plan_catalog() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.public_plan_catalog() TO anon,authenticated,service_role;

CREATE FUNCTION public.platform_save_plan_version(
  p_plan text,p_expected_version_id uuid,p_definition jsonb,p_price_monthly_cents bigint,p_actor_user_id uuid
) RETURNS SETOF public.platform_plan_versions
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET lock_timeout='5s' AS $$
DECLARE previous public.platform_plan_versions; saved public.platform_plan_versions; actor text; pointer uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.platform_admins WHERE user_id=p_actor_user_id) THEN
    RAISE EXCEPTION 'Platform administrator required' USING ERRCODE='42501';
  END IF;
  IF p_plan IS NULL OR p_plan NOT IN ('trial','basico','pro','empresa')
     OR public.valid_plan_definition(p_definition) IS DISTINCT FROM true
     OR (p_price_monthly_cents IS NOT NULL AND (p_price_monthly_cents<0 OR p_price_monthly_cents>9007199254740991))
     OR (p_plan='trial' AND p_price_monthly_cents IS DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'Invalid plan terms' USING ERRCODE='22023';
  END IF;
  SELECT current_version_id INTO pointer FROM public.platform_plan_catalog WHERE plan=p_plan FOR UPDATE;
  IF pointer IS NULL THEN RAISE EXCEPTION 'Plan unavailable' USING ERRCODE='22023'; END IF;
  SELECT * INTO previous FROM public.platform_plan_versions WHERE id=pointer;
  IF pointer IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'Plan changed; reload current terms' USING ERRCODE='40001';
  END IF;
  IF previous.definition=p_definition AND previous.price_monthly_cents IS NOT DISTINCT FROM p_price_monthly_cents THEN
    RETURN NEXT previous; RETURN;
  END IF;
  SELECT full_name INTO actor FROM public.profiles WHERE user_id=p_actor_user_id;
  INSERT INTO public.platform_plan_versions(plan,revision,definition,price_monthly_cents,actor_user_id,actor_name)
    VALUES(p_plan,previous.revision+1,p_definition,p_price_monthly_cents,p_actor_user_id,actor) RETURNING * INTO saved;
  UPDATE public.platform_plan_catalog SET current_version_id=saved.id WHERE plan=p_plan;
  RETURN NEXT saved;
END $$;
REVOKE ALL ON FUNCTION public.platform_save_plan_version(text,uuid,jsonb,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.platform_save_plan_version(text,uuid,jsonb,bigint,uuid) TO service_role;
DROP FUNCTION public.platform_list_accounts();
CREATE FUNCTION public.platform_list_accounts()
RETURNS TABLE (
  id                    UUID,
  name                  TEXT,
  owner_user_id         UUID,
  owner_email           TEXT,
  owner_name            TEXT,
  plan                  TEXT,
  plan_status           TEXT,
  plan_expires_at       TIMESTAMPTZ,
  module_overrides      JSONB,
  limit_overrides       JSONB,
  platform_notes        TEXT,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ,
  members_count         BIGINT,
  channels_count        BIGINT,
  pending_invites_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.name,
    a.owner_user_id,
    op.email                      AS owner_email,
    op.full_name                  AS owner_name,
    a.plan,
    a.plan_version_id,
    v.definition,
    a.plan_status,
    a.plan_expires_at,
    a.module_overrides,
    a.limit_overrides,
    a.platform_notes,
    a.created_at,
    a.updated_at,
    (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id)            AS members_count,
    (SELECT COUNT(*) FROM whatsapp_config w WHERE w.account_id = a.id)
      + (SELECT COUNT(*) FROM wa_qr_sessions q
           WHERE q.account_id = a.id
             AND q.status <> 'disconnected')                               AS channels_count,
    (SELECT COUNT(*) FROM account_invitations i
       WHERE i.account_id = a.id
         AND i.accepted_at IS NULL
         AND i.expires_at > NOW())                                         AS pending_invites_count
  FROM accounts a
  JOIN platform_plan_versions v ON v.id=a.plan_version_id AND v.plan=a.plan
  LEFT JOIN profiles op ON op.user_id = a.owner_user_id
  ORDER BY a.created_at DESC;
END;
$$;

ALTER FUNCTION public.platform_list_accounts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_list_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_list_accounts() TO authenticated, service_role;

CREATE FUNCTION public.platform_update_account_v2(
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
    'calendar', 'ai'
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
NOTIFY pgrst,'reload schema';
COMMIT;
