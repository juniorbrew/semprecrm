-- ============================================================
-- 104 — Products and services inside the deal.
--
-- 1. products: the account catalog (name, optional code, unit price,
--    short description, archived_at). Name is unique among the active
--    products of an account (case-insensitive). Owner/admin write, every
--    member reads. Products are archived, not deleted, once used; a real
--    DELETE sets deal_items.product_id to NULL (the item keeps its copy).
-- 2. deal_items: lines of a deal. name and unit_price are COPIES taken
--    when the item is added, so the history does not move when the catalog
--    changes. quantity > 0 (2 decimals), discount_pct 0-100, line_total is
--    generated: round(quantity * unit_price * (1 - discount / 100), 2).
--    Whoever can edit the deal (agent and above, same rule as deals) edits
--    its items. deal_id and account_id never change.
-- 3. deals.value = sum(line_total) while the deal has items. Computed here,
--    never in the browser: an AFTER trigger on deal_items recomputes it
--    (locking the deal row so concurrent edits do not lose an update), and a
--    BEFORE UPDATE OF value trigger on deals overrides any direct write with
--    the sum. When the last item is removed the value stays as it was and is
--    editable by hand again. A sum that does not fit NUMERIC(12,2) is
--    rejected with a clear error (22003), never clamped.
-- 4. Guards (073 style, SECURITY INVOKER with a pinned search_path): deal and
--    product must belong to the item's account. A probe for another tenant's
--    row looks like a missing row because they are read under the caller's RLS.
-- 5. Billing block (094): RESTRICTIVE INSERT/UPDATE/DELETE policies with
--    private.account_is_writable on both tables (same shape as 096/103).
--
-- Grants follow 076/096: nothing for PUBLIC/anon; authenticated gets table
-- rights narrowed by RLS; trigger functions are closed.
-- Rollback: supabase/rollback/104_rollback.sql. SQL test: supabase/tests/products_deal_items.sql.
-- Idempotent.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---- products ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.products (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT,
  unit_price  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  description TEXT,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_name_check;
ALTER TABLE public.products ADD CONSTRAINT products_name_check CHECK (char_length(name) <= 80 AND btrim(name, E' \t\r\n') <> '');
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_code_check;
ALTER TABLE public.products ADD CONSTRAINT products_code_check CHECK (code IS NULL OR (char_length(code) <= 40 AND btrim(code, E' \t\r\n') <> ''));
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_price_check;
ALTER TABLE public.products ADD CONSTRAINT products_price_check CHECK (unit_price BETWEEN 0 AND 9999999999.99);
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_description_check;
ALTER TABLE public.products ADD CONSTRAINT products_description_check CHECK (description IS NULL OR char_length(description) <= 300);

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_active_name ON public.products (account_id, lower(btrim(name))) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_account ON public.products (account_id, archived_at);

DROP TRIGGER IF EXISTS set_updated_at ON public.products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- deal_items ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deal_items (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  deal_id      UUID NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  product_id   UUID REFERENCES public.products(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  unit_price   NUMERIC(12, 2) NOT NULL DEFAULT 0,
  quantity     NUMERIC(10, 2) NOT NULL DEFAULT 1,
  discount_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0,
  line_total   NUMERIC GENERATED ALWAYS AS (round(quantity * unit_price * (100 - discount_pct) / 100, 2)) STORED,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.deal_items DROP CONSTRAINT IF EXISTS deal_items_name_check;
ALTER TABLE public.deal_items ADD CONSTRAINT deal_items_name_check CHECK (char_length(name) <= 120 AND btrim(name, E' \t\r\n') <> '');
ALTER TABLE public.deal_items DROP CONSTRAINT IF EXISTS deal_items_price_check;
ALTER TABLE public.deal_items ADD CONSTRAINT deal_items_price_check CHECK (unit_price BETWEEN 0 AND 9999999999.99);
ALTER TABLE public.deal_items DROP CONSTRAINT IF EXISTS deal_items_quantity_check;
ALTER TABLE public.deal_items ADD CONSTRAINT deal_items_quantity_check CHECK (quantity > 0 AND quantity BETWEEN 0 AND 1000000);
ALTER TABLE public.deal_items DROP CONSTRAINT IF EXISTS deal_items_discount_check;
ALTER TABLE public.deal_items ADD CONSTRAINT deal_items_discount_check CHECK (discount_pct BETWEEN 0 AND 100);

CREATE INDEX IF NOT EXISTS idx_deal_items_deal ON public.deal_items (deal_id, position);
CREATE INDEX IF NOT EXISTS idx_deal_items_product ON public.deal_items (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deal_items_account ON public.deal_items (account_id);

DROP TRIGGER IF EXISTS set_updated_at ON public.deal_items;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.deal_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- guards ---------------------------------------------------------------
-- SECURITY INVOKER on purpose (like 094/103): deals and products are read under
-- the caller's RLS, so another tenant's id looks the same as a missing one.
CREATE OR REPLACE FUNCTION public.products_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'the account of a product never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.products_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS products_guard ON public.products;
CREATE TRIGGER products_guard BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.products_guard();

CREATE OR REPLACE FUNCTION public.deal_items_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.deal_id IS DISTINCT FROM OLD.deal_id OR NEW.account_id IS DISTINCT FROM OLD.account_id) THEN
    RAISE EXCEPTION 'the deal and account of an item never change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM public.deals d WHERE d.id = NEW.deal_id AND d.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'deal does not belong to this account' USING ERRCODE = '23503';
  END IF;
  -- At most 200 lines per deal (the drawer and the sum stay small).
  IF TG_OP = 'INSERT' AND (SELECT count(*) FROM public.deal_items i WHERE i.deal_id = NEW.deal_id) >= 200 THEN
    RAISE EXCEPTION 'deal_items_limit: a deal can have at most 200 items' USING ERRCODE = '54000';
  END IF;
  IF NEW.product_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.product_id IS DISTINCT FROM OLD.product_id) AND NOT EXISTS (
    SELECT 1 FROM public.products p WHERE p.id = NEW.product_id AND p.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'product does not belong to this account' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.deal_items_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS deal_items_guard ON public.deal_items;
CREATE TRIGGER deal_items_guard BEFORE INSERT OR UPDATE ON public.deal_items
  FOR EACH ROW EXECUTE FUNCTION public.deal_items_guard();

-- ---- deals.value = sum of the items -------------------------------------------
-- Sum of the items of a deal, NULL when it has none. Raises 22003 when the sum
-- does not fit deals.value (NUMERIC(12,2)). Internal helper for the triggers.
CREATE OR REPLACE FUNCTION private.deal_items_sum(p_deal_id uuid)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sum NUMERIC;
BEGIN
  SELECT sum(i.line_total) INTO v_sum FROM public.deal_items i WHERE i.deal_id = p_deal_id;
  IF v_sum > 9999999999.99 THEN
    RAISE EXCEPTION 'deal_items_total_too_large: the items add up to more than the deal value limit' USING ERRCODE = '22003';
  END IF;
  RETURN v_sum;
END;
$$;
-- In schema private (not exposed by PostgREST, like private.account_is_writable, 094). The
-- invoker's triggers call it, so authenticated needs USAGE on the schema (094) and EXECUTE; it reads under RLS.
REVOKE ALL ON FUNCTION private.deal_items_sum(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.deal_items_sum(uuid) TO authenticated, service_role;

-- AFTER an item changes: lock the deal row (so two concurrent edits queue and the
-- second sums with the first committed), then write the sum. No items left = the
-- value stays as it was. A deleted deal (FK cascade) has no row to lock: nothing to do.
CREATE OR REPLACE FUNCTION public.deal_items_recompute()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deal uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.deal_id ELSE NEW.deal_id END;
  v_sum  NUMERIC;
BEGIN
  -- NO KEY UPDATE, not UPDATE: the FK check of an item INSERT holds KEY SHARE on the deal, and two
  -- concurrent inserts on one deal would deadlock waiting for each other with FOR UPDATE.
  -- NO KEY UPDATE conflicts with itself (edits queue) but not with KEY SHARE.
  PERFORM 1 FROM public.deals d WHERE d.id = v_deal FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    -- Cascade from a deleted deal: nothing to recompute. Anything else means the deal is
    -- invisible to this caller (deals_update RLS tighter than deal_items policies): fail loudly
    -- instead of letting deals.value drift. Keep the deal_items policies in step with deals_*.
    -- (An item DELETE cannot tell the cascade from a hidden deal: pg_trigger_depth() is 1 in both,
    -- and RLS hides a deleted row the same way. It returns quietly; writes still raise.)
    IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'deal not found or not editable by the caller' USING ERRCODE = '42501';
  END IF;
  v_sum := private.deal_items_sum(v_deal);
  IF v_sum IS NOT NULL THEN
    UPDATE public.deals d SET value = v_sum WHERE d.id = v_deal AND d.value IS DISTINCT FROM v_sum;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.deal_items_recompute() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS deal_items_recompute_ins_del ON public.deal_items;
CREATE TRIGGER deal_items_recompute_ins_del AFTER INSERT OR DELETE ON public.deal_items
  FOR EACH ROW EXECUTE FUNCTION public.deal_items_recompute();
-- A product change (SET NULL on product delete) does not move the sum.
DROP TRIGGER IF EXISTS deal_items_recompute_upd ON public.deal_items;
CREATE TRIGGER deal_items_recompute_upd AFTER UPDATE OF quantity, unit_price, discount_pct ON public.deal_items
  FOR EACH ROW EXECUTE FUNCTION public.deal_items_recompute();

-- Any write to deals.value (drawer, AI apply, API) is replaced by the sum while the
-- deal has items. Fires only when value is in the SET list.
CREATE OR REPLACE FUNCTION public.deals_value_from_items()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sum NUMERIC;
BEGIN
  v_sum := private.deal_items_sum(NEW.id);
  IF v_sum IS NOT NULL THEN NEW.value := v_sum; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.deals_value_from_items() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS deals_value_from_items ON public.deals;
CREATE TRIGGER deals_value_from_items BEFORE UPDATE OF value ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_value_from_items();

-- ---- grants (076 / 096 style) ---------------------------------------
REVOKE ALL ON public.products FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;
REVOKE ALL ON public.deal_items FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deal_items TO authenticated;
GRANT ALL ON public.deal_items TO service_role;

-- ---- RLS ------------------------------------------------------------
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS products_insert ON public.products;
CREATE POLICY products_insert ON public.products FOR INSERT WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS products_update ON public.products;
CREATE POLICY products_update ON public.products FOR UPDATE
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS products_delete ON public.products;
CREATE POLICY products_delete ON public.products FOR DELETE USING (public.is_account_member(account_id, 'admin'));

ALTER TABLE public.deal_items ENABLE ROW LEVEL SECURITY;
-- Same tiers as deals (017: deals_select / deals_insert / deals_update / deals_delete). Keep them in
-- step: deal_items_recompute updates deals.value as the caller and raises if it cannot see the deal.
DROP POLICY IF EXISTS deal_items_select ON public.deal_items;
CREATE POLICY deal_items_select ON public.deal_items FOR SELECT USING (public.is_account_member(account_id));
DROP POLICY IF EXISTS deal_items_insert ON public.deal_items;
CREATE POLICY deal_items_insert ON public.deal_items FOR INSERT WITH CHECK (public.is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS deal_items_update ON public.deal_items;
CREATE POLICY deal_items_update ON public.deal_items FOR UPDATE
  USING (public.is_account_member(account_id, 'agent'))
  WITH CHECK (public.is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS deal_items_delete ON public.deal_items;
CREATE POLICY deal_items_delete ON public.deal_items FOR DELETE USING (public.is_account_member(account_id, 'agent'));

-- 094: a read-only (billing) account does not write.
DROP POLICY IF EXISTS products_readonly_insert ON public.products;
CREATE POLICY products_readonly_insert ON public.products AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS products_readonly_update ON public.products;
CREATE POLICY products_readonly_update ON public.products AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS products_readonly_delete ON public.products;
CREATE POLICY products_readonly_delete ON public.products AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deal_items_readonly_insert ON public.deal_items;
CREATE POLICY deal_items_readonly_insert ON public.deal_items AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deal_items_readonly_update ON public.deal_items;
CREATE POLICY deal_items_readonly_update ON public.deal_items AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deal_items_readonly_delete ON public.deal_items;
CREATE POLICY deal_items_readonly_delete ON public.deal_items AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

NOTIFY pgrst, 'reload schema';
COMMIT;
