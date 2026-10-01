-- ============================================================
-- Migrations 074 (CSAT survey) and 075 (support reports) — behaviour,
-- RLS, grants, CHECK widening and aggregation-parity smoke.
--
-- Nothing is committed (ends in ROLLBACK). The local DB is migrated
-- through 073 (or 074 when already applied: every migration statement is
-- idempotent). Apply 074-075 in the same transaction:
--   (echo "BEGIN;"; cat supabase/migrations/07[45]_*.sql supabase/tests/support_csat_reports.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
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

-- ---- tenants -----------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('75000000-0000-4000-8000-00000000000a', 'owner-a@csat.test', '{"full_name":"Owner A"}'),
 ('75000000-0000-4000-8000-00000000000b', 'owner-b@csat.test', '{"full_name":"Owner B"}'),
 ('75000000-0000-4000-8000-00000000000d', 'agent-a@csat.test', '{"full_name":"Agent A"}');
CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '75000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '75000000-0000-4000-8000-00000000000b') AS acc_b,
       '75000000-0000-4000-8000-0000000000a1'::uuid AS cat1,
       '75000000-0000-4000-8000-0000000000a2'::uuid AS cat2,
       '75000000-0000-4000-8000-0000000000b1'::uuid AS team1,
       '75000000-0000-4000-8000-0000000000b2'::uuid AS team2;
GRANT SELECT ON ids TO anon, authenticated, service_role;
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent' WHERE user_id = '75000000-0000-4000-8000-00000000000d';
UPDATE accounts SET preferences = '{"business_hours":{"timezone":"America/Sao_Paulo","days":{}}}'::jsonb WHERE id = (SELECT acc_a FROM ids);

INSERT INTO conversation_categories(id, account_id, name) VALUES
 ((SELECT cat1 FROM ids), (SELECT acc_a FROM ids), 'Cobrança'),
 ((SELECT cat2 FROM ids), (SELECT acc_a FROM ids), 'Dúvida');
INSERT INTO teams(id, account_id, name) VALUES
 ((SELECT team1 FROM ids), (SELECT acc_a FROM ids), 'Financeiro'),
 ((SELECT team2 FROM ids), (SELECT acc_a FROM ids), 'Suporte');

-- ---- ten contacts (one live conversation each) ---------------------------
INSERT INTO contacts(id, user_id, account_id, phone, name)
SELECT ('75000000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '551197500' || lpad(n::text, 4, '0'), 'C' || n
  FROM generate_series(1, 10) AS n;
INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
 ('75000000-0000-4000-8000-000000000199', '75000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '5511975009999', 'Outro');

-- =====================================================================
-- 074: settings, RLS
-- =====================================================================
-- 076 closes new functions by default: open this script's pg_temp helpers.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-00000000000a', true);
INSERT INTO csat_settings(account_id, enabled, delay_minutes) VALUES ((SELECT acc_a FROM ids), true, 5);
SELECT pg_temp.assert_true((SELECT scale = 'stars5' AND ask_comment AND cooldown_days = 7 AND skip_resolutions = ARRAY['not_applicable','duplicate','expired'] AND max_age_hours = 72 AND message_text LIKE 'Como foi o atendimento%'
  FROM csat_settings WHERE account_id = (SELECT acc_a FROM ids)), 'csat_settings defaults');
SELECT pg_temp.assert_fails(format('UPDATE csat_settings SET delay_minutes = 1441 WHERE account_id = %L', (SELECT acc_a FROM ids)), 'delay CHECK (0-1440)');
SELECT pg_temp.assert_fails(format('UPDATE csat_settings SET scale = %L WHERE account_id = %L', 'emoji', (SELECT acc_a FROM ids)), 'scale CHECK');
SELECT pg_temp.assert_fails(format('UPDATE csat_settings SET skip_resolutions = ARRAY[%L] WHERE account_id = %L', 'bogus', (SELECT acc_a FROM ids)), 'skip_resolutions CHECK');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM csat_settings), 1, 'agent reads the settings');
UPDATE csat_settings SET enabled = false WHERE account_id = (SELECT acc_a FROM ids);
SELECT pg_temp.assert_true((SELECT enabled FROM csat_settings WHERE account_id = (SELECT acc_a FROM ids)), 'agent cannot update the settings (0 rows by RLS)');
SELECT pg_temp.assert_fails(format('INSERT INTO csat_settings(account_id) VALUES (%L)', (SELECT acc_b FROM ids)), 'agent cannot insert settings');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM csat_settings), 0, 'tenant B does not see A settings');
SELECT pg_temp.assert_fails(format('INSERT INTO csat_settings(account_id) VALUES (%L)', (SELECT acc_a FROM ids)), 'tenant B cannot write into A');
RESET ROLE;

-- =====================================================================
-- 074: enqueue on close, cancel on reopen
-- =====================================================================
INSERT INTO conversations(id, user_id, account_id, contact_id, status, last_customer_message_at)
VALUES ('75000000-0000-4000-8000-0000000002e1', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000101', 'open', now());
UPDATE conversations SET status = 'closed' WHERE id = '75000000-0000-4000-8000-0000000002e1';
SELECT pg_temp.assert_eq((SELECT count(*) FROM csat_jobs WHERE conversation_id = '75000000-0000-4000-8000-0000000002e1'), 1, 'closing enqueues one job');
SELECT pg_temp.assert_true((SELECT run_at BETWEEN now() + interval '4 minutes' AND now() + interval '6 minutes' AND service_count = 1 FROM csat_jobs WHERE conversation_id = '75000000-0000-4000-8000-0000000002e1'), 'job runs delay_minutes later');
UPDATE conversations SET status = 'open' WHERE id = '75000000-0000-4000-8000-0000000002e1';
SELECT pg_temp.assert_true((SELECT processed_at IS NOT NULL AND result = 'reopened' FROM csat_jobs WHERE conversation_id = '75000000-0000-4000-8000-0000000002e1'), 'reopening cancels the pending job');
UPDATE conversations SET status = 'closed' WHERE id = '75000000-0000-4000-8000-0000000002e1';
SELECT pg_temp.assert_eq((SELECT count(*) FROM csat_jobs WHERE conversation_id = '75000000-0000-4000-8000-0000000002e1'), 2, 'a new attendance (service_count 2) gets its own job');
SELECT pg_temp.assert_true((SELECT service_count = 2 FROM csat_jobs WHERE conversation_id = '75000000-0000-4000-8000-0000000002e1' AND processed_at IS NULL), 'second job keyed on the attendance');
-- Survey off: nothing is enqueued, and a failing enqueue never blocks the resolve.
UPDATE csat_settings SET enabled = false WHERE account_id = (SELECT acc_a FROM ids);
INSERT INTO conversations(id, user_id, account_id, contact_id, status) VALUES ('75000000-0000-4000-8000-0000000002e2', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000102', 'open');
UPDATE conversations SET status = 'closed' WHERE id = '75000000-0000-4000-8000-0000000002e2';
SELECT pg_temp.assert_eq((SELECT count(*) FROM csat_jobs WHERE conversation_id = '75000000-0000-4000-8000-0000000002e2'), 0, 'survey off: no job');
UPDATE csat_settings SET enabled = true WHERE account_id = (SELECT acc_a FROM ids);
-- Archiving an open conversation is not a resolution.
INSERT INTO conversations(id, user_id, account_id, contact_id, status) VALUES ('75000000-0000-4000-8000-0000000002e3', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000103', 'open');
UPDATE conversations SET status = 'closed', archived_at = now() WHERE id = '75000000-0000-4000-8000-0000000002e3';
SELECT pg_temp.assert_eq((SELECT count(*) FROM csat_jobs WHERE conversation_id = '75000000-0000-4000-8000-0000000002e3'), 0, 'archived: no job');
-- Unique per attendance.
SELECT pg_temp.assert_fails(format('INSERT INTO csat_jobs(account_id, conversation_id, service_count, run_at) VALUES (%L, %L, 2, now())', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e1'), 'one job per conversation attendance');

-- =====================================================================
-- 074: claim, answer, comment, expire (service role only)
-- =====================================================================
SET ROLE authenticated;
SELECT pg_temp.assert_fails('SELECT * FROM public.csat_claim_jobs()', 'claim is not callable by users');
SELECT pg_temp.assert_fails('SELECT public.csat_expire()', 'expire is not callable by users');
SELECT pg_temp.assert_fails(format('SELECT * FROM public.csat_record_answer(%L, 5)', gen_random_uuid()), 'record_answer is not callable by users');
SELECT pg_temp.assert_fails(format('SELECT public.csat_request_comment(%L)', gen_random_uuid()), 'request_comment is not callable by users');
SELECT pg_temp.assert_fails(format('SELECT public.csat_record_comment(%L, %L)', gen_random_uuid(), 'x'), 'record_comment is not callable by users');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.assert_fails('SELECT * FROM public.csat_claim_jobs()', 'claim is not callable by anon');
RESET ROLE;
SET ROLE service_role;
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.csat_claim_jobs(now() + interval '10 minutes')), 1, 'claim returns the due job');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.csat_claim_jobs(now() + interval '10 minutes')), 0, 'a claimed job is not claimed twice');
RESET ROLE;
UPDATE csat_jobs SET claimed_at = now() - interval '10 minutes' WHERE processed_at IS NULL;
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.csat_claim_jobs(now() + interval '10 minutes')), 1, 'a stale claim (crashed worker) is retried');
UPDATE csat_jobs SET attempts = 3, claimed_at = now() - interval '10 minutes' WHERE processed_at IS NULL;
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.csat_claim_jobs(now() + interval '10 minutes')), 0, 'after 3 attempts it is not claimed again');
SELECT public.csat_expire();
SELECT pg_temp.assert_true((SELECT result = 'failed' FROM csat_jobs WHERE conversation_id = '75000000-0000-4000-8000-0000000002e1' AND processed_at IS NOT NULL AND result <> 'reopened'), 'exhausted jobs are closed as failed');

INSERT INTO csat_responses(id, account_id, conversation_id, contact_id, status, sent_at) VALUES
 ('75000000-0000-4000-8000-0000000003a1', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e1', '75000000-0000-4000-8000-000000000101', 'sent', now() - interval '1 hour');
SELECT pg_temp.assert_fails(format('INSERT INTO csat_responses(account_id, conversation_id, contact_id) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e1', '75000000-0000-4000-8000-000000000101'), 'one survey per conversation');
SELECT pg_temp.assert_fails(format('UPDATE csat_responses SET score = 6 WHERE id = %L', '75000000-0000-4000-8000-0000000003a1'), 'score CHECK 1-5');
SELECT pg_temp.assert_fails(format('UPDATE csat_responses SET comment = repeat(%L, 501) WHERE id = %L', 'x', '75000000-0000-4000-8000-0000000003a1'), 'comment CHECK <= 500');
SELECT pg_temp.assert_fails(format('UPDATE csat_responses SET status = %L WHERE id = %L', 'answered', '75000000-0000-4000-8000-0000000003a1'), 'answered needs a score');

INSERT INTO automations(user_id, account_id, name, trigger_type, trigger_config, is_active)
VALUES ('75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), 'Nota baixa', 'csat_received', '{"max_score":2}', true);
SET ROLE service_role;
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.csat_record_answer('75000000-0000-4000-8000-0000000003a1', 6)), 0, 'a score out of range records nothing');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.csat_record_answer('75000000-0000-4000-8000-0000000003a1', 2)), 1, 'the first answer wins');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.csat_record_answer('75000000-0000-4000-8000-0000000003a1', 5)), 0, 'a second answer records nothing');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT status = 'answered' AND score = 2 AND comment_requested_at IS NULL AND answered_at IS NOT NULL FROM csat_responses WHERE id = '75000000-0000-4000-8000-0000000003a1'), 'answer stored (the comment question is asked later)');
SELECT pg_temp.assert_eq((SELECT count(*) FROM conversation_events WHERE conversation_id = '75000000-0000-4000-8000-0000000002e1' AND event_type = 'csat_answered' AND payload = '{"score":2}'), 1, 'one csat_answered event');
SELECT pg_temp.assert_eq((SELECT count(*) FROM automation_event_queue WHERE trigger_type = 'csat_received' AND conversation_id = '75000000-0000-4000-8000-0000000002e1' AND (context->>'score')::int = 2), 1, 'csat_received queued with the score');
SET ROLE service_role;
SELECT pg_temp.assert_true(NOT public.csat_record_comment('75000000-0000-4000-8000-0000000003a1', 'cedo demais'), 'no comment before the question was sent');
SELECT pg_temp.assert_true(public.csat_request_comment('75000000-0000-4000-8000-0000000003a1'), 'the question is recorded once it went out');
SELECT pg_temp.assert_true(NOT public.csat_request_comment('75000000-0000-4000-8000-0000000003a1'), 'asked only once');
SELECT pg_temp.assert_true(public.csat_record_comment('75000000-0000-4000-8000-0000000003a1', '  Demorou, mas resolveram  '), 'the comment is recorded');
SELECT pg_temp.assert_true(NOT public.csat_record_comment('75000000-0000-4000-8000-0000000003a1', 'outro'), 'a second comment is refused');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT comment = 'Demorou, mas resolveram' AND comment_received_at IS NOT NULL FROM csat_responses WHERE id = '75000000-0000-4000-8000-0000000003a1'), 'comment trimmed and stored once');
-- A comment later than 10 minutes after the question is refused; score + comment in one message is stored at once.
INSERT INTO csat_responses(id, account_id, conversation_id, contact_id, status, score, sent_at, answered_at, comment_requested_at) VALUES
 ('75000000-0000-4000-8000-0000000003c1', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e2', '75000000-0000-4000-8000-000000000102', 'answered', 4, now() - interval '1 hour', now() - interval '30 minutes', now() - interval '11 minutes');
SET ROLE service_role;
SELECT pg_temp.assert_true(NOT public.csat_record_comment('75000000-0000-4000-8000-0000000003c1', 'tarde'), 'comment window is 10 minutes');
RESET ROLE;
DELETE FROM csat_responses WHERE id = '75000000-0000-4000-8000-0000000003c1';
INSERT INTO csat_responses(id, account_id, conversation_id, contact_id, status, sent_at) VALUES
 ('75000000-0000-4000-8000-0000000003c2', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e2', '75000000-0000-4000-8000-000000000102', 'sent', now() - interval '1 hour');
SET ROLE service_role;
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.csat_record_answer('75000000-0000-4000-8000-0000000003c2', 5, 'mas demorou')), 1, 'score with a comment in one message');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT comment = 'mas demorou' AND comment_received_at IS NOT NULL AND comment_requested_at IS NULL FROM csat_responses WHERE id = '75000000-0000-4000-8000-0000000003c2'), 'comment stored with the score, no question needed');
DELETE FROM csat_responses WHERE id = '75000000-0000-4000-8000-0000000003c2';
-- 'reserved' is the default and is not a survey sent.
INSERT INTO csat_responses(id, account_id, conversation_id, contact_id) VALUES ('75000000-0000-4000-8000-0000000003c3', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e2', '75000000-0000-4000-8000-000000000102');
SELECT pg_temp.assert_true((SELECT status = 'reserved' FROM csat_responses WHERE id = '75000000-0000-4000-8000-0000000003c3'), 'new rows are reserved');
SET ROLE service_role;
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.csat_record_answer('75000000-0000-4000-8000-0000000003c3', 5)), 0, 'a reserved (never sent) survey cannot be answered');
RESET ROLE;
DELETE FROM csat_responses WHERE id = '75000000-0000-4000-8000-0000000003c3';
-- Survey traffic (origin csat) is invisible to the conversation bookkeeping.
INSERT INTO conversations(id, user_id, account_id, contact_id, status, archived_at, resolved_at, last_customer_message_at) VALUES ('75000000-0000-4000-8000-0000000002e9', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000109', 'closed', now(), now() - interval '1 day', now() - interval '2 days');
INSERT INTO messages(conversation_id, sender_type, content_type, content_text, origin) VALUES ('75000000-0000-4000-8000-0000000002e9', 'bot', 'text', 'Como foi?', 'csat');
INSERT INTO messages(conversation_id, sender_type, content_type, content_text, origin) VALUES ('75000000-0000-4000-8000-0000000002e9', 'customer', 'text', '5', 'csat');
SELECT pg_temp.assert_true((SELECT first_response_at IS NULL AND last_agent_message_at IS NULL AND archived_at IS NOT NULL AND last_customer_message_at < now() - interval '1 day' FROM conversations WHERE id = '75000000-0000-4000-8000-0000000002e9'), 'csat messages: no first response, no agent bump, a consumed 5 does not un-archive');
INSERT INTO messages(conversation_id, sender_type, content_type, content_text) VALUES ('75000000-0000-4000-8000-0000000002e9', 'customer', 'text', 'oi, voltei');
SELECT pg_temp.assert_true((SELECT archived_at IS NULL FROM conversations WHERE id = '75000000-0000-4000-8000-0000000002e9'), 'a normal customer message still un-archives (056 unchanged)');
DELETE FROM conversations WHERE id = '75000000-0000-4000-8000-0000000002e9';
-- 48 h expiry; an answered survey never expires.
INSERT INTO csat_responses(id, account_id, conversation_id, contact_id, status, sent_at) VALUES
 ('75000000-0000-4000-8000-0000000003b1', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e2', '75000000-0000-4000-8000-000000000102', 'sent', now() - interval '30 hours'),
 ('75000000-0000-4000-8000-0000000003b2', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e3', '75000000-0000-4000-8000-000000000103', 'sent', now() - interval '60 hours');
SELECT pg_temp.assert_eq(public.csat_expire(), 1, 'only the survey older than 48 h expires (60 h; the 30 h one stays)');
SELECT pg_temp.assert_eq(public.csat_expire(), 0, 'expiry is idempotent');
SELECT pg_temp.assert_true((SELECT status = 'answered' FROM csat_responses WHERE id = '75000000-0000-4000-8000-0000000003a1'), 'an answered survey stays answered');

-- csat_responses: members read, nobody writes through the API.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_true((SELECT count(*) >= 1 FROM csat_responses), 'agent reads surveys of the account');
SELECT pg_temp.assert_fails(format('INSERT INTO csat_responses(account_id, conversation_id, contact_id) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e2', '75000000-0000-4000-8000-000000000102'), 'agent cannot insert a survey row');
UPDATE csat_responses SET score = 1 WHERE id = '75000000-0000-4000-8000-0000000003a1';
SELECT pg_temp.assert_eq((SELECT score FROM csat_responses WHERE id = '75000000-0000-4000-8000-0000000003a1'), 2, 'agent cannot update a survey (0 rows by RLS)');
SELECT pg_temp.assert_eq((SELECT count(*) FROM csat_jobs), 0, 'csat_jobs has no policies: invisible to users');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_fails(format('INSERT INTO csat_responses(account_id, conversation_id, contact_id) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e2', '75000000-0000-4000-8000-000000000102'), 'not even an admin writes survey rows');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM csat_responses), 0, 'tenant B does not see A surveys');
RESET ROLE;

-- =====================================================================
-- 074: CHECK lists keep every prior value
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assigned','unassigned','status_changed','label_added','label_removed','note_added','contact_opted_out','contact_opted_in','ai_handoff','ai_paused','ai_resumed','deal_stage_changed','category_changed','priority_changed','resolution_set','sla_warning','sla_breached','team_changed','csat_sent','csat_answered'] LOOP
    INSERT INTO conversation_events(account_id, conversation_id, event_type, payload)
    VALUES ((SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e1', t, '{}'::jsonb);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['phone','automation','flow','system','ai','csat'] LOOP
    INSERT INTO messages(conversation_id, sender_type, content_type, content_text, origin)
    VALUES ('75000000-0000-4000-8000-0000000002e1', 'bot', 'text', 'x', t);
  END LOOP;
END $$;
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_events(account_id, conversation_id, event_type) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000002e1', 'not_a_real_event'), 'unknown event type rejected');
SELECT pg_temp.assert_fails(format('INSERT INTO messages(conversation_id, sender_type, content_type, content_text, origin) VALUES (%L, %L, %L, %L, %L)', '75000000-0000-4000-8000-0000000002e1', 'bot', 'text', 'x', 'robot'), 'unknown message origin rejected');

-- =====================================================================
-- 075: reports. Seed with known values (account time zone = Sao Paulo).
-- =====================================================================
-- The conversations used above would count in the report: drop them (cascades to surveys and jobs).
DELETE FROM conversations WHERE id IN ('75000000-0000-4000-8000-0000000002e1', '75000000-0000-4000-8000-0000000002e2', '75000000-0000-4000-8000-0000000002e3');
CREATE FUNCTION pg_temp.sp(d date, hh numeric) RETURNS timestamptz LANGUAGE sql AS
$$ SELECT (d::timestamp + make_interval(secs => (hh * 3600)::int)) AT TIME ZONE 'America/Sao_Paulo' $$;
CREATE TEMP TABLE d AS SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS today;
GRANT SELECT ON d TO authenticated, service_role;

-- c(n): contact n. status/cat/team/agent/priority/created/resolved/fr as noted.
INSERT INTO conversations(id, user_id, account_id, contact_id, status, category_id, team_id, assigned_agent_id, priority, channel, created_at, last_customer_message_at, first_response_seconds, first_response_at) VALUES
 -- C1: opened D-3 10:00, resolved D-3 12:00 (7200 s), fr 60 s
 ('75000000-0000-4000-8000-0000000004c1', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000104', 'closed', (SELECT cat1 FROM ids), (SELECT team1 FROM ids), '75000000-0000-4000-8000-00000000000a', 'high', 'official', pg_temp.sp((SELECT today FROM d) - 3, 10), pg_temp.sp((SELECT today FROM d) - 3, 10), 60, pg_temp.sp((SELECT today FROM d) - 3, 10.0167)),
 -- C2: opened D-2 10:00, resolved D-2 11:00 (3600 s), fr 120 s
 ('75000000-0000-4000-8000-0000000004c2', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000105', 'closed', (SELECT cat1 FROM ids), (SELECT team1 FROM ids), '75000000-0000-4000-8000-00000000000d', 'normal', 'official', pg_temp.sp((SELECT today FROM d) - 2, 10), pg_temp.sp((SELECT today FROM d) - 2, 10), 120, pg_temp.sp((SELECT today FROM d) - 2, 10.0333)),
 -- C3: opened D-2 15:00, resolved D-1 09:00 (64800 s), fr 300 s, reopened once, QR
 ('75000000-0000-4000-8000-0000000004c3', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000106', 'closed', (SELECT cat2 FROM ids), (SELECT team2 FROM ids), '75000000-0000-4000-8000-00000000000d', 'normal', 'qr', pg_temp.sp((SELECT today FROM d) - 2, 15), pg_temp.sp((SELECT today FROM d) - 2, 15), 300, pg_temp.sp((SELECT today FROM d) - 2, 15.0833)),
 -- C4: opened D-2 10:00, still open, unassigned
 ('75000000-0000-4000-8000-0000000004c4', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000107', 'open', (SELECT cat1 FROM ids), (SELECT team1 FROM ids), NULL, 'normal', 'official', pg_temp.sp((SELECT today FROM d) - 2, 10), pg_temp.sp((SELECT today FROM d) - 2, 10), NULL, NULL),
 -- C5: opened 2 h ago, open, no category / team
 ('75000000-0000-4000-8000-0000000004c5', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000108', 'open', NULL, NULL, NULL, 'normal', 'official', now() - interval '2 hours', now() - interval '2 hours', NULL, NULL),
 -- C6: opened 10 days ago (before the period), still open
 ('75000000-0000-4000-8000-0000000004c6', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000109', 'open', (SELECT cat2 FROM ids), (SELECT team2 FROM ids), '75000000-0000-4000-8000-00000000000d', 'low', 'official', pg_temp.sp((SELECT today FROM d) - 10, 10), pg_temp.sp((SELECT today FROM d) - 10, 10), NULL, NULL),
 -- C9: opened D-4 23:30 Sao Paulo (= D-3 02:30 UTC): the day belongs to D-4
 ('75000000-0000-4000-8000-0000000004c9', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000110', 'open', (SELECT cat1 FROM ids), (SELECT team1 FROM ids), '75000000-0000-4000-8000-00000000000a', 'normal', 'official', pg_temp.sp((SELECT today FROM d) - 4, 23.5), pg_temp.sp((SELECT today FROM d) - 4, 23.5), NULL, NULL);
-- C7: opened 8 days ago, closed yesterday (inside the period): resolved but not opened.
INSERT INTO conversations(id, user_id, account_id, contact_id, status, category_id, team_id, assigned_agent_id, priority, channel, created_at, last_customer_message_at)
VALUES ('75000000-0000-4000-8000-0000000004c7', '75000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '75000000-0000-4000-8000-000000000104', 'open', (SELECT cat1 FROM ids), (SELECT team1 FROM ids), '75000000-0000-4000-8000-00000000000a', 'normal', 'official', pg_temp.sp((SELECT today FROM d) - 8, 10), pg_temp.sp((SELECT today FROM d) - 8, 10));
-- Closing stamps resolved_at = now(); set the intended instants afterwards (not a status change, no trigger).
UPDATE conversations SET resolved_at = pg_temp.sp((SELECT today FROM d) - 3, 12) WHERE id = '75000000-0000-4000-8000-0000000004c1';
UPDATE conversations SET resolved_at = pg_temp.sp((SELECT today FROM d) - 2, 11) WHERE id = '75000000-0000-4000-8000-0000000004c2';
UPDATE conversations SET resolved_at = pg_temp.sp((SELECT today FROM d) - 1, 9), service_count = 2 WHERE id = '75000000-0000-4000-8000-0000000004c3';
UPDATE conversations SET status = 'closed' WHERE id = '75000000-0000-4000-8000-0000000004c7';
UPDATE conversations SET resolved_at = pg_temp.sp((SELECT today FROM d) - 1, 10) WHERE id = '75000000-0000-4000-8000-0000000004c7';
-- Another tenant's conversation, never to be seen.
INSERT INTO conversations(id, user_id, account_id, contact_id, status, created_at, last_customer_message_at)
VALUES ('75000000-0000-4000-8000-0000000004b1', '75000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '75000000-0000-4000-8000-000000000199', 'open', now(), now());
-- SLA targets (set directly: no policy rows in this test).
UPDATE conversations SET first_response_due_at = created_at + interval '30 minutes', resolution_due_at = created_at + interval '3 hours' WHERE id = '75000000-0000-4000-8000-0000000004c1';  -- met + met
UPDATE conversations SET first_response_due_at = created_at + interval '1 minute', resolution_due_at = created_at + interval '30 minutes' WHERE id = '75000000-0000-4000-8000-0000000004c2';  -- missed + missed
UPDATE conversations SET resolution_due_at = now() - interval '1 hour' WHERE id = '75000000-0000-4000-8000-0000000004c4';  -- open and late: missed
UPDATE conversations SET resolution_due_at = now() + interval '5 hours' WHERE id = '75000000-0000-4000-8000-0000000004c5';  -- future: not judged
-- Surveys sent in the period: C1 answered 5, C2 answered 3, C3 sent (unanswered), C4 skipped and C5 reserved (a never-sent reservation) are not counted.
INSERT INTO csat_responses(account_id, conversation_id, contact_id, team_id, category_id, priority, assigned_agent_id, score, status, sent_at) VALUES
 ((SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000004c1', '75000000-0000-4000-8000-000000000104', (SELECT team1 FROM ids), (SELECT cat1 FROM ids), 'high',   '75000000-0000-4000-8000-00000000000a', 5, 'answered', pg_temp.sp((SELECT today FROM d) - 3, 12.1)),
 ((SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000004c2', '75000000-0000-4000-8000-000000000105', (SELECT team1 FROM ids), (SELECT cat1 FROM ids), 'normal', '75000000-0000-4000-8000-00000000000d', 3, 'answered', pg_temp.sp((SELECT today FROM d) - 2, 11.1)),
 ((SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000004c3', '75000000-0000-4000-8000-000000000106', (SELECT team2 FROM ids), (SELECT cat2 FROM ids), 'normal', '75000000-0000-4000-8000-00000000000d', NULL, 'sent', pg_temp.sp((SELECT today FROM d) - 1, 9.1)),
 ((SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000004c4', '75000000-0000-4000-8000-000000000107', NULL, NULL, 'normal', NULL, NULL, 'skipped', pg_temp.sp((SELECT today FROM d) - 1, 10.1)),
 ((SELECT acc_a FROM ids), '75000000-0000-4000-8000-0000000004c5', '75000000-0000-4000-8000-000000000108', NULL, NULL, 'normal', NULL, NULL, 'reserved', pg_temp.sp((SELECT today FROM d) - 1, 10.2));

-- ---- grants ----------------------------------------------------------------
SET ROLE anon;
SELECT pg_temp.assert_fails(format('SELECT * FROM public.support_report(%L, current_date - 5, current_date)', (SELECT acc_a FROM ids)), 'anon cannot call support_report');
SELECT pg_temp.assert_fails(format('SELECT * FROM public.support_report_backlog(%L)', (SELECT acc_a FROM ids)), 'anon cannot call support_report_backlog');
RESET ROLE;

-- ---- authorisation -------------------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_fails(format('SELECT * FROM public.support_report(%L, current_date - 5, current_date)', (SELECT acc_a FROM ids)), 'an agent cannot read the reports');
SELECT pg_temp.assert_fails(format('SELECT * FROM public.support_report_backlog(%L)', (SELECT acc_a FROM ids)), 'an agent cannot read the backlog report');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_fails(format('SELECT * FROM public.support_report(%L, current_date - 5, current_date)', (SELECT acc_a FROM ids)), 'an admin of tenant B cannot read tenant A');
SELECT pg_temp.assert_eq((SELECT opened FROM public.support_report((SELECT acc_b FROM ids), current_date - 5, current_date)), 1, 'tenant B sees only its own row');
RESET ROLE;

-- ---- numbers (admin of A) -----------------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-00000000000a', true);
CREATE TEMP TABLE r_all AS SELECT * FROM public.support_report((SELECT acc_a FROM ids), (SELECT today FROM d) - 5, (SELECT today FROM d));
SELECT pg_temp.assert_eq((SELECT count(*) FROM r_all), 1, 'group all = one row');
SELECT pg_temp.assert_eq((SELECT opened FROM r_all), 6, 'opened: C1 C2 C3 C4 C5 + C9 (C6 and C7 opened outside the period)');
SELECT pg_temp.assert_eq((SELECT resolved FROM r_all), 4, 'resolved: C1 C2 C3 C7');
SELECT pg_temp.assert_eq((SELECT backlog FROM r_all), 4, 'backlog now: C4 C5 C6 C9');
SELECT pg_temp.assert_eq((SELECT fr_count FROM r_all), 3, 'first responses: C1 C2 C3');
SELECT pg_temp.assert_eq((SELECT round(fr_avg_seconds::numeric, 2) FROM r_all), 160, 'first response average (60+120+300)/3');
SELECT pg_temp.assert_eq((SELECT fr_median_seconds::numeric FROM r_all), 120, 'first response median');
SELECT pg_temp.assert_eq((SELECT round(fr_p90_seconds::numeric, 2) FROM r_all), 264, 'first response p90 (interpolated 120 + 0.8 * 180)');
SELECT pg_temp.assert_eq((SELECT res_count FROM r_all), 4, 'resolution times: 4');
SELECT pg_temp.assert_eq((SELECT round(res_avg_seconds::numeric)  FROM r_all), 170100, 'resolution average');
SELECT pg_temp.assert_eq((SELECT round(res_median_seconds::numeric) FROM r_all), 36000, 'resolution median');
SELECT pg_temp.assert_eq((SELECT round(res_p90_seconds::numeric) FROM r_all), 442800, 'resolution p90');
SELECT pg_temp.assert_eq((SELECT sla_met FROM r_all), 2, 'SLA met: C1 first response + C1 resolution');
SELECT pg_temp.assert_eq((SELECT sla_missed FROM r_all), 3, 'SLA missed: C2 first response + C2 resolution + C4 resolution (C5 is still in the future)');
SELECT pg_temp.assert_eq((SELECT reopened FROM r_all), 1, 'reopened: C3');
SELECT pg_temp.assert_eq((SELECT csat_sent FROM r_all), 3, 'surveys sent (skipped not counted)');
SELECT pg_temp.assert_eq((SELECT csat_answered FROM r_all), 2, 'surveys answered');
SELECT pg_temp.assert_eq((SELECT csat_avg FROM r_all), 4.00, 'CSAT average (5+3)/2');
RESET ROLE;

-- ---- groups: ids, nulls, parity with the overall row ---------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-00000000000a', true);
CREATE TEMP TABLE r_cat  AS SELECT * FROM public.support_report((SELECT acc_a FROM ids), (SELECT today FROM d) - 5, (SELECT today FROM d), 'category');
CREATE TEMP TABLE r_team AS SELECT * FROM public.support_report((SELECT acc_a FROM ids), (SELECT today FROM d) - 5, (SELECT today FROM d), 'team');
CREATE TEMP TABLE r_agent AS SELECT * FROM public.support_report((SELECT acc_a FROM ids), (SELECT today FROM d) - 5, (SELECT today FROM d), 'agent');
CREATE TEMP TABLE r_prio AS SELECT * FROM public.support_report((SELECT acc_a FROM ids), (SELECT today FROM d) - 5, (SELECT today FROM d), 'priority');
-- Every grouping adds up to the overall row (no row lost, none counted twice).
SELECT pg_temp.assert_eq((SELECT sum(opened) FROM r_cat), 6, 'category: opened parity');
SELECT pg_temp.assert_eq((SELECT sum(resolved) FROM r_cat), 4, 'category: resolved parity');
SELECT pg_temp.assert_eq((SELECT sum(backlog) FROM r_cat), 4, 'category: backlog parity');
SELECT pg_temp.assert_eq((SELECT sum(csat_sent) FROM r_cat), 3, 'category: csat parity');
SELECT pg_temp.assert_eq((SELECT sum(opened) FROM r_team), 6, 'team: opened parity');
SELECT pg_temp.assert_eq((SELECT sum(resolved) FROM r_agent), 4, 'agent: resolved parity');
SELECT pg_temp.assert_eq((SELECT sum(sla_met + sla_missed) FROM r_prio), 5, 'priority: SLA parity');
SELECT pg_temp.assert_eq((SELECT sum(csat_answered) FROM r_agent), 2, 'agent: answered parity');
-- Values per group.
SELECT pg_temp.assert_true((SELECT opened = 4 AND resolved = 3 AND backlog = 2 FROM r_cat WHERE group_key = (SELECT cat1 FROM ids)::text), 'category 1');
SELECT pg_temp.assert_true((SELECT opened = 1 AND resolved = 1 AND backlog = 1 FROM r_cat WHERE group_key = (SELECT cat2 FROM ids)::text), 'category 2');
SELECT pg_temp.assert_true((SELECT opened = 1 AND backlog = 1 FROM r_cat WHERE group_key IS NULL), 'no category = NULL key');
SELECT pg_temp.assert_true((SELECT opened = 4 AND csat_sent = 2 AND csat_answered = 2 AND csat_avg = 4.00 FROM r_team WHERE group_key = (SELECT team1 FROM ids)::text), 'team 1 (csat by snapshot)');
SELECT pg_temp.assert_true((SELECT opened = 2 AND resolved = 2 AND csat_sent = 1 AND csat_avg = 5.00 FROM r_agent WHERE group_key = '75000000-0000-4000-8000-00000000000a'), 'owner as agent');
SELECT pg_temp.assert_true((SELECT opened = 2 AND resolved = 2 AND backlog = 1 AND csat_sent = 2 AND csat_answered = 1 AND csat_avg = 3.00 FROM r_agent WHERE group_key = '75000000-0000-4000-8000-00000000000d'), 'agent d');
SELECT pg_temp.assert_true((SELECT opened = 2 AND backlog = 2 FROM r_agent WHERE group_key IS NULL), 'unassigned');
SELECT pg_temp.assert_true((SELECT opened = 1 AND sla_met = 2 AND sla_missed = 0 FROM r_prio WHERE group_key = 'high'), 'priority high SLA');
SELECT pg_temp.assert_true((SELECT opened = 5 AND sla_met = 0 AND sla_missed = 3 FROM r_prio WHERE group_key = 'normal'), 'priority normal SLA');
SELECT pg_temp.assert_true((SELECT opened = 0 AND backlog = 1 FROM r_prio WHERE group_key = 'low'), 'a group with only backlog still appears');

-- ---- filters ------------------------------------------------------------------------------
SELECT pg_temp.assert_true((SELECT opened = 1 AND resolved = 1 AND csat_sent = 1 FROM public.support_report((SELECT acc_a FROM ids), (SELECT today FROM d) - 5, (SELECT today FROM d), 'all', NULL, NULL, NULL, 'qr')), 'channel filter (qr)');
SELECT pg_temp.assert_true((SELECT opened = 4 FROM public.support_report((SELECT acc_a FROM ids), (SELECT today FROM d) - 5, (SELECT today FROM d), 'all', (SELECT team1 FROM ids))), 'team filter');
SELECT pg_temp.assert_true((SELECT opened = 4 AND backlog = 2 FROM public.support_report((SELECT acc_a FROM ids), (SELECT today FROM d) - 5, (SELECT today FROM d), 'all', NULL, (SELECT cat1 FROM ids))), 'category filter');
SELECT pg_temp.assert_true((SELECT opened = 2 AND csat_sent = 2 FROM public.support_report((SELECT acc_a FROM ids), (SELECT today FROM d) - 5, (SELECT today FROM d), 'all', NULL, NULL, '75000000-0000-4000-8000-00000000000d')), 'agent filter');

-- ---- days are the account's days (Sao Paulo), not UTC ---------------------------------------
SELECT pg_temp.assert_eq((SELECT opened FROM public.support_report((SELECT acc_a FROM ids), (SELECT today FROM d) - 4, (SELECT today FROM d) - 4)), 1, 'D-4 23:30 São Paulo belongs to D-4');
SELECT pg_temp.assert_eq((SELECT opened FROM public.support_report((SELECT acc_a FROM ids), (SELECT today FROM d) - 3, (SELECT today FROM d) - 3)), 1, 'D-3 holds only C1 (a UTC bucket would add C9)');
RESET ROLE;
-- A time zone the account never set falls back to the default; an invalid one too.
SELECT pg_temp.assert_true(public.report_timezone((SELECT acc_b FROM ids)) = 'America/Sao_Paulo', 'default time zone');
UPDATE accounts SET preferences = '{"business_hours":{"timezone":"Not/AZone"}}'::jsonb WHERE id = (SELECT acc_b FROM ids);
SELECT pg_temp.assert_true(public.report_timezone((SELECT acc_b FROM ids)) = 'America/Sao_Paulo', 'unknown time zone falls back');
UPDATE accounts SET preferences = '{"business_hours":{"timezone":"Asia/Tokyo"}}'::jsonb WHERE id = (SELECT acc_b FROM ids);
SELECT pg_temp.assert_true(public.report_timezone((SELECT acc_b FROM ids)) = 'Asia/Tokyo', 'the account time zone is used');

-- ---- bad input -------------------------------------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '75000000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_fails(format('SELECT * FROM public.support_report(%L, current_date, current_date - 1)', (SELECT acc_a FROM ids)), 'to before from');
SELECT pg_temp.assert_fails(format('SELECT * FROM public.support_report(%L, current_date - 400, current_date)', (SELECT acc_a FROM ids)), 'period over a year');
SELECT pg_temp.assert_fails(format('SELECT * FROM public.support_report(%L, current_date - 5, current_date, %L)', (SELECT acc_a FROM ids), 'contact'), 'unknown grouping');
SELECT pg_temp.assert_fails(format('SELECT * FROM public.support_report(%L, current_date - 5, current_date, %L, NULL, NULL, NULL, %L)', (SELECT acc_a FROM ids), 'all', 'sms'), 'unknown channel');

-- ---- backlog by age ------------------------------------------------------------------------------
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.support_report_backlog((SELECT acc_a FROM ids))), 4, 'four buckets, always');
SELECT pg_temp.assert_true((SELECT array_agg(bucket || '=' || total ORDER BY bucket) = ARRAY['d1_3=1','d3_7=1','gt7=1','lt1d=1'] FROM public.support_report_backlog((SELECT acc_a FROM ids))), 'backlog: C4 1-3 d, C9 3-7 d, C6 over 7 d, C5 under 1 d');
SELECT pg_temp.assert_eq((SELECT sum(total) FROM public.support_report_backlog((SELECT acc_a FROM ids))), 4, 'backlog total = open + pending');
SELECT pg_temp.assert_eq((SELECT sum(total) FROM public.support_report_backlog((SELECT acc_a FROM ids), (SELECT team2 FROM ids))), 1, 'backlog team filter (C6)');
RESET ROLE;

-- ---- the report returns no personal data ---------------------------------------------------------
SELECT pg_temp.assert_true((SELECT NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'support_report'
     AND pg_get_function_result(p.oid) ~* '(phone|contact|comment|message)')), 'support_report returns no contact / message / comment column');

ROLLBACK;
