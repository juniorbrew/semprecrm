-- ============================================================
-- 025_plans_and_platform_admin.sql — Plans, per-account modules
-- and the platform (master) admin layer.
--
-- Spec: docs/superpowers/specs/2026-09-12-plans-modules-platform-admin-design.md
--
-- What this migration does
--   1. Adds the plan columns to `accounts`:
--        plan, plan_status, plan_expires_at,
--        module_overrides, limit_overrides, platform_notes
--   2. Creates `platform_admins` — a platform admin is a normal
--      auth user whose id is listed here (no env-var password).
--   3. Adds `is_platform_admin()` (SECURITY DEFINER) and new RLS
--      policies so a platform admin can SELECT/UPDATE every
--      account. Members keep reading only their own account (the
--      017 policies stay untouched).
--   4. Adds the two RPCs the /platform pages call:
--        platform_list_accounts()            — every account + counts
--        platform_update_account(id, patch)  — validated partial update
--   5. Replaces `handle_new_user` so a fresh signup lands on the
--      14-day trial (`plan_expires_at = now() + 14 days`).
--
-- The plan catalogue (which modules / limits each plan grants)
-- lives in code (`src/lib/plans.ts`). The DB only stores the plan
-- name, its status, and the per-account overrides.
--
-- Existing accounts keep `plan_expires_at = NULL` — a trial with
-- no expiry never blocks, so nobody is locked out by the upgrade.
-- The platform admin can set an expiry per account afterwards.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- ACCOUNTS — plan columns
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS plan             TEXT        NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS plan_status      TEXT        NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS plan_expires_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS module_overrides JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS limit_overrides  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS platform_notes   TEXT;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_plan_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_plan_check
  CHECK (plan IN ('trial', 'basico', 'pro', 'empresa'));

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_plan_status_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_plan_status_check
  CHECK (plan_status IN ('trial', 'active', 'past_due', 'canceled', 'suspended'));

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_module_overrides_object;
ALTER TABLE accounts ADD CONSTRAINT accounts_module_overrides_object
  CHECK (jsonb_typeof(module_overrides) = 'object');

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_limit_overrides_object;
ALTER TABLE accounts ADD CONSTRAINT accounts_limit_overrides_object
  CHECK (jsonb_typeof(limit_overrides) = 'object');

CREATE INDEX IF NOT EXISTS idx_accounts_plan_status ON accounts(plan_status);

-- ============================================================
-- PLATFORM_ADMINS
--
-- Promote the first admin by hand (psql / Studio):
--   insert into platform_admins (user_id) values ('<auth.users.id>');
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- is_platform_admin()
--
-- SECURITY DEFINER so policies on `accounts` can consult
-- `platform_admins` without a recursive RLS evaluation.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_admins pa WHERE pa.user_id = auth.uid()
  );
$$;

ALTER FUNCTION public.is_platform_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_platform_admin() TO authenticated, service_role;

-- ============================================================
-- RLS
--
-- platform_admins: a row is readable only by the admin it names
-- (lets the client ask "am I an admin?" cheaply; nobody can list
-- the other admins). No client-side writes — promotion is a
-- manual psql step by design.
--
-- accounts: platform admins may read and update every account.
-- These are additive policies; the 017 member policies stay.
-- ============================================================
DROP POLICY IF EXISTS platform_admins_select_self ON platform_admins;
CREATE POLICY platform_admins_select_self ON platform_admins FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS accounts_platform_select ON accounts;
CREATE POLICY accounts_platform_select ON accounts FOR SELECT
  USING (is_platform_admin());

DROP POLICY IF EXISTS accounts_platform_update ON accounts;
CREATE POLICY accounts_platform_update ON accounts FOR UPDATE
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- ============================================================
-- platform_list_accounts()
--
-- Every account with its owner, plan fields and the two counts
-- the listing shows (members / connected channels), plus the
-- pending-invite count so the master can see how close an
-- account is to its `max_users`.
--
-- Error contract (mirrors 018): 42501 = forbidden.
-- ============================================================
DROP FUNCTION IF EXISTS public.platform_list_accounts();
CREATE OR REPLACE FUNCTION public.platform_list_accounts()
RETURNS TABLE (
  id                    UUID,
  name                  TEXT,
  owner_user_id         UUID,
  owner_email           TEXT,
  owner_name            TEXT,
  plan                  TEXT,
  plan_status           TEXT,
  plan_expires_at       TIMESTAMPTZ,
  module_overrides      JSONB,
  limit_overrides       JSONB,
  platform_notes        TEXT,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ,
  members_count         BIGINT,
  channels_count        BIGINT,
  pending_invites_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.name,
    a.owner_user_id,
    op.email                      AS owner_email,
    op.full_name                  AS owner_name,
    a.plan,
    a.plan_status,
    a.plan_expires_at,
    a.module_overrides,
    a.limit_overrides,
    a.platform_notes,
    a.created_at,
    a.updated_at,
    (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id)            AS members_count,
    (SELECT COUNT(*) FROM whatsapp_config w WHERE w.account_id = a.id)     AS channels_count,
    (SELECT COUNT(*) FROM account_invitations i
       WHERE i.account_id = a.id
         AND i.accepted_at IS NULL
         AND i.expires_at > NOW())                                         AS pending_invites_count
  FROM accounts a
  LEFT JOIN profiles op ON op.user_id = a.owner_user_id
  ORDER BY a.created_at DESC;
END;
$$;

ALTER FUNCTION public.platform_list_accounts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_list_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_list_accounts() TO authenticated, service_role;

-- ============================================================
-- platform_update_account(p_account_id, p_patch)
--
-- Partial update. `p_patch` is a JSON object; only the keys
-- present are applied, so the caller can clear a nullable field
-- by sending an explicit JSON null:
--
--   {"plan": "pro"}
--   {"plan_status": "suspended"}
--   {"plan_expires_at": null}
--   {"module_overrides": {"flows": true, "broadcasts": false}}
--   {"limit_overrides": {"max_users": 5, "max_channels": null}}
--   {"platform_notes": "Pagou via PIX em 12/09"}
--
-- Validation lives here (not only in the CHECK constraints) so
-- the API surfaces a 400-class error with a readable message
-- instead of a constraint violation.
--
-- Error contract (mirrors 018):
--   42501 forbidden, 22023 bad input.
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
    'dashboard', 'pipelines', 'broadcasts', 'automations', 'flows',
    'channel_official', 'channel_qr'
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

-- ============================================================
-- SIGNUP TRIGGER — new accounts start a 14-day trial
--
-- Same body as 017, plus `plan_expires_at`. `plan` / `plan_status`
-- take their column defaults ('trial'). The trigger binding from
-- 017 (`on_auth_user_created`) is untouched; CREATE OR REPLACE
-- swaps the function body in place.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id, plan, plan_status, plan_expires_at)
  VALUES (
    COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'),
    NEW.id,
    'trial',
    'trial',
    NOW() + INTERVAL '14 days'
  )
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
