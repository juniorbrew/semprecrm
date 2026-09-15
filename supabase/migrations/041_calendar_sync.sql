-- ============================================================
-- 041_calendar_sync.sql — Calendar module, phase 2: Google Calendar
-- and Outlook (Microsoft Graph) two-way sync per user.
--
-- Spec: docs/superpowers/specs/2026-09-14-calendar-design.md
--       section "Fase 2 — Google Agenda e Outlook"
--
-- What this migration does
--   1. Creates `calendar_connections` — one row per (user, provider)
--      with the OAuth tokens encrypted at rest (AES-256-GCM through
--      src/lib/whatsapp/encryption.ts, `*_enc` columns), the provider
--      sync cursor (Google `syncToken` / Graph `deltaLink`), the last
--      sync outcome and the "mirror the appointments I attend" opt-in.
--   2. Locks the base table down: RLS on with NO policies and no
--      table grants for `anon` / `authenticated`, so only the service
--      role (the API routes and the sync engine) reads or writes it.
--   3. Exposes `calendar_connections_public` — the same rows minus
--      the `*_enc` columns, filtered to the caller (`user_id =
--      auth.uid()`), which is what Settings → Agenda reads.
--   4. Adds the FK `calendar_events.external_connection_id →
--      calendar_connections(id) ON DELETE SET NULL` that 040 reserved.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- CALENDAR_CONNECTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS calendar_connections (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL,
  email                 TEXT,
  -- The provider calendar the events go to / come from. Google:
  -- `primary`; Microsoft: the default calendar (`me/events`).
  external_calendar_id  TEXT,
  access_token_enc      TEXT,
  refresh_token_enc     TEXT,
  token_expires_at      TIMESTAMPTZ,
  -- Google `syncToken` (or `pageToken:<token>` while an initial full
  -- read is paging) / Graph `deltaLink` (or `nextLink` while paging).
  sync_cursor           TEXT,
  last_sync_at          TIMESTAMPTZ,
  last_error            TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  -- Also push appointments where the user is an attendee (not only
  -- the ones they own) to the external calendar.
  mirror_attending      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS mirror_attending BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE calendar_connections DROP CONSTRAINT IF EXISTS calendar_connections_provider_check;
ALTER TABLE calendar_connections ADD CONSTRAINT calendar_connections_provider_check
  CHECK (provider IN ('google', 'microsoft'));

ALTER TABLE calendar_connections DROP CONSTRAINT IF EXISTS calendar_connections_status_check;
ALTER TABLE calendar_connections ADD CONSTRAINT calendar_connections_status_check
  CHECK (status IN ('active', 'error', 'revoked'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_connections_user_provider
  ON calendar_connections(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_calendar_connections_account
  ON calendar_connections(account_id);
-- The cron picks the stalest active connections first.
CREATE INDEX IF NOT EXISTS idx_calendar_connections_due
  ON calendar_connections(last_sync_at NULLS FIRST)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS set_updated_at ON calendar_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON calendar_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS on, no policies: `authenticated` / `anon` never touch the base
-- table (tokens live here). The service role bypasses RLS.
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE calendar_connections FROM anon, authenticated;
GRANT ALL ON TABLE calendar_connections TO service_role;

-- ============================================================
-- calendar_connections_public — what the owner may see (no tokens).
--
-- Owned by postgres (no security_invoker) so it can read the locked
-- base table; the WHERE clause is the whole access rule and
-- `security_barrier` keeps a leaky function from peeking past it.
-- ============================================================
CREATE OR REPLACE VIEW calendar_connections_public
WITH (security_barrier = true) AS
  SELECT
    id,
    account_id,
    user_id,
    provider,
    email,
    external_calendar_id,
    token_expires_at,
    last_sync_at,
    last_error,
    status,
    mirror_attending,
    created_at,
    updated_at
  FROM calendar_connections
  WHERE user_id = auth.uid();

ALTER VIEW calendar_connections_public OWNER TO postgres;
REVOKE ALL ON calendar_connections_public FROM anon;
GRANT SELECT ON calendar_connections_public TO authenticated, service_role;

-- ============================================================
-- calendar_events.external_connection_id → calendar_connections
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'calendar_events_external_connection_fk'
      AND conrelid = 'calendar_events'::regclass
  ) THEN
    ALTER TABLE calendar_events
      ADD CONSTRAINT calendar_events_external_connection_fk
      FOREIGN KEY (external_connection_id)
      REFERENCES calendar_connections(id) ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_calendar_events_external_connection
  ON calendar_events(external_connection_id)
  WHERE external_connection_id IS NOT NULL;
