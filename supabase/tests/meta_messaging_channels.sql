-- ============================================================
-- Migration 100 (Instagram / Messenger) — identity rules, channel CHECKs,
-- inbox / report RPC channel guard, token isolation.
--
-- Nothing is committed (ends in ROLLBACK). Run with 099 + 100 in the same
-- transaction (every migration statement is idempotent; strip their own
-- BEGIN/COMMIT):
--   (echo "BEGIN;"; sed '/^BEGIN;$/d;/^COMMIT;$/d' supabase/migrations/099_*.sql supabase/migrations/100_*.sql; cat supabase/tests/meta_messaging_channels.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_fails(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN RETURN;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;

INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('10000000-0000-4000-8000-00000000000a', 'owner-a@omni.test', '{"full_name":"Owner A"}'),
 ('10000000-0000-4000-8000-00000000000b', 'owner-b@omni.test', '{"full_name":"Owner B"}');
CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '10000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '10000000-0000-4000-8000-00000000000b') AS acc_b;
GRANT SELECT ON ids TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- connections ----------------------------------------------------------
INSERT INTO meta_messaging_channels(account_id, kind, external_id, name, access_token) VALUES
 ((SELECT acc_a FROM ids), 'instagram', 'ig-1', 'Salao IG', 'ciphertext-ig'),
 ((SELECT acc_a FROM ids), 'messenger', 'pg-1', 'Salao FB', 'ciphertext-fb');
SELECT pg_temp.assert_fails(format('INSERT INTO meta_messaging_channels(account_id, kind, external_id, access_token) VALUES (%L, %L, %L, %L)', (SELECT acc_a FROM ids), 'instagram', 'ig-2', 'x'), 'one instagram connection per account');
SELECT pg_temp.assert_fails(format('INSERT INTO meta_messaging_channels(account_id, kind, external_id, access_token) VALUES (%L, %L, %L, %L)', (SELECT acc_b FROM ids), 'instagram', 'ig-1', 'x'), 'one account per external id');
SELECT pg_temp.assert_fails(format('INSERT INTO meta_messaging_channels(account_id, kind, external_id, access_token) VALUES (%L, %L, %L, %L)', (SELECT acc_b FROM ids), 'whatsapp', 'w-1', 'x'), 'kind CHECK');

-- ---- contact identity -----------------------------------------------------
SELECT pg_temp.assert_fails(format('INSERT INTO contacts(user_id, account_id, name) VALUES (%L, %L, %L)', '10000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'Sem identidade'), 'contact needs phone / instagram_id / messenger_id');
SELECT pg_temp.assert_fails(format('INSERT INTO contacts(user_id, account_id, instagram_id) VALUES (%L, %L, %L)', '10000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '  '), 'blank instagram_id');
INSERT INTO contacts(id, user_id, account_id, instagram_id, name) VALUES
 ('10000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'igsid-1', 'Cliente IG');
INSERT INTO contacts(id, user_id, account_id, messenger_id, name) VALUES
 ('10000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'psid-1', 'Cliente FB');
SELECT pg_temp.assert_true((SELECT phone IS NULL AND phone_normalized IS NULL FROM contacts WHERE id = '10000000-0000-4000-8000-000000000101'), 'no phone: phone_normalized NULL');
-- two phone-less contacts do not collide on the phone index
INSERT INTO contacts(user_id, account_id, instagram_id) VALUES ('10000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'igsid-2');
SELECT pg_temp.assert_fails(format('INSERT INTO contacts(user_id, account_id, instagram_id) VALUES (%L, %L, %L)', '10000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'igsid-1'), 'duplicate instagram_id in the same account');
SELECT pg_temp.assert_fails(format('INSERT INTO contacts(user_id, account_id, messenger_id) VALUES (%L, %L, %L)', '10000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'psid-1'), 'duplicate messenger_id in the same account');
INSERT INTO contacts(user_id, account_id, instagram_id) VALUES ('10000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), 'igsid-1');
-- WhatsApp rules unchanged
INSERT INTO contacts(user_id, account_id, phone) VALUES ('10000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '+55 11 90000-0001');
SELECT pg_temp.assert_fails(format('INSERT INTO contacts(user_id, account_id, phone) VALUES (%L, %L, %L)', '10000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511900000001'), 'phone dedup still enforced');

-- ---- channels on conversations / messages ---------------------------------
INSERT INTO conversations(id, user_id, account_id, contact_id, channel, status, last_customer_message_at)
VALUES ('10000000-0000-4000-8000-0000000002e1', '10000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '10000000-0000-4000-8000-000000000101', 'instagram', 'open', now());
INSERT INTO conversations(id, user_id, account_id, contact_id, channel, status)
VALUES ('10000000-0000-4000-8000-0000000002e2', '10000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '10000000-0000-4000-8000-000000000102', 'messenger', 'open');
INSERT INTO messages(conversation_id, sender_type, content_type, content_text, channel, message_id)
VALUES ('10000000-0000-4000-8000-0000000002e1', 'customer', 'text', 'oi', 'instagram', 'mid.1');
SELECT pg_temp.assert_fails(format('UPDATE conversations SET channel = %L WHERE id = %L', 'telegram', '10000000-0000-4000-8000-0000000002e1'), 'conversation channel CHECK');
SELECT pg_temp.assert_fails(format('UPDATE messages SET channel = %L WHERE message_id = %L', 'telegram', 'mid.1'), 'message channel CHECK');
SELECT pg_temp.assert_fails(format('INSERT INTO ai_agents(account_id, name, channels) VALUES (%L, %L, ARRAY[%L])', (SELECT acc_a FROM ids), 'x', 'telegram'), 'ai_agents.channels CHECK');

-- ---- RPCs accept the new channels -----------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM inbox_conversation_page((SELECT acc_a FROM ids), 'all', 'live', false, NULL, 15, 24, NULL, NULL, NULL, NULL, 50, NULL, 'instagram')), 'inbox page filters instagram');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM inbox_conversation_page((SELECT acc_a FROM ids), 'all', 'live', false, NULL, 15, 24, NULL, NULL, NULL, NULL, 50, NULL, 'messenger')), 'inbox page filters messenger');
SELECT pg_temp.assert_fails(format('SELECT * FROM inbox_conversation_page(%L, %L, %L, false, NULL, 15, 24, NULL, NULL, NULL, NULL, 50, NULL, %L)', (SELECT acc_a FROM ids), 'all', 'live', 'telegram'), 'inbox page rejects unknown channel');
SELECT pg_temp.assert_true((SELECT all_count = 1 FROM inbox_counts((SELECT acc_a FROM ids), 'live', false, NULL, 15, 24, NULL, 'instagram')), 'inbox_counts counts instagram');
SELECT count(*) FROM support_report((SELECT acc_a FROM ids), current_date - 1, current_date + 1, 'all', NULL, NULL, NULL, 'instagram');
SELECT count(*) FROM support_report_backlog((SELECT acc_a FROM ids), NULL, NULL, NULL, 'messenger');
SELECT pg_temp.assert_fails(format('SELECT * FROM support_report_backlog(%L, NULL, NULL, NULL, %L)', (SELECT acc_a FROM ids), 'telegram'), 'report rejects unknown channel');

-- ---- token isolation ------------------------------------------------------
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM (SELECT id, kind, status, external_id FROM meta_messaging_channels) s), 'member reads the safe columns of own connections');
SELECT pg_temp.assert_fails('SELECT access_token FROM meta_messaging_channels', 'authenticated cannot read access_token');
SELECT pg_temp.assert_fails('SELECT * FROM meta_messaging_channels', 'select * is refused (token column)');
SELECT pg_temp.assert_fails(format('INSERT INTO meta_messaging_channels(account_id, kind, external_id, access_token) VALUES (%L, %L, %L, %L)', (SELECT acc_a FROM ids), 'instagram', 'x', 'x'), 'browser cannot write connections');
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM (SELECT id FROM meta_messaging_channels WHERE kind = 'messenger') s), 'other account sees none of them');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.assert_fails('SELECT id FROM meta_messaging_channels', 'anon has no access');
RESET ROLE;

ROLLBACK;
