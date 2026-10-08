\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.check_plan(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;
SELECT pg_temp.check_plan((SELECT count(*) = 4 FROM public.platform_plan_catalog), 'four initial plans');
SELECT pg_temp.check_plan((SELECT definition->'limits' = '{"max_users":10,"max_channels":2}'::jsonb AND price_monthly_cents=8990 FROM public.platform_plan_versions WHERE plan='pro' AND revision=1), 'initial Pro preserves limits and price');
SELECT pg_temp.check_plan((SELECT price_monthly_cents=5990 FROM public.platform_plan_versions WHERE plan='basico' AND revision=1), 'Basic price in cents');
SELECT pg_temp.check_plan(NOT EXISTS(SELECT 1 FROM public.accounts WHERE plan_version_id IS NULL), 'existing companies assigned');
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 ('39000000-0000-4000-8000-000000000001','admin@plan.test','{"full_name":"Catalog admin"}'),
 ('39000000-0000-4000-8000-000000000002','tenant@plan.test','{"full_name":"Catalog tenant"}');
INSERT INTO public.platform_admins(user_id) VALUES ('39000000-0000-4000-8000-000000000001');
SELECT pg_temp.check_plan((SELECT v.plan='trial' AND v.price_monthly_cents=0 FROM public.accounts a JOIN public.platform_plan_versions v ON v.id=a.plan_version_id WHERE a.owner_user_id='39000000-0000-4000-8000-000000000002'), 'signup granted current free trial');
SET LOCAL ROLE anon;
SELECT pg_temp.check_plan((SELECT count(*)=4 FROM public.public_plan_catalog()), 'anonymous current catalog');
DO $$ BEGIN PERFORM * FROM public.platform_plan_versions; RAISE EXCEPTION 'anonymous history allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','39000000-0000-4000-8000-000000000002',true);
SELECT pg_temp.check_plan((SELECT count(*)=1 FROM (SELECT id FROM public.platform_plan_versions) v), 'tenant reads assigned revision only');
DO $$ BEGIN UPDATE public.accounts SET plan_version_id=gen_random_uuid() WHERE owner_user_id=auth.uid(); RAISE EXCEPTION 'tenant assigned own version'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN INSERT INTO public.platform_plan_catalog(plan,current_version_id) VALUES ('pro',gen_random_uuid()); RAISE EXCEPTION 'tenant writes catalog'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM public.platform_save_plan_version('pro',(SELECT id FROM public.platform_plan_versions LIMIT 1),'{}',1,auth.uid()); RAISE EXCEPTION 'tenant invokes writer'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
CREATE TEMP TABLE prior_company AS SELECT id,plan,plan_status,plan_expires_at,module_overrides,limit_overrides,plan_version_id FROM public.accounts;
CREATE TEMP TABLE saved_version(id uuid);
GRANT ALL ON saved_version TO service_role;
SET LOCAL ROLE service_role;
INSERT INTO saved_version SELECT id FROM public.platform_save_plan_version('pro',(SELECT current_version_id FROM public.platform_plan_catalog WHERE plan='pro'),'{"modules":["tasks"],"limits":{"max_users":20,"max_channels":3}}',9990,'39000000-0000-4000-8000-000000000001');
RESET ROLE;
SELECT pg_temp.check_plan(NOT EXISTS(SELECT * FROM prior_company EXCEPT SELECT id,plan,plan_status,plan_expires_at,module_overrides,limit_overrides,plan_version_id FROM public.accounts), 'editing catalog preserves every company');
SELECT pg_temp.check_plan((SELECT revision=2 AND actor_name='Catalog admin' FROM public.platform_plan_versions WHERE id=(SELECT id FROM saved_version)), 'new revision has author snapshot');
SET LOCAL ROLE service_role;
SELECT pg_temp.check_plan((SELECT id=(SELECT id FROM saved_version) FROM public.platform_save_plan_version('pro',(SELECT id FROM saved_version),'{"modules":["tasks"],"limits":{"max_users":20,"max_channels":3}}',9990,'39000000-0000-4000-8000-000000000001')), 'retry identical save does not duplicate history');
DO $$ BEGIN PERFORM public.platform_save_plan_version('pro',(SELECT id FROM public.platform_plan_versions WHERE plan='pro' AND revision=1),'{"modules":[],"limits":{"max_users":2,"max_channels":1}}',8990,'39000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'stale version accepted'; EXCEPTION WHEN serialization_failure THEN NULL; END $$;
DO $$ BEGIN PERFORM public.platform_save_plan_version('pro',(SELECT id FROM saved_version),'{"modules":["password"],"limits":{"max_users":20,"max_channels":3}}',9990,'39000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'unknown module accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN PERFORM public.platform_save_plan_version('pro',(SELECT id FROM saved_version),'{"modules":[],"limits":{"max_users":1.5,"max_channels":3}}',9990,'39000000-0000-4000-8000-000000000001'); RAISE EXCEPTION 'fractional capacity accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN PERFORM public.platform_save_plan_version('pro',(SELECT id FROM saved_version),'{"modules":[],"limits":{"max_users":2,"max_channels":3}}',9990,'39000000-0000-4000-8000-000000000002'); RAISE EXCEPTION 'tenant actor accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN UPDATE public.platform_plan_versions SET revision=99 WHERE id=(SELECT id FROM saved_version); RAISE EXCEPTION 'immutable version edited'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
DELETE FROM public.accounts WHERE owner_user_id='39000000-0000-4000-8000-000000000001';
DELETE FROM auth.users WHERE id='39000000-0000-4000-8000-000000000001';
SELECT pg_temp.check_plan((SELECT actor_name='Catalog admin' FROM public.platform_plan_versions WHERE id=(SELECT id FROM saved_version)), 'history survives actor deletion');
ROLLBACK;
