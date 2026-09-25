-- ============================================================
-- 048_automation_upgrade.sql — automation run frequency, attendance
-- counter, DB-sourced trigger events, loop protection, honest logs
-- and wait steps that cancel when the customer replies.
--
-- Idempotent — safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Run frequency per automation.
--    Existing rows keep 'every_time' (today's behaviour); the builder
--    picks a per-trigger default for new automations.
-- ------------------------------------------------------------
ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS run_frequency TEXT NOT NULL DEFAULT 'every_time',
  ADD COLUMN IF NOT EXISTS cooldown_hours NUMERIC;

ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_run_frequency_check;
ALTER TABLE automations ADD CONSTRAINT automations_run_frequency_check
  CHECK (run_frequency IN ('every_time', 'once_per_contact', 'once_per_attendance', 'cooldown')) NOT VALID;
ALTER TABLE automations VALIDATE CONSTRAINT automations_run_frequency_check;

ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_cooldown_hours_check;
ALTER TABLE automations ADD CONSTRAINT automations_cooldown_hours_check
  CHECK (
    cooldown_hours IS NULL
    OR (cooldown_hours >= 0.05 AND cooldown_hours <= 720)
  ) NOT VALID;
ALTER TABLE automations VALIDATE CONSTRAINT automations_cooldown_hours_check;

-- ------------------------------------------------------------
-- 2. Attendance counter. Every closed → open/pending transition starts
--    a new attendance (the customer came back, or an agent reopened).
--    "Once per attendance" automations key their guard on it.
-- ------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS service_count INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION conversations_bump_service_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status IS DISTINCT FROM 'closed' THEN
    NEW.service_count := COALESCE(OLD.service_count, 1) + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_service_count ON conversations;
CREATE TRIGGER conversations_service_count
  BEFORE UPDATE OF status ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_bump_service_count();

-- ------------------------------------------------------------
-- 3. Run guards — the atomic "may this automation run for this contact
--    now?" check. One row per (automation, contact, scope):
--      scope 'contact'          → once per contact
--      scope 'attendance:<conv>:<n>' → once per attendance
--      scope 'cooldown'         → at most every cooldown_hours
--    Claiming is a single INSERT … ON CONFLICT so two messages that
--    arrive together can never both pass.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_run_guards (
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (automation_id, contact_id, scope_key)
);

ALTER TABLE automation_run_guards ENABLE ROW LEVEL SECURITY;
-- No policies: service role only (the engine).

CREATE OR REPLACE FUNCTION claim_automation_run(
  p_automation_id UUID,
  p_contact_id UUID,
  p_scope_key TEXT,
  p_cooldown_hours NUMERIC DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed BOOLEAN := FALSE;
BEGIN
  INSERT INTO automation_run_guards AS g (automation_id, contact_id, scope_key, last_run_at)
  VALUES (p_automation_id, p_contact_id, p_scope_key, NOW())
  ON CONFLICT (automation_id, contact_id, scope_key) DO UPDATE
    SET last_run_at = NOW()
    WHERE p_cooldown_hours IS NOT NULL
      AND g.last_run_at <= NOW() - make_interval(secs => p_cooldown_hours * 3600)
  RETURNING TRUE INTO v_claimed;
  RETURN COALESCE(v_claimed, FALSE);
END;
$$;

-- A run that ended with nothing done (conditions not met, failure)
-- gives its claim back, so "once per contact" means "once per contact
-- that actually got the automation", not "once per attempt".
CREATE OR REPLACE FUNCTION release_automation_run(
  p_automation_id UUID,
  p_contact_id UUID,
  p_scope_key TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM automation_run_guards
   WHERE automation_id = p_automation_id
     AND contact_id = p_contact_id
     AND scope_key = p_scope_key;
$$;

REVOKE ALL ON FUNCTION claim_automation_run(UUID, UUID, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION release_automation_run(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_automation_run(UUID, UUID, TEXT, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION release_automation_run(UUID, UUID, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 4. Honest logs. New statuses:
--      waiting   — parked at a wait step (was 'partial')
--      no_action — ran, but the path it took had nothing to do
--      skipped   — did not run (frequency, loop protection…);
--                  skip_reason says why
--      cancelled — a parked wait was cancelled (customer replied)
-- ------------------------------------------------------------
ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS skip_reason TEXT;

ALTER TABLE automation_logs DROP CONSTRAINT IF EXISTS automation_logs_status_check;
ALTER TABLE automation_logs ADD CONSTRAINT automation_logs_status_check
  CHECK (status IN ('success', 'partial', 'failed', 'waiting', 'no_action', 'skipped', 'cancelled')) NOT VALID;
ALTER TABLE automation_logs VALIDATE CONSTRAINT automation_logs_status_check;

ALTER TABLE automation_logs DROP CONSTRAINT IF EXISTS automation_logs_skip_reason_check;
ALTER TABLE automation_logs ADD CONSTRAINT automation_logs_skip_reason_check
  CHECK (status <> 'skipped' OR skip_reason IS NOT NULL) NOT VALID;
ALTER TABLE automation_logs VALIDATE CONSTRAINT automation_logs_skip_reason_check;

CREATE INDEX IF NOT EXISTS idx_automation_logs_burst
  ON automation_logs(automation_id, contact_id, created_at DESC);

-- ------------------------------------------------------------
-- 5. Wait steps that cancel when the customer replies.
-- ------------------------------------------------------------
ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS cancel_on_reply BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE automation_pending_executions DROP CONSTRAINT IF EXISTS automation_pending_executions_status_check;
ALTER TABLE automation_pending_executions ADD CONSTRAINT automation_pending_executions_status_check
  CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')) NOT VALID;
ALTER TABLE automation_pending_executions VALIDATE CONSTRAINT automation_pending_executions_status_check;

CREATE INDEX IF NOT EXISTS idx_automation_pending_cancel_on_reply
  ON automation_pending_executions(conversation_id)
  WHERE status = 'pending' AND cancel_on_reply;

-- ------------------------------------------------------------
-- 6. Trigger events raised by the database. The UI writes tags,
--    assignments and statuses straight to Postgres from many places
--    (contact page, inbox sidebar, import, flows, the engine itself),
--    so the only place that sees all of them is a table trigger. Rows
--    land here and the engine drains them (cron every minute, plus an
--    immediate drain after server-side writes).
--
--    depth / origin_automation_id carry loop protection: an engine
--    action runs inside an RPC that sets `app.automation_depth` and
--    `app.automation_origin`, so an event it causes is one level
--    deeper than the run that caused it.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_event_queue (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  depth INTEGER NOT NULL DEFAULT 0,
  origin_automation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_automation_event_queue_pending
  ON automation_event_queue(created_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_automation_event_queue_account_pending
  ON automation_event_queue(account_id, created_at) WHERE processed_at IS NULL;

ALTER TABLE automation_event_queue ENABLE ROW LEVEL SECURITY;
-- No policies: service role only.

-- Only enqueue when some active automation listens — keeps imports of
-- thousands of tags from filling the queue for nothing.
CREATE OR REPLACE FUNCTION automation_enqueue_event(
  p_account_id UUID,
  p_trigger_type TEXT,
  p_contact_id UUID,
  p_conversation_id UUID,
  p_context JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_depth INTEGER := COALESCE(NULLIF(current_setting('app.automation_depth', TRUE), '')::INTEGER, 0);
  v_origin UUID := NULLIF(current_setting('app.automation_origin', TRUE), '')::UUID;
BEGIN
  IF p_account_id IS NULL THEN RETURN; END IF;
  -- Chain cap (belt and braces with the engine's own check): an event
  -- caused by a run already 3 levels deep is dropped here.
  IF v_depth > 3 THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM automations
    WHERE account_id = p_account_id AND trigger_type = p_trigger_type AND is_active
  ) THEN
    RETURN;
  END IF;
  INSERT INTO automation_event_queue
    (account_id, trigger_type, contact_id, conversation_id, context, depth, origin_automation_id)
  VALUES
    (p_account_id, p_trigger_type, p_contact_id, p_conversation_id, COALESCE(p_context, '{}'::jsonb), v_depth, v_origin);
END;
$$;

REVOKE ALL ON FUNCTION automation_enqueue_event(UUID, TEXT, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;

-- Claim a batch for processing. SKIP LOCKED lets two cron ticks (or the
-- cron and an inline drain) run side by side without taking the same
-- row; a claim older than 5 minutes is treated as a crashed worker and
-- retried; after 5 attempts a row is left for the retention sweep.
CREATE OR REPLACE FUNCTION claim_automation_events(
  p_account_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 100
)
RETURNS SETOF automation_event_queue
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE automation_event_queue q
     SET claimed_at = NOW(),
         attempts = q.attempts + 1
   WHERE q.id IN (
     SELECT id FROM automation_event_queue
      WHERE processed_at IS NULL
        AND attempts < 5
        AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')
        AND (p_account_id IS NULL OR account_id = p_account_id)
      ORDER BY id
      LIMIT GREATEST(1, LEAST(p_limit, 500))
      FOR UPDATE SKIP LOCKED
   )
  RETURNING q.*;
$$;

REVOKE ALL ON FUNCTION claim_automation_events(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_automation_events(UUID, INTEGER) TO service_role;

-- tag_added
CREATE OR REPLACE FUNCTION contact_tags_enqueue_tag_added()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
BEGIN
  SELECT account_id INTO v_account FROM contacts WHERE id = NEW.contact_id;
  PERFORM automation_enqueue_event(
    v_account, 'tag_added', NEW.contact_id, NULL,
    jsonb_build_object('tag_id', NEW.tag_id)
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS contact_tags_tag_added ON contact_tags;
CREATE TRIGGER contact_tags_tag_added
  AFTER INSERT ON contact_tags
  FOR EACH ROW EXECUTE FUNCTION contact_tags_enqueue_tag_added();

-- conversation_assigned / conversation_resolved / conversation_reopened
CREATE OR REPLACE FUNCTION conversations_enqueue_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NOT NULL
     AND NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    PERFORM automation_enqueue_event(
      NEW.account_id, 'conversation_assigned', NEW.contact_id, NEW.id,
      jsonb_build_object('agent_id', NEW.assigned_agent_id)
    );
  END IF;

  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    PERFORM automation_enqueue_event(
      NEW.account_id, 'conversation_resolved', NEW.contact_id, NEW.id,
      jsonb_build_object('previous_status', OLD.status)
    );
  ELSIF OLD.status = 'closed' AND NEW.status IS DISTINCT FROM 'closed' THEN
    PERFORM automation_enqueue_event(
      NEW.account_id, 'conversation_reopened', NEW.contact_id, NEW.id,
      jsonb_build_object('service_count', NEW.service_count)
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS conversations_automation_events ON conversations;
CREATE TRIGGER conversations_automation_events
  AFTER UPDATE OF assigned_agent_id, status ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversations_enqueue_events();

-- ------------------------------------------------------------
-- 7. Engine actions that raise events run through these RPCs so the
--    event inherits the run's depth/origin (loop protection).
--    Service role only.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION automation_add_tag(
  p_contact_id UUID,
  p_tag_id UUID,
  p_depth INTEGER,
  p_origin UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Tag and contact must belong to the same account.
  IF NOT EXISTS (
    SELECT 1 FROM contacts c JOIN tags t ON t.account_id = c.account_id
     WHERE c.id = p_contact_id AND t.id = p_tag_id
  ) THEN
    RAISE EXCEPTION 'tag % does not belong to the contact account', p_tag_id;
  END IF;
  PERFORM set_config('app.automation_depth', p_depth::TEXT, TRUE);
  PERFORM set_config('app.automation_origin', COALESCE(p_origin::TEXT, ''), TRUE);
  INSERT INTO contact_tags (contact_id, tag_id)
  VALUES (p_contact_id, p_tag_id)
  ON CONFLICT (contact_id, tag_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION automation_update_conversations(
  p_account_id UUID,
  p_contact_id UUID,
  p_assigned_agent_id UUID,
  p_status TEXT,
  p_depth INTEGER,
  p_origin UUID
)
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'pending', 'closed') THEN
    RAISE EXCEPTION 'invalid conversation status %', p_status;
  END IF;
  PERFORM set_config('app.automation_depth', p_depth::TEXT, TRUE);
  PERFORM set_config('app.automation_origin', COALESCE(p_origin::TEXT, ''), TRUE);
  RETURN QUERY
    UPDATE conversations
       SET assigned_agent_id = COALESCE(p_assigned_agent_id, assigned_agent_id),
           status = COALESCE(p_status, status),
           updated_at = NOW()
     WHERE account_id = p_account_id
       AND contact_id = p_contact_id
    RETURNING id;
END;
$$;

REVOKE ALL ON FUNCTION automation_add_tag(UUID, UUID, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION automation_update_conversations(UUID, UUID, UUID, TEXT, INTEGER, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION automation_add_tag(UUID, UUID, INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION automation_update_conversations(UUID, UUID, UUID, TEXT, INTEGER, UUID) TO service_role;

-- Trigger functions are not meant to be called directly.
REVOKE ALL ON FUNCTION contact_tags_enqueue_tag_added() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION conversations_enqueue_events() FROM PUBLIC, anon, authenticated;
