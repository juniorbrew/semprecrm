-- ============================================================
-- Migration 111 (indicadores): ad_spend (tenant isolation, admin-only writes, anon denied, CHECKs,
-- billing block 094), origin_report spend_cents (whole months the period touches, time zone, pipeline
-- filter), ai_report and team_report numbers checked by hand, the 400-day cap.
--
-- Nothing is committed (ends in ROLLBACK). Needs the local DB migrated through 110; apply 111 in the
-- same run (111 has its own BEGIN/COMMIT, so it stays applied; it is idempotent):
--   (cat supabase/migrations/111_indicadores.sql supabase/tests/indicadores.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- Never run `supabase db reset`.
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
-- Rows an UPDATE/DELETE touched (a RESTRICTIVE / USING policy hides rows: 0, not an error).
CREATE FUNCTION pg_temp.rows(stmt text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN EXECUTE stmt; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- tenants ---------------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('11100000-0000-4000-8000-00000000000a', 'owner-a@ind.test', '{"full_name":"Owner A"}'),
 ('11100000-0000-4000-8000-00000000000b', 'owner-b@ind.test', '{"full_name":"Owner B"}'),
 ('11100000-0000-4000-8000-00000000000c', 'agent@ind.test', '{"full_name":"Agent"}'),
 ('11100000-0000-4000-8000-00000000000e', 'admin@ind.test', '{"full_name":"Admin"}');
CREATE TEMP TABLE ctx AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '11100000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '11100000-0000-4000-8000-00000000000b') AS acc_b;
GRANT SELECT ON ctx TO anon, authenticated, service_role;
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'agent' WHERE user_id = '11100000-0000-4000-8000-00000000000c';
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'admin' WHERE user_id = '11100000-0000-4000-8000-00000000000e';
UPDATE accounts SET plan_status = 'active', plan_expires_at = NULL WHERE id IN ((SELECT acc_a FROM ctx), (SELECT acc_b FROM ctx));
UPDATE accounts SET default_currency = 'BRL' WHERE id = (SELECT acc_a FROM ctx);
-- fixed profile ids (deals.assigned_to points at profiles.id)
UPDATE profiles SET id = '11100000-0000-4000-8000-0000000000a1' WHERE user_id = '11100000-0000-4000-8000-00000000000a';
UPDATE profiles SET id = '11100000-0000-4000-8000-0000000000c1' WHERE user_id = '11100000-0000-4000-8000-00000000000c';
UPDATE profiles SET id = '11100000-0000-4000-8000-0000000000e1' WHERE user_id = '11100000-0000-4000-8000-00000000000e';
UPDATE profiles SET id = '11100000-0000-4000-8000-0000000000b1' WHERE user_id = '11100000-0000-4000-8000-00000000000b';

-- ================= ad_spend: access ====================================================
INSERT INTO ad_spend(account_id, origin_type, channel, name, source, month, amount_cents) VALUES
  ((SELECT acc_a FROM ctx), 'ad', 'instagram', 'Anuncio A', '', '2026-11-01', 5000),
  ((SELECT acc_b FROM ctx), 'ad', 'instagram', 'Anuncio B', '', '2026-11-01', 9999);

-- an agent reads, never writes
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11100000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM ad_spend), 1, 'agent reads only the spend of its account');
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO ad_spend(account_id, origin_type, name, month, amount_cents) VALUES (%L, 'ad', 'X', '2026-11-01', 1)$q$, (SELECT acc_a FROM ctx)),
  '42501', 'agent cannot insert spend');
SELECT pg_temp.assert_eq(pg_temp.rows($q$UPDATE ad_spend SET amount_cents = 1$q$), 0, 'agent cannot update spend');
SELECT pg_temp.assert_eq(pg_temp.rows($q$DELETE FROM ad_spend$q$), 0, 'agent cannot delete spend');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- tenant B: sees only its row, cannot write into A
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11100000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(name = 'Anuncio B') FROM ad_spend), 'tenant B sees only its own spend');
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO ad_spend(account_id, origin_type, name, month, amount_cents) VALUES (%L, 'ad', 'X', '2026-11-01', 1)$q$, (SELECT acc_a FROM ctx)),
  '42501', 'B cannot write spend into A');
SELECT pg_temp.assert_eq(pg_temp.rows($q$UPDATE ad_spend SET amount_cents = 1 WHERE name = 'Anuncio A'$q$), 0, 'B cannot update A');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- anon: no grant at all
SET ROLE anon;
SELECT pg_temp.assert_fails_with($q$SELECT count(*) FROM ad_spend$q$, '42501', 'anon cannot read ad_spend');
SELECT pg_temp.assert_fails_with($q$SELECT * FROM origin_report(now() - interval '1 day', now())$q$, '42501', 'anon cannot call origin_report');
SELECT pg_temp.assert_fails_with(format($q$SELECT * FROM ai_report(%L, now() - interval '1 day', now())$q$, (SELECT acc_a FROM ctx)), '42501', 'anon cannot call ai_report');
SELECT pg_temp.assert_fails_with(format($q$SELECT * FROM team_report(%L, now() - interval '1 day', now())$q$, (SELECT acc_a FROM ctx)), '42501', 'anon cannot call team_report');
RESET ROLE;

-- an admin writes; who / currency are stamped by the trigger
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11100000-0000-4000-8000-00000000000e', true);
INSERT INTO ad_spend(account_id, origin_type, channel, name, month, amount_cents, currency, updated_by) VALUES
  ((SELECT acc_a FROM ctx), 'ad', 'instagram', 'Anuncio C', '2026-11-01', 700, 'USD', '11100000-0000-4000-8000-00000000000a');
SELECT pg_temp.assert_true((SELECT currency = 'BRL' AND updated_by = '11100000-0000-4000-8000-00000000000e' FROM ad_spend WHERE name = 'Anuncio C'),
  'currency is the account one, updated_by is the caller');
-- upsert on the key (what the app does) replaces the amount
INSERT INTO ad_spend(account_id, origin_type, channel, name, source, month, amount_cents) VALUES
  ((SELECT acc_a FROM ctx), 'ad', 'instagram', 'Anuncio C', '', '2026-11-01', 900)
  ON CONFLICT (account_id, origin_type, channel, name, source, month) DO UPDATE SET amount_cents = EXCLUDED.amount_cents;
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND max(amount_cents) = 900 FROM ad_spend WHERE name = 'Anuncio C'), 'one spend per ad per month (upsert)');
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO ad_spend(account_id, origin_type, channel, name, month, amount_cents) VALUES (%L, 'ad', 'instagram', 'Anuncio C', '2026-11-01', 1)$q$, (SELECT acc_a FROM ctx)),
  '23505', 'duplicate key refused');
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO ad_spend(account_id, origin_type, name, month, amount_cents) VALUES (%L, 'ad', 'Neg', '2026-11-01', -1)$q$, (SELECT acc_a FROM ctx)), '23514', 'negative amount');
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO ad_spend(account_id, origin_type, name, month, amount_cents) VALUES (%L, 'ad', 'Big', '2026-11-01', 100000000001)$q$, (SELECT acc_a FROM ctx)), '23514', 'amount over the cap');
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO ad_spend(account_id, origin_type, name, month, amount_cents) VALUES (%L, 'ad', 'Day', '2026-11-15', 1)$q$, (SELECT acc_a FROM ctx)), '23514', 'month must be the first day');
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO ad_spend(account_id, origin_type, name, month, amount_cents) VALUES (%L, 'direct', 'Dir', '2026-11-01', 1)$q$, (SELECT acc_a FROM ctx)), '23514', 'direct has no spend');
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO ad_spend(account_id, origin_type, name, month, amount_cents) VALUES (%L, 'ad', '', '2026-11-01', 1)$q$, (SELECT acc_a FROM ctx)), '23514', 'blank name');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- billing block (094): a read-only account writes nothing but still reads
UPDATE accounts SET plan_status = 'canceled' WHERE id = (SELECT acc_a FROM ctx);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11100000-0000-4000-8000-00000000000e', true);
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO ad_spend(account_id, origin_type, name, month, amount_cents) VALUES (%L, 'ad', 'Late', '2026-11-01', 1)$q$, (SELECT acc_a FROM ctx)),
  '42501', 'read-only account: insert refused');
SELECT pg_temp.assert_eq(pg_temp.rows($q$UPDATE ad_spend SET amount_cents = 1$q$), 0, 'read-only account: update refused');
SELECT pg_temp.assert_eq(pg_temp.rows($q$DELETE FROM ad_spend$q$), 0, 'read-only account: delete refused');
SELECT pg_temp.assert_eq((SELECT count(*) FROM ad_spend), 2, 'read-only account still reads its spend');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
UPDATE accounts SET plan_status = 'active' WHERE id = (SELECT acc_a FROM ctx);
DELETE FROM ad_spend;

-- ================= origin_report: spend_cents ==========================================
-- Spend-only bucket "S": Oct 100, Nov 200, Dec 400 (no customer, no deal). Tenant B has its own.
INSERT INTO ad_spend(account_id, origin_type, channel, name, month, amount_cents) VALUES
  ((SELECT acc_a FROM ctx), 'campaign', 'site_bot', 'S', '2026-10-01', 100),
  ((SELECT acc_a FROM ctx), 'campaign', 'site_bot', 'S', '2026-11-01', 200),
  ((SELECT acc_a FROM ctx), 'campaign', 'site_bot', 'S', '2026-12-01', 400),
  ((SELECT acc_b FROM ctx), 'campaign', 'site_bot', 'S', '2026-11-01', 5);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11100000-0000-4000-8000-00000000000a', true);
-- 10/11 to 20/11 (local) -> November only
SELECT pg_temp.assert_eq((SELECT spend_cents FROM origin_report('2026-11-10 00:00-03', '2026-11-21 00:00-03', NULL, NULL, 'America/Sao_Paulo') WHERE name = 'S'), 200, 'mid-month period uses the whole month');
-- 25/10 to 04/11 -> October + November
SELECT pg_temp.assert_eq((SELECT spend_cents FROM origin_report('2026-10-25 00:00-03', '2026-11-05 00:00-03', NULL, NULL, 'America/Sao_Paulo') WHERE name = 'S'), 300, 'period across two months sums both');
-- exactly November: the exclusive end at 00:00 of December does not touch December
SELECT pg_temp.assert_eq((SELECT spend_cents FROM origin_report('2026-11-01 00:00-03', '2026-12-01 00:00-03', NULL, NULL, 'America/Sao_Paulo') WHERE name = 'S'), 200, 'whole November does not touch December');
SELECT pg_temp.assert_eq((SELECT spend_cents FROM origin_report('2026-11-01 00:00Z', '2026-12-01 00:00Z') WHERE name = 'S'), 200, 'no time zone: UTC');
-- the time zone matters: 2026-12-01 02:00Z is still 30/11 in Sao Paulo (Nov) but already December in UTC
SELECT pg_temp.assert_eq((SELECT spend_cents FROM origin_report('2026-11-20 00:00Z', '2026-12-01 02:00Z', NULL, NULL, 'America/Sao_Paulo') WHERE name = 'S'), 200, 'time zone keeps 30/11 local in November');
SELECT pg_temp.assert_eq((SELECT spend_cents FROM origin_report('2026-11-20 00:00Z', '2026-12-01 02:00Z') WHERE name = 'S'), 600, 'UTC sees December too');
-- a month without spend and without activity: no bucket (and tenant B spend never leaks into A)
SELECT pg_temp.assert_eq((SELECT count(*) FROM origin_report('2026-09-01 00:00Z', '2026-09-10 00:00Z')), 0, 'a month without spend and activity: no bucket');
-- a pipeline filter drops the spend (it belongs to the ad, not to a pipeline)
SELECT pg_temp.assert_eq((SELECT count(*) FROM origin_report('2026-11-10 00:00-03', '2026-11-21 00:00-03', NULL, '11100000-0000-4000-8000-0000000000f1', 'America/Sao_Paulo')), 0, 'pipeline filter: no spend-only rows');
SELECT pg_temp.assert_fails_with($q$SELECT * FROM origin_report(now() - interval '401 days', now())$q$, '22023', 'origin_report keeps the 400-day cap');
SELECT pg_temp.assert_fails_with($q$SELECT * FROM origin_report(now() - interval '1 day', now(), NULL, NULL, 'Not/AZone')$q$, '22023', 'invalid time zone refused');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- a bucket with a customer and a deal AND spend: the columns of 109 are unchanged, spend joins by key
INSERT INTO pipelines(id, user_id, account_id, name) VALUES
  ('11100000-0000-4000-8000-0000000000f1', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), 'Funil 1');
INSERT INTO pipeline_stages(id, pipeline_id, name) VALUES ('11100000-0000-4000-8000-0000000000e1', '11100000-0000-4000-8000-0000000000f1', 'Novo');
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
  ('11100000-0000-4000-8000-0000000000c1', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511911110001', 'C1');
INSERT INTO lead_origins(id, account_id, contact_id, channel, kind, ad_id, headline, occurred_at) VALUES
  ('11100000-0000-4000-8000-0000000000a1', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000000c1', 'instagram', 'ad', 'AD1', 'Promo X', now());
UPDATE contacts SET first_origin_id = '11100000-0000-4000-8000-0000000000a1', last_origin_id = '11100000-0000-4000-8000-0000000000a1' WHERE id = '11100000-0000-4000-8000-0000000000c1';
INSERT INTO deals(user_id, account_id, pipeline_id, stage_id, contact_id, title, value, status) VALUES
  ('11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000000f1', '11100000-0000-4000-8000-0000000000e1', '11100000-0000-4000-8000-0000000000c1', 'DP', 800, 'won');
INSERT INTO ad_spend(account_id, origin_type, channel, name, month, amount_cents) VALUES
  ((SELECT acc_a FROM ctx), 'ad', 'instagram', 'Promo X', date_trunc('month', now() AT TIME ZONE 'UTC')::date, 12345);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11100000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_true((SELECT customers = 1 AND deals_created = 1 AND deals_won = 1 AND won_value = 800 AND spend_cents = 12345
   FROM origin_report(now() - interval '1 day', now() + interval '1 day', NULL, NULL, 'UTC') WHERE name = 'Promo X'), 'bucket with data and spend');
SELECT pg_temp.assert_true((SELECT spend_cents IS NULL AND customers = 1
   FROM origin_report(now() - interval '1 day', now() + interval '1 day', NULL, '11100000-0000-4000-8000-0000000000f1', 'UTC') WHERE name = 'Promo X'), 'pipeline filter: spend is NULL, the rest stays');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- ================= ai_report ===========================================================
INSERT INTO contacts(id, user_id, account_id, phone, name)
SELECT ('11100000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+55119111101' || lpad(g::text, 2, '0'), 'K' || g
  FROM generate_series(1, 4) g;
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
  ('11100000-0000-4000-8000-0000000001b1', '11100000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ctx), '+5511911110199', 'KB');
INSERT INTO conversations(id, user_id, account_id, contact_id) VALUES
  ('11100000-0000-4000-8000-0000000002d1', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-000000000101'),
  ('11100000-0000-4000-8000-0000000002d2', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-000000000102'),
  ('11100000-0000-4000-8000-0000000002d3', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-000000000103'),
  ('11100000-0000-4000-8000-0000000002d4', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-000000000104'),
  ('11100000-0000-4000-8000-0000000002db', '11100000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ctx), '11100000-0000-4000-8000-0000000001b1');
-- d1: 2 AI messages + a person (agent c). d2: 1 AI message. d3: 1 AI message. d4: person only (admin e). B: 1 AI message.
INSERT INTO messages(conversation_id, sender_type, sender_id, content_text, origin, created_at) VALUES
  ('11100000-0000-4000-8000-0000000002d1', 'bot', NULL, 'oi', 'ai', now() - interval '3 hours'),
  ('11100000-0000-4000-8000-0000000002d1', 'bot', NULL, 'ola', 'ai', now() - interval '2 hours'),
  ('11100000-0000-4000-8000-0000000002d1', 'agent', '11100000-0000-4000-8000-00000000000c', 'assumo', NULL, now() - interval '1 hour'),
  ('11100000-0000-4000-8000-0000000002d2', 'bot', NULL, 'oi', 'ai', now() - interval '3 hours'),
  ('11100000-0000-4000-8000-0000000002d3', 'bot', NULL, 'oi', 'ai', now() - interval '3 hours'),
  ('11100000-0000-4000-8000-0000000002d4', 'agent', '11100000-0000-4000-8000-00000000000e', 'oi', NULL, now() - interval '3 hours'),
  ('11100000-0000-4000-8000-0000000002db', 'bot', NULL, 'oi', 'ai', now() - interval '3 hours'),
  -- an AI message long before the period: does not count
  ('11100000-0000-4000-8000-0000000002d4', 'bot', NULL, 'antigo', 'ai', now() - interval '30 days');
INSERT INTO conversation_events(account_id, conversation_id, actor_user_id, event_type, payload, created_at) VALUES
  ((SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000002d1', NULL, 'ai_handoff', '{"reason":"preco"}', now() - interval '90 minutes'),
  ((SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000002d3', NULL, 'ai_handoff', '{"reason":"preco"}', now() - interval '80 minutes'),
  ((SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000002d3', NULL, 'ai_handoff', '{"reason":"prazo"}', now() - interval '70 minutes'),
  ((SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000002d2', NULL, 'status_changed', '{"status":"closed"}', now() - interval '30 minutes'),
  ((SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000002d1', '11100000-0000-4000-8000-00000000000c', 'status_changed', '{"status":"closed"}', now() - interval '20 minutes'),
  ((SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000002d4', '11100000-0000-4000-8000-00000000000e', 'status_changed', '{"status":"closed"}', now() - interval '20 minutes'),
  ((SELECT acc_b FROM ctx), '11100000-0000-4000-8000-0000000002db', NULL, 'ai_handoff', '{"reason":"B"}', now() - interval '80 minutes');
INSERT INTO ai_usage(account_id, feature, provider, model, cost_cents, status, created_at) VALUES
  ((SELECT acc_a FROM ctx), 'auto_reply', 'openai', 'm', 12.5, 'ok', now() - interval '3 hours'),
  ((SELECT acc_a FROM ctx), 'auto_reply', 'openai', 'm', 2.5, 'error', now() - interval '2 hours'),
  ((SELECT acc_a FROM ctx), 'triage', 'openai', 'm', 5, 'ok', now() - interval '2 hours'),
  ((SELECT acc_a FROM ctx), 'suggest_reply', 'openai', 'm', 100, 'blocked', now() - interval '2 hours'),
  ((SELECT acc_a FROM ctx), 'auto_reply', 'openai', 'm', 99, 'ok', now() - interval '30 days'),
  ((SELECT acc_b FROM ctx), 'auto_reply', 'openai', 'm', 77, 'ok', now() - interval '2 hours');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11100000-0000-4000-8000-00000000000a', true);
-- attended: d1, d2, d3 = 3. handed off: d1, d3 = 2 (d3 has two events but counts once). top reason: preco x2.
-- resolved without a person: d2 (closed, never an agent message) = 1; d1 has an agent message, d4 never had an AI message.
-- AI messages in the period: d1 2 + d2 1 + d3 1 = 4.
SELECT pg_temp.assert_true((SELECT attended = 3 AND handed_off = 2 AND top_reason = 'preco' AND top_reason_count = 2
                                   AND resolved_without_person = 1 AND ai_messages = 4
   FROM ai_report((SELECT acc_a FROM ctx), now() - interval '1 day', now() + interval '1 day')), 'ai_report counts');
-- cost: auto_reply 12.5 + 2.5 = 15 over 2 calls, triage 5; the blocked row, the old row and tenant B are out
SELECT pg_temp.assert_true((SELECT cost_by_feature = '[{"feature":"auto_reply","calls":2,"cost_cents":15.0},{"feature":"triage","calls":1,"cost_cents":5.0}]'::jsonb
   FROM ai_report((SELECT acc_a FROM ctx), now() - interval '1 day', now() + interval '1 day')), 'ai_report cost by feature');
SELECT pg_temp.assert_true((SELECT NOT ai_enabled FROM ai_report((SELECT acc_a FROM ctx), now() - interval '1 day', now() + interval '1 day')), 'AI is off without ai_settings');
SELECT pg_temp.assert_fails_with(format($q$SELECT * FROM ai_report(%L, now() - interval '1 day', now())$q$, (SELECT acc_b FROM ctx)), '42501', 'owner of A cannot read the AI report of B');
SELECT pg_temp.assert_fails_with(format($q$SELECT * FROM ai_report(%L, now() - interval '401 days', now())$q$, (SELECT acc_a FROM ctx)), '22023', 'ai_report 400-day cap');
SELECT pg_temp.assert_fails_with(format($q$SELECT * FROM ai_report(%L, now() - interval '1 day', 'infinity')$q$, (SELECT acc_a FROM ctx)), '22023', 'ai_report finite period');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
-- an agent sees the counts, never the cost
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11100000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_true((SELECT attended = 3 AND cost_by_feature IS NULL FROM ai_report((SELECT acc_a FROM ctx), now() - interval '1 day', now() + interval '1 day')), 'agent: counts yes, cost hidden');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- ================= team_report =========================================================
UPDATE conversations SET first_response_by = '11100000-0000-4000-8000-00000000000c', first_response_seconds = 30, first_response_at = now() - interval '1 hour'
 WHERE id = '11100000-0000-4000-8000-0000000002d1';
UPDATE conversations SET first_response_by = '11100000-0000-4000-8000-00000000000e', first_response_seconds = 60, first_response_at = now() - interval '3 hours'
 WHERE id = '11100000-0000-4000-8000-0000000002d4';
UPDATE conversations SET assigned_agent_id = '11100000-0000-4000-8000-00000000000c', status = 'open' WHERE id = '11100000-0000-4000-8000-0000000002d3';
-- deals closed in the period: agent c won 1000 + 500, lost 1; admin e lost 1; owner a nothing. Old win and open deal are out.
INSERT INTO deals(id, user_id, account_id, pipeline_id, stage_id, contact_id, title, value, status, assigned_to) VALUES
  ('11100000-0000-4000-8000-000000000d01', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000000f1', '11100000-0000-4000-8000-0000000000e1', NULL, 'T1', 1000, 'won',  '11100000-0000-4000-8000-0000000000c1'),
  ('11100000-0000-4000-8000-000000000d02', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000000f1', '11100000-0000-4000-8000-0000000000e1', NULL, 'T2', 500,  'won',  '11100000-0000-4000-8000-0000000000c1'),
  ('11100000-0000-4000-8000-000000000d03', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000000f1', '11100000-0000-4000-8000-0000000000e1', NULL, 'T3', 300,  'lost', '11100000-0000-4000-8000-0000000000c1'),
  ('11100000-0000-4000-8000-000000000d04', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000000f1', '11100000-0000-4000-8000-0000000000e1', NULL, 'T4', 200,  'lost', '11100000-0000-4000-8000-0000000000e1'),
  ('11100000-0000-4000-8000-000000000d05', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000000f1', '11100000-0000-4000-8000-0000000000e1', NULL, 'T5', 7777, 'won',  '11100000-0000-4000-8000-0000000000c1'),
  ('11100000-0000-4000-8000-000000000d06', '11100000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '11100000-0000-4000-8000-0000000000f1', '11100000-0000-4000-8000-0000000000e1', NULL, 'T6', 50,   'open', '11100000-0000-4000-8000-0000000000c1');
UPDATE deals SET closed_at = now() - interval '2 hours' WHERE id IN ('11100000-0000-4000-8000-000000000d01', '11100000-0000-4000-8000-000000000d02', '11100000-0000-4000-8000-000000000d03', '11100000-0000-4000-8000-000000000d04');
UPDATE deals SET closed_at = now() - interval '10 days' WHERE id = '11100000-0000-4000-8000-000000000d05';

-- every role of the account sees the whole table (owner decision: like the dashboard)
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11100000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM team_report((SELECT acc_a FROM ctx), now() - interval '1 day', now() + interval '1 day')), 3, 'one row per member (owner, admin, agent), seen by an agent');
-- agent c: handled d1 = 1, resolved 1 (closed d1), first response 30 s x1, no tasks, open 1 (d3), won 2 / 1500, lost 1
SELECT pg_temp.assert_true((SELECT handled = 1 AND resolved = 1 AND first_response_avg_seconds = 30 AND first_response_median_seconds = 30 AND first_response_samples = 1
                                   AND tasks_completed = 0 AND open_assigned = 1 AND deals_won = 2 AND deals_lost = 1 AND won_value = 1500
   FROM team_report((SELECT acc_a FROM ctx), now() - interval '1 day', now() + interval '1 day') WHERE user_id = '11100000-0000-4000-8000-00000000000c'), 'agent numbers');
-- admin e: handled d4 = 1, resolved d4 = 1, first response 60 s, no open, lost 1, nothing won
SELECT pg_temp.assert_true((SELECT handled = 1 AND resolved = 1 AND first_response_avg_seconds = 60 AND open_assigned = 0 AND deals_won = 0 AND deals_lost = 1 AND won_value = 0
   FROM team_report((SELECT acc_a FROM ctx), now() - interval '1 day', now() + interval '1 day') WHERE user_id = '11100000-0000-4000-8000-00000000000e'), 'admin numbers');
-- owner a: idle, zeros, no first response
SELECT pg_temp.assert_true((SELECT handled = 0 AND resolved = 0 AND first_response_avg_seconds IS NULL AND first_response_samples = 0 AND deals_won = 0 AND deals_lost = 0
   FROM team_report((SELECT acc_a FROM ctx), now() - interval '1 day', now() + interval '1 day') WHERE user_id = '11100000-0000-4000-8000-00000000000a'), 'idle member is a row of zeros');
-- a wider window brings the old win of c in; a window before everything has zeros
SELECT pg_temp.assert_true((SELECT deals_won = 3 AND won_value = 9277 FROM team_report((SELECT acc_a FROM ctx), now() - interval '20 days', now() + interval '1 day') WHERE user_id = '11100000-0000-4000-8000-00000000000c'), 'wider period includes the old deal');
SELECT pg_temp.assert_true((SELECT sum(handled) = 0 AND sum(deals_won) = 0 FROM team_report((SELECT acc_a FROM ctx), now() - interval '40 days', now() - interval '35 days')), 'empty period');
SELECT pg_temp.assert_fails_with(format($q$SELECT * FROM team_report(%L, now() - interval '401 days', now())$q$, (SELECT acc_a FROM ctx)), '22023', 'team_report 400-day cap');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
-- tenant isolation: B asks for A and is refused; B's own table has only B's member
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11100000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_fails_with(format($q$SELECT * FROM team_report(%L, now() - interval '1 day', now())$q$, (SELECT acc_a FROM ctx)), '42501', 'B cannot read the team of A');
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(user_id = '11100000-0000-4000-8000-00000000000b')
   FROM team_report((SELECT acc_b FROM ctx), now() - interval '1 day', now() + interval '1 day')), 'B sees only its own member');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- grants: closed to PUBLIC / anon, open to authenticated
SELECT pg_temp.assert_true(
  has_function_privilege('authenticated', 'public.ai_report(uuid,timestamptz,timestamptz)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.team_report(uuid,timestamptz,timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.ai_report(uuid,timestamptz,timestamptz)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.team_report(uuid,timestamptz,timestamptz)', 'EXECUTE')
  AND NOT has_table_privilege('anon', 'public.ad_spend', 'SELECT'), 'grants');

ROLLBACK;
SELECT 'indicadores.sql: all assertions passed' AS result;
