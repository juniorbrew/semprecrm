-- ============================================================
-- Migration 103 (sales goals) — RLS visibility, write rules, guard triggers,
-- "valid until changed" resolution, NULL removal, currency filter, time zone
-- month boundary, team / member attribution, billing block.
--
-- Nothing is committed (ends in ROLLBACK). Needs the local DB migrated through
-- 102; apply 103 in the same transaction:
--   (cat supabase/migrations/103_sales_goals.sql supabase/tests/sales_goals.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- (103 has its own BEGIN/COMMIT, so it stays applied; everything this file creates is rolled
-- back at its end. 103 is idempotent.)
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
-- rows of the progress function for (scope, metric) as "target/achieved", or NULL when absent
CREATE FUNCTION pg_temp.prog(p_acc uuid, p_month date, p_scope text, p_ref uuid, p_metric text) RETURNS text LANGUAGE sql AS $$
  SELECT target::text || '/' || achieved::text
    FROM public.sales_goal_progress(p_acc, p_month) r
   WHERE r.scope = p_scope AND r.metric = p_metric
     AND COALESCE(r.team_id, r.user_id) IS NOT DISTINCT FROM p_ref
$$;
-- 076 closes new functions by default: open this script's pg_temp helpers.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- ---- tenants -----------------------------------------------------------
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('10300000-0000-4000-8000-00000000000a', 'owner-a@goals.test', '{"full_name":"Owner A"}'),
 ('10300000-0000-4000-8000-00000000000b', 'owner-b@goals.test', '{"full_name":"Owner B"}'),
 ('10300000-0000-4000-8000-00000000000c', 'agent-1@goals.test', '{"full_name":"Agent One"}'),
 ('10300000-0000-4000-8000-00000000000d', 'agent-2@goals.test', '{"full_name":"Agent Two"}');
CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '10300000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '10300000-0000-4000-8000-00000000000b') AS acc_b,
       '10300000-0000-4000-8000-00000000000a'::uuid AS owner,
       '10300000-0000-4000-8000-00000000000b'::uuid AS owner_b,
       '10300000-0000-4000-8000-00000000000c'::uuid AS ag1,
       '10300000-0000-4000-8000-00000000000d'::uuid AS ag2,
       '10300000-0000-4000-8000-0000000000b1'::uuid AS team1,
       '10300000-0000-4000-8000-0000000000b2'::uuid AS team2,
       '10300000-0000-4000-8000-0000000000b3'::uuid AS team_b,
       date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date AS cur;
GRANT SELECT ON ids TO anon, authenticated, service_role;
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent' WHERE user_id IN ((SELECT ag1 FROM ids), (SELECT ag2 FROM ids));
UPDATE accounts SET preferences = '{"business_hours":{"timezone":"America/Sao_Paulo","days":{}}}'::jsonb,
                    default_currency = 'BRL', plan_status = 'active', plan_expires_at = NULL
 WHERE id = (SELECT acc_a FROM ids);
INSERT INTO teams(id, account_id, name) VALUES
 ((SELECT team1 FROM ids), (SELECT acc_a FROM ids), 'Vendas SP'),
 ((SELECT team2 FROM ids), (SELECT acc_a FROM ids), 'Vendas RJ'),
 ((SELECT team_b FROM ids), (SELECT acc_b FROM ids), 'Outra empresa');
INSERT INTO team_members(team_id, user_id, account_id) VALUES
 ((SELECT team1 FROM ids), (SELECT ag1 FROM ids), (SELECT acc_a FROM ids)),
 ((SELECT team2 FROM ids), (SELECT ag2 FROM ids), (SELECT acc_a FROM ids));

-- ---- deals (seeded as superuser) -----------------------------------------
-- cur = first day of the current month in America/Sao_Paulo; prev = month before.
CREATE TEMP TABLE ctx AS
SELECT i.*,
       (i.cur - INTERVAL '1 month')::date AS prev,
       (i.cur - INTERVAL '2 month')::date AS prev2,
       (i.cur::timestamp AT TIME ZONE 'America/Sao_Paulo') AS cur_start,
       (SELECT id FROM profiles WHERE user_id = i.ag1) AS p1,
       (SELECT id FROM profiles WHERE user_id = i.ag2) AS p2
  FROM ids i;
GRANT SELECT ON ctx TO authenticated, service_role;
DO $$
DECLARE c record; v_contact uuid; v_pipe uuid; v_stage uuid;
BEGIN
  SELECT * INTO c FROM ctx;
  INSERT INTO contacts(user_id, account_id, phone, name) VALUES (c.owner, c.acc_a, '5511103000001', 'G1') RETURNING id INTO v_contact;
  INSERT INTO pipelines(user_id, account_id, name) VALUES (c.owner, c.acc_a, 'Funil') RETURNING id INTO v_pipe;
  INSERT INTO pipeline_stages(pipeline_id, name) VALUES (v_pipe, 'Novo') RETURNING id INTO v_stage;
  -- current month: agent 1 won 100 + 50 (BRL), agent 2 won 200 (BRL), one USD deal (999) of agent 1, one unassigned 25, one lost 777, one still open 888
  INSERT INTO deals(user_id, account_id, pipeline_id, stage_id, contact_id, title, value, currency, status, assigned_to) VALUES
    (c.owner, c.acc_a, v_pipe, v_stage, v_contact, 'a1-100', 100, 'BRL', 'won', c.p1),
    (c.owner, c.acc_a, v_pipe, v_stage, v_contact, 'a1-50',   50, 'BRL', 'won', c.p1),
    (c.owner, c.acc_a, v_pipe, v_stage, v_contact, 'a2-200', 200, 'BRL', 'won', c.p2),
    (c.owner, c.acc_a, v_pipe, v_stage, v_contact, 'a1-usd', 999, 'USD', 'won', c.p1),
    (c.owner, c.acc_a, v_pipe, v_stage, v_contact, 'nobody',  25, 'BRL', 'won', NULL),
    (c.owner, c.acc_a, v_pipe, v_stage, v_contact, 'lost',   777, 'BRL', 'lost', c.p1),
    (c.owner, c.acc_a, v_pipe, v_stage, v_contact, 'open',   888, 'BRL', 'open', c.p1);
  -- previous month: agent 1 won 30, plus the boundary deal: closed 1 minute before this month starts
  -- in Sao Paulo (02:59 UTC on day 1 = still "this month" in UTC) -> previous month for the account.
  INSERT INTO deals(user_id, account_id, pipeline_id, stage_id, contact_id, title, value, currency, status, assigned_to) VALUES
    (c.owner, c.acc_a, v_pipe, v_stage, v_contact, 'prev-30',   30, 'BRL', 'won', c.p1),
    (c.owner, c.acc_a, v_pipe, v_stage, v_contact, 'boundary',  11, 'BRL', 'won', c.p1);
  -- closed_at is stamped to NOW() on insert; the trigger only fires on UPDATE OF status
  UPDATE deals SET closed_at = c.cur_start - INTERVAL '10 days' WHERE title = 'prev-30';
  UPDATE deals SET closed_at = c.cur_start - INTERVAL '1 minute' WHERE title = 'boundary';
  UPDATE deals SET closed_at = c.cur_start + INTERVAL '1 minute' WHERE title IN ('a1-100', 'a1-50', 'a2-200', 'a1-usd', 'nobody');
END $$;

-- ---- seed goals as superuser (history is writable outside a user context) --
INSERT INTO sales_goals(account_id, scope, team_id, user_id, metric, month, target) VALUES
  ((SELECT acc_a FROM ctx), 'account', NULL, NULL, 'won_value', (SELECT prev2 FROM ctx), 1000),
  ((SELECT acc_a FROM ctx), 'account', NULL, NULL, 'won_count', (SELECT prev2 FROM ctx), 10),
  ((SELECT acc_a FROM ctx), 'team', (SELECT team1 FROM ctx), NULL, 'won_value', (SELECT prev2 FROM ctx), 400),
  ((SELECT acc_a FROM ctx), 'team', (SELECT team2 FROM ctx), NULL, 'won_value', (SELECT prev2 FROM ctx), 500),
  ((SELECT acc_a FROM ctx), 'member', NULL, (SELECT ag1 FROM ctx), 'won_value', (SELECT prev2 FROM ctx), 300),
  ((SELECT acc_a FROM ctx), 'member', NULL, (SELECT ag2 FROM ctx), 'won_value', (SELECT prev2 FROM ctx), 350);

-- =====================================================================
-- constraints and guard triggers (superuser: same-account rules always apply)
-- =====================================================================
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, metric, month, target) VALUES (%L, %L, %L, %L, 5)', (SELECT acc_a FROM ctx), 'bogus', 'won_value', (SELECT cur FROM ctx)), 'scope CHECK');
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, metric, month, target) VALUES (%L, %L, %L, %L, 5)', (SELECT acc_a FROM ctx), 'account', 'revenue', (SELECT cur FROM ctx)), 'metric CHECK');
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, metric, month, target) VALUES (%L, %L, %L, %L, 5)', (SELECT acc_a FROM ctx), 'account', 'won_value', (SELECT cur FROM ctx) + 3), 'month must be the first day');
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, metric, month, target) VALUES (%L, %L, %L, %L, 0)', (SELECT acc_a FROM ctx), 'account', 'won_value', (SELECT cur FROM ctx)), 'target must be positive');
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, metric, month, target) VALUES (%L, %L, %L, %L, 2000000000)', (SELECT acc_a FROM ctx), 'account', 'won_value', (SELECT cur FROM ctx)), 'target upper bound');
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, metric, month, target) VALUES (%L, %L, %L, %L, 2.5)', (SELECT acc_a FROM ctx), 'account', 'won_count', (SELECT cur FROM ctx)), 'count goal must be whole');
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, team_id, metric, month, target) VALUES (%L, %L, %L, %L, %L, 5)', (SELECT acc_a FROM ctx), 'account', (SELECT team1 FROM ctx), 'won_value', (SELECT cur FROM ctx)), 'account scope cannot carry a team');
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, metric, month, target) VALUES (%L, %L, %L, %L, 5)', (SELECT acc_a FROM ctx), 'team', 'won_value', (SELECT cur FROM ctx)), 'team scope needs a team');
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, team_id, metric, month, target) VALUES (%L, %L, %L, %L, %L, 5)', (SELECT acc_a FROM ctx), 'team', (SELECT team_b FROM ctx), 'won_value', (SELECT cur FROM ctx)), 'guard: team of another account');
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, user_id, metric, month, target) VALUES (%L, %L, %L, %L, %L, 5)', (SELECT acc_a FROM ctx), 'member', (SELECT owner_b FROM ctx), 'won_value', (SELECT cur FROM ctx)), 'guard: member of another account');
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, metric, month, target) VALUES (%L, %L, %L, %L, 5)', (SELECT acc_a FROM ctx), 'account', 'won_value', (SELECT prev2 FROM ctx)), 'unique per (account, target, metric, month)');

-- =====================================================================
-- resolution: "valid until changed" (history seeded in prev2 only)
-- =====================================================================
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT prev2 FROM ctx), 'account', NULL, 'won_value') = '1000.00/0', 'prev2: own row, nothing won yet');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT prev FROM ctx), 'account', NULL, 'won_value') = '1000.00/41.00', 'prev: inherits the older goal; achieved 30 + 11 boundary deal (account time zone)');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'account', NULL, 'won_value') = '1000.00/375.00', 'current: BRL only, won only, 100+50+200+25 (USD, lost, open and previous month excluded)');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'account', NULL, 'won_count') = '10.00/5', 'count goal counts every won deal incl. the USD one and the unassigned one');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT prev FROM ctx), 'account', NULL, 'won_count') = '10.00/2', 'previous month count');
-- team = deals of the members CURRENTLY in the team; member = their own deals
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'team', (SELECT team1 FROM ctx), 'won_value') = '400.00/150.00', 'team 1 = agent 1 BRL won (USD excluded)');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'team', (SELECT team2 FROM ctx), 'won_value') = '500.00/200.00', 'team 2 = agent 2');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'member', (SELECT ag1 FROM ctx), 'won_value') = '300.00/150.00', 'member 1');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'member', (SELECT ag2 FROM ctx), 'won_value') = '350.00/200.00', 'member 2');
-- archived team and removed member drop out
UPDATE teams SET archived_at = now() WHERE id = (SELECT team2 FROM ctx);
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'team', (SELECT team2 FROM ctx), 'won_value') IS NULL, 'archived team disappears');
UPDATE teams SET archived_at = NULL WHERE id = (SELECT team2 FROM ctx);
-- a team that moves: agent 2 joins team 1 -> its total follows the membership today
INSERT INTO team_members(team_id, user_id, account_id) VALUES ((SELECT team1 FROM ctx), (SELECT ag2 FROM ctx), (SELECT acc_a FROM ctx));
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'team', (SELECT team1 FROM ctx), 'won_value') = '400.00/350.00', 'team follows team_members today');
DELETE FROM team_members WHERE team_id = (SELECT team1 FROM ctx) AND user_id = (SELECT ag2 FROM ctx);
-- another tenant never contributes and cannot be queried by a non-member (superuser has no auth.uid -> checked as users below)

-- NULL removal from a month on, and a change keeps the history
INSERT INTO sales_goals(account_id, scope, metric, month, target) VALUES ((SELECT acc_a FROM ctx), 'account', 'won_count', (SELECT prev FROM ctx), NULL);
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT prev2 FROM ctx), 'account', NULL, 'won_count') = '10.00/0', 'removal does not touch earlier months');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT prev FROM ctx), 'account', NULL, 'won_count') IS NULL, 'removed from prev on');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'account', NULL, 'won_count') IS NULL, 'still removed in the current month (inherits the removal)');
DELETE FROM sales_goals WHERE scope = 'account' AND metric = 'won_count' AND month = (SELECT prev FROM ctx) AND account_id = (SELECT acc_a FROM ctx);

-- =====================================================================
-- RLS: who sees what (owner, agent 1 in team 1, agent 2 in team 2, other tenant)
-- =====================================================================
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10300000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goals), 6, 'owner sees all six goals');
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goal_progress((SELECT acc_a FROM ctx), (SELECT cur FROM ctx))), 6, 'owner progress: six goals');
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10300000-0000-4000-8000-00000000000c', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goals), 4, 'agent 1 sees company x2, team 1 and own goal');
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goals WHERE scope = 'member' AND user_id = (SELECT ag2 FROM ctx)), 0, 'agent 1 cannot read agent 2 goal');
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goals WHERE scope = 'team' AND team_id = (SELECT team2 FROM ctx)), 0, 'agent 1 cannot read the goal of a team they are not in');
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goal_progress((SELECT acc_a FROM ctx), (SELECT cur FROM ctx))), 4, 'agent 1 progress: same four');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'member', (SELECT ag2 FROM ctx), 'won_value') IS NULL, 'agent 1 gets no number of agent 2');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'member', (SELECT ag1 FROM ctx), 'won_value') = '300.00/150.00', 'agent 1 sees own progress');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'team', (SELECT team1 FROM ctx), 'won_value') = '400.00/150.00', 'agent 1 sees own team progress');
-- agents cannot write, not even their own goal
SELECT pg_temp.assert_fails(format('INSERT INTO sales_goals(account_id, scope, user_id, metric, month, target) VALUES (%L, %L, %L, %L, %L, 5)', (SELECT acc_a FROM ctx), 'member', (SELECT ag1 FROM ctx), 'won_count', (SELECT cur FROM ctx)), 'agent cannot insert a goal');
SELECT pg_temp.assert_fails(format('SELECT sales_goal_set(%L, %L, NULL, NULL, %L, %L, 5)', (SELECT acc_a FROM ctx), 'account', 'won_value', (SELECT cur FROM ctx)), 'agent cannot call sales_goal_set');
UPDATE sales_goals SET target = 1 WHERE scope = 'account';
DELETE FROM sales_goals WHERE scope = 'account';
RESET ROLE;
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goals WHERE scope = 'account' AND target = 1), 0, 'agent update touched 0 rows');
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goals WHERE scope = 'account'), 2, 'agent delete touched 0 rows');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10300000-0000-4000-8000-00000000000d', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goals WHERE scope = 'member' AND user_id = (SELECT ag1 FROM ctx)), 0, 'agent 2 cannot read agent 1 goal');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'team', (SELECT team1 FROM ctx), 'won_value') IS NULL, 'agent 2 gets no progress of team 1');
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10300000-0000-4000-8000-00000000000b', true);
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goals), 0, 'tenant B sees no goal of A');
SELECT pg_temp.assert_fails(format('SELECT * FROM sales_goal_progress(%L, %L)', (SELECT acc_a FROM ctx), (SELECT cur FROM ctx)), 'tenant B cannot ask A progress');
SELECT pg_temp.assert_fails(format('SELECT sales_goal_set(%L, %L, NULL, NULL, %L, %L, 5)', (SELECT acc_a FROM ctx), 'account', 'won_value', (SELECT cur FROM ctx)), 'tenant B cannot set goals in A');
RESET ROLE;

SET ROLE anon;
SELECT pg_temp.assert_fails(format('SELECT * FROM sales_goal_progress(%L, %L)', (SELECT acc_a FROM ctx), (SELECT cur FROM ctx)), 'anon has no EXECUTE');
RESET ROLE;

-- =====================================================================
-- admin writes: current month onward only; upsert path; guards
-- =====================================================================
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10300000-0000-4000-8000-00000000000a', true);
SELECT sales_goal_set((SELECT acc_a FROM ctx), 'account', NULL, NULL, 'won_value', (SELECT cur FROM ctx), 2000);
SELECT sales_goal_set((SELECT acc_a FROM ctx), 'account', NULL, NULL, 'won_value', (SELECT cur FROM ctx), 2500);  -- same key: update, not a duplicate
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goals WHERE scope = 'account' AND metric = 'won_value' AND month = (SELECT cur FROM ctx)), 1, 'upsert keeps one row per key');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'account', NULL, 'won_value') = '2500.00/375.00', 'new goal valid from this month');
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT prev FROM ctx), 'account', NULL, 'won_value') = '1000.00/41.00', 'past month keeps the old goal (history unchanged)');
SELECT sales_goal_set((SELECT acc_a FROM ctx), 'team', (SELECT team1 FROM ctx), NULL, 'won_value', (SELECT cur FROM ctx), NULL);
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT cur FROM ctx), 'team', (SELECT team1 FROM ctx), 'won_value') IS NULL, 'NULL target removes the goal from this month');
SELECT sales_goal_set((SELECT acc_a FROM ctx), 'account', NULL, NULL, 'won_value', ((SELECT cur FROM ctx) + INTERVAL '1 month')::date, 3000);  -- future month is fine
-- past months are read-only for the admin too
SELECT pg_temp.assert_fails(format('SELECT sales_goal_set(%L, %L, NULL, NULL, %L, %L, 5)', (SELECT acc_a FROM ctx), 'account', 'won_value', (SELECT prev FROM ctx)), 'admin cannot write a past month (insert)');
SELECT pg_temp.assert_fails(format('UPDATE sales_goals SET target = 5 WHERE month = %L', (SELECT prev2 FROM ctx)), 'admin cannot update a past month');
SELECT pg_temp.assert_fails(format('DELETE FROM sales_goals WHERE month = %L', (SELECT prev2 FROM ctx)), 'admin cannot delete a past month');
SELECT pg_temp.assert_fails(format('UPDATE sales_goals SET month = %L WHERE month = %L AND scope = %L AND metric = %L', (SELECT cur FROM ctx), (SELECT prev2 FROM ctx), 'account', 'won_count'), 'the key of a goal never changes');
-- guards through the user path
SELECT pg_temp.assert_fails(format('SELECT sales_goal_set(%L, %L, %L, NULL, %L, %L, 5)', (SELECT acc_a FROM ctx), 'team', (SELECT team_b FROM ctx), 'won_value', (SELECT cur FROM ctx)), 'admin cannot target a team of another account');
SELECT pg_temp.assert_fails(format('SELECT sales_goal_set(%L, %L, NULL, %L, %L, %L, 5)', (SELECT acc_a FROM ctx), 'member', (SELECT owner_b FROM ctx), 'won_value', (SELECT cur FROM ctx)), 'admin cannot target a user of another account');
SELECT pg_temp.assert_fails(format('SELECT sales_goal_set(%L, %L, NULL, NULL, %L, %L, 5)', (SELECT acc_b FROM ctx), 'account', 'won_value', (SELECT cur FROM ctx)), 'admin of A cannot write into B');
RESET ROLE;

-- =====================================================================
-- time zone month boundary: the same instant, another account zone
-- =====================================================================
-- The boundary deal closed at 02:59 UTC on day 1 (23:59 the day before in Sao Paulo).
UPDATE accounts SET preferences = '{"business_hours":{"timezone":"UTC","days":{}}}'::jsonb WHERE id = (SELECT acc_a FROM ctx);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10300000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_true(pg_temp.prog((SELECT acc_a FROM ctx), (SELECT prev FROM ctx), 'account', NULL, 'won_value') = '1000.00/30.00', 'UTC account: the boundary deal is no longer in the previous month');
RESET ROLE;
UPDATE accounts SET preferences = '{"business_hours":{"timezone":"America/Sao_Paulo","days":{}}}'::jsonb WHERE id = (SELECT acc_a FROM ctx);

-- =====================================================================
-- billing block (094): a read-only account does not write goals
-- =====================================================================
UPDATE accounts SET plan_status = 'past_due', plan_expires_at = NULL WHERE id = (SELECT acc_a FROM ctx);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10300000-0000-4000-8000-00000000000a', true);
SELECT pg_temp.assert_fails(format('SELECT sales_goal_set(%L, %L, NULL, NULL, %L, %L, 123)', (SELECT acc_a FROM ctx), 'account', 'won_value', (SELECT cur FROM ctx)), 'past_due: insert/update blocked');
SELECT pg_temp.assert_eq((SELECT count(*) FROM sales_goals), 9, 'past_due: still readable');
RESET ROLE;
UPDATE accounts SET plan_status = 'active' WHERE id = (SELECT acc_a FROM ctx);

-- ---- grants (076 rule) -------------------------------------------------------------------
SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'public.sales_goal_progress(uuid, date)', 'EXECUTE'), 'anon cannot run progress');
SELECT pg_temp.assert_true(has_function_privilege('authenticated', 'public.sales_goal_progress(uuid, date)', 'EXECUTE'), 'authenticated runs progress');
SELECT pg_temp.assert_true(NOT has_function_privilege('authenticated', 'public.sales_goals_guard()', 'EXECUTE'), 'trigger function is closed');
SELECT pg_temp.assert_true(NOT has_table_privilege('authenticated', 'public.sales_goals', 'TRUNCATE'), 'no TRUNCATE for authenticated');

ROLLBACK;
