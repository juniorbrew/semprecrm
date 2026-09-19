-- ============================================================
-- 043_account_contact.sql — Address, phone and e-mail on the
-- account (tenant), filled from the CNPJ / CEP lookup at signup or
-- in Settings → Empresa.
--
-- What this migration does
--   1. Adds `accounts.address` jsonb — `{ cep, street, number,
--      complement, neighborhood, city, state }`, all strings, parsed
--      and validated by src/lib/br/lookup.ts (`validateAccountContact`).
--      `{}` = no address. Plus `accounts.phone` (digits, DDD + number)
--      and `accounts.email` (the company's contact e-mail — distinct
--      from the owner's login e-mail).
--   2. Redefines `handle_new_user` (042 body + contact block) so the
--      signup metadata keys `address`, `phone` and `email` land on the
--      new account. Only the seven known address keys are copied; a
--      non-object `address` is ignored. Nothing here can fail the
--      signup.
--
-- RLS: unchanged — `accounts_update` (017) restricts writes to admin+.
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS address JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS phone   TEXT,
  ADD COLUMN IF NOT EXISTS email   TEXT;

COMMENT ON COLUMN accounts.address IS 'Company address { cep, street, number, complement, neighborhood, city, state }; {} = none';
COMMENT ON COLUMN accounts.phone IS 'Company phone, digits only (DDD + number)';
COMMENT ON COLUMN accounts.email IS 'Company contact e-mail (not the owner login)';

-- ============================================================
-- SIGNUP TRIGGER — 042 body + contact block
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name    TEXT;
  v_person_type  TEXT;
  v_tax_id       TEXT;
  v_legal_name   TEXT;
  v_account_name TEXT;
  v_phone        TEXT;
  v_email        TEXT;
  v_address_in   JSONB;
  v_address      JSONB := '{}'::jsonb;
  v_key          TEXT;
  v_account_id   UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  v_person_type := NEW.raw_user_meta_data->>'person_type';
  IF v_person_type IS DISTINCT FROM 'pj' THEN
    v_person_type := 'pf';
  END IF;

  v_tax_id := UPPER(REGEXP_REPLACE(COALESCE(NEW.raw_user_meta_data->>'tax_id', ''), '[^0-9A-Za-z]', '', 'g'));
  IF v_tax_id = ''
     OR (v_person_type = 'pf' AND v_tax_id !~ '^[0-9]{11}$')
     OR (v_person_type = 'pj' AND v_tax_id !~ '^[0-9A-Z]{12}[0-9]{2}$') THEN
    v_tax_id := NULL;
  END IF;

  v_legal_name := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'legal_name', '')), '');
  IF v_person_type = 'pf' THEN
    v_legal_name := NULL;
  END IF;

  v_account_name := NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'account_name', '')), '');

  -- Contact block: digits-only phone, lower-cased e-mail, and only the
  -- known address keys (each capped at 120 chars) so a client cannot
  -- stuff arbitrary JSON into the row.
  v_phone := NULLIF(REGEXP_REPLACE(COALESCE(NEW.raw_user_meta_data->>'phone', ''), '[^0-9]', '', 'g'), '');
  IF v_phone IS NOT NULL AND v_phone !~ '^[0-9]{10,11}$' THEN
    v_phone := NULL;
  END IF;
  v_email := NULLIF(LOWER(TRIM(COALESCE(NEW.raw_user_meta_data->>'email', ''))), '');
  IF v_email IS NOT NULL AND (v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' OR LENGTH(v_email) > 120) THEN
    v_email := NULL;
  END IF;

  v_address_in := NEW.raw_user_meta_data->'address';
  IF v_address_in IS NOT NULL AND jsonb_typeof(v_address_in) = 'object' THEN
    FOREACH v_key IN ARRAY ARRAY['cep','street','number','complement','neighborhood','city','state'] LOOP
      IF jsonb_typeof(v_address_in->v_key) = 'string' THEN
        v_address := v_address || jsonb_build_object(
          v_key,
          CASE WHEN v_key = 'cep' THEN LEFT(REGEXP_REPLACE(v_address_in->>v_key, '[^0-9]', '', 'g'), 8)
               WHEN v_key = 'state' THEN UPPER(LEFT(TRIM(v_address_in->>v_key), 2))
               ELSE LEFT(TRIM(v_address_in->>v_key), 120) END
        );
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.accounts (
    name, owner_user_id, plan, plan_status, plan_expires_at,
    person_type, tax_id, legal_name, phone, email, address
  )
  VALUES (
    COALESCE(v_account_name, v_legal_name, NULLIF(v_full_name, ''), NEW.email, 'My account'),
    NEW.id,
    'trial',
    'trial',
    NOW() + INTERVAL '14 days',
    v_person_type,
    v_tax_id,
    v_legal_name,
    v_phone,
    v_email,
    v_address
  )
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  PERFORM public.seed_task_statuses(v_account_id);
  PERFORM public.seed_deal_loss_reasons(v_account_id);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
