-- ============================================================
-- Migration 106 (sales forecast) — stage chance (automatic rule for 1, 2, 3 and 5
-- stages, defined value, CHECK 0-100), forecast buckets: won by closed_at in the
-- account time zone, overdue -> current month, "no date", other currency counted
-- apart, lost out, pipeline filter, month clamp; access: member reads, other
-- tenant / anon / no user cannot, only admins edit a stage chance.
--
-- Nothing is committed (ends in ROLLBACK). Needs the local DB migrated through
-- 104 (103 for report_timezone); apply 106 in the same transaction:
--   (cat supabase/migrations/106_sales_forecast.sql supabase/tests/sales_forecast.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- (106 has its own BEGIN/COMMIT, so it stays applied; everything this file creates is rolled
-- back at its end. 106 is idempotent.)
-- Never run `supabase db reset`.
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
-- Totals of the forecast for one month bucket (NULL = "no date") summed over sellers (or one seller),
-- as "won/weighted/best/open/overdue_count/overdue_value/other_currency". NULL when the bucket has no row.
-- With no JWT subject set (superuser sections) the call is made as owner A for that one read.
CREATE FUNCTION pg_temp.fc(p_acc uuid, p_pipe uuid, p_from date, p_months int, p_bucket date, p_seller uuid DEFAULT NULL, p_any_seller boolean DEFAULT true) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_anon boolean := coalesce(current_setting('request.jwt.claim.sub', true), '') = '';
  v_out text;
BEGIN
  IF v_anon THEN PERFORM set_config('request.jwt.claim.sub', '10600000-0000-4000-8000-00000000000a', true); END IF;
  SELECT sum(r.won_value)::text || '/' || sum(r.weighted_value)::text || '/' || sum(r.best_case_value)::text || '/' || sum(r.open_count)::text
         || '/' || sum(r.overdue_count)::text || '/' || sum(r.overdue_value)::text || '/' || sum(r.other_currency_count)::text
    INTO v_out
    FROM public.sales_forecast(p_acc, p_pipe, p_from, p_months) r
   WHERE r.month IS NOT DISTINCT FROM p_bucket
     AND (p_any_seller OR r.assigned_to IS NOT DISTINCT FROM p_seller);
  IF v_anon THEN PERFORM set_config('request.jwt.claim.sub', '', true); END IF;
  RETURN v_out;
END $$;
CREATE FUNCTION pg_temp.fc_fails(p_acc uuid, p_month date) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '10600000-0000-4000-8000-00000000000a', true);
  PERFORM * FROM public.sales_forecast(p_acc, NULL, p_month, 1);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN false;
EXCEPTION WHEN SQLSTATE '22023' THEN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN true;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- tenants -----------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('10600000-0000-4000-8000-00000000000a', 'owner-a@forecast.test', '{"full_name":"Owner A"}'),
 ('10600000-0000-4000-8000-00000000000b', 'owner-b@forecast.test', '{"full_name":"Owner B"}'),
 ('10600000-0000-4000-8000-00000000000c', 'agent-1@forecast.test', '{"full_name":"Agent One"}'),
 ('10600000-0000-4000-8000-00000000000d', 'agent-2@forecast.test', '{"full_name":"Agent Two"}');
CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '10600000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '10600000-0000-4000-8000-00000000000b') AS acc_b,
       '10600000-0000-4000-8000-00000000000a'::uuid AS owner,
       '10600000-0000-4000-8000-00000000000b'::uuid AS owner_b,
       '10600000-0000-4000-8000-00000000000c'::uuid AS ag1,
       '10600000-0000-4000-8000-00000000000d'::uuid AS ag2,
       date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date AS cur;
GRANT SELECT ON ids TO anon, authenticated, service_role;
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent' WHERE user_id IN ((SELECT ag1 FROM ids), (SELECT ag2 FROM ids));
UPDATE accounts SET preferences = '{"business_hours":{"timezone":"America/Sao_Paulo","days":{}}}'::jsonb,
                    default_currency = 'BRL', plan_status = 'active', plan_expires_at = NULL
 WHERE id = (SELECT acc_a FROM ids);

CREATE TEMP TABLE ctx AS
SELECT i.*,
       (i.cur::timestamp AT TIME ZONE 'America/Sao_Paulo') AS cur_start,
       (SELECT id FROM profiles WHERE user_id = i.ag1) AS p1,
       (SELECT id FROM profiles WHERE user_id = i.ag2) AS p2,
       '10600000-0000-4000-8000-0000000000f1'::uuid AS pipe,    -- 3 stages
       '10600000-0000-4000-8000-0000000000f2'::uuid AS pipe1,   -- 1 stage
       '10600000-0000-4000-8000-0000000000f3'::uuid AS pipe2,   -- 2 stages
       '10600000-0000-4000-8000-0000000000f5'::uuid AS pipe5,   -- 5 stages
       '10600000-0000-4000-8000-0000000000e1'::uuid AS s1,
       '10600000-0000-4000-8000-0000000000e2'::uuid AS s2,
       '10600000-0000-4000-8000-0000000000e3'::uuid AS s3
  FROM ids i;
GRANT SELECT ON ctx TO authenticated, service_role, anon;

DO $$
DECLARE c record; v_contact uuid; k int;
BEGIN
  SELECT * INTO c FROM ctx;
  INSERT INTO contacts(user_id, account_id, phone, name) VALUES (c.owner, c.acc_a, '5511106000001', 'F1') RETURNING id INTO v_contact;
  INSERT INTO pipelines(id, user_id, account_id, name) VALUES
    (c.pipe, c.owner, c.acc_a, 'Funil'), (c.pipe1, c.owner, c.acc_a, 'Um'),
    (c.pipe2, c.owner, c.acc_a, 'Dois'), (c.pipe5, c.owner, c.acc_a, 'Cinco');
  INSERT INTO pipeline_stages(id, pipeline_id, name, position) VALUES
    (c.s1, c.pipe, 'Novo', 0), (c.s2, c.pipe, 'Proposta', 1), (c.s3, c.pipe, 'Ganho', 2);
  INSERT INTO pipeline_stages(pipeline_id, name, position) VALUES (c.pipe1, 'Unica', 0);
  INSERT INTO pipeline_stages(pipeline_id, name, position) VALUES (c.pipe2, 'A', 0), (c.pipe2, 'B', 1);
  FOR k IN 0..4 LOOP
    INSERT INTO pipeline_stages(pipeline_id, name, position) VALUES (c.pipe5, 'E' || k, k * 10);
  END LOOP;

  -- open deals (pipe, stage S1 = 10%, S2 = 90%)
  INSERT INTO deals(user_id, account_id, pipeline_id, stage_id, contact_id, title, value, currency, status, assigned_to, expected_close_date) VALUES
    (c.owner, c.acc_a, c.pipe, c.s1, v_contact, 'o1',  1000, 'BRL', 'open', c.p1, (c.cur + 14)),
    (c.owner, c.acc_a, c.pipe, c.s2, v_contact, 'o2',   500, 'BRL', 'open', c.p1, (c.cur + INTERVAL '1 month' + INTERVAL '3 days')::date),
    (c.owner, c.acc_a, c.pipe, c.s2, v_contact, 'o3',   200, 'BRL', 'open', c.p2, (c.cur - 40)),
    (c.owner, c.acc_a, c.pipe, c.s1, v_contact, 'o4',   300, 'BRL', 'open', NULL, NULL),
    (c.owner, c.acc_a, c.pipe, c.s1, v_contact, 'o5',   999, 'USD', 'open', c.p1, (c.cur + 14)),
    (c.owner, c.acc_a, c.pipe, c.s1, v_contact, 'o6',   400, 'BRL', 'open', c.p1, (c.cur + INTERVAL '4 months' + INTERVAL '3 days')::date),
    (c.owner, c.acc_a, c.pipe, c.s1, v_contact, 'lost', 777, 'BRL', 'lost', c.p1, (c.cur + 14)),
    (c.owner, c.acc_a, c.pipe, c.s3, v_contact, 'w1',   100, 'BRL', 'won',  c.p1, NULL),
    (c.owner, c.acc_a, c.pipe, c.s3, v_contact, 'w2',    50, 'BRL', 'won',  c.p2, NULL),
    (c.owner, c.acc_a, c.pipe, c.s3, v_contact, 'w-usd', 55, 'USD', 'won',  c.p2, NULL),
    (c.owner, c.acc_a, c.pipe, c.s3, v_contact, 'w-old', 70, 'BRL', 'won',  c.p1, NULL),
    -- a deal of another pipeline (S2-like single stage = 100%)
    (c.owner, c.acc_a, c.pipe1, (SELECT id FROM pipeline_stages WHERE pipeline_id = c.pipe1), v_contact, 'p1-open', 60, 'BRL', 'open', c.p1, (c.cur + 14));
  -- closed_at is stamped to NOW() on insert; set it explicitly
  UPDATE deals SET closed_at = c.cur_start + INTERVAL '1 minute' WHERE title IN ('w1', 'w-usd');
  UPDATE deals SET closed_at = c.cur_start - INTERVAL '1 minute' WHERE title = 'w2';   -- 23:59 the day before in Sao Paulo (02:59 UTC = this month in UTC)
  UPDATE deals SET closed_at = c.cur_start - INTERVAL '40 days' WHERE title = 'w-old';
END $$;

-- =====================================================================
-- stage chance: same numbers as the TypeScript rule (src/lib/pipelines/board.test.ts)
-- =====================================================================
CREATE FUNCTION pg_temp.chance(p_pipeline uuid, p_pos int) RETURNS numeric LANGUAGE sql AS $$
  SELECT sp.probability
    FROM private.stage_probs((SELECT account_id FROM pipelines WHERE id = p_pipeline)) sp
    JOIN pipeline_stages s ON s.id = sp.stage_id
   WHERE sp.pipeline_id = p_pipeline ORDER BY s.position OFFSET p_pos LIMIT 1
$$;
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe1 FROM ctx), 0), 100, '1 stage: 100');
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe2 FROM ctx), 0), 10, '2 stages: first is 10');
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe2 FROM ctx), 1), 100, '2 stages: last is 100');
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe FROM ctx), 0), 10, '3 stages: first 10');
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe FROM ctx), 1), 90, '3 stages: second 90');
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe FROM ctx), 2), 100, '3 stages: last 100');
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe5 FROM ctx), 0), 10, '5 stages: 10');
SELECT pg_temp.assert_true(abs(pg_temp.chance((SELECT pipe5 FROM ctx), 1) - 36.666666666667) < 0.000001, '5 stages: 36.67');
SELECT pg_temp.assert_true(abs(pg_temp.chance((SELECT pipe5 FROM ctx), 2) - 63.333333333333) < 0.000001, '5 stages: 63.33');
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe5 FROM ctx), 3), 90, '5 stages: 90');
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe5 FROM ctx), 4), 100, '5 stages: last 100');
-- a defined value wins over the automatic rule (including 0 and 100)
UPDATE pipeline_stages SET win_probability = 0 WHERE pipeline_id = (SELECT pipe5 FROM ctx) AND position = 0;
UPDATE pipeline_stages SET win_probability = 100 WHERE pipeline_id = (SELECT pipe5 FROM ctx) AND position = 10;
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe5 FROM ctx), 0), 0, 'defined 0 wins');
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe5 FROM ctx), 1), 100, 'defined 100 wins');
SELECT pg_temp.assert_true(abs(pg_temp.chance((SELECT pipe5 FROM ctx), 2) - 63.333333333333) < 0.000001, 'the others stay automatic');
UPDATE pipeline_stages SET win_probability = NULL WHERE pipeline_id = (SELECT pipe5 FROM ctx);
SELECT pg_temp.assert_eq(pg_temp.chance((SELECT pipe5 FROM ctx), 0), 10, 'back to automatic');
-- CHECK 0..100
SELECT pg_temp.assert_fails('UPDATE pipeline_stages SET win_probability = -1 WHERE id = (SELECT s1 FROM ctx)', 'CHECK: below 0');
SELECT pg_temp.assert_fails('UPDATE pipeline_stages SET win_probability = 101 WHERE id = (SELECT s1 FROM ctx)', 'CHECK: above 100');

-- =====================================================================
-- forecast buckets (account time zone America/Sao_Paulo, currency BRL), pipeline "Funil" + the rest
-- fields: won / weighted / best case / open / overdue count / overdue value / other currency
-- =====================================================================
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 3, (SELECT cur FROM ctx)) = '100.00/280.00/1300.00/2/1/200.00/2', 'current month: won 100 (w2 closed the month before, USD counted apart); weighted o1 100 + overdue o3 180; best 100+1000+200; overdue o3; other currency o5 + w-usd');
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 3, ((SELECT cur FROM ctx) + INTERVAL '1 month')::date) = '0/450.00/500.00/1/0/0/0', 'next month: o2 at 90%');
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 3, ((SELECT cur FROM ctx) + INTERVAL '2 month')::date) IS NULL, 'month +2: no row');
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 3, NULL) = '0/30.00/300.00/1/0/0/0', 'no date bucket: o4 at 10%');
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 3, ((SELECT cur FROM ctx) + INTERVAL '4 month')::date) IS NULL, '3 months: o6 (month +4) is out of range');
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 99, ((SELECT cur FROM ctx) + INTERVAL '4 month')::date) = '0/40.00/400.00/1/0/0/0', 'months clamped to 6: o6 shows');
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 99, ((SELECT cur FROM ctx) + INTERVAL '6 month')::date) IS NULL, 'months clamped to 6: month +6 is out');
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 0, ((SELECT cur FROM ctx) + INTERVAL '1 month')::date) IS NULL, 'months clamped to 1: next month absent');
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 0, (SELECT cur FROM ctx)) IS NOT NULL, 'months clamped to 1: current month present');
-- window that does not contain the current month: overdue deals are not shown
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), ((SELECT cur FROM ctx) + INTERVAL '1 month')::date, 1, ((SELECT cur FROM ctx) + INTERVAL '1 month')::date) = '0/450.00/500.00/1/0/0/0', 'window of the next month only');
-- the past: won of the previous month by closed_at
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), ((SELECT cur FROM ctx) - INTERVAL '1 month')::date, 1, ((SELECT cur FROM ctx) - INTERVAL '1 month')::date) = '50.00/0.00/50.00/0/0/0/0', 'previous month: w2 closed 1 minute before this month (account time zone); w-old is 40 days back');
-- per seller
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 3, (SELECT cur FROM ctx), (SELECT p1 FROM ctx), false) = '100.00/100.00/1100.00/1/0/0/1', 'seller 1, current month');
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 3, (SELECT cur FROM ctx), (SELECT p2 FROM ctx), false) = '0/180.00/200.00/1/1/200.00/1', 'seller 2, current month (overdue o3, USD won counted apart)');
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 3, NULL, NULL, false) = '0/30.00/300.00/1/0/0/0', 'no seller: the unassigned deal is its own row');
-- pipeline filter: all pipelines adds the single-stage pipeline deal (100%)
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), NULL, (SELECT cur FROM ctx), 3, (SELECT cur FROM ctx)) = '100.00/340.00/1360.00/3/1/200.00/2', 'all pipelines: + p1-open 60 at 100%');
-- a deal with no currency counts as "another currency" (same as 103: it is not summed)
INSERT INTO deals(user_id, account_id, pipeline_id, stage_id, contact_id, title, value, currency, status, assigned_to, expected_close_date)
  SELECT c.owner, c.acc_a, c.pipe, c.s1, (SELECT id FROM contacts WHERE phone = '5511106000001'), 'o-null', 77, NULL, 'open', c.p1, (c.cur + 14) FROM ctx c;
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 3, (SELECT cur FROM ctx)) = '100.00/280.00/1300.00/2/1/200.00/3', 'NULL currency: counted as another currency, not summed');
DELETE FROM deals WHERE title = 'o-null';
-- p_month sanity: a clear error, not a raw timestamp overflow
SELECT pg_temp.assert_true(pg_temp.fc_fails((SELECT acc_a FROM ctx), DATE '1900-01-01'), 'month before 2000 refused (22023)');
SELECT pg_temp.assert_true(pg_temp.fc_fails((SELECT acc_a FROM ctx), DATE '2300-01-01'), 'month after 2200 refused (22023)');
-- a defined chance moves the forecast
UPDATE pipeline_stages SET win_probability = 50 WHERE id = (SELECT s1 FROM ctx);
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 3, (SELECT cur FROM ctx)) = '100.00/680.00/1300.00/2/1/200.00/2', 'stage chance 50%: o1 500 + o3 180');
UPDATE pipeline_stages SET win_probability = NULL WHERE id = (SELECT s1 FROM ctx);

-- =====================================================================
-- time zone: w2 closed at 02:59 UTC on day 1 is this month for a UTC account
-- =====================================================================
UPDATE accounts SET preferences = '{"business_hours":{"timezone":"UTC","days":{}}}'::jsonb WHERE id = (SELECT acc_a FROM ctx);
SELECT pg_temp.assert_true(split_part(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 1, (SELECT cur FROM ctx)), '/', 1) = '150.00', 'UTC account: w2 counts in this month');
UPDATE accounts SET preferences = '{"business_hours":{"timezone":"America/Sao_Paulo","days":{}}}'::jsonb WHERE id = (SELECT acc_a FROM ctx);

-- =====================================================================
-- access
-- =====================================================================
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10600000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_true(pg_temp.fc((SELECT acc_a FROM ctx), (SELECT pipe FROM ctx), (SELECT cur FROM ctx), 3, (SELECT cur FROM ctx)) = '100.00/280.00/1300.00/2/1/200.00/2', 'an agent (member) reads the forecast');
-- only admins edit the chance of a stage
UPDATE pipeline_stages SET win_probability = 77 WHERE id = (SELECT s1 FROM ctx);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM pipeline_stages WHERE win_probability = 77), 0, 'agent cannot edit a stage chance (0 rows)');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10600000-0000-4000-8000-00000000000a', true);
UPDATE pipeline_stages SET win_probability = 77 WHERE id = (SELECT s1 FROM ctx);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM pipeline_stages WHERE win_probability = 77), 1, 'owner edits a stage chance');
UPDATE pipeline_stages SET win_probability = NULL WHERE id = (SELECT s1 FROM ctx);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10600000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_fails(format('SELECT * FROM sales_forecast(%L, NULL, %L, 3)', (SELECT acc_a FROM ctx), (SELECT cur FROM ctx)), 'a member of another account reads nothing');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT pg_temp.assert_fails(format('SELECT * FROM sales_forecast(%L, NULL, %L, 3)', (SELECT acc_a FROM ctx), (SELECT cur FROM ctx)), 'authenticated with no user reads nothing');
RESET ROLE;

SET ROLE anon;
SELECT pg_temp.assert_fails(format('SELECT * FROM sales_forecast(%L, NULL, %L, 3)', (SELECT acc_a FROM ctx), (SELECT cur FROM ctx)), 'anon has no EXECUTE');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', true);

-- ---- grants (076 rule) ---------------------------------------------------------------------
SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'public.sales_forecast(uuid, uuid, date, int)', 'EXECUTE'), 'anon cannot run the forecast');
SELECT pg_temp.assert_true(has_function_privilege('authenticated', 'public.sales_forecast(uuid, uuid, date, int)', 'EXECUTE'), 'authenticated runs the forecast');
SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'private.stage_probs(uuid)', 'EXECUTE'), 'anon cannot run stage_probs');

SELECT 'sales_forecast: all assertions passed' AS result;
ROLLBACK;
