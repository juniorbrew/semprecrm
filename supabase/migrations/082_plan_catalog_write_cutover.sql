-- Apply only AFTER the version-aware application is healthy.
-- Keep data and history on rollback; never reopen this unaudited writer.
BEGIN;
REVOKE ALL ON FUNCTION public.platform_update_account(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
