-- ============================================================
-- Migration 107 (deal fields and values) — constraints, guards, limits, RLS tiers,
-- billing block, cascade, grants.
--
-- Nothing is committed (ends in ROLLBACK). Needs the local DB migrated through 106;
-- apply 107 in the same run:
--   (cat supabase/migrations/107_deal_fields.sql supabase/tests/deal_fields.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- (107 has its own BEGIN/COMMIT, so it stays applied; everything this file creates is rolled
-- back at its end. 107 is idempotent.)
-- Never run `supabase db reset`.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
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
-- same, and the error must carry this SQLSTATE
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
-- 076 closes new functions by default: open this script's pg_temp helpers.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- tenants -----------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('10700000-0000-4000-8000-00000000000a', 'owner-a@fields.test', '{"full_name":"Owner A"}'),
 ('10700000-0000-4000-8000-00000000000b', 'owner-b@fields.test', '{"full_name":"Owner B"}'),
 ('10700000-0000-4000-8000-00000000000c', 'agent@fields.test', '{"full_name":"Agent"}'),
 ('10700000-0000-4000-8000-00000000000d', 'viewer@fields.test', '{"full_name":"Viewer"}'),
 ('10700000-0000-4000-8000-00000000000e', 'admin@fields.test', '{"full_name":"Admin"}');
CREATE TEMP TABLE ctx AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '10700000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '10700000-0000-4000-8000-00000000000b') AS acc_b,
       '10700000-0000-4000-8000-00000000000a'::uuid AS owner,
       '10700000-0000-4000-8000-00000000000b'::uuid AS owner_b,
       '10700000-0000-4000-8000-00000000000c'::uuid AS agent,
       '10700000-0000-4000-8000-00000000000d'::uuid AS viewer,
       '10700000-0000-4000-8000-00000000000e'::uuid AS adm,
       '10700000-0000-4000-8000-0000000000d1'::uuid AS deal1,
       '10700000-0000-4000-8000-0000000000d2'::uuid AS deal2,
       '10700000-0000-4000-8000-0000000000d3'::uuid AS deal_b,
       '10700000-0000-4000-8000-0000000000a1'::uuid AS f_custo,
       '10700000-0000-4000-8000-0000000000a2'::uuid AS f_frete,
       '10700000-0000-4000-8000-0000000000a3'::uuid AS f_margem,
       '10700000-0000-4000-8000-0000000000a4'::uuid AS f_b;
GRANT SELECT ON ctx TO anon, authenticated, service_role;
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'agent'  WHERE user_id = (SELECT agent FROM ctx);
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'viewer' WHERE user_id = (SELECT viewer FROM ctx);
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'admin'  WHERE user_id = (SELECT adm FROM ctx);
UPDATE accounts SET plan_status = 'active', plan_expires_at = NULL WHERE id IN ((SELECT acc_a FROM ctx), (SELECT acc_b FROM ctx));

DO $$
DECLARE c record; v_pipe uuid; v_stage uuid; v_pipe_b uuid; v_stage_b uuid;
BEGIN
  SELECT * INTO c FROM ctx;
  INSERT INTO pipelines(user_id, account_id, name) VALUES (c.owner, c.acc_a, 'Funil') RETURNING id INTO v_pipe;
  INSERT INTO pipeline_stages(pipeline_id, name) VALUES (v_pipe, 'Novo') RETURNING id INTO v_stage;
  INSERT INTO pipelines(user_id, account_id, name) VALUES (c.owner_b, c.acc_b, 'Funil B') RETURNING id INTO v_pipe_b;
  INSERT INTO pipeline_stages(pipeline_id, name) VALUES (v_pipe_b, 'Novo') RETURNING id INTO v_stage_b;
  INSERT INTO deals(id, user_id, account_id, pipeline_id, stage_id, title, value) VALUES
    (c.deal1, c.owner, c.acc_a, v_pipe, v_stage, 'Negocio 1', 50),
    (c.deal2, c.owner, c.acc_a, v_pipe, v_stage, 'Negocio 2', 70),
    (c.deal_b, c.owner_b, c.acc_b, v_pipe_b, v_stage_b, 'Negocio B', 5);
  INSERT INTO deal_fields(id, account_id, name, kind, position, created_by) VALUES
    (c.f_custo, c.acc_a, 'Custo', 'currency', 0, c.owner),
    (c.f_frete, c.acc_a, 'Frete', 'number', 1, c.owner);
  INSERT INTO deal_fields(id, account_id, name, kind, expression, result_format, position) VALUES
    (c.f_margem, c.acc_a, 'Margem', 'formula', '{valor} - {f:' || c.f_custo || '}', 'currency', 2);
  INSERT INTO deal_fields(id, account_id, name, kind, position) VALUES
    (c.f_b, c.acc_b, 'Custo', 'number', 0);   -- same name in another account: fine
END $$;

-- =====================================================================
-- deal_fields: constraints
-- =====================================================================
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), '   ', 'number'), 'blank name');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, E%L, %L)', (SELECT acc_a FROM ctx), ' \t\n ', 'number'), 'name of tabs and newlines');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, repeat(%L, 41), %L)', (SELECT acc_a FROM ctx), 'x', 'number'), 'name over 40');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), 'Texto', 'text'), 'unknown kind');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), ' Valor ', 'number'), 'built-in name Valor is reserved');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), 'Dias para FECHAR', 'number'), 'built-in name Dias para fechar is reserved');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), 'Com {chaves}', 'number'), 'braces in a name');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), ' CUSTO ', 'number'), '23505', 'name is unique ignoring case and spaces');
-- formula shape
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), 'F1', 'formula'), 'formula needs expression and format');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind, expression) VALUES (%L, %L, %L, %L)', (SELECT acc_a FROM ctx), 'F2', 'formula', '{valor}'), 'formula needs result_format');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind, result_format) VALUES (%L, %L, %L, %L)', (SELECT acc_a FROM ctx), 'F3', 'formula', 'number'), 'formula needs expression');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind, expression, result_format) VALUES (%L, %L, %L, %L, %L)', (SELECT acc_a FROM ctx), 'F4', 'formula', '   ', 'number'), 'blank expression');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind, expression, result_format) VALUES (%L, %L, %L, repeat(%L, 4001), %L)', (SELECT acc_a FROM ctx), 'F5', 'formula', '1', 'number'), 'expression over 4000');
INSERT INTO deal_fields(account_id, name, kind, expression, result_format) VALUES ((SELECT acc_a FROM ctx), 'F6', 'formula', repeat('1', 4000), 'number');  -- exactly 4000: fine
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind, expression, result_format) VALUES (%L, %L, %L, %L, %L)', (SELECT acc_a FROM ctx), 'F7', 'formula', '{valor}', 'text'), 'unknown result_format');
-- non-formula kinds carry neither
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind, expression) VALUES (%L, %L, %L, %L)', (SELECT acc_a FROM ctx), 'N1', 'number', '{valor}'), 'number with expression');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind, result_format) VALUES (%L, %L, %L, %L)', (SELECT acc_a FROM ctx), 'N2', 'percent', 'number'), 'percent with result_format');
-- immutable account, formula-ness
SELECT pg_temp.assert_fails_with(format('UPDATE deal_fields SET account_id = %L WHERE id = %L', (SELECT acc_b FROM ctx), (SELECT f_custo FROM ctx)), '23514', 'field account is immutable');
SELECT pg_temp.assert_fails(format('UPDATE deal_fields SET kind = %L, expression = %L, result_format = %L WHERE id = %L', 'formula', '1', 'number', (SELECT f_frete FROM ctx)), 'number cannot become a formula');
SELECT pg_temp.assert_fails_with(format('UPDATE deal_fields SET kind = %L, expression = NULL, result_format = NULL WHERE id = %L', 'number', (SELECT f_margem FROM ctx)), '23514', 'formula cannot become a number');
UPDATE deal_fields SET kind = 'percent' WHERE id = (SELECT f_frete FROM ctx);   -- number -> percent is fine
UPDATE deal_fields SET kind = 'number' WHERE id = (SELECT f_frete FROM ctx);
DELETE FROM deal_fields WHERE name = 'F6';

-- ---- show_on_card: at most 2 per account -----------------------------------------
UPDATE deal_fields SET show_on_card = true WHERE id IN ((SELECT f_custo FROM ctx), (SELECT f_margem FROM ctx));
SELECT pg_temp.assert_fails_with(format('UPDATE deal_fields SET show_on_card = true WHERE id = %L', (SELECT f_frete FROM ctx)), '54000', 'a third card field is refused');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_fields(account_id, name, kind, show_on_card) VALUES (%L, %L, %L, true)', (SELECT acc_a FROM ctx), 'Terceiro', 'number'), '54000', 'a third card field on insert is refused');
UPDATE deal_fields SET name = 'Custo total' WHERE id = (SELECT f_custo FROM ctx);   -- editing a card field keeps working
UPDATE deal_fields SET name = 'Custo' WHERE id = (SELECT f_custo FROM ctx);
UPDATE deal_fields SET show_on_card = false WHERE id = (SELECT f_custo FROM ctx);
UPDATE deal_fields SET show_on_card = true WHERE id = (SELECT f_frete FROM ctx);  -- a slot was freed
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_fields WHERE account_id = (SELECT acc_b FROM ctx) AND show_on_card), 0, 'other account unaffected by the card limit');
UPDATE deal_fields SET show_on_card = false WHERE account_id = (SELECT acc_a FROM ctx);

-- ---- at most 50 fields per account (account B has 1) -----------------------------------
INSERT INTO deal_fields(account_id, name, kind, position) SELECT (SELECT acc_b FROM ctx), 'Campo ' || g, 'number', g FROM generate_series(1, 49) g;
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_fields WHERE account_id = (SELECT acc_b FROM ctx)), 50, '50 fields fit');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, %L, %L)', (SELECT acc_b FROM ctx), 'Campo 51', 'number'), '54000', 'the 51st field is refused');
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_fields WHERE account_id = (SELECT acc_a FROM ctx)), 3, 'other account unaffected by the 50 limit');
DELETE FROM deal_fields WHERE account_id = (SELECT acc_b FROM ctx) AND name LIKE 'Campo %';

-- =====================================================================
-- deal_field_values: constraints and guards (superuser: same-account rules always apply)
-- =====================================================================
INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES ((SELECT deal1 FROM ctx), (SELECT f_custo FROM ctx), (SELECT acc_b FROM ctx), 12.5);
SELECT pg_temp.assert_true((SELECT account_id FROM deal_field_values WHERE deal_id = (SELECT deal1 FROM ctx)) = (SELECT acc_a FROM ctx), 'account_id is stamped from the deal');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', (SELECT deal1 FROM ctx), (SELECT f_custo FROM ctx), (SELECT acc_a FROM ctx)), 'one value per deal and field');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', (SELECT deal1 FROM ctx), (SELECT f_b FROM ctx), (SELECT acc_a FROM ctx)), '23503', 'guard: field of another account');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', (SELECT deal_b FROM ctx), (SELECT f_custo FROM ctx), (SELECT acc_a FROM ctx)), '23503', 'guard: deal of another account');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', (SELECT deal1 FROM ctx), (SELECT f_margem FROM ctx), (SELECT acc_a FROM ctx)), '23514', 'a formula field has no stored value');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', gen_random_uuid(), (SELECT f_custo FROM ctx), (SELECT acc_a FROM ctx)), '23503', 'missing deal');
SELECT pg_temp.assert_fails_with(format('UPDATE deal_field_values SET deal_id = %L WHERE deal_id = %L', (SELECT deal2 FROM ctx), (SELECT deal1 FROM ctx)), '23514', 'deal_id is immutable');
SELECT pg_temp.assert_fails_with(format('UPDATE deal_field_values SET field_id = %L WHERE deal_id = %L', (SELECT f_frete FROM ctx), (SELECT deal1 FROM ctx)), '23514', 'field_id is immutable');
UPDATE deal_field_values SET account_id = (SELECT acc_b FROM ctx) WHERE deal_id = (SELECT deal1 FROM ctx);
SELECT pg_temp.assert_true((SELECT account_id FROM deal_field_values WHERE deal_id = (SELECT deal1 FROM ctx)) = (SELECT acc_a FROM ctx), 'account_id cannot be moved by an update');
-- value range: NaN, infinity and huge numbers are refused
SELECT pg_temp.assert_fails(format('UPDATE deal_field_values SET value = %L WHERE deal_id = %L', 'NaN', (SELECT deal1 FROM ctx)), 'NaN');
SELECT pg_temp.assert_fails(format('UPDATE deal_field_values SET value = %L WHERE deal_id = %L', 'Infinity', (SELECT deal1 FROM ctx)), 'infinity');
SELECT pg_temp.assert_fails(format('UPDATE deal_field_values SET value = 1000000000000 WHERE deal_id = %L', (SELECT deal1 FROM ctx)), 'value above the ceiling');
SELECT pg_temp.assert_fails(format('UPDATE deal_field_values SET value = -1000000000000 WHERE deal_id = %L', (SELECT deal1 FROM ctx)), 'value below the floor');
UPDATE deal_field_values SET value = -999999999999 WHERE deal_id = (SELECT deal1 FROM ctx);   -- edges fit
UPDATE deal_field_values SET value = 12.5 WHERE deal_id = (SELECT deal1 FROM ctx);

-- =====================================================================
-- RLS
-- =====================================================================
-- deal_fields: every member reads, only owner/admin write
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10700000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_fields), 3, 'agent reads the fields of A, not B');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), 'Agente nao cria', 'number'), 'agent cannot create a field');
UPDATE deal_fields SET name = 'Hackeado';
DELETE FROM deal_fields;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_fields WHERE account_id = (SELECT acc_a FROM ctx) AND name <> 'Hackeado'), 3, 'agent update/delete touched 0 rows');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10700000-0000-4000-8000-00000000000e', true);
INSERT INTO deal_fields(account_id, name, kind, created_by) VALUES ((SELECT acc_a FROM ctx), 'Criado pelo admin', 'percent', (SELECT adm FROM ctx));
UPDATE deal_fields SET position = 9 WHERE name = 'Criado pelo admin';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT position FROM deal_fields WHERE name = 'Criado pelo admin'), 9, 'admin writes fields');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10700000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_fields WHERE account_id = (SELECT acc_a FROM ctx)), 0, 'tenant B sees no field of A');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), 'Invasor', 'number'), 'tenant B cannot create in A');
UPDATE deal_fields SET name = 'Invadido' WHERE account_id = (SELECT acc_a FROM ctx);
DELETE FROM deal_fields WHERE account_id = (SELECT acc_a FROM ctx);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_fields WHERE account_id = (SELECT acc_a FROM ctx) AND name = 'Invadido'), 0, 'tenant B update/delete touched 0 rows');
DELETE FROM deal_fields WHERE name = 'Criado pelo admin';

-- deal_field_values: agent edits, viewer reads only, other tenant nothing
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10700000-0000-4000-8000-00000000000c', true);
INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES ((SELECT deal2 FROM ctx), (SELECT f_frete FROM ctx), (SELECT acc_a FROM ctx), 30);
UPDATE deal_field_values SET value = 31 WHERE deal_id = (SELECT deal2 FROM ctx);
SELECT pg_temp.assert_eq((SELECT value FROM deal_field_values WHERE deal_id = (SELECT deal2 FROM ctx)), 31, 'agent writes values');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', (SELECT deal_b FROM ctx), (SELECT f_b FROM ctx), (SELECT acc_b FROM ctx)), 'agent cannot write on a deal of B (RLS)');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', (SELECT deal1 FROM ctx), (SELECT f_b FROM ctx), (SELECT acc_a FROM ctx)), 'agent cannot use a field of B');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', (SELECT deal1 FROM ctx), (SELECT f_margem FROM ctx), (SELECT acc_a FROM ctx)), 'agent cannot write a formula value');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10700000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_field_values), 2, 'viewer reads the values');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', (SELECT deal2 FROM ctx), (SELECT f_custo FROM ctx), (SELECT acc_a FROM ctx)), 'viewer cannot write values');
UPDATE deal_field_values SET value = 1;
DELETE FROM deal_field_values;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT value FROM deal_field_values WHERE deal_id = (SELECT deal2 FROM ctx)), 31, 'viewer update/delete touched 0 rows');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10700000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_field_values), 0, 'tenant B sees no value of A');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', (SELECT deal2 FROM ctx), (SELECT f_frete FROM ctx), (SELECT acc_a FROM ctx)), 'tenant B cannot write on a deal of A');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', (SELECT deal2 FROM ctx), (SELECT f_frete FROM ctx), (SELECT acc_b FROM ctx)), 'tenant B cannot point its own account at a deal of A');
UPDATE deal_field_values SET value = 1;
DELETE FROM deal_field_values;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT value FROM deal_field_values WHERE deal_id = (SELECT deal2 FROM ctx)), 31, 'tenant B update/delete touched 0 rows');

-- =====================================================================
-- billing block (094): a read-only account writes neither table
-- =====================================================================
UPDATE accounts SET plan_status = 'past_due', plan_expires_at = NULL WHERE id = (SELECT acc_a FROM ctx);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10700000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_fails(format('INSERT INTO deal_field_values(deal_id, field_id, account_id, value) VALUES (%L, %L, %L, 1)', (SELECT deal2 FROM ctx), (SELECT f_custo FROM ctx), (SELECT acc_a FROM ctx)), 'past_due: value insert blocked');
UPDATE deal_field_values SET value = 9;
DELETE FROM deal_field_values;
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_field_values), 2, 'past_due: values still readable');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '10700000-0000-4000-8000-00000000000a', true);
SET ROLE authenticated;
SELECT pg_temp.assert_fails(format('INSERT INTO deal_fields(account_id, name, kind) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), 'Bloqueado', 'number'), 'past_due: field insert blocked');
UPDATE deal_fields SET name = 'Bloqueado';
DELETE FROM deal_fields;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT value FROM deal_field_values WHERE deal_id = (SELECT deal2 FROM ctx)), 31, 'past_due: value update/delete touched 0 rows');
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_fields WHERE account_id = (SELECT acc_a FROM ctx) AND name <> 'Bloqueado'), 3, 'past_due: field update/delete touched 0 rows');
UPDATE accounts SET plan_status = 'active' WHERE id = (SELECT acc_a FROM ctx);

-- =====================================================================
-- cascade: deleting a field drops its values; deleting a deal drops its values
-- =====================================================================
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_field_values WHERE field_id = (SELECT f_custo FROM ctx)), 1, 'value of Custo exists');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10700000-0000-4000-8000-00000000000a', true);
DELETE FROM deal_fields WHERE id = (SELECT f_custo FROM ctx);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_field_values WHERE field_id = (SELECT f_custo FROM ctx)), 0, 'deleting a field cascades its values');
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_fields WHERE id = (SELECT f_margem FROM ctx)), 1, 'formulas are not deleted by the app-level cascade');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10700000-0000-4000-8000-00000000000c', true);
DELETE FROM deals WHERE id = (SELECT deal2 FROM ctx);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_field_values WHERE deal_id = (SELECT deal2 FROM ctx)), 0, 'deleting a deal cascades its values');

-- ---- grants (076 rule) ----------------------------------------------------------------------
SELECT pg_temp.assert_true(NOT has_table_privilege('anon', 'public.deal_fields', 'SELECT') AND NOT has_table_privilege('anon', 'public.deal_fields', 'INSERT'), 'anon has no deal_fields privileges');
SELECT pg_temp.assert_true(NOT has_table_privilege('anon', 'public.deal_field_values', 'SELECT') AND NOT has_table_privilege('anon', 'public.deal_field_values', 'INSERT'), 'anon has no deal_field_values privileges');
SELECT pg_temp.assert_true(has_table_privilege('authenticated', 'public.deal_fields', 'SELECT') AND has_table_privilege('authenticated', 'public.deal_field_values', 'UPDATE'), 'authenticated has table rights (RLS filters)');
SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated', 'public.deal_fields', 'TRUNCATE') AND NOT has_table_privilege('authenticated', 'public.deal_field_values', 'TRUNCATE'), 'no TRUNCATE for authenticated');
SELECT pg_temp.assert_true(NOT has_function_privilege('authenticated', 'public.deal_fields_guard()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.deal_field_values_guard()', 'EXECUTE'), 'trigger functions are closed');
SET ROLE anon;
SELECT pg_temp.assert_fails('SELECT count(*) FROM public.deal_fields', 'anon cannot read deal_fields');
SELECT pg_temp.assert_fails('SELECT count(*) FROM public.deal_field_values', 'anon cannot read deal_field_values');
RESET ROLE;

ROLLBACK;
