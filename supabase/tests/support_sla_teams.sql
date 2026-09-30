-- ============================================================
-- Migrations 072 (SLA) and 073 (teams, routing) — behaviour + RLS smoke.
--
-- Nothing is committed (ends in ROLLBACK). The local DB is migrated
-- through 071: apply 072-073 in the same transaction:
--   (echo "BEGIN;"; cat supabase/migrations/07[23]_*.sql supabase/tests/support_sla_teams.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual bigint, expected bigint, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
CREATE FUNCTION pg_temp.assert_ts(actual timestamptz, expected timestamptz, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
-- |actual - expected| <= 2 s (clock_timestamp drift inside a transaction).
CREATE FUNCTION pg_temp.assert_near(actual timestamptz, expected timestamptz, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS NULL OR abs(extract(epoch FROM actual - expected)) > 2 THEN RAISE EXCEPTION 'FAIL: % (got %, want ~%)', label, actual, expected; END IF; END $$;
CREATE FUNCTION pg_temp.assert_fails(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN RETURN;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;

-- ---- business-hours math (same fixtures as sla-time.test.ts) --------
CREATE FUNCTION pg_temp.bh(from_ts text, mins int, hours jsonb) RETURNS timestamptz LANGUAGE sql AS $$
  SELECT public.sla_add_business_minutes(from_ts::timestamptz, mins, hours) $$;
CREATE TEMP TABLE hrs AS SELECT
  '{"timezone":"America/Sao_Paulo","days":{"mon":[{"start":"09:00","end":"18:00"}],"tue":[{"start":"09:00","end":"18:00"}],"wed":[{"start":"09:00","end":"18:00"}],"thu":[{"start":"09:00","end":"18:00"}],"fri":[{"start":"09:00","end":"18:00"}],"sat":[],"sun":[]}}'::jsonb AS weekdays,
  '{"timezone":"UTC","days":{"mon":[{"start":"22:00","end":"06:00"}],"tue":[],"wed":[],"thu":[],"fri":[],"sat":[],"sun":[]}}'::jsonb AS overnight,
  '{"timezone":"America/New_York","days":{"sun":[{"start":"00:00","end":"04:00"}],"mon":[],"tue":[],"wed":[],"thu":[],"fri":[],"sat":[]}}'::jsonb AS dst,
  '{"timezone":"UTC","days":{"mon":[],"tue":[],"wed":[],"thu":[],"fri":[],"sat":[],"sun":[]}}'::jsonb AS closed_all,
  '{"timezone":"Not/AZone","days":{"mon":[{"start":"09:00","end":"18:00"}]}}'::jsonb AS bad_tz;
-- Mon 2026-03-02 10:00 -03 + 60 min = 11:00 -03
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-02T13:00:00Z', 60, (SELECT weekdays FROM hrs)), '2026-03-02T14:00:00Z', 'same-day');
-- Fri 17:30 -03 + 60 min: 30 today, 30 Monday -> Mon 09:30 -03
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-06T20:30:00Z', 60, (SELECT weekdays FROM hrs)), '2026-03-09T12:30:00Z', 'over the weekend');
-- Sat 12:00 -03 + 30 min -> Mon 09:30 -03
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-07T15:00:00Z', 30, (SELECT weekdays FROM hrs)), '2026-03-09T12:30:00Z', 'starts on a closed day');
-- Mon 09:00 -03 + 540 min lands exactly on the closing time.
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-02T12:00:00Z', 540, (SELECT weekdays FROM hrs)), '2026-03-02T21:00:00Z', 'exactly the whole day');
-- Mon 07:00 -03 (before opening) + 15 -> 09:15
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-02T10:00:00Z', 15, (SELECT weekdays FROM hrs)), '2026-03-02T12:15:00Z', 'before opening');
-- Overnight Monday 22:00-06:00 UTC: Mon 23:00 + 120 -> Tue 01:00.
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-02T23:00:00Z', 120, (SELECT overnight FROM hrs)), '2026-03-03T01:00:00Z', 'overnight range');
-- Tue 05:00 is still inside Monday's range (1 h left), then next Monday 22:00 + 1 h.
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-03T05:00:00Z', 120, (SELECT overnight FROM hrs)), '2026-03-09T23:00:00Z', 'overnight tail then next week');
-- DST (US spring forward, Sun 2026-03-08 02:00 -> 03:00): the 00:00-04:00 window holds 180 real minutes.
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-08T05:00:00Z', 180, (SELECT dst FROM hrs)), '2026-03-08T08:00:00Z', 'DST: window is 3 real hours');
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-08T05:00:00Z', 181, (SELECT dst FROM hrs)), '2026-03-15T04:01:00Z', 'DST: one minute spills to next Sunday');
-- No open range at all, malformed timezone: plain elapsed minutes.
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-02T13:00:00Z', 90, (SELECT closed_all FROM hrs)), '2026-03-02T14:30:00Z', 'never open = elapsed');
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-02T13:00:00Z', 90, (SELECT bad_tz FROM hrs)), '2026-03-02T14:30:00Z', 'bad timezone = elapsed');
SELECT pg_temp.assert_ts(pg_temp.bh('2026-03-02T13:00:00Z', 0, (SELECT weekdays FROM hrs)), '2026-03-02T13:00:00Z', 'zero minutes');

-- sla_target: 80% warning and the restart of a deadline already behind us.
SELECT pg_temp.assert_true((SELECT due_at = '2026-03-02T14:00:00Z' AND warn_at = '2026-03-02T13:48:00Z'
  FROM public.sla_target('2026-03-02T13:00:00Z', 60, (SELECT weekdays FROM hrs), '2026-03-02T13:00:00Z')), 'target + 80% warning (business hours)');
SELECT pg_temp.assert_true((SELECT due_at = '2026-03-02T15:30:00Z' AND warn_at = '2026-03-02T15:24:00Z'
  FROM public.sla_target('2026-03-02T13:00:00Z', 30, NULL, '2026-03-02T15:00:00Z')), 'past deadline restarts from now');
SELECT pg_temp.assert_true((SELECT warn_at IS NULL FROM public.sla_target('2026-03-02T13:00:00Z', 1, NULL, '2026-03-02T13:00:00Z')), '1 minute: no separate warning');

-- ---- tenants ----------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('72000000-0000-4000-8000-00000000000a', 'owner-a@sla.test', '{"full_name":"Owner A"}'),
 ('72000000-0000-4000-8000-00000000000b', 'owner-b@sla.test', '{"full_name":"Owner B"}'),
 ('72000000-0000-4000-8000-00000000000d', 'agent-a@sla.test', '{"full_name":"Agent A"}'),
 ('72000000-0000-4000-8000-00000000000e', 'agent-a2@sla.test', '{"full_name":"Agent A2"}');

CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '72000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '72000000-0000-4000-8000-00000000000b') AS acc_b,
       '72000000-0000-4000-8000-0000000000c1'::uuid AS cat_a,
       '72000000-0000-4000-8000-0000000000c3'::uuid AS cat_b,
       '72000000-0000-4000-8000-0000000000e1'::uuid AS team_a,
       '72000000-0000-4000-8000-0000000000e2'::uuid AS team_a2,
       '72000000-0000-4000-8000-0000000000e3'::uuid AS team_b,
       '72000000-0000-4000-8000-0000000000f1'::uuid AS conv_1,
       '72000000-0000-4000-8000-0000000000f2'::uuid AS conv_2,
       '72000000-0000-4000-8000-0000000000f3'::uuid AS conv_3,
       '72000000-0000-4000-8000-0000000000f4'::uuid AS conv_b,
       '72000000-0000-4000-8000-0000000000f5'::uuid AS conv_4;
GRANT SELECT ON ids TO anon, authenticated, service_role;

UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id IN ('72000000-0000-4000-8000-00000000000d', '72000000-0000-4000-8000-00000000000e');
-- Count every minute in tenant A for the stamping assertions below.
UPDATE accounts SET preferences = jsonb_build_object('sla_count_only_business_hours', false) WHERE id = (SELECT acc_a FROM ids);

INSERT INTO contacts(id, user_id, account_id, phone, name) VALUES
 ('72000000-0000-4000-8000-0000000000d1', '72000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511972000001', 'Ana'),
 ('72000000-0000-4000-8000-0000000000d2', '72000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511972000002', 'Bruno'),
 ('72000000-0000-4000-8000-0000000000d3', '72000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511972000003', 'Carla'),
 ('72000000-0000-4000-8000-0000000000d4', '72000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '5511972000004', 'Outro'),
 ('72000000-0000-4000-8000-0000000000d5', '72000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '5511972000005', 'Dora');

INSERT INTO conversation_categories(id, account_id, name) VALUES
 ((SELECT cat_a FROM ids), (SELECT acc_a FROM ids), 'Cobrança'),
 ((SELECT cat_b FROM ids), (SELECT acc_b FROM ids), 'Cobrança');

-- ---- no policy rows: nothing is stamped ---------------------------------
INSERT INTO conversations(id, user_id, account_id, contact_id, status, last_customer_message_at) VALUES
 ((SELECT conv_1 FROM ids), '72000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '72000000-0000-4000-8000-0000000000d1', 'open', now()),
 ((SELECT conv_b FROM ids), '72000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '72000000-0000-4000-8000-0000000000d4', 'open', now());
SELECT pg_temp.assert_true((SELECT first_response_due_at IS NULL AND resolution_due_at IS NULL AND sla_breached_at IS NULL FROM conversations WHERE id = (SELECT conv_1 FROM ids)), 'no policy: columns stay NULL');
UPDATE conversations SET priority = 'urgent' WHERE id = (SELECT conv_1 FROM ids);
SELECT pg_temp.assert_true((SELECT first_response_due_at IS NULL AND resolution_due_at IS NULL FROM conversations WHERE id = (SELECT conv_1 FROM ids)), 'no policy: a priority change stamps nothing');

-- ---- sla_policies: RLS + CHECKs -------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-00000000000a', true);
INSERT INTO sla_policies(account_id, priority, first_response_minutes, resolution_minutes) VALUES
 ((SELECT acc_a FROM ids), 'urgent', 30, 120),
 ((SELECT acc_a FROM ids), 'normal', 60, 480),
 ((SELECT acc_a FROM ids), 'high', NULL, 240);
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-00000000000b', true);
INSERT INTO sla_policies(account_id, priority, first_response_minutes) VALUES ((SELECT acc_b FROM ids), 'normal', 10);
SELECT pg_temp.assert_eq((SELECT count(*) FROM sla_policies), 1, 'tenant B sees only its own policies');
SELECT pg_temp.assert_fails(format('INSERT INTO sla_policies(account_id, priority, first_response_minutes) VALUES (%L, %L, 5)', (SELECT acc_a FROM ids), 'low'), 'tenant B cannot write into A');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM sla_policies), 3, 'agent reads A policies');
SELECT pg_temp.assert_fails(format('INSERT INTO sla_policies(account_id, priority, first_response_minutes) VALUES (%L, %L, 5)', (SELECT acc_a FROM ids), 'low'), 'agent cannot insert a policy');
UPDATE sla_policies SET first_response_minutes = 1 WHERE account_id = (SELECT acc_a FROM ids) AND priority = 'urgent';
SELECT pg_temp.assert_eq((SELECT first_response_minutes FROM sla_policies WHERE account_id = (SELECT acc_a FROM ids) AND priority = 'urgent'), 30, 'agent cannot update a policy (0 rows by RLS)');
RESET ROLE;
SELECT pg_temp.assert_fails(format('INSERT INTO sla_policies(account_id, priority, first_response_minutes) VALUES (%L, %L, 5)', (SELECT acc_a FROM ids), 'urgent'), 'one policy per account + priority');
SELECT pg_temp.assert_fails(format('INSERT INTO sla_policies(account_id, priority, first_response_minutes) VALUES (%L, %L, 5)', (SELECT acc_a FROM ids), 'critical'), 'priority CHECK');
SELECT pg_temp.assert_fails(format('INSERT INTO sla_policies(account_id, priority) VALUES (%L, %L)', (SELECT acc_a FROM ids), 'low'), 'at least one target');
SELECT pg_temp.assert_fails(format('INSERT INTO sla_policies(account_id, priority, first_response_minutes) VALUES (%L, %L, 0)', (SELECT acc_a FROM ids), 'low'), 'first response >= 1');
SELECT pg_temp.assert_fails(format('INSERT INTO sla_policies(account_id, priority, resolution_minutes) VALUES (%L, %L, 129601)', (SELECT acc_a FROM ids), 'low'), 'resolution <= 90 days');

-- ---- stamping on insert / priority change / reopen -------------------------
INSERT INTO conversations(id, user_id, account_id, contact_id, status, priority, last_customer_message_at) VALUES
 ((SELECT conv_2 FROM ids), '72000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '72000000-0000-4000-8000-0000000000d2', 'open', 'normal', now());
SELECT pg_temp.assert_near((SELECT first_response_due_at FROM conversations WHERE id = (SELECT conv_2 FROM ids)), now() + interval '60 minutes', 'insert: first response due = created + 60');
SELECT pg_temp.assert_near((SELECT first_response_warn_at FROM conversations WHERE id = (SELECT conv_2 FROM ids)), now() + interval '48 minutes', 'insert: warning at 80%');
SELECT pg_temp.assert_near((SELECT resolution_due_at FROM conversations WHERE id = (SELECT conv_2 FROM ids)), now() + interval '480 minutes', 'insert: resolution due = created + 480');
-- Tenant B has a policy for normal only with no resolution target.
INSERT INTO conversations(id, user_id, account_id, contact_id, status, last_customer_message_at) VALUES
 ('72000000-0000-4000-8000-0000000000f9', '72000000-0000-4000-8000-00000000000b', (SELECT acc_b FROM ids), '72000000-0000-4000-8000-0000000000d4', 'closed', now());
SELECT pg_temp.assert_true((SELECT resolution_due_at IS NULL FROM conversations WHERE id = '72000000-0000-4000-8000-0000000000f9'), 'closed on insert: no resolution target');

-- Raising the priority keeps the original clock start (created_at) when the new deadline is still ahead.
UPDATE conversations SET priority = 'urgent' WHERE id = (SELECT conv_2 FROM ids);
SELECT pg_temp.assert_near((SELECT first_response_due_at FROM conversations WHERE id = (SELECT conv_2 FROM ids)), now() + interval '30 minutes', 'priority change: new target from created_at');
SELECT pg_temp.assert_near((SELECT resolution_due_at FROM conversations WHERE id = (SELECT conv_2 FROM ids)), now() + interval '120 minutes', 'priority change: resolution too');

-- Created long ago: the original deadline is behind us, so the clock restarts from the change (not back-dated).
INSERT INTO conversations(id, user_id, account_id, contact_id, status, created_at, last_customer_message_at) VALUES
 ((SELECT conv_3 FROM ids), '72000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '72000000-0000-4000-8000-0000000000d3', 'open', now() - interval '3 hours', now() - interval '3 hours');
UPDATE conversations SET priority = 'urgent' WHERE id = (SELECT conv_3 FROM ids);
SELECT pg_temp.assert_near((SELECT first_response_due_at FROM conversations WHERE id = (SELECT conv_3 FROM ids)), now() + interval '30 minutes', 'late raise restarts the clock at the change time');

-- A first response that already happened is history: priority changes leave it alone.
UPDATE conversations SET first_response_at = now() WHERE id = (SELECT conv_3 FROM ids);
UPDATE conversations SET priority = 'normal' WHERE id = (SELECT conv_3 FROM ids);
SELECT pg_temp.assert_near((SELECT first_response_due_at FROM conversations WHERE id = (SELECT conv_3 FROM ids)), now() + interval '30 minutes', 'responded: first_response_due_at untouched');
SELECT pg_temp.assert_near((SELECT resolution_due_at FROM conversations WHERE id = (SELECT conv_3 FROM ids)), now() + interval '300 minutes', 'responded: resolution still follows the priority (created 3 h ago)');

-- Closing keeps the resolution target (history); priority without a policy clears only pending targets.
UPDATE conversations SET status = 'closed' WHERE id = (SELECT conv_3 FROM ids);
SELECT pg_temp.assert_true((SELECT resolution_due_at IS NOT NULL FROM conversations WHERE id = (SELECT conv_3 FROM ids)), 'closed: resolution_due_at kept');
UPDATE conversations SET priority = 'low' WHERE id = (SELECT conv_3 FROM ids);
SELECT pg_temp.assert_true((SELECT resolution_due_at IS NOT NULL AND first_response_due_at IS NOT NULL FROM conversations WHERE id = (SELECT conv_3 FROM ids)), 'closed + responded: a priority without policy rewrites nothing');
UPDATE conversations SET priority = 'low' WHERE id = (SELECT conv_2 FROM ids);
SELECT pg_temp.assert_true((SELECT first_response_due_at IS NULL AND resolution_due_at IS NULL AND first_response_warn_at IS NULL FROM conversations WHERE id = (SELECT conv_2 FROM ids)), 'priority without policy clears pending targets');
-- A policy with only a resolution target leaves the first response empty.
UPDATE conversations SET priority = 'high' WHERE id = (SELECT conv_2 FROM ids);
SELECT pg_temp.assert_true((SELECT first_response_due_at IS NULL AND resolution_due_at IS NOT NULL FROM conversations WHERE id = (SELECT conv_2 FROM ids)), 'policy with one target');
-- Reopen: a fresh resolution window from now.
UPDATE conversations SET status = 'open', priority = 'normal' WHERE id = (SELECT conv_3 FROM ids);
SELECT pg_temp.assert_near((SELECT resolution_due_at FROM conversations WHERE id = (SELECT conv_3 FROM ids)), now() + interval '480 minutes', 'reopen restarts the resolution clock');

-- Business hours through the trigger: a far-future start, tenant A on business hours (Mon-Fri 09-18 -03 by default).
UPDATE accounts SET preferences = '{}'::jsonb WHERE id = (SELECT acc_a FROM ids);
INSERT INTO conversations(id, user_id, account_id, contact_id, status, priority, last_customer_message_at) VALUES
 ((SELECT conv_4 FROM ids), '72000000-0000-4000-8000-00000000000a', (SELECT acc_a FROM ids), '72000000-0000-4000-8000-0000000000d5', 'open', 'normal', now());
SELECT pg_temp.assert_ts((SELECT first_response_due_at FROM conversations WHERE id = (SELECT conv_4 FROM ids)),
  public.sla_add_business_minutes((SELECT created_at FROM conversations WHERE id = (SELECT conv_4 FROM ids)), 60,
    '{"timezone":"America/Sao_Paulo","days":{"mon":[{"start":"09:00","end":"18:00"}],"tue":[{"start":"09:00","end":"18:00"}],"wed":[{"start":"09:00","end":"18:00"}],"thu":[{"start":"09:00","end":"18:00"}],"fri":[{"start":"09:00","end":"18:00"}],"sat":[],"sun":[]}}'::jsonb),
  'default preferences: business hours Mon-Fri 09-18 America/Sao_Paulo');

-- ---- sla_tick: one warning, one breach, never a repeat ---------------------
UPDATE accounts SET preferences = jsonb_build_object('sla_count_only_business_hours', false) WHERE id = (SELECT acc_a FROM ids);
UPDATE conversations SET status = 'open', priority = 'normal' WHERE id = (SELECT conv_2 FROM ids);
UPDATE conversations SET first_response_at = NULL,
       first_response_warn_at = now() - interval '5 minutes', first_response_due_at = now() + interval '5 minutes',
       resolution_due_at = now() + interval '7 hours', resolution_warn_at = now() + interval '6 hours'
 WHERE id = (SELECT conv_2 FROM ids);
SELECT pg_temp.assert_eq((SELECT count(*) FROM sla_tick() WHERE conversation_id = (SELECT conv_2 FROM ids) AND stage = 'warning' AND kind = 'first_response'), 1, 'tick: one warning');
SELECT pg_temp.assert_eq((SELECT count(*) FROM sla_tick() WHERE conversation_id = (SELECT conv_2 FROM ids)), 0, 'tick: the warning is not repeated');
SELECT pg_temp.assert_true((SELECT sla_breached_at IS NULL FROM conversations WHERE id = (SELECT conv_2 FROM ids)), 'a warning does not stamp sla_breached_at');
UPDATE conversations SET first_response_due_at = now() - interval '1 minute' WHERE id = (SELECT conv_2 FROM ids);
SELECT pg_temp.assert_eq((SELECT count(*) FROM sla_tick() WHERE conversation_id = (SELECT conv_2 FROM ids) AND stage = 'breached' AND kind = 'first_response'), 1, 'tick: one breach');
SELECT pg_temp.assert_eq((SELECT count(*) FROM sla_tick() WHERE conversation_id = (SELECT conv_2 FROM ids)), 0, 'tick: the breach is not repeated');
SELECT pg_temp.assert_true((SELECT sla_breached_at IS NOT NULL FROM conversations WHERE id = (SELECT conv_2 FROM ids)), 'breach stamps sla_breached_at');
SELECT pg_temp.assert_eq((SELECT count(*) FROM conversation_events WHERE conversation_id = (SELECT conv_2 FROM ids) AND event_type IN ('sla_warning', 'sla_breached')), 2, 'exactly one warning + one breach event');
-- Resolution is its own kind.
UPDATE conversations SET resolution_due_at = now() - interval '1 minute', resolution_warn_at = now() - interval '2 hours' WHERE id = (SELECT conv_2 FROM ids);
SELECT pg_temp.assert_eq((SELECT count(*) FROM sla_tick() WHERE conversation_id = (SELECT conv_2 FROM ids) AND kind = 'resolution' AND stage = 'breached'), 1, 'tick: resolution breach is separate');
-- A response ends the first-response target; closed / archived / other tenants are not touched.
UPDATE conversations SET first_response_at = now(), status = 'closed' WHERE id = (SELECT conv_2 FROM ids);
UPDATE conversations SET first_response_due_at = now() - interval '1 hour', first_response_at = NULL WHERE id = (SELECT conv_1 FROM ids);
SELECT pg_temp.assert_eq((SELECT count(*) FROM sla_tick() WHERE conversation_id = (SELECT conv_2 FROM ids)), 0, 'closed conversations are skipped');
UPDATE conversations SET first_response_at = now() WHERE id = (SELECT conv_1 FROM ids);
SELECT pg_temp.assert_eq((SELECT count(*) FROM sla_tick() WHERE conversation_id = (SELECT conv_1 FROM ids)), 0, 'a responded conversation has no first-response breach');
-- Only service_role may call the tick.
SET ROLE authenticated;
SELECT pg_temp.assert_fails('SELECT * FROM public.sla_tick()', 'sla_tick is not callable by users');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.assert_fails('SELECT * FROM public.sla_tick()', 'sla_tick is not callable by anon');
RESET ROLE;

-- ---- conversation_events: every prior type + the new ones -------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assigned','unassigned','status_changed','label_added','label_removed','note_added','contact_opted_out','contact_opted_in','ai_handoff','ai_paused','ai_resumed','deal_stage_changed','category_changed','priority_changed','resolution_set','team_changed'] LOOP
    INSERT INTO conversation_events(account_id, conversation_id, event_type, payload)
    VALUES ((SELECT acc_a FROM ids), (SELECT conv_1 FROM ids), t, '{}'::jsonb);
  END LOOP;
END $$;
SELECT pg_temp.assert_fails(format('INSERT INTO conversation_events(account_id, conversation_id, event_type) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), (SELECT conv_1 FROM ids), 'not_a_real_event'), 'unknown event type rejected');

-- ---- teams: RLS, guards ---------------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-00000000000a', true);
INSERT INTO teams(id, account_id, name) VALUES
 ((SELECT team_a FROM ids), (SELECT acc_a FROM ids), 'Financeiro'),
 ((SELECT team_a2 FROM ids), (SELECT acc_a FROM ids), 'Suporte');
INSERT INTO team_members(team_id, user_id, account_id) VALUES
 ((SELECT team_a FROM ids), '72000000-0000-4000-8000-00000000000d', (SELECT acc_a FROM ids)),
 ((SELECT team_a FROM ids), '72000000-0000-4000-8000-00000000000e', (SELECT acc_a FROM ids));
INSERT INTO routing_rules(account_id, category_id, team_id, priority_min) VALUES ((SELECT acc_a FROM ids), (SELECT cat_a FROM ids), (SELECT team_a FROM ids), 'normal');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-00000000000b', true);
INSERT INTO teams(id, account_id, name) VALUES ((SELECT team_b FROM ids), (SELECT acc_b FROM ids), 'Financeiro');
SELECT pg_temp.assert_eq((SELECT count(*) FROM teams), 1, 'tenant B sees only its own teams');
SELECT pg_temp.assert_eq((SELECT count(*) FROM team_members), 0, 'tenant B sees no A team members');
SELECT pg_temp.assert_eq((SELECT count(*) FROM routing_rules), 0, 'tenant B sees no A routing rules');
SELECT pg_temp.assert_fails(format('INSERT INTO teams(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ids), 'Invasor'), 'tenant B cannot create a team in A');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM teams), 2, 'agent reads teams');
SELECT pg_temp.assert_eq((SELECT count(*) FROM team_members), 2, 'agent reads team members');
SELECT pg_temp.assert_eq((SELECT count(*) FROM routing_rules), 1, 'agent reads rules');
SELECT pg_temp.assert_fails(format('INSERT INTO teams(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ids), 'Nova'), 'agent cannot create a team');
SELECT pg_temp.assert_fails(format('INSERT INTO team_members(team_id, user_id, account_id) VALUES (%L, %L, %L)', (SELECT team_a2 FROM ids), '72000000-0000-4000-8000-00000000000d', (SELECT acc_a FROM ids)), 'agent cannot add members');
SELECT pg_temp.assert_fails(format('INSERT INTO routing_rules(account_id, category_id, team_id) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), (SELECT cat_a FROM ids), (SELECT team_a2 FROM ids)), 'agent cannot write rules');
RESET ROLE;
SELECT pg_temp.assert_fails(format('INSERT INTO teams(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ids), ' financeiro '), 'team name unique (case-insensitive, trimmed)');
SELECT pg_temp.assert_fails(format('INSERT INTO teams(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ids), repeat('x', 41)), 'team name > 40');
SELECT pg_temp.assert_fails(format('INSERT INTO teams(account_id, name) VALUES (%L, %L)', (SELECT acc_a FROM ids), '  '), 'blank team name');
-- Cross-account guards.
SELECT pg_temp.assert_fails(format('INSERT INTO team_members(team_id, user_id, account_id) VALUES (%L, %L, %L)', (SELECT team_a2 FROM ids), '72000000-0000-4000-8000-00000000000b', (SELECT acc_a FROM ids)), 'a member of another account cannot join a team');
SELECT pg_temp.assert_fails(format('INSERT INTO team_members(team_id, user_id, account_id) VALUES (%L, %L, %L)', (SELECT team_b FROM ids), '72000000-0000-4000-8000-00000000000d', (SELECT acc_a FROM ids)), 'team of another account');
SELECT pg_temp.assert_fails(format('INSERT INTO routing_rules(account_id, category_id, team_id) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), (SELECT cat_b FROM ids), (SELECT team_a2 FROM ids)), 'rule with a category of another account');
SELECT pg_temp.assert_fails(format('INSERT INTO routing_rules(account_id, category_id, team_id) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), (SELECT cat_a FROM ids), (SELECT team_b FROM ids)), 'rule with a team of another account');
SELECT pg_temp.assert_fails(format('INSERT INTO routing_rules(account_id, category_id, team_id) VALUES (%L, %L, %L)', (SELECT acc_a FROM ids), (SELECT cat_a FROM ids), (SELECT team_a2 FROM ids)), 'one rule per category');
SELECT pg_temp.assert_fails(format('UPDATE routing_rules SET priority_min = %L WHERE account_id = %L', 'critical', (SELECT acc_a FROM ids)), 'priority_min CHECK');
SELECT pg_temp.assert_fails(format('UPDATE conversations SET team_id = %L WHERE id = %L', (SELECT team_b FROM ids), (SELECT conv_1 FROM ids)), 'conversation cannot get a team of another account');

-- ---- provenance (assignment_source / team_source) ---------------------------------
-- Service role: no JWT subject (set_config is transaction-local, so clear it) -> 'auto'.
SELECT set_config('request.jwt.claim.sub', '', true);
UPDATE conversations SET assigned_agent_id = '72000000-0000-4000-8000-00000000000d', team_id = (SELECT team_a FROM ids) WHERE id = (SELECT conv_1 FROM ids);
SELECT pg_temp.assert_true((SELECT assignment_source = 'auto' AND team_source = 'auto' FROM conversations WHERE id = (SELECT conv_1 FROM ids)), 'server writes are auto');
-- Same value again: provenance unchanged.
UPDATE conversations SET assigned_agent_id = '72000000-0000-4000-8000-00000000000d' WHERE id = (SELECT conv_1 FROM ids);
SELECT pg_temp.assert_true((SELECT assignment_source = 'auto' FROM conversations WHERE id = (SELECT conv_1 FROM ids)), 'no-op write keeps provenance');
-- A signed-in user: manual.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-00000000000e', true);
UPDATE conversations SET assigned_agent_id = '72000000-0000-4000-8000-00000000000e' WHERE id = (SELECT conv_1 FROM ids);
UPDATE conversations SET team_id = (SELECT team_a2 FROM ids) WHERE id = (SELECT conv_1 FROM ids);
RESET ROLE;
SELECT pg_temp.assert_true((SELECT assignment_source = 'manual' AND team_source = 'manual' FROM conversations WHERE id = (SELECT conv_1 FROM ids)), 'a person claiming / choosing the team is manual');
-- An explicit value in the same UPDATE wins (server route for "transfer to team").
UPDATE conversations SET assigned_agent_id = '72000000-0000-4000-8000-00000000000d', assignment_source = 'manual' WHERE id = (SELECT conv_1 FROM ids);
SELECT pg_temp.assert_true((SELECT assignment_source = 'manual' FROM conversations WHERE id = (SELECT conv_1 FROM ids)), 'explicit provenance is kept');
UPDATE conversations SET assigned_agent_id = NULL WHERE id = (SELECT conv_1 FROM ids);
SELECT pg_temp.assert_true((SELECT assignment_source IS NULL FROM conversations WHERE id = (SELECT conv_1 FROM ids)), 'unassigning clears provenance');
-- Deleting a team detaches its conversations.
UPDATE conversations SET team_id = (SELECT team_a2 FROM ids) WHERE id = (SELECT conv_1 FROM ids);
DELETE FROM teams WHERE id = (SELECT team_a2 FROM ids);
SELECT pg_temp.assert_true((SELECT team_id IS NULL FROM conversations WHERE id = (SELECT conv_1 FROM ids)), 'ON DELETE SET NULL');

-- ---- automation RPC -------------------------------------------------------------------
SELECT pg_temp.assert_true(public.automation_set_conversation((SELECT acc_a FROM ids), (SELECT conv_1 FROM ids), (SELECT cat_a FROM ids), 'urgent', (SELECT team_a FROM ids), 1, NULL), 'automation_set_conversation writes');
SELECT pg_temp.assert_true((SELECT category_id = (SELECT cat_a FROM ids) AND priority = 'urgent' AND team_id = (SELECT team_a FROM ids) AND team_source = 'auto' FROM conversations WHERE id = (SELECT conv_1 FROM ids)), 'fields written by the RPC');
SELECT pg_temp.assert_true(NOT public.automation_set_conversation((SELECT acc_b FROM ids), (SELECT conv_1 FROM ids), NULL, 'low', NULL, 1, NULL), 'another account cannot reach the conversation');
SELECT pg_temp.assert_fails(format('SELECT public.automation_set_conversation(%L, %L, NULL, %L, NULL, 1, NULL)', (SELECT acc_a FROM ids), (SELECT conv_1 FROM ids), 'critical'), 'invalid priority rejected');
SET ROLE authenticated;
SELECT pg_temp.assert_fails(format('SELECT public.automation_set_conversation(%L, %L, NULL, %L, NULL, 1, NULL)', (SELECT acc_a FROM ids), (SELECT conv_1 FROM ids), 'low'), 'users cannot call the automation RPC');
RESET ROLE;

-- ---- inbox RPCs: new params, old calls --------------------------------------------------
UPDATE conversations SET status = 'open', first_response_at = NULL, first_response_due_at = now() - interval '1 hour', resolution_due_at = NULL, archived_at = NULL WHERE id = (SELECT conv_1 FROM ids);
UPDATE conversations SET status = 'open', first_response_due_at = NULL, resolution_due_at = now() + interval '1 day' WHERE id = (SELECT conv_2 FROM ids);
UPDATE conversations SET team_id = NULL, status = 'closed' WHERE id = (SELECT conv_3 FROM ids);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_true((SELECT count(*) >= 3 FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all')), 'old-style call (no new params) still works');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_sla_breached => true)), 1, 'SLA filter: only the overdue open one');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_team_id => (SELECT team_a FROM ids))), 1, 'team filter');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_team_id => (SELECT team_a FROM ids), p_sla_breached => true)), 1, 'team + SLA filters combine');
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_priority => 'low', p_sla_breached => true)), 0, 'SLA + priority intersect');
SELECT pg_temp.assert_eq((SELECT radar_sla_breached FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids))), 1, 'counts: Estourados chip');
SELECT pg_temp.assert_eq((SELECT radar_sla_breached FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids), p_sla_breached => true)), 1, 'counts: chip unaffected by its own filter');
SELECT pg_temp.assert_eq((SELECT all_count FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids), p_sla_breached => true)), 1, 'counts: tabs follow the SLA filter');
SELECT pg_temp.assert_eq((SELECT all_count FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids), p_team_id => (SELECT team_a FROM ids))), 1, 'counts: team filter');
SELECT pg_temp.assert_eq((SELECT all_count FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids))), (SELECT count(*) FROM conversations WHERE account_id = (SELECT acc_a FROM ids) AND status IN ('open','pending') AND archived_at IS NULL), 'counts: no filters = every live conversation');
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM public.inbox_conversation_page(p_account_id => (SELECT acc_a FROM ids), p_tab => 'all', p_sla_breached => true)), 0, 'other tenant: page empty');
SELECT pg_temp.assert_eq((SELECT radar_sla_breached FROM public.inbox_counts(p_account_id => (SELECT acc_a FROM ids))), 0, 'other tenant: counts zero');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.assert_fails(format('SELECT * FROM public.inbox_counts(p_account_id => %L)', (SELECT acc_a FROM ids)), 'anon cannot call inbox_counts');
RESET ROLE;

ROLLBACK;
\echo 'support_sla_teams.sql: all assertions passed'
