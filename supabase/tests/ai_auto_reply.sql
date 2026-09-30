-- ============================================================
-- Migration 066 (automatic reply) — behaviour + RLS smoke test.
--
-- Nothing is committed (ends in ROLLBACK). Apply the missing
-- migrations in the same transaction first:
--   (echo "BEGIN;"; cat supabase/migrations/05[4-9]_*.sql supabase/migrations/06[0-6]_*.sql supabase/tests/ai_auto_reply.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;

INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('66000000-0000-4000-8000-00000000000a', 'owner-a@auto.test', '{"full_name":"Owner A"}'),
 ('66000000-0000-4000-8000-00000000000b', 'owner-b@auto.test', '{"full_name":"Owner B"}'),
 ('66000000-0000-4000-8000-00000000000d', 'agent-a@auto.test', '{"full_name":"Agent A"}'),
 ('66000000-0000-4000-8000-00000000000e', 'viewer-a@auto.test', '{"full_name":"Viewer A"}');

CREATE TEMP TABLE ids AS
SELECT
  (SELECT account_id FROM profiles WHERE user_id = '66000000-0000-4000-8000-00000000000a') AS acc_a,
  (SELECT account_id FROM profiles WHERE user_id = '66000000-0000-4000-8000-00000000000b') AS acc_b,
  '66000000-0000-4000-8000-0000000000c1'::uuid AS contact_a,
  '66000000-0000-4000-8000-0000000000c2'::uuid AS contact_b,
  '66000000-0000-4000-8000-0000000000f1'::uuid AS conv_a,
  '66000000-0000-4000-8000-0000000000f2'::uuid AS conv_b,
  '66000000-0000-4000-8000-0000000000e1'::uuid AS msg_1,
  '66000000-0000-4000-8000-0000000000e2'::uuid AS msg_2,
  '66000000-0000-4000-8000-0000000000e3'::uuid AS msg_3;
GRANT SELECT ON ids TO authenticated, service_role;

UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id = '66000000-0000-4000-8000-00000000000d';
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'viewer'
 WHERE user_id = '66000000-0000-4000-8000-00000000000e';

INSERT INTO contacts(id, user_id, account_id, phone, name)
SELECT contact_a, '66000000-0000-4000-8000-00000000000a'::uuid, acc_a, '5511966000001', 'Maria' FROM ids
UNION ALL
SELECT contact_b, '66000000-0000-4000-8000-00000000000b', acc_b, '5511966000002', 'Zoe' FROM ids;
INSERT INTO conversations(id, user_id, account_id, contact_id, channel)
SELECT conv_a, '66000000-0000-4000-8000-00000000000a'::uuid, acc_a, contact_a, 'qr' FROM ids
UNION ALL
SELECT conv_b, '66000000-0000-4000-8000-00000000000b', acc_b, contact_b, 'qr' FROM ids;

-- ---- CHECK lists ----------------------------------------------
INSERT INTO messages(conversation_id, sender_type, origin, content_type, content_text)
SELECT conv_a, 'bot', 'ai', 'text', 'Olá' FROM ids;
INSERT INTO conversation_events(account_id, conversation_id, event_type, payload)
SELECT acc_a, conv_a, e, '{}' FROM ids, unnest(ARRAY['ai_handoff', 'ai_paused', 'ai_resumed']) e;
DO $$ BEGIN
  INSERT INTO ai_reply_jobs(account_id, conversation_id, contact_id, status) SELECT acc_a, conv_a, contact_a, 'weird' FROM ids;
  RAISE EXCEPTION 'unknown job status accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;

-- ---- human reply pauses the AI (trigger) ----------------------
SELECT pg_temp.assert_true((SELECT ai_paused_until IS NULL FROM conversations WHERE id = (SELECT conv_a FROM ids)), 'AI bubble does not pause');
INSERT INTO messages(conversation_id, sender_type, content_type, content_text, created_at)
SELECT conv_a, 'customer', 'text', 'oi', now() FROM ids;
-- phone echo 5 s after the customer = WhatsApp Business greeting, not a person
INSERT INTO messages(conversation_id, sender_type, origin, content_type, content_text, created_at)
SELECT conv_a, 'agent', 'phone', 'text', 'Olá! Já respondemos', now() + interval '5 seconds' FROM ids;
SELECT pg_temp.assert_true((SELECT ai_paused_until IS NULL FROM conversations WHERE id = (SELECT conv_a FROM ids)), 'instant phone echo does not pause');
INSERT INTO messages(conversation_id, sender_type, sender_id, content_type, content_text)
SELECT conv_a, 'agent', '66000000-0000-4000-8000-00000000000d', 'text', 'Oi, sou a Ana' FROM ids;
SELECT pg_temp.assert_true((SELECT ai_paused_until BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes' FROM conversations WHERE id = (SELECT conv_a FROM ids)), 'human reply pauses 30 min');
UPDATE conversations SET ai_paused_until = 'infinity' WHERE id = (SELECT conv_a FROM ids);
INSERT INTO messages(conversation_id, sender_type, sender_id, content_type, content_text)
SELECT conv_a, 'agent', '66000000-0000-4000-8000-00000000000d', 'text', 'de novo' FROM ids;
SELECT pg_temp.assert_true((SELECT ai_paused_until = 'infinity' FROM conversations WHERE id = (SELECT conv_a FROM ids)), 'human reply never shortens a hand-over pause');
UPDATE conversations SET ai_paused_until = NULL;

-- ---- AI / bot replies count as answered (SLA, inactivity) ------
UPDATE conversations SET last_agent_message_at = NULL WHERE id = (SELECT conv_a FROM ids);
INSERT INTO messages(conversation_id, sender_type, origin, content_type, content_text)
SELECT conv_a, 'bot', 'ai', 'text', 'Respondido pela IA' FROM ids;
SELECT pg_temp.assert_true((SELECT last_agent_message_at IS NOT NULL FROM conversations WHERE id = (SELECT conv_a FROM ids)), 'AI reply updates last_agent_message_at');

-- ---- a person claiming pauses the AI; round-robin does not -------
UPDATE conversations SET assigned_agent_id = '66000000-0000-4000-8000-00000000000d', ai_paused_until = NULL WHERE id = (SELECT conv_a FROM ids);
SELECT pg_temp.assert_true((SELECT ai_paused_until IS NULL FROM conversations WHERE id = (SELECT conv_a FROM ids)), 'service-role assign (round-robin) does not pause');
UPDATE conversations SET assigned_agent_id = NULL WHERE id = (SELECT conv_a FROM ids);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '66000000-0000-4000-8000-00000000000d', true);
UPDATE conversations SET assigned_agent_id = '66000000-0000-4000-8000-00000000000d' WHERE id = (SELECT conv_a FROM ids);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT ai_paused_until BETWEEN now() + interval '29 minutes' AND now() + interval '31 minutes' FROM conversations WHERE id = (SELECT conv_a FROM ids)), 'Assumir pauses the AI 30 min');
UPDATE conversations SET ai_paused_until = NULL, assigned_agent_id = NULL;

-- ---- enqueue: debounce + attach -------------------------------
SELECT ai_reply_enqueue(acc_a, conv_a, contact_a, NULL, ARRAY[msg_1], 8) FROM ids;
CREATE TEMP TABLE first_job AS SELECT id, run_after FROM ai_reply_jobs WHERE status = 'queued';
SELECT ai_reply_enqueue(acc_a, conv_a, contact_a, NULL, ARRAY[msg_2], 8) FROM ids;
SELECT ai_reply_enqueue(acc_a, conv_a, contact_a, NULL, ARRAY[msg_2, msg_1], 8) FROM ids;
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM ai_reply_jobs), 'one queued job per conversation');
SELECT pg_temp.assert_true(
  (SELECT j.inbound_message_ids = ARRAY[i.msg_1, i.msg_2] AND j.run_after = f.run_after
     FROM ai_reply_jobs j, ids i, first_job f),
  'later messages attach once, in order; run_after anchored to the first');
SELECT pg_temp.assert_true((SELECT run_after > now() FROM ai_reply_jobs), 'not due yet');

-- ---- claim ----------------------------------------------------
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM ai_reply_claim(10)), 'nothing due');
UPDATE ai_reply_jobs SET run_after = now() - interval '1 second';
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND min(attempts) = 1 AND min(status) = 'running' FROM ai_reply_claim(10)), 'claims due job');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM ai_reply_claim(10)), 'no double claim');
-- a message while running opens a NEW queued job, not claimable while the other runs
SELECT ai_reply_enqueue(acc_a, conv_a, contact_a, NULL, ARRAY[msg_3], 0) FROM ids;
UPDATE ai_reply_jobs SET run_after = now() - interval '1 second' WHERE status = 'queued';
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM ai_reply_jobs), 'second job queued while first runs');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM ai_reply_claim(10)), 'same conversation never runs twice');

-- ---- reaper ---------------------------------------------------
SET session_replication_role = replica; -- backdate without the updated_at trigger
UPDATE ai_reply_jobs SET updated_at = now() - interval '3 minutes' WHERE status = 'running';
SET session_replication_role = origin;
-- stale running + a queued sibling → its messages merge into the queued one, which is claimed
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(inbound_message_ids @> ARRAY[i.msg_1, i.msg_2, i.msg_3]) FROM ai_reply_claim(10), ids i), 'reaped: merged into the queued job, then claimed');
SELECT pg_temp.assert_true((SELECT status = 'skipped' AND skip_reason = 'merged' FROM ai_reply_jobs WHERE id = (SELECT id FROM first_job)), 'stale job merged');
-- stale alone → back to the queue (attempts keep counting; the runtime gives up past 3)
SET session_replication_role = replica;
UPDATE ai_reply_jobs SET updated_at = now() - interval '3 minutes', attempts = 3 WHERE status = 'running';
SET session_replication_role = origin;
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND min(attempts) = 4 FROM ai_reply_claim(10)), 'stale job requeued and reclaimed (attempts 4 → runtime hands over)');

-- ---- D3: enqueue vs a job that already has a generated reply --------
DELETE FROM ai_reply_jobs;
INSERT INTO ai_reply_jobs(account_id, conversation_id, contact_id, status, inbound_message_ids, reply_parts, reply_message_ids, sent_parts)
SELECT acc_a, conv_a, contact_a, 'queued', ARRAY[msg_1], ARRAY['a', 'b'], ARRAY[msg_1], 0 FROM ids;
SELECT ai_reply_enqueue(acc_a, conv_a, contact_a, NULL, ARRAY[msg_2], 8) FROM ids;
SELECT pg_temp.assert_true((SELECT reply_parts IS NULL AND reply_message_ids IS NULL AND cardinality(inbound_message_ids) = 2 FROM ai_reply_jobs), 'nothing sent yet: reply discarded, regenerated with the new message');
UPDATE ai_reply_jobs SET reply_parts = ARRAY['a', 'b'], reply_message_ids = ARRAY[(SELECT msg_1 FROM ids)], sent_parts = 1, inbound_message_ids = ARRAY[(SELECT msg_1 FROM ids)];
SELECT ai_reply_enqueue(acc_a, conv_a, contact_a, NULL, ARRAY[msg_2], 8) FROM ids;
SELECT pg_temp.assert_true((SELECT reply_parts = ARRAY['a', 'b'] AND reply_message_ids = ARRAY[i.msg_1] AND inbound_message_ids = ARRAY[i.msg_1, i.msg_2] FROM ai_reply_jobs, ids i), 'bubbles already out: the reply in flight is kept, new id attached for a follow-up job');

-- reaper: stale job with bubbles out + a queued sibling → the stale job resumes, sibling merged into it
DELETE FROM ai_reply_jobs;
INSERT INTO ai_reply_jobs(id, account_id, conversation_id, contact_id, status, inbound_message_ids, reply_parts, reply_message_ids, sent_parts, attempts)
SELECT '66000000-0000-4000-8000-0000000000a1', acc_a, conv_a, contact_a, 'running', ARRAY[msg_1], ARRAY['a', 'b'], ARRAY[msg_1], 1, 1 FROM ids;
INSERT INTO ai_reply_jobs(id, account_id, conversation_id, contact_id, status, inbound_message_ids, run_after)
SELECT '66000000-0000-4000-8000-0000000000a2', acc_a, conv_a, contact_a, 'queued', ARRAY[msg_2], now() - interval '1 second' FROM ids;
SET session_replication_role = replica;
UPDATE ai_reply_jobs SET updated_at = now() - interval '3 minutes' WHERE status = 'running';
SET session_replication_role = origin;
SELECT pg_temp.assert_true((SELECT count(*) = 1 AND bool_and(id = '66000000-0000-4000-8000-0000000000a1' AND reply_parts = ARRAY['a', 'b'] AND sent_parts = 1 AND inbound_message_ids = ARRAY[i.msg_1, i.msg_2] AND reply_message_ids = ARRAY[i.msg_1]) FROM ai_reply_claim(10), ids i), 'stale job with bubbles out resumes; queued sibling merged into it');
SELECT pg_temp.assert_true((SELECT skip_reason = 'merged' FROM ai_reply_jobs WHERE id = '66000000-0000-4000-8000-0000000000a2'), 'sibling marked merged');
DELETE FROM ai_reply_jobs;

-- ---- account B data for RLS -----------------------------------
SELECT ai_reply_enqueue(acc_b, conv_b, contact_b, NULL, ARRAY[msg_1], 8) FROM ids;
SELECT ai_reply_enqueue(acc_a, conv_a, contact_a, NULL, ARRAY[msg_1], 8) FROM ids;
INSERT INTO ai_handoffs(account_id, conversation_id, contact_id, reason)
SELECT acc_a, conv_a, contact_a, 'pediu atendente' FROM ids
UNION ALL SELECT acc_b, conv_b, contact_b, 'b' FROM ids;
INSERT INTO ai_knowledge_items(account_id, kind, title, content) SELECT acc_a, 'text', 'Horário', 'Abrimos às oito horas da manhã' FROM ids;
INSERT INTO ai_knowledge_chunks(item_id, account_id, chunk_index, content)
SELECT id, account_id, 0, content FROM ai_knowledge_items;

-- service role: KB search strictly per account
SET LOCAL ROLE service_role;
SELECT pg_temp.assert_true((SELECT count(*) >= 1 FROM ai_knowledge_search_service((SELECT acc_a FROM ids), 'que horas abrem manhã', 5)), 'service search finds account A');
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM ai_knowledge_search_service((SELECT acc_b FROM ids), 'que horas abrem manhã', 5)), 'service search never crosses accounts');
RESET ROLE;

-- agent of A
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '66000000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_true((SELECT count(*) >= 1 AND bool_and(account_id = (SELECT acc_a FROM ids)) FROM ai_reply_jobs), 'agent reads own jobs only');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM ai_handoffs), 'agent reads own handoffs only');
SELECT pg_temp.assert_true((SELECT count(*) >= 1 FROM ai_knowledge_search((SELECT acc_a FROM ids), 'que horas abrem manhã', 5)), 'agent search still works (063 contract)');
DO $$ BEGIN
  INSERT INTO ai_reply_jobs(account_id, conversation_id, contact_id) SELECT acc_a, conv_a, contact_a FROM ids;
  RAISE EXCEPTION 'authenticated inserted a job';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM ai_reply_claim(1);
  RAISE EXCEPTION 'authenticated claimed jobs';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM ai_knowledge_search_service((SELECT acc_b FROM ids), 'x', 1);
  RAISE EXCEPTION 'authenticated called the service search';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM ai_reply_enqueue((SELECT acc_a FROM ids), (SELECT conv_a FROM ids), (SELECT contact_a FROM ids), NULL, ARRAY[]::uuid[], 8);
  RAISE EXCEPTION 'authenticated enqueued';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

-- viewer of A: hand-over card yes, job log no
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '66000000-0000-4000-8000-00000000000e', true);
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM ai_reply_jobs), 'viewer reads no jobs');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM ai_handoffs), 'viewer reads the hand-over card');
RESET ROLE;

SELECT 'ai_auto_reply smoke: OK' AS result;
ROLLBACK;
