-- ============================================================
-- 038_internal_chat.sql — Internal team chat (module
-- `internal_chat`): 1-to-1 conversations between members of the
-- same account, with presence, delivery and read receipts.
--
-- Spec: docs/superpowers/specs/2026-09-14-internal-chat-design.md
--       sections "Módulo", "Dados — fase 1", "Entrega e leitura"
--
-- What this migration does
--   1. Creates `chat_threads` (direct today, groups in phase 2),
--      `chat_thread_members`, `chat_messages` and the phase-2
--      `chat_message_receipts` (created now so the shape is fixed;
--      unused by phase 1).
--   2. Adds `profiles.last_seen_at` — the presence heartbeat fallback
--      ("last seen X ago" when the user is not on the presence channel).
--   3. `is_chat_thread_member(thread_id)` SECURITY DEFINER helper so
--      the RLS policies can test membership without recursing into
--      `chat_thread_members`' own policy.
--   4. `chat_get_or_create_direct_thread(other_user_id)` — validates
--      both users belong to the caller's account, finds the direct
--      thread for the pair or creates it (+ both member rows). The
--      pair is stored ordered in `direct_user_a < direct_user_b` with a
--      partial unique index so a race can never produce duplicates.
--   5. Triggers: BEFORE INSERT on chat_messages stamps `account_id`
--      from the thread; BEFORE UPDATE lets the recipient touch only
--      `delivered_at` / `read_at` (monotonic, read implies delivered);
--      AFTER INSERT refreshes `last_message_at` / `last_message_preview`
--      on the thread.
--   6. RLS: threads / members / messages readable by thread members;
--      messages insertable by the sender when a member; delivery /
--      read updates by the recipient only; a member updates their own
--      `last_read_at`.
--   7. Realtime: chat_messages + chat_threads join the publication.
--   8. Redefines `platform_update_account` (037 body) with
--      `internal_chat` in the overridable modules.
--
-- Does NOT touch `handle_new_user`.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- PROFILES.last_seen_at (presence heartbeat fallback)
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- ============================================================
-- CHAT_THREADS
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_threads (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL DEFAULT 'direct',
  title                 TEXT,
  created_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Ordered pair for direct threads (a < b); NULL on groups.
  direct_user_a         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  direct_user_b         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at       TIMESTAMPTZ,
  last_message_preview  TEXT
);

ALTER TABLE chat_threads DROP CONSTRAINT IF EXISTS chat_threads_kind_check;
ALTER TABLE chat_threads ADD CONSTRAINT chat_threads_kind_check
  CHECK (kind IN ('direct', 'group'));

ALTER TABLE chat_threads DROP CONSTRAINT IF EXISTS chat_threads_direct_pair_check;
ALTER TABLE chat_threads ADD CONSTRAINT chat_threads_direct_pair_check
  CHECK (
    (kind = 'direct' AND direct_user_a IS NOT NULL AND direct_user_b IS NOT NULL AND direct_user_a < direct_user_b)
    OR (kind <> 'direct' AND direct_user_a IS NULL AND direct_user_b IS NULL)
  );

-- One direct thread per pair per account.
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_threads_direct_pair
  ON chat_threads(account_id, direct_user_a, direct_user_b)
  WHERE kind = 'direct';

CREATE INDEX IF NOT EXISTS idx_chat_threads_account_activity
  ON chat_threads(account_id, last_message_at DESC NULLS LAST);

DROP TRIGGER IF EXISTS set_updated_at ON chat_threads;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON chat_threads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- CHAT_THREAD_MEMBERS
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_thread_members (
  thread_id     UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_read_at  TIMESTAMPTZ,
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_thread_members_user ON chat_thread_members(user_id);

ALTER TABLE chat_thread_members ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- CHAT_MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_messages (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_id     UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  -- Phase 2 (edit / delete / attachments) — reserved, unused today.
  edited_at     TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,
  attachment    JSONB
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created
  ON chat_messages(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_account_created
  ON chat_messages(account_id, created_at DESC);
-- Unread badge: messages with no read receipt yet.
CREATE INDEX IF NOT EXISTS idx_chat_messages_unread
  ON chat_messages(thread_id, sender_id)
  WHERE read_at IS NULL;

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- CHAT_MESSAGE_RECEIPTS (phase 2 — groups). Created now so the
-- shape is fixed; phase 1 uses delivered_at / read_at on the message.
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_message_receipts (
  message_id    UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);

ALTER TABLE chat_message_receipts ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- is_chat_thread_member(thread_id)
--
-- SECURITY DEFINER so policies on chat_thread_members / chat_messages
-- can test membership without recursive RLS evaluation.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_chat_thread_member(p_thread_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM chat_thread_members m
    WHERE m.thread_id = p_thread_id
      AND m.user_id = auth.uid()
  );
$$;

ALTER FUNCTION public.is_chat_thread_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_chat_thread_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_chat_thread_member(UUID) TO authenticated, service_role;

-- ============================================================
-- RLS — threads, members, messages, receipts
-- ============================================================
DROP POLICY IF EXISTS chat_threads_select ON chat_threads;
CREATE POLICY chat_threads_select ON chat_threads FOR SELECT
  USING (is_chat_thread_member(id));
-- No INSERT / UPDATE / DELETE policies: direct threads are created
-- through chat_get_or_create_direct_thread (SECURITY DEFINER) and the
-- preview columns are maintained by a trigger. Phase 2 adds group
-- policies.

DROP POLICY IF EXISTS chat_thread_members_select ON chat_thread_members;
CREATE POLICY chat_thread_members_select ON chat_thread_members FOR SELECT
  USING (is_chat_thread_member(thread_id));
-- A member can only touch their own row (last_read_at).
DROP POLICY IF EXISTS chat_thread_members_update ON chat_thread_members;
CREATE POLICY chat_thread_members_update ON chat_thread_members FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND is_chat_thread_member(thread_id));

DROP POLICY IF EXISTS chat_messages_select ON chat_messages;
CREATE POLICY chat_messages_select ON chat_messages FOR SELECT
  USING (is_chat_thread_member(thread_id));
DROP POLICY IF EXISTS chat_messages_insert ON chat_messages;
CREATE POLICY chat_messages_insert ON chat_messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND is_chat_thread_member(thread_id)
    AND is_account_member(account_id)
  );
-- Delivery / read receipts: only the *recipient* updates a message
-- (the trigger below restricts which columns can change on this path).
DROP POLICY IF EXISTS chat_messages_update ON chat_messages;
CREATE POLICY chat_messages_update ON chat_messages FOR UPDATE
  USING (is_chat_thread_member(thread_id) AND sender_id <> auth.uid())
  WITH CHECK (is_chat_thread_member(thread_id) AND sender_id <> auth.uid());

DROP POLICY IF EXISTS chat_message_receipts_select ON chat_message_receipts;
CREATE POLICY chat_message_receipts_select ON chat_message_receipts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM chat_messages msg
      WHERE msg.id = chat_message_receipts.message_id
        AND is_chat_thread_member(msg.thread_id)
    )
  );

-- ============================================================
-- chat_messages BEFORE INSERT — stamp account_id from the thread
-- (and refuse a thread the sender does not belong to, belt and
-- braces on top of the INSERT policy).
-- ============================================================
CREATE OR REPLACE FUNCTION public.chat_messages_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  SELECT account_id INTO v_account_id FROM chat_threads WHERE id = NEW.thread_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Chat thread not found' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chat_thread_members WHERE thread_id = NEW.thread_id AND user_id = NEW.sender_id
  ) THEN
    RAISE EXCEPTION 'Sender is not a member of the thread' USING ERRCODE = '42501';
  END IF;
  NEW.account_id := v_account_id;
  IF NEW.body IS NULL OR btrim(NEW.body) = '' THEN
    RAISE EXCEPTION 'Message body cannot be empty' USING ERRCODE = '22023';
  END IF;
  -- Receipts start empty regardless of what the client sent.
  NEW.delivered_at := NULL;
  NEW.read_at := NULL;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.chat_messages_before_insert() OWNER TO postgres;

DROP TRIGGER IF EXISTS chat_messages_before_insert ON chat_messages;
CREATE TRIGGER chat_messages_before_insert BEFORE INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_messages_before_insert();

-- ============================================================
-- chat_messages BEFORE UPDATE — the recipient path may only move
-- delivered_at / read_at forward. Anyone other than the sender
-- (which is everyone the UPDATE policy admits in phase 1) gets
-- body / sender / thread / account / created_at and the phase-2
-- columns pinned to their old values. Read implies delivered.
-- ============================================================
CREATE OR REPLACE FUNCTION public.chat_messages_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS DISTINCT FROM OLD.sender_id THEN
    NEW.body        := OLD.body;
    NEW.sender_id   := OLD.sender_id;
    NEW.thread_id   := OLD.thread_id;
    NEW.account_id  := OLD.account_id;
    NEW.created_at  := OLD.created_at;
    NEW.edited_at   := OLD.edited_at;
    NEW.deleted_at  := OLD.deleted_at;
    NEW.attachment  := OLD.attachment;
  END IF;
  -- Receipts are monotonic: once stamped they never clear or move.
  NEW.delivered_at := COALESCE(OLD.delivered_at, NEW.delivered_at);
  NEW.read_at      := COALESCE(OLD.read_at, NEW.read_at);
  IF NEW.read_at IS NOT NULL AND NEW.delivered_at IS NULL THEN
    NEW.delivered_at := NEW.read_at;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.chat_messages_before_update() OWNER TO postgres;

DROP TRIGGER IF EXISTS chat_messages_before_update ON chat_messages;
CREATE TRIGGER chat_messages_before_update BEFORE UPDATE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_messages_before_update();

-- ============================================================
-- chat_messages AFTER INSERT — refresh the thread's preview.
-- SECURITY DEFINER because members have no UPDATE policy on threads.
-- ============================================================
CREATE OR REPLACE FUNCTION public.chat_messages_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE chat_threads
  SET last_message_at = NEW.created_at,
      last_message_preview = left(regexp_replace(NEW.body, '\s+', ' ', 'g'), 120)
  WHERE id = NEW.thread_id
    AND (last_message_at IS NULL OR last_message_at <= NEW.created_at);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.chat_messages_after_insert() OWNER TO postgres;

DROP TRIGGER IF EXISTS chat_messages_after_insert ON chat_messages;
CREATE TRIGGER chat_messages_after_insert AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_messages_after_insert();

-- ============================================================
-- chat_get_or_create_direct_thread(other_user_id) → thread id
--
-- Both users must belong to the caller's account. Finds the direct
-- thread for the (ordered) pair or creates it with both member rows.
-- ON CONFLICT on the partial unique index makes a concurrent double
-- call converge on the same row.
-- ============================================================
CREATE OR REPLACE FUNCTION public.chat_get_or_create_direct_thread(p_other_user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me         UUID := auth.uid();
  v_account_id UUID;
  v_a          UUID;
  v_b          UUID;
  v_thread_id  UUID;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_other_user_id IS NULL OR p_other_user_id = v_me THEN
    RAISE EXCEPTION 'other_user_id must be another user' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_me;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE user_id = p_other_user_id AND account_id = v_account_id
  ) THEN
    RAISE EXCEPTION 'User is not a member of this account' USING ERRCODE = '42501';
  END IF;

  v_a := LEAST(v_me, p_other_user_id);
  v_b := GREATEST(v_me, p_other_user_id);

  SELECT id INTO v_thread_id
  FROM chat_threads
  WHERE account_id = v_account_id
    AND kind = 'direct'
    AND direct_user_a = v_a
    AND direct_user_b = v_b;
  IF v_thread_id IS NOT NULL THEN
    RETURN v_thread_id;
  END IF;

  INSERT INTO chat_threads (account_id, kind, created_by, direct_user_a, direct_user_b)
  VALUES (v_account_id, 'direct', v_me, v_a, v_b)
  ON CONFLICT (account_id, direct_user_a, direct_user_b) WHERE kind = 'direct' DO NOTHING
  RETURNING id INTO v_thread_id;

  IF v_thread_id IS NULL THEN
    -- Lost the race — the other call created it.
    SELECT id INTO v_thread_id
    FROM chat_threads
    WHERE account_id = v_account_id
      AND kind = 'direct'
      AND direct_user_a = v_a
      AND direct_user_b = v_b;
    RETURN v_thread_id;
  END IF;

  INSERT INTO chat_thread_members (thread_id, user_id)
  VALUES (v_thread_id, v_a), (v_thread_id, v_b)
  ON CONFLICT DO NOTHING;

  RETURN v_thread_id;
END;
$$;

ALTER FUNCTION public.chat_get_or_create_direct_thread(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_get_or_create_direct_thread(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_get_or_create_direct_thread(UUID) TO authenticated, service_role;

-- ============================================================
-- REALTIME
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_threads'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_threads;
  END IF;
END;
$$;

-- ============================================================
-- platform_update_account — 037 body + `internal_chat` as an
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
    'channel_official', 'channel_qr', 'lead_capture', 'white_label', 'internal_chat'
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
