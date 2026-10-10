-- Run ONLY against the isolated local verification database. Fixtures rollback.
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE channel_fixtures AS
SELECT gen_random_uuid() AS user_id, n FROM generate_series(1, 1002) n;
INSERT INTO auth.users (id, email, raw_user_meta_data)
SELECT user_id, 'channel-check-' || user_id || '@example.test',
       '{"full_name":"Channel verification"}'::jsonb FROM channel_fixtures;
INSERT INTO public.platform_admins (user_id)
SELECT user_id FROM channel_fixtures WHERE n = 1;
INSERT INTO public.whatsapp_config (account_id, user_id, phone_number_id, access_token, status)
SELECT a.id, f.user_id, 'synthetic-' || f.user_id, 'HIDDEN_VERIFICATION_TOKEN', 'disconnected'
FROM channel_fixtures f JOIN public.accounts a ON a.owner_user_id = f.user_id
WHERE f.n <= 1001;

DO $$
DECLARE result jsonb; account uuid; fixture record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', (SELECT user_id::text FROM channel_fixtures WHERE n=1), true);
  result := public.platform_channel_alerts();
  IF (SELECT count(*) FROM channel_fixtures f JOIN public.accounts a ON a.owner_user_id=f.user_id
      WHERE f.n<=1001 AND result ? a.id::text) <> 1001 THEN
    RAISE EXCEPTION 'Aggregate truncated';
  END IF;
  IF result::text LIKE '%HIDDEN_VERIFICATION%' THEN RAISE EXCEPTION 'Secret exposed'; END IF;
  SELECT a.id INTO account FROM public.accounts a JOIN channel_fixtures f ON a.owner_user_id=f.user_id WHERE f.n=1;
  IF result->account::text <> '{"official_disconnected":true,"qr_disconnected":false}'::jsonb THEN
    RAISE EXCEPTION 'Official disconnected indicator incorrect';
  END IF;
  UPDATE public.whatsapp_config SET status='connected' WHERE account_id=account;
  IF public.platform_channel_alerts() ? account::text THEN RAISE EXCEPTION 'Connected official alerted'; END IF;
  FOR fixture IN SELECT * FROM (VALUES
    ('disconnected', NULL, NULL, NULL, false), -- default / voluntary logout
    ('disconnected', ' ', ' ', ' ', false),
    ('disconnected', '5511999999999', NULL, NULL, true),
    ('disconnected', NULL, 'Synthetic channel', NULL, true),
    ('disconnected', NULL, NULL, 'HIDDEN_VERIFICATION_LOGGED_OUT', true),
    ('connected', '5511999999999', NULL, 'HIDDEN_VERIFICATION_ERROR', false),
    ('connecting', '5511999999999', NULL, NULL, false),
    ('qr', NULL, NULL, NULL, false)
  ) AS cases(status, phone, display_name, error, expected) LOOP
    INSERT INTO public.wa_qr_sessions (account_id, status, phone_number, display_name, last_error)
    VALUES (account, fixture.status, fixture.phone, fixture.display_name, fixture.error)
    ON CONFLICT (account_id) DO UPDATE SET status=EXCLUDED.status, phone_number=EXCLUDED.phone_number,
      display_name=EXCLUDED.display_name, last_error=EXCLUDED.last_error;
    result := public.platform_channel_alerts();
    IF (result ? account::text) <> fixture.expected THEN RAISE EXCEPTION 'QR classification failed: %', fixture; END IF;
    IF result::text LIKE '%HIDDEN_VERIFICATION%' THEN RAISE EXCEPTION 'Error text exposed'; END IF;
    IF fixture.expected AND result->account::text <> '{"official_disconnected":false,"qr_disconnected":true}'::jsonb THEN
      RAISE EXCEPTION 'QR indicator projection incorrect';
    END IF;
  END LOOP;
  IF result ? (SELECT a.id::text FROM public.accounts a JOIN channel_fixtures f ON a.owner_user_id=f.user_id WHERE f.n=1002) THEN
    RAISE EXCEPTION 'Missing channel alerted';
  END IF;
  IF has_function_privilege('anon', 'public.platform_channel_alerts()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous execute allowed';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', (SELECT user_id::text FROM channel_fixtures WHERE n=1002), true);
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.platform_channel_alerts();
    RAISE EXCEPTION 'Nonadmin read allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT user_id::text FROM channel_fixtures WHERE n=1), true) IS NOT NULL AS admin_claim_set;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF jsonb_typeof(public.platform_channel_alerts()) <> 'object' THEN RAISE EXCEPTION 'Admin aggregate unavailable'; END IF;
END;
$$;
RESET ROLE;
ROLLBACK;
SELECT 'PASS channel states, safe projection, 1001 alerts, admin-only access; fixtures rolled back' AS result;
