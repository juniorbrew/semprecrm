-- ============================================================
-- Migration 076 (security hardening) — smoke test. Each block runs the
-- attack (must fail) and the legitimate path (must keep working).
--
-- Run against a database that already has 076 applied, or apply it in
-- the same transaction first (nothing is committed):
--   (echo 'BEGIN;'; cat supabase/migrations/076_security_hardening.sql supabase/tests/security_hardening.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
-- 076 closes new functions by default: open the test helper explicitly.
GRANT EXECUTE ON FUNCTION pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;
-- What the storage API sets before its own DELETEs (storage.protect_delete).
SELECT set_config('storage.allow_delete_query', 'true', true);

-- Accounts A (owner, admin, agent, viewer) and B (owner). The signup
-- trigger creates one account per user; members are moved as postgres.
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('76000000-0000-4000-8000-00000000000a', 'owner-a@sec.test',  '{"full_name":"Owner A"}'),
 ('76000000-0000-4000-8000-00000000000b', 'owner-b@sec.test',  '{"full_name":"Owner B"}'),
 ('76000000-0000-4000-8000-0000000000ad', 'admin-a@sec.test',  '{"full_name":"Admin A"}'),
 ('76000000-0000-4000-8000-0000000000ac', 'agent-a@sec.test',  '{"full_name":"Agent A"}'),
 ('76000000-0000-4000-8000-0000000000ae', 'viewer-a@sec.test', '{"full_name":"Viewer A"}'),
 ('76000000-0000-4000-8000-0000000000ff', 'orphan@sec.test',   '{"full_name":"No profile"}');

CREATE TEMP TABLE ids AS
SELECT
  (SELECT account_id FROM profiles WHERE user_id = '76000000-0000-4000-8000-00000000000a') AS acc_a,
  (SELECT account_id FROM profiles WHERE user_id = '76000000-0000-4000-8000-00000000000b') AS acc_b;
GRANT SELECT ON ids TO anon, authenticated, service_role;

UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'admin'
 WHERE user_id = '76000000-0000-4000-8000-0000000000ad';
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id = '76000000-0000-4000-8000-0000000000ac';
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'viewer'
 WHERE user_id = '76000000-0000-4000-8000-0000000000ae';
DELETE FROM accounts WHERE owner_user_id IN ('76000000-0000-4000-8000-0000000000ad', '76000000-0000-4000-8000-0000000000ac',
  '76000000-0000-4000-8000-0000000000ae', '76000000-0000-4000-8000-0000000000ff');
DELETE FROM profiles WHERE user_id = '76000000-0000-4000-8000-0000000000ff';

-- Fixtures (as postgres).
INSERT INTO contacts(id, user_id, account_id, phone, name, opted_out_at) VALUES
 ('76000000-0000-4000-8000-0000000000c1', '76000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '+5511976000001', 'Ana', NULL),
 ('76000000-0000-4000-8000-0000000000c2', '76000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '+5511976000002', 'Bia', now()),
 ('76000000-0000-4000-8000-0000000000c3', '76000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '+5511976000003', 'Caio', NULL),
 ('76000000-0000-4000-8000-0000000000c9', '76000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '+5511976000009', 'Zoe', NULL);
UPDATE contacts SET anonymized_at = now(), name = 'Contato anonimizado'
 WHERE id = '76000000-0000-4000-8000-0000000000c3';
INSERT INTO tags(id, user_id, account_id, name) VALUES
 ('76000000-0000-4000-8000-0000000000e1', '76000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'VIP A'),
 ('76000000-0000-4000-8000-0000000000e9', '76000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), 'VIP B');
INSERT INTO pipelines(id, user_id, account_id, name) VALUES
 ('76000000-0000-4000-8000-0000000000f1', '76000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'Vendas A'),
 ('76000000-0000-4000-8000-0000000000f9', '76000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), 'Vendas B');
INSERT INTO pipeline_stages(id, pipeline_id, name) VALUES
 ('76000000-0000-4000-8000-0000000000a1', '76000000-0000-4000-8000-0000000000f1', 'Novo'),
 ('76000000-0000-4000-8000-0000000000a9', '76000000-0000-4000-8000-0000000000f9', 'Novo');
INSERT INTO lead_sources(id, account_id, name, token) VALUES
 ('76000000-0000-4000-8000-0000000000b1', (SELECT acc_a FROM ids), 'Site A', repeat('ab', 32));
INSERT INTO whatsapp_config(account_id, user_id, phone_number_id, waba_id, access_token, verify_token, status)
VALUES ((SELECT acc_a FROM ids), '76000000-0000-4000-8000-00000000000a', 'pn-a', 'waba-a', 'cipher-access', 'cipher-verify', 'connected');
INSERT INTO storage.objects(bucket_id, name, owner) VALUES
 ('flow-media', 'account-' || (SELECT acc_a FROM ids) || '/f.jpg', '76000000-0000-4000-8000-00000000000a'),
 ('chat-media', 'account-' || (SELECT acc_a FROM ids) || '/a.jpg', '76000000-0000-4000-8000-00000000000a'),
 ('chat-media', 'account-' || (SELECT acc_b FROM ids) || '/b.jpg', '76000000-0000-4000-8000-00000000000b');
UPDATE accounts SET platform_notes = 'internal note' WHERE id = (SELECT acc_a FROM ids);
INSERT INTO platform_admins(user_id) VALUES ('76000000-0000-4000-8000-00000000000b');


-- ---- 3. privileges (catalog) --------------------------------
SELECT pg_temp.assert_true(NOT has_function_privilege(r, f, 'execute'), r || ' cannot execute ' || f)
  FROM unnest(ARRAY['anon', 'authenticated']) r,
       unnest(ARRAY['public._bcast_bump(uuid,text,integer)', 'public.recompute_broadcast_counts(uuid)',
                    'public.chat_insert_system_message(uuid,uuid,jsonb)', 'public.merge_duplicate_contacts()',
                    'public.seed_task_statuses(uuid)', 'public.seed_deal_loss_reasons(uuid)',
                    'public.handle_new_user()', 'public.broadcast_recipient_aggregate_trigger()',
                    'public.enforce_same_account()']) f;
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                AND p.prorettype = 'trigger'::regtype
                AND (has_function_privilege('anon', p.oid, 'execute')
                     OR has_function_privilege('authenticated', p.oid, 'execute'))),
  'no trigger function is executable by anon/authenticated');
SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'public.set_member_role(uuid,account_role_enum)', 'execute'), 'anon cannot set_member_role');
SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'public.platform_update_account(uuid,jsonb)', 'execute'), 'anon cannot platform_update_account');
SELECT pg_temp.assert_true(has_function_privilege('authenticated', 'public.redeem_invitation(text)', 'execute'), 'authenticated keeps redeem_invitation');
SELECT pg_temp.assert_true(has_function_privilege('anon', 'public.peek_invitation(text)', 'execute'), 'anon keeps peek_invitation (invite page)');
SELECT pg_temp.assert_true(has_function_privilege('anon', 'public.is_account_member(uuid,account_role_enum)', 'execute'), 'anon keeps is_account_member (RLS)');
SELECT pg_temp.assert_true(has_function_privilege('anon', 'public.chat_internal_object_allowed(text)', 'execute'), 'anon keeps chat_internal_object_allowed (storage RLS)');
SELECT pg_temp.assert_true(has_function_privilege('service_role', 'public.recompute_broadcast_counts(uuid)', 'execute'), 'service_role keeps recompute_broadcast_counts');
CREATE FUNCTION public.zz_sec_new_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';
SELECT pg_temp.assert_true(
  NOT has_function_privilege('anon', 'public.zz_sec_new_fn()', 'execute')
  AND NOT has_function_privilege('authenticated', 'public.zz_sec_new_fn()', 'execute')
  AND has_function_privilege('service_role', 'public.zz_sec_new_fn()', 'execute'),
  'new functions are closed by default');
SELECT pg_temp.assert_true(NOT has_table_privilege(r, 'public.contacts', p), r || ' has no ' || p || ' on contacts')
  FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['TRUNCATE', 'TRIGGER', 'REFERENCES']) p;
CREATE TABLE public.zz_sec_new_table(id int);
SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated', 'public.zz_sec_new_table', 'TRUNCATE')
  AND has_table_privilege('authenticated', 'public.zz_sec_new_table', 'SELECT'), 'new tables: no TRUNCATE, SELECT kept');
SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated', 'public.calendar_connections_public', p),
  'calendar_connections_public has no ' || p)
  FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) p;
SELECT pg_temp.assert_true(has_table_privilege('authenticated', 'public.calendar_connections_public', 'SELECT'), 'calendar_connections_public SELECT kept');
SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'account-branding' AND 'image/svg+xml' = ANY (allowed_mime_types)),
  'account-branding rejects SVG');


-- ---- anon ---------------------------------------------------
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM storage.objects WHERE bucket_id IN ('chat-media', 'flow-media', 'avatars', 'account-branding')),
  'anon cannot list public buckets');
DO $$ BEGIN
  PERFORM public._bcast_bump(gen_random_uuid(), 'sent', 1);
  RAISE EXCEPTION 'anon executed _bcast_bump';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT pg_temp.assert_true((SELECT public.is_account_member((SELECT acc_a FROM ids))) = false, 'anon: RLS helper still callable');
RESET ROLE;


-- ---- owner A (account admin+) -------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"76000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);

-- 1. accounts
DO $$ BEGIN
  UPDATE accounts SET plan = 'empresa' WHERE id = (SELECT acc_a FROM ids);
  RAISE EXCEPTION 'owner changed own plan';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  UPDATE accounts SET limit_overrides = '{"users": 999}' WHERE id = (SELECT acc_a FROM ids);
  RAISE EXCEPTION 'owner changed own limit_overrides';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  UPDATE accounts SET owner_user_id = '76000000-0000-4000-8000-0000000000ac' WHERE id = (SELECT acc_a FROM ids);
  RAISE EXCEPTION 'owner rewrote owner_user_id';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM platform_notes FROM accounts WHERE id = (SELECT acc_a FROM ids);
  RAISE EXCEPTION 'member read platform_notes';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
UPDATE accounts SET name = 'Conta A', default_currency = 'BRL' WHERE id = (SELECT acc_a FROM ids);
SELECT pg_temp.assert_true((SELECT name = 'Conta A' AND plan IS NOT NULL FROM accounts WHERE id = (SELECT acc_a FROM ids)),
  'owner edits name/currency and reads plan columns');

-- 5. lead_sources: admin+ sees the token
SELECT pg_temp.assert_true((SELECT token = repeat('ab', 32) FROM lead_sources WHERE id = '76000000-0000-4000-8000-0000000000b1'), 'owner reads lead source token');

-- 9. whatsapp_config: no ciphertext even for the owner; other columns ok
DO $$ BEGIN
  PERFORM access_token FROM whatsapp_config;
  RAISE EXCEPTION 'member read whatsapp access_token';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM verify_token FROM whatsapp_config;
  RAISE EXCEPTION 'member read whatsapp verify_token';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM whatsapp_config WHERE status = 'connected' AND phone_number_id = 'pn-a'),
  'member reads non-secret whatsapp_config columns');
UPDATE whatsapp_config SET access_token = 'cipher-new' WHERE account_id = (SELECT acc_a FROM ids);

-- 2. storage: own folder only
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM storage.objects WHERE bucket_id = 'chat-media'
  AND name LIKE 'account-' || (SELECT acc_a FROM ids) || '/%'), 'owner sees own chat-media');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM storage.objects WHERE bucket_id = 'chat-media'
  AND name LIKE 'account-' || (SELECT acc_b FROM ids) || '/%'), 'owner cannot list account B chat-media');
RESET ROLE;

-- 1. transfer_account_ownership (SECURITY DEFINER) still works
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"76000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
SELECT public.transfer_account_ownership('76000000-0000-4000-8000-0000000000ad');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT owner_user_id = '76000000-0000-4000-8000-0000000000ad' FROM accounts WHERE id = (SELECT acc_a FROM ids)),
  'transfer_account_ownership updates owner_user_id');


-- ---- owner B = platform admin -------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"76000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
SELECT public.platform_update_account((SELECT acc_a FROM ids), '{"plan":"pro","plan_status":"active","platform_notes":"via rpc"}');
-- Direct table write (accounts_platform_update) would skip the gated,
-- audited route: rejected even for a platform admin.
DO $$ BEGIN
  UPDATE accounts SET plan = 'empresa' WHERE id = (SELECT acc_a FROM ids);
  RAISE EXCEPTION 'platform admin bypassed the platform route';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM storage.objects WHERE bucket_id = 'chat-media'
  AND name LIKE 'account-' || (SELECT acc_a FROM ids) || '/%'), 'account B cannot list account A chat-media');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM lead_sources_public WHERE account_id = (SELECT acc_a FROM ids)),
  'account B does not see account A lead sources');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT plan = 'pro' AND plan_status = 'active' AND platform_notes = 'via rpc'
  FROM accounts WHERE id = (SELECT acc_a FROM ids)), 'platform admin paths still update plan columns');


-- ---- viewer A -----------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"76000000-0000-4000-8000-0000000000ae","role":"authenticated"}', true);
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM lead_sources), 'viewer cannot read lead_sources (token)');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM lead_sources_public WHERE name = 'Site A'), 'viewer reads lead_sources_public');
DO $$ BEGIN
  PERFORM token FROM lead_sources_public;
  RAISE EXCEPTION 'lead_sources_public exposes token';
EXCEPTION WHEN undefined_column THEN NULL; END $$;
-- flow-media writes are agent+ (chat-media write policies: migration 078's test).
DO $$ BEGIN
  INSERT INTO storage.objects(bucket_id, name) VALUES ('flow-media', 'account-' || (SELECT acc_a FROM ids) || '/viewer.jpg');
  RAISE EXCEPTION 'viewer uploaded flow media';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DELETE FROM storage.objects WHERE bucket_id = 'flow-media' AND name LIKE 'account-' || (SELECT acc_a FROM ids) || '/%';
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM storage.objects WHERE bucket_id = 'flow-media'
  AND name LIKE 'account-' || (SELECT acc_a FROM ids) || '/%'), 'viewer cannot delete flow media');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM storage.objects WHERE bucket_id = 'chat-media'
  AND name LIKE 'account-' || (SELECT acc_a FROM ids) || '/%'), 'viewer lists own chat-media');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM accounts WHERE id = (SELECT acc_a FROM ids)), 'viewer reads own account row');
RESET ROLE;


-- ---- agent A ------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"76000000-0000-4000-8000-0000000000ac","role":"authenticated"}', true);

-- 2. agent+ writes media in its own folder (chat-media: pre-076 policies, unchanged)
INSERT INTO storage.objects(bucket_id, name) VALUES ('chat-media', 'account-' || (SELECT acc_a FROM ids) || '/agent.jpg');
DELETE FROM storage.objects WHERE bucket_id = 'chat-media' AND name = 'account-' || (SELECT acc_a FROM ids) || '/agent.jpg';
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM storage.objects WHERE name = 'account-' || (SELECT acc_a FROM ids) || '/agent.jpg'),
  'agent deletes own chat media');
INSERT INTO storage.objects(bucket_id, name) VALUES ('flow-media', 'account-' || (SELECT acc_a FROM ids) || '/agent.jpg');
DELETE FROM storage.objects WHERE bucket_id = 'flow-media' AND name = 'account-' || (SELECT acc_a FROM ids) || '/agent.jpg';
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM storage.objects WHERE name = 'account-' || (SELECT acc_a FROM ids) || '/agent.jpg'),
  'agent deletes own flow media');
DO $$ BEGIN
  INSERT INTO storage.objects(bucket_id, name) VALUES ('chat-media', 'account-' || (SELECT acc_b FROM ids) || '/x.jpg');
  RAISE EXCEPTION 'agent uploaded chat media into account B';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO storage.objects(bucket_id, name) VALUES ('flow-media', 'account-' || (SELECT acc_b FROM ids) || '/x.jpg');
  RAISE EXCEPTION 'agent uploaded flow media into account B';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

-- 4. calendar_connections_public is read-only
DO $$ BEGIN
  INSERT INTO calendar_connections_public(account_id, user_id, provider)
  VALUES ((SELECT acc_b FROM ids), '76000000-0000-4000-8000-00000000000b', 'google');
  RAISE EXCEPTION 'insert through calendar_connections_public';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT count(*) FROM calendar_connections_public;

-- 5. agent: no token, automation picker still works
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM lead_sources), 'agent cannot read lead_sources (token)');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM lead_sources_public), 'agent reads lead_sources_public');

-- 7. cross-tenant references
DO $$ BEGIN
  INSERT INTO deals(account_id, user_id, pipeline_id, stage_id, title, contact_id)
  VALUES ((SELECT acc_a FROM ids), '76000000-0000-4000-8000-0000000000ac', '76000000-0000-4000-8000-0000000000f1',
          '76000000-0000-4000-8000-0000000000a1', 'x', '76000000-0000-4000-8000-0000000000c9');
  RAISE EXCEPTION 'deal linked to a contact of account B';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO deals(account_id, user_id, pipeline_id, stage_id, title)
  VALUES ((SELECT acc_a FROM ids), '76000000-0000-4000-8000-0000000000ac', '76000000-0000-4000-8000-0000000000f1',
          '76000000-0000-4000-8000-0000000000a9', 'x');
  RAISE EXCEPTION 'deal in a stage of account B';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
INSERT INTO deals(id, account_id, user_id, pipeline_id, stage_id, title, contact_id)
VALUES ('76000000-0000-4000-8000-0000000000d1', (SELECT acc_a FROM ids), '76000000-0000-4000-8000-0000000000ac',
        '76000000-0000-4000-8000-0000000000f1', '76000000-0000-4000-8000-0000000000a1', 'Deal A',
        '76000000-0000-4000-8000-0000000000c1');
UPDATE deals SET title = 'Deal A2' WHERE id = '76000000-0000-4000-8000-0000000000d1';
DO $$ BEGIN
  UPDATE deals SET pipeline_id = '76000000-0000-4000-8000-0000000000f9' WHERE id = '76000000-0000-4000-8000-0000000000d1';
  RAISE EXCEPTION 'deal moved to a pipeline of account B';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO contact_tags(contact_id, tag_id) VALUES ('76000000-0000-4000-8000-0000000000c1', '76000000-0000-4000-8000-0000000000e9');
  RAISE EXCEPTION 'contact tagged with a tag of account B';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
INSERT INTO contact_tags(contact_id, tag_id) VALUES ('76000000-0000-4000-8000-0000000000c1', '76000000-0000-4000-8000-0000000000e1');
DO $$ BEGIN
  INSERT INTO tasks(account_id, status_id, created_by, title, assignee_user_id)
  VALUES ((SELECT acc_a FROM ids), (SELECT id FROM task_statuses WHERE account_id = (SELECT acc_a FROM ids) LIMIT 1),
          '76000000-0000-4000-8000-0000000000ac', 't', '76000000-0000-4000-8000-00000000000b');
  RAISE EXCEPTION 'task assigned to a user of account B';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
INSERT INTO tasks(account_id, status_id, created_by, title, assignee_user_id, deal_id)
VALUES ((SELECT acc_a FROM ids), (SELECT id FROM task_statuses WHERE account_id = (SELECT acc_a FROM ids) LIMIT 1),
        '76000000-0000-4000-8000-0000000000ac', 't', '76000000-0000-4000-8000-0000000000ae',
        '76000000-0000-4000-8000-0000000000d1');

-- 8. contacts LGPD markers
DO $$ BEGIN
  UPDATE contacts SET anonymized_at = now() WHERE id = '76000000-0000-4000-8000-0000000000c1';
  RAISE EXCEPTION 'agent set anonymized_at';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  UPDATE contacts SET anonymized_at = NULL WHERE id = '76000000-0000-4000-8000-0000000000c3';
  RAISE EXCEPTION 'agent un-anonymized a contact';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  UPDATE contacts SET name = 'Real name again', phone = '+5511900000000' WHERE id = '76000000-0000-4000-8000-0000000000c3';
  RAISE EXCEPTION 'agent rewrote an anonymized contact';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
UPDATE contacts SET name = 'Ana Souza', consent_status = 'granted', opted_out_at = now() WHERE id = '76000000-0000-4000-8000-0000000000c1';
UPDATE contacts SET opted_out_at = NULL WHERE id = '76000000-0000-4000-8000-0000000000c2';  -- inbox "reactivate"
SELECT pg_temp.assert_true((SELECT opted_out_at IS NULL FROM contacts WHERE id = '76000000-0000-4000-8000-0000000000c2'), 'agent reactivates an opted-out contact');

-- 10. ai_contact_memories
INSERT INTO ai_contact_memories(id, account_id, contact_id, fact, status, source)
VALUES ('76000000-0000-4000-8000-0000000000d7', (SELECT acc_a FROM ids), '76000000-0000-4000-8000-0000000000c1',
        'Prefere contato pela manhã', 'active', 'ai');
SELECT pg_temp.assert_true((SELECT status = 'proposed' AND approved_by IS NULL FROM ai_contact_memories WHERE id = '76000000-0000-4000-8000-0000000000d7'),
  'AI fact inserted by a user is forced to proposed');
UPDATE ai_contact_memories SET status = 'active' WHERE id = '76000000-0000-4000-8000-0000000000d7';
SELECT pg_temp.assert_true((SELECT status = 'active' AND approved_by = '76000000-0000-4000-8000-0000000000ac' FROM ai_contact_memories
  WHERE id = '76000000-0000-4000-8000-0000000000d7'), 'agent approves a proposed fact (approved_by = auth.uid())');
INSERT INTO ai_contact_memories(account_id, contact_id, fact, status, source)
VALUES ((SELECT acc_a FROM ids), '76000000-0000-4000-8000-0000000000c1', 'Cliente desde 2019, pedido 123456', 'active', 'manual');
DO $$ BEGIN
  INSERT INTO ai_contact_memories(account_id, contact_id, fact, status, source)
  VALUES ((SELECT acc_a FROM ids), '76000000-0000-4000-8000-0000000000c1', 'CPF 529.982.247-25', 'active', 'manual');
  RAISE EXCEPTION 'CPF stored in contact memory';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  UPDATE ai_contact_memories SET fact = 'cartão 4111 1111 1111 1111' WHERE id = '76000000-0000-4000-8000-0000000000d7';
  RAISE EXCEPTION 'card number stored in contact memory';
EXCEPTION WHEN check_violation THEN NULL; END $$;
RESET ROLE;


-- ---- viewer A: memories -------------------------------------
INSERT INTO ai_contact_memories(id, account_id, contact_id, fact, status, source)
VALUES ('76000000-0000-4000-8000-0000000000d8', (SELECT acc_a FROM ids), '76000000-0000-4000-8000-0000000000c1', 'Gosta de café', 'proposed', 'ai');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"76000000-0000-4000-8000-0000000000ae","role":"authenticated"}', true);
UPDATE ai_contact_memories SET status = 'active' WHERE id = '76000000-0000-4000-8000-0000000000d8';
RESET ROLE;
SELECT pg_temp.assert_true((SELECT status = 'proposed' FROM ai_contact_memories WHERE id = '76000000-0000-4000-8000-0000000000d8'),
  'viewer cannot approve a fact');


-- ---- 6. profiles: a user without a profile cannot self-insert ----
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"76000000-0000-4000-8000-0000000000ff","role":"authenticated"}', true);
DO $$ BEGIN
  INSERT INTO profiles(user_id, account_id, account_role, full_name, email)
  VALUES ('76000000-0000-4000-8000-0000000000ff', (SELECT acc_a FROM ids), 'owner', 'Intruder', 'orphan@sec.test');
  RAISE EXCEPTION 'user inserted itself as owner of account A';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;


-- ---- service role -------------------------------------------
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT pg_temp.assert_true((SELECT access_token = 'cipher-new' FROM whatsapp_config WHERE account_id = (SELECT acc_a FROM ids)),
  'service role reads the whatsapp token (and the admin update landed)');
UPDATE contacts SET anonymized_at = now(), opted_out_at = now(), name = 'Contato anonimizado'
 WHERE id = '76000000-0000-4000-8000-0000000000c2';  -- anonymize flow
UPDATE accounts SET plan = 'empresa' WHERE id = (SELECT acc_a FROM ids);
INSERT INTO ai_contact_memories(id, account_id, contact_id, fact, status, source)
VALUES ('76000000-0000-4000-8000-0000000000d9', (SELECT acc_a FROM ids), '76000000-0000-4000-8000-0000000000c1', 'Tem dois filhos', 'active', 'ai');
SELECT pg_temp.assert_true((SELECT status = 'active' FROM ai_contact_memories WHERE id = '76000000-0000-4000-8000-0000000000d9'),
  'service role keeps its own status');
DO $$ BEGIN
  INSERT INTO ai_contact_memories(account_id, contact_id, fact, status, source)
  VALUES ((SELECT acc_a FROM ids), '76000000-0000-4000-8000-0000000000c1', 'documento 52998224725', 'proposed', 'ai');
  RAISE EXCEPTION 'service role stored a CPF';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO contact_notes(account_id, user_id, contact_id, note_text)
  VALUES ((SELECT acc_a FROM ids), '76000000-0000-4000-8000-00000000000a', '76000000-0000-4000-8000-0000000000c9', 'x');
  RAISE EXCEPTION 'service role linked a note to a contact of account B';
EXCEPTION WHEN foreign_key_violation THEN NULL; END $$;
RESET ROLE;
SELECT pg_temp.assert_true((SELECT anonymized_at IS NOT NULL FROM contacts WHERE id = '76000000-0000-4000-8000-0000000000c2'),
  'service role anonymizes');

SELECT 'security_hardening: all assertions passed' AS result;
ROLLBACK;
