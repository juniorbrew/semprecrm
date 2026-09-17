-- ============================================================
-- 040_calendar.sql — Internal calendar (module `calendar`), phase 1.
--
-- Spec: docs/superpowers/specs/2026-09-14-calendar-design.md
--       sections "Módulo" and "Fase 1 — dados"
--
-- What this migration does
--   1. Creates `calendar_events` — one appointment per row, owned by
--      a member (`owner_user_id`), optionally linked to a contact, an
--      inbox conversation, a deal, a task and / or an internal chat
--      thread. Everything is stored in UTC; the account timezone
--      (`accounts.preferences.business_hours.timezone`) is applied by
--      the UI. The `source` / `external_*` / `sync_hash` columns are
--      reserved for phase 2 (Google / Outlook sync) and unused today.
--   2. Creates `calendar_event_attendees` (event × member, with the
--      member's response).
--   3. `can_edit_calendar_event(event_id)` SECURITY DEFINER helper so
--      the attendee policies can test "owner / creator / admin+" without
--      recursing into `calendar_events`' own policy.
--   4. RLS: every account member reads every event (team calendar);
--      agent+ creates; the owner, the creator or an admin+ edits /
--      cancels / deletes; an attendee only touches their own response.
--   5. Triggers: `updated_at`; BEFORE UPDATE clears `reminded_at` when
--      `starts_at` or `reminder_minutes` change so the cron re-reminds.
--   6. Realtime: both tables join the publication (attendees with
--      REPLICA IDENTITY FULL so DELETE events carry the row).
--   7. Redefines `platform_update_account` (038 body) with `calendar`
--      in the overridable modules.
--
-- Does NOT touch `handle_new_user`.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- CALENDAR_EVENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS calendar_events (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id              UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_user_id           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title                   TEXT NOT NULL,
  description             TEXT,
  location                TEXT,
  color                   TEXT,
  starts_at               TIMESTAMPTZ NOT NULL,
  ends_at                 TIMESTAMPTZ NOT NULL,
  all_day                 BOOLEAN NOT NULL DEFAULT FALSE,
  status                  TEXT NOT NULL DEFAULT 'confirmed',
  reminder_minutes        INTEGER,
  reminded_at             TIMESTAMPTZ,
  contact_id              UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id         UUID REFERENCES conversations(id) ON DELETE SET NULL,
  deal_id                 UUID REFERENCES deals(id) ON DELETE SET NULL,
  task_id                 UUID REFERENCES tasks(id) ON DELETE SET NULL,
  chat_thread_id          UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  -- Phase 2 (Google / Outlook sync) — reserved, unused today.
  source                  TEXT NOT NULL DEFAULT 'internal',
  external_connection_id  UUID,
  external_id             TEXT,
  external_etag           TEXT,
  external_updated_at     TIMESTAMPTZ,
  sync_hash               TEXT,
  created_by              UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_range_check;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_range_check
  CHECK (ends_at > starts_at);

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_status_check;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_status_check
  CHECK (status IN ('confirmed', 'cancelled'));

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_reminder_check;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_reminder_check
  CHECK (reminder_minutes IS NULL OR reminder_minutes IN (5, 10, 15, 30, 60, 1440));

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_source_check;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_source_check
  CHECK (source IN ('internal', 'google', 'microsoft'));

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_title_check;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_title_check
  CHECK (btrim(title) <> '');

CREATE INDEX IF NOT EXISTS idx_calendar_events_account_starts
  ON calendar_events(account_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_account_owner_starts
  ON calendar_events(account_id, owner_user_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_contact ON calendar_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_deal ON calendar_events(deal_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_task ON calendar_events(task_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_conversation ON calendar_events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_chat_thread ON calendar_events(chat_thread_id);
-- Reminder scan: pending reminders only.
CREATE INDEX IF NOT EXISTS idx_calendar_events_reminder_pending
  ON calendar_events(starts_at)
  WHERE reminder_minutes IS NOT NULL AND reminded_at IS NULL AND status = 'confirmed';
CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_events_external
  ON calendar_events(external_connection_id, external_id)
  WHERE external_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON calendar_events;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- CALENDAR_EVENT_ATTENDEES
-- ============================================================
CREATE TABLE IF NOT EXISTS calendar_event_attendees (
  event_id   UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  response   TEXT NOT NULL DEFAULT 'needs_action',
  PRIMARY KEY (event_id, user_id)
);

ALTER TABLE calendar_event_attendees DROP CONSTRAINT IF EXISTS calendar_event_attendees_response_check;
ALTER TABLE calendar_event_attendees ADD CONSTRAINT calendar_event_attendees_response_check
  CHECK (response IN ('needs_action', 'accepted', 'declined'));

CREATE INDEX IF NOT EXISTS idx_calendar_event_attendees_user
  ON calendar_event_attendees(user_id);

-- DELETE payloads on realtime need the full old row.
ALTER TABLE calendar_event_attendees REPLICA IDENTITY FULL;

ALTER TABLE calendar_event_attendees ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- can_edit_calendar_event(event_id)
--
-- True when the caller owns the event, created it, or is admin+ in
-- its account. SECURITY DEFINER so the attendee policies can read
-- `calendar_events` without a recursive RLS evaluation.
-- ============================================================
CREATE OR REPLACE FUNCTION public.can_edit_calendar_event(p_event_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM calendar_events e
    WHERE e.id = p_event_id
      AND (
        e.owner_user_id = auth.uid()
        OR e.created_by = auth.uid()
        OR is_account_member(e.account_id, 'admin')
      )
  );
$$;

ALTER FUNCTION public.can_edit_calendar_event(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_edit_calendar_event(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_edit_calendar_event(UUID) TO authenticated, service_role;

-- Same, for the account of an event (attendee SELECT).
CREATE OR REPLACE FUNCTION public.can_read_calendar_event(p_event_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM calendar_events e
    WHERE e.id = p_event_id
      AND is_account_member(e.account_id)
  );
$$;

ALTER FUNCTION public.can_read_calendar_event(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_read_calendar_event(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_calendar_event(UUID) TO authenticated, service_role;

-- ============================================================
-- RLS — events
-- ============================================================
DROP POLICY IF EXISTS calendar_events_select ON calendar_events;
CREATE POLICY calendar_events_select ON calendar_events FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS calendar_events_insert ON calendar_events;
CREATE POLICY calendar_events_insert ON calendar_events FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS calendar_events_update ON calendar_events;
CREATE POLICY calendar_events_update ON calendar_events FOR UPDATE
  USING (
    is_account_member(account_id, 'agent')
    AND (
      owner_user_id = auth.uid()
      OR created_by = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  )
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS calendar_events_delete ON calendar_events;
CREATE POLICY calendar_events_delete ON calendar_events FOR DELETE
  USING (
    is_account_member(account_id, 'agent')
    AND (
      owner_user_id = auth.uid()
      OR created_by = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  );

-- ============================================================
-- RLS — attendees
-- ============================================================
DROP POLICY IF EXISTS calendar_event_attendees_select ON calendar_event_attendees;
CREATE POLICY calendar_event_attendees_select ON calendar_event_attendees FOR SELECT
  USING (can_read_calendar_event(event_id));

DROP POLICY IF EXISTS calendar_event_attendees_insert ON calendar_event_attendees;
CREATE POLICY calendar_event_attendees_insert ON calendar_event_attendees FOR INSERT
  WITH CHECK (can_edit_calendar_event(event_id));

-- The event's editors manage the roster; an attendee updates only
-- their own row (the response).
DROP POLICY IF EXISTS calendar_event_attendees_update ON calendar_event_attendees;
CREATE POLICY calendar_event_attendees_update ON calendar_event_attendees FOR UPDATE
  USING (user_id = auth.uid() OR can_edit_calendar_event(event_id))
  WITH CHECK (user_id = auth.uid() OR can_edit_calendar_event(event_id));

DROP POLICY IF EXISTS calendar_event_attendees_delete ON calendar_event_attendees;
CREATE POLICY calendar_event_attendees_delete ON calendar_event_attendees FOR DELETE
  USING (can_edit_calendar_event(event_id));

-- ============================================================
-- calendar_events BEFORE UPDATE — a moved event (or a changed
-- reminder) has not been reminded yet.
-- ============================================================
CREATE OR REPLACE FUNCTION public.calendar_events_before_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.reminder_minutes IS DISTINCT FROM OLD.reminder_minutes THEN
    -- Only when the caller did not stamp it in this very statement
    -- (the cron claims rows with `reminded_at = now()` and never
    -- touches the schedule at the same time).
    IF NEW.reminded_at IS NOT DISTINCT FROM OLD.reminded_at THEN
      NEW.reminded_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.calendar_events_before_update() OWNER TO postgres;

DROP TRIGGER IF EXISTS calendar_events_before_update ON calendar_events;
CREATE TRIGGER calendar_events_before_update BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.calendar_events_before_update();

-- ============================================================
-- REALTIME
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'calendar_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE calendar_events;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'calendar_event_attendees'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE calendar_event_attendees;
  END IF;
END;
$$;

-- ============================================================
-- platform_update_account — 038 body + `calendar` as an overridable
-- module (keep `v_allowed_modules` in sync with OPTIONAL_MODULES in
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
    'calendar'
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
