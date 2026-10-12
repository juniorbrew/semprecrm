-- ============================================================
-- Migration 090 (billing with Asaas): RLS, grants, activation and
-- past-due transitions. Nothing is committed (ends in ROLLBACK):
--   (echo "BEGIN;"; cat supabase/migrations/090_*.sql supabase/tests/billing_asaas.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual numeric, expected numeric, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
CREATE FUNCTION pg_temp.assert_fails(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN RETURN;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('90000000-0000-4000-8000-00000000000a', 'dono@billing.test', '{"full_name":"Dono"}'),
 ('90000000-0000-4000-8000-00000000000b', 'agente@billing.test', '{"full_name":"Agente"}'),
 ('90000000-0000-4000-8000-00000000000c', 'outro@billing.test', '{"full_name":"Outro"}');
CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '90000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '90000000-0000-4000-8000-00000000000c') AS acc_b,
       (SELECT current_version_id FROM platform_plan_catalog WHERE plan = 'pro') AS pro_v;
GRANT SELECT ON ids TO authenticated, service_role;
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id = '90000000-0000-4000-8000-00000000000b';

-- The server (service role) records the checkout.
SET ROLE service_role;
INSERT INTO account_billing(account_id, asaas_customer_id, asaas_subscription_id, plan, plan_version_id, cycle, value_cents)
SELECT acc_a, 'cus_1', 'sub_1', 'pro', pro_v, 'monthly', 8990 FROM ids;
INSERT INTO billing_payments(asaas_payment_id, account_id, asaas_subscription_id, status, value_cents, due_date, invoice_url)
SELECT 'pay_1', acc_a, 'sub_1', 'PENDING', 8990, current_date, 'https://sandbox.asaas.com/i/x' FROM ids;
INSERT INTO billing_webhook_events(event_id, event, payload) VALUES ('evt_1', 'PAYMENT_CREATED', '{}');
SELECT pg_temp.assert_fails($$INSERT INTO billing_webhook_events(event_id, event, payload) VALUES ('evt_1', 'PAYMENT_CREATED', '{}')$$,
                            'an event id is stored once');

-- Pending first charge overdue: a trial account is not marked past_due.
SELECT public.billing_mark_past_due((SELECT acc_a FROM ids), 'sub_1');
SELECT pg_temp.assert_true((SELECT plan_status = 'trial' FROM accounts WHERE id = (SELECT acc_a FROM ids)), 'pending subscription: no past_due');

-- A payment of another (replaced) subscription changes nothing.
SELECT pg_temp.assert_true(NOT public.billing_activate((SELECT acc_a FROM ids), 'sub_old', '2026-11-17T00:00:00Z'), 'other subscription: refused');
SELECT pg_temp.assert_true((SELECT plan_status = 'trial' FROM accounts WHERE id = (SELECT acc_a FROM ids)), 'other subscription: still trial');

-- Confirmed payment: plan, version, status and expiry.
SELECT public.billing_activate((SELECT acc_a FROM ids), 'sub_1', '2026-11-17T00:00:00Z');
SELECT pg_temp.assert_true((SELECT plan = 'pro' AND plan_version_id = (SELECT pro_v FROM ids) AND plan_status = 'active'
                                   AND plan_expires_at = '2026-11-17T00:00:00Z'
                              FROM accounts WHERE id = (SELECT acc_a FROM ids)), 'activation sets plan, version, active, expiry');
-- A late, older payment never shortens the period.
SELECT public.billing_activate((SELECT acc_a FROM ids), 'sub_1', '2026-10-20T00:00:00Z');
SELECT pg_temp.assert_true((SELECT plan_expires_at = '2026-11-17T00:00:00Z' FROM accounts WHERE id = (SELECT acc_a FROM ids)),
                           'older payment does not shorten the period');
SELECT public.billing_mark_past_due((SELECT acc_a FROM ids), 'sub_1');
SELECT pg_temp.assert_true((SELECT a.plan_status = 'past_due' AND b.status = 'past_due'
                              FROM accounts a JOIN account_billing b ON b.account_id = a.id WHERE a.id = (SELECT acc_a FROM ids)),
                           'overdue marks account and billing past_due');
-- The old charge settling late does not cover the overdue one.
SELECT pg_temp.assert_true(NOT public.billing_activate((SELECT acc_a FROM ids), 'sub_1', '2026-11-17T00:00:00Z'), 'old charge refused');
SELECT pg_temp.assert_true((SELECT plan_status = 'past_due' FROM accounts WHERE id = (SELECT acc_a FROM ids)), 'old charge: still past_due');
SELECT public.billing_activate((SELECT acc_a FROM ids), 'sub_1', '2026-12-17T00:00:00Z');
SELECT pg_temp.assert_true((SELECT plan_status = 'active' FROM accounts WHERE id = (SELECT acc_a FROM ids)), 'paying the next period reactivates');

-- A platform suspension survives payments and overdue notices.
RESET ROLE;
UPDATE accounts SET plan_status = 'suspended' WHERE id = (SELECT acc_a FROM ids);
SET ROLE service_role;
SELECT public.billing_activate((SELECT acc_a FROM ids), 'sub_1', '2027-01-17T00:00:00Z');
SELECT public.billing_mark_past_due((SELECT acc_a FROM ids), 'sub_1');
SELECT public.billing_activate((SELECT acc_a FROM ids), 'sub_1', '2027-02-17T00:00:00Z');
SELECT pg_temp.assert_true((SELECT plan_status = 'suspended' FROM accounts WHERE id = (SELECT acc_a FROM ids)), 'payment never lifts a suspension');
RESET ROLE;
UPDATE accounts SET plan_status = 'active' WHERE id = (SELECT acc_a FROM ids);
SET ROLE service_role;

-- Safety net: a period that ended without a new payment turns past_due.
SELECT pg_temp.assert_eq(public.billing_expire_lapsed(), 0, 'nothing lapsed yet');
UPDATE account_billing SET current_period_end = now() - interval '1 minute' WHERE account_id = (SELECT acc_a FROM ids);
SELECT pg_temp.assert_eq(public.billing_expire_lapsed(), 1, 'lapsed period expires');
SELECT pg_temp.assert_true((SELECT a.plan_status = 'past_due' AND b.status = 'past_due'
                              FROM accounts a JOIN account_billing b ON b.account_id = a.id WHERE a.id = (SELECT acc_a FROM ids)),
                           'lapsed: account and billing past_due');
RESET ROLE;

-- ---- owner reads, writes nothing -------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM account_billing), 1, 'owner reads the billing row');
SELECT pg_temp.assert_eq((SELECT count(*) FROM billing_payments), 1, 'owner reads the payments');
SELECT pg_temp.assert_fails('SELECT count(*) FROM billing_webhook_events', 'owner cannot read raw webhook events');
SELECT pg_temp.assert_fails($$UPDATE account_billing SET status = 'active'$$, 'owner cannot change billing');
SELECT pg_temp.assert_fails($$INSERT INTO billing_payments(asaas_payment_id, account_id, status, value_cents) SELECT 'pay_x', acc_a, 'RECEIVED', 1 FROM ids$$,
                            'owner cannot forge a payment');
SELECT pg_temp.assert_fails(format('SELECT public.billing_activate(%L, ''sub_1'', now() + interval ''10 years'')', (SELECT acc_a FROM ids)),
                            'owner cannot activate the plan');
SELECT pg_temp.assert_fails($$UPDATE accounts SET plan_status = 'active', plan_expires_at = now() + interval '10 years'$$,
                            'owner cannot extend the plan directly (076/081 guard)');
RESET ROLE;

-- ---- agent and other tenant read nothing ------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM account_billing) + (SELECT count(*) FROM billing_payments), 0, 'agents read no billing');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '90000000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM account_billing) + (SELECT count(*) FROM billing_payments), 0, 'tenant B reads nothing of A');
SELECT pg_temp.assert_fails(format('SELECT public.billing_mark_past_due(%L, ''sub_1'')', (SELECT acc_a FROM ids)), 'tenant B cannot touch A');
SELECT pg_temp.assert_fails('SELECT public.billing_expire_lapsed()', 'tenants cannot run the expiry sweep');
RESET ROLE;

SELECT pg_temp.assert_true(NOT has_table_privilege('anon', 'account_billing', 'SELECT')
                           AND NOT has_function_privilege('authenticated', 'public.billing_activate(uuid, text, timestamptz)', 'EXECUTE')
                           AND NOT has_function_privilege('anon', 'public.billing_expire_lapsed()', 'EXECUTE'),
                           'grants');
ROLLBACK;
