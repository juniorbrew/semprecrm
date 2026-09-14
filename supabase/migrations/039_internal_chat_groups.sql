-- ============================================================
-- 039_internal_chat_groups.sql — Internal team chat, phase 2:
-- groups, per-member receipts, attachments, reactions, edit /
-- delete.
--
-- Spec: docs/superpowers/specs/2026-09-14-internal-chat-design.md
--       section "Fase 2"
--
-- What this migration does
--   1. `chat_messages.kind` ('text' | 'system'). System lines
--      (group created / members added / removed / left) are stored as
--      messages with a small JSON body (`{"event":"added","users":[…]}`)
--      so the UI can word them in the viewer's language. Only the group
--      RPCs below may insert them (guarded by a transaction-local
--      setting in the BEFORE INSERT trigger).
--   2. Group threads: `chat_create_group`, `chat_add_members`,
--      `chat_remove_member`, `chat_leave_group` (SECURITY DEFINER,
--      account membership validated; the creator or an account admin+
--      manages members; anyone can leave). `chat_thread_members` joins
--      the realtime publication so clients notice membership changes.
--   3. Per-member receipts (`chat_message_receipts`) for group
--      messages: `thread_id` column (stamped by trigger, used by RLS
--      and realtime filters), monotonic stamps, only the row owner
--      writes, never the sender. `chat_mark_delivered(thread)` /
--      `chat_mark_read(thread)` do the right thing for both thread
--      kinds in one round trip and return the ids they touched.
--      `chat_unread_counts()` counts unread per thread for the caller
--      (direct: `read_at`; group: my receipt), excluding system and
--      deleted rows and anything older than my `joined_at`.
--   4. Reactions: `chat_message_reactions` (pk message_id, user_id,
--      emoji), thread members read, own rows write, realtime with
--      REPLICA IDENTITY FULL so DELETE events carry the row.
--   5. Attachments: private bucket `chat-internal` (25 MB; images,
--      audio, video, pdf / office docs, text) with path
--      `account-<id>/chat/<thread>/<uuid>-<name>`; read / upload by
--      thread members only. Messages may have an empty body when an
--      attachment is present; the thread preview then reads
--      "📎 Anexo" / "🎤 Áudio".
--   6. Edit / delete: the BEFORE UPDATE trigger gains a sender path —
--      the sender may change `body` within 15 minutes of `created_at`
--      (stamps `edited_at`) and set `deleted_at` (body emptied,
--      attachment cleared). Everything else stays pinned, and the
--      phase-1 rule that only the recipient moves receipts is kept.
--      The UPDATE policy now admits every member of the thread; the
--      trigger decides what each side may change.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. chat_messages.kind
-- ============================================================
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_kind_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_kind_check
  CHECK (kind IN ('text', 'system'));

-- ============================================================
-- 2. chat_message_receipts — thread_id + monotonic trigger + RLS
-- ============================================================
ALTER TABLE chat_message_receipts ADD COLUMN IF NOT EXISTS thread_id UUID
  REFERENCES chat_threads(id) ON DELETE CASCADE;

-- Backfill (no-op on a fresh install).
UPDATE chat_message_receipts r
SET thread_id = m.thread_id
FROM chat_messages m
WHERE m.id = r.message_id AND r.thread_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_chat_message_receipts_thread_user
  ON chat_message_receipts(thread_id, user_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_receipts_user_read
  ON chat_message_receipts(user_id, message_id)
  WHERE read_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.chat_message_receipts_before_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_thread_id UUID;
  v_sender_id UUID;
BEGIN
  SELECT thread_id, sender_id INTO v_thread_id, v_sender_id
  FROM chat_messages WHERE id = NEW.message_id;
  IF v_thread_id IS NULL THEN
    RAISE EXCEPTION 'Chat message not found' USING ERRCODE = '22023';
  END IF;
  IF NEW.user_id = v_sender_id THEN
    RAISE EXCEPTION 'The sender does not receive their own message' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chat_thread_members WHERE thread_id = v_thread_id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Receipt owner is not a member of the thread' USING ERRCODE = '42501';
  END IF;
  NEW.thread_id := v_thread_id;
  IF TG_OP = 'UPDATE' THEN
    NEW.message_id   := OLD.message_id;
    NEW.user_id      := OLD.user_id;
    NEW.delivered_at := COALESCE(OLD.delivered_at, NEW.delivered_at);
    NEW.read_at      := COALESCE(OLD.read_at, NEW.read_at);
  END IF;
  IF NEW.read_at IS NOT NULL AND NEW.delivered_at IS NULL THEN
    NEW.delivered_at := NEW.read_at;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.chat_message_receipts_before_write() OWNER TO postgres;

DROP TRIGGER IF EXISTS chat_message_receipts_before_write ON chat_message_receipts;
CREATE TRIGGER chat_message_receipts_before_write
  BEFORE INSERT OR UPDATE ON chat_message_receipts
  FOR EACH ROW EXECUTE FUNCTION public.chat_message_receipts_before_write();

-- Only the row owner writes their receipt (the RPCs below are the
-- normal path; the policies keep a direct upsert equally safe).
DROP POLICY IF EXISTS chat_message_receipts_insert ON chat_message_receipts;
CREATE POLICY chat_message_receipts_insert ON chat_message_receipts FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM chat_messages msg
      WHERE msg.id = chat_message_receipts.message_id
        AND is_chat_thread_member(msg.thread_id)
    )
  );
DROP POLICY IF EXISTS chat_message_receipts_update ON chat_message_receipts;
CREATE POLICY chat_message_receipts_update ON chat_message_receipts FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- 3. chat_message_reactions
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_message_reactions (
  message_id  UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  thread_id   UUID REFERENCES chat_threads(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

ALTER TABLE chat_message_reactions DROP CONSTRAINT IF EXISTS chat_message_reactions_emoji_check;
ALTER TABLE chat_message_reactions ADD CONSTRAINT chat_message_reactions_emoji_check
  CHECK (char_length(emoji) BETWEEN 1 AND 16);

CREATE INDEX IF NOT EXISTS idx_chat_message_reactions_thread
  ON chat_message_reactions(thread_id, message_id);

ALTER TABLE chat_message_reactions ENABLE ROW LEVEL SECURITY;
-- DELETE events must carry the full row for the realtime thread filter.
ALTER TABLE chat_message_reactions REPLICA IDENTITY FULL;

CREATE OR REPLACE FUNCTION public.chat_message_reactions_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_thread_id UUID;
  v_deleted   TIMESTAMPTZ;
BEGIN
  SELECT thread_id, deleted_at INTO v_thread_id, v_deleted FROM chat_messages WHERE id = NEW.message_id;
  IF v_thread_id IS NULL THEN
    RAISE EXCEPTION 'Chat message not found' USING ERRCODE = '22023';
  END IF;
  IF v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot react to a deleted message' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chat_thread_members WHERE thread_id = v_thread_id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'Not a member of the thread' USING ERRCODE = '42501';
  END IF;
  NEW.thread_id := v_thread_id;
  NEW.created_at := NOW();
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.chat_message_reactions_before_insert() OWNER TO postgres;

DROP TRIGGER IF EXISTS chat_message_reactions_before_insert ON chat_message_reactions;
CREATE TRIGGER chat_message_reactions_before_insert
  BEFORE INSERT ON chat_message_reactions
  FOR EACH ROW EXECUTE FUNCTION public.chat_message_reactions_before_insert();

DROP POLICY IF EXISTS chat_message_reactions_select ON chat_message_reactions;
CREATE POLICY chat_message_reactions_select ON chat_message_reactions FOR SELECT
  USING (is_chat_thread_member(thread_id));
DROP POLICY IF EXISTS chat_message_reactions_insert ON chat_message_reactions;
CREATE POLICY chat_message_reactions_insert ON chat_message_reactions FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM chat_messages msg
      WHERE msg.id = chat_message_reactions.message_id
        AND is_chat_thread_member(msg.thread_id)
    )
  );
DROP POLICY IF EXISTS chat_message_reactions_delete ON chat_message_reactions;
CREATE POLICY chat_message_reactions_delete ON chat_message_reactions FOR DELETE
  USING (user_id = auth.uid());

-- ============================================================
-- 4. chat_messages triggers — system rows, attachments, edit / delete
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
  NEW.kind := COALESCE(NEW.kind, 'text');
  -- System lines come only from the group RPCs (transaction-local flag).
  IF NEW.kind = 'system' AND COALESCE(current_setting('chat.system_insert', TRUE), '') <> '1' THEN
    RAISE EXCEPTION 'System messages are written by the chat functions only' USING ERRCODE = '42501';
  END IF;
  IF NEW.kind = 'system' THEN
    NEW.attachment := NULL;
  END IF;
  NEW.body := COALESCE(NEW.body, '');
  IF btrim(NEW.body) = '' AND NEW.attachment IS NULL THEN
    RAISE EXCEPTION 'Message body cannot be empty' USING ERRCODE = '22023';
  END IF;
  IF NEW.attachment IS NOT NULL AND (
    jsonb_typeof(NEW.attachment) <> 'object'
    OR NULLIF(btrim(COALESCE(NEW.attachment->>'path', '')), '') IS NULL
    OR NULLIF(btrim(COALESCE(NEW.attachment->>'mime', '')), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'attachment must carry path and mime' USING ERRCODE = '22023';
  END IF;
  -- Receipts / edit / delete start empty regardless of what the client sent.
  NEW.delivered_at := NULL;
  NEW.read_at := NULL;
  NEW.edited_at := NULL;
  NEW.deleted_at := NULL;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.chat_messages_before_insert() OWNER TO postgres;

-- Sender path: body (edit window) and deleted_at. Recipient path: as
-- in phase 1 (only delivered_at / read_at, monotonic).
CREATE OR REPLACE FUNCTION public.chat_messages_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Immutable on every path.
  NEW.sender_id   := OLD.sender_id;
  NEW.thread_id   := OLD.thread_id;
  NEW.account_id  := OLD.account_id;
  NEW.created_at  := OLD.created_at;
  NEW.kind        := OLD.kind;

  IF auth.uid() IS NOT DISTINCT FROM OLD.sender_id THEN
    -- ---- sender: edit / delete ---------------------------------
    NEW.delivered_at := OLD.delivered_at;
    NEW.read_at      := OLD.read_at;
    IF OLD.deleted_at IS NOT NULL THEN
      -- A deleted message is frozen.
      NEW.body       := OLD.body;
      NEW.attachment := OLD.attachment;
      NEW.edited_at  := OLD.edited_at;
      NEW.deleted_at := OLD.deleted_at;
    ELSIF NEW.deleted_at IS NOT NULL THEN
      IF OLD.kind <> 'text' THEN
        RAISE EXCEPTION 'System messages cannot be deleted' USING ERRCODE = '42501';
      END IF;
      NEW.deleted_at := NOW();
      NEW.body       := '';
      NEW.attachment := NULL;
      NEW.edited_at  := OLD.edited_at;
    ELSE
      NEW.attachment := OLD.attachment;
      IF NEW.body IS DISTINCT FROM OLD.body THEN
        IF OLD.kind <> 'text' THEN
          RAISE EXCEPTION 'System messages cannot be edited' USING ERRCODE = '42501';
        END IF;
        IF NOW() - OLD.created_at > INTERVAL '15 minutes' THEN
          RAISE EXCEPTION 'Messages can be edited for 15 minutes only' USING ERRCODE = '42501';
        END IF;
        IF NEW.body IS NULL OR btrim(NEW.body) = '' THEN
          RAISE EXCEPTION 'Message body cannot be empty' USING ERRCODE = '22023';
        END IF;
        NEW.edited_at := NOW();
      ELSE
        NEW.edited_at := OLD.edited_at;
      END IF;
    END IF;
  ELSE
    -- ---- recipient (or service role): receipts only --------------
    NEW.body        := OLD.body;
    NEW.edited_at   := OLD.edited_at;
    NEW.deleted_at  := OLD.deleted_at;
    NEW.attachment  := OLD.attachment;
    NEW.delivered_at := COALESCE(OLD.delivered_at, NEW.delivered_at);
    NEW.read_at      := COALESCE(OLD.read_at, NEW.read_at);
    IF NEW.read_at IS NOT NULL AND NEW.delivered_at IS NULL THEN
      NEW.delivered_at := NEW.read_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.chat_messages_before_update() OWNER TO postgres;

-- Thread preview: attachments and system lines get a placeholder;
-- system rows still bump last_message_at so the list orders by them.
CREATE OR REPLACE FUNCTION public.chat_messages_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_preview TEXT;
BEGIN
  IF NEW.kind = 'system' THEN
    v_preview := NULL;
  ELSIF btrim(NEW.body) <> '' THEN
    v_preview := left(regexp_replace(NEW.body, '\s+', ' ', 'g'), 120);
  ELSIF COALESCE(NEW.attachment->>'mime', '') LIKE 'audio/%' THEN
    v_preview := '🎤 Áudio';
  ELSE
    v_preview := '📎 Anexo';
  END IF;
  UPDATE chat_threads
  SET last_message_at = NEW.created_at,
      last_message_preview = v_preview
  WHERE id = NEW.thread_id
    AND (last_message_at IS NULL OR last_message_at <= NEW.created_at);
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.chat_messages_after_insert() OWNER TO postgres;

-- Both sides may UPDATE a message now; the trigger decides what each
-- side is allowed to change.
DROP POLICY IF EXISTS chat_messages_update ON chat_messages;
CREATE POLICY chat_messages_update ON chat_messages FOR UPDATE
  USING (is_chat_thread_member(thread_id))
  WITH CHECK (is_chat_thread_member(thread_id));

-- ============================================================
-- 5. Group RPCs
-- ============================================================

-- Creator or account admin+ manages members.
CREATE OR REPLACE FUNCTION public.chat_can_manage_group(p_thread_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM chat_threads t
    WHERE t.id = p_thread_id
      AND t.kind = 'group'
      AND (t.created_by = auth.uid() OR is_account_member(t.account_id, 'admin'))
  );
$$;

ALTER FUNCTION public.chat_can_manage_group(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_can_manage_group(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_can_manage_group(UUID) TO authenticated, service_role;

-- Internal: write a system line as the acting user.
CREATE OR REPLACE FUNCTION public.chat_insert_system_message(
  p_thread_id UUID,
  p_actor UUID,
  p_body JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('chat.system_insert', '1', TRUE);
  -- clock_timestamp(): two lines written by one call (created + added)
  -- keep their order instead of sharing the transaction's now().
  INSERT INTO chat_messages (thread_id, account_id, sender_id, body, kind, created_at)
  SELECT p_thread_id, t.account_id, p_actor, p_body::text, 'system', clock_timestamp()
  FROM chat_threads t WHERE t.id = p_thread_id;
  PERFORM set_config('chat.system_insert', '', TRUE);
END;
$$;

ALTER FUNCTION public.chat_insert_system_message(UUID, UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_insert_system_message(UUID, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_insert_system_message(UUID, UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.chat_create_group(p_title TEXT, p_member_ids UUID[])
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me         UUID := auth.uid();
  v_account_id UUID;
  v_title      TEXT := NULLIF(btrim(COALESCE(p_title, '')), '');
  v_members    UUID[];
  v_thread_id  UUID;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_title IS NULL OR char_length(v_title) > 80 THEN
    RAISE EXCEPTION 'title must be 1-80 characters' USING ERRCODE = '22023';
  END IF;
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_me;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  -- Distinct other members that belong to my account.
  SELECT COALESCE(array_agg(DISTINCT p.user_id), '{}') INTO v_members
  FROM unnest(COALESCE(p_member_ids, '{}')) AS u(id)
  JOIN profiles p ON p.user_id = u.id AND p.account_id = v_account_id
  WHERE u.id <> v_me;
  IF cardinality(v_members) < cardinality(ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_member_ids, '{}')) x WHERE x <> v_me)) THEN
    RAISE EXCEPTION 'Every member must belong to this account' USING ERRCODE = '42501';
  END IF;
  IF cardinality(v_members) = 0 THEN
    RAISE EXCEPTION 'A group needs at least one other member' USING ERRCODE = '22023';
  END IF;

  INSERT INTO chat_threads (account_id, kind, title, created_by)
  VALUES (v_account_id, 'group', v_title, v_me)
  RETURNING id INTO v_thread_id;

  INSERT INTO chat_thread_members (thread_id, user_id)
  SELECT v_thread_id, x FROM unnest(v_members || v_me) AS x
  ON CONFLICT DO NOTHING;

  PERFORM chat_insert_system_message(v_thread_id, v_me, jsonb_build_object('event', 'created'));
  PERFORM chat_insert_system_message(
    v_thread_id, v_me, jsonb_build_object('event', 'added', 'users', to_jsonb(v_members))
  );
  RETURN v_thread_id;
END;
$$;

ALTER FUNCTION public.chat_create_group(TEXT, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_create_group(TEXT, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_create_group(TEXT, UUID[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.chat_add_members(p_thread_id UUID, p_member_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me         UUID := auth.uid();
  v_account_id UUID;
  v_new        UUID[];
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT is_chat_thread_member(p_thread_id) OR NOT chat_can_manage_group(p_thread_id) THEN
    RAISE EXCEPTION 'Only the group creator or an account admin can add members' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_account_id FROM chat_threads WHERE id = p_thread_id;

  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_member_ids, '{}')) AS u(id)
    WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u.id AND p.account_id = v_account_id)
  ) THEN
    RAISE EXCEPTION 'Every member must belong to this account' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT u.id), '{}') INTO v_new
  FROM unnest(COALESCE(p_member_ids, '{}')) AS u(id)
  WHERE NOT EXISTS (
    SELECT 1 FROM chat_thread_members m WHERE m.thread_id = p_thread_id AND m.user_id = u.id
  );
  IF cardinality(v_new) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO chat_thread_members (thread_id, user_id)
  SELECT p_thread_id, x FROM unnest(v_new) AS x
  ON CONFLICT DO NOTHING;

  PERFORM chat_insert_system_message(
    p_thread_id, v_me, jsonb_build_object('event', 'added', 'users', to_jsonb(v_new))
  );
  RETURN cardinality(v_new);
END;
$$;

ALTER FUNCTION public.chat_add_members(UUID, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_add_members(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_add_members(UUID, UUID[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.chat_remove_member(p_thread_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me UUID := auth.uid();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = v_me THEN
    RAISE EXCEPTION 'Use chat_leave_group to leave' USING ERRCODE = '22023';
  END IF;
  IF NOT is_chat_thread_member(p_thread_id) OR NOT chat_can_manage_group(p_thread_id) THEN
    RAISE EXCEPTION 'Only the group creator or an account admin can remove members' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chat_thread_members WHERE thread_id = p_thread_id AND user_id = p_user_id
  ) THEN
    RETURN;
  END IF;
  -- The line is written while the actor is still a member (it always is here).
  PERFORM chat_insert_system_message(
    p_thread_id, v_me, jsonb_build_object('event', 'removed', 'users', to_jsonb(ARRAY[p_user_id]))
  );
  DELETE FROM chat_thread_members WHERE thread_id = p_thread_id AND user_id = p_user_id;
END;
$$;

ALTER FUNCTION public.chat_remove_member(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_remove_member(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_remove_member(UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.chat_leave_group(p_thread_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me UUID := auth.uid();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM chat_threads WHERE id = p_thread_id AND kind = 'group') THEN
    RAISE EXCEPTION 'Not a group' USING ERRCODE = '22023';
  END IF;
  IF NOT is_chat_thread_member(p_thread_id) THEN
    RETURN;
  END IF;
  -- Written before the membership goes (the insert trigger checks it).
  PERFORM chat_insert_system_message(p_thread_id, v_me, jsonb_build_object('event', 'left'));
  DELETE FROM chat_thread_members WHERE thread_id = p_thread_id AND user_id = v_me;
  -- An empty group is gone.
  DELETE FROM chat_threads t
  WHERE t.id = p_thread_id
    AND NOT EXISTS (SELECT 1 FROM chat_thread_members m WHERE m.thread_id = t.id);
END;
$$;

ALTER FUNCTION public.chat_leave_group(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_leave_group(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_leave_group(UUID) TO authenticated, service_role;

-- ============================================================
-- 6. Receipts RPCs — delivered / read for both thread kinds
-- ============================================================

-- Stamp "delivered" on every pending message addressed to me in
-- `p_thread_id` (NULL = every thread I belong to). Returns the ids.
CREATE OR REPLACE FUNCTION public.chat_mark_delivered(p_thread_id UUID DEFAULT NULL)
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me UUID := auth.uid();
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  -- Direct threads: the column on the message.
  RETURN QUERY
  WITH target AS (
    SELECT m.id
    FROM chat_messages m
    JOIN chat_threads t ON t.id = m.thread_id AND t.kind = 'direct'
    JOIN chat_thread_members mem ON mem.thread_id = m.thread_id AND mem.user_id = v_me
    WHERE (p_thread_id IS NULL OR m.thread_id = p_thread_id)
      AND m.sender_id <> v_me
      AND m.kind = 'text'
      AND m.delivered_at IS NULL
  ), upd AS (
    UPDATE chat_messages m SET delivered_at = v_now
    FROM target WHERE m.id = target.id
    RETURNING m.id
  )
  SELECT id FROM upd;
  -- Group threads: my receipt row (only rows since I joined).
  RETURN QUERY
  WITH target AS (
    SELECT m.id, m.thread_id
    FROM chat_messages m
    JOIN chat_threads t ON t.id = m.thread_id AND t.kind = 'group'
    JOIN chat_thread_members mem ON mem.thread_id = m.thread_id AND mem.user_id = v_me
    WHERE (p_thread_id IS NULL OR m.thread_id = p_thread_id)
      AND m.sender_id <> v_me
      AND m.kind = 'text'
      AND m.created_at >= mem.joined_at
      AND NOT EXISTS (
        SELECT 1 FROM chat_message_receipts r
        WHERE r.message_id = m.id AND r.user_id = v_me AND r.delivered_at IS NOT NULL
      )
  ), ins AS (
    INSERT INTO chat_message_receipts (message_id, user_id, thread_id, delivered_at)
    SELECT id, v_me, thread_id, v_now FROM target
    ON CONFLICT (message_id, user_id) DO UPDATE
      SET delivered_at = COALESCE(chat_message_receipts.delivered_at, EXCLUDED.delivered_at)
    RETURNING message_id
  )
  SELECT message_id FROM ins;
END;
$$;

ALTER FUNCTION public.chat_mark_delivered(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_mark_delivered(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_mark_delivered(UUID) TO authenticated, service_role;

-- Stamp "read" (implies delivered) on the unread messages of one
-- thread and bump my `last_read_at`. Returns the ids.
CREATE OR REPLACE FUNCTION public.chat_mark_read(p_thread_id UUID)
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me   UUID := auth.uid();
  v_now  TIMESTAMPTZ := NOW();
  v_kind TEXT;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT is_chat_thread_member(p_thread_id) THEN
    RAISE EXCEPTION 'Not a member of the thread' USING ERRCODE = '42501';
  END IF;
  SELECT kind INTO v_kind FROM chat_threads WHERE id = p_thread_id;

  UPDATE chat_thread_members SET last_read_at = v_now
  WHERE thread_id = p_thread_id AND user_id = v_me;

  IF v_kind = 'direct' THEN
    RETURN QUERY
    WITH upd AS (
      UPDATE chat_messages m
      SET read_at = v_now, delivered_at = COALESCE(m.delivered_at, v_now)
      WHERE m.thread_id = p_thread_id
        AND m.sender_id <> v_me
        AND m.kind = 'text'
        AND m.read_at IS NULL
      RETURNING m.id
    )
    SELECT id FROM upd;
  ELSE
    RETURN QUERY
    WITH target AS (
      SELECT m.id
      FROM chat_messages m
      JOIN chat_thread_members mem ON mem.thread_id = m.thread_id AND mem.user_id = v_me
      WHERE m.thread_id = p_thread_id
        AND m.sender_id <> v_me
        AND m.kind = 'text'
        AND m.created_at >= mem.joined_at
        AND NOT EXISTS (
          SELECT 1 FROM chat_message_receipts r
          WHERE r.message_id = m.id AND r.user_id = v_me AND r.read_at IS NOT NULL
        )
    ), ins AS (
      INSERT INTO chat_message_receipts (message_id, user_id, thread_id, delivered_at, read_at)
      SELECT id, v_me, p_thread_id, v_now, v_now FROM target
      ON CONFLICT (message_id, user_id) DO UPDATE
        SET delivered_at = COALESCE(chat_message_receipts.delivered_at, EXCLUDED.delivered_at),
            read_at      = COALESCE(chat_message_receipts.read_at, EXCLUDED.read_at)
      RETURNING message_id
    )
    SELECT message_id FROM ins;
  END IF;
END;
$$;

ALTER FUNCTION public.chat_mark_read(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_mark_read(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_mark_read(UUID) TO authenticated, service_role;

-- Unread per thread for the caller. Direct: `read_at`; group: my read
-- receipt. System lines, deleted rows and anything before I joined
-- don't count.
CREATE OR REPLACE FUNCTION public.chat_unread_counts()
RETURNS TABLE (thread_id UUID, unread BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.thread_id, COUNT(*)::bigint AS unread
  FROM chat_messages m
  JOIN chat_thread_members mem ON mem.thread_id = m.thread_id AND mem.user_id = auth.uid()
  JOIN chat_threads t ON t.id = m.thread_id
  WHERE m.sender_id <> auth.uid()
    AND m.kind = 'text'
    AND m.deleted_at IS NULL
    AND m.created_at >= mem.joined_at
    AND (
      (t.kind = 'direct' AND m.read_at IS NULL)
      OR (t.kind = 'group' AND NOT EXISTS (
        SELECT 1 FROM chat_message_receipts r
        WHERE r.message_id = m.id AND r.user_id = auth.uid() AND r.read_at IS NOT NULL
      ))
    )
  GROUP BY m.thread_id;
$$;

ALTER FUNCTION public.chat_unread_counts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_unread_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_unread_counts() TO authenticated, service_role;

-- ============================================================
-- 7. Storage — private bucket `chat-internal`
--    path: account-<account_id>/chat/<thread_id>/<uuid>-<name>
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-internal',
  'chat-internal',
  FALSE,
  26214400, -- 25 MB
  ARRAY[
    'image/png', 'image/jpeg', 'image/webp', 'image/gif',
    'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/webm', 'audio/x-m4a',
    'video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv', 'application/zip'
  ]
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Path helper: true when the object sits under account-<my account>/chat/<thread I belong to>/…
CREATE OR REPLACE FUNCTION public.chat_internal_object_allowed(p_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parts   TEXT[] := storage.foldername(p_name);
  v_thread  UUID;
BEGIN
  IF v_parts IS NULL OR cardinality(v_parts) < 3 OR v_parts[2] <> 'chat' THEN
    RETURN FALSE;
  END IF;
  BEGIN
    v_thread := v_parts[3]::uuid;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;
  RETURN EXISTS (
    SELECT 1
    FROM chat_threads t
    JOIN chat_thread_members m ON m.thread_id = t.id AND m.user_id = auth.uid()
    WHERE t.id = v_thread
      AND ('account-' || t.account_id::text) = v_parts[1]
  );
END;
$$;

ALTER FUNCTION public.chat_internal_object_allowed(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.chat_internal_object_allowed(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chat_internal_object_allowed(TEXT) TO authenticated, service_role;

DROP POLICY IF EXISTS "Chat internal: members read" ON storage.objects;
CREATE POLICY "Chat internal: members read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'chat-internal' AND public.chat_internal_object_allowed(name));

DROP POLICY IF EXISTS "Chat internal: members upload" ON storage.objects;
CREATE POLICY "Chat internal: members upload"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'chat-internal' AND public.chat_internal_object_allowed(name));
-- No UPDATE / DELETE for members: objects are removed by the delete
-- route with the service role after the ownership check.

-- ============================================================
-- 8. Realtime
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_message_receipts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_message_receipts;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_message_reactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_message_reactions;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_thread_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_thread_members;
  END IF;
END;
$$;
