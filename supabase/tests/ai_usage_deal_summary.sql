-- ============================================================
-- Migration 102 (ai_usage.feature accepts 'deal_summary') — smoke test.
-- Nothing is committed (ends in ROLLBACK). On a DB migrated through 101:
--   (echo "BEGIN;"; cat supabase/migrations/102_*.sql supabase/tests/ai_usage_deal_summary.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_fails(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN RETURN;
  END;
  RAISE EXCEPTION 'FAIL (accepted): %', label;
END $$;

INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('72000000-0000-4000-8000-00000000000a', 'owner-a@dealsummary.test', '{"full_name":"Owner A"}');
CREATE TEMP TABLE ids AS
SELECT account_id AS acc_a FROM profiles WHERE user_id = '72000000-0000-4000-8000-00000000000a';

INSERT INTO ai_usage(account_id, feature, provider, model, status) VALUES ((SELECT acc_a FROM ids), 'deal_summary', 'openai', 'gpt-5-mini', 'ok');
-- older labels still valid, unknown ones still refused
INSERT INTO ai_usage(account_id, feature, provider, model, status) VALUES ((SELECT acc_a FROM ids), 'suggest_reply', 'openai', 'gpt-5-mini', 'ok');
SELECT pg_temp.assert_fails(
  format('INSERT INTO ai_usage(account_id, feature, provider, model, status) VALUES (%L, %L, %L, %L, %L)',
         (SELECT acc_a FROM ids), 'nope', 'openai', 'gpt-5-mini', 'ok'),
  'unknown ai_usage feature');
ROLLBACK;
