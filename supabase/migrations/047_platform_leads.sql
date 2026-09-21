-- Global platform leads. Source snapshots survive source deletion; references
-- may become NULL, but can never point at the other kind of source.
-- No backfill: only new submissions/signups generate leads and notifications.
CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('contato', 'cadastro')),
  status text NOT NULL DEFAULT 'novo' CHECK (status IN ('novo', 'em_contato', 'convertido', 'descartado')),
  name text NOT NULL,
  email text NOT NULL,
  company text,
  contact_submission_id uuid REFERENCES public.contact_submissions(id) ON DELETE SET NULL,
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  notification_claimed_at timestamptz,
  notification_claim_token uuid,
  notified_at timestamptz,
  notification_attempts integer NOT NULL DEFAULT 0 CHECK (notification_attempts >= 0),
  notification_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leads_source_kind CHECK (
    (kind = 'contato' AND account_id IS NULL) OR
    (kind = 'cadastro' AND contact_submission_id IS NULL)
  ),
  CONSTRAINT leads_claim_pair CHECK ((notification_claimed_at IS NULL) = (notification_claim_token IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_contact_source_unique ON public.leads(contact_submission_id) WHERE contact_submission_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS leads_account_source_unique ON public.leads(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_created ON public.leads(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS leads_status_created ON public.leads(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS leads_kind_created ON public.leads(kind, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS leads_notification_pending ON public.leads(notification_next_attempt_at, created_at, id) WHERE notified_at IS NULL;

-- Supabase may already have pg_trgm installed in extensions instead of public.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
DO $$
DECLARE v_schema text;
BEGIN
  SELECT n.nspname INTO v_schema FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm';
  EXECUTE pg_catalog.format('CREATE INDEX IF NOT EXISTS leads_search ON public.leads USING gin ((lower(name || '' '' || email || '' '' || coalesce(company, ''''))) %I.gin_trgm_ops)', v_schema);
END;
$$;

-- Harden the existing authorization helper reused by this module. The
-- authorization meaning and handle_new_user() remain completely unchanged.
CREATE OR REPLACE FUNCTION public.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid());
$$;
ALTER FUNCTION public.is_platform_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.leads TO authenticated;
GRANT ALL ON public.leads TO service_role;
DROP POLICY IF EXISTS leads_platform_select ON public.leads;
CREATE POLICY leads_platform_select ON public.leads FOR SELECT TO authenticated USING (public.is_platform_admin());
-- Even admins update only through the validated status RPC. No client INSERT,
-- UPDATE or DELETE grant/policy exists.

CREATE TABLE IF NOT EXISTS public.lead_push_deliveries (
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES public.push_subscriptions(id) ON DELETE CASCADE,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, subscription_id)
);
ALTER TABLE public.lead_push_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_push_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.lead_push_deliveries TO service_role;

-- Trigger functions cannot require platform-admin identity: their callers are
-- public-contact service writes and auth signup. No role may invoke them as RPCs.
CREATE OR REPLACE FUNCTION public.on_contact_submission_created_lead() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.leads(kind, name, email, company, contact_submission_id)
  VALUES ('contato', NEW.name, NEW.email, NEW.company, NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- SQLSTATE only: never log SQLERRM, names, addresses, messages or credentials.
  RAISE WARNING 'platform_lead_capture_failed source=contato sqlstate=%', SQLSTATE;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.on_contact_submission_created_lead() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.on_contact_submission_created_lead() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS contact_submission_created_lead ON public.contact_submissions;
CREATE TRIGGER contact_submission_created_lead AFTER INSERT ON public.contact_submissions
  FOR EACH ROW EXECUTE FUNCTION public.on_contact_submission_created_lead();

CREATE OR REPLACE FUNCTION public.on_account_created_lead() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_email text;
BEGIN
  IF NEW.plan <> 'trial' THEN RETURN NEW; END IF;
  -- The auth row already exists while handle_new_user inserts accounts; the
  -- profile does not. accounts.email is company contact, not the owner's login.
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = NEW.owner_user_id;
  INSERT INTO public.leads(kind, name, email, company, account_id)
  VALUES ('cadastro', NEW.name, v_email, NEW.legal_name, NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'platform_lead_capture_failed source=cadastro sqlstate=%', SQLSTATE;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.on_account_created_lead() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.on_account_created_lead() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS account_created_lead ON public.accounts;
CREATE TRIGGER account_created_lead AFTER INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.on_account_created_lead();

CREATE OR REPLACE FUNCTION public.platform_list_leads(
  p_limit integer DEFAULT 25, p_offset integer DEFAULT 0,
  p_status text DEFAULT NULL, p_kind text DEFAULT NULL, p_search text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_result jsonb; v_pattern text;
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset < 0 OR p_offset > 1000000
    OR (p_status IS NOT NULL AND p_status NOT IN ('novo','em_contato','convertido','descartado'))
    OR (p_kind IS NOT NULL AND p_kind NOT IN ('contato','cadastro')) OR length(coalesce(p_search,'')) > 200
  THEN RAISE EXCEPTION 'Invalid lead filters' USING ERRCODE = '22023'; END IF;
  -- Literal substring search; wildcard characters supplied by users are data.
  v_pattern := '%' || replace(replace(replace(lower(btrim(coalesce(p_search,''))), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  WITH filtered AS NOT MATERIALIZED (
    SELECT l.id,l.kind,l.status,l.name,l.email,l.company,l.created_at,l.updated_at
    FROM public.leads l WHERE (p_status IS NULL OR l.status = p_status)
      AND (p_kind IS NULL OR l.kind = p_kind)
      AND (v_pattern = '%%' OR lower(l.name || ' ' || l.email || ' ' || coalesce(l.company,'')) LIKE v_pattern)
  ), page AS (
    SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object('leads', coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.created_at DESC,p.id DESC) FROM page p),'[]'::jsonb),
    'total',(SELECT count(*) FROM filtered),'new_count',(SELECT count(*) FROM public.leads WHERE status = 'novo'),
    'limit',p_limit,'offset',p_offset) INTO v_result;
  RETURN v_result;
END;
$$;
ALTER FUNCTION public.platform_list_leads(integer,integer,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_list_leads(integer,integer,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_list_leads(integer,integer,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.platform_update_lead_status(p_lead_id uuid,p_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_row public.leads;
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501'; END IF;
  IF p_lead_id IS NULL OR p_status IS NULL OR p_status NOT IN ('novo','em_contato','convertido','descartado')
  THEN RAISE EXCEPTION 'Invalid lead status' USING ERRCODE = '22023'; END IF;
  UPDATE public.leads SET status = p_status, updated_at = clock_timestamp() WHERE id = p_lead_id RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('id',v_row.id,'kind',v_row.kind,'status',v_row.status,'name',v_row.name,
    'email',v_row.email,'company',v_row.company,'created_at',v_row.created_at,'updated_at',v_row.updated_at);
END;
$$;
ALTER FUNCTION public.platform_update_lead_status(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_update_lead_status(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_update_lead_status(uuid,text) TO authenticated;

-- Service-only INVOKER functions do not elevate privileges or rely on a
-- request-provided JWT role. PostgreSQL grants are the worker authorization.
-- One bounded item per worker call avoids holding a batch of aging leases.
CREATE OR REPLACE FUNCTION public.claim_lead_notifications(p_limit integer DEFAULT 1)
RETURNS TABLE(id uuid,kind text,name text,email text,company text,notification_claim_token uuid,
  notification_attempts integer,notification_claimed_at timestamptz)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_limit IS NULL OR p_limit <> 1 THEN RAISE EXCEPTION 'Claim one lead at a time' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT l.id FROM public.leads l
    WHERE l.notified_at IS NULL AND l.notification_next_attempt_at <= clock_timestamp()
      AND (l.notification_claimed_at IS NULL OR l.notification_claimed_at < clock_timestamp() - interval '5 minutes')
    ORDER BY l.notification_next_attempt_at,l.created_at,l.id FOR UPDATE SKIP LOCKED LIMIT p_limit
  )
  UPDATE public.leads l SET notification_claimed_at = clock_timestamp(), notification_claim_token = gen_random_uuid(),
    notification_attempts = l.notification_attempts + 1
  FROM candidates c WHERE l.id = c.id
  RETURNING l.id,l.kind,l.name,l.email,l.company,l.notification_claim_token,l.notification_attempts,l.notification_claimed_at;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_lead_notifications(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_lead_notifications(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_lead_notification(p_lead_id uuid,p_claim_token uuid,p_success boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  IF p_success IS NULL THEN RAISE EXCEPTION 'Missing outcome' USING ERRCODE = '22023'; END IF;
  UPDATE public.leads l SET notified_at = CASE WHEN p_success THEN clock_timestamp() ELSE NULL END,
    notification_claimed_at = NULL, notification_claim_token = NULL,
    notification_next_attempt_at = CASE WHEN p_success THEN l.notification_next_attempt_at
      ELSE clock_timestamp() + interval '1 minute' * least(60, power(2,least(l.notification_attempts - 1,6))::integer) END
  WHERE l.id = p_lead_id AND l.notification_claim_token = p_claim_token AND l.notified_at IS NULL
    AND l.notification_claimed_at >= clock_timestamp() - interval '5 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_lead_notification(uuid,uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_lead_notification(uuid,uuid,boolean) TO service_role;
