-- ============================================================
-- Migration 110 (meta_capi_settings / meta_capi_events / enqueue trigger / claim / purge): triggers write only
-- when they should, unique (deal, kind), disabled = no-op, tenant isolation, anon / agent denied, token_enc
-- hidden, billing block (094) in the claim, lease, pause, purge.
--
-- Nothing is committed (ends in ROLLBACK). Needs the local DB migrated through 109:
--   (cat supabase/migrations/110_meta_capi.sql supabase/tests/meta_capi.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- Never run `supabase db reset`. LGPD cancel is app code (anonymize.ts, Vitest).
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
CREATE FUNCTION pg_temp.n_events(where_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN EXECUTE 'SELECT count(*) FROM public.meta_capi_events WHERE ' || where_sql INTO n; RETURN n; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- tenants ---------------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('11000000-0000-4000-8000-00000000000a', 'owner-a@capi.test', '{"full_name":"Owner A"}'),
 ('11000000-0000-4000-8000-00000000000b', 'owner-b@capi.test', '{"full_name":"Owner B"}'),
 ('11000000-0000-4000-8000-00000000000c', 'agent@capi.test', '{"full_name":"Agent"}');
CREATE TEMP TABLE ctx AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '11000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '11000000-0000-4000-8000-00000000000b') AS acc_b;
GRANT SELECT ON ctx TO anon, authenticated, service_role;
UPDATE profiles SET account_id = (SELECT acc_a FROM ctx), account_role = 'agent' WHERE user_id = '11000000-0000-4000-8000-00000000000c';
UPDATE accounts SET plan_status = 'active', plan_expires_at = NULL WHERE id IN ((SELECT acc_a FROM ctx), (SELECT acc_b FROM ctx));

INSERT INTO pipelines(id, user_id, account_id, name) VALUES
  ('11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), 'Funil A'),
  ('11000000-0000-4000-8000-0000000000f3', '11000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ctx), 'Funil B');
INSERT INTO pipeline_stages(id, pipeline_id, name) VALUES
  ('11000000-0000-4000-8000-0000000000e1', '11000000-0000-4000-8000-0000000000f1', 'Novo'),
  ('11000000-0000-4000-8000-0000000000e3', '11000000-0000-4000-8000-0000000000f3', 'Novo');
-- c1 whatsapp ctwa | c2 instagram ad | c3 instagram post (not ad) | c4 site fbclid | c5 site gclid | c6 whatsapp without click id | c7 none | cb tenant B
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
  ('11000000-0000-4000-8000-0000000000c1', '11000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900020001', 'C1'),
  ('11000000-0000-4000-8000-0000000000c2', '11000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900020002', 'C2'),
  ('11000000-0000-4000-8000-0000000000c3', '11000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900020003', 'C3'),
  ('11000000-0000-4000-8000-0000000000c4', '11000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900020004', 'C4'),
  ('11000000-0000-4000-8000-0000000000c5', '11000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900020005', 'C5'),
  ('11000000-0000-4000-8000-0000000000c6', '11000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900020006', 'C6'),
  ('11000000-0000-4000-8000-0000000000c7', '11000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ctx), '+5511900020007', 'C7'),
  ('11000000-0000-4000-8000-0000000000cb', '11000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ctx), '+5511900020099', 'CB');
INSERT INTO lead_origins(account_id, contact_id, channel, kind, click_id_type, click_id, occurred_at) VALUES
  ((SELECT acc_a FROM ctx), '11000000-0000-4000-8000-0000000000c1', 'whatsapp', 'ad', 'ctwa_clid', 'CTWA1', now()),
  ((SELECT acc_a FROM ctx), '11000000-0000-4000-8000-0000000000c2', 'instagram', 'ad', NULL, NULL, now()),
  ((SELECT acc_a FROM ctx), '11000000-0000-4000-8000-0000000000c3', 'instagram', 'post', NULL, NULL, now()),
  ((SELECT acc_a FROM ctx), '11000000-0000-4000-8000-0000000000c4', 'site_bot', 'link', 'fbclid', 'FB1', now()),
  ((SELECT acc_a FROM ctx), '11000000-0000-4000-8000-0000000000c5', 'site_bot', 'link', 'gclid', 'G1', now()),
  ((SELECT acc_a FROM ctx), '11000000-0000-4000-8000-0000000000c6', 'whatsapp_qr', 'ad', NULL, NULL, now()),
  ((SELECT acc_b FROM ctx), '11000000-0000-4000-8000-0000000000cb', 'whatsapp', 'ad', 'ctwa_clid', 'CTWAB', now());
UPDATE contacts c SET last_origin_id = o.id, first_origin_id = o.id FROM lead_origins o WHERE o.contact_id = c.id AND c.id::text LIKE '11000000-%';

-- A deal: origin is copied from the contact's last touch by deals_origin_guard (BEFORE), the AFTER trigger enqueues.
CREATE FUNCTION pg_temp.mkdeal(n int, contact text, acc uuid, owner text, pipe text, stage text, st text DEFAULT 'open') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO deals(id, user_id, account_id, pipeline_id, stage_id, contact_id, title, value, status)
  VALUES (('11000000-0000-4000-8000-000000000d' || lpad(n::text, 2, '0'))::uuid, owner::uuid, acc, pipe::uuid, stage::uuid,
          ('11000000-0000-4000-8000-0000000000' || contact)::uuid, 'D' || n, 1234.50, st);
END $$;

-- ---- disabled / no settings: nothing is written, the deal write succeeds ----------------------
SELECT pg_temp.mkdeal(1, 'c1', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.assert_eq(pg_temp.n_events('true'), 0, 'no settings row: no event');
INSERT INTO meta_capi_settings(account_id, dataset_id, token_enc, token_last4, enabled)
  VALUES ((SELECT acc_a FROM ctx), '123456789012345', 'ENC', 'abcd', false);
SELECT pg_temp.mkdeal(2, 'c1', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.assert_eq(pg_temp.n_events('true'), 0, 'disabled integration: no event');
-- enabled requires dataset + token
SELECT pg_temp.assert_fails($q$INSERT INTO meta_capi_settings(account_id, enabled) VALUES ((SELECT acc_b FROM ctx), true)$q$, 'enabled without dataset/token refused');
SELECT pg_temp.assert_fails($q$INSERT INTO meta_capi_settings(account_id, dataset_id) VALUES ((SELECT acc_b FROM ctx), 'abc')$q$, 'dataset id must be digits');

-- ---- enabled: lead on insert, only for Meta-identifiable origins ------------------------------
UPDATE meta_capi_settings SET enabled = true WHERE account_id = (SELECT acc_a FROM ctx);
SELECT pg_temp.mkdeal(3, 'c1', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.mkdeal(4, 'c2', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.mkdeal(5, 'c3', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.mkdeal(6, 'c4', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.mkdeal(7, 'c5', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.mkdeal(8, 'c6', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.mkdeal(9, 'c7', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.assert_eq(pg_temp.n_events($$event_name = 'lead'$$), 3, 'leads: whatsapp ctwa, instagram ad, site fbclid only');
SELECT pg_temp.assert_true((SELECT event_id = 'sempre-11000000-0000-4000-8000-000000000d03-lead' AND status = 'pending' AND value IS NULL
   FROM meta_capi_events WHERE deal_id = '11000000-0000-4000-8000-000000000d03'), 'stable event_id, pending, lead has no value');
SELECT pg_temp.assert_eq(pg_temp.n_events($$deal_id IN ('11000000-0000-4000-8000-000000000d05','11000000-0000-4000-8000-000000000d07','11000000-0000-4000-8000-000000000d08','11000000-0000-4000-8000-000000000d09')$$), 0,
  'instagram post, gclid, QR and no origin never enqueue');

-- ---- purchase on status -> won, once ----------------------------------------------------------
UPDATE deals SET status = 'won' WHERE id = '11000000-0000-4000-8000-000000000d03';
SELECT pg_temp.assert_true((SELECT value = 1234.50 AND currency = 'BRL' AND event_id = 'sempre-11000000-0000-4000-8000-000000000d03-purchase'
   FROM meta_capi_events WHERE deal_id = '11000000-0000-4000-8000-000000000d03' AND event_name = 'purchase'), 'purchase with value and currency');
UPDATE deals SET status = 'open' WHERE id = '11000000-0000-4000-8000-000000000d03';
UPDATE deals SET status = 'won' WHERE id = '11000000-0000-4000-8000-000000000d03';
SELECT pg_temp.assert_eq(pg_temp.n_events($$deal_id = '11000000-0000-4000-8000-000000000d03' AND event_name = 'purchase'$$), 1, 'won again: still one purchase');
UPDATE deals SET status = 'won' WHERE id = '11000000-0000-4000-8000-000000000d08';  -- QR origin
SELECT pg_temp.assert_eq(pg_temp.n_events($$deal_id = '11000000-0000-4000-8000-000000000d08'$$), 0, 'won deal with QR origin: nothing');
-- a deal inserted already won: lead + purchase
SELECT pg_temp.mkdeal(10, 'c4', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1', 'won');
SELECT pg_temp.assert_eq(pg_temp.n_events($$deal_id = '11000000-0000-4000-8000-000000000d10'$$), 2, 'insert as won: lead + purchase');
-- the unique key itself
SELECT pg_temp.assert_fails($q$INSERT INTO meta_capi_events(account_id, deal_id, event_name, event_id) VALUES ((SELECT acc_a FROM ctx), '11000000-0000-4000-8000-000000000d03', 'lead', 'x')$q$, 'unique (deal, kind)');

-- ---- toggles ----------------------------------------------------------------------------------
UPDATE meta_capi_settings SET send_lead = false WHERE account_id = (SELECT acc_a FROM ctx);
SELECT pg_temp.mkdeal(11, 'c1', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.assert_eq(pg_temp.n_events($$deal_id = '11000000-0000-4000-8000-000000000d11'$$), 0, 'lead toggle off: nothing');
UPDATE meta_capi_settings SET send_lead = true, paused_reason = 'invalid_token' WHERE account_id = (SELECT acc_a FROM ctx);
SELECT pg_temp.mkdeal(12, 'c1', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.assert_eq(pg_temp.n_events($$deal_id = '11000000-0000-4000-8000-000000000d12'$$), 0, 'paused account: nothing');
UPDATE meta_capi_settings SET paused_reason = NULL WHERE account_id = (SELECT acc_a FROM ctx);

-- ---- the enqueue never blocks the deal write --------------------------------------------------
ALTER TABLE meta_capi_events ADD CONSTRAINT tmp_break CHECK (false) NOT VALID;
SELECT pg_temp.mkdeal(13, 'c1', (SELECT acc_a FROM ctx), '11000000-0000-4000-8000-00000000000a', '11000000-0000-4000-8000-0000000000f1', '11000000-0000-4000-8000-0000000000e1');
SELECT pg_temp.assert_true(EXISTS (SELECT 1 FROM deals WHERE id = '11000000-0000-4000-8000-000000000d13'), 'a failing enqueue still lets the deal be written');
ALTER TABLE meta_capi_events DROP CONSTRAINT tmp_break;
SELECT pg_temp.assert_eq(pg_temp.n_events($$deal_id = '11000000-0000-4000-8000-000000000d13'$$), 0, 'and wrote no event');

-- ---- tenant B (own settings, own events) ---------------------------------------------------------
INSERT INTO meta_capi_settings(account_id, dataset_id, token_enc, token_last4, enabled)
  VALUES ((SELECT acc_b FROM ctx), '999999999999', 'ENCB', 'wxyz', true);
SELECT pg_temp.mkdeal(20, 'cb', (SELECT acc_b FROM ctx), '11000000-0000-4000-8000-00000000000b', '11000000-0000-4000-8000-0000000000f3', '11000000-0000-4000-8000-0000000000e3');
SELECT pg_temp.assert_eq(pg_temp.n_events($$deal_id = '11000000-0000-4000-8000-000000000d20' AND account_id = (SELECT acc_b FROM ctx)$$), 1, 'tenant B lead');

-- ---- access control ----------------------------------------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM meta_capi_settings), 1, 'admin A reads only its settings row');
SELECT pg_temp.assert_true((SELECT token_last4 = 'abcd' FROM meta_capi_settings), 'last4 readable');
SELECT pg_temp.assert_fails('SELECT token_enc FROM meta_capi_settings', 'token_enc hidden from authenticated');
SELECT pg_temp.assert_fails('SELECT * FROM meta_capi_settings', 'select * refused (token_enc not granted)');
SELECT pg_temp.assert_true((SELECT count(*) > 0 AND bool_and(account_id = (SELECT acc_a FROM ctx)) FROM meta_capi_events), 'admin A reads only its events');
SELECT pg_temp.assert_fails($q$UPDATE meta_capi_settings SET enabled = false$q$, 'no write grant on settings');
SELECT pg_temp.assert_fails($q$UPDATE meta_capi_events SET status = 'sent'$q$, 'no write grant on events');
SELECT pg_temp.assert_fails($q$DELETE FROM meta_capi_events$q$, 'no delete grant on events');
SELECT pg_temp.assert_fails($q$INSERT INTO meta_capi_events(account_id, deal_id, event_name, event_id) VALUES ((SELECT acc_a FROM ctx), '11000000-0000-4000-8000-000000000d09', 'lead', 'x')$q$, 'no insert grant on events');
SELECT pg_temp.assert_fails($q$SELECT * FROM public.meta_capi_claim(10, 60)$q$, 'claim is service-role only');
SELECT pg_temp.assert_fails($q$SELECT public.meta_capi_purge(90, 10)$q$, 'purge is service-role only');
SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM meta_capi_settings), 0, 'agent reads no settings');
SELECT pg_temp.assert_eq((SELECT count(*) FROM meta_capi_events), 0, 'agent reads no events');
SELECT set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_true((SELECT bool_and(account_id = (SELECT acc_b FROM ctx)) FROM meta_capi_events), 'admin B reads only its events');
SELECT set_config('request.jwt.claim.sub', '', true);
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.assert_fails('SELECT count(*) FROM meta_capi_settings', 'anon: settings denied');
SELECT pg_temp.assert_fails('SELECT count(*) FROM meta_capi_events', 'anon: events denied');
SELECT pg_temp.assert_fails($q$SELECT * FROM public.meta_capi_claim(10, 60)$q$, 'anon: claim denied');
RESET ROLE;

-- ---- claim: lease, billing block (094), pause, toggles ------------------------------------------------
SET ROLE service_role;
SELECT pg_temp.assert_true((SELECT count(*) = 7 FROM public.meta_capi_claim(100, 60)), 'claims the 6 events of A and the 1 of B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.meta_capi_claim(100, 60)), 0, 'leased rows are not claimed twice');
RESET ROLE;
UPDATE meta_capi_events SET claimed_until = NULL;

-- the claim returns the context the sender needs
SET ROLE service_role;
SELECT pg_temp.assert_true((SELECT origin_channel = 'whatsapp' AND origin_click_id = 'CTWA1' AND contact_phone = '+5511900020001'
   AND dataset_id = '123456789012345' AND token_enc = 'ENC' AND NOT contact_anonymized
   FROM public.meta_capi_claim(100, 60) WHERE deal_id = '11000000-0000-4000-8000-000000000d03' AND event_name = 'lead'), 'claim context');
RESET ROLE;
UPDATE meta_capi_events SET claimed_until = NULL;

-- a read-only account (canceled) is not claimed; the other tenant still is
UPDATE accounts SET plan_status = 'canceled' WHERE id = (SELECT acc_a FROM ctx);
SET ROLE service_role;
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(account_id = (SELECT acc_b FROM ctx)) FROM public.meta_capi_claim(100, 60)), '094: read-only account sends nothing');
RESET ROLE;
UPDATE accounts SET plan_status = 'active' WHERE id = (SELECT acc_a FROM ctx);
UPDATE meta_capi_events SET claimed_until = NULL;

-- paused and switched-off kinds are not claimed
UPDATE meta_capi_settings SET paused_reason = 'invalid_token' WHERE account_id = (SELECT acc_a FROM ctx);
SET ROLE service_role;
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM public.meta_capi_claim(100, 60)), 'paused account is not claimed');
RESET ROLE;
UPDATE meta_capi_settings SET paused_reason = NULL, send_purchase = false WHERE account_id = (SELECT acc_a FROM ctx);
UPDATE meta_capi_events SET claimed_until = NULL;
SET ROLE service_role;
SELECT pg_temp.assert_true((SELECT count(*) = 5 FROM public.meta_capi_claim(100, 60)), 'purchase toggle off: A purchases not claimed (3 leads + d10 lead... + B)');
RESET ROLE;
UPDATE meta_capi_settings SET send_purchase = true WHERE account_id = (SELECT acc_a FROM ctx);
UPDATE meta_capi_events SET claimed_until = NULL;

-- expiry: pending past expires_at becomes failed on the next claim
UPDATE meta_capi_events SET expires_at = now() - interval '1 minute' WHERE deal_id = '11000000-0000-4000-8000-000000000d04';
SET ROLE service_role;
SELECT count(*) FROM public.meta_capi_claim(100, 60);
RESET ROLE;
SELECT pg_temp.assert_true((SELECT status = 'failed' AND last_error LIKE 'Expirou%' FROM meta_capi_events WHERE deal_id = '11000000-0000-4000-8000-000000000d04'), 'expired pending -> failed');

-- ---- purge: terminal rows older than 90 days, pending kept -----------------------------------------------
UPDATE meta_capi_events SET status = 'sent', sent_at = now(), created_at = now() - interval '91 days' WHERE deal_id = '11000000-0000-4000-8000-000000000d06';
UPDATE meta_capi_events SET created_at = now() - interval '91 days' WHERE deal_id = '11000000-0000-4000-8000-000000000d10' AND event_name = 'lead';  -- still pending
SET ROLE service_role;
SELECT pg_temp.assert_eq(public.meta_capi_purge(90, 100), 1, 'purge removes the old sent row only');
RESET ROLE;
SELECT pg_temp.assert_eq(pg_temp.n_events($$deal_id = '11000000-0000-4000-8000-000000000d10' AND event_name = 'lead'$$), 1, 'old pending row kept');

-- ---- cascade: deleting a deal removes its events -------------------------------------------------------------
DELETE FROM deals WHERE id = '11000000-0000-4000-8000-000000000d20';
SELECT pg_temp.assert_eq(pg_temp.n_events($$deal_id = '11000000-0000-4000-8000-000000000d20'$$), 0, 'deal delete cascades');

SELECT 'meta_capi.sql: all assertions passed' AS result;
ROLLBACK;
