-- ============================================================
-- 037_branding.sql — White-label ("marca própria", module
-- `white_label`): the account's own app name, logo and primary
-- colour applied to the sidebar, header, document title and theme.
--
-- Spec: docs/superpowers/specs/2026-09-13-parity-round2-design.md
--       section "6. Marca própria — white-label"
--
-- What this migration does
--   1. Adds `accounts.branding` jsonb — `{ app_name, logo_url,
--      primary_color }`, all optional; parsed with defaults by
--      src/lib/branding.ts. Writes go through PUT /api/account/branding
--      (admin+, module-gated, audited) on top of the 017 `accounts_update`
--      RLS policy.
--   2. Creates the public `account-branding` storage bucket (≤ 512 KB,
--      png / svg / webp). Path `account-<account_id>/logo.<ext>`;
--      admin+ members of that account write, everyone reads (the logo
--      is rendered in the app shell).
--   3. Adds `white_label` to the modules `platform_update_account`
--      accepts in `module_overrides` (keep in sync with OPTIONAL_MODULES
--      in src/lib/plans.ts). Body is 029's, with the new module in
--      `v_allowed_modules`.
--
-- Does NOT touch `handle_new_user`.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- ACCOUNTS.branding
-- ============================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS branding JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_branding_object_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_branding_object_check
  CHECK (jsonb_typeof(branding) = 'object');

-- ============================================================
-- account-branding storage bucket (public read, admin+ write)
-- Mirrors 023_chat_media.sql; the extra role check uses
-- is_account_member(<uuid from the path>, 'admin').
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'account-branding',
  'account-branding',
  TRUE,
  524288, -- 512 KB
  ARRAY['image/png', 'image/svg+xml', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Account branding is publicly readable" ON storage.objects;
CREATE POLICY "Account branding is publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'account-branding');

DROP POLICY IF EXISTS "Admins can upload account branding" ON storage.objects;
CREATE POLICY "Admins can upload account branding"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'account-branding'
    AND (storage.foldername(name))[1] ~ '^account-[0-9a-f-]{36}$'
    AND public.is_account_member(
      substring((storage.foldername(name))[1] from 9)::uuid, 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can update account branding" ON storage.objects;
CREATE POLICY "Admins can update account branding"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'account-branding'
    AND (storage.foldername(name))[1] ~ '^account-[0-9a-f-]{36}$'
    AND public.is_account_member(
      substring((storage.foldername(name))[1] from 9)::uuid, 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can delete account branding" ON storage.objects;
CREATE POLICY "Admins can delete account branding"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'account-branding'
    AND (storage.foldername(name))[1] ~ '^account-[0-9a-f-]{36}$'
    AND public.is_account_member(
      substring((storage.foldername(name))[1] from 9)::uuid, 'admin'
    )
  );

-- ============================================================
-- platform_update_account — 029 body + `white_label` as an
-- overridable module (keep `v_allowed_modules` in sync with
-- OPTIONAL_MODULES in src/lib/plans.ts).
-- ============================================================
DROP FUNCTION IF EXISTS public.platform_update_account(UUID, JSONB);
CREATE OR REPLACE FUNCTION public.platform_update_account(
  p_account_id UUID,
  p_patch JSONB
) RETURNS accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row     accounts;
  v_key     TEXT;
  v_val     JSONB;
  v_allowed_modules TEXT[] := ARRAY[
    'dashboard', 'pipelines', 'tasks', 'broadcasts', 'automations', 'flows',
    'channel_official', 'channel_qr', 'lead_capture', 'white_label'
  ];
  v_allowed_limits TEXT[] := ARRAY['max_users', 'max_channels'];
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin only' USING ERRCODE = '42501';
  END IF;

  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be a JSON object' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM accounts WHERE id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found' USING ERRCODE = '22023';
  END IF;

  -- plan --------------------------------------------------------
  IF p_patch ? 'plan' THEN
    IF jsonb_typeof(p_patch->'plan') <> 'string'
       OR (p_patch->>'plan') NOT IN ('trial', 'basico', 'pro', 'empresa') THEN
      RAISE EXCEPTION 'plan must be one of trial, basico, pro, empresa'
        USING ERRCODE = '22023';
    END IF;
    v_row.plan := p_patch->>'plan';
  END IF;

  -- plan_status -------------------------------------------------
  IF p_patch ? 'plan_status' THEN
    IF jsonb_typeof(p_patch->'plan_status') <> 'string'
       OR (p_patch->>'plan_status') NOT IN ('trial', 'active', 'past_due', 'canceled', 'suspended') THEN
      RAISE EXCEPTION 'plan_status must be one of trial, active, past_due, canceled, suspended'
        USING ERRCODE = '22023';
    END IF;
    v_row.plan_status := p_patch->>'plan_status';
  END IF;

  -- plan_expires_at (null clears) --------------------------------
  IF p_patch ? 'plan_expires_at' THEN
    IF jsonb_typeof(p_patch->'plan_expires_at') = 'null' THEN
      v_row.plan_expires_at := NULL;
    ELSIF jsonb_typeof(p_patch->'plan_expires_at') = 'string' THEN
      BEGIN
        v_row.plan_expires_at := (p_patch->>'plan_expires_at')::timestamptz;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'plan_expires_at must be an ISO-8601 timestamp or null'
          USING ERRCODE = '22023';
      END;
    ELSE
      RAISE EXCEPTION 'plan_expires_at must be an ISO-8601 timestamp or null'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- module_overrides: {module: boolean} over the known modules ---
  IF p_patch ? 'module_overrides' THEN
    v_val := p_patch->'module_overrides';
    IF v_val IS NULL OR jsonb_typeof(v_val) <> 'object' THEN
      RAISE EXCEPTION 'module_overrides must be a JSON object' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_val) LOOP
      IF NOT (v_key = ANY (v_allowed_modules)) THEN
        RAISE EXCEPTION 'Unknown module in module_overrides: %', v_key
          USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(v_val->v_key) <> 'boolean' THEN
        RAISE EXCEPTION 'module_overrides.% must be true or false', v_key
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
    v_row.module_overrides := v_val;
  END IF;

  -- limit_overrides: {max_users|max_channels: int >= 0 | null} ---
  IF p_patch ? 'limit_overrides' THEN
    v_val := p_patch->'limit_overrides';
    IF v_val IS NULL OR jsonb_typeof(v_val) <> 'object' THEN
      RAISE EXCEPTION 'limit_overrides must be a JSON object' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_val) LOOP
      IF NOT (v_key = ANY (v_allowed_limits)) THEN
        RAISE EXCEPTION 'Unknown limit in limit_overrides: %', v_key
          USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(v_val->v_key) NOT IN ('number', 'null') THEN
        RAISE EXCEPTION 'limit_overrides.% must be a number or null', v_key
          USING ERRCODE = '22023';
      END IF;
      IF jsonb_typeof(v_val->v_key) = 'number'
         AND ((v_val->>v_key)::numeric < 0 OR (v_val->>v_key)::numeric <> floor((v_val->>v_key)::numeric)) THEN
        RAISE EXCEPTION 'limit_overrides.% must be a non-negative integer', v_key
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
    v_row.limit_overrides := v_val;
  END IF;

  -- platform_notes (null clears) ---------------------------------
  IF p_patch ? 'platform_notes' THEN
    IF jsonb_typeof(p_patch->'platform_notes') = 'null' THEN
      v_row.platform_notes := NULL;
    ELSIF jsonb_typeof(p_patch->'platform_notes') = 'string' THEN
      v_row.platform_notes := NULLIF(btrim(p_patch->>'platform_notes'), '');
    ELSE
      RAISE EXCEPTION 'platform_notes must be a string or null' USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE accounts
  SET plan             = v_row.plan,
      plan_status      = v_row.plan_status,
      plan_expires_at  = v_row.plan_expires_at,
      module_overrides = v_row.module_overrides,
      limit_overrides  = v_row.limit_overrides,
      platform_notes   = v_row.platform_notes
  WHERE id = p_account_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

ALTER FUNCTION public.platform_update_account(UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_update_account(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_update_account(UUID, JSONB) TO authenticated, service_role;
