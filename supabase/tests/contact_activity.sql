-- ============================================================
-- Migration 070 (contact_activity + account_tag_usage) — parity and
-- tenant-isolation smoke test. Nothing is committed (ends in ROLLBACK).
-- Apply 068-070 in the same transaction (067 must already be applied):
--   (echo "BEGIN;"; cat supabase/migrations/068_inbox_filters.sql supabase/migrations/069_transfer_reason_limit.sql supabase/migrations/070_contact_activity.sql supabase/tests/contact_activity.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_eq(actual bigint, expected bigint, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;

INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('70000000-0000-4000-8000-00000000000a', 'owner-a@activity.test', '{"full_name":"Owner A"}'),
 ('70000000-0000-4000-8000-00000000000b', 'owner-b@activity.test', '{"full_name":"Owner B"}');

CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '70000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '70000000-0000-4000-8000-00000000000b') AS acc_b,
       '70000000-0000-4000-8000-0000000000c1'::uuid AS c1,
       '70000000-0000-4000-8000-0000000000c2'::uuid AS c2,
       '70000000-0000-4000-8000-0000000000c3'::uuid AS c3,
       '70000000-0000-4000-8000-0000000000e1'::uuid AS conv1;
GRANT SELECT ON ids TO authenticated;

INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
 ('70000000-0000-4000-8000-0000000000c1', '70000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511900070001', 'Ana'),
 ('70000000-0000-4000-8000-0000000000c2', '70000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '5511900070002', 'Outro');
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
 ('70000000-0000-4000-8000-0000000000c3', '70000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511900070003', 'Empate');
INSERT INTO conversations(id, user_id, account_id, contact_id, status) VALUES
 ('70000000-0000-4000-8000-0000000000e1', '70000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), (SELECT c1 FROM ids), 'open');

-- One row per source for contact c1 (plus foreign rows on c2 / account B).
INSERT INTO conversation_events(account_id, conversation_id, actor_user_id, event_type, payload, created_at) VALUES
 ((SELECT acc_a FROM ids), (SELECT conv1 FROM ids), '70000000-0000-4000-8000-00000000000a', 'assigned', '{"assignee_name":"Owner A"}', now() - interval '10 min'),
 ((SELECT acc_a FROM ids), (SELECT conv1 FROM ids), NULL, 'deal_stage_changed', '{"deal_title":"Deal X","from_stage_name":"Novo","to_stage_name":"Proposta"}', now() - interval '9 min'),
 ((SELECT acc_a FROM ids), (SELECT conv1 FROM ids), NULL, 'note_added', '{}', now() - interval '8 min');  -- excluded (notes come from contact_notes)

INSERT INTO pipelines(id, user_id, account_id, name) VALUES
 ('70000000-0000-4000-8000-0000000000f1', '70000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'P');
INSERT INTO pipeline_stages(id, pipeline_id, name, position, color) VALUES
 ('70000000-0000-4000-8000-0000000000f2', '70000000-0000-4000-8000-0000000000f1', 'Novo', 0, '#111111');
-- created + won = 2 rows
INSERT INTO deals(user_id, account_id, pipeline_id, stage_id, contact_id, title, value, status, created_at, updated_at) VALUES
 ('70000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '70000000-0000-4000-8000-0000000000f1', '70000000-0000-4000-8000-0000000000f2', (SELECT c1 FROM ids), 'Deal X', 100, 'won', now() - interval '7 min', now() - interval '6 min');

INSERT INTO task_statuses(id, account_id, name, position, kind)
  VALUES ('70000000-0000-4000-8000-0000000000f3', (SELECT acc_a FROM ids), 'Feito', 99, 'done');
-- created + done = 2 rows
INSERT INTO tasks(account_id, status_id, title, contact_id, created_by, completed_at, created_at) VALUES
 ((SELECT acc_a FROM ids), '70000000-0000-4000-8000-0000000000f3', 'Ligar', (SELECT c1 FROM ids), '70000000-0000-4000-8000-00000000000a', now() - interval '4 min', now() - interval '5 min');

INSERT INTO calendar_events(account_id, title, starts_at, ends_at, contact_id, created_at) VALUES
 ((SELECT acc_a FROM ids), 'Visita', now() + interval '1 day', now() + interval '1 day 1 hour', (SELECT c1 FROM ids), now() - interval '3 min');
INSERT INTO contact_notes(contact_id, user_id, account_id, note_text, created_at) VALUES
 ((SELECT c1 FROM ids), '70000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'Cliente pediu retorno', now() - interval '2 min');
INSERT INTO companies(id, account_id, razao_social) VALUES
 ('70000000-0000-4000-8000-0000000000f4', (SELECT acc_a FROM ids), 'Acme Ltda');
INSERT INTO contact_companies(contact_id, company_id, account_id, created_at) VALUES
 ((SELECT c1 FROM ids), '70000000-0000-4000-8000-0000000000f4', (SELECT acc_a FROM ids), now() - interval '1 min');
INSERT INTO broadcasts(id, user_id, account_id, name, template_name) VALUES
 ('70000000-0000-4000-8000-0000000000f5', '70000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'Black Friday', 'bf');
-- pending is not shown
INSERT INTO broadcast_recipients(broadcast_id, contact_id, status, sent_at) VALUES
 ('70000000-0000-4000-8000-0000000000f5', (SELECT c1 FROM ids), 'sent', now() - interval '30 seconds'),
 ('70000000-0000-4000-8000-0000000000f5', (SELECT c1 FROM ids), 'failed', NULL),
 ('70000000-0000-4000-8000-0000000000f5', (SELECT c1 FROM ids), 'pending', NULL);

-- c3: 25 tasks sharing one created_at.
INSERT INTO tasks(account_id, status_id, title, contact_id, created_at)
SELECT (SELECT acc_a FROM ids), '70000000-0000-4000-8000-0000000000f3', 'T' || g, (SELECT c3 FROM ids), '2026-01-01T10:00:00Z'
  FROM generate_series(1, 25) g;

-- Foreign tenant data on c2 must never leak to A.
INSERT INTO contact_notes(contact_id, user_id, account_id, note_text) VALUES
 ((SELECT c2 FROM ids), '70000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), 'segredo B');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-00000000000a', true);

-- Parity: 2 events + 2 deal + 2 task + 1 appointment + 1 note + 1 company + 2 campaign = 11.
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c1 FROM ids), 50)), 11, 'all sources, note_added event excluded');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c1 FROM ids), 50) WHERE type = 'campaign_sent'), 1, 'campaign sent');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c1 FROM ids), 50) WHERE type = 'campaign_failed'), 1, 'campaign failed');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c1 FROM ids), 50) WHERE type IN ('deal_created','deal_won')), 2, 'deal created + won');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c1 FROM ids), 50) WHERE type = 'conv_deal_stage_changed' AND title = 'Deal X'), 1, 'stage change event carries deal title');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c1 FROM ids), 50) WHERE type = 'note' AND actor_name = 'Owner A'), 1, 'note actor resolved');
-- limit + keyset paging by `at`.
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c1 FROM ids), 3)), 3, 'limit honoured');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c1 FROM ids), 50, now() - interval '5 minutes')), 4, 'p_before without an id is inclusive of that instant');
-- Won time is closed_at (stamped when status changes), not updated_at.
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c1 FROM ids), 50) WHERE type = 'deal_won' AND at >= now() - interval '1 minute'), 1, 'deal_won uses closed_at');
-- Keyset paging reaches every row of a 25-way timestamp tie.
CREATE FUNCTION pg_temp.walk(p_contact uuid, p_page int) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE seen text[] := '{}'; r record; last_at timestamptz; last_cur uuid; n int;
BEGIN
  LOOP
    n := 0;
    FOR r IN SELECT * FROM public.contact_activity(p_contact, p_page, last_at, last_cur) LOOP
      seen := seen || r.id; last_at := r.at; last_cur := r.cursor; n := n + 1;
    END LOOP;
    EXIT WHEN n < p_page;
  END LOOP;
  RETURN (SELECT count(DISTINCT x) FROM unnest(seen) x) * 1000 + array_length(seen, 1);
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.walk(uuid, int) TO authenticated;
SELECT pg_temp.assert_eq(pg_temp.walk((SELECT c3 FROM ids), 10), 50 * 1000 + 50, '25 tasks x (created + done) at identical timestamps: all 50 reachable, none repeated');
SELECT pg_temp.assert_eq(pg_temp.walk((SELECT c1 FROM ids), 4), 11 * 1000 + 11, 'paged walk over c1 sees all 11 rows once');

-- Grants: anon cannot execute the RPCs.
SELECT pg_temp.assert_eq(has_function_privilege('anon', 'public.contact_activity(uuid,integer,timestamptz,uuid)', 'EXECUTE')::int, 0, 'anon cannot run contact_activity');
SELECT pg_temp.assert_eq(has_function_privilege('anon', 'public.account_tag_usage()', 'EXECUTE')::int, 0, 'anon cannot run account_tag_usage');
SELECT pg_temp.assert_eq(has_function_privilege('authenticated', 'public.contact_activity(uuid,integer,timestamptz,uuid)', 'EXECUTE')::int, 1, 'authenticated can run contact_activity');

-- Foreign contact returns nothing for A.
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c2 FROM ids), 50)), 0, 'A cannot read B contact activity');

-- Tag usage counts (RLS scoped).
RESET ROLE;
INSERT INTO tags(id, user_id, account_id, name) VALUES
 ('70000000-0000-4000-8000-0000000000a1', '70000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'VIP'),
 ('70000000-0000-4000-8000-0000000000a2', '70000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), 'B tag');
INSERT INTO contact_tags(contact_id, tag_id) VALUES
 ((SELECT c1 FROM ids), '70000000-0000-4000-8000-0000000000a1'),
 ((SELECT c2 FROM ids), '70000000-0000-4000-8000-0000000000a2');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.account_tag_usage()), 1, 'tag usage limited to own tenant');

-- Tenant B sees none of A.
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c1 FROM ids), 50)), 0, 'B cannot read A contact activity');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.contact_activity((SELECT c2 FROM ids), 50)), 1, 'B sees own note');
RESET ROLE;

SELECT 'OK contact_activity smoke' AS result;
ROLLBACK;
