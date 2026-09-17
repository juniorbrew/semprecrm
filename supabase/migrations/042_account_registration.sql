-- ============================================================
-- 042_account_registration.sql — Pessoa física / pessoa jurídica
-- registration for the account (tenant).
--
-- A SempreCRM account is either a pessoa física (CPF) or a pessoa
-- jurídica (CNPJ). The signup page collects the type, the document
-- and — for companies — the razão social; the trigger stores them on
-- the account row so every member's data stays scoped to that
-- company. Settings → Empresa (admin+) edits them later through
-- PATCH /api/account.
--
-- What this migration does
--   1. Adds `accounts.person_type` ('pf' | 'pj', default 'pf' so
--      existing accounts keep working), `accounts.tax_id` (CPF: 11
--      digits; CNPJ: 12 alphanumerics + 2 check digits — the
--      Receita Federal alphanumeric format) and `accounts.legal_name`
--      (razão social, pessoa jurídica only). Format is CHECKed here;
--      check digits are validated in src/lib/br/documents.ts.
--   2. Redefines `handle_new_user` (031 body + registration fields)
--      so a fresh signup reads `person_type`, `tax_id`, `legal_name`
--      and `account_name` from the signup metadata. A malformed
--      document is stored as NULL rather than failing the signup.
--
-- RLS: unchanged — `accounts_update` (017) already restricts writes
-- to admin+, and members can SELECT their own account.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- ACCOUNTS columns
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS person_type TEXT NOT NULL DEFAULT 'pf',
  ADD COLUMN IF NOT EXISTS tax_id      TEXT,
  ADD COLUMN IF NOT EXISTS legal_name  TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_person_type_check'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_person_type_check
      CHECK (person_type IN ('pf', 'pj'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_tax_id_format_check'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_tax_id_format_check
      CHECK (
        tax_id IS NULL
        OR (person_type = 'pf' AND tax_id ~ '^[0-9]{11}$')
        OR (person_type = 'pj' AND tax_id ~ '^[0-9A-Z]{12}[0-9]{2}$')
      );
  END IF;
END $$;

COMMENT ON COLUMN accounts.person_type IS 'pf = pessoa física (CPF), pj = pessoa jurídica (CNPJ)';
COMMENT ON COLUMN accounts.tax_id IS 'CPF (11 digits) or CNPJ (14 alphanumerics), no mask';
COMMENT ON COLUMN accounts.legal_name IS 'Razão social — pessoa jurídica only';

-- ============================================================
-- SIGNUP TRIGGER — 031 body + registration fields
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
  v_account_id   UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  v_person_type := NEW.raw_user_meta_data->>'person_type';
  IF v_person_type IS DISTINCT FROM 'pj' THEN
    v_person_type := 'pf';
  END IF;

  -- Normalise the document (strip mask, upper-case) and drop it when
  -- it does not match the format the CHECK constraint expects — a bad
  -- document must never block account creation.
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

  INSERT INTO public.accounts (name, owner_user_id, plan, plan_status, plan_expires_at, person_type, tax_id, legal_name)
  VALUES (
    COALESCE(v_account_name, v_legal_name, NULLIF(v_full_name, ''), NEW.email, 'My account'),
    NEW.id,
    'trial',
    'trial',
    NOW() + INTERVAL '14 days',
    v_person_type,
    v_tax_id,
    v_legal_name
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
