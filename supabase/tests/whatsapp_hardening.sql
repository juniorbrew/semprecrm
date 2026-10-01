-- ============================================================
-- Migration 078 (chat-media storage write policies) — smoke test.
--
-- Nothing is committed (ends in ROLLBACK). Apply 078 in the same
-- transaction:
--   (echo "BEGIN;"; cat supabase/migrations/078_whatsapp_hardening.sql supabase/tests/whatsapp_hardening.sql) \
--     | docker exec -i supabase_db_semprecrm psql -v ON_ERROR_STOP=1 -U postgres -d postgres
-- ============================================================
\set ON_ERROR_STOP on

INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES
 ('78000000-0000-4000-8000-00000000000a', 'agent-a@media.test', '{"full_name":"Agent A"}'),
 ('78000000-0000-4000-8000-00000000000b', 'owner-b@media.test', '{"full_name":"Owner B"}'),
 ('78000000-0000-4000-8000-00000000000c', 'viewer-a@media.test', '{"full_name":"Viewer A"}');

CREATE TEMP TABLE ids AS
SELECT (SELECT account_id FROM profiles WHERE user_id = '78000000-0000-4000-8000-00000000000a') AS acc_a,
       (SELECT account_id FROM profiles WHERE user_id = '78000000-0000-4000-8000-00000000000b') AS acc_b;
GRANT SELECT ON ids TO authenticated, service_role;

-- Agent A and Viewer A in account A.
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'agent'
 WHERE user_id = '78000000-0000-4000-8000-00000000000a';
UPDATE profiles SET account_id = (SELECT acc_a FROM ids), account_role = 'viewer'
 WHERE user_id = '78000000-0000-4000-8000-00000000000c';

-- Policy check without touching storage internals: run the policy predicate
-- as the caller (same function the policies call).
CREATE FUNCTION pg_temp.can(uid text, path text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE ok boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', uid, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  SELECT public.chat_media_writable(path) INTO ok;
  RETURN ok;
END $$;

CREATE FUNCTION pg_temp.assert(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; END $$;
-- 076 revokes default EXECUTE from authenticated; the asserts below run as it.
GRANT EXECUTE ON FUNCTION pg_temp.assert(boolean, text) TO authenticated;

SELECT pg_temp.assert(pg_temp.can('78000000-0000-4000-8000-00000000000a', 'account-' || (SELECT acc_a FROM ids) || '/1-a.jpg'),
  'agent writes own account folder');
SELECT pg_temp.assert(NOT pg_temp.can('78000000-0000-4000-8000-00000000000a', 'account-' || (SELECT acc_a FROM ids) || '/qr/1-a.jpg'),
  'agent cannot write the qr/ prefix');
SELECT pg_temp.assert(NOT pg_temp.can('78000000-0000-4000-8000-00000000000a', 'account-' || (SELECT acc_b FROM ids) || '/1-a.jpg'),
  'agent cannot write another account');
SELECT pg_temp.assert(NOT pg_temp.can('78000000-0000-4000-8000-00000000000c', 'account-' || (SELECT acc_a FROM ids) || '/1-a.jpg'),
  'viewer cannot write');
SELECT pg_temp.assert(NOT pg_temp.can('78000000-0000-4000-8000-00000000000a', 'account-not-a-uuid/1-a.jpg'),
  'malformed folder is refused (no cast error)');
SELECT pg_temp.assert(NOT pg_temp.can('78000000-0000-4000-8000-00000000000a', '1-a.jpg'),
  'root-level object is refused');

-- Real RLS on storage.objects, as `authenticated`.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '78000000-0000-4000-8000-00000000000a', true);
SELECT set_config('request.jwt.claims', '{"sub":"78000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
INSERT INTO storage.objects(bucket_id, name, owner_id)
  VALUES ('chat-media', 'account-' || (SELECT acc_a FROM ids) || '/1-ok.jpg', '78000000-0000-4000-8000-00000000000a');
DO $$
BEGIN
  BEGIN
    INSERT INTO storage.objects(bucket_id, name, owner_id)
      VALUES ('chat-media', 'account-' || (SELECT acc_a FROM ids) || '/qr/1-x.jpg', '78000000-0000-4000-8000-00000000000a');
    RAISE EXCEPTION 'FAIL: authenticated insert under qr/ was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

-- The service role (gateway) still writes qr/.
SET LOCAL ROLE service_role;
INSERT INTO storage.objects(bucket_id, name)
  VALUES ('chat-media', 'account-' || (SELECT acc_a FROM ids) || '/qr/1-gw.jpg');
RESET ROLE;

-- An agent cannot overwrite the gateway's qr/ object (RLS USING hides it:
-- 0 rows), nor move its own object into qr/ (WITH CHECK). Direct DELETE on
-- storage.objects is blocked by a storage trigger, so DELETE is covered by
-- the predicate checks above (same function).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '78000000-0000-4000-8000-00000000000a', true);
WITH u AS (
  UPDATE storage.objects SET user_metadata = '{"x":1}'
   WHERE bucket_id = 'chat-media' AND name = 'account-' || (SELECT acc_a FROM ids) || '/qr/1-gw.jpg'
  RETURNING 1)
SELECT pg_temp.assert((SELECT count(*) FROM u) = 0, 'agent cannot overwrite a qr/ object');
DO $$
BEGIN
  BEGIN
    UPDATE storage.objects SET name = 'account-' || (SELECT acc_a FROM ids) || '/qr/1-moved.jpg'
     WHERE bucket_id = 'chat-media' AND name = 'account-' || (SELECT acc_a FROM ids) || '/1-ok.jpg';
    RAISE EXCEPTION 'FAIL: moving an object into qr/ was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
SELECT pg_temp.assert(EXISTS (SELECT 1 FROM storage.objects WHERE name = 'account-' || (SELECT acc_a FROM ids) || '/qr/1-gw.jpg'),
  'qr/ object still there');

SELECT 'whatsapp_hardening (078): all checks passed' AS result;
ROLLBACK;
