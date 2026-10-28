-- Seed for supabase/tests/meta_connect_101.sql: accounts that exist BEFORE migration 101 runs
-- (a pro, an empresa and a basico account with a billing row each), so the test can prove
-- they are repointed (pro/empresa) or left alone (basico). Run after 099+100, before 101.
\set ON_ERROR_STOP on
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('11000000-0000-4000-8000-0000000000b1', 'pro@connect.test', '{"full_name":"Pro"}'),
 ('11000000-0000-4000-8000-0000000000b2', 'empresa@connect.test', '{"full_name":"Empresa"}'),
 ('11000000-0000-4000-8000-0000000000b3', 'basico@connect.test', '{"full_name":"Basico"}');
CREATE TEMP TABLE pre_accounts AS
SELECT p.user_id, p.account_id, split_part(u.email, '@', 1) AS plan
  FROM profiles p JOIN auth.users u ON u.id = p.user_id
 WHERE p.user_id IN ('11000000-0000-4000-8000-0000000000b1', '11000000-0000-4000-8000-0000000000b2', '11000000-0000-4000-8000-0000000000b3');
UPDATE accounts a
   SET plan = pa.plan, plan_version_id = (SELECT current_version_id FROM platform_plan_catalog WHERE plan = pa.plan)
  FROM pre_accounts pa WHERE a.id = pa.account_id;
INSERT INTO account_billing(account_id, plan, plan_version_id, cycle, value_cents, status)
SELECT pa.account_id, pa.plan, (SELECT current_version_id FROM platform_plan_catalog WHERE plan = pa.plan), 'monthly', 9900, 'active'
  FROM pre_accounts pa;
CREATE TEMP TABLE pre_versions AS
SELECT pa.account_id, pa.plan, a.plan_version_id AS old_account_version, b.plan_version_id AS old_billing_version
  FROM pre_accounts pa JOIN accounts a ON a.id = pa.account_id JOIN account_billing b ON b.account_id = pa.account_id;
