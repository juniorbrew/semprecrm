-- ============================================================
-- Migration 109 (lead_origins, origin pointers, deal trigger, origin_report): tenant
-- isolation, anon denied, click_id hidden from authenticated, CHECKs, guards, the 30-day
-- rule, manual override by role, origin_report numbers checked by hand, LGPD delete,
-- billing block (094).
--
-- Nothing is committed (ends in ROLLBACK). Needs the local DB migrated through 108; apply 109
-- in the same run:
--   (cat supabase/migrations/109_lead_origins.sql supabase/tests/lead_origins.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- (109 has its own BEGIN/COMMIT, so it stays applied; everything this file creates is rolled
-- back at its end. 109 is idempotent.) Never run `supabase db reset`.
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
-- Rows an UPDATE/DELETE touched (a RESTRICTIVE USING hides rows: 0, not an error).
CREATE FUNCTION pg_temp.rows(stmt text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN EXECUTE stmt; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $$;
-- 076 closes new functions by default: open this script's pg_temp helpers.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- tenants ---------------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('10900000-0000-4000-8000-00000000000a', 'owner-a@orig.test', '{"full_name":"Owner A"}'),
 ('10900000-0000-4000-8000-00000000000b', 'owner-b@orig.test', '{"full_name":"Owner B"}'),
 ('10900000-0000-4000-8000-00000000000c', 'agent@orig.test', '{"full_name":"Agent"}'),
 ('10900000-0000-4000-8000-00000000000e', 'admin@orig.test', '{"full_name":"Admin"}');
CREATE TEMP TABLE ctx AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '10900000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '10900000-0000-4000-8000-00000000000b') AS acc_b;
GRANT SELECT ON ctx TO anon, authenticated, service_role;
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'agent' WHERE user_id = '10900000-0000-4000-8000-00000000000c';
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'admin' WHERE user_id = '10900000-0000-4000-8000-00000000000e';
UPDATE accounts SET plan_status = 'active', plan_expires_at = NULL WHERE id IN ((SELECT acc_a FROM ctx), (SELECT acc_b FROM ctx));

-- ---- seed (as the superuser = a trusted server path) -----------------------
INSERT INTO pipelines(id, user_id, account_id, name) VALUES
  ('10900000-0000-4000-8000-0000000000f1', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), 'Funil 1'),
  ('10900000-0000-4000-8000-0000000000f2', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), 'Funil 2'),
  ('10900000-0000-4000-8000-0000000000f3', '10900000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ctx), 'Funil B');
INSERT INTO pipeline_stages(id, pipeline_id, name) VALUES
  ('10900000-0000-4000-8000-0000000000e1', '10900000-0000-4000-8000-0000000000f1', 'Novo'),
  ('10900000-0000-4000-8000-0000000000e2', '10900000-0000-4000-8000-0000000000f2', 'Novo'),
  ('10900000-0000-4000-8000-0000000000e3', '10900000-0000-4000-8000-0000000000f3', 'Novo');
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
  ('10900000-0000-4000-8000-0000000000c1', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900010001', 'C1'),
  ('10900000-0000-4000-8000-0000000000c2', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900010002', 'C2'),
  ('10900000-0000-4000-8000-0000000000c3', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900010003', 'C3'),
  ('10900000-0000-4000-8000-0000000000c4', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900010004', 'C4'),
  ('10900000-0000-4000-8000-0000000000c5', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900010005', 'C5'),
  ('10900000-0000-4000-8000-0000000000cb', '10900000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ctx), '+5511900010099', 'CB');
INSERT INTO conversations(id, user_id, account_id, contact_id) VALUES
  ('10900000-0000-4000-8000-0000000000d1', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000c1'),
  ('10900000-0000-4000-8000-0000000000db', '10900000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ctx), '10900000-0000-4000-8000-0000000000cb');

-- c1, c2: the same Instagram ad. c3: site campaign. c4: no touch. c5: a touch 31 days old.
INSERT INTO lead_origins(id, account_id, contact_id, conversation_id, channel, kind, ad_id, headline, source_url, click_id_type, click_id, occurred_at) VALUES
  ('10900000-0000-4000-8000-0000000000a1', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000c1', '10900000-0000-4000-8000-0000000000d1',
   'instagram', 'ad', 'AD1', 'Promoção sofás', 'https://fb.me/x', 'ctwa_clid', 'SECRET-CLICK-ID', now() - interval '2 days'),
  ('10900000-0000-4000-8000-0000000000a2', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000c2', NULL,
   'instagram', 'ad', 'AD1', 'Promoção sofás', NULL, NULL, NULL, now() - interval '1 day');
INSERT INTO lead_origins(id, account_id, contact_id, channel, kind, utm_source, utm_campaign, occurred_at) VALUES
  ('10900000-0000-4000-8000-0000000000a3', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000c3',
   'site_bot', 'campaign', 'google', 'black-friday', now() - interval '3 hours'),
  ('10900000-0000-4000-8000-0000000000a5', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000c5',
   'site_bot', 'campaign', 'google', 'antiga', now() - interval '31 days');
INSERT INTO lead_origins(id, account_id, contact_id, channel, kind, headline, occurred_at) VALUES
  ('10900000-0000-4000-8000-0000000000ab', (SELECT acc_b FROM ctx), '10900000-0000-4000-8000-0000000000cb', 'whatsapp', 'ad', 'Anuncio da B', now());
UPDATE contacts SET first_origin_id = '10900000-0000-4000-8000-0000000000a1', last_origin_id = '10900000-0000-4000-8000-0000000000a1' WHERE id = '10900000-0000-4000-8000-0000000000c1';
UPDATE contacts SET first_origin_id = '10900000-0000-4000-8000-0000000000a2', last_origin_id = '10900000-0000-4000-8000-0000000000a2' WHERE id = '10900000-0000-4000-8000-0000000000c2';
UPDATE contacts SET first_origin_id = '10900000-0000-4000-8000-0000000000a3', last_origin_id = '10900000-0000-4000-8000-0000000000a3' WHERE id = '10900000-0000-4000-8000-0000000000c3';
UPDATE contacts SET first_origin_id = '10900000-0000-4000-8000-0000000000a5', last_origin_id = '10900000-0000-4000-8000-0000000000a5' WHERE id = '10900000-0000-4000-8000-0000000000c5';
UPDATE contacts SET first_origin_id = '10900000-0000-4000-8000-0000000000ab', last_origin_id = '10900000-0000-4000-8000-0000000000ab' WHERE id = '10900000-0000-4000-8000-0000000000cb';

-- Deals are inserted WITHOUT an origin: the trigger copies the contact's last touch (30 days).
INSERT INTO deals(id, user_id, account_id, pipeline_id, stage_id, contact_id, title, value, status) VALUES
  ('10900000-0000-4000-8000-000000000d01', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000f1', '10900000-0000-4000-8000-0000000000e1', '10900000-0000-4000-8000-0000000000c1', 'D1', 1000, 'won'),
  ('10900000-0000-4000-8000-000000000d02', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000f1', '10900000-0000-4000-8000-0000000000e1', '10900000-0000-4000-8000-0000000000c2', 'D2', 500, 'won'),
  ('10900000-0000-4000-8000-000000000d03', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000f1', '10900000-0000-4000-8000-0000000000e1', '10900000-0000-4000-8000-0000000000c2', 'D3', 200, 'open'),
  ('10900000-0000-4000-8000-000000000d04', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000f2', '10900000-0000-4000-8000-0000000000e2', '10900000-0000-4000-8000-0000000000c3', 'D4', 300, 'won'),
  ('10900000-0000-4000-8000-000000000d05', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000f1', '10900000-0000-4000-8000-0000000000e1', '10900000-0000-4000-8000-0000000000c4', 'D5', 100, 'open'),
  ('10900000-0000-4000-8000-000000000d06', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000f1', '10900000-0000-4000-8000-0000000000e1', '10900000-0000-4000-8000-0000000000c5', 'D6', 50, 'open');
INSERT INTO deals(id, user_id, account_id, pipeline_id, stage_id, contact_id, title, value, status) VALUES
  ('10900000-0000-4000-8000-000000000db1', '10900000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ctx), '10900000-0000-4000-8000-0000000000f3', '10900000-0000-4000-8000-0000000000e3', '10900000-0000-4000-8000-0000000000cb', 'DB', 999, 'won');

-- ---- the deal trigger: last touch within 30 days ------------------------------
SELECT pg_temp.assert_true((SELECT origin_id = '10900000-0000-4000-8000-0000000000a1' FROM deals WHERE title = 'D1' AND account_id = (SELECT acc_a FROM ctx)), 'D1 gets the last touch of C1');
SELECT pg_temp.assert_true((SELECT origin_id = '10900000-0000-4000-8000-0000000000a3' FROM deals WHERE title = 'D4' AND account_id = (SELECT acc_a FROM ctx)), 'D4 gets the last touch of C3');
SELECT pg_temp.assert_true((SELECT origin_id IS NULL FROM deals WHERE title = 'D5' AND account_id = (SELECT acc_a FROM ctx)), 'C4 has no touch: no origin');
SELECT pg_temp.assert_true((SELECT origin_id IS NULL FROM deals WHERE title = 'D6' AND account_id = (SELECT acc_a FROM ctx)), 'C5 touch is 31 days old: no origin');
SELECT pg_temp.assert_true((SELECT origin_id = '10900000-0000-4000-8000-0000000000ab' FROM deals WHERE title = 'DB'), 'tenant B deal gets its own contact touch');
-- a touch of another account is refused even from the server
SELECT pg_temp.assert_fails_with(
  $q$INSERT INTO deals(user_id, account_id, pipeline_id, stage_id, contact_id, title, origin_id) VALUES
     ('10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000f1', '10900000-0000-4000-8000-0000000000e1', NULL, 'X', '10900000-0000-4000-8000-0000000000ab')$q$,
  '23503', 'server cannot stamp an origin of another account');

-- ---- origin_report, as the owner of A: numbers checked by hand -------------------
-- instagram / ad / "Promoção sofás": customers C1+C2 = 2; deals D1,D2,D3 = 3; won D1,D2 = 2; 1000+500 = 1500; 66.7 %; ticket 750
-- site_bot / campaign black-friday (google): customers C3 = 1; deals D4 = 1; won 1; 300; 100 %; ticket 300
-- campaign antiga: customers C5 (first touch, 31 days old) = 1; no deal carries it
-- direct: customers C4 = 1; deals D5, D6 (no origin within 30 days) = 2; won 0
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10900000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM origin_report(now() - interval '1 day', now() + interval '1 day')), 4, 'report has 4 buckets');
SELECT pg_temp.assert_true((SELECT customers = 2 AND deals_created = 3 AND deals_won = 2 AND won_value = 1500 AND conversion_pct = 66.7 AND avg_ticket = 750
   FROM origin_report(now() - interval '1 day', now() + interval '1 day') WHERE origin_type = 'ad' AND channel = 'instagram' AND name = 'Promoção sofás'), 'ad bucket numbers');
SELECT pg_temp.assert_true((SELECT customers = 1 AND deals_created = 1 AND deals_won = 1 AND won_value = 300 AND conversion_pct = 100 AND avg_ticket = 300 AND source = 'google'
   FROM origin_report(now() - interval '1 day', now() + interval '1 day') WHERE origin_type = 'campaign' AND name = 'black-friday'), 'campaign bucket numbers');
SELECT pg_temp.assert_true((SELECT customers = 1 AND deals_created = 2 AND deals_won = 0 AND won_value = 0 AND conversion_pct = 0 AND avg_ticket = 0
   FROM origin_report(now() - interval '1 day', now() + interval '1 day') WHERE origin_type = 'direct'), 'direct bucket numbers');
SELECT pg_temp.assert_true((SELECT customers = 1 AND deals_created = 0 FROM origin_report(now() - interval '1 day', now() + interval '1 day') WHERE name = 'antiga'), 'old first touch still counts the customer');
SELECT pg_temp.assert_true((SELECT origin_type = 'ad' FROM origin_report(now() - interval '1 day', now() + interval '1 day') LIMIT 1), 'sorted by won value');
-- channel filter: only that channel (direct dropped)
SELECT pg_temp.assert_eq((SELECT count(*) FROM origin_report(now() - interval '1 day', now() + interval '1 day', 'site_bot')), 2, 'channel filter (black-friday and antiga)');
SELECT pg_temp.assert_eq((SELECT count(*) FROM origin_report(now() - interval '1 day', now() + interval '1 day', 'whatsapp')), 0, 'channel filter: tenant B ad invisible to A');
-- pipeline filter (Funil 2 only holds D4)
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(name = 'black-friday' AND deals_created = 1 AND customers = 1)
   FROM origin_report(now() - interval '1 day', now() + interval '1 day', NULL, '10900000-0000-4000-8000-0000000000f2')), 'pipeline filter');
-- Funil 1: ad keeps 3 deals / 2 customers; direct: C4 (D5) with 2 deals; antiga: C5 (has D6 there)
SELECT pg_temp.assert_true((SELECT customers = 2 AND deals_created = 3 FROM origin_report(now() - interval '1 day', now() + interval '1 day', NULL, '10900000-0000-4000-8000-0000000000f1') WHERE origin_type = 'ad'), 'pipeline 1 ad');
SELECT pg_temp.assert_true((SELECT customers = 1 AND deals_created = 2 FROM origin_report(now() - interval '1 day', now() + interval '1 day', NULL, '10900000-0000-4000-8000-0000000000f1') WHERE origin_type = 'direct'), 'pipeline 1 direct');
-- a range with nothing
SELECT pg_temp.assert_eq((SELECT count(*) FROM origin_report(now() - interval '10 days', now() - interval '9 days')), 0, 'empty period');
SELECT pg_temp.assert_fails_with($q$SELECT * FROM origin_report('-infinity', now())$q$, '22023', 'report rejects an infinite start');
SELECT pg_temp.assert_fails_with($q$SELECT * FROM origin_report(now() - interval '1 day', 'infinity')$q$, '22023', 'report rejects an infinite end');
SELECT pg_temp.assert_fails_with($q$SELECT * FROM origin_report(NULL, now())$q$, '22023', 'report rejects a missing bound');
SELECT pg_temp.assert_fails_with($q$SELECT * FROM origin_report(now() - interval '401 days', now())$q$, '22023', 'report rejects a period over 400 days');
SELECT pg_temp.assert_true((SELECT count(*) >= 0 FROM origin_report(now() - interval '400 days', now())), 'report accepts exactly 400 days');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- ---- tenant isolation + anon ----------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10900000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM lead_origins WHERE account_id = (SELECT acc_a FROM ctx)), 0, 'tenant B reads no touch of A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM lead_origins), 1, 'tenant B reads its own touch only');
SELECT pg_temp.assert_true((SELECT bool_and(name = 'Anuncio da B') FROM origin_report(now() - interval '1 day', now() + interval '1 day') WHERE origin_type = 'ad'), 'tenant B report shows only B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM origin_report(now() - interval '1 day', now() + interval '1 day') WHERE name = 'Promoção sofás'), 0, 'tenant B report has no A rows');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SET ROLE anon;
SELECT pg_temp.assert_fails('SELECT count(*) FROM public.lead_origins', 'anon cannot read lead_origins');
SELECT pg_temp.assert_fails($q$SELECT * FROM origin_report(now() - interval '1 day', now())$q$, 'anon cannot run origin_report');
SELECT pg_temp.assert_fails($q$INSERT INTO public.lead_origins(account_id, contact_id, channel, kind) VALUES (gen_random_uuid(), gen_random_uuid(), 'whatsapp', 'ad')$q$, 'anon cannot insert');
RESET ROLE;

-- ---- authenticated: read yes, click_id never, write never -------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10900000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM lead_origins), 4, 'agent of A reads the 4 touches of A');
SELECT pg_temp.assert_true((SELECT headline = 'Promoção sofás' AND click_id_type = 'ctwa_clid' FROM lead_origins WHERE id = '10900000-0000-4000-8000-0000000000a1'), 'agent reads the visible columns');
SELECT pg_temp.assert_fails('SELECT click_id FROM lead_origins', 'click_id is not readable by authenticated');
SELECT pg_temp.assert_fails('SELECT * FROM lead_origins', 'select * hits click_id: refused');
SELECT pg_temp.assert_fails('SELECT count(*) FROM lead_origins WHERE click_id IS NOT NULL', 'click_id cannot be filtered on either');
SELECT pg_temp.assert_fails(format($q$INSERT INTO lead_origins(account_id, contact_id, channel, kind) VALUES (%L, '10900000-0000-4000-8000-0000000000c1', 'whatsapp', 'ad')$q$, (SELECT acc_a FROM ctx)), 'authenticated cannot insert a touch');
SELECT pg_temp.assert_fails($q$UPDATE lead_origins SET headline = 'x'$q$, 'authenticated cannot update a touch');
SELECT pg_temp.assert_fails($q$DELETE FROM lead_origins$q$, 'authenticated cannot delete a touch');
-- origin pointers of a contact are the server's
SELECT pg_temp.assert_fails_with($q$UPDATE contacts SET last_origin_id = '10900000-0000-4000-8000-0000000000a3' WHERE id = '10900000-0000-4000-8000-0000000000c1'$q$, '42501', 'agent cannot move a contact pointer');
SELECT pg_temp.assert_eq(pg_temp.rows($q$UPDATE contacts SET name = 'C1 renomeado' WHERE id = '10900000-0000-4000-8000-0000000000c1'$q$), 1, 'agent still edits the contact itself');
-- a new deal by a user never carries a chosen origin; it gets the computed one
INSERT INTO deals(id, user_id, account_id, pipeline_id, stage_id, contact_id, title, origin_id)
  VALUES ('10900000-0000-4000-8000-000000000d07', '10900000-0000-4000-8000-00000000000c', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000f1', '10900000-0000-4000-8000-0000000000e1',
          '10900000-0000-4000-8000-0000000000c1', 'D7 by agent', '10900000-0000-4000-8000-0000000000a3');
SELECT pg_temp.assert_true((SELECT origin_id = '10900000-0000-4000-8000-0000000000a1' AND origin_set_by IS NULL FROM deals WHERE id = '10900000-0000-4000-8000-000000000d07'), 'user insert: origin is the contact last touch, not the one sent');
-- manual override: the agent cannot, nor forge the stamp
SELECT pg_temp.assert_fails_with($q$UPDATE deals SET origin_id = '10900000-0000-4000-8000-0000000000a3' WHERE id = '10900000-0000-4000-8000-000000000d01'$q$, '42501', 'agent cannot change a deal origin');
UPDATE deals SET origin_set_by = '10900000-0000-4000-8000-00000000000a', origin_set_at = now() WHERE id = '10900000-0000-4000-8000-000000000d01';
SELECT pg_temp.assert_true((SELECT origin_set_by IS NULL AND origin_set_at IS NULL FROM deals WHERE id = '10900000-0000-4000-8000-000000000d01'), 'agent cannot forge the stamp');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- admin: may change, and the stamp is theirs (also to NULL = "unknown")
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10900000-0000-4000-8000-00000000000e', true);
UPDATE deals SET origin_id = '10900000-0000-4000-8000-0000000000a3' WHERE id = '10900000-0000-4000-8000-000000000d01';
SELECT pg_temp.assert_true((SELECT origin_id = '10900000-0000-4000-8000-0000000000a3' AND origin_set_by = '10900000-0000-4000-8000-00000000000e' AND origin_set_at IS NOT NULL
   FROM deals WHERE id = '10900000-0000-4000-8000-000000000d01'), 'admin changes the origin and is stamped');
SELECT pg_temp.assert_fails_with($q$UPDATE deals SET origin_id = '10900000-0000-4000-8000-0000000000ab' WHERE id = '10900000-0000-4000-8000-000000000d01'$q$, '23503', 'admin cannot pick a touch of another account');
UPDATE deals SET origin_id = NULL WHERE id = '10900000-0000-4000-8000-000000000d01';
SELECT pg_temp.assert_true((SELECT origin_id IS NULL AND origin_set_by IS NOT NULL FROM deals WHERE id = '10900000-0000-4000-8000-000000000d01'), 'admin can clear the origin');
UPDATE deals SET origin_id = '10900000-0000-4000-8000-0000000000a1' WHERE id = '10900000-0000-4000-8000-000000000d01';
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- tenant B cannot touch A's deal at all
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10900000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq(pg_temp.rows($q$UPDATE deals SET origin_id = NULL WHERE id = '10900000-0000-4000-8000-000000000d01'$q$), 0, 'tenant B cannot change a deal of A');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- ---- guards and CHECKs (as the server) ---------------------------------------------
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO lead_origins(account_id, contact_id, channel, kind) VALUES (%L, '10900000-0000-4000-8000-0000000000cb', 'whatsapp', 'ad')$q$, (SELECT acc_a FROM ctx)),
  '23503', 'contact of another account');
SELECT pg_temp.assert_fails_with(format($q$INSERT INTO lead_origins(account_id, contact_id, conversation_id, channel, kind) VALUES (%L, '10900000-0000-4000-8000-0000000000c2', '10900000-0000-4000-8000-0000000000d1', 'whatsapp', 'ad')$q$, (SELECT acc_a FROM ctx)),
  '23503', 'conversation of another contact');
SELECT pg_temp.assert_fails_with($q$UPDATE lead_origins SET contact_id = '10900000-0000-4000-8000-0000000000c2' WHERE id = '10900000-0000-4000-8000-0000000000a1'$q$, '23514', 'a touch never moves to another contact');
SELECT pg_temp.assert_fails_with($q$UPDATE contacts SET last_origin_id = '10900000-0000-4000-8000-0000000000a3' WHERE id = '10900000-0000-4000-8000-0000000000c1'$q$, '23503', 'pointer must name a touch of the same contact');
SELECT pg_temp.assert_fails(format($q$INSERT INTO lead_origins(account_id, contact_id, channel, kind) VALUES (%L, '10900000-0000-4000-8000-0000000000c1', 'telegram', 'ad')$q$, (SELECT acc_a FROM ctx)), 'unknown channel');
SELECT pg_temp.assert_fails(format($q$INSERT INTO lead_origins(account_id, contact_id, channel, kind) VALUES (%L, '10900000-0000-4000-8000-0000000000c1', 'whatsapp', 'banner')$q$, (SELECT acc_a FROM ctx)), 'unknown kind');
SELECT pg_temp.assert_fails(format($q$INSERT INTO lead_origins(account_id, contact_id, channel, kind, headline) VALUES (%L, '10900000-0000-4000-8000-0000000000c1', 'whatsapp', 'ad', repeat('x', 301))$q$, (SELECT acc_a FROM ctx)), 'headline over 300');
SELECT pg_temp.assert_fails(format($q$INSERT INTO lead_origins(account_id, contact_id, channel, kind, source_url) VALUES (%L, '10900000-0000-4000-8000-0000000000c1', 'whatsapp', 'ad', repeat('x', 1001))$q$, (SELECT acc_a FROM ctx)), 'source_url over 1000');
SELECT pg_temp.assert_fails(format($q$INSERT INTO lead_origins(account_id, contact_id, channel, kind, click_id) VALUES (%L, '10900000-0000-4000-8000-0000000000c1', 'whatsapp', 'ad', 'abc')$q$, (SELECT acc_a FROM ctx)), 'click_id without type');
SELECT pg_temp.assert_fails(format($q$INSERT INTO lead_origins(account_id, contact_id, channel, kind, click_id_type, click_id) VALUES (%L, '10900000-0000-4000-8000-0000000000c1', 'whatsapp', 'ad', 'other', 'abc')$q$, (SELECT acc_a FROM ctx)), 'unknown click id type');
SELECT pg_temp.assert_fails(format($q$INSERT INTO lead_origins(account_id, contact_id, channel, kind, utm_campaign) VALUES (%L, '10900000-0000-4000-8000-0000000000c1', 'site_bot', 'campaign', '   ')$q$, (SELECT acc_a FROM ctx)), 'blank text');

-- ---- billing block (094): a read-only account cannot change an origin ---------------
UPDATE accounts SET plan_status = 'canceled' WHERE id = (SELECT acc_a FROM ctx);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10900000-0000-4000-8000-00000000000e', true);
SELECT pg_temp.assert_eq(pg_temp.rows($q$UPDATE deals SET origin_id = '10900000-0000-4000-8000-0000000000a3' WHERE id = '10900000-0000-4000-8000-000000000d01'$q$), 0, 'read-only account: origin change refused');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT origin_id = '10900000-0000-4000-8000-0000000000a1' FROM deals WHERE id = '10900000-0000-4000-8000-000000000d01'), 'origin unchanged on the read-only account');
UPDATE accounts SET plan_status = 'active' WHERE id = (SELECT acc_a FROM ctx);

-- ---- record_lead_origin: the single write path (run as the superuser = service_role's rights) --------
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
  ('10900000-0000-4000-8000-0000000000c6', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900010006', 'C6'),
  ('10900000-0000-4000-8000-0000000000c7', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900010007', 'C7');
CREATE FUNCTION pg_temp.rec(p_contact uuid, p_ad text, p_url text, p_at timestamptz, p_first boolean, p_conv uuid DEFAULT NULL, p_account uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS $$
  SELECT public.record_lead_origin(coalesce(p_account, (SELECT acc_a FROM ctx)), p_contact, p_conv, 'instagram', 'ad', p_ad, NULL, p_url, 'Anuncio',
                                   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, p_at, p_first)
$$;
CREATE TEMP TABLE rec_ids(label text PRIMARY KEY, id uuid);
INSERT INTO rec_ids VALUES
  ('a', pg_temp.rec('10900000-0000-4000-8000-0000000000c6', 'AD-A', 'https://fb.me/a', now() - interval '1 hour', false));
SELECT pg_temp.assert_true((SELECT id IS NOT NULL FROM rec_ids WHERE label = 'a'), 'first touch is recorded');
SELECT pg_temp.assert_true((SELECT last_origin_id = (SELECT id FROM rec_ids WHERE label = 'a') AND first_origin_id = (SELECT id FROM rec_ids WHERE label = 'a')
   FROM contacts WHERE id = '10900000-0000-4000-8000-0000000000c6'),
  'an untrusted touch still fills EMPTY pointers');
-- the same touch inside 24h is nothing new
SELECT pg_temp.assert_true(pg_temp.rec('10900000-0000-4000-8000-0000000000c6', 'AD-A', 'https://fb.me/a', now(), false) IS NULL, 'same touch inside 24h: dedup');
SELECT pg_temp.assert_eq((SELECT count(*) FROM lead_origins WHERE contact_id = '10900000-0000-4000-8000-0000000000c6'), 1, 'dedup wrote no row');
-- an UNTRUSTED newer touch on a contact that already has a last touch: stored as history, pointers stay
INSERT INTO rec_ids VALUES ('u', pg_temp.rec('10900000-0000-4000-8000-0000000000c6', 'AD-U', NULL, now(), false));
SELECT pg_temp.assert_true((SELECT id IS NOT NULL FROM rec_ids WHERE label = 'u'), 'an untrusted touch is still stored');
SELECT pg_temp.assert_true((SELECT last_origin_id = (SELECT id FROM rec_ids WHERE label = 'a') AND first_origin_id = (SELECT id FROM rec_ids WHERE label = 'a')
   FROM contacts WHERE id = '10900000-0000-4000-8000-0000000000c6'), 'an untrusted touch moves neither pointer');
SELECT pg_temp.assert_eq((SELECT count(*) FROM lead_origins WHERE contact_id = '10900000-0000-4000-8000-0000000000c6'), 2, 'both rows exist');
-- a new deal still inherits the TRUSTED last touch, not the untrusted one
INSERT INTO deals(id, user_id, account_id, pipeline_id, stage_id, contact_id, title) VALUES
  ('10900000-0000-4000-8000-000000000d08', '10900000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '10900000-0000-4000-8000-0000000000f1', '10900000-0000-4000-8000-0000000000e1',
   '10900000-0000-4000-8000-0000000000c6', 'D8');
SELECT pg_temp.assert_true((SELECT origin_id = (SELECT id FROM rec_ids WHERE label = 'a') FROM deals WHERE id = '10900000-0000-4000-8000-000000000d08'), 'the new deal inherits the trusted last touch');
-- source_url is part of the identity (trusted from here on)
INSERT INTO rec_ids VALUES ('b', pg_temp.rec('10900000-0000-4000-8000-0000000000c6', 'AD-A', 'https://fb.me/other', now(), true));
SELECT pg_temp.assert_true((SELECT id IS NOT NULL FROM rec_ids WHERE label = 'b'), 'another source_url is another touch');
SELECT pg_temp.assert_true((SELECT last_origin_id = (SELECT id FROM rec_ids WHERE label = 'b') FROM contacts WHERE id = '10900000-0000-4000-8000-0000000000c6'), 'a trusted newer touch moves last');
SELECT pg_temp.assert_true(pg_temp.rec('10900000-0000-4000-8000-0000000000c6', 'AD-A', 'https://fb.me/other', now(), true) IS NULL, 'the repeat of that one is dedup again');
-- an older trusted touch is stored but does not move last
INSERT INTO rec_ids VALUES ('old', pg_temp.rec('10900000-0000-4000-8000-0000000000c6', 'AD-OLD', NULL, now() - interval '5 hours', true));
SELECT pg_temp.assert_true((SELECT id IS NOT NULL FROM rec_ids WHERE label = 'old'), 'an older touch is still stored');
SELECT pg_temp.assert_true((SELECT last_origin_id = (SELECT id FROM rec_ids WHERE label = 'b') FROM contacts WHERE id = '10900000-0000-4000-8000-0000000000c6'), 'an older touch does not move last');
-- first is never replaced, trusted or not
INSERT INTO rec_ids VALUES ('d', pg_temp.rec('10900000-0000-4000-8000-0000000000c6', 'AD-D', NULL, now(), true));
SELECT pg_temp.assert_true((SELECT first_origin_id = (SELECT id FROM rec_ids WHERE label = 'a') AND last_origin_id = (SELECT id FROM rec_ids WHERE label = 'd')
   FROM contacts WHERE id = '10900000-0000-4000-8000-0000000000c6'), 'first is never replaced; last follows a trusted touch');
-- at most 50 touches per contact per 24h
DO $$
DECLARE i int;
BEGIN
  FOR i IN 1..50 LOOP
    PERFORM pg_temp.rec('10900000-0000-4000-8000-0000000000c7', 'AD-' || i, NULL, now(), false);
  END LOOP;
END $$;
SELECT pg_temp.assert_eq((SELECT count(*) FROM lead_origins WHERE contact_id = '10900000-0000-4000-8000-0000000000c7'), 50, '50 distinct touches are stored');
SELECT pg_temp.assert_true(pg_temp.rec('10900000-0000-4000-8000-0000000000c7', 'AD-51', NULL, now(), false) IS NULL, 'the 51st touch in 24h is refused');
SELECT pg_temp.assert_eq((SELECT count(*) FROM lead_origins WHERE contact_id = '10900000-0000-4000-8000-0000000000c7'), 50, 'cap wrote no row');
-- a contact of another account is refused by the guard
SELECT pg_temp.assert_fails_with($q$SELECT pg_temp.rec('10900000-0000-4000-8000-0000000000cb', 'AD-X', NULL, now(), true)$q$, '23503', 'record_lead_origin: contact of another account');
-- who can run it
SELECT pg_temp.assert_true(has_function_privilege('service_role', 'public.record_lead_origin(uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.record_lead_origin(uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.record_lead_origin(uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz,boolean)', 'EXECUTE'),
  'only service_role executes record_lead_origin');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10900000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_fails_with(format($q$SELECT public.record_lead_origin(%L, '10900000-0000-4000-8000-0000000000c6', NULL, 'instagram', 'ad', 'AD-Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), true)$q$, (SELECT acc_a FROM ctx)),
  '42501', 'authenticated cannot call record_lead_origin');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SET ROLE anon;
SELECT pg_temp.assert_fails_with(format($q$SELECT public.record_lead_origin(%L, '10900000-0000-4000-8000-0000000000c6', NULL, 'instagram', 'ad', 'AD-Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), true)$q$, (SELECT acc_a FROM ctx)),
  '42501', 'anon cannot call record_lead_origin');
RESET ROLE;

-- the click id of a Google / Facebook visit with nothing else is named after the network
SELECT pg_temp.assert_true((SELECT nm = 'Google Ads' AND t = 'paid' FROM private.origin_bucket('campaign', 'site_bot', NULL, NULL, NULL, NULL, NULL, NULL, 'gclid')), 'gclid only: Google Ads');
SELECT pg_temp.assert_true((SELECT nm = 'Facebook/Instagram Ads' AND t = 'paid' FROM private.origin_bucket('campaign', 'site_bot', NULL, NULL, NULL, NULL, NULL, NULL, 'fbclid')), 'fbclid only: Facebook/Instagram Ads');
SELECT pg_temp.assert_true((SELECT t = 'referrer' FROM private.origin_bucket('campaign', 'site_bot', NULL, NULL, NULL, NULL, NULL, 'google.com', 'gclid')), 'a referrer beats the click id');
SELECT pg_temp.assert_true((SELECT t = 'direct' AND ch = '' FROM private.origin_bucket(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)), 'no touch is direct');

-- ---- LGPD: deleting a contact's touches nulls every pointer; a hard delete cascades --------
DELETE FROM lead_origins WHERE contact_id = '10900000-0000-4000-8000-0000000000c1';
SELECT pg_temp.assert_true((SELECT first_origin_id IS NULL AND last_origin_id IS NULL FROM contacts WHERE id = '10900000-0000-4000-8000-0000000000c1'), 'contact pointers nulled');
SELECT pg_temp.assert_true((SELECT bool_and(origin_id IS NULL) FROM deals WHERE contact_id = '10900000-0000-4000-8000-0000000000c1'), 'deal pointers nulled');
SELECT pg_temp.assert_eq((SELECT count(*) FROM deals WHERE contact_id = '10900000-0000-4000-8000-0000000000c1'), 2, 'the deals stay');
DELETE FROM contacts WHERE id = '10900000-0000-4000-8000-0000000000c2';
SELECT pg_temp.assert_eq((SELECT count(*) FROM lead_origins WHERE contact_id = '10900000-0000-4000-8000-0000000000c2'), 0, 'hard delete of a contact removes its touches');

ROLLBACK;
SELECT 'lead_origins.sql: all assertions passed' AS result;
