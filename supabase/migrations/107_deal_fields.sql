-- ============================================================
-- 107 — Deal fields (numbers per deal) and formula fields.
--
-- 1. deal_fields: the fields an admin defines for the deals of an account.
--    kind = number | currency | percent | formula. A formula field has an
--    expression (the app limits what the admin types to 300 chars; stored it
--    carries field ids instead of names, so the column allows 4000) and a
--    result_format; the other kinds have neither (CHECK). Name is unique per
--    account ignoring case and spaces. At most 50 fields per account and at
--    most 2 with show_on_card (guard trigger, serialized per account).
--    Whether a field is a formula never changes after creation.
--    Admin writes, every member reads.
-- 2. deal_field_values: the number a deal has for a field, key (deal_id,
--    field_id). The guard stamps account_id from the deal, refuses a field of
--    another account and a formula field (formulas are computed in the app,
--    never stored). Whoever edits the deal (agent and above) writes values.
--    Deleting a field or a deal cascades to the values. Values have at most 4 decimals.
-- 3. Billing block (094): RESTRICTIVE INSERT/UPDATE/DELETE policies with
--    private.account_is_writable on both tables.
--
-- Guards are SECURITY INVOKER with a pinned search_path (073/104 style): deals and
-- fields are read under the caller's RLS, so another tenant's id looks like a
-- missing row. Grants follow 076/104.
-- Rollback: supabase/rollback/107_rollback.sql. SQL test: supabase/tests/deal_fields.sql.
-- Idempotent.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---- deal_fields ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deal_fields (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  expression    TEXT,
  result_format TEXT,
  show_on_card  BOOLEAN NOT NULL DEFAULT FALSE,
  position      INTEGER NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.deal_fields DROP CONSTRAINT IF EXISTS deal_fields_name_check;
ALTER TABLE public.deal_fields ADD CONSTRAINT deal_fields_name_check CHECK (
  char_length(name) <= 40 AND btrim(name, E' \t\r\n') <> ''
  AND name !~ '[{}]'
  -- no control characters and no leading/trailing Unicode whitespace: what the app trims is what is stored,
  -- so the reserved-name and unique checks see the same text the formula editor matches on
  AND name !~ '[\x01-\x1f\x7f]'
  AND name !~ '^[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]'
  AND name !~ '[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]$'
  AND lower(btrim(name)) NOT IN ('valor', 'chance', 'itens', 'dias para fechar')  -- names of the built-in formula variables
);
ALTER TABLE public.deal_fields DROP CONSTRAINT IF EXISTS deal_fields_kind_check;
ALTER TABLE public.deal_fields ADD CONSTRAINT deal_fields_kind_check CHECK (kind IN ('number', 'currency', 'percent', 'formula'));
ALTER TABLE public.deal_fields DROP CONSTRAINT IF EXISTS deal_fields_result_format_check;
ALTER TABLE public.deal_fields ADD CONSTRAINT deal_fields_result_format_check CHECK (result_format IS NULL OR result_format IN ('number', 'currency', 'percent'));
ALTER TABLE public.deal_fields DROP CONSTRAINT IF EXISTS deal_fields_formula_check;
ALTER TABLE public.deal_fields ADD CONSTRAINT deal_fields_formula_check CHECK (
  (kind = 'formula' AND expression IS NOT NULL AND result_format IS NOT NULL
     AND char_length(expression) <= 4000 AND btrim(expression, E' \t\r\n') <> '')
  OR (kind <> 'formula' AND expression IS NULL AND result_format IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_fields_name ON public.deal_fields (account_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_deal_fields_account ON public.deal_fields (account_id, position);

DROP TRIGGER IF EXISTS set_updated_at ON public.deal_fields;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.deal_fields
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- deal_field_values --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deal_field_values (
  deal_id    UUID NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  field_id   UUID NOT NULL REFERENCES public.deal_fields(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  value      NUMERIC NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deal_id, field_id)
);
-- BETWEEN rejects NaN (a plain comparison would let it through) and infinity.
ALTER TABLE public.deal_field_values DROP CONSTRAINT IF EXISTS deal_field_values_value_check;
ALTER TABLE public.deal_field_values ADD CONSTRAINT deal_field_values_value_check CHECK (value BETWEEN -999999999999 AND 999999999999 AND scale(value) <= 4);

CREATE INDEX IF NOT EXISTS idx_deal_field_values_field ON public.deal_field_values (field_id);
CREATE INDEX IF NOT EXISTS idx_deal_field_values_account ON public.deal_field_values (account_id);

DROP TRIGGER IF EXISTS set_updated_at ON public.deal_field_values;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.deal_field_values
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- guards ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deal_fields_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- created_by is who really created it: the session user, never what the client sent.
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(auth.uid(), NEW.created_by);
  ELSE
    NEW.created_by := OLD.created_by;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
      RAISE EXCEPTION 'the account of a field never changes' USING ERRCODE = '23514';
    END IF;
    IF (NEW.kind = 'formula') IS DISTINCT FROM (OLD.kind = 'formula') THEN
      RAISE EXCEPTION 'a field cannot become a formula or stop being one' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Serialize the limit checks of one account (two concurrent inserts must not both pass).
  IF TG_OP = 'INSERT' OR (NEW.show_on_card AND NOT OLD.show_on_card) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('deal_fields:' || NEW.account_id::text, 0));
  END IF;
  IF TG_OP = 'INSERT' AND (SELECT count(*) FROM public.deal_fields f WHERE f.account_id = NEW.account_id) >= 50 THEN
    RAISE EXCEPTION 'deal_fields_limit: an account can have at most 50 deal fields' USING ERRCODE = '54000';
  END IF;
  IF NEW.show_on_card AND (TG_OP = 'INSERT' OR NOT OLD.show_on_card)
     AND (SELECT count(*) FROM public.deal_fields f WHERE f.account_id = NEW.account_id AND f.show_on_card AND f.id <> NEW.id) >= 2 THEN
    RAISE EXCEPTION 'deal_fields_card_limit: at most 2 fields can show on the card' USING ERRCODE = '54000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.deal_fields_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS deal_fields_guard ON public.deal_fields;
CREATE TRIGGER deal_fields_guard BEFORE INSERT OR UPDATE ON public.deal_fields
  FOR EACH ROW EXECUTE FUNCTION public.deal_fields_guard();

CREATE OR REPLACE FUNCTION public.deal_field_values_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_kind    text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.deal_id IS DISTINCT FROM OLD.deal_id OR NEW.field_id IS DISTINCT FROM OLD.field_id) THEN
    RAISE EXCEPTION 'the deal and field of a value never change' USING ERRCODE = '23514';
  END IF;
  SELECT d.account_id INTO v_account FROM public.deals d WHERE d.id = NEW.deal_id;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'deal not found' USING ERRCODE = '23503';
  END IF;
  -- account_id always comes from the deal: whatever the client sent is replaced.
  NEW.account_id := v_account;
  SELECT f.kind INTO v_kind FROM public.deal_fields f WHERE f.id = NEW.field_id AND f.account_id = v_account;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'field does not belong to this account' USING ERRCODE = '23503';
  END IF;
  IF v_kind = 'formula' THEN
    RAISE EXCEPTION 'a formula field has no stored value' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.deal_field_values_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS deal_field_values_guard ON public.deal_field_values;
CREATE TRIGGER deal_field_values_guard BEFORE INSERT OR UPDATE ON public.deal_field_values
  FOR EACH ROW EXECUTE FUNCTION public.deal_field_values_guard();

-- ---- sums of the item lines for many deals ({Itens} on the board cards) ----------------
-- One row per deal that has items, aggregated here: a plain select of the lines would be cut at
-- PostgREST max_rows. SECURITY INVOKER: deal_items RLS decides what the caller sees.
CREATE OR REPLACE FUNCTION public.deal_items_sums(p_deal_ids uuid[])
RETURNS TABLE (deal_id uuid, total numeric)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT i.deal_id, sum(i.line_total)
  FROM public.deal_items i
  WHERE i.deal_id = ANY (p_deal_ids)
  GROUP BY i.deal_id
$$;
REVOKE ALL ON FUNCTION public.deal_items_sums(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deal_items_sums(uuid[]) TO authenticated, service_role;

-- ---- grants (076 / 104 style) ----------------------------------------------------
REVOKE ALL ON public.deal_fields FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deal_fields TO authenticated;
GRANT ALL ON public.deal_fields TO service_role;
REVOKE ALL ON public.deal_field_values FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deal_field_values TO authenticated;
GRANT ALL ON public.deal_field_values TO service_role;

-- ---- RLS ---------------------------------------------------------------------------
ALTER TABLE public.deal_fields ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_fields_select ON public.deal_fields;
CREATE POLICY deal_fields_select ON public.deal_fields FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS deal_fields_insert ON public.deal_fields;
CREATE POLICY deal_fields_insert ON public.deal_fields FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS deal_fields_update ON public.deal_fields;
CREATE POLICY deal_fields_update ON public.deal_fields FOR UPDATE
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS deal_fields_delete ON public.deal_fields;
CREATE POLICY deal_fields_delete ON public.deal_fields FOR DELETE USING (public.is_account_member(account_id, 'admin'));

ALTER TABLE public.deal_field_values ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_field_values_select ON public.deal_field_values;
CREATE POLICY deal_field_values_select ON public.deal_field_values FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS deal_field_values_insert ON public.deal_field_values;
CREATE POLICY deal_field_values_insert ON public.deal_field_values FOR INSERT WITH CHECK (public.is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS deal_field_values_update ON public.deal_field_values;
CREATE POLICY deal_field_values_update ON public.deal_field_values FOR UPDATE
  USING (public.is_account_member(account_id, 'agent'))
  WITH CHECK (public.is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS deal_field_values_delete ON public.deal_field_values;
CREATE POLICY deal_field_values_delete ON public.deal_field_values FOR DELETE USING (public.is_account_member(account_id, 'agent'));

-- 094: a read-only (billing) account does not write.
DROP POLICY IF EXISTS deal_fields_readonly_insert ON public.deal_fields;
CREATE POLICY deal_fields_readonly_insert ON public.deal_fields AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deal_fields_readonly_update ON public.deal_fields;
CREATE POLICY deal_fields_readonly_update ON public.deal_fields AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deal_fields_readonly_delete ON public.deal_fields;
CREATE POLICY deal_fields_readonly_delete ON public.deal_fields AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deal_field_values_readonly_insert ON public.deal_field_values;
CREATE POLICY deal_field_values_readonly_insert ON public.deal_field_values AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deal_field_values_readonly_update ON public.deal_field_values;
CREATE POLICY deal_field_values_readonly_update ON public.deal_field_values AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deal_field_values_readonly_delete ON public.deal_field_values;
CREATE POLICY deal_field_values_readonly_delete ON public.deal_field_values AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

NOTIFY pgrst, 'reload schema';
COMMIT;
