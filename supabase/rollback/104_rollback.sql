-- Rollback of 104_products_deal_items.sql. NOT a migration: run by hand (as postgres).
-- Roll the APP back first (the deal drawer and Settings -> Produtos read these tables).
-- Drops the catalog and every deal line (data loss); deals keep their last computed value.
BEGIN;
DROP TRIGGER IF EXISTS deals_value_from_items ON public.deals;
DROP TABLE IF EXISTS public.deal_items;  -- takes its policies, triggers and indexes along
DROP TABLE IF EXISTS public.products;
DROP FUNCTION IF EXISTS public.deals_value_from_items();
DROP FUNCTION IF EXISTS public.deal_items_recompute();
DROP FUNCTION IF EXISTS private.deal_items_sum(uuid);
DROP FUNCTION IF EXISTS public.deal_items_guard();
DROP FUNCTION IF EXISTS public.products_guard();
NOTIFY pgrst, 'reload schema';
COMMIT;
