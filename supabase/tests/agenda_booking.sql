-- ============================================================
-- Migration 096 (Agenda inteligente): booking guarantees. Nothing is committed
-- (ends in ROLLBACK). Needs migrations 001..095 applied. 096 has its own
-- BEGIN/COMMIT, so strip those and run both in ONE transaction:
--   (echo 'BEGIN;'; sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' supabase/migrations/096_agenda_services.sql;
--    cat supabase/tests/agenda_booking.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- If 096 is already applied, run only: (echo 'BEGIN;'; cat supabase/tests/agenda_booking.sql) | psql ...
--
-- Access model under test (spec, "Regras de acesso"): the booking RPCs are
-- executable by service_role ONLY (the server authenticates the session first,
-- the AI calls them directly); users cannot call them. Any agent+ of the account
-- may reschedule / cancel any service appointment through RLS (reception desk);
-- viewers and other tenants may not; and no user can tamper with the block
-- columns, service_id, booking_source or idempotency_key.
-- Proves: (1) a second overlapping booking on the same professional fails
-- (RPC and a raw INSERT), buffers included; (2) cancelled time is free again;
-- (3) idempotency; (4) the professional's own events are busy time; (5) RLS
-- isolation between two accounts; (6) roles: agent cannot configure; (7)
-- read-only accounts cannot write; (8) service_role (the AI) can book;
-- (9) grants.
-- True parallelism (two sessions at once) cannot be shown inside one
-- transaction: it relies on the exclusion constraint + the FOR UPDATE on the
-- resource row; run two psql sessions by hand for that (see the spec).
-- ============================================================
\set ON_ERROR_STOP on

CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.assert_eq(actual numeric, expected numeric, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'FAIL: % (got %, want %)', label, actual, expected; END IF; END $$;
-- The statement must fail with exactly this SQLSTATE.
CREATE FUNCTION pg_temp.fails(stmt text, state text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = state THEN RETURN; END IF;
    RAISE EXCEPTION 'FAIL (wrong error % / %): %', SQLSTATE, SQLERRM, label;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;
CREATE FUNCTION pg_temp.ok(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL (refused: % / %): %', SQLSTATE, SQLERRM, label;
  END;
END $$;
CREATE FUNCTION pg_temp.rows(stmt text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN EXECUTE stmt; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---------- fixtures ----------
-- A owner | A2 agent of A | B owner (other account) | R owner of a read-only account
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('96000000-0000-4000-8000-0000000000a1', 'a1@agenda.test', '{"full_name":"A1"}'),
 ('96000000-0000-4000-8000-0000000000a2', 'a2@agenda.test', '{"full_name":"A2"}'),
 ('96000000-0000-4000-8000-0000000000a3', 'a3@agenda.test', '{"full_name":"A3"}'),
 ('96000000-0000-4000-8000-0000000000b1', 'b1@agenda.test', '{"full_name":"B1"}'),
 ('96000000-0000-4000-8000-0000000000c1', 'c1@agenda.test', '{"full_name":"C1"}');

CREATE TEMP TABLE t AS
SELECT l.label, l.uid::uuid AS uid, (SELECT account_id FROM profiles WHERE user_id = l.uid::uuid) AS acc,
       NULL::uuid AS contact, NULL::uuid AS svc, NULL::uuid AS res
  FROM (VALUES ('A1','96000000-0000-4000-8000-0000000000a1'), ('A2','96000000-0000-4000-8000-0000000000a2'), ('A3','96000000-0000-4000-8000-0000000000a3'),
               ('B1','96000000-0000-4000-8000-0000000000b1'), ('C1','96000000-0000-4000-8000-0000000000c1')) AS l(label, uid);
GRANT SELECT ON t TO authenticated, service_role;

-- A2 joins account A as an agent.
UPDATE profiles SET account_id = (SELECT acc FROM t WHERE label = 'A1'), account_role = 'agent'
 WHERE user_id = (SELECT uid FROM t WHERE label = 'A2');
UPDATE profiles SET account_id = (SELECT acc FROM t WHERE label = 'A1'), account_role = 'viewer'
 WHERE user_id = (SELECT uid FROM t WHERE label = 'A3');
UPDATE t SET acc = (SELECT acc FROM t WHERE label = 'A1') WHERE label IN ('A2', 'A3');
-- C1's account is read-only (trial ended).
UPDATE accounts SET plan_status = 'trial', plan_expires_at = now() - interval '1 day' WHERE id = (SELECT acc FROM t WHERE label = 'C1');

DO $$
DECLARE r record; v_contact uuid; v_svc uuid; v_res uuid;
BEGIN
  FOR r IN SELECT * FROM t WHERE label IN ('A1', 'B1', 'C1') LOOP
    INSERT INTO contacts(user_id, account_id, phone, name) VALUES (r.uid, r.acc, '+55119' || substr(r.uid::text, 36, 1) || '0000001', 'Cliente ' || r.label) RETURNING id INTO v_contact;
    INSERT INTO agenda_services(account_id, name, duration_minutes, buffer_after_minutes) VALUES (r.acc, 'Corte ' || r.label, 60, 15) RETURNING id INTO v_svc;
    INSERT INTO agenda_resources(account_id, name, user_id) VALUES (r.acc, 'Prof ' || r.label, r.uid) RETURNING id INTO v_res;
    INSERT INTO agenda_resource_services(resource_id, service_id, account_id) VALUES (v_res, v_svc, r.acc);
    INSERT INTO agenda_working_hours(account_id, resource_id, weekday, start_minute, end_minute) VALUES (r.acc, v_res, 1, 540, 1080);
    UPDATE t SET contact = v_contact, svc = v_svc, res = v_res WHERE label = r.label;
  END LOOP;
END $$;

-- Hours of one resource cannot overlap (exclusion on the weekday ranges).
SELECT pg_temp.fails(format('INSERT INTO agenda_working_hours(account_id, resource_id, weekday, start_minute, end_minute) VALUES (%L, %L, 1, 600, 700)',
  (SELECT acc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1')), '23P01', 'overlapping working hours rejected');
-- A resource cannot be linked to a member of another account.
SELECT pg_temp.fails(format('INSERT INTO agenda_resources(account_id, name, user_id) VALUES (%L, ''Intruso'', %L)',
  (SELECT acc FROM t WHERE label='A1'), (SELECT uid FROM t WHERE label='B1')), 'AG007', 'foreign member rejected');
-- Cross-account composite FK: a link between A's resource and B's service is impossible.
SELECT pg_temp.fails(format('INSERT INTO agenda_resource_services(resource_id, service_id, account_id) VALUES (%L, %L, %L)',
  (SELECT res FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='B1'), (SELECT acc FROM t WHERE label='A1')), '23503', 'cross-account link rejected');

-- ---------- booking as the server (service_role) for account A ----------
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE service_role;

-- 2030-01-07 is a Monday. First booking 13:00-14:00 UTC (block until 14:15).
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-07 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')),
  'first booking succeeds');
SELECT pg_temp.assert_eq((SELECT count(*) FROM calendar_events WHERE service_id IS NOT NULL), 1, 'one appointment stored');
SELECT pg_temp.assert_true((SELECT owner_user_id = (SELECT uid FROM t WHERE label='A1') AND status = 'scheduled' AND booking_source = 'agent'
                                   AND block_ends_at = ends_at + interval '15 minutes'
                              FROM calendar_events WHERE service_id IS NOT NULL),
  'appointment lands on the professional agenda with the buffer block');

-- The same slot again: refused. Exactly one wins.
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-07 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')),
  'AG001', 'second booking of the same slot is refused');
-- Partial overlap, and inside the 15-minute buffer of the first one.
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-07 13:30+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')),
  'AG001', 'partial overlap refused');
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-07 14:10+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')),
  'AG001', 'booking inside the buffer refused');
-- A raw INSERT (any code path) is stopped by the same constraint.
SELECT pg_temp.fails(format($q$INSERT INTO calendar_events(account_id, title, starts_at, ends_at, service_id, resource_id, status)
  VALUES (%L, 'x', '2030-01-07 13:15+00', '2030-01-07 14:15+00', %L, %L, 'confirmed')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1')),
  '23P01', 'raw INSERT overlapping is refused by the exclusion constraint');
-- Right after the buffer: fine.
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-07 14:15+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')),
  'booking right after the buffer succeeds');

-- Idempotency: same key twice = same appointment.
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-07 16:00+00', NULL, 'ai', NULL, 'key-12345678')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')), 'keyed booking');
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-07 16:00+00', NULL, 'ai', NULL, 'key-12345678')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')), 'keyed retry');
SELECT pg_temp.assert_eq((SELECT count(*) FROM calendar_events WHERE idempotency_key = 'key-12345678'), 1, 'idempotent: one row');

-- Cancel frees the slot; reopening a cancelled one conflicts if someone took it.
SELECT pg_temp.ok(format($q$SELECT agenda_set_appointment_status(%L, %L, 'cancelled')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 13:00+00' AND service_id IS NOT NULL)), 'cancel');
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-07 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')),
  'cancelled time is bookable again');
SELECT pg_temp.fails(format($q$SELECT agenda_set_appointment_status(%L, %L, 'confirmed')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE status = 'cancelled' AND service_id IS NOT NULL)),
  'AG001', 'reopening a cancelled appointment whose slot was retaken conflicts');

-- Reschedule onto a taken slot fails; onto a free one works.
SELECT pg_temp.fails(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-01-07 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 16:00+00')), 'AG001', 'reschedule onto a taken slot');
SELECT pg_temp.ok(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-01-07 17:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 16:00+00')), 'reschedule onto a free slot');
SELECT pg_temp.fails(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-01-07 19:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE status = 'cancelled' AND service_id IS NOT NULL)), 'AG006', 'cancelled cannot be rescheduled');

-- The professional's own event is busy time.
RESET ROLE;
INSERT INTO calendar_events(account_id, owner_user_id, title, starts_at, ends_at, status)
  VALUES ((SELECT acc FROM t WHERE label='A1'), (SELECT uid FROM t WHERE label='A1'), 'Dentista', '2030-01-07 20:00+00', '2030-01-07 21:00+00', 'confirmed');
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE service_role;
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-07 20:30+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')),
  'AG005', 'personal event blocks the booking');

-- Invalid combinations.
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-14 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='B1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')),
  'AG003', 'service of another account is unavailable');
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-14 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='B1')),
  'AG004', 'contact of another account rejected');

-- A p_actor that is not an agent+ of the account is refused.
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-14 13:00+00', NULL, 'ai', NULL, NULL, 'scheduled', %L)$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1'), (SELECT uid FROM t WHERE label='A3')),
  '42501', 'a viewer cannot be the actor of a booking');

-- ---------- users: no direct RPC; an agent manages appointments by RLS ----------
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'A2'), true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-14 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')),
  '42501', 'a signed-in user cannot call the booking RPC (no EXECUTE)');
SELECT pg_temp.fails(format($q$SELECT agenda_set_appointment_status(%L, %L, 'cancelled')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE service_id IS NOT NULL LIMIT 1)), '42501', 'nor the status RPC');
SELECT pg_temp.fails(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-01-14 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE service_id IS NOT NULL LIMIT 1)), '42501', 'nor the reschedule RPC');

-- Reserved columns: no user can mark / unmark an event as an appointment.
SELECT pg_temp.fails(format($q$INSERT INTO calendar_events(account_id, title, starts_at, ends_at, service_id) VALUES (%L, 'x', '2031-01-01 10:00+00', '2031-01-01 11:00+00', %L)$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1')), '42501', 'user cannot insert with service_id');
-- The row was booked with source 'agent'; writing the same value is a no-op the guard allows.
SELECT pg_temp.fails(format($q$UPDATE calendar_events SET booking_source = 'ai' WHERE id = %L$q$,
  (SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 14:15+00')), '42501', 'user cannot change booking_source');
SELECT pg_temp.fails(format($q$UPDATE calendar_events SET idempotency_key = 'hijack-123' WHERE id = %L$q$,
  (SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 14:15+00')), '42501', 'user cannot change idempotency_key');
SELECT pg_temp.fails(format($q$UPDATE calendar_events SET service_id = NULL WHERE id = %L$q$,
  (SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 14:15+00')), '42501', 'user cannot detach the service');

-- Tampering with block_* cannot dodge the exclusion: recomputed on every write.
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE calendar_events SET block_starts_at = '2040-01-01', block_ends_at = '2040-01-02' WHERE id = %L$q$,
  (SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 14:15+00'))), 1, 'agent may write the row (any agent+ manages appointments)');
SELECT pg_temp.assert_true((SELECT block_starts_at = starts_at AND block_ends_at = ends_at + interval '15 minutes'
                              FROM calendar_events WHERE starts_at = '2030-01-07 14:15+00'), 'block_* were recomputed, not taken from the client');
SELECT pg_temp.fails(format($q$UPDATE calendar_events SET block_starts_at = '2040-01-01', block_ends_at = '2040-01-02',
    starts_at = '2030-01-07 13:00+00', ends_at = '2030-01-07 14:00+00' WHERE id = %L$q$,
  (SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 14:15+00')), '23P01', 'moving onto a taken slot with forged block_* still fails');
SELECT pg_temp.fails(format($q$INSERT INTO calendar_events(account_id, title, starts_at, ends_at, resource_id, status, block_starts_at, block_ends_at)
  VALUES (%L, 'x', '2030-01-07 13:10+00', '2030-01-07 13:40+00', %L, 'confirmed', '2040-01-01', '2040-01-02')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1')), '23P01', 'INSERT with forged block_* still fails');

-- Reception desk rule (a): an agent that is neither owner nor creator cancels it.
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE calendar_events SET status = 'cancelled' WHERE id = %L$q$,
  (SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 17:00+00'))), 1, 'any agent+ cancels an appointment');
UPDATE calendar_events SET status = 'scheduled' WHERE starts_at = '2030-01-07 17:00+00';

-- A viewer reads but cannot change it.
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'A3'), true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_true((SELECT count(*) FROM calendar_events WHERE service_id IS NOT NULL) >= 1, 'viewer reads appointments');
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE calendar_events SET status = 'cancelled' WHERE id = %L$q$,
  (SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 17:00+00'))), 0, 'viewer cannot cancel an appointment');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'A2'), true);
SET LOCAL ROLE authenticated;

-- ---------- roles: an agent books but does not configure ----------
SELECT pg_temp.assert_true((SELECT count(*) FROM agenda_services) = 1, 'agent reads the services of their account only');
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE agenda_services SET name = 'Hack' WHERE id = %L$q$, (SELECT svc FROM t WHERE label='A1'))), 0, 'agent cannot edit a service');
SELECT pg_temp.fails(format($q$INSERT INTO agenda_services(account_id, name, duration_minutes) VALUES (%L, 'Novo', 30)$q$, (SELECT acc FROM t WHERE label='A1')),
  '42501', 'agent cannot create a service');

-- ---------- RLS isolation: account B ----------
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'B1'), true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_services), 1, 'B sees only its own service');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_resources), 1, 'B sees only its own resource');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_working_hours), 1, 'B sees only its own hours');
SELECT pg_temp.assert_eq((SELECT count(*) FROM calendar_events WHERE service_id IS NOT NULL), 0, 'B sees none of the appointments of A');
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$DELETE FROM agenda_resources WHERE id = %L$q$, (SELECT res FROM t WHERE label='A1'))), 0, 'B cannot delete A resource');
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-14 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')),
  '42501', 'B cannot call the booking RPC');
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE calendar_events SET status = 'cancelled' WHERE id = %L$q$,
  (SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 17:00+00'))), 0, 'B cannot touch A appointments');
-- B owner configures freely in its own account.
SELECT pg_temp.ok(format($q$INSERT INTO agenda_services(account_id, name, duration_minutes) VALUES (%L, 'Extra', 30)$q$, (SELECT acc FROM t WHERE label='B1')), 'owner creates a service');

-- ---------- read-only account ----------
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'C1'), true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_services), 1, 'read-only account still reads');
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-14 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='C1'), (SELECT svc FROM t WHERE label='C1'), (SELECT res FROM t WHERE label='C1'), (SELECT contact FROM t WHERE label='C1')),
  '42501', 'read-only user cannot book (no EXECUTE)');
SELECT pg_temp.fails(format($q$INSERT INTO agenda_services(account_id, name, duration_minutes) VALUES (%L, 'Novo', 30)$q$, (SELECT acc FROM t WHERE label='C1')),
  '42501', 'read-only account cannot configure');

-- ---------- service_role (the AI on WhatsApp, delivery C) ----------
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE service_role;
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-14 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='C1'), (SELECT svc FROM t WHERE label='C1'), (SELECT res FROM t WHERE label='C1'), (SELECT contact FROM t WHERE label='C1')),
  '42501', 'the server path refuses a read-only account too (private.account_is_writable)');
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-14 13:00+00', NULL, 'ai', 'via WhatsApp', NULL, 'scheduled', %L)$q$,
  (SELECT acc FROM t WHERE label='B1'), (SELECT svc FROM t WHERE label='B1'), (SELECT res FROM t WHERE label='B1'), (SELECT contact FROM t WHERE label='B1'), (SELECT uid FROM t WHERE label='B1')),
  'service_role can book with source ai');
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-14 13:00+00', NULL, 'ai')$q$,
  (SELECT acc FROM t WHERE label='B1'), (SELECT svc FROM t WHERE label='B1'), (SELECT res FROM t WHERE label='B1'), (SELECT contact FROM t WHERE label='B1')),
  'AG001', 'service_role is held to the same exclusion');
RESET ROLE;
SELECT pg_temp.assert_eq((SELECT count(*) FROM calendar_events WHERE booking_source = 'ai'), 2, 'ai bookings recorded (keyed one + this one)');

-- ---------- grants ----------
SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.agenda_reschedule_appointment(uuid, uuid, timestamptz, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.agenda_set_appointment_status(uuid, uuid, text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid)', 'EXECUTE'),
  'RPC grants: service_role only');
SELECT pg_temp.assert_true(NOT has_table_privilege('anon', 'public.agenda_services', 'SELECT'), 'anon has no table access');

SELECT 'agenda_booking: ALL OK' AS result;
ROLLBACK;
