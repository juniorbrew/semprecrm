-- ============================================================
-- Migration 104 (products and deal items) — constraints, guards, deals.value
-- recompute, override of direct writes, overflow, RLS tiers, billing block,
-- cascade / SET NULL, grants.
--
-- Nothing is committed (ends in ROLLBACK). Needs the local DB migrated through
-- 103 (the billing block, 094/096); apply 104 in the same transaction:
--   (cat supabase/migrations/104_products_deal_items.sql supabase/tests/products_deal_items.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- (104 has its own BEGIN/COMMIT, so it stays applied; everything this file creates is rolled
-- back at its end. 104 is idempotent.)
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
 ('10400000-0000-4000-8000-00000000000a', 'owner-a@items.test', '{"full_name":"Owner A"}'),
 ('10400000-0000-4000-8000-00000000000b', 'owner-b@items.test', '{"full_name":"Owner B"}'),
 ('10400000-0000-4000-8000-00000000000c', 'agent@items.test', '{"full_name":"Agent"}'),
 ('10400000-0000-4000-8000-00000000000d', 'viewer@items.test', '{"full_name":"Viewer"}'),
 ('10400000-0000-4000-8000-00000000000e', 'admin@items.test', '{"full_name":"Admin"}');
CREATE TEMP TABLE ctx AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '10400000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '10400000-0000-4000-8000-00000000000b') AS acc_b,
       '10400000-0000-4000-8000-00000000000a'::uuid AS owner,
       '10400000-0000-4000-8000-00000000000b'::uuid AS owner_b,
       '10400000-0000-4000-8000-00000000000c'::uuid AS agent,
       '10400000-0000-4000-8000-00000000000d'::uuid AS viewer,
       '10400000-0000-4000-8000-00000000000e'::uuid AS adm,
       '10400000-0000-4000-8000-0000000000d1'::uuid AS deal1,
       '10400000-0000-4000-8000-0000000000d2'::uuid AS deal2,
       '10400000-0000-4000-8000-0000000000d3'::uuid AS deal_b,
       '10400000-0000-4000-8000-0000000000a1'::uuid AS prod1,
       '10400000-0000-4000-8000-0000000000a2'::uuid AS prod2,
       '10400000-0000-4000-8000-0000000000a3'::uuid AS prod_b;
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
  INSERT INTO products(id, account_id, name, code, unit_price) VALUES
    (c.prod1, c.acc_a, 'Plano Mensal', 'PM', 100),
    (c.prod2, c.acc_a, 'Instalacao', NULL, 300),
    (c.prod_b, c.acc_b, 'Produto de B', NULL, 9);
END $$;

-- =====================================================================
-- products: constraints
-- =====================================================================
SELECT pg_temp.assert_fails(format('INSERT INTO products(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ctx), '   '), 'blank name');
SELECT pg_temp.assert_fails(format('INSERT INTO products(account_id, name) VALUES (%L, repeat(%L, 81))', (SELECT acc_a FROM ctx), 'x'), 'name over 80');
SELECT pg_temp.assert_fails(format('INSERT INTO products(account_id, name, code) VALUES (%L, %L, repeat(%L, 41))', (SELECT acc_a FROM ctx), 'Novo', 'x'), 'code over 40');
SELECT pg_temp.assert_fails(format('INSERT INTO products(account_id, name, unit_price) VALUES (%L, %L, -1)', (SELECT acc_a FROM ctx), 'Novo'), 'negative price');
SELECT pg_temp.assert_fails(format('INSERT INTO products(account_id, name, unit_price) VALUES (%L, %L, 10000000000)', (SELECT acc_a FROM ctx), 'Novo'), 'price above NUMERIC(12,2)');
SELECT pg_temp.assert_fails(format('INSERT INTO products(account_id, name, description) VALUES (%L, %L, repeat(%L, 301))', (SELECT acc_a FROM ctx), 'Novo', 'x'), 'description over 300');
SELECT pg_temp.assert_fails_with(format('INSERT INTO products(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ctx), ' plano MENSAL '), '23505', 'active name is unique ignoring case and spaces');
INSERT INTO products(account_id, name) VALUES ((SELECT acc_b FROM ctx), 'Plano Mensal');  -- other account: fine
UPDATE products SET archived_at = now() WHERE id = (SELECT prod2 FROM ctx);
INSERT INTO products(account_id, name) VALUES ((SELECT acc_a FROM ctx), 'Instalacao');   -- archived name is free again
SELECT pg_temp.assert_fails_with(format('UPDATE products SET archived_at = NULL WHERE id = %L', (SELECT prod2 FROM ctx)), '23505', 'unarchive onto a taken name');
SELECT pg_temp.assert_fails(format('UPDATE products SET account_id = %L WHERE id = %L', (SELECT acc_b FROM ctx), (SELECT prod1 FROM ctx)), 'product account is immutable');

-- =====================================================================
-- deal_items: constraints and guards (superuser: same-account rules always apply)
-- =====================================================================
SELECT pg_temp.assert_fails(format('INSERT INTO deal_items(account_id, deal_id, name) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), ' '), 'blank item name');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_items(account_id, deal_id, name, quantity) VALUES (%L, %L, %L, 0)', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), 'x'), 'quantity must be > 0');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_items(account_id, deal_id, name, quantity) VALUES (%L, %L, %L, 1000000.01)', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), 'x'), 'quantity ceiling');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_items(account_id, deal_id, name, unit_price) VALUES (%L, %L, %L, -0.01)', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), 'x'), 'negative unit price');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_items(account_id, deal_id, name, discount_pct) VALUES (%L, %L, %L, 100.01)', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), 'x'), 'discount above 100');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_items(account_id, deal_id, name, discount_pct) VALUES (%L, %L, %L, -1)', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), 'x'), 'negative discount');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_items(account_id, deal_id, name) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), (SELECT deal_b FROM ctx), 'x'), '23503', 'guard: deal of another account');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_items(account_id, deal_id, name) VALUES (%L, %L, %L)', (SELECT acc_b FROM ctx), (SELECT deal1 FROM ctx), 'x'), '23503', 'guard: account does not match the deal');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_items(account_id, deal_id, product_id, name) VALUES (%L, %L, %L, %L)', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), (SELECT prod_b FROM ctx), 'x'), '23503', 'guard: product of another account');

-- =====================================================================
-- recompute: deals.value follows the items
-- =====================================================================
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 50, 'no items: value untouched');
INSERT INTO deal_items(account_id, deal_id, product_id, name, unit_price, quantity, position)
  VALUES ((SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), (SELECT prod1 FROM ctx), 'Plano Mensal', 100, 2, 0);
SELECT pg_temp.assert_eq((SELECT line_total FROM deal_items WHERE deal_id = (SELECT deal1 FROM ctx)), 200, 'line total 2 x 100');
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 200, 'first item replaces the typed value');
INSERT INTO deal_items(id, account_id, deal_id, name, unit_price, quantity, discount_pct, position)
  VALUES ('10400000-0000-4000-8000-0000000000e2', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), 'Instalacao avulsa', 50, 1, 10, 1);
SELECT pg_temp.assert_eq((SELECT line_total FROM deal_items WHERE id = '10400000-0000-4000-8000-0000000000e2'), 45, 'line total with 10% discount');
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 245, 'sum of two lines');
-- rounding to 2 places: 1.5 x 33.33 = 49.995 -> 50.00 (half away from zero); 3 x 0.335 impossible (2 dp), 1.01 x 0.99 x 50% = 0.49995 -> 0.50
UPDATE deal_items SET quantity = 1.5, unit_price = 33.33, discount_pct = 0 WHERE id = '10400000-0000-4000-8000-0000000000e2';
SELECT pg_temp.assert_eq((SELECT line_total FROM deal_items WHERE id = '10400000-0000-4000-8000-0000000000e2'), 50.00, 'rounding 49.995 -> 50.00');
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 250, 'update recomputes');
UPDATE deal_items SET discount_pct = 100 WHERE id = '10400000-0000-4000-8000-0000000000e2';
SELECT pg_temp.assert_eq((SELECT line_total FROM deal_items WHERE id = '10400000-0000-4000-8000-0000000000e2'), 0, '100% discount = 0');
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 200, 'zero line keeps the rest');
-- a name / product change does not move the sum, and the stored copy does not follow the catalog
UPDATE products SET name = 'Plano Mensal PRO', unit_price = 999 WHERE id = (SELECT prod1 FROM ctx);
SELECT pg_temp.assert_true((SELECT name FROM deal_items WHERE product_id = (SELECT prod1 FROM ctx)) = 'Plano Mensal', 'item keeps its name copy');
SELECT pg_temp.assert_eq((SELECT unit_price FROM deal_items WHERE product_id = (SELECT prod1 FROM ctx)), 100, 'item keeps its price copy');
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 200, 'catalog change does not move the deal');
-- delete one
DELETE FROM deal_items WHERE id = '10400000-0000-4000-8000-0000000000e2';
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 200, 'delete recomputes');

-- ---- direct writes to deals.value are overridden while items exist ---------
UPDATE deals SET value = 1 WHERE id = (SELECT deal1 FROM ctx);
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 200, 'direct UPDATE of value is replaced by the sum');
UPDATE deals SET value = 1, title = 'Renomeado' WHERE id = (SELECT deal1 FROM ctx);
SELECT pg_temp.assert_true((SELECT title FROM deals WHERE id = (SELECT deal1 FROM ctx)) = 'Renomeado' AND (SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)) = 200, 'other columns still update; value stays the sum');
-- title-only update leaves updated_at semantics alone (set_updated_at still runs)
SELECT pg_temp.assert_true((SELECT updated_at FROM deals WHERE id = (SELECT deal1 FROM ctx)) >= (SELECT created_at FROM deals WHERE id = (SELECT deal1 FROM ctx)), 'updated_at kept moving forward');
-- status change still stamps closed_at (070 trigger not disturbed)
UPDATE deals SET status = 'won' WHERE id = (SELECT deal1 FROM ctx);
SELECT pg_temp.assert_true((SELECT closed_at FROM deals WHERE id = (SELECT deal1 FROM ctx)) IS NOT NULL, 'closed_at stamped as before');
UPDATE deals SET status = 'open' WHERE id = (SELECT deal1 FROM ctx);
-- last item removed: value stays and is editable again
DELETE FROM deal_items WHERE deal_id = (SELECT deal1 FROM ctx);
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 200, 'last item removed: value stays as it was');
UPDATE deals SET value = 321.5 WHERE id = (SELECT deal1 FROM ctx);
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 321.5, 'no items: value is editable by hand again');

-- ---- immutable keys ------------------------------------------------------------
INSERT INTO deal_items(id, account_id, deal_id, name, unit_price, quantity)
  VALUES ('10400000-0000-4000-8000-0000000000e3', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), 'Fixo', 10, 1);
SELECT pg_temp.assert_fails_with(format('UPDATE deal_items SET deal_id = %L WHERE id = %L', (SELECT deal2 FROM ctx), '10400000-0000-4000-8000-0000000000e3'), '23514', 'deal_id is immutable');
SELECT pg_temp.assert_fails_with(format('UPDATE deal_items SET account_id = %L WHERE id = %L', (SELECT acc_b FROM ctx), '10400000-0000-4000-8000-0000000000e3'), '23514', 'account_id is immutable');
SELECT pg_temp.assert_fails_with(format('UPDATE deal_items SET product_id = %L WHERE id = %L', (SELECT prod_b FROM ctx), '10400000-0000-4000-8000-0000000000e3'), '23503', 'guard on product change');
DELETE FROM deal_items WHERE id = '10400000-0000-4000-8000-0000000000e3';

-- ---- overflow: rejected, never clamped -------------------------------------------
INSERT INTO deal_items(id, account_id, deal_id, name, unit_price, quantity)
  VALUES ('10400000-0000-4000-8000-0000000000e4', (SELECT acc_a FROM ctx), (SELECT deal2 FROM ctx), 'Quase no limite', 9999999999.99, 1);
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal2 FROM ctx)), 9999999999.99, 'exactly the limit fits');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_items(account_id, deal_id, name, unit_price) VALUES (%L, %L, %L, 0.01)', (SELECT acc_a FROM ctx), (SELECT deal2 FROM ctx), 'Um centavo a mais'), '22003', 'sum above the limit is rejected');
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_items WHERE deal_id = (SELECT deal2 FROM ctx)), 1, 'rejected insert left no row');
SELECT pg_temp.assert_fails_with(format('UPDATE deal_items SET quantity = 2 WHERE id = %L', '10400000-0000-4000-8000-0000000000e4'), '22003', 'update that overflows is rejected');
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal2 FROM ctx)), 9999999999.99, 'value unchanged after rejected update');
SELECT pg_temp.assert_fails_with(format('INSERT INTO deal_items(account_id, deal_id, name, unit_price, quantity) VALUES (%L, %L, %L, 10000, 1000000)', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), 'Linha gigante'), '22003', 'one huge line is rejected too');
DELETE FROM deal_items WHERE id = '10400000-0000-4000-8000-0000000000e4';

-- =====================================================================
-- RLS: owner A, admin, agent, viewer, other tenant
-- =====================================================================
-- products: every member reads, only owner/admin write
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM products), 3, 'agent reads the catalog of A (2 active + 1 archived), not B');
SELECT pg_temp.assert_fails(format('INSERT INTO products(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ctx), 'Agente nao cria'), 'agent cannot create a product');
UPDATE products SET unit_price = 1 WHERE id = (SELECT prod1 FROM ctx);
DELETE FROM products WHERE id = (SELECT prod1 FROM ctx);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT unit_price FROM products WHERE id = (SELECT prod1 FROM ctx)), 999, 'agent update touched 0 rows');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-00000000000e', true);
INSERT INTO products(account_id, name, unit_price) VALUES ((SELECT acc_a FROM ctx), 'Criado pelo admin', 10);
UPDATE products SET unit_price = 11 WHERE name = 'Criado pelo admin';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT unit_price FROM products WHERE name = 'Criado pelo admin'), 11, 'admin writes the catalog');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM products WHERE account_id = (SELECT acc_a FROM ctx)), 0, 'tenant B sees no product of A');
SELECT pg_temp.assert_fails(format('INSERT INTO products(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ctx), 'Invasor'), 'tenant B cannot create in A');
UPDATE products SET unit_price = 1 WHERE account_id = (SELECT acc_a FROM ctx);
DELETE FROM products WHERE account_id = (SELECT acc_a FROM ctx);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM products WHERE account_id = (SELECT acc_a FROM ctx) AND unit_price = 1), 0, 'tenant B update touched 0 rows');

-- deal_items: agent edits (deal rule), viewer reads only, other tenant nothing
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-00000000000c', true);
INSERT INTO deal_items(id, account_id, deal_id, product_id, name, unit_price, quantity)
  VALUES ('10400000-0000-4000-8000-0000000000f1', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), (SELECT prod1 FROM ctx), 'Plano Mensal', 100, 3);
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 300, 'agent adds an item; the recompute runs under the agent rights');
UPDATE deal_items SET quantity = 4 WHERE id = '10400000-0000-4000-8000-0000000000f1';
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 400, 'agent updates an item');
UPDATE deals SET value = 5 WHERE id = (SELECT deal1 FROM ctx);
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 400, 'agent direct write of value is overridden');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_items(account_id, deal_id, name) VALUES (%L, %L, %L)', (SELECT acc_b FROM ctx), (SELECT deal_b FROM ctx), 'x'), 'agent cannot add to a deal of B (RLS)');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_items), 1, 'viewer reads the items');
SELECT pg_temp.assert_eq((SELECT count(*) FROM products), 4, 'viewer reads the catalog');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_items(account_id, deal_id, name) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), 'x'), 'viewer cannot add items');
UPDATE deal_items SET quantity = 1;
DELETE FROM deal_items;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT quantity FROM deal_items WHERE id = '10400000-0000-4000-8000-0000000000f1'), 4, 'viewer update/delete touched 0 rows');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_items), 0, 'tenant B sees no item of A');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_items(account_id, deal_id, name) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), 'x'), 'tenant B cannot add an item to a deal of A');
SELECT pg_temp.assert_fails(format('INSERT INTO deal_items(account_id, deal_id, name) VALUES (%L, %L, %L)', (SELECT acc_b FROM ctx), (SELECT deal1 FROM ctx), 'x'), 'tenant B cannot point its own account at a deal of A');
UPDATE deal_items SET quantity = 1;
DELETE FROM deal_items;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT quantity FROM deal_items WHERE id = '10400000-0000-4000-8000-0000000000f1'), 4, 'tenant B update/delete touched 0 rows');

-- =====================================================================
-- billing block (094): a read-only account does not write either table
-- =====================================================================
UPDATE accounts SET plan_status = 'past_due', plan_expires_at = NULL WHERE id = (SELECT acc_a FROM ctx);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_fails(format('INSERT INTO deal_items(account_id, deal_id, name) VALUES (%L, %L, %L)', (SELECT acc_a FROM ctx), (SELECT deal1 FROM ctx), 'bloqueado'), 'past_due: item insert blocked');
UPDATE deal_items SET quantity = 9;
DELETE FROM deal_items;
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_items), 1, 'past_due: items still readable');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-00000000000a', true);
SET ROLE authenticated;
SELECT pg_temp.assert_fails(format('INSERT INTO products(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ctx), 'Bloqueado'), 'past_due: product insert blocked');
UPDATE products SET unit_price = 2 WHERE id = (SELECT prod1 FROM ctx);
DELETE FROM products WHERE id = (SELECT prod1 FROM ctx);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT quantity FROM deal_items WHERE id = '10400000-0000-4000-8000-0000000000f1'), 4, 'past_due: item update/delete touched 0 rows');
SELECT pg_temp.assert_eq((SELECT unit_price FROM products WHERE id = (SELECT prod1 FROM ctx)), 999, 'past_due: product update/delete touched 0 rows');
UPDATE accounts SET plan_status = 'active' WHERE id = (SELECT acc_a FROM ctx);

-- =====================================================================
-- product delete -> SET NULL (item keeps its copy); deal delete -> cascade
-- =====================================================================
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-00000000000a', true);
DELETE FROM products WHERE id = (SELECT prod1 FROM ctx);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT product_id IS NULL AND name = 'Plano Mensal' AND unit_price = 100 FROM deal_items WHERE id = '10400000-0000-4000-8000-0000000000f1'), 'product delete: SET NULL, name and price copy kept');
SELECT pg_temp.assert_eq((SELECT value FROM deals WHERE id = (SELECT deal1 FROM ctx)), 400, 'product delete does not move the deal value');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-00000000000c', true);
DELETE FROM deals WHERE id = (SELECT deal1 FROM ctx);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM deal_items WHERE deal_id = (SELECT deal1 FROM ctx)), 0, 'deleting a deal cascades its items');

-- ---- grants (076 rule) -------------------------------------------------------------------
SELECT pg_temp.assert_true(NOT has_table_privilege('anon', 'public.products', 'SELECT') AND NOT has_table_privilege('anon', 'public.products', 'INSERT'), 'anon has no products privileges');
SELECT pg_temp.assert_true(NOT has_table_privilege('anon', 'public.deal_items', 'SELECT') AND NOT has_table_privilege('anon', 'public.deal_items', 'INSERT'), 'anon has no deal_items privileges');
SELECT pg_temp.assert_true(has_table_privilege('authenticated', 'public.products', 'SELECT') AND has_table_privilege('authenticated', 'public.deal_items', 'UPDATE'), 'authenticated has table rights (RLS filters)');
SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated', 'public.deal_items', 'TRUNCATE') AND NOT has_table_privilege('authenticated', 'public.products', 'TRUNCATE'), 'no TRUNCATE for authenticated');
SELECT pg_temp.assert_true(NOT has_function_privilege('authenticated', 'public.deal_items_guard()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.products_guard()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.deal_items_recompute()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.deals_value_from_items()', 'EXECUTE'), 'trigger functions are closed');
SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'public.deal_items_sum(uuid)', 'EXECUTE'), 'anon cannot run the sum helper');
SET ROLE anon;
SELECT pg_temp.assert_fails('SELECT count(*) FROM public.deal_items', 'anon cannot read deal_items');
SELECT pg_temp.assert_fails('SELECT count(*) FROM public.products', 'anon cannot read products');
RESET ROLE;

ROLLBACK;
