-- ============================================================
-- Migration 097 (Agenda inteligente, entrega B): lembretes por WhatsApp e encaixe.
-- Nothing is committed (ends in ROLLBACK). Needs migrations 001..096 applied. 097 has
-- its own BEGIN/COMMIT, so strip those and run both in ONE transaction:
--   (echo 'BEGIN;'; sed -e '/^BEGIN;$/d' -e '/^COMMIT;$/d' supabase/migrations/097_agenda_reminders.sql;
--    cat supabase/tests/agenda_reminders.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- If 097 is already applied, run only: (echo 'BEGIN;'; cat supabase/tests/agenda_reminders.sql) | psql ...
--
-- Proves: (1) the trigger plans one pending reminder per offset (24 h and 2 h) and the
-- due times are exact; an appointment made inside an offset only gets the later ones
-- (past offsets are 'skipped'/'past'); (2) reschedule cancels the old pending ones and plans
-- new ones, rescheduling back revives; cancel / completed cancel; reopen replans;
-- (3) the claim is atomic and idempotent (second claim gets nothing; stuck 'sending' is
-- parked as maybe_sent, never re-sent); (4) uniqueness (event, slot, start); (5) settings
-- changes replan; (6) customer response RPC: confirms through the status RPC, flags a
-- reschedule request, closes sibling reminders, refuses a second answer and read-only
-- accounts, and a reschedule clears the answer; (7) encaixe: only source 'agent' with an
-- actor, recorded in booking_override, for book and reschedule; (8) users cannot write
-- the new columns / tables; RLS; read-only accounts; (9) LGPD erasure cancels; (10) grants.
-- True parallelism (two sessions at once) cannot be shown inside one transaction: it relies
-- on FOR UPDATE SKIP LOCKED in agenda_reminders_claim; run two psql sessions by hand
-- (BEGIN; SELECT * FROM agenda_reminders_claim(now(), 1); in both: they get different rows).
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
-- A1 owner | A2 agent of A | A3 viewer of A | B1 other account | C1 read-only account
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('97000000-0000-4000-8000-0000000000a1', 'a1@rem.test', '{"full_name":"A1"}'),
 ('97000000-0000-4000-8000-0000000000a2', 'a2@rem.test', '{"full_name":"A2"}'),
 ('97000000-0000-4000-8000-0000000000a3', 'a3@rem.test', '{"full_name":"A3"}'),
 ('97000000-0000-4000-8000-0000000000b1', 'b1@rem.test', '{"full_name":"B1"}'),
 ('97000000-0000-4000-8000-0000000000c1', 'c1@rem.test', '{"full_name":"C1"}');

CREATE TEMP TABLE t AS
SELECT l.label, l.uid::uuid AS uid, (SELECT account_id FROM profiles WHERE user_id = l.uid::uuid) AS acc,
       NULL::uuid AS contact, NULL::uuid AS svc, NULL::uuid AS res
  FROM (VALUES ('A1','97000000-0000-4000-8000-0000000000a1'), ('A2','97000000-0000-4000-8000-0000000000a2'), ('A3','97000000-0000-4000-8000-0000000000a3'),
               ('B1','97000000-0000-4000-8000-0000000000b1'), ('C1','97000000-0000-4000-8000-0000000000c1')) AS l(label, uid);
GRANT SELECT ON t TO authenticated, service_role;

UPDATE profiles SET account_id = (SELECT acc FROM t WHERE label = 'A1'), account_role = 'agent'  WHERE user_id = (SELECT uid FROM t WHERE label = 'A2');
UPDATE profiles SET account_id = (SELECT acc FROM t WHERE label = 'A1'), account_role = 'viewer' WHERE user_id = (SELECT uid FROM t WHERE label = 'A3');
UPDATE t SET acc = (SELECT acc FROM t WHERE label = 'A1') WHERE label IN ('A2', 'A3');

DO $$
DECLARE r record; v_contact uuid; v_svc uuid; v_res uuid;
BEGIN
  FOR r IN SELECT * FROM t WHERE label IN ('A1', 'B1', 'C1') LOOP
    INSERT INTO contacts(user_id, account_id, phone, name) VALUES (r.uid, r.acc, '+55119' || substr(r.uid::text, 36, 1) || '0000001', 'Cliente ' || r.label) RETURNING id INTO v_contact;
    INSERT INTO agenda_services(account_id, name, duration_minutes) VALUES (r.acc, 'Corte ' || r.label, 60) RETURNING id INTO v_svc;
    INSERT INTO agenda_resources(account_id, name, user_id) VALUES (r.acc, 'Prof ' || r.label, r.uid) RETURNING id INTO v_res;
    INSERT INTO agenda_resource_services(resource_id, service_id, account_id) VALUES (v_res, v_svc, r.acc);
    UPDATE t SET contact = v_contact, svc = v_svc, res = v_res WHERE label = r.label;
  END LOOP;
END $$;

-- Reminders are on for A (defaults: 24 h and 2 h) and C. Inserted as postgres; the trigger replans nothing yet.
INSERT INTO agenda_reminder_settings(account_id, enabled) VALUES ((SELECT acc FROM t WHERE label='A1'), true);
INSERT INTO agenda_reminder_settings(account_id, enabled) VALUES ((SELECT acc FROM t WHERE label='C1'), true);
SELECT pg_temp.assert_true((SELECT first_offset_minutes = 1440 AND second_offset_minutes = 120 AND template_language = 'pt_BR' AND message_text IS NULL
                              FROM agenda_reminder_settings WHERE account_id = (SELECT acc FROM t WHERE label='A1')),
  'defaults: 24 h and 2 h, default text, pt_BR template language');
-- Settings validation.
SELECT pg_temp.fails(format($q$UPDATE agenda_reminder_settings SET first_offset_minutes = 120 WHERE account_id = %L$q$, (SELECT acc FROM t WHERE label='A1')), '23514', 'equal offsets rejected');
SELECT pg_temp.fails(format($q$UPDATE agenda_reminder_settings SET first_offset_minutes = 2 WHERE account_id = %L$q$, (SELECT acc FROM t WHERE label='A1')), '23514', 'offset below 5 minutes rejected');
SELECT pg_temp.fails(format($q$UPDATE agenda_reminder_settings SET message_text = repeat('x', 1001) WHERE account_id = %L$q$, (SELECT acc FROM t WHERE label='A1')), '23514', 'text over 1000 chars rejected');

-- ---------- (1) planning ----------
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE service_role;

-- Far future: both offsets pending, exact due times.
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-01-07 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')), 'book far-future appointment');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE state = 'pending'), 2, 'two pending reminders planned');
SELECT pg_temp.assert_true((SELECT bool_and(CASE slot WHEN 1 THEN due_at = '2030-01-06 13:00+00' AND offset_minutes = 1440
                                                      WHEN 2 THEN due_at = '2030-01-07 11:00+00' AND offset_minutes = 120 END
                                   AND for_starts_at = '2030-01-07 13:00+00' AND reason IS NULL AND attempts = 0)
                              FROM agenda_reminders),
  'due_at = start - offset, for_starts_at = the appointment start');

-- Booked inside the 24 h mark (5 h ahead): only the 2 h one is still ahead.
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, now() + interval '5 hours')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')), 'book 5 h ahead');
SELECT pg_temp.assert_true((SELECT state = 'skipped' AND reason = 'past' FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id WHERE r.slot = 1 AND e.starts_at < now() + interval '6 hours'),
  '24 h offset already in the past is skipped with reason past');
SELECT pg_temp.assert_true((SELECT state = 'pending' AND due_at > now() FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id WHERE r.slot = 2 AND e.starts_at < now() + interval '6 hours'),
  '2 h offset still ahead stays pending');

-- Booked 1 h ahead: both offsets passed, nothing will be sent.
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, now() + interval '90 minutes', NULL, 'agent', NULL, NULL, 'scheduled', NULL)$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')), 'book 90 min ahead');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id
                           WHERE e.starts_at < now() + interval '2 hours' AND r.state = 'skipped' AND r.reason = 'past'), 2, 'last-minute booking: both offsets skipped');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders), 6, 'six rows so far');

-- A reminder never exists twice for the same (event, slot, start).
RESET ROLE;
SELECT pg_temp.fails(format($q$INSERT INTO agenda_reminders(account_id, event_id, slot, offset_minutes, for_starts_at, due_at)
  SELECT account_id, event_id, slot, offset_minutes, for_starts_at, due_at FROM agenda_reminders WHERE id = %L$q$,
  (SELECT id FROM agenda_reminders LIMIT 1)), '23505', 'unique (event, slot, start): no duplicate reminder');

-- ---------- (2) reschedule / cancel / reopen ----------
CREATE TEMP TABLE ev AS SELECT id FROM calendar_events WHERE starts_at = '2030-01-07 13:00+00';
GRANT SELECT ON ev TO service_role, authenticated;
SET LOCAL ROLE service_role;
SELECT pg_temp.ok(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-01-14 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM ev)), 'reschedule the far-future appointment');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE event_id = (SELECT id FROM ev) AND state = 'cancelled' AND reason = 'rescheduled'), 2, 'old pending reminders cancelled (rescheduled)');
SELECT pg_temp.assert_true((SELECT count(*) = 2 AND bool_and(due_at IN ('2030-01-13 13:00+00', '2030-01-14 11:00+00'))
                              FROM agenda_reminders WHERE event_id = (SELECT id FROM ev) AND state = 'pending' AND for_starts_at = '2030-01-14 13:00+00'),
  'two new pending reminders for the new time');
-- Back to the original time: the cancelled rows of that time are revived, not duplicated.
SELECT pg_temp.ok(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-01-07 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM ev)), 'reschedule back');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE event_id = (SELECT id FROM ev)), 4, 'still four rows: revived, not duplicated');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE event_id = (SELECT id FROM ev) AND state = 'pending' AND for_starts_at = '2030-01-07 13:00+00'), 2, 'original time pending again');

-- Cancel cancels; reopening replans.
SELECT pg_temp.ok(format($q$SELECT agenda_set_appointment_status(%L, %L, 'cancelled')$q$, (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM ev)), 'cancel');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE event_id = (SELECT id FROM ev) AND state = 'pending'), 0, 'cancelled appointment has no pending reminder');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE event_id = (SELECT id FROM ev) AND reason = 'appointment_closed'), 2, 'reason appointment_closed');
SELECT pg_temp.ok(format($q$SELECT agenda_set_appointment_status(%L, %L, 'confirmed')$q$, (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM ev)), 'reopen');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE event_id = (SELECT id FROM ev) AND state = 'pending'), 2, 'reopened appointment gets its reminders back');
SELECT pg_temp.ok(format($q$SELECT agenda_set_appointment_status(%L, %L, 'no_show')$q$, (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM ev)), 'no-show');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE event_id = (SELECT id FROM ev) AND state = 'pending'), 0, 'no-show cancels pending reminders');
SELECT pg_temp.ok(format($q$SELECT agenda_set_appointment_status(%L, %L, 'scheduled')$q$, (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM ev)), 'reopen again');

-- ---------- (5) settings changes replan ----------
RESET ROLE;
UPDATE agenda_reminder_settings SET second_offset_minutes = NULL WHERE account_id = (SELECT acc FROM t WHERE label='A1');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE event_id = (SELECT id FROM ev) AND state = 'pending' AND slot = 2), 0, 'second offset switched off cancels its pending reminders');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE event_id = (SELECT id FROM ev) AND state = 'pending' AND slot = 1), 1, 'first offset untouched');
UPDATE agenda_reminder_settings SET second_offset_minutes = 60, first_offset_minutes = 2880 WHERE account_id = (SELECT acc FROM t WHERE label='A1');
SELECT pg_temp.assert_true((SELECT bool_and(CASE slot WHEN 1 THEN due_at = '2030-01-05 13:00+00' WHEN 2 THEN due_at = '2030-01-07 12:00+00' END)
                              FROM agenda_reminders WHERE event_id = (SELECT id FROM ev) AND state = 'pending'),
  'changed offsets move the pending due times');
UPDATE agenda_reminder_settings SET enabled = false WHERE account_id = (SELECT acc FROM t WHERE label='A1');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE account_id = (SELECT acc FROM t WHERE label='A1') AND state = 'pending'), 0, 'switching reminders off cancels every pending one');
UPDATE agenda_reminder_settings SET enabled = true, first_offset_minutes = 1440, second_offset_minutes = 120 WHERE account_id = (SELECT acc FROM t WHERE label='A1');
SELECT pg_temp.assert_true((SELECT count(*) FILTER (WHERE state = 'pending') >= 2 FROM agenda_reminders WHERE event_id = (SELECT id FROM ev)),
  'switching back on plans the future appointments again');

-- ---------- (3) the claim ----------
UPDATE agenda_reminders SET due_at = now() - interval '1 minute' WHERE event_id = (SELECT id FROM ev) AND state = 'pending';
CREATE TEMP TABLE claimed AS SELECT * FROM agenda_reminders_claim(now(), 25);
GRANT SELECT ON claimed TO service_role;
SELECT pg_temp.assert_eq((SELECT count(*) FROM claimed), 2, 'first claim takes the two due reminders');
SELECT pg_temp.assert_true((SELECT bool_and(state = 'sending' AND attempts = 1 AND claimed_at IS NOT NULL) FROM claimed), 'claimed rows are sending with attempts = 1');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders_claim(now(), 25)), 0, 'second claim (overlapping tick) gets nothing: never double-sent');
-- A throttled send goes back to pending with next_try_at: not claimed before it, claimed after.
UPDATE agenda_reminders SET state = 'pending', next_try_at = now() + interval '5 minutes', claimed_at = NULL WHERE id = (SELECT id FROM claimed WHERE slot = 1);
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders_claim(now(), 25)), 0, 'parked reminder waits for next_try_at');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders_claim(now() + interval '6 minutes', 25)), 1, 'and is claimed after it');
SELECT pg_temp.assert_eq((SELECT attempts FROM agenda_reminders WHERE id = (SELECT id FROM claimed WHERE slot = 1)), 2, 'attempts counted');
-- A worker that died mid-send: parked as maybe_sent, never re-sent.
UPDATE agenda_reminders SET claimed_at = now() - interval '11 minutes' WHERE id = (SELECT id FROM claimed WHERE slot = 2);
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders_claim(now(), 25)), 0, 'stuck row is not re-claimed');
SELECT pg_temp.assert_true((SELECT state = 'failed' AND reason = 'maybe_sent' FROM agenda_reminders WHERE id = (SELECT id FROM claimed WHERE slot = 2)), 'stuck row parked as failed/maybe_sent');
-- Nothing else is due: reminders for the future stay pending.
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders_claim(now(), 25)), 0, 'future reminders are not claimed');

-- ---------- (6) the customer's answer ----------
-- Fresh appointments for the answer tests (distinct times, 2030-02-*).
SET LOCAL ROLE service_role;
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-02-04 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')), 'book answer-test appointment 1');
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-02-05 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')), 'book answer-test appointment 2');
RESET ROLE;
-- Both reminders of both were "sent".
UPDATE agenda_reminders SET state = 'sent', sent_at = now() WHERE event_id IN (SELECT id FROM calendar_events WHERE starts_at IN ('2030-02-04 13:00+00', '2030-02-05 13:00+00'));
SET LOCAL ROLE service_role;

SELECT pg_temp.ok(format($q$SELECT agenda_reminder_respond(%L, %L, 'confirmed')$q$,
  (SELECT acc FROM t WHERE label='A1'),
  (SELECT r.id FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id WHERE e.starts_at = '2030-02-04 13:00+00' AND r.slot = 2)), 'customer confirms (answering the 2 h reminder)');
SELECT pg_temp.assert_true((SELECT status = 'confirmed' AND customer_response = 'confirmed' AND customer_responded_at IS NOT NULL FROM calendar_events WHERE starts_at = '2030-02-04 13:00+00'),
  'appointment confirmed and marked as confirmed by the customer');
SELECT pg_temp.assert_true((SELECT bool_and(response = 'confirmed') FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id WHERE e.starts_at = '2030-02-04 13:00+00'),
  'the sibling reminder of the same appointment is answered too');
SELECT pg_temp.fails(format($q$SELECT agenda_reminder_respond(%L, %L, 'reschedule_requested')$q$,
  (SELECT acc FROM t WHERE label='A1'),
  (SELECT r.id FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id WHERE e.starts_at = '2030-02-04 13:00+00' AND r.slot = 1)), 'AG009', 'a second answer is refused');

SELECT pg_temp.ok(format($q$SELECT agenda_reminder_respond(%L, %L, 'reschedule_requested')$q$,
  (SELECT acc FROM t WHERE label='A1'),
  (SELECT r.id FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id WHERE e.starts_at = '2030-02-05 13:00+00' AND r.slot = 1)), 'customer asks to reschedule');
SELECT pg_temp.assert_true((SELECT status = 'scheduled' AND customer_response = 'reschedule_requested' FROM calendar_events WHERE starts_at = '2030-02-05 13:00+00'),
  'status untouched, flagged "pediu para remarcar"');
-- A human reschedules: the old answer no longer applies.
SELECT pg_temp.ok(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-02-06 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE starts_at = '2030-02-05 13:00+00')), 'agent reschedules');
SELECT pg_temp.assert_true((SELECT customer_response IS NULL AND customer_responded_at IS NULL FROM calendar_events WHERE starts_at = '2030-02-06 13:00+00'),
  'rescheduling clears the customer answer');
-- Bad input, other accounts, started appointments.
SELECT pg_temp.fails(format($q$SELECT agenda_reminder_respond(%L, %L, 'cancel')$q$, (SELECT acc FROM t WHERE label='A1'), gen_random_uuid()), 'AG008', 'unknown action');
SELECT pg_temp.fails(format($q$SELECT agenda_reminder_respond(%L, %L, 'confirmed')$q$,
  (SELECT acc FROM t WHERE label='B1'), (SELECT id FROM agenda_reminders LIMIT 1)), 'AG009', 'a reminder of another account cannot be answered');

-- A read-only account cannot be answered into a changed state.
RESET ROLE;
UPDATE accounts SET plan_status = 'trial', plan_expires_at = now() - interval '1 day' WHERE id = (SELECT acc FROM t WHERE label='C1');
INSERT INTO calendar_events(account_id, owner_user_id, title, starts_at, ends_at, status, contact_id, service_id, resource_id, created_by)
  VALUES ((SELECT acc FROM t WHERE label='C1'), (SELECT uid FROM t WHERE label='C1'), 'x', '2030-03-04 13:00+00', '2030-03-04 14:00+00', 'scheduled',
          (SELECT contact FROM t WHERE label='C1'), (SELECT svc FROM t WHERE label='C1'), (SELECT res FROM t WHERE label='C1'), (SELECT uid FROM t WHERE label='C1'));
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE account_id = (SELECT acc FROM t WHERE label='C1')), 2, 'reminders are planned for the read-only account too (the cron skips them)');
UPDATE agenda_reminders SET state = 'sent', sent_at = now() WHERE account_id = (SELECT acc FROM t WHERE label='C1');
SET LOCAL ROLE service_role;
SELECT pg_temp.fails(format($q$SELECT agenda_reminder_respond(%L, %L, 'confirmed')$q$,
  (SELECT acc FROM t WHERE label='C1'), (SELECT id FROM agenda_reminders WHERE account_id = (SELECT acc FROM t WHERE label='C1') LIMIT 1)), '42501', 'read-only account: answer refused');

-- A confirmed customer is not asked again; a reschedule request stops the next reminder too.
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-05-06 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')), 'book appointment for the 24 h answer');
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-05-07 13:00+00')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')), 'book appointment for the reschedule request');
RESET ROLE;
UPDATE agenda_reminders SET state = 'sent', sent_at = now() WHERE slot = 1 AND event_id IN (SELECT id FROM calendar_events WHERE starts_at IN ('2030-05-06 13:00+00', '2030-05-07 13:00+00'));
SET LOCAL ROLE service_role;
SELECT pg_temp.ok(format($q$SELECT agenda_reminder_respond(%L, %L, 'confirmed')$q$, (SELECT acc FROM t WHERE label='A1'),
  (SELECT r.id FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id WHERE e.starts_at = '2030-05-06 13:00+00' AND r.slot = 1)), 'confirm from the 24 h reminder');
SELECT pg_temp.assert_true((SELECT state = 'cancelled' AND reason = 'customer_confirmed' FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id WHERE e.starts_at = '2030-05-06 13:00+00' AND r.slot = 2),
  'after "confirmo" the 2 h reminder is cancelled (customer_confirmed)');
SELECT pg_temp.ok(format($q$SELECT agenda_reminder_respond(%L, %L, 'reschedule_requested')$q$, (SELECT acc FROM t WHERE label='A1'),
  (SELECT r.id FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id WHERE e.starts_at = '2030-05-07 13:00+00' AND r.slot = 1)), 'reschedule request from the 24 h reminder');
SELECT pg_temp.assert_true((SELECT state = 'skipped' AND reason = 'reschedule_requested' FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id WHERE e.starts_at = '2030-05-07 13:00+00' AND r.slot = 2),
  'after "pediu para remarcar" the next reminder is skipped (reschedule_requested)');
-- Replanning (status change, settings change) must not bring them back.
SELECT pg_temp.ok(format($q$SELECT agenda_set_appointment_status(%L, %L, 'scheduled')$q$, (SELECT acc FROM t WHERE label='A1'),
  (SELECT id FROM calendar_events WHERE starts_at = '2030-05-06 13:00+00')), 'status change replans');
RESET ROLE;
UPDATE agenda_reminder_settings SET second_offset_minutes = 90 WHERE account_id = (SELECT acc FROM t WHERE label='A1');
UPDATE agenda_reminder_settings SET second_offset_minutes = 120 WHERE account_id = (SELECT acc FROM t WHERE label='A1');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders r JOIN calendar_events e ON e.id = r.event_id
                           WHERE e.starts_at IN ('2030-05-06 13:00+00', '2030-05-07 13:00+00') AND r.slot = 2 AND r.state = 'pending'), 0, 'neither is revived by a replan');
SET LOCAL ROLE service_role;

-- ---------- (7) encaixe ----------
SELECT pg_temp.ok(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-04-01 13:00+00', NULL, 'agent', NULL, NULL, 'scheduled', %L, true)$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1'), (SELECT uid FROM t WHERE label='A2')),
  'agent books an encaixe');
SELECT pg_temp.assert_true((SELECT booking_override AND booking_source = 'agent' FROM calendar_events WHERE starts_at = '2030-04-01 13:00+00'), 'encaixe recorded for audit');
SELECT pg_temp.assert_true((SELECT NOT booking_override FROM calendar_events WHERE starts_at = '2030-02-04 13:00+00'), 'normal bookings are not encaixe');
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-04-02 13:00+00', NULL, 'ai', NULL, NULL, 'scheduled', %L, true)$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1'), (SELECT uid FROM t WHERE label='A2')),
  'AG011', 'the AI can never book an encaixe');
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-04-02 13:00+00', NULL, 'api', NULL, NULL, 'scheduled', %L, true)$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1'), (SELECT uid FROM t WHERE label='A2')),
  'AG011', 'the public API can never book an encaixe');
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-04-02 13:00+00', NULL, 'agent', NULL, NULL, 'scheduled', NULL, true)$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')),
  'AG011', 'an encaixe needs an identified person');
SELECT pg_temp.assert_eq((SELECT count(*) FROM calendar_events WHERE starts_at = '2030-04-02 13:00+00'), 0, 'refused encaixe booked nothing');
-- Reschedule with encaixe.
SELECT pg_temp.fails(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-04-03 13:00+00', NULL, true, 'ai')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE starts_at = '2030-02-04 13:00+00')), 'AG011', 'the AI can never reschedule as encaixe');
SELECT pg_temp.assert_true((SELECT NOT booking_override FROM calendar_events WHERE starts_at = '2030-02-04 13:00+00'), 'refused reschedule changed nothing');
SELECT pg_temp.fails(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-04-03 13:00+00', NULL, true, 'agent')$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE starts_at = '2030-02-04 13:00+00')), 'AG011', 'an encaixe reschedule needs an identified person');
SELECT pg_temp.fails(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-04-03 13:00+00', NULL, true, 'agent', %L)$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE starts_at = '2030-02-04 13:00+00'), (SELECT uid FROM t WHERE label='A3')), 'AG011', 'a viewer cannot be the actor of an encaixe');
SELECT pg_temp.fails(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-04-03 13:00+00', NULL, true, 'agent', %L)$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE starts_at = '2030-02-04 13:00+00'), (SELECT uid FROM t WHERE label='B1')), 'AG011', 'nor a member of another account');
SELECT pg_temp.ok(format($q$SELECT agenda_reschedule_appointment(%L, %L, '2030-04-03 13:00+00', NULL, true, 'agent', %L)$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE starts_at = '2030-02-04 13:00+00'), (SELECT uid FROM t WHERE label='A2')), 'agent reschedules as encaixe');
SELECT pg_temp.assert_true((SELECT booking_override FROM calendar_events WHERE starts_at = '2030-04-03 13:00+00'), 'reschedule encaixe recorded');
-- Encaixe still cannot overlap (the exclusion constraint is the guarantee).
SELECT pg_temp.fails(format($q$SELECT agenda_book_appointment(%L, %L, %L, %L, '2030-04-01 13:30+00', NULL, 'agent', NULL, NULL, 'scheduled', %L, true)$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1'), (SELECT uid FROM t WHERE label='A2')),
  'AG001', 'encaixe still cannot overlap another appointment');

-- ---------- (8) users: no new columns, no new tables ----------
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'A1'), true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.fails(format($q$UPDATE calendar_events SET customer_response = 'confirmed' WHERE id = %L$q$, (SELECT id FROM calendar_events WHERE starts_at = '2030-04-01 13:00+00')), '42501', 'admin cannot forge the customer answer');
SELECT pg_temp.fails(format($q$UPDATE calendar_events SET booking_override = true WHERE id = %L$q$, (SELECT id FROM calendar_events WHERE starts_at = '2030-02-06 13:00+00')), '42501', 'admin cannot flag an encaixe');
SELECT pg_temp.fails(format($q$UPDATE calendar_events SET booking_override = false WHERE id = %L$q$, (SELECT id FROM calendar_events WHERE starts_at = '2030-04-01 13:00+00')), '42501', 'admin cannot erase the encaixe audit');
SELECT pg_temp.fails(format($q$INSERT INTO calendar_events(account_id, title, starts_at, ends_at, booking_override) VALUES (%L, 'x', '2031-01-01 10:00+00', '2031-01-01 11:00+00', true)$q$, (SELECT acc FROM t WHERE label='A1')), '42501', 'user cannot insert a row flagged as encaixe');
SELECT pg_temp.fails(format($q$INSERT INTO calendar_events(account_id, title, starts_at, ends_at, customer_response) VALUES (%L, 'x', '2031-01-01 10:00+00', '2031-01-01 11:00+00', 'confirmed')$q$, (SELECT acc FROM t WHERE label='A1')), '42501', 'user cannot insert a row with a customer answer');
SELECT pg_temp.ok(format($q$UPDATE calendar_events SET description = 'ok' WHERE id = %L$q$, (SELECT id FROM calendar_events WHERE starts_at = '2030-04-01 13:00+00')), 'admin can still edit the free fields');
-- agenda_reminders: members read, nobody writes.
SELECT pg_temp.assert_true((SELECT count(*) > 0 FROM agenda_reminders), 'member reads the reminders of the account');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE account_id <> (SELECT acc FROM t WHERE label='A1')), 0, 'and only of the account');
SELECT pg_temp.fails(format($q$INSERT INTO agenda_reminders(account_id, event_id, slot, offset_minutes, for_starts_at, due_at) VALUES (%L, %L, 1, 60, now(), now())$q$,
  (SELECT acc FROM t WHERE label='A1'), (SELECT id FROM calendar_events WHERE starts_at = '2030-04-01 13:00+00')), '42501', 'users cannot insert reminders');
SELECT pg_temp.fails(format($q$UPDATE agenda_reminders SET state = 'sent' WHERE account_id = %L$q$, (SELECT acc FROM t WHERE label='A1')), '42501', 'users cannot update reminders');
SELECT pg_temp.fails($q$DELETE FROM agenda_reminders$q$, '42501', 'users cannot delete reminders');
-- Settings: admin writes, agent / viewer do not, read-only blocks, other tenants invisible.
SELECT pg_temp.ok(format($q$UPDATE agenda_reminder_settings SET message_text = 'Oi {cliente}' WHERE account_id = %L$q$, (SELECT acc FROM t WHERE label='A1')), 'admin edits the settings');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'A2'), true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE agenda_reminder_settings SET message_text = 'agent' WHERE account_id = %L$q$, (SELECT acc FROM t WHERE label='A1'))), 0, 'agent cannot edit the settings');
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM agenda_reminder_settings), 'agent can read them');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'B1'), true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminder_settings WHERE account_id = (SELECT acc FROM t WHERE label='A1')), 0, 'other tenant sees no settings');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE account_id = (SELECT acc FROM t WHERE label='A1')), 0, 'other tenant sees no reminders');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT uid::text FROM t WHERE label = 'C1'), true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.assert_eq(pg_temp.rows(format($q$UPDATE agenda_reminder_settings SET enabled = false WHERE account_id = %L$q$, (SELECT acc FROM t WHERE label='C1'))), 0, 'read-only account: the owner cannot edit the settings');
RESET ROLE;

-- ---------- (8b) claim fairness: at most 10 rows per account per call ----------
INSERT INTO calendar_events(account_id, owner_user_id, title, starts_at, ends_at, status, contact_id, service_id, resource_id, created_by)
  SELECT (SELECT acc FROM t WHERE label='A1'), (SELECT uid FROM t WHERE label='A1'), 'bulk ' || n,
         timestamptz '2031-03-01 13:00+00' + (n || ' days')::interval, timestamptz '2031-03-01 14:00+00' + (n || ' days')::interval, 'scheduled',
         (SELECT contact FROM t WHERE label='A1'), (SELECT svc FROM t WHERE label='A1'), (SELECT res FROM t WHERE label='A1'), (SELECT uid FROM t WHERE label='A1')
    FROM generate_series(1, 12) AS n;
UPDATE agenda_reminders SET due_at = now() - interval '1 minute'
 WHERE state = 'pending' AND event_id IN (SELECT id FROM calendar_events WHERE title LIKE 'bulk %');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE state = 'pending' AND due_at < now()), 24, '24 reminders due in one account');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders_claim(now(), 25)), 10, 'one account gets at most 10 rows per claim');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders_claim(now(), 25)), 10, 'second claim: the next 10');
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders_claim(now(), 25)), 4, 'third claim: the rest');

-- ---------- (9) event type, then LGPD erasure ----------
INSERT INTO conversations(user_id, account_id, contact_id) VALUES ((SELECT uid FROM t WHERE label='A1'), (SELECT acc FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1'));
SELECT pg_temp.ok(format($q$INSERT INTO conversation_events(account_id, conversation_id, event_type, payload)
  SELECT account_id, id, 'agenda_reply', '{"action":"confirmed"}' FROM conversations WHERE account_id = %L LIMIT 1$q$, (SELECT acc FROM t WHERE label='A1')), 'agenda_reply is an accepted event type');
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_true((SELECT count(*) > 0 FROM agenda_reminders WHERE state = 'pending' AND account_id = (SELECT acc FROM t WHERE label='A1')), 'there are pending reminders before the erasure');
SELECT pg_temp.ok(format($q$SELECT lgpd_delete_contact(%L, %L)$q$, (SELECT acc FROM t WHERE label='A1'), (SELECT contact FROM t WHERE label='A1')), 'erase the contact');
RESET ROLE;
SELECT pg_temp.assert_eq((SELECT count(*) FROM agenda_reminders WHERE state = 'pending' AND account_id = (SELECT acc FROM t WHERE label='A1')), 0, 'erasure cancels every pending reminder (the contact link is gone)');

-- ---------- (10) event type + grants ----------
SELECT pg_temp.assert_true(
      NOT has_function_privilege('anon', 'public.agenda_reminders_claim(timestamptz, integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.agenda_reminders_claim(timestamptz, integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.agenda_reminder_respond(uuid, uuid, text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid, boolean)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.agenda_reschedule_appointment(uuid, uuid, timestamptz, uuid, boolean, text, uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.agenda_reminders_claim(timestamptz, integer)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.agenda_reminder_respond(uuid, uuid, text)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.agenda_book_appointment(uuid, uuid, uuid, uuid, timestamptz, uuid, text, text, text, text, uuid, boolean)', 'EXECUTE'),
  'new RPC grants: service_role only');
SELECT pg_temp.assert_true(
      NOT has_function_privilege('authenticated', 'private.agenda_reminders_plan(uuid)', 'EXECUTE')
  AND NOT has_table_privilege('authenticated', 'public.agenda_reminders', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.agenda_reminders', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.agenda_reminder_settings', 'SELECT'),
  'table and helper grants');
-- The old RPC signatures are gone (no ambiguous overload, no way around the new checks).
SELECT pg_temp.assert_eq((SELECT count(*) FROM pg_proc WHERE proname IN ('agenda_book_appointment', 'agenda_reschedule_appointment') AND pronamespace = 'public'::regnamespace), 2, 'exactly one overload of each booking RPC');

SELECT 'agenda_reminders: ALL OK' AS result;
ROLLBACK;
