-- ============================================================
-- 045_platform_gate.sql — Second factor for the platform (master)
-- area: a username + password the owner types on /platform/login,
-- separate from the CRM account password.
--
-- What this migration does
--   1. Creates `platform_gate_credentials` — one row per platform
--      admin (FK to platform_admins, cascades when the admin is
--      removed). The password is a scrypt hash produced by
--      src/lib/platform/gate-crypto.ts; never a plain password.
--   2. RLS: enabled with NO policies — anon and authenticated roles
--      get zero access, so the hash never leaves the server. Only
--      the service-role client (src/app/api/platform/gate/route.ts
--      and the login page) reads or writes here, same model as
--      `contact_submissions` (044).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_gate_credentials (
  user_id       UUID PRIMARY KEY REFERENCES platform_admins(user_id) ON DELETE CASCADE,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_gate_credentials DROP CONSTRAINT IF EXISTS platform_gate_credentials_username_check;
ALTER TABLE platform_gate_credentials ADD CONSTRAINT platform_gate_credentials_username_check
  CHECK (length(btrim(username)) BETWEEN 3 AND 40);

ALTER TABLE platform_gate_credentials ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: service role only.

COMMENT ON TABLE platform_gate_credentials IS
  'Username + scrypt password hash for /platform/login. No RLS policies — service role only.';
