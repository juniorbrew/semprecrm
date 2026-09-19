\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $$;

-- Real auth inserts run the unchanged signup bootstrap and its account trigger.
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
 ('10000000-0000-4000-8000-000000000001','admin@leads.test','{"full_name":"Platform admin"}'),
 ('10000000-0000-4000-8000-000000000002','tenant-a@leads.test','{"full_name":"Tenant A"}'),
 ('10000000-0000-4000-8000-000000000003','tenant-b@leads.test','{"full_name":"Tenant B"}');
INSERT INTO public.platform_admins(user_id) VALUES ('10000000-0000-4000-8000-000000000001');
SELECT pg_temp.assert_true((SELECT count(*)=3 FROM public.leads WHERE email LIKE '%@leads.test' AND kind='cadastro'),'signup captures one each');
SELECT pg_temp.assert_true((SELECT count(*)=3 FROM public.profiles WHERE email LIKE '%@leads.test'),'signup profiles preserved');
INSERT INTO public.contact_submissions(id,name,email,company,message) VALUES
 ('20000000-0000-4000-8000-000000000001','<script>alert(1)</script>','contact@leads.test','Acme_100%','Contact message');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.leads WHERE contact_submission_id='20000000-0000-4000-8000-000000000001'),'contact captures exactly once');
DO $$ BEGIN
  INSERT INTO public.leads(kind,name,email,contact_submission_id) VALUES ('contato','duplicate','x','20000000-0000-4000-8000-000000000001');
  RAISE EXCEPTION 'duplicate accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO public.leads(kind,name,email,account_id) SELECT 'cadastro','duplicate','x',id FROM public.accounts WHERE owner_user_id='10000000-0000-4000-8000-000000000002';
  RAISE EXCEPTION 'duplicate signup accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO public.leads(kind,name,email,account_id) SELECT 'contato','wrong kind','x',id FROM public.accounts LIMIT 1;
  RAISE EXCEPTION 'wrong source accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;

SET LOCAL ROLE anon;
DO $$ BEGIN PERFORM * FROM public.leads; RAISE EXCEPTION 'anon select accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM public.platform_list_leads(); RAISE EXCEPTION 'anon rpc accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.leads),'tenant A sees no leads');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.accounts),'tenant A sees only own account');
DO $$ BEGIN PERFORM public.platform_list_leads(); RAISE EXCEPTION 'tenant rpc accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM public.platform_update_lead_status('20000000-0000-4000-8000-000000000001','novo'); RAISE EXCEPTION 'tenant status accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN INSERT INTO public.leads(kind,name,email) VALUES('contato','x','x'); RAISE EXCEPTION 'tenant insert accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN UPDATE public.leads SET status='convertido'; RAISE EXCEPTION 'tenant update accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN DELETE FROM public.leads; RAISE EXCEPTION 'tenant delete accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM public.claim_lead_notifications(); RAISE EXCEPTION 'tenant claim accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM * FROM public.lead_push_deliveries; RAISE EXCEPTION 'tenant receipts accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000003',true);
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.leads),'tenant B sees no leads');
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM public.accounts),'tenant B sees only own account');
DO $$ BEGIN PERFORM public.platform_list_leads(); RAISE EXCEPTION 'tenant B rpc accepted'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
SELECT pg_temp.assert_true((public.platform_list_leads(1,0,NULL,NULL,'@leads.test')->>'total')::int=4,'admin total and limit');
SELECT pg_temp.assert_true(jsonb_array_length(public.platform_list_leads(1,0,NULL,NULL,'@leads.test')->'leads')=1,'bounded pagination');
SELECT pg_temp.assert_true((public.platform_list_leads(25,0,NULL,NULL,'Acme_100%')->>'total')::int=1,'literal wildcard search');
SELECT pg_temp.assert_true((public.platform_list_leads(25,0,NULL,NULL,$x$' OR 1=1--$x$)->>'total')::int=0,'SQL injection is literal');
SELECT pg_temp.assert_true(public.platform_update_lead_status((SELECT id FROM public.leads WHERE email='contact@leads.test'),'convertido')->>'status'='convertido','admin status update');
DO $$ BEGIN PERFORM public.platform_update_lead_status('00000000-0000-4000-8000-000000000000','novo'); RAISE EXCEPTION 'missing accepted'; EXCEPTION WHEN no_data_found THEN NULL; END $$;
DO $$ BEGIN PERFORM public.platform_update_lead_status('00000000-0000-4000-8000-000000000000','bad'); RAISE EXCEPTION 'bad status accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN PERFORM public.platform_list_leads(1000); RAISE EXCEPTION 'unbounded accepted'; EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
RESET ROLE;

-- A failing lead insert must not abort the originating contact or signup.
CREATE FUNCTION pg_temp.reject_lead() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic secret must not appear in capture warning'; END $$;
CREATE TRIGGER test_reject_lead BEFORE INSERT ON public.leads FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_lead();
INSERT INTO public.contact_submissions(name,email,message) VALUES('Survives','survives@leads.test','message');
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES('10000000-0000-4000-8000-000000000004','survives-signup@leads.test','{}');
SELECT pg_temp.assert_true(EXISTS(SELECT 1 FROM public.contact_submissions WHERE email='survives@leads.test'),'contact survives capture failure');
SELECT pg_temp.assert_true(EXISTS(SELECT 1 FROM public.profiles WHERE email='survives-signup@leads.test'),'signup survives capture failure');
DROP TRIGGER test_reject_lead ON public.leads;

DELETE FROM public.contact_submissions WHERE id='20000000-0000-4000-8000-000000000001';
SELECT pg_temp.assert_true(EXISTS(SELECT 1 FROM public.leads WHERE email='contact@leads.test' AND contact_submission_id IS NULL),'deleted source preserves history');
DELETE FROM public.accounts WHERE owner_user_id='10000000-0000-4000-8000-000000000003';
SELECT pg_temp.assert_true(EXISTS(SELECT 1 FROM public.leads WHERE email='tenant-b@leads.test' AND account_id IS NULL),'deleted account preserves history');

-- Isolate eligible fixtures without committing changes to other rows.
UPDATE public.leads SET notification_next_attempt_at=now()+interval '1 day';
UPDATE public.leads SET notification_next_attempt_at=now() WHERE email='contact@leads.test';
SET LOCAL ROLE service_role;
CREATE TEMP TABLE first_claim AS SELECT * FROM public.claim_lead_notifications();
SELECT pg_temp.assert_true((SELECT count(*)=1 FROM first_claim),'claim succeeds');
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.claim_lead_notifications()),'active claim not reissued');
SELECT pg_temp.assert_true(public.complete_lead_notification((SELECT id FROM first_claim),(SELECT notification_claim_token FROM first_claim),false),'failure releases claim');
SELECT pg_temp.assert_true((SELECT notified_at IS NULL AND notification_claimed_at IS NULL AND notification_attempts=1 AND notification_next_attempt_at>now() FROM public.leads WHERE id=(SELECT id FROM first_claim)),'failure backoff without success stamp');
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.claim_lead_notifications()),'backoff suppresses aggressive retry');
UPDATE public.leads SET notification_next_attempt_at=now() WHERE id=(SELECT id FROM first_claim);
CREATE TEMP TABLE second_claim AS SELECT * FROM public.claim_lead_notifications();
SELECT pg_temp.assert_true(NOT public.complete_lead_notification((SELECT id FROM first_claim),(SELECT notification_claim_token FROM first_claim),true),'stale token fenced');
UPDATE public.leads SET notification_claimed_at=now()-interval '6 minutes' WHERE id=(SELECT id FROM first_claim);
CREATE TEMP TABLE third_claim AS SELECT * FROM public.claim_lead_notifications();
SELECT pg_temp.assert_true((SELECT notification_attempts=3 FROM third_claim),'expired claim recovered');
SELECT pg_temp.assert_true(public.complete_lead_notification((SELECT id FROM third_claim),(SELECT notification_claim_token FROM third_claim),true),'successful delivery finalized');
SELECT pg_temp.assert_true((SELECT notified_at IS NOT NULL AND notification_claimed_at IS NULL FROM public.leads WHERE id=(SELECT id FROM first_claim)),'success stamp only after delivery');
SELECT pg_temp.assert_true((SELECT count(*)=0 FROM public.claim_lead_notifications()),'no re-send after success');
RESET ROLE;
ROLLBACK;
\echo 'PASS platform leads database: triggers, RLS, tenants, CRUD, injection, duplicates, history, nonblocking failures, claims, retry, fencing'
