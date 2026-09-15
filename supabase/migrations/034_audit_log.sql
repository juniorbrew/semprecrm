-- ============================================================
-- 034_audit_log.sql — Account audit trail.
--
-- Spec: docs/superpowers/specs/2026-09-13-parity-round2-design.md
--       section "3. Log de auditoria"
--
-- What this migration does
--   1. Creates `audit_log` — one row per sensitive action performed
--      in an account (member role changes, channel connections,
--      contact deletion / export / anonymisation, plan changes made
--      from the platform panel, …). `action` is one of the constants
--      in src/lib/audit.ts (AUDIT_ACTIONS); `entity_type`/`entity_id`
--      point at what was touched; `metadata` carries the diff-ish
--      details (old/new role, contact name, …).
--   2. Index on (account_id, created_at desc) — the Settings →
--      Auditoria table pages newest-first by cursor.
--   3. RLS: admin+ SELECT only. There is deliberately NO INSERT /
--      UPDATE / DELETE policy for authenticated users: rows are
--      written exclusively by the app server through the service
--      role (which bypasses RLS) and are never edited. The cron in
--      /api/automations/cron deletes rows older than 365 days, also
--      with the service role.
--
-- Does NOT touch `handle_new_user`.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Nullable: platform-admin actions (plan.changed) and gateway
  -- events have no member as actor. Not an FK so the row survives
  -- the member leaving / being deleted — `actor_name` keeps the
  -- human-readable trail.
  actor_user_id  UUID,
  actor_name     TEXT,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (length(btrim(action)) > 0);

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entity_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entity_type_check
  CHECK (length(btrim(entity_type)) > 0);

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_metadata_object_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_metadata_object_check
  CHECK (jsonb_typeof(metadata) = 'object');

-- Newest-first paging per account (Settings → Auditoria).
CREATE INDEX IF NOT EXISTS idx_audit_log_account_created
  ON audit_log(account_id, created_at DESC);
-- The retention sweep in /api/automations/cron deletes by age.
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Admin+ reads. No write policies on purpose — see header.
DROP POLICY IF EXISTS audit_log_select ON audit_log;
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS audit_log_insert ON audit_log;
DROP POLICY IF EXISTS audit_log_update ON audit_log;
DROP POLICY IF EXISTS audit_log_delete ON audit_log;
