-- ============================================================
-- Migration 108 (site bot columns on lead_sources) — defaults, CHECKs,
-- unique public_key, old rows intact, RLS tiers, anon access.
--
-- Nothing is committed (ends in ROLLBACK). Needs the local DB migrated through 107;
-- apply 108 in the same run:
--   (cat supabase/migrations/108_site_bot.sql supabase/tests/site_bot.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- (108 has its own BEGIN/COMMIT, so it stays applied; everything this file creates is rolled
-- back at its end. 108 is idempotent.) Never run `supabase db reset`.
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
 ('10800000-0000-4000-8000-00000000000a', 'owner-a@bot.test', '{"full_name":"Owner A"}'),
 ('10800000-0000-4000-8000-00000000000b', 'owner-b@bot.test', '{"full_name":"Owner B"}'),
 ('10800000-0000-4000-8000-00000000000c', 'agent@bot.test', '{"full_name":"Agent"}'),
 ('10800000-0000-4000-8000-00000000000e', 'admin@bot.test', '{"full_name":"Admin"}');
CREATE TEMP TABLE ctx AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '10800000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '10800000-0000-4000-8000-00000000000b') AS acc_b;
GRANT SELECT ON ctx TO anon, authenticated, service_role;
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'agent' WHERE user_id = '10800000-0000-4000-8000-00000000000c';
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'admin' WHERE user_id = '10800000-0000-4000-8000-00000000000e';
UPDATE accounts SET plan_status = 'active', plan_expires_at = NULL WHERE id IN ((SELECT acc_a FROM ctx), (SELECT acc_b FROM ctx));

-- ---- old rows: a webhook source made the 029 way keeps working -----------
INSERT INTO lead_sources(id, account_id, name, token) VALUES
  ('10800000-0000-4000-8000-0000000000a1', (SELECT acc_a FROM ctx), 'Webhook antigo', repeat('a', 64));
SELECT pg_temp.assert_true((SELECT kind = 'webhook' AND public_key IS NULL AND bot_config = '{}'::jsonb
                              FROM lead_sources WHERE id = '10800000-0000-4000-8000-0000000000a1'),
  'a webhook source defaults to kind webhook, no key, empty config');
-- (the local DB may already hold bots made in the UI: the rule is about rows without a key)
SELECT pg_temp.assert_true((SELECT coalesce(bool_and(kind = 'webhook'), true) FROM lead_sources WHERE public_key IS NULL),
  'every row without a public key is a webhook');

-- ---- site bot ------------------------------------------------------------
INSERT INTO lead_sources(id, account_id, name, token, kind, public_key, bot_config) VALUES
  ('10800000-0000-4000-8000-0000000000b1', (SELECT acc_a FROM ctx), 'Bot', repeat('b', 64), 'site_bot',
   repeat('1', 32), '{"greeting":"Oi"}');
SELECT pg_temp.assert_fails(format('INSERT INTO lead_sources(account_id, name, token, kind, public_key) VALUES (%L, %L, %L, %L, %L)',
  (SELECT acc_a FROM ctx), 'Bot sem chave', repeat('c', 64), 'site_bot', NULL), 'bot without key');
SELECT pg_temp.assert_fails(format('INSERT INTO lead_sources(account_id, name, token, kind, public_key) VALUES (%L, %L, %L, %L, %L)',
  (SELECT acc_a FROM ctx), 'Webhook com chave', repeat('d', 64), 'webhook', repeat('2', 32)), 'webhook with a key');
SELECT pg_temp.assert_fails(format('INSERT INTO lead_sources(account_id, name, token, kind, public_key) VALUES (%L, %L, %L, %L, %L)',
  (SELECT acc_a FROM ctx), 'Tipo ruim', repeat('e', 64), 'other', NULL), 'unknown kind');
SELECT pg_temp.assert_fails(format('INSERT INTO lead_sources(account_id, name, token, kind, public_key) VALUES (%L, %L, %L, %L, %L)',
  (SELECT acc_a FROM ctx), 'Chave curta', repeat('f', 64), 'site_bot', 'abc'), 'short key');
SELECT pg_temp.assert_fails(format('INSERT INTO lead_sources(account_id, name, token, kind, public_key) VALUES (%L, %L, %L, %L, %L)',
  (SELECT acc_a FROM ctx), 'Chave maiuscula', repeat('f', 64), 'site_bot', repeat('A', 32)), 'uppercase key');
SELECT pg_temp.assert_fails_with(format('INSERT INTO lead_sources(account_id, name, token, kind, public_key) VALUES (%L, %L, %L, %L, %L)',
  (SELECT acc_b FROM ctx), 'Chave repetida', repeat('9', 64), 'site_bot', repeat('1', 32)), '23505', 'public_key is unique across accounts');
SELECT pg_temp.assert_fails(format('INSERT INTO lead_sources(account_id, name, token, kind, public_key, bot_config) VALUES (%L, %L, %L, %L, %L, %L::jsonb)',
  (SELECT acc_a FROM ctx), 'Config array', repeat('8', 64), 'site_bot', repeat('3', 32), '[]'), 'bot_config must be an object');
SELECT pg_temp.assert_fails(format('INSERT INTO lead_sources(account_id, name, token, kind, public_key, bot_config) VALUES (%L, %L, %L, %L, %L, jsonb_build_object(%L, repeat(%L, 20000)))',
  (SELECT acc_a FROM ctx), 'Config grande', repeat('7', 64), 'site_bot', repeat('4', 32), 'x', 'y'), 'bot_config over 16 KB');
-- a webhook cannot be flipped into a bot without a key, nor a bot lose its key
SELECT pg_temp.assert_fails('UPDATE lead_sources SET kind = ''site_bot'' WHERE id = ''10800000-0000-4000-8000-0000000000a1''', 'flip webhook to bot without key');
SELECT pg_temp.assert_fails('UPDATE lead_sources SET public_key = NULL WHERE id = ''10800000-0000-4000-8000-0000000000b1''', 'bot loses key');

-- ---- RLS: unchanged tiers (076: admin+ reads, admin+ writes) --------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10800000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM lead_sources), 0, 'agent reads no lead source: token and key are admin-only');
SELECT pg_temp.assert_fails(format('INSERT INTO lead_sources(account_id, name, token, kind, public_key) VALUES (%L, %L, %L, %L, %L)',
  (SELECT acc_a FROM ctx), 'Agente nao cria robo', repeat('5', 64), 'site_bot', repeat('5', 32)), 'agent cannot create a bot');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10800000-0000-4000-8000-00000000000e', true);
SELECT pg_temp.assert_true((SELECT count(*) >= 2 FROM lead_sources WHERE account_id = (SELECT acc_a FROM ctx)), 'admin reads own sources');
INSERT INTO lead_sources(account_id, name, token, kind, public_key, bot_config)
  VALUES ((SELECT acc_a FROM ctx), 'Robo do admin', repeat('6', 64), 'site_bot', repeat('6', 32), '{"greeting":"Ola"}');
UPDATE lead_sources SET bot_config = '{"greeting":"Novo"}' WHERE public_key = repeat('6', 32);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT bot_config->>'greeting' = 'Novo' FROM lead_sources WHERE public_key = repeat('6', 32)), 'admin creates and edits a bot');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10800000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM lead_sources WHERE account_id = (SELECT acc_a FROM ctx)), 0, 'tenant B sees no source of A');
UPDATE lead_sources SET bot_config = '{"greeting":"Invadido"}' WHERE account_id = (SELECT acc_a FROM ctx);
DELETE FROM lead_sources WHERE account_id = (SELECT acc_a FROM ctx);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM lead_sources WHERE account_id = (SELECT acc_a FROM ctx) AND name IN ('Bot', 'Webhook antigo')), 2, 'tenant B update/delete touched 0 rows');

-- ---- billing read-only (094): a blocked account cannot create a bot --------
UPDATE accounts SET plan_status = 'canceled' WHERE id = (SELECT acc_a FROM ctx);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10800000-0000-4000-8000-00000000000e', true);
SELECT pg_temp.assert_fails(format('INSERT INTO lead_sources(account_id, name, token, kind, public_key) VALUES (%L, %L, %L, %L, %L)',
  (SELECT acc_a FROM ctx), 'Conta bloqueada', repeat('4', 64), 'site_bot', repeat('4', 32)), 'read-only account cannot create a bot');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
UPDATE accounts SET plan_status = 'active' WHERE id = (SELECT acc_a FROM ctx);

-- ---- anon: no access -----------------------------------------------------
SET ROLE anon;
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.lead_sources), 0, 'anon sees no lead source');
SELECT pg_temp.assert_fails(format('INSERT INTO lead_sources(account_id, name, token, kind, public_key) VALUES (%L, %L, %L, %L, %L)',
  (SELECT acc_a FROM ctx), 'Anon', repeat('3', 64), 'site_bot', repeat('3', 32)), 'anon cannot create a bot');
RESET ROLE;

ROLLBACK;
SELECT 'site_bot.sql: all assertions passed' AS result;
