-- ============================================================
-- Migration 114 (extras além do plano): preços opcionais no JSON da versão do plano
-- (valid_plan_definition), colunas de extras em account_billing (faixas, preço travado
-- obrigatório), e quem pode ler/gravar: admin lê a PRÓPRIA linha, ninguém do cliente grava,
-- agente e anon nada, service_role grava. Nada é gravado (termina em ROLLBACK).
--
-- Nota: o banco NAO tem gatilho de max_users / max_channels; o limite real (plano + extras)
-- vale no servidor (resolveEntitlements, testado em Vitest). Aqui fica o que o banco garante.
--
-- Precisa do banco local migrado até a 113; aplique a 114 na mesma rodada (tem BEGIN/COMMIT
-- próprio e é idempotente nos objetos que cria com IF NOT EXISTS; rode so uma vez por banco):
--   (cat supabase/migrations/114_plan_extras.sql supabase/tests/plan_extras.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- Nunca rode `supabase db reset`.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual numeric, expected numeric, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
CREATE FUNCTION pg_temp.assert_fails_with(stmt text, state text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = state THEN RETURN; END IF;
    RAISE EXCEPTION 'FAIL (wrong error %: %): %', SQLSTATE, SQLERRM, label;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;
CREATE FUNCTION pg_temp.rows(stmt text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN EXECUTE stmt; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- tenants: A (owner, admin, agent) and B (owner) --------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('11400000-0000-4000-8000-00000000000a', 'owner-a@ext.test', '{"full_name":"Owner A"}'),
 ('11400000-0000-4000-8000-00000000000b', 'owner-b@ext.test', '{"full_name":"Owner B"}'),
 ('11400000-0000-4000-8000-00000000000c', 'agent@ext.test', '{"full_name":"Agent"}'),
 ('11400000-0000-4000-8000-00000000000e', 'admin@ext.test', '{"full_name":"Admin"}');
CREATE TEMP TABLE ctx AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '11400000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '11400000-0000-4000-8000-00000000000b') AS acc_b;
GRANT SELECT ON ctx TO anon, authenticated, service_role;
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'agent' WHERE user_id = '11400000-0000-4000-8000-00000000000c';
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'admin' WHERE user_id = '11400000-0000-4000-8000-00000000000e';
UPDATE accounts a SET plan = 'basico', plan_status = 'active', plan_expires_at = NULL, plan_version_id = c.current_version_id
  FROM platform_plan_catalog c WHERE c.plan = 'basico' AND a.id IN ((SELECT acc_a FROM ctx), (SELECT acc_b FROM ctx));

-- ================= valid_plan_definition: optional extra prices ==========================
CREATE TEMP TABLE def AS SELECT definition AS d FROM platform_plan_versions WHERE plan = 'pro' ORDER BY revision DESC LIMIT 1;
SELECT pg_temp.assert_true(valid_plan_definition((SELECT d FROM def)), 'a definition without prices stays valid');
SELECT pg_temp.assert_true(valid_plan_definition((SELECT d FROM def) || '{"extra_user_price_cents":1500,"extra_channel_price_cents":1}'), 'both prices accepted (1 cent is the minimum)');
SELECT pg_temp.assert_true(NOT valid_plan_definition((SELECT d FROM def) || '{"extra_user_price_cents":0}'), 'zero is not a price');
SELECT pg_temp.assert_true(NOT valid_plan_definition((SELECT d FROM def) || '{"extra_channel_price_cents":0}'), 'zero is not a price (channels)');
SELECT pg_temp.assert_true(valid_plan_definition((SELECT d FROM def) || '{"extra_user_price_cents":10000000}'), 'the cap itself is accepted');
SELECT pg_temp.assert_true(NOT valid_plan_definition((SELECT d FROM def) || '{"extra_user_price_cents":10000001}'), 'over the cap');
SELECT pg_temp.assert_true(NOT valid_plan_definition((SELECT d FROM def) || '{"extra_user_price_cents":-1}'), 'negative');
SELECT pg_temp.assert_true(NOT valid_plan_definition((SELECT d FROM def) || '{"extra_channel_price_cents":1.5}'), 'fraction of a cent');
SELECT pg_temp.assert_true(NOT valid_plan_definition((SELECT d FROM def) || '{"extra_user_price_cents":"1500"}'), 'string');
SELECT pg_temp.assert_true(NOT valid_plan_definition((SELECT d FROM def) || '{"extra_user_price_cents":null}'), 'null (absent means not offered)');
SELECT pg_temp.assert_true(NOT valid_plan_definition((SELECT d FROM def) || '{"extra_seats_price_cents":1}'), 'unknown key still refused');
-- the table CHECK uses the same function
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO platform_plan_versions(plan, revision, definition, price_monthly_cents) VALUES ('pro', 9999, %L::jsonb, 100)$q$,
  ((SELECT d FROM def) || '{"extra_user_price_cents":-5}')::text), '23514', 'the version table refuses a bad price');
-- not callable by clients
SET ROLE authenticated;
SELECT pg_temp.assert_fails_with($q$SELECT valid_plan_definition('{}'::jsonb)$q$, '42501', 'authenticated cannot call valid_plan_definition');
RESET ROLE;

-- ================= account_billing: columns and constraints ==============================
INSERT INTO account_billing(account_id, plan, plan_version_id, cycle, value_cents, status, asaas_subscription_id)
  SELECT acc_a, 'basico', (SELECT plan_version_id FROM accounts WHERE id = acc_a), 'monthly', 5990, 'active', 'sub_ext_a' FROM ctx;
INSERT INTO account_billing(account_id, plan, plan_version_id, cycle, value_cents, status, asaas_subscription_id)
  SELECT acc_b, 'basico', (SELECT plan_version_id FROM accounts WHERE id = acc_b), 'monthly', 5990, 'active', 'sub_ext_b' FROM ctx;
SELECT pg_temp.assert_true((SELECT extra_users = 0 AND extra_channels = 0 AND extra_user_price_cents IS NULL AND extra_channel_price_cents IS NULL
  FROM account_billing WHERE account_id = (SELECT acc_a FROM ctx)), 'new rows start with no extras');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET extra_users = 1 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'extras need a locked price (users)');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET extra_channels = 1 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'extras need a locked price (channels)');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET extra_users = -1, extra_user_price_cents = 1 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'negative quantity');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET extra_users = 101, extra_user_price_cents = 1 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'quantity over the cap');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET extra_user_price_cents = 10000001 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'price over the cap');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET extra_channel_price_cents = -1 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'negative price');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET extra_user_price_cents = 0 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'zero price');
-- a scheduled removal is all-or-nothing and only lowers
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET pending_extra_users = 0 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'half a schedule');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET extras_asaas_lowered = true WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'lowered without a schedule');
-- an awaited annual purchase is all-or-nothing, with a positive amount and a locked price for what it adds
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET pending_add_users = 1, pending_add_channels = 0 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'purchase without its charge');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET pending_add_users = 0, pending_add_channels = 0, extras_oneoff_payment_id = 'p', extras_oneoff_cents = 100, extras_oneoff_expires_at = now() WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'a purchase of nothing');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET pending_add_users = 1, pending_add_channels = 0, extras_oneoff_payment_id = 'p', extras_oneoff_cents = 100, extras_oneoff_expires_at = now() WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'a purchase without the price it locks');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET pending_add_users = 1, pending_add_channels = 0, pending_add_user_price_cents = 1500, extras_oneoff_payment_id = 'p', extras_oneoff_cents = 0, extras_oneoff_expires_at = now() WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '23514', 'a free one-off charge');
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE account_billing SET pending_add_users = 1, pending_add_channels = 0, pending_add_user_price_cents = 1500, extras_oneoff_payment_id = 'p', extras_oneoff_cents = 100, extras_oneoff_expires_at = now() WHERE account_id = %L$q$, (SELECT acc_a FROM ctx))), 1, 'a complete purchase is accepted');
UPDATE account_billing SET pending_add_users = NULL, pending_add_channels = NULL, pending_add_user_price_cents = NULL, extras_oneoff_payment_id = NULL, extras_oneoff_cents = NULL, extras_oneoff_expires_at = NULL WHERE account_id = (SELECT acc_a FROM ctx);

-- service_role (the server) writes; the compare-and-swap UPDATE matches 1 row, then 0 when stale
SET ROLE service_role;
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE account_billing SET extra_users = 2, extra_user_price_cents = 1500, value_cents = 8990
  WHERE account_id = %L AND status = 'active' AND extra_users = 0 AND extra_channels = 0 AND extra_user_price_cents IS NULL AND value_cents = 5990$q$, (SELECT acc_a FROM ctx))),
  1, 'service role saves the extras (compare-and-swap, first caller)');
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE account_billing SET extra_users = 2, extra_user_price_cents = 1500, value_cents = 8990
  WHERE account_id = %L AND status = 'active' AND extra_users = 0 AND extra_channels = 0 AND extra_user_price_cents IS NULL AND value_cents = 5990$q$, (SELECT acc_a FROM ctx))),
  0, 'the same swap again matches nothing: two simultaneous clicks cannot add twice');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT extra_users = 2 AND extra_user_price_cents = 1500 AND value_cents = 8990 FROM account_billing WHERE account_id = (SELECT acc_a FROM ctx)), 'saved once');

-- ================= who reads and who writes ==============================================
-- an admin reads ONLY its own billing row (extras included)
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11400000-0000-4000-8000-00000000000e', true);
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(extra_users = 2) FROM account_billing), 'admin reads its own extras, not the other tenant');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET extra_users = 50, extra_user_price_cents = 1 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '42501', 'admin cannot write extras');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET value_cents = 1 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '42501', 'admin cannot write the value either');
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO account_billing(account_id, plan, plan_version_id, cycle, value_cents) VALUES (%L, 'basico', %L, 'monthly', 1)$q$,
  (SELECT acc_b FROM ctx), (SELECT plan_version_id FROM accounts WHERE id = (SELECT acc_b FROM ctx))), '42501', 'admin cannot insert billing rows');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- the owner of the OTHER tenant sees only its own row and cannot touch A's
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11400000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(extra_users = 0) FROM account_billing), 'tenant B sees only its own row');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET extra_users = 0, extra_user_price_cents = NULL WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '42501', 'B cannot write A extras');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- an agent reads nothing and writes nothing
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11400000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM account_billing), 0, 'agent sees no billing row (so no extras)');
SELECT pg_temp.assert_fails_with(format($q$UPDATE account_billing SET extra_users = 9, extra_user_price_cents = 1 WHERE account_id = %L$q$, (SELECT acc_a FROM ctx)), '42501', 'agent cannot write extras');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- anon: no grant at all
SET ROLE anon;
SELECT pg_temp.assert_fails_with($q$SELECT extra_users FROM account_billing$q$, '42501', 'anon cannot read extras');
SELECT pg_temp.assert_fails_with($q$UPDATE account_billing SET extra_users = 1$q$, '42501', 'anon cannot write extras');
RESET ROLE;

-- ================= serialised changes: claim / commit / release ==========================
-- (run on tenant B, whose extras were 0; the checks above are already done)
SET ROLE service_role;
CREATE TEMP TABLE claim AS SELECT billing_extras_claim((SELECT acc_b FROM ctx), 10) AS r;
GRANT SELECT ON claim TO service_role;
SELECT pg_temp.assert_true((SELECT r->>'status' = 'ok' AND (r->>'token') IS NOT NULL AND (r->'row'->>'extra_users')::int = 0 FROM claim), 'claim returns the row and a token');
SELECT pg_temp.assert_true(billing_extras_claim((SELECT acc_b FROM ctx), 10)->>'status' = 'busy', 'a second claim finds the account claimed');
SELECT pg_temp.assert_true(billing_extras_claim('00000000-0000-4000-8000-0000000000ff', 10)->>'status' = 'none', 'unknown account');
-- commit with a wrong token or stale data changes nothing
SELECT pg_temp.assert_true(NOT billing_extras_commit((SELECT acc_b FROM ctx), gen_random_uuid(),
  jsonb_build_object('asaas_subscription_id','sub_ext_b','value_cents',5990,'extra_users',0,'extra_channels',0,'extras_asaas_lowered',false),
  jsonb_build_object('extra_users',1,'extra_channels',0,'extra_user_price_cents',1500,'value_cents',7490,'extras_asaas_lowered',false),
  NULL, 'billing.extras_changed', '{}'), 'wrong token');
SELECT pg_temp.assert_true(NOT billing_extras_commit((SELECT acc_b FROM ctx), ((SELECT r FROM claim)->>'token')::uuid,
  jsonb_build_object('asaas_subscription_id','sub_ext_b','value_cents',1,'extra_users',0,'extra_channels',0,'extras_asaas_lowered',false),
  jsonb_build_object('extra_users',1,'extra_channels',0,'extra_user_price_cents',1500,'value_cents',7490,'extras_asaas_lowered',false),
  NULL, 'billing.extras_changed', '{}'), 'stale value read: compare-and-swap fails');
SELECT pg_temp.assert_fails_with(format($q$SELECT billing_extras_commit(%L, %L, '{}', '{}', NULL, 'billing.checkout', '{}')$q$, (SELECT acc_b FROM ctx), ((SELECT r FROM claim)->>'token')),
  '22023', 'only the extras actions can be written');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT extra_users = 0 AND value_cents = 5990 FROM account_billing WHERE account_id = (SELECT acc_b FROM ctx))
  AND NOT EXISTS (SELECT 1 FROM audit_log WHERE account_id = (SELECT acc_b FROM ctx) AND action LIKE 'billing.extras%'), 'failed commits wrote nothing, not even an audit row');
-- the real commit: extras and audit row together, claim cleared
SET ROLE service_role;
SELECT pg_temp.assert_true(billing_extras_commit((SELECT acc_b FROM ctx), ((SELECT r FROM claim)->>'token')::uuid,
  jsonb_build_object('asaas_subscription_id','sub_ext_b','value_cents',5990,'extra_users',0,'extra_channels',0,'extras_asaas_lowered',false),
  jsonb_build_object('extra_users',1,'extra_channels',0,'extra_user_price_cents',1500,'value_cents',7490,'extras_first_due','2027-01-01','extras_asaas_lowered',false),
  '11400000-0000-4000-8000-00000000000b', 'billing.extras_changed', '{"type":"add"}'), 'commit succeeds with the right token and data');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT extra_users = 1 AND extra_user_price_cents = 1500 AND value_cents = 7490 AND extras_first_due = '2027-01-01' AND extras_claim_token IS NULL
  FROM account_billing WHERE account_id = (SELECT acc_b FROM ctx)), 'extras saved and claim cleared');
SELECT pg_temp.assert_eq((SELECT count(*) FROM audit_log WHERE account_id = (SELECT acc_b FROM ctx) AND action = 'billing.extras_changed'
  AND actor_user_id = '11400000-0000-4000-8000-00000000000b' AND metadata->>'type' = 'add'), 1, 'one audit row, written with the change');
-- a used token cannot commit again
SET ROLE service_role;
SELECT pg_temp.assert_true(NOT billing_extras_commit((SELECT acc_b FROM ctx), ((SELECT r FROM claim)->>'token')::uuid,
  jsonb_build_object('asaas_subscription_id','sub_ext_b','value_cents',7490,'extra_users',1,'extra_channels',0,'extra_user_price_cents',1500,'extras_asaas_lowered',false),
  jsonb_build_object('extra_users',2,'extra_channels',0,'extra_user_price_cents',1500,'value_cents',8990,'extras_asaas_lowered',false),
  NULL, 'billing.extras_changed', '{}'), 'a used token is dead');
-- release frees the account
CREATE TEMP TABLE claim2 AS SELECT billing_extras_claim((SELECT acc_b FROM ctx), 10) AS r;
GRANT SELECT ON claim2 TO service_role;
SELECT billing_extras_release((SELECT acc_b FROM ctx), ((SELECT r FROM claim2)->>'token')::uuid);
SELECT pg_temp.assert_true(billing_extras_claim((SELECT acc_b FROM ctx), 10)->>'status' = 'ok', 'released: claimable again');
RESET ROLE;
-- the daily cap counts the audit rows under the claim lock
INSERT INTO audit_log(account_id, action, entity_type, created_at)
  SELECT (SELECT acc_b FROM ctx), 'billing.extras_changed', 'account_billing', now() FROM generate_series(1, 9);
UPDATE account_billing SET extras_claim_token = NULL, extras_claim_until = NULL WHERE account_id = (SELECT acc_b FROM ctx);
SET ROLE service_role;
SELECT pg_temp.assert_true(billing_extras_claim((SELECT acc_b FROM ctx), 10)->>'status' = 'cap', 'ten changes in 24 h: the cap');
SELECT pg_temp.assert_true(billing_extras_claim((SELECT acc_b FROM ctx), NULL)->>'status' = 'ok', 'the system steps are not capped');
RESET ROLE;
-- an annual purchase through the same RPCs: commit writes the awaited charge, and a stale read of it fails
UPDATE account_billing SET extras_claim_token = NULL, extras_claim_until = NULL WHERE account_id = (SELECT acc_a FROM ctx);
SET ROLE service_role;
CREATE TEMP TABLE claim3 AS SELECT billing_extras_claim((SELECT acc_a FROM ctx), NULL) AS r;
GRANT SELECT ON claim3 TO service_role;
SELECT pg_temp.assert_true(NOT billing_extras_commit((SELECT acc_a FROM ctx), ((SELECT r FROM claim3)->>'token')::uuid,
  jsonb_build_object('asaas_subscription_id','sub_ext_a','value_cents',8990,'extra_users',2,'extra_channels',0,'extra_user_price_cents',1500,'extras_asaas_lowered',false,'extras_oneoff_payment_id','pay_other'),
  jsonb_build_object('extra_users',2,'extra_channels',0,'extra_user_price_cents',1500,'value_cents',8990,'extras_asaas_lowered',false),
  NULL, 'billing.extras_changed', '{}'), 'a stale read of the awaited charge fails the compare-and-swap');
SELECT pg_temp.assert_true(billing_extras_commit((SELECT acc_a FROM ctx), ((SELECT r FROM claim3)->>'token')::uuid,
  jsonb_build_object('asaas_subscription_id','sub_ext_a','value_cents',8990,'extra_users',2,'extra_channels',0,'extra_user_price_cents',1500,'pending_extra_users',NULL,'extras_asaas_lowered',false),
  jsonb_build_object('extra_users',2,'extra_channels',0,'extra_user_price_cents',1500,'value_cents',8990,'extras_asaas_lowered',false,
    'pending_add_users',1,'pending_add_channels',0,'pending_add_user_price_cents',1500,'extras_oneoff_payment_id','pay_1','extras_oneoff_url','https://asaas.invalid/i/1','extras_oneoff_cents',15000,'extras_oneoff_expires_at','2027-01-01T00:00:00Z'),
  '11400000-0000-4000-8000-00000000000a', 'billing.extras_changed', '{"type":"add_awaiting_payment"}'), 'the awaited purchase is committed');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT pending_add_users = 1 AND extras_oneoff_payment_id = 'pay_1' AND extras_oneoff_cents = 15000 AND extra_users = 2 AND value_cents = 8990
  FROM account_billing WHERE account_id = (SELECT acc_a FROM ctx)), 'purchase stored; the limit-bearing extras and the value did not move');
SET ROLE service_role;
CREATE TEMP TABLE claim4 AS SELECT billing_extras_claim((SELECT acc_a FROM ctx), NULL) AS r;
GRANT SELECT ON claim4 TO service_role;
SELECT pg_temp.assert_true(billing_extras_commit((SELECT acc_a FROM ctx), ((SELECT r FROM claim4)->>'token')::uuid,
  jsonb_build_object('asaas_subscription_id','sub_ext_a','value_cents',8990,'extra_users',2,'extra_channels',0,'extra_user_price_cents',1500,'extras_asaas_lowered',false,'extras_oneoff_payment_id','pay_1'),
  jsonb_build_object('extra_users',3,'extra_channels',0,'extra_user_price_cents',1500,'value_cents',10490,'extras_asaas_lowered',false),
  NULL, 'billing.extras_changed', '{"type":"add_activated"}'), 'activation releases the extras and clears the purchase');
SELECT pg_temp.assert_true(NOT billing_extras_commit((SELECT acc_a FROM ctx), gen_random_uuid(), '{}', '{}', NULL, 'billing.extras_add_cancelled', '{}'), 'the cancelled-purchase action exists (wrong token still refused)');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT extra_users = 3 AND value_cents = 10490 AND pending_add_users IS NULL AND extras_oneoff_payment_id IS NULL AND extras_oneoff_url IS NULL
  FROM account_billing WHERE account_id = (SELECT acc_a FROM ctx)), 'extras active, purchase cleared');
-- the platform list counts extras only while the subscription is active
SELECT pg_temp.assert_true(pg_get_functiondef('public.platform_list_accounts()'::regprocedure) LIKE '%b.status = ''active'' THEN b.extra_users%', 'platform extras count only for an active subscription');
-- nobody but service_role runs them
SELECT pg_temp.assert_true(
  NOT has_function_privilege('anon', 'public.billing_extras_claim(uuid,integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.billing_extras_claim(uuid,integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.billing_extras_commit(uuid,uuid,jsonb,jsonb,uuid,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.billing_extras_release(uuid,uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.billing_extras_claim(uuid,integer)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.billing_extras_commit(uuid,uuid,jsonb,jsonb,uuid,text,jsonb)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.billing_extras_release(uuid,uuid)', 'EXECUTE'), 'extras functions are service_role only');

-- ================= platform_list_accounts carries the extras ==============================
SELECT pg_temp.assert_true(pg_get_function_result('public.platform_list_accounts()'::regprocedure) LIKE '%extra_users integer, extra_channels integer%',
  'platform_list_accounts returns extra_users and extra_channels');
SELECT pg_temp.assert_true(has_function_privilege('authenticated', 'public.platform_list_accounts()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.platform_list_accounts()', 'EXECUTE'), 'platform_list_accounts keeps its grants');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11400000-0000-4000-8000-00000000000e', true);
SELECT pg_temp.assert_fails_with($q$SELECT * FROM platform_list_accounts()$q$, '42501', 'not callable by a non-platform admin');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- grants, spelled out
SELECT pg_temp.assert_true(
  has_table_privilege('authenticated', 'public.account_billing', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.account_billing', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.account_billing', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.account_billing', 'DELETE')
  AND NOT has_table_privilege('anon', 'public.account_billing', 'SELECT')
  AND has_table_privilege('service_role', 'public.account_billing', 'UPDATE'), 'grants');

ROLLBACK;
SELECT 'plan_extras.sql: all assertions passed' AS result;
