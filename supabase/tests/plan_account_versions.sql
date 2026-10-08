\set ON_ERROR_STOP on
BEGIN;
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 ('39000000-0000-4000-8000-000000000011','admin-account@plan.test','{"full_name":"Account admin"}'),
 ('39000000-0000-4000-8000-000000000012','account@plan.test','{"full_name":"Account tenant"}');
INSERT INTO public.platform_admins(user_id) VALUES ('39000000-0000-4000-8000-000000000011');
CREATE TEMP TABLE assigned_before AS SELECT id,plan_version_id FROM public.accounts WHERE owner_user_id='39000000-0000-4000-8000-000000000012';
GRANT SELECT ON assigned_before TO service_role;
SET LOCAL ROLE service_role;
SELECT public.platform_update_account_v2((SELECT id FROM assigned_before),'{"platform_notes":"preserve","plan_status":"active"}','39000000-0000-4000-8000-000000000011');
RESET ROLE;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM assigned_before b JOIN public.accounts a USING(id) WHERE a.plan_version_id<>b.plan_version_id) THEN RAISE EXCEPTION 'Status adopted new conditions'; END IF; END $$;
SET LOCAL ROLE service_role;
DO $$ BEGIN PERFORM public.platform_update_account_v2((SELECT id FROM assigned_before),'{"plan":"pro"}','39000000-0000-4000-8000-000000000011',gen_random_uuid(),false); RAISE EXCEPTION 'Stale preview accepted'; EXCEPTION WHEN serialization_failure THEN NULL; END $$;
SELECT public.platform_update_account_v2((SELECT id FROM assigned_before),'{"plan":"pro","limit_overrides":{"max_users":3}}','39000000-0000-4000-8000-000000000011',(SELECT current_version_id FROM public.platform_plan_catalog WHERE plan='pro'),false);
SELECT public.platform_save_plan_version('pro',(SELECT current_version_id FROM public.platform_plan_catalog WHERE plan='pro'),'{"modules":["tasks"],"limits":{"max_users":20,"max_channels":3}}',9990,'39000000-0000-4000-8000-000000000011');
SELECT public.platform_update_account_v2((SELECT id FROM assigned_before),'{"platform_notes":"still old"}','39000000-0000-4000-8000-000000000011');
RESET ROLE;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM public.accounts a JOIN public.platform_plan_versions v ON a.plan_version_id=v.id WHERE a.id=(SELECT id FROM assigned_before) AND v.revision=1 AND a.limit_overrides='{"max_users":3}'::jsonb) THEN RAISE EXCEPTION 'Notes changed assigned terms'; END IF; END $$;
SET LOCAL ROLE service_role;
SELECT public.platform_update_account_v2((SELECT id FROM assigned_before),'{}','39000000-0000-4000-8000-000000000011',(SELECT current_version_id FROM public.platform_plan_catalog WHERE plan='pro'),true);
RESET ROLE;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.accounts a JOIN public.platform_plan_versions v ON a.plan_version_id=v.id WHERE a.id=(SELECT id FROM assigned_before) AND v.revision=2 AND a.limit_overrides='{"max_users":3}'::jsonb) THEN RAISE EXCEPTION 'Adoption lost override'; END IF;
 IF (SELECT count(*) FROM public.audit_log WHERE account_id=(SELECT id FROM assigned_before) AND metadata ? 'plan_version_change') <> 2 THEN RAISE EXCEPTION 'Atomic adoption history missing or duplicated'; END IF;
END $$;
ROLLBACK;
