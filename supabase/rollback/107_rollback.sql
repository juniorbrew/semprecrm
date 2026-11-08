-- Rollback of 107_deal_fields.sql. NOT a migration: run by hand (as postgres).
-- Roll the APP back first (Settings -> Campos personalizados -> Negocio and the deal drawer read these tables).
-- Drops every deal field and every value (data loss).
BEGIN;
DROP TABLE IF EXISTS public.deal_field_values;  -- takes its policies, triggers and indexes along
DROP TABLE IF EXISTS public.deal_fields;
DROP FUNCTION IF EXISTS public.deal_items_sums(uuid[]);
DROP FUNCTION IF EXISTS public.deal_field_values_guard();
DROP FUNCTION IF EXISTS public.deal_fields_guard();
NOTIFY pgrst, 'reload schema';
COMMIT;
