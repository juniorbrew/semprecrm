-- Rollback of 112_platform_usage.sql. NOT a migration: run by hand (as postgres).
-- Roll the APP back first (/platform/usage calls platform_usage). No data is lost: it only reads.
BEGIN;
DROP FUNCTION IF EXISTS public.platform_usage(date);
COMMIT;
