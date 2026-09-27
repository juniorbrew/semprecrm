-- ============================================================
-- 054_companies.sql — Empresas (client companies / pessoa jurídica)
--
-- Ported from the DeskcommCRM fork (its migration 9001), rewritten
-- for this schema: `accounts` is the tenant, `deals` is the funnel
-- table, roles come from `is_account_member(account_id, min_role)`.
--
-- Naming: in the product "empresa" is also the tenant ("Sua empresa",
-- Settings → Empresa, `accounts`). This entity is the CRM's customer
-- company and lives in `companies`; the UI calls it "Empresas".
--
-- What this migration does
--   1. `companies` — razão social, nome fantasia, CNPJ (normalised:
--      12 alphanumerics + 2 check digits, the July-2026 format;
--      numeric CNPJs are a subset), commercial contact, address
--      split like `accounts.address` (cep / logradouro / numero /
--      complemento / bairro / cidade / uf), atividade + CNAE, notes.
--      CNPJ is unique per account when present (partial index).
--   2. `contact_companies` — N:N contact ↔ company. At most ONE
--      primary company per contact (partial unique index). Triggers
--      keep that rule without a second round trip:
--        * the first company linked to a contact becomes primary;
--        * linking / marking a company as primary clears the flag on
--          the contact's other links in the same statement;
--        * removing the primary link promotes the oldest remaining
--          one (also when the company itself is deleted).
--   3. `deals.company_id` — nullable, ON DELETE SET NULL (deleting a
--      company never takes the funnel with it).
--   4. Cross-tenant integrity (the FK does not go through RLS):
--        * `contact_companies.account_id` is always the contact's
--          account, and the company must belong to it;
--        * a deal can only point at a company of its own account;
--        * `companies.account_id` is immutable.
--      Errors are a generic "not found" (23503) so the caller cannot
--      probe whether an id exists in another account.
--   5. RLS — same tiers as contacts / deals (017): viewer+ reads,
--      agent+ writes.
--
-- LGPD: `contact_companies` stores only the link (no personal data)
-- and cascades with the contact; `companies` holds legal-entity data
-- and has no FK to `contacts`.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. COMPANIES
-- ============================================================
CREATE TABLE IF NOT EXISTS companies (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cnpj           TEXT,
  razao_social   TEXT NOT NULL,
  nome_fantasia  TEXT,
  email          TEXT,
  phone          TEXT,
  cep            TEXT,
  logradouro     TEXT,
  numero         TEXT,
  complemento    TEXT,
  bairro         TEXT,
  cidade         TEXT,
  uf             TEXT,
  cnae           TEXT,
  atividade      TEXT,
  notes          TEXT,
  created_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_razao_social_check;
ALTER TABLE companies ADD CONSTRAINT companies_razao_social_check
  CHECK (length(btrim(razao_social)) BETWEEN 1 AND 200);

-- Stored normalised (no mask). Check digits are validated by the app
-- (src/lib/br/documents.ts); the shape is enforced here.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_cnpj_format_check;
ALTER TABLE companies ADD CONSTRAINT companies_cnpj_format_check
  CHECK (cnpj IS NULL OR cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$');

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_cep_format_check;
ALTER TABLE companies ADD CONSTRAINT companies_cep_format_check
  CHECK (cep IS NULL OR cep ~ '^[0-9]{8}$');

ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_uf_format_check;
ALTER TABLE companies ADD CONSTRAINT companies_uf_format_check
  CHECK (uf IS NULL OR uf ~ '^[A-Z]{2}$');

-- Bounded free text (the form caps at the same sizes).
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_text_length_check;
ALTER TABLE companies ADD CONSTRAINT companies_text_length_check
  CHECK (
    coalesce(length(nome_fantasia), 0) <= 200
    AND coalesce(length(email), 0) <= 120
    AND coalesce(length(phone), 0) <= 20
    AND coalesce(length(logradouro), 0) <= 120
    AND coalesce(length(numero), 0) <= 20
    AND coalesce(length(complemento), 0) <= 120
    AND coalesce(length(bairro), 0) <= 120
    AND coalesce(length(cidade), 0) <= 120
    AND coalesce(length(cnae), 0) <= 20
    AND coalesce(length(atividade), 0) <= 300
    AND coalesce(length(notes), 0) <= 5000
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_account_cnpj
  ON companies(account_id, cnpj) WHERE cnpj IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_account_name
  ON companies(account_id, lower(razao_social));

DROP TRIGGER IF EXISTS set_updated_at ON companies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE companies IS
  'CRM customer company (pessoa jurídica), migration 054. Not the tenant (accounts). CNPJ normalised, unique per account when present.';

-- account_id never moves: every link and deal pointing here was
-- validated against it.
CREATE OR REPLACE FUNCTION public.companies_lock_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'companies.account_id cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.companies_lock_account() OWNER TO postgres;

DROP TRIGGER IF EXISTS companies_lock_account ON companies;
CREATE TRIGGER companies_lock_account
  BEFORE UPDATE OF account_id ON companies
  FOR EACH ROW EXECUTE FUNCTION public.companies_lock_account();

-- ============================================================
-- 2. CONTACT_COMPANIES
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_companies (
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, company_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_companies_one_primary
  ON contact_companies(contact_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS idx_contact_companies_company
  ON contact_companies(company_id);
CREATE INDEX IF NOT EXISTS idx_contact_companies_account
  ON contact_companies(account_id);

COMMENT ON TABLE contact_companies IS
  'Contact ↔ customer company (N:N), at most one primary per contact — migration 054. Link only, no personal data.';

-- 2a. Integrity: the link lives in the contact's account and the
-- company must belong to it. SECURITY DEFINER so the check sees both
-- rows regardless of the caller's RLS (and the service role, which
-- bypasses RLS, is held to the same rule).
CREATE OR REPLACE FUNCTION public.contact_companies_same_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_account UUID;
BEGIN
  SELECT c.account_id INTO v_contact_account FROM contacts c WHERE c.id = NEW.contact_id;
  IF v_contact_account IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM companies co
        WHERE co.id = NEW.company_id AND co.account_id = v_contact_account)
  THEN
    RAISE EXCEPTION 'Contact or company not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.account_id := v_contact_account;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.contact_companies_same_account() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.contact_companies_same_account() FROM PUBLIC;

-- Trigger names sort alphabetically — integrity (a_) runs before the
-- primary bookkeeping (b_).
DROP TRIGGER IF EXISTS contact_companies_a_same_account ON contact_companies;
CREATE TRIGGER contact_companies_a_same_account
  BEFORE INSERT OR UPDATE OF contact_id, company_id, account_id ON contact_companies
  FOR EACH ROW EXECUTE FUNCTION public.contact_companies_same_account();

-- 2b. One primary per contact, maintained in the same statement.
CREATE OR REPLACE FUNCTION public.contact_companies_primary()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The contact's first company is its primary one.
    IF NOT NEW.is_primary AND NOT EXISTS (
      SELECT 1 FROM contact_companies WHERE contact_id = NEW.contact_id
    ) THEN
      NEW.is_primary := TRUE;
    END IF;
  END IF;

  IF NEW.is_primary AND (TG_OP = 'INSERT' OR NOT OLD.is_primary) THEN
    UPDATE contact_companies
       SET is_primary = FALSE
     WHERE contact_id = NEW.contact_id
       AND company_id <> NEW.company_id
       AND is_primary;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.contact_companies_primary() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.contact_companies_primary() FROM PUBLIC;

DROP TRIGGER IF EXISTS contact_companies_b_primary ON contact_companies;
CREATE TRIGGER contact_companies_b_primary
  BEFORE INSERT OR UPDATE OF is_primary ON contact_companies
  FOR EACH ROW EXECUTE FUNCTION public.contact_companies_primary();

-- 2c. The primary link went away (unlink, or the company was
-- deleted): the oldest remaining link takes over. Skipped when the
-- contact itself is gone (its links are cascading away too).
CREATE OR REPLACE FUNCTION public.contact_companies_promote_primary()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.is_primary
     AND EXISTS (SELECT 1 FROM contacts WHERE id = OLD.contact_id)
     AND NOT EXISTS (
       SELECT 1 FROM contact_companies WHERE contact_id = OLD.contact_id AND is_primary)
  THEN
    UPDATE contact_companies
       SET is_primary = TRUE
     WHERE (contact_id, company_id) = (
       SELECT cc.contact_id, cc.company_id
         FROM contact_companies cc
        WHERE cc.contact_id = OLD.contact_id
        ORDER BY cc.created_at, cc.company_id
        LIMIT 1
     );
  END IF;
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.contact_companies_promote_primary() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.contact_companies_promote_primary() FROM PUBLIC;

DROP TRIGGER IF EXISTS contact_companies_promote_primary ON contact_companies;
CREATE TRIGGER contact_companies_promote_primary
  AFTER DELETE ON contact_companies
  FOR EACH ROW EXECUTE FUNCTION public.contact_companies_promote_primary();

-- ============================================================
-- 3. DEALS.COMPANY_ID
-- ============================================================
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deals_company
  ON deals(company_id) WHERE company_id IS NOT NULL;

COMMENT ON COLUMN deals.company_id IS
  'Customer company of the deal (migration 054). Optional; same account as the deal (trigger deals_company_same_account).';

CREATE OR REPLACE FUNCTION public.deals_company_same_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.company_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR NEW.company_id IS DISTINCT FROM OLD.company_id
          OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND NOT EXISTS (
       SELECT 1 FROM companies co
        WHERE co.id = NEW.company_id AND co.account_id = NEW.account_id)
  THEN
    RAISE EXCEPTION 'Company not found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.deals_company_same_account() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.deals_company_same_account() FROM PUBLIC;

DROP TRIGGER IF EXISTS deals_company_same_account ON deals;
CREATE TRIGGER deals_company_same_account
  BEFORE INSERT OR UPDATE OF company_id, account_id ON deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_company_same_account();

-- ============================================================
-- 4. RLS — viewer+ reads, agent+ writes (contacts / deals tiers)
-- ============================================================
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS companies_select ON companies;
CREATE POLICY companies_select ON companies FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS companies_insert ON companies;
CREATE POLICY companies_insert ON companies FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS companies_update ON companies;
CREATE POLICY companies_update ON companies FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS companies_delete ON companies;
CREATE POLICY companies_delete ON companies FOR DELETE
  USING (is_account_member(account_id, 'agent'));

ALTER TABLE contact_companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_companies_select ON contact_companies;
CREATE POLICY contact_companies_select ON contact_companies FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS contact_companies_insert ON contact_companies;
CREATE POLICY contact_companies_insert ON contact_companies FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS contact_companies_update ON contact_companies;
CREATE POLICY contact_companies_update ON contact_companies FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS contact_companies_delete ON contact_companies;
CREATE POLICY contact_companies_delete ON contact_companies FOR DELETE
  USING (is_account_member(account_id, 'agent'));

REVOKE ALL ON companies, contact_companies FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON companies, contact_companies TO authenticated;
GRANT ALL ON companies, contact_companies TO service_role;

NOTIFY pgrst, 'reload schema';
