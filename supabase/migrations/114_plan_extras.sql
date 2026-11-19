-- ============================================================
-- 114 — Extras além do plano (usuário extra e número extra).
-- Spec: docs/superpowers/specs/2026-11-15-indicadores-e-extras.md, Parte C.
--
--   * valid_plan_definition (cópia da 113) aceita duas chaves OPCIONAIS no JSON da
--     versão do plano: extra_user_price_cents e extra_channel_price_cents (inteiro
--     1..10000000, centavos por mês). Sem a chave, o plano não oferece o extra.
--     Versões antigas continuam válidas (as chaves não são obrigatórias).
--   * account_billing ganha: extra_users / extra_channels (quantidade contratada,
--     0..100), o preço TRAVADO de cada um (centavos/mês), extras_first_due (vencimento
--     da primeira cobrança que inclui o último extra adicionado), a redução agendada
--     (pending_extra_*, extras_reduce_due, extras_asaas_lowered) e a reserva por conta
--     (extras_claim_*) que serializa as mudanças. Quantidade > 0 exige preço travado.
--   * Três funções (só service_role): billing_extras_claim / _commit / _release. A mudança
--     e a linha de auditoria entram na MESMA transação, e o teto diário é contado dessas
--     linhas sob o lock da conta.
--   * Só o servidor (service_role) grava: authenticated só tem SELECT (090) e a RLS
--     só deixa admin/dono ler a própria linha.
--   * platform_list_accounts() devolve extra_users / extra_channels, para as páginas da
--     plataforma usarem o limite real.
--   * O limite real (plano + extras) é aplicado pelo servidor (resolveEntitlements): o
--     banco não tem gatilho de max_users / max_channels (só o plano em JSON).
--
-- Idempotente: pode rodar de novo (colunas IF NOT EXISTS, constraints recriadas, funções
-- CREATE OR REPLACE, platform_list_accounts recriada com os mesmos grants).
-- Rollback: supabase/rollback/114_rollback.sql. Teste: supabase/tests/plan_extras.sql.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.valid_plan_definition(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE item jsonb; key text; capacity jsonb; price jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
     OR NOT value ?& ARRAY['modules','limits']
     OR value - ARRAY['modules','limits','extra_user_price_cents','extra_channel_price_cents'] <> '{}'
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
  -- Extra prices: absent (not offered) or a whole number of cents, R$ 0,01..R$ 100.000,00 / month.
  FOREACH key IN ARRAY ARRAY['extra_user_price_cents','extra_channel_price_cents'] LOOP
    IF value ? key THEN
      price := value->key;
      IF jsonb_typeof(price) <> 'number'
         OR (price #>> '{}')::numeric < 1 OR (price #>> '{}')::numeric > 10000000
         OR trunc((price #>> '{}')::numeric) <> (price #>> '{}')::numeric
         THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.valid_plan_definition(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.valid_plan_definition(jsonb) TO service_role;

ALTER TABLE public.account_billing
  ADD COLUMN IF NOT EXISTS extra_users INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_channels INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_user_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS extra_channel_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS extras_first_due DATE,
  ADD COLUMN IF NOT EXISTS pending_extra_users INTEGER,
  ADD COLUMN IF NOT EXISTS pending_extra_channels INTEGER,
  ADD COLUMN IF NOT EXISTS extras_reduce_due DATE,
  ADD COLUMN IF NOT EXISTS extras_asaas_lowered BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS extras_claim_token UUID,
  ADD COLUMN IF NOT EXISTS extras_claim_until TIMESTAMPTZ,
  -- Annual subscriptions: an add waits for its one-off prorated charge to be paid (the limit is
  -- released only then). The deltas, the prices the purchase locks, and the Asaas charge.
  ADD COLUMN IF NOT EXISTS pending_add_users INTEGER,
  ADD COLUMN IF NOT EXISTS pending_add_channels INTEGER,
  ADD COLUMN IF NOT EXISTS pending_add_user_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS pending_add_channel_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS extras_oneoff_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS extras_oneoff_url TEXT,
  ADD COLUMN IF NOT EXISTS extras_oneoff_cents BIGINT,
  ADD COLUMN IF NOT EXISTS extras_oneoff_expires_at TIMESTAMPTZ,
  -- The renewal due date the purchase was priced against: if that renewal is paid before the one-off
  -- charge, the months are already covered and nothing is released (the owner refunds).
  ADD COLUMN IF NOT EXISTS extras_oneoff_renewal_due DATE,
  -- The paid one-off charge of the last activated purchase (a refund or chargeback of it is acted on).
  ADD COLUMN IF NOT EXISTS extras_oneoff_paid_id TEXT,
  -- The charge for the difference of a blocked removal, and when the sweep stops waiting for it.
  ADD COLUMN IF NOT EXISTS extras_diff_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS extras_diff_expires_at TIMESTAMPTZ;

-- Recreated every run so a second run does not fail.
ALTER TABLE public.account_billing
  DROP CONSTRAINT IF EXISTS account_billing_extra_users_range,
  DROP CONSTRAINT IF EXISTS account_billing_extra_channels_range,
  DROP CONSTRAINT IF EXISTS account_billing_extra_prices_range,
  DROP CONSTRAINT IF EXISTS account_billing_extra_users_priced,
  DROP CONSTRAINT IF EXISTS account_billing_extra_channels_priced,
  DROP CONSTRAINT IF EXISTS account_billing_extras_pending_shape,
  DROP CONSTRAINT IF EXISTS account_billing_extras_purchase_shape,
  DROP CONSTRAINT IF EXISTS account_billing_extras_diff_shape;
ALTER TABLE public.account_billing
  ADD CONSTRAINT account_billing_extra_users_range CHECK (extra_users BETWEEN 0 AND 100),
  ADD CONSTRAINT account_billing_extra_channels_range CHECK (extra_channels BETWEEN 0 AND 100),
  ADD CONSTRAINT account_billing_extra_prices_range CHECK (
    (extra_user_price_cents IS NULL OR extra_user_price_cents BETWEEN 1 AND 10000000)
    AND (extra_channel_price_cents IS NULL OR extra_channel_price_cents BETWEEN 1 AND 10000000)),
  ADD CONSTRAINT account_billing_extra_users_priced CHECK (extra_users = 0 OR extra_user_price_cents IS NOT NULL),
  ADD CONSTRAINT account_billing_extra_channels_priced CHECK (extra_channels = 0 OR extra_channel_price_cents IS NOT NULL),
  -- A scheduled reduction is all-or-nothing and only ever lowers.
  ADD CONSTRAINT account_billing_extras_pending_shape CHECK (
    (pending_extra_users IS NULL) = (pending_extra_channels IS NULL)
    AND (pending_extra_users IS NULL) = (extras_reduce_due IS NULL)
    AND (pending_extra_users IS NULL OR (pending_extra_users BETWEEN 0 AND extra_users
         AND pending_extra_channels BETWEEN 0 AND extra_channels))
    AND (extras_asaas_lowered = false OR extras_reduce_due IS NOT NULL)),
  -- An awaited purchase is all-or-nothing: deltas, charge, link, amount and expiry together.
  ADD CONSTRAINT account_billing_extras_purchase_shape CHECK (
    (pending_add_users IS NULL) = (pending_add_channels IS NULL)
    AND (pending_add_users IS NULL) = (extras_oneoff_payment_id IS NULL)
    AND (pending_add_users IS NULL) = (extras_oneoff_cents IS NULL)
    AND (pending_add_users IS NULL) = (extras_oneoff_expires_at IS NULL)
    AND (pending_add_users IS NULL) = (extras_oneoff_renewal_due IS NULL)
    AND (pending_add_users IS NULL OR (pending_add_users >= 0 AND pending_add_channels >= 0
         AND pending_add_users + pending_add_channels > 0 AND extras_oneoff_cents > 0
         AND (pending_add_users = 0 OR (pending_add_user_price_cents IS NOT NULL AND pending_add_user_price_cents BETWEEN 1 AND 10000000))
         AND (pending_add_channels = 0 OR (pending_add_channel_price_cents IS NOT NULL AND pending_add_channel_price_cents BETWEEN 1 AND 10000000))))),
  -- The difference charge of a blocked removal: id and expiry together.
  ADD CONSTRAINT account_billing_extras_diff_shape CHECK ((extras_diff_payment_id IS NULL) = (extras_diff_expires_at IS NULL));

-- Clients get no write path: 090 gave authenticated SELECT only (RLS: owner/admin of the account).
REVOKE INSERT, UPDATE, DELETE ON public.account_billing FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- Serialised changes. One change per account at a time: CLAIM (under an advisory lock, counts
-- the daily cap from the audit rows, stamps a token valid for 90 s), then the server talks to
-- Asaas, then COMMIT (checks the token and what was read, writes the extras AND the audit row in
-- one transaction) or RELEASE. All closed to everyone but service_role (076 rule).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.billing_extras_claim(p_account uuid, p_max_per_day integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  b public.account_billing%ROWTYPE;
  v_token uuid := gen_random_uuid();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_extras:' || p_account::text, 0));
  SELECT * INTO b FROM public.account_billing WHERE account_id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'none'); END IF;
  IF b.extras_claim_until IS NOT NULL AND b.extras_claim_until > now() THEN
    RETURN jsonb_build_object('status', 'busy');
  END IF;
  IF p_max_per_day IS NOT NULL AND (
       SELECT count(*) FROM public.audit_log
        WHERE account_id = p_account AND action = 'billing.extras_changed'
          AND created_at > now() - interval '24 hours') >= p_max_per_day THEN
    RETURN jsonb_build_object('status', 'cap');
  END IF;
  UPDATE public.account_billing
     SET extras_claim_token = v_token, extras_claim_until = now() + interval '90 seconds'
   WHERE account_id = p_account
  RETURNING * INTO b;
  RETURN jsonb_build_object('status', 'ok', 'token', v_token, 'row', to_jsonb(b));
END $$;

CREATE OR REPLACE FUNCTION public.billing_extras_commit(
  p_account uuid, p_token uuid, p_expect jsonb, p_new jsonb,
  p_actor uuid, p_action text, p_metadata jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  b public.account_billing%ROWTYPE;
  v_name text;
BEGIN
  IF p_action NOT IN ('billing.extras_changed', 'billing.extras_removal_applied', 'billing.extras_removal_blocked', 'billing.extras_add_cancelled',
                    'billing.extras_refund_needed', 'billing.extras_diff_settled', 'billing.extras_diff_expired') THEN
    RAISE EXCEPTION 'Unknown extras action' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing_extras:' || p_account::text, 0));
  SELECT * INTO b FROM public.account_billing WHERE account_id = p_account FOR UPDATE;
  IF NOT FOUND OR b.extras_claim_token IS DISTINCT FROM p_token
     OR b.extras_claim_until IS NULL OR b.extras_claim_until <= now() THEN
    RETURN false;
  END IF;
  -- Compare-and-swap on what the server read.
  IF b.status <> 'active'
     OR b.asaas_subscription_id IS DISTINCT FROM (p_expect->>'asaas_subscription_id')
     OR b.value_cents IS DISTINCT FROM (p_expect->>'value_cents')::bigint
     OR b.extra_users IS DISTINCT FROM (p_expect->>'extra_users')::int
     OR b.extra_channels IS DISTINCT FROM (p_expect->>'extra_channels')::int
     OR b.extra_user_price_cents IS DISTINCT FROM (p_expect->>'extra_user_price_cents')::int
     OR b.extra_channel_price_cents IS DISTINCT FROM (p_expect->>'extra_channel_price_cents')::int
     OR b.pending_extra_users IS DISTINCT FROM (p_expect->>'pending_extra_users')::int
     OR b.extras_asaas_lowered IS DISTINCT FROM (p_expect->>'extras_asaas_lowered')::boolean
     OR b.extras_oneoff_payment_id IS DISTINCT FROM (p_expect->>'extras_oneoff_payment_id')
     OR b.extras_diff_payment_id IS DISTINCT FROM (p_expect->>'extras_diff_payment_id') THEN
    RETURN false;
  END IF;
  UPDATE public.account_billing SET
    extra_users = (p_new->>'extra_users')::int,
    extra_channels = (p_new->>'extra_channels')::int,
    extra_user_price_cents = (p_new->>'extra_user_price_cents')::int,
    extra_channel_price_cents = (p_new->>'extra_channel_price_cents')::int,
    value_cents = (p_new->>'value_cents')::bigint,
    extras_first_due = (p_new->>'extras_first_due')::date,
    pending_extra_users = (p_new->>'pending_extra_users')::int,
    pending_extra_channels = (p_new->>'pending_extra_channels')::int,
    extras_reduce_due = (p_new->>'extras_reduce_due')::date,
    extras_asaas_lowered = coalesce((p_new->>'extras_asaas_lowered')::boolean, false),
    pending_add_users = (p_new->>'pending_add_users')::int,
    pending_add_channels = (p_new->>'pending_add_channels')::int,
    pending_add_user_price_cents = (p_new->>'pending_add_user_price_cents')::int,
    pending_add_channel_price_cents = (p_new->>'pending_add_channel_price_cents')::int,
    extras_oneoff_payment_id = (p_new->>'extras_oneoff_payment_id'),
    extras_oneoff_url = (p_new->>'extras_oneoff_url'),
    extras_oneoff_cents = (p_new->>'extras_oneoff_cents')::bigint,
    extras_oneoff_expires_at = (p_new->>'extras_oneoff_expires_at')::timestamptz,
    extras_oneoff_renewal_due = (p_new->>'extras_oneoff_renewal_due')::date,
    extras_oneoff_paid_id = (p_new->>'extras_oneoff_paid_id'),
    extras_diff_payment_id = (p_new->>'extras_diff_payment_id'),
    extras_diff_expires_at = (p_new->>'extras_diff_expires_at')::timestamptz,
    extras_claim_token = NULL, extras_claim_until = NULL
  WHERE account_id = p_account;
  IF p_actor IS NOT NULL THEN SELECT full_name INTO v_name FROM public.profiles WHERE user_id = p_actor; END IF;
  INSERT INTO public.audit_log(account_id, actor_user_id, actor_name, action, entity_type, entity_id, metadata)
  VALUES (p_account, p_actor, v_name, p_action, 'account_billing', p_account::text, coalesce(p_metadata, '{}'::jsonb));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.billing_extras_release(p_account uuid, p_token uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.account_billing SET extras_claim_token = NULL, extras_claim_until = NULL
   WHERE account_id = p_account AND extras_claim_token = p_token;
$$;

REVOKE ALL ON FUNCTION public.billing_extras_claim(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_extras_commit(uuid, uuid, jsonb, jsonb, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_extras_release(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_extras_claim(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_extras_commit(uuid, uuid, jsonb, jsonb, uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_extras_release(uuid, uuid) TO service_role;

-- ------------------------------------------------------------
-- platform_list_accounts(): same as 081 plus the contracted extras (the effective ones: only while the subscription is active, and the target while a removal is pending), so /platform, the account
-- page and Usage compute the real limit. Same owner and grants.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.platform_list_accounts();
CREATE FUNCTION public.platform_list_accounts()
RETURNS TABLE (
  id                    UUID,
  name                  TEXT,
  owner_user_id         UUID,
  owner_email           TEXT,
  owner_name            TEXT,
  plan                  TEXT,
  plan_version_id       UUID,
  plan_definition       JSONB,
  plan_status           TEXT,
  plan_expires_at       TIMESTAMPTZ,
  module_overrides      JSONB,
  limit_overrides       JSONB,
  platform_notes        TEXT,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ,
  members_count         BIGINT,
  channels_count        BIGINT,
  pending_invites_count BIGINT,
  extra_users           INTEGER,
  extra_channels        INTEGER
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
         AND i.expires_at > NOW())                                         AS pending_invites_count,
    CASE WHEN b.status = 'active' THEN LEAST(b.extra_users, COALESCE(b.pending_extra_users, b.extra_users)) ELSE 0 END          AS extra_users,
    CASE WHEN b.status = 'active' THEN LEAST(b.extra_channels, COALESCE(b.pending_extra_channels, b.extra_channels)) ELSE 0 END AS extra_channels
  FROM accounts a
  JOIN platform_plan_versions v ON v.id=a.plan_version_id AND v.plan=a.plan
  LEFT JOIN account_billing b ON b.account_id = a.id
  LEFT JOIN profiles op ON op.user_id = a.owner_user_id
  ORDER BY a.created_at DESC;
END;
$$;

ALTER FUNCTION public.platform_list_accounts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_list_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_list_accounts() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
