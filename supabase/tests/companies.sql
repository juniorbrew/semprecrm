-- ============================================================
-- Migration 054 (companies) — behaviour + RLS smoke test.
--
-- Run against a database that already has 054 applied, or apply it
-- in the same transaction first (nothing is committed):
--   (echo 'BEGIN;'; cat supabase/migrations/054_companies.sql supabase/tests/companies.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;

-- Signup trigger creates one account per user (owner).
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('54000000-0000-4000-8000-00000000000a', 'owner-a@companies.test', '{"full_name":"Owner A"}'),
 ('54000000-0000-4000-8000-00000000000b', 'owner-b@companies.test', '{"full_name":"Owner B"}'),
 ('54000000-0000-4000-8000-00000000000c', 'viewer-a@companies.test', '{"full_name":"Viewer A"}'),
 ('54000000-0000-4000-8000-00000000000d', 'agent-a@companies.test', '{"full_name":"Agent A"}');

CREATE TEMP TABLE ids AS
SELECT
  (SELECT account_id FROM profiles WHERE user_id = '54000000-0000-4000-8000-00000000000a') AS acc_a,
  (SELECT account_id FROM profiles WHERE user_id = '54000000-0000-4000-8000-00000000000b') AS acc_b;
GRANT SELECT ON ids TO authenticated;

-- Viewer and agent join account A (as postgres, like the member RPCs).
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'viewer'
 WHERE user_id = '54000000-0000-4000-8000-00000000000c';
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id = '54000000-0000-4000-8000-00000000000d';

-- Fixtures (as postgres): contacts, companies, a pipeline per account.
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
 ('54000000-0000-4000-8000-0000000000c1', '54000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '+5511900000001', 'Ana'),
 ('54000000-0000-4000-8000-0000000000c2', '54000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '+5511900000002', 'Bruno'),
 ('54000000-0000-4000-8000-0000000000c9', '54000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '+5511900000009', 'Zoe');
INSERT INTO companies(id, account_id, cnpj, razao_social) VALUES
 ('54000000-0000-4000-8000-0000000000e1', (SELECT acc_a FROM ids), '11222333000181', 'Padaria Sol LTDA'),
 ('54000000-0000-4000-8000-0000000000e2', (SELECT acc_a FROM ids), NULL, 'Mercado Lua'),
 ('54000000-0000-4000-8000-0000000000e3', (SELECT acc_a FROM ids), NULL, 'Oficina Estrela'),
 ('54000000-0000-4000-8000-0000000000e9', (SELECT acc_b FROM ids), '11222333000181', 'Padaria Sol LTDA (B)');
INSERT INTO pipelines(id, user_id, account_id, name) VALUES
 ('54000000-0000-4000-8000-0000000000f1', '54000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'Vendas A'),
 ('54000000-0000-4000-8000-0000000000f9', '54000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), 'Vendas B');
INSERT INTO pipeline_stages(id, pipeline_id, name) VALUES
 ('54000000-0000-4000-8000-0000000000a1', '54000000-0000-4000-8000-0000000000f1', 'Novo'),
 ('54000000-0000-4000-8000-0000000000a9', '54000000-0000-4000-8000-0000000000f9', 'Novo');

-- ---- constraints -------------------------------------------
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM companies WHERE cnpj = '11222333000181'),
  'same CNPJ allowed in two accounts');
DO $$ BEGIN
  INSERT INTO companies(account_id, cnpj, razao_social) SELECT acc_a, '11222333000181', 'Dup' FROM ids;
  RAISE EXCEPTION 'duplicate CNPJ in one account accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO companies(account_id, cnpj, razao_social) SELECT acc_a, '11.222.333/0001-81', 'Masked' FROM ids;
  RAISE EXCEPTION 'masked CNPJ accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO companies(account_id, razao_social) SELECT acc_a, '   ' FROM ids;
  RAISE EXCEPTION 'blank razao social accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO companies(account_id, razao_social, uf, cep) SELECT acc_a, 'X', 'sp', '1234' FROM ids;
  RAISE EXCEPTION 'bad uf/cep accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;

-- ---- primary-company rules (as postgres: triggers, not RLS) --
INSERT INTO contact_companies(contact_id, company_id) VALUES
 ('54000000-0000-4000-8000-0000000000c1', '54000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.assert_true(
  (SELECT is_primary FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1' AND company_id = '54000000-0000-4000-8000-0000000000e1'),
  'first company becomes primary');
SELECT pg_temp.assert_true(
  (SELECT account_id = (SELECT acc_a FROM ids) FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1'),
  'link account_id derived from contact');
INSERT INTO contact_companies(contact_id, company_id) VALUES
 ('54000000-0000-4000-8000-0000000000c1', '54000000-0000-4000-8000-0000000000e2');
SELECT pg_temp.assert_true(
  (SELECT NOT is_primary FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1' AND company_id = '54000000-0000-4000-8000-0000000000e2'),
  'second company is not primary by default');
INSERT INTO contact_companies(contact_id, company_id, is_primary) VALUES
 ('54000000-0000-4000-8000-0000000000c1', '54000000-0000-4000-8000-0000000000e3', true);
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1' AND is_primary),
  'linking as primary keeps exactly one primary');
SELECT pg_temp.assert_true(
  (SELECT company_id = '54000000-0000-4000-8000-0000000000e3' FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1' AND is_primary),
  'new primary wins');
UPDATE contact_companies SET is_primary = true
 WHERE contact_id = '54000000-0000-4000-8000-0000000000c1' AND company_id = '54000000-0000-4000-8000-0000000000e2';
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 AND bool_and(company_id = '54000000-0000-4000-8000-0000000000e2') FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1' AND is_primary),
  'marking primary moves the flag');
DELETE FROM contact_companies
 WHERE contact_id = '54000000-0000-4000-8000-0000000000c1' AND company_id = '54000000-0000-4000-8000-0000000000e2';
SELECT pg_temp.assert_true(
  (SELECT company_id = '54000000-0000-4000-8000-0000000000e1' FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1' AND is_primary),
  'unlinking the primary promotes the oldest remaining link');
DO $$ BEGIN
  INSERT INTO contact_companies(contact_id, company_id) VALUES
   ('54000000-0000-4000-8000-0000000000c1', '54000000-0000-4000-8000-0000000000e1');
  RAISE EXCEPTION 'duplicate link accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;

-- ---- cross-tenant integrity (even as postgres) ---------------
DO $$ BEGIN
  INSERT INTO contact_companies(contact_id, company_id) VALUES
   ('54000000-0000-4000-8000-0000000000c1', '54000000-0000-4000-8000-0000000000e9');
  RAISE EXCEPTION 'contact linked to another account company';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO contact_companies(contact_id, company_id, account_id) SELECT
   '54000000-0000-4000-8000-0000000000c9', '54000000-0000-4000-8000-0000000000e1', acc_a FROM ids;
  RAISE EXCEPTION 'foreign contact linked by spoofing account_id';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO deals(user_id, account_id, pipeline_id, stage_id, title, company_id) SELECT
   '54000000-0000-4000-8000-00000000000a', acc_a, '54000000-0000-4000-8000-0000000000f1', '54000000-0000-4000-8000-0000000000a1', 'X', '54000000-0000-4000-8000-0000000000e9' FROM ids;
  RAISE EXCEPTION 'deal linked to another account company';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
DO $$ BEGIN
  UPDATE companies SET account_id = (SELECT acc_b FROM ids) WHERE id = '54000000-0000-4000-8000-0000000000e2';
  RAISE EXCEPTION 'company moved to another account';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

INSERT INTO deals(id, user_id, account_id, pipeline_id, stage_id, title, company_id) SELECT
 '54000000-0000-4000-8000-0000000000d1', '54000000-0000-4000-8000-00000000000a', acc_a,
 '54000000-0000-4000-8000-0000000000f1', '54000000-0000-4000-8000-0000000000a1', 'Pão para o ano', '54000000-0000-4000-8000-0000000000e3' FROM ids;

-- ---- RLS: owner of account B sees nothing of A ---------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '54000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM companies), 'B sees only its own company');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM contact_companies), 'B sees no links of A');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM companies WHERE id = '54000000-0000-4000-8000-0000000000e1'), 'B cannot read A company by id');
UPDATE companies SET razao_social = 'hacked' WHERE id = '54000000-0000-4000-8000-0000000000e1';
DELETE FROM companies WHERE id = '54000000-0000-4000-8000-0000000000e2';
DO $$ BEGIN
  INSERT INTO companies(account_id, razao_social) SELECT acc_a, 'Planted' FROM ids;
  RAISE EXCEPTION 'B inserted into A';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  -- B's contact with A's company: the integrity trigger refuses first.
  INSERT INTO contact_companies(contact_id, company_id) VALUES
   ('54000000-0000-4000-8000-0000000000c9', '54000000-0000-4000-8000-0000000000e1');
  RAISE EXCEPTION 'B linked to A company';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
DO $$ BEGIN
  -- A's contact with A's company, attempted by B: RLS refuses.
  INSERT INTO contact_companies(contact_id, company_id) VALUES
   ('54000000-0000-4000-8000-0000000000c2', '54000000-0000-4000-8000-0000000000e1');
  RAISE EXCEPTION 'B created a link inside A';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
INSERT INTO contact_companies(contact_id, company_id) VALUES
 ('54000000-0000-4000-8000-0000000000c9', '54000000-0000-4000-8000-0000000000e9');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM contact_companies), 'B links its own contact and company');
RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT razao_social = 'Padaria Sol LTDA' FROM companies WHERE id = '54000000-0000-4000-8000-0000000000e1'),
  'B update on A company had no effect');
SELECT pg_temp.assert_true(
  EXISTS (SELECT 1 FROM companies WHERE id = '54000000-0000-4000-8000-0000000000e2'),
  'B delete on A company had no effect');

-- ---- RLS: viewer of A reads, cannot write -------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '54000000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_true((SELECT count(*) = 3 FROM companies), 'viewer reads A companies');
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM contact_companies), 'viewer reads A links');
DO $$ BEGIN
  INSERT INTO companies(account_id, razao_social) SELECT acc_a, 'Viewer' FROM ids;
  RAISE EXCEPTION 'viewer inserted';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO contact_companies(contact_id, company_id) VALUES
   ('54000000-0000-4000-8000-0000000000c2', '54000000-0000-4000-8000-0000000000e1');
  RAISE EXCEPTION 'viewer linked';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
UPDATE companies SET razao_social = 'viewer edit' WHERE id = '54000000-0000-4000-8000-0000000000e2';
DELETE FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1';
RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT razao_social = 'Mercado Lua' FROM companies WHERE id = '54000000-0000-4000-8000-0000000000e2'),
  'viewer update had no effect');
SELECT pg_temp.assert_true(
  (SELECT count(*) = 2 FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1'),
  'viewer delete had no effect');

-- ---- RLS: agent of A writes ----------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '54000000-0000-4000-8000-00000000000d', true);
INSERT INTO companies(id, account_id, razao_social, created_by) SELECT
 '54000000-0000-4000-8000-0000000000e4', acc_a, 'Agente Comércio', '54000000-0000-4000-8000-00000000000d' FROM ids;
INSERT INTO contact_companies(contact_id, company_id) VALUES
 ('54000000-0000-4000-8000-0000000000c2', '54000000-0000-4000-8000-0000000000e4');
SELECT pg_temp.assert_true(
  (SELECT is_primary FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c2'),
  'agent link: first company primary');
UPDATE contact_companies SET is_primary = true
 WHERE contact_id = '54000000-0000-4000-8000-0000000000c1' AND company_id = '54000000-0000-4000-8000-0000000000e3';
SELECT pg_temp.assert_true(
  (SELECT count(*) = 1 AND bool_and(company_id = '54000000-0000-4000-8000-0000000000e3') FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1' AND is_primary),
  'agent marks primary atomically');
UPDATE deals SET company_id = '54000000-0000-4000-8000-0000000000e4' WHERE id = '54000000-0000-4000-8000-0000000000d1';
DO $$ BEGIN
  UPDATE deals SET company_id = '54000000-0000-4000-8000-0000000000e9' WHERE id = '54000000-0000-4000-8000-0000000000d1';
  RAISE EXCEPTION 'agent pointed a deal at another account company';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
-- Deleting the primary company promotes the contact's other link and
-- clears the deal's company (ON DELETE SET NULL).
DELETE FROM companies WHERE id = '54000000-0000-4000-8000-0000000000e3';
RESET ROLE;
SELECT pg_temp.assert_true(
  (SELECT company_id = '54000000-0000-4000-8000-0000000000e1' FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1' AND is_primary),
  'deleting the primary company promotes the remaining link');
UPDATE deals SET company_id = '54000000-0000-4000-8000-0000000000e2' WHERE id = '54000000-0000-4000-8000-0000000000d1';
DELETE FROM companies WHERE id = '54000000-0000-4000-8000-0000000000e2';
SELECT pg_temp.assert_true(
  (SELECT company_id IS NULL FROM deals WHERE id = '54000000-0000-4000-8000-0000000000d1'),
  'deleting a company keeps the deal and clears company_id');

-- Deleting the contact removes its links without tripping the promotion.
DELETE FROM contacts WHERE id = '54000000-0000-4000-8000-0000000000c1';
SELECT pg_temp.assert_true(
  (SELECT count(*) = 0 FROM contact_companies WHERE contact_id = '54000000-0000-4000-8000-0000000000c1'),
  'contact delete cascades links');

-- anon has no access at all.
SET LOCAL ROLE anon;
DO $$ BEGIN PERFORM * FROM companies; RAISE EXCEPTION 'anon read companies'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN PERFORM * FROM contact_companies; RAISE EXCEPTION 'anon read links'; EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

SELECT 'companies smoke test: PASS' AS result;
ROLLBACK;
