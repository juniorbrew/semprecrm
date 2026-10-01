-- ============================================================
-- Migration 068 (inbox filters: tag + channel) — parity smoke test.
--
-- Nothing is committed (ends in ROLLBACK). Apply 068 in the same
-- transaction (067 must already be applied):
--   (echo "BEGIN;"; cat supabase/migrations/068_inbox_filters.sql supabase/tests/inbox_filters.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_eq(actual bigint, expected bigint, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;

INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('68000000-0000-4000-8000-00000000000a', 'owner-a@filters.test', '{"full_name":"Owner A"}'),
 ('68000000-0000-4000-8000-00000000000b', 'owner-b@filters.test', '{"full_name":"Owner B"}');

CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '68000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '68000000-0000-4000-8000-00000000000b') AS acc_b,
       '68000000-0000-4000-8000-0000000000a1'::uuid AS t1,
       '68000000-0000-4000-8000-0000000000a2'::uuid AS t2;
GRANT SELECT ON ids TO authenticated;

INSERT INTO tags(id, user_id, account_id, name) VALUES
 ((SELECT t1 FROM ids), '68000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'T1'),
 ((SELECT t2 FROM ids), '68000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'T2');

-- c1: T1 official · c2: T1+T2 qr · c3: T2 qr · c4: no tag official · c5: other account
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
 ('68000000-0000-4000-8000-0000000000c1', '68000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511900000001', 'Alfa Um'),
 ('68000000-0000-4000-8000-0000000000c2', '68000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511900000002', 'Zeta Dois'),
 ('68000000-0000-4000-8000-0000000000c3', '68000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511900000003', 'Zeta Tres'),
 ('68000000-0000-4000-8000-0000000000c4', '68000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511900000004', 'Beta Quatro'),
 ('68000000-0000-4000-8000-0000000000c5', '68000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '5511900000005', 'Zeta Outro');
INSERT INTO contact_tags(contact_id, tag_id) VALUES
 ('68000000-0000-4000-8000-0000000000c1', (SELECT t1 FROM ids)),
 ('68000000-0000-4000-8000-0000000000c2', (SELECT t1 FROM ids)),
 ('68000000-0000-4000-8000-0000000000c2', (SELECT t2 FROM ids)),
 ('68000000-0000-4000-8000-0000000000c3', (SELECT t2 FROM ids));
INSERT INTO conversations(user_id, account_id, contact_id, status, channel, last_message_at, last_customer_message_at) VALUES
 ('68000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '68000000-0000-4000-8000-0000000000c1', 'open', 'official', now() - interval '1 hour', now() - interval '1 hour'),
 ('68000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '68000000-0000-4000-8000-0000000000c2', 'open', 'qr',       now() - interval '2 hour', now() - interval '2 hour'),
 ('68000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '68000000-0000-4000-8000-0000000000c3', 'open', 'qr',       now() - interval '3 hour', now() - interval '3 hour'),
 ('68000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '68000000-0000-4000-8000-0000000000c4', 'open', 'official', now() - interval '4 hour', now() - interval '4 hour'),
 ('68000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '68000000-0000-4000-8000-0000000000c5', 'open', 'official', now(), now());

CREATE FUNCTION pg_temp.page_n(tags uuid[], ch text, pat text DEFAULT NULL, tab text DEFAULT 'all') RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.inbox_conversation_page(
    p_account_id => (SELECT acc_a FROM ids), p_tab => tab, p_pattern => pat, p_tag_ids => tags, p_channel => ch, p_sla_minutes => 1)
$$;
CREATE FUNCTION pg_temp.count_of(col text, tags uuid[], ch text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  EXECUTE format('SELECT %I FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids), p_tag_ids => $1, p_channel => $2, p_sla_minutes => 1)', col)
    INTO v USING tags, ch;
  RETURN v;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.page_n(uuid[], text, text, text), pg_temp.count_of(text, uuid[], text) TO authenticated;

-- 076 closes new functions by default: open this script's pg_temp helpers.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-00000000000a', true);

-- Backwards compatible: old named-argument call, no filters.
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, NULL), 4, 'no filter lists all 4');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all')), 4, 'old-style call');
SELECT pg_temp.assert_eq(pg_temp.page_n(ARRAY[]::uuid[], NULL), 4, 'empty tag array = no filter');

-- Tag filter (ANY of).
SELECT pg_temp.assert_eq(pg_temp.page_n(ARRAY[(SELECT t1 FROM ids)], NULL), 2, 'tag T1 -> c1,c2');
SELECT pg_temp.assert_eq(pg_temp.page_n(ARRAY[(SELECT t2 FROM ids)], NULL), 2, 'tag T2 -> c2,c3');
SELECT pg_temp.assert_eq(pg_temp.page_n(ARRAY[(SELECT t1 FROM ids),(SELECT t2 FROM ids)], NULL), 3, 'T1 or T2 -> 3 (no duplicate for c2)');
-- Channel.
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, 'qr'), 2, 'qr -> c2,c3');
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, 'official'), 2, 'official -> c1,c4');
SELECT pg_temp.assert_eq(pg_temp.page_n(ARRAY[(SELECT t1 FROM ids)], 'qr'), 1, 'T1 + qr -> c2');
-- Queue tab honours them too.
SELECT pg_temp.assert_eq(pg_temp.page_n(ARRAY[(SELECT t2 FROM ids)], 'qr', NULL, 'queue'), 2, 'queue T2 + qr');

-- Counts parity with the list.
SELECT pg_temp.assert_eq(pg_temp.count_of('all_count', NULL, NULL), 4, 'counts: none');
SELECT pg_temp.assert_eq(pg_temp.count_of('all_count', ARRAY[(SELECT t1 FROM ids)], NULL), 2, 'counts: T1');
SELECT pg_temp.assert_eq(pg_temp.count_of('all_count', ARRAY[(SELECT t1 FROM ids),(SELECT t2 FROM ids)], NULL), 3, 'counts: T1|T2');
SELECT pg_temp.assert_eq(pg_temp.count_of('all_count', NULL, 'qr'), 2, 'counts: qr');
SELECT pg_temp.assert_eq(pg_temp.count_of('all_count', ARRAY[(SELECT t1 FROM ids)], 'qr'), 1, 'counts: T1+qr');
SELECT pg_temp.assert_eq(pg_temp.count_of('queue_count', ARRAY[(SELECT t2 FROM ids)], 'qr'), 2, 'counts: queue T2+qr');
SELECT pg_temp.assert_eq(pg_temp.count_of('radar_unassigned', ARRAY[(SELECT t1 FROM ids)], NULL), 2, 'radar chip respects tag');
SELECT pg_temp.assert_eq(pg_temp.count_of('radar_unassigned', NULL, NULL), 4, 'radar chip unfiltered');

-- Search parity (name / phone), alone and combined.
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, NULL, '%Zeta%'), 2, 'search Zeta');
SELECT pg_temp.assert_eq(pg_temp.page_n(ARRAY[(SELECT t1 FROM ids)], NULL, '%Zeta%'), 1, 'search Zeta + T1');
SELECT pg_temp.assert_eq(pg_temp.page_n(NULL, 'official', '%Zeta%'), 0, 'search Zeta + official');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_search_ids((SELECT acc_a FROM ids), '%Zeta%')), 2, 'search_ids plain');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_search_ids((SELECT acc_a FROM ids), '%Zeta%', ARRAY[(SELECT t2 FROM ids)], 'qr')), 2, 'search_ids T2+qr');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_search_ids((SELECT acc_a FROM ids), '%5511900000001%', ARRAY[(SELECT t2 FROM ids)], NULL)), 0, 'search_ids phone excluded by tag');

-- Invalid channel is rejected.
DO $$ BEGIN
  PERFORM count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_channel => 'sms');
  RAISE EXCEPTION 'FAIL: invalid channel accepted';
EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END $$;

-- Tenant isolation: the other account's owner sees nothing of account A, even with A's tags.
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq(pg_temp.page_n(ARRAY[(SELECT t1 FROM ids)], NULL), 0, 'other tenant: page empty');
SELECT pg_temp.assert_eq(pg_temp.count_of('all_count', ARRAY[(SELECT t1 FROM ids)], NULL), 0, 'other tenant: counts zero');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_search_ids((SELECT acc_a FROM ids), '%Zeta%')), 0, 'other tenant: search empty');
RESET ROLE;

SELECT 'OK inbox filters smoke' AS result;
ROLLBACK;
