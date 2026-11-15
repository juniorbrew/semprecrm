-- ============================================================
-- 114 — Extras além do plano (usuário extra e número extra).
-- Spec: docs/superpowers/specs/2026-11-15-indicadores-e-extras.md, Parte C.
--
--   * valid_plan_definition (cópia da 113) aceita duas chaves OPCIONAIS no JSON da
--     versão do plano: extra_user_price_cents e extra_channel_price_cents (inteiro
--     0..10000000, centavos por mês). Sem a chave, o plano não oferece o extra.
--     Versões antigas continuam válidas (as chaves não são obrigatórias).
--   * account_billing ganha extra_users / extra_channels (quantidade contratada,
--     0..100) e o preço TRAVADO de cada extra (centavos por mês, no momento da
--     contratação). Quantidade > 0 exige preço travado.
--   * Só o servidor (service_role) grava: authenticated só tem SELECT (090) e a RLS
--     só deixa admin/dono ler a própria linha. Nenhuma função nova.
--   * O limite real (plano + extras) é aplicado pelo servidor (resolveEntitlements):
--     o banco não tem gatilho de max_users / max_channels (só o plano em JSON).
--
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
  -- Extra prices: absent (not offered) or a whole number of cents, 0..R$ 100.000,00 / month.
  FOREACH key IN ARRAY ARRAY['extra_user_price_cents','extra_channel_price_cents'] LOOP
    IF value ? key THEN
      price := value->key;
      IF jsonb_typeof(price) <> 'number'
         OR (price #>> '{}')::numeric < 0 OR (price #>> '{}')::numeric > 10000000
         OR trunc((price #>> '{}')::numeric) <> (price #>> '{}')::numeric
         THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.valid_plan_definition(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.valid_plan_definition(jsonb) TO service_role;

ALTER TABLE public.account_billing
  ADD COLUMN IF NOT EXISTS extra_users INTEGER NOT NULL DEFAULT 0 CHECK (extra_users BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS extra_channels INTEGER NOT NULL DEFAULT 0 CHECK (extra_channels BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS extra_user_price_cents INTEGER CHECK (extra_user_price_cents BETWEEN 0 AND 10000000),
  ADD COLUMN IF NOT EXISTS extra_channel_price_cents INTEGER CHECK (extra_channel_price_cents BETWEEN 0 AND 10000000);
ALTER TABLE public.account_billing
  ADD CONSTRAINT account_billing_extra_users_priced CHECK (extra_users = 0 OR extra_user_price_cents IS NOT NULL),
  ADD CONSTRAINT account_billing_extra_channels_priced CHECK (extra_channels = 0 OR extra_channel_price_cents IS NOT NULL);

-- Grants (076 rule): 090 already gave authenticated SELECT (RLS: owner/admin of the account)
-- and service_role everything; the new columns inherit that. Nothing to add, but make the
-- intent explicit: no client write path exists.
REVOKE INSERT, UPDATE, DELETE ON public.account_billing FROM PUBLIC, anon, authenticated;

COMMIT;
