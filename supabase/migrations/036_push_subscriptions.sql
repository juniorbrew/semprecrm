-- ============================================================
-- 036_push_subscriptions.sql — Browser push notifications
-- (Web Push / VAPID).
--
-- Spec: docs/superpowers/specs/2026-09-13-deskcomm-parity-round2-design.md
--       section "5. Notificações push no navegador"
--
-- What this migration does
--   1. Creates `push_subscriptions` — one row per browser the user
--      enabled notifications in (PushSubscription endpoint + keys).
--      The endpoint is globally unique (a browser hands out one per
--      origin); `last_used_at` is stamped by the sender. RLS: the
--      user reads / writes only their own rows; the server sends
--      with the service role and deletes 404 / 410 endpoints.
--   2. Adds `tasks.reminded_at` — set by the cron when the "due in
--      ≤ 15 min" push went out, so a task is reminded once.
--   3. Adds `profiles.notification_prefs` jsonb — per-user toggles
--      for the four event kinds (inbound_message, task_assigned,
--      task_due, conversation_assigned). Missing key = enabled;
--      parsed by src/lib/push/prefs.ts.
--
-- Does NOT touch `handle_new_user`.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- PUSH_SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);

ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_endpoint_key;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);

ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_endpoint_check;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_endpoint_check
  CHECK (endpoint ~ '^https://' AND length(endpoint) <= 2048);

ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_keys_check;
ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_keys_check
  CHECK (length(p256dh) BETWEEN 1 AND 512 AND length(auth) BETWEEN 1 AND 512);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account ON push_subscriptions(account_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- The owner of the subscription manages it; the service role (the
-- sender) bypasses RLS to stamp last_used_at / drop dead endpoints.
DROP POLICY IF EXISTS push_subscriptions_select ON push_subscriptions;
CREATE POLICY push_subscriptions_select ON push_subscriptions FOR SELECT
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS push_subscriptions_insert ON push_subscriptions;
CREATE POLICY push_subscriptions_insert ON push_subscriptions FOR INSERT
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id));
DROP POLICY IF EXISTS push_subscriptions_update ON push_subscriptions;
CREATE POLICY push_subscriptions_update ON push_subscriptions FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id));
DROP POLICY IF EXISTS push_subscriptions_delete ON push_subscriptions;
CREATE POLICY push_subscriptions_delete ON push_subscriptions FOR DELETE
  USING (user_id = auth.uid());

-- ============================================================
-- TASKS.reminded_at — "due in ≤ 15 min" push sent (cron, once).
-- ============================================================
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;

-- The cron scans open tasks with a due date and no reminder yet.
CREATE INDEX IF NOT EXISTS idx_tasks_due_unreminded
  ON tasks(due_at)
  WHERE due_at IS NOT NULL AND reminded_at IS NULL AND completed_at IS NULL;

-- ============================================================
-- PROFILES.notification_prefs — per-user push toggles.
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_notification_prefs_object_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_notification_prefs_object_check
  CHECK (jsonb_typeof(notification_prefs) = 'object');
