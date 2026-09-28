-- ============================================================
-- 058_ai_foundations.sql — AI phase 1: foundations + "Sugerir
-- resposta" (suggested reply) in the inbox. Module `ai`.
--
-- Decisions (product):
--   * Each account brings its OWN provider API key (OpenAI or
--     Anthropic). There is no platform key and no fallback to env keys.
--   * Nothing here stores prompt or response text. `ai_usage` is a
--     cost/usage ledger only (tokens, cost, status, error code).
--
-- What this migration does
--   1. `ai_provider_credentials` — one row per (account, provider) with
--      the API key encrypted at rest (AES-256-GCM through
--      src/lib/whatsapp/encryption.ts, `api_key_enc`) plus `last4`.
--      RLS on with NO policies and no grants for anon/authenticated:
--      only the service role (API routes) reads or writes it.
--   2. `ai_provider_credentials_public` — same rows minus `api_key_enc`,
--      visible to admin+ of the account (Settings → IA).
--   3. `ai_settings` — one row per account: enabled, provider, model,
--      assistant instructions, monthly budget (USD cents), history
--      window and the LGPD consent stamp (international transfer of
--      conversation text to the chosen provider). Members read (the
--      composer needs to know whether AI is on), admin+ write. A CHECK
--      makes "enabled" impossible without a consent given for the
--      provider currently selected; a trigger stamps who/when.
--   4. `ai_usage` — append-only ledger. Admin+ read; only the service
--      role writes.
--   5. `ai_usage_summary(account, since)` — aggregate for the budget
--      check and the Settings usage card (SECURITY INVOKER: RLS applies
--      to authenticated callers).
--   6. Redefines `platform_update_account` (040 body) with `ai` as an
--      overridable module (keep in sync with OPTIONAL_MODULES in
--      src/lib/plans.ts).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- AI_PROVIDER_CREDENTIALS
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_provider_credentials (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  api_key_enc   TEXT NOT NULL,
  last4         TEXT NOT NULL,
  validated_at  TIMESTAMPTZ,
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_provider_credentials DROP CONSTRAINT IF EXISTS ai_provider_credentials_provider_check;
ALTER TABLE ai_provider_credentials ADD CONSTRAINT ai_provider_credentials_provider_check
  CHECK (provider IN ('openai', 'anthropic'));

ALTER TABLE ai_provider_credentials DROP CONSTRAINT IF EXISTS ai_provider_credentials_last4_check;
ALTER TABLE ai_provider_credentials ADD CONSTRAINT ai_provider_credentials_last4_check
  CHECK (char_length(last4) BETWEEN 1 AND 4);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_provider_credentials_account_provider
  ON ai_provider_credentials(account_id, provider);

DROP TRIGGER IF EXISTS set_updated_at ON ai_provider_credentials;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_provider_credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS on, no policies: the encrypted key never reaches PostgREST for
-- anon/authenticated. The service role bypasses RLS.
ALTER TABLE ai_provider_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ai_provider_credentials FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE ai_provider_credentials TO service_role;

-- What an admin may see: everything but the ciphertext. Owned by
-- postgres (no security_invoker) so it can read the locked table; the
-- WHERE clause is the access rule and `security_barrier` keeps a leaky
-- function from peeking past it.
CREATE OR REPLACE VIEW ai_provider_credentials_public
WITH (security_barrier = true) AS
  SELECT
    id,
    account_id,
    provider,
    last4,
    validated_at,
    created_by,
    created_at,
    updated_at
  FROM ai_provider_credentials
  WHERE is_account_member(account_id, 'admin');

ALTER VIEW ai_provider_credentials_public OWNER TO postgres;
ALTER VIEW ai_provider_credentials_public SET (security_barrier = true);
-- A simple view is auto-updatable and Supabase's default privileges
-- hand INSERT/UPDATE/DELETE to `authenticated`: through the view an
-- admin could rewrite `account_id` and move a key into another account
-- (the view owner bypasses the base table's RLS). Read-only, always.
REVOKE ALL ON ai_provider_credentials_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON ai_provider_credentials_public TO authenticated, service_role;

-- ============================================================
-- AI_SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_settings (
  account_id                UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled                   BOOLEAN NOT NULL DEFAULT FALSE,
  provider                  TEXT,
  model                     TEXT,
  instructions              TEXT,
  -- USD cents per calendar month (America/Sao_Paulo). 0 blocks every call.
  monthly_budget_cents      INTEGER NOT NULL DEFAULT 1000,
  suggest_history_messages  INTEGER NOT NULL DEFAULT 20,
  -- LGPD: the admin accepted that conversation text is sent to
  -- `consent_provider` (international transfer). Re-consent is needed
  -- when the provider changes.
  consent_provider          TEXT,
  consented_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  consented_at              TIMESTAMPTZ,
  updated_by                UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_settings DROP CONSTRAINT IF EXISTS ai_settings_provider_check;
ALTER TABLE ai_settings ADD CONSTRAINT ai_settings_provider_check
  CHECK (provider IS NULL OR provider IN ('openai', 'anthropic'));

ALTER TABLE ai_settings DROP CONSTRAINT IF EXISTS ai_settings_consent_provider_check;
ALTER TABLE ai_settings ADD CONSTRAINT ai_settings_consent_provider_check
  CHECK (consent_provider IS NULL OR consent_provider IN ('openai', 'anthropic'));

ALTER TABLE ai_settings DROP CONSTRAINT IF EXISTS ai_settings_model_check;
ALTER TABLE ai_settings ADD CONSTRAINT ai_settings_model_check
  CHECK (model IS NULL OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$');

ALTER TABLE ai_settings DROP CONSTRAINT IF EXISTS ai_settings_instructions_check;
ALTER TABLE ai_settings ADD CONSTRAINT ai_settings_instructions_check
  CHECK (instructions IS NULL OR char_length(instructions) <= 4000);

ALTER TABLE ai_settings DROP CONSTRAINT IF EXISTS ai_settings_budget_check;
ALTER TABLE ai_settings ADD CONSTRAINT ai_settings_budget_check
  CHECK (monthly_budget_cents BETWEEN 0 AND 1000000);

ALTER TABLE ai_settings DROP CONSTRAINT IF EXISTS ai_settings_history_check;
ALTER TABLE ai_settings ADD CONSTRAINT ai_settings_history_check
  CHECK (suggest_history_messages BETWEEN 1 AND 50);

-- Enabled requires a provider, a model and a consent given for THAT
-- provider — enforced here so no code path can skip the LGPD notice.
ALTER TABLE ai_settings DROP CONSTRAINT IF EXISTS ai_settings_enabled_requires_consent;
ALTER TABLE ai_settings ADD CONSTRAINT ai_settings_enabled_requires_consent
  CHECK (
    NOT enabled
    OR (
      provider IS NOT NULL
      AND model IS NOT NULL
      AND consented_at IS NOT NULL
      AND consent_provider = provider
    )
  );

DROP TRIGGER IF EXISTS set_updated_at ON ai_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Consent stamp: when a signed-in user sets/changes the consent, the
-- server clock and the caller's uid win over whatever was sent, so the
-- record says who actually accepted the notice and when. Any other
-- update by a signed-in user keeps the previous stamp (no forging
-- `consented_by`), and `updated_by` is always the caller.
CREATE OR REPLACE FUNCTION public.ai_settings_stamp_consent()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.consented_at IS NULL THEN
    NEW.consented_by := NULL;
    NEW.consent_provider := NULL;
  ELSIF TG_OP = 'INSERT'
     OR NEW.consented_at IS DISTINCT FROM OLD.consented_at
     OR NEW.consent_provider IS DISTINCT FROM OLD.consent_provider THEN
    NEW.consented_at := NOW();
    IF auth.uid() IS NOT NULL THEN
      NEW.consented_by := auth.uid();
    END IF;
  ELSIF auth.uid() IS NOT NULL THEN
    NEW.consented_by := OLD.consented_by;
  END IF;
  IF auth.uid() IS NOT NULL THEN
    NEW.updated_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_settings_stamp_consent ON ai_settings;
CREATE TRIGGER ai_settings_stamp_consent BEFORE INSERT OR UPDATE ON ai_settings
  FOR EACH ROW EXECUTE FUNCTION public.ai_settings_stamp_consent();

ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_settings_select ON ai_settings;
CREATE POLICY ai_settings_select ON ai_settings FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_settings_insert ON ai_settings;
CREATE POLICY ai_settings_insert ON ai_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_settings_update ON ai_settings;
CREATE POLICY ai_settings_update ON ai_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_settings_delete ON ai_settings;
CREATE POLICY ai_settings_delete ON ai_settings FOR DELETE
  USING (is_account_member(account_id, 'admin'));

REVOKE ALL ON TABLE ai_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ai_settings TO authenticated;
GRANT ALL ON TABLE ai_settings TO service_role;

-- ============================================================
-- AI_USAGE — cost/usage ledger. NO prompt or response text.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_usage (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE SET NULL,
  feature          TEXT NOT NULL,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_cents       NUMERIC(12, 4) NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,
  error_code       TEXT,
  latency_ms       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_feature_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_feature_check
  CHECK (feature IN ('suggest_reply'));

ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_provider_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_provider_check
  CHECK (provider IN ('openai', 'anthropic'));

ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_status_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_status_check
  CHECK (status IN ('ok', 'error', 'blocked'));

ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_tokens_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_tokens_check
  CHECK (input_tokens >= 0 AND output_tokens >= 0 AND cost_cents >= 0);

ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_error_code_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_error_code_check
  CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$');

CREATE INDEX IF NOT EXISTS idx_ai_usage_account_created
  ON ai_usage(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_conversation
  ON ai_usage(conversation_id) WHERE conversation_id IS NOT NULL;

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_usage_select ON ai_usage;
CREATE POLICY ai_usage_select ON ai_usage FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- Writes: service role only (no INSERT/UPDATE/DELETE policy and no
-- grant for authenticated).
REVOKE ALL ON TABLE ai_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE ai_usage TO authenticated;
GRANT ALL ON TABLE ai_usage TO service_role;

-- ============================================================
-- ai_usage_summary(account, since) — calls/tokens/cost since `since`.
-- SECURITY INVOKER: an authenticated caller only sees what RLS lets
-- them (admin+ of their account); the service role sees everything.
-- `blocked` rows (budget refusals, never sent) are not counted.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ai_usage_summary(
  p_account_id UUID,
  p_since TIMESTAMPTZ
) RETURNS TABLE (
  calls          BIGINT,
  errors         BIGINT,
  input_tokens   BIGINT,
  output_tokens  BIGINT,
  cost_cents     NUMERIC
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    COUNT(*) FILTER (WHERE u.status IN ('ok', 'error'))::BIGINT,
    COUNT(*) FILTER (WHERE u.status = 'error')::BIGINT,
    COALESCE(SUM(u.input_tokens), 0)::BIGINT,
    COALESCE(SUM(u.output_tokens), 0)::BIGINT,
    COALESCE(SUM(u.cost_cents), 0)::NUMERIC
  FROM ai_usage u
  WHERE u.account_id = p_account_id
    AND u.created_at >= p_since;
$$;

REVOKE ALL ON FUNCTION public.ai_usage_summary(UUID, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_usage_summary(UUID, TIMESTAMPTZ) TO authenticated, service_role;

-- ============================================================
-- platform_update_account — 040 body + `ai` as an overridable module
-- (keep `v_allowed_modules` in sync with OPTIONAL_MODULES in
-- src/lib/plans.ts).
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
    'channel_official', 'channel_qr', 'lead_capture', 'white_label', 'internal_chat',
    'calendar', 'ai'
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
