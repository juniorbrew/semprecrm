-- Rollback of 114_plan_extras.sql. NOT a migration: run by hand (as postgres).
--
-- READ FIRST. Roll the APP back before this script, and only if BOTH checks below return 0 rows:
--
--   -- 1) no plan version carries extra prices (the old app parser accepts exactly the keys
--   --    modules + limits, so an account assigned to such a version would read as
--   --    "plan unavailable" and be blocked; versions are immutable, so this cannot be undone):
--   SELECT id, plan, revision FROM platform_plan_versions
--    WHERE definition ? 'extra_user_price_cents' OR definition ? 'extra_channel_price_cents';
--   -- 2) no account holds extras or a scheduled reduction (dropping the columns loses what
--   --    customers bought, and Asaas would keep billing the extras):
--   SELECT account_id, extra_users, extra_channels, pending_extra_users FROM account_billing
--    WHERE extra_users > 0 OR extra_channels > 0 OR pending_extra_users IS NOT NULL;
--
-- If check 1 returns rows, roll FORWARD instead (fix the code): the choice made in this PR is
-- that the parser stays strict, as before; it is not made tolerant of unknown keys.
-- If check 2 returns rows, first remove the extras by hand and set each Asaas subscription back
-- to the plan price.
--
-- valid_plan_definition goes back to the 113 text (no price keys).
BEGIN;

DROP FUNCTION IF EXISTS public.billing_extras_claim(uuid, integer);
DROP FUNCTION IF EXISTS public.billing_extras_commit(uuid, uuid, jsonb, jsonb, uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.billing_extras_release(uuid, uuid);

ALTER TABLE public.account_billing
  DROP CONSTRAINT IF EXISTS account_billing_extra_users_range,
  DROP CONSTRAINT IF EXISTS account_billing_extra_channels_range,
  DROP CONSTRAINT IF EXISTS account_billing_extra_prices_range,
  DROP CONSTRAINT IF EXISTS account_billing_extra_users_priced,
  DROP CONSTRAINT IF EXISTS account_billing_extra_channels_priced,
  DROP CONSTRAINT IF EXISTS account_billing_extras_pending_shape,
  DROP CONSTRAINT IF EXISTS account_billing_extras_purchase_shape,
  DROP CONSTRAINT IF EXISTS account_billing_extras_diff_shape,
  DROP COLUMN IF EXISTS extra_users,
  DROP COLUMN IF EXISTS extra_channels,
  DROP COLUMN IF EXISTS extra_user_price_cents,
  DROP COLUMN IF EXISTS extra_channel_price_cents,
  DROP COLUMN IF EXISTS extras_first_due,
  DROP COLUMN IF EXISTS pending_extra_users,
  DROP COLUMN IF EXISTS pending_extra_channels,
  DROP COLUMN IF EXISTS extras_reduce_due,
  DROP COLUMN IF EXISTS extras_asaas_lowered,
  DROP COLUMN IF EXISTS extras_claim_token,
  DROP COLUMN IF EXISTS extras_claim_until,
  DROP COLUMN IF EXISTS pending_add_users,
  DROP COLUMN IF EXISTS pending_add_channels,
  DROP COLUMN IF EXISTS pending_add_user_price_cents,
  DROP COLUMN IF EXISTS pending_add_channel_price_cents,
  DROP COLUMN IF EXISTS extras_oneoff_payment_id,
  DROP COLUMN IF EXISTS extras_oneoff_url,
  DROP COLUMN IF EXISTS extras_oneoff_cents,
  DROP COLUMN IF EXISTS extras_oneoff_expires_at,
  DROP COLUMN IF EXISTS extras_oneoff_renewal_due,
  DROP COLUMN IF EXISTS extras_oneoff_paid_id,
  DROP COLUMN IF EXISTS extras_diff_payment_id,
  DROP COLUMN IF EXISTS extras_diff_expires_at;

-- platform_list_accounts() without the extras columns (081 shape).
DROP FUNCTION IF EXISTS public.platform_list_accounts();
CREATE FUNCTION public.platform_list_accounts()
RETURNS TABLE (
  id UUID, name TEXT, owner_user_id UUID, owner_email TEXT, owner_name TEXT, plan TEXT,
  plan_version_id UUID, plan_definition JSONB, plan_status TEXT, plan_expires_at TIMESTAMPTZ,
  module_overrides JSONB, limit_overrides JSONB, platform_notes TEXT, created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ, members_count BIGINT, channels_count BIGINT, pending_invites_count BIGINT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT a.id, a.name, a.owner_user_id, op.email, op.full_name, a.plan, a.plan_version_id, v.definition,
    a.plan_status, a.plan_expires_at, a.module_overrides, a.limit_overrides, a.platform_notes,
    a.created_at, a.updated_at,
    (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id),
    (SELECT COUNT(*) FROM whatsapp_config w WHERE w.account_id = a.id)
      + (SELECT COUNT(*) FROM wa_qr_sessions q WHERE q.account_id = a.id AND q.status <> 'disconnected'),
    (SELECT COUNT(*) FROM account_invitations i
       WHERE i.account_id = a.id AND i.accepted_at IS NULL AND i.expires_at > NOW())
  FROM accounts a
  JOIN platform_plan_versions v ON v.id=a.plan_version_id AND v.plan=a.plan
  LEFT JOIN profiles op ON op.user_id = a.owner_user_id
  ORDER BY a.created_at DESC;
END;
$$;
ALTER FUNCTION public.platform_list_accounts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_list_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_list_accounts() TO authenticated, service_role;

-- valid_plan_definition back to the 113 text (copied from supabase/migrations/113_booking_pages.sql).
CREATE OR REPLACE FUNCTION public.valid_plan_definition(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE item jsonb; key text; capacity jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
     OR NOT value ?& ARRAY['modules','limits']
     OR value - ARRAY['modules','limits'] <> '{}'
     OR jsonb_typeof(value->'modules') IS DISTINCT FROM 'array'
     OR jsonb_typeof(value->'limits') IS DISTINCT FROM 'object'
     OR NOT (value->'limits') ?& ARRAY['max_users','max_channels']
     OR (value->'limits') - ARRAY['max_users','max_channels'] <> '{}' THEN
    RETURN false;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value->'modules') LOOP
    IF jsonb_typeof(item) <> 'string' OR NOT (item #>> '{}') = ANY(ARRAY[
      'dashboard','pipelines','tasks','broadcasts','automations','flows',
      'channel_official','channel_qr','lead_capture','white_label','internal_chat','calendar','ai',
      'reports','api','support','ai_actions','channel_instagram','channel_messenger','booking_page'
    ]) THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(*) <> count(DISTINCT x) FROM jsonb_array_elements(value->'modules') x)
     THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['max_users','max_channels'] LOOP
    capacity := value->'limits'->key;
    IF capacity <> 'null'::jsonb THEN
      IF jsonb_typeof(capacity) <> 'number' THEN RETURN false; END IF;
      IF (capacity #>> '{}')::numeric < 0 OR (capacity #>> '{}')::numeric > 9007199254740991
         OR trunc((capacity #>> '{}')::numeric) <> (capacity #>> '{}')::numeric
         THEN RETURN false; END IF;
    END IF;
  END LOOP;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.valid_plan_definition(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.valid_plan_definition(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
