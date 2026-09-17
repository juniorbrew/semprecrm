-- ============================================================
-- 031_deal_loss_reasons.sql — "Motivo de perda" for deals.
--
-- Spec: docs/superpowers/specs/2026-09-13-parity-round1-design.md
--       (section 6)
--
-- What this migration does
--   1. Creates `deal_loss_reasons` — the account's list of reasons a
--      deal can be lost for (renamable, reorderable, activatable).
--   2. Adds `deals.loss_reason_id` (→ deal_loss_reasons, SET NULL) and
--      `deals.lost_note`.
--   3. `seed_deal_loss_reasons(account_id)` seeds the five defaults
--      ("Preço", "Sem resposta", "Escolheu concorrente", "Sem
--      interesse", "Outro") when the account has none yet; backfills
--      every existing account.
--   4. RLS: viewer+ reads, admin+ writes (same tier as task statuses
--      and pipeline stages).
--   5. Redefines `handle_new_user` (027 body + loss reason seed) so
--      new accounts start with the defaults.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- DEAL_LOSS_REASONS
-- ============================================================
CREATE TABLE IF NOT EXISTS deal_loss_reasons (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deferrable so a reorder can swap positions inside one statement
-- (the app upserts the whole list at once).
ALTER TABLE deal_loss_reasons DROP CONSTRAINT IF EXISTS deal_loss_reasons_account_position_key;
ALTER TABLE deal_loss_reasons ADD CONSTRAINT deal_loss_reasons_account_position_key
  UNIQUE (account_id, position) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_deal_loss_reasons_account
  ON deal_loss_reasons(account_id, position);

ALTER TABLE deal_loss_reasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_loss_reasons_select ON deal_loss_reasons;
CREATE POLICY deal_loss_reasons_select ON deal_loss_reasons FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS deal_loss_reasons_insert ON deal_loss_reasons;
CREATE POLICY deal_loss_reasons_insert ON deal_loss_reasons FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS deal_loss_reasons_update ON deal_loss_reasons;
CREATE POLICY deal_loss_reasons_update ON deal_loss_reasons FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS deal_loss_reasons_delete ON deal_loss_reasons;
CREATE POLICY deal_loss_reasons_delete ON deal_loss_reasons FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- DEALS — loss_reason_id + lost_note
-- ============================================================
ALTER TABLE deals ADD COLUMN IF NOT EXISTS loss_reason_id UUID
  REFERENCES deal_loss_reasons(id) ON DELETE SET NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_note TEXT;

CREATE INDEX IF NOT EXISTS idx_deals_loss_reason ON deals(loss_reason_id);

-- ============================================================
-- seed_deal_loss_reasons(account_id)
--
-- Creates the five default reasons for an account that has none.
-- No-op when the account already has reasons, so it is safe from
-- both the backfill below and the signup trigger.
-- ============================================================
CREATE OR REPLACE FUNCTION public.seed_deal_loss_reasons(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM deal_loss_reasons WHERE account_id = p_account_id) THEN
    RETURN;
  END IF;
  INSERT INTO deal_loss_reasons (account_id, name, position) VALUES
    (p_account_id, 'Preço',                0),
    (p_account_id, 'Sem resposta',         1),
    (p_account_id, 'Escolheu concorrente', 2),
    (p_account_id, 'Sem interesse',        3),
    (p_account_id, 'Outro',                4);
END;
$$;

ALTER FUNCTION public.seed_deal_loss_reasons(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.seed_deal_loss_reasons(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_deal_loss_reasons(UUID) TO authenticated, service_role;

-- Backfill every existing account.
DO $$
DECLARE
  v_account RECORD;
BEGIN
  FOR v_account IN SELECT id FROM accounts LOOP
    PERFORM public.seed_deal_loss_reasons(v_account.id);
  END LOOP;
END;
$$;

-- ============================================================
-- SIGNUP TRIGGER — 027 body + loss reason seed
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

  PERFORM public.seed_task_statuses(v_account_id);
  PERFORM public.seed_deal_loss_reasons(v_account_id);

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
