-- ============================================================
-- 027_tasks.sql — Tasks module (free-standing or linked to a
-- contact / conversation / deal), with per-account statuses.
--
-- Spec: docs/superpowers/specs/2026-09-13-tasks-module-design.md
--
-- What this migration does
--   1. Creates `task_statuses` — the account's columns (like
--      pipeline stages). Each has a `kind` (open / in_progress /
--      done); the app keeps at least one status of each kind.
--   2. Creates `tasks` and `task_comments`.
--   3. `seed_task_statuses(account_id)` seeds the three defaults
--      ("A fazer", "Em andamento", "Concluída") when the account
--      has none yet; backfills every existing account.
--   4. Trigger: a task moved onto a `done` status gets
--      `completed_at`; leaving `done` clears it.
--   5. RLS: viewer+ reads, agent+ writes tasks / comments, admin+
--      writes statuses (same tiers as deals / pipeline stages).
--   6. Realtime: tasks + task_comments join the publication.
--   7. Redefines `handle_new_user` (025 body + status seed) and
--      `platform_update_account` (025 body + `tasks` in the list
--      of overridable modules).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- TASK_STATUSES
-- ============================================================
CREATE TABLE IF NOT EXISTS task_statuses (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#3b82f6',
  position    INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'open',
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE task_statuses DROP CONSTRAINT IF EXISTS task_statuses_kind_check;
ALTER TABLE task_statuses ADD CONSTRAINT task_statuses_kind_check
  CHECK (kind IN ('open', 'in_progress', 'done'));

-- Deferrable so a reorder can swap positions inside one transaction
-- (the app upserts the whole list at once).
ALTER TABLE task_statuses DROP CONSTRAINT IF EXISTS task_statuses_account_position_key;
ALTER TABLE task_statuses ADD CONSTRAINT task_statuses_account_position_key
  UNIQUE (account_id, position) DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_task_statuses_account ON task_statuses(account_id, position);

DROP TRIGGER IF EXISTS set_updated_at ON task_statuses;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON task_statuses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE task_statuses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_statuses_select ON task_statuses;
CREATE POLICY task_statuses_select ON task_statuses FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS task_statuses_insert ON task_statuses;
CREATE POLICY task_statuses_insert ON task_statuses FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS task_statuses_update ON task_statuses;
CREATE POLICY task_statuses_update ON task_statuses FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS task_statuses_delete ON task_statuses;
CREATE POLICY task_statuses_delete ON task_statuses FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- TASKS
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status_id         UUID NOT NULL REFERENCES task_statuses(id) ON DELETE RESTRICT,
  title             TEXT NOT NULL,
  description       TEXT,
  priority          TEXT NOT NULL DEFAULT 'normal',
  assignee_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
  deal_id           UUID REFERENCES deals(id) ON DELETE SET NULL,
  due_at            TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_priority_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check
  CHECK (priority IN ('low', 'normal', 'high', 'urgent'));

CREATE INDEX IF NOT EXISTS idx_tasks_account_status_position ON tasks(account_id, status_id, position);
CREATE INDEX IF NOT EXISTS idx_tasks_account_assignee_due ON tasks(account_id, assignee_user_id, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_contact ON tasks(contact_id);
CREATE INDEX IF NOT EXISTS idx_tasks_deal ON tasks(deal_id);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);

DROP TRIGGER IF EXISTS set_updated_at ON tasks;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_select ON tasks;
CREATE POLICY tasks_select ON tasks FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS tasks_insert ON tasks;
CREATE POLICY tasks_insert ON tasks FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS tasks_update ON tasks;
CREATE POLICY tasks_update ON tasks FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS tasks_delete ON tasks;
CREATE POLICY tasks_delete ON tasks FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ============================================================
-- TASK_COMMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS task_comments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at);

ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_comments_select ON task_comments;
CREATE POLICY task_comments_select ON task_comments FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS task_comments_insert ON task_comments;
CREATE POLICY task_comments_insert ON task_comments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS task_comments_update ON task_comments;
CREATE POLICY task_comments_update ON task_comments FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS task_comments_delete ON task_comments;
CREATE POLICY task_comments_delete ON task_comments FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- ============================================================
-- completed_at trigger
--
-- Moving onto a `done` status stamps completed_at (kept if already
-- set so re-saving a finished task doesn't rewrite the time);
-- moving off `done` clears it.
-- ============================================================
CREATE OR REPLACE FUNCTION public.tasks_sync_completed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind TEXT;
BEGIN
  SELECT kind INTO v_kind FROM task_statuses WHERE id = NEW.status_id;
  IF v_kind = 'done' THEN
    IF NEW.completed_at IS NULL THEN
      NEW.completed_at := NOW();
    END IF;
  ELSE
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.tasks_sync_completed_at() OWNER TO postgres;

DROP TRIGGER IF EXISTS tasks_sync_completed_at ON tasks;
CREATE TRIGGER tasks_sync_completed_at BEFORE INSERT OR UPDATE OF status_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION public.tasks_sync_completed_at();

-- ============================================================
-- seed_task_statuses(account_id)
--
-- Creates the three default statuses for an account that has none.
-- No-op when the account already has statuses, so it is safe from
-- both the backfill below and the signup trigger.
-- ============================================================
CREATE OR REPLACE FUNCTION public.seed_task_statuses(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM task_statuses WHERE account_id = p_account_id) THEN
    RETURN;
  END IF;
  INSERT INTO task_statuses (account_id, name, color, position, kind, is_default) VALUES
    (p_account_id, 'A fazer',      '#3b82f6', 0, 'open',        TRUE),
    (p_account_id, 'Em andamento', '#f59e0b', 1, 'in_progress', FALSE),
    (p_account_id, 'Concluída',    '#22c55e', 2, 'done',        FALSE);
END;
$$;

ALTER FUNCTION public.seed_task_statuses(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.seed_task_statuses(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_task_statuses(UUID) TO authenticated, service_role;

-- Backfill every existing account.
DO $$
DECLARE
  v_account RECORD;
BEGIN
  FOR v_account IN SELECT id FROM accounts LOOP
    PERFORM public.seed_task_statuses(v_account.id);
  END LOOP;
END;
$$;

-- ============================================================
-- REALTIME
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE tasks;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'task_comments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE task_comments;
  END IF;
END;
$$;

-- ============================================================
-- SIGNUP TRIGGER — 025 body + task status seed
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

-- ============================================================
-- platform_update_account — 025 body + `tasks` as an overridable
-- module (keep `v_allowed_modules` in sync with OPTIONAL_MODULES
-- in src/lib/plans.ts).
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
