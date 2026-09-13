-- ============================================================
-- 033_availability_business_hours.sql — agent availability, business
-- hours / out-of-hours auto-reply and round-robin bookkeeping.
--
-- Spec: docs/superpowers/specs/2026-09-13-deskcomm-parity-round2-design.md
--       section "2. Horário de atendimento e disponibilidade"
--
-- What this migration does
--   1. profiles.availability ('available' | 'away', default
--      'available'), profiles.availability_changed_at and
--      profiles.last_assigned_at (round-robin tie-breaker).
--   2. conversations.out_of_hours_replied_at — when the out-of-hours
--      auto-reply was last sent (or skipped) for this conversation.
--   3. accounts.preferences gains the keys business_hours,
--      out_of_hours_enabled, out_of_hours_message and
--      auto_assign_enabled. The column is free-form jsonb (migration
--      030) so no schema change is needed; defaults live in
--      src/lib/account-preferences.ts.
--
-- RLS: profiles_update (017) already lets each user update their own
-- row, which is what the availability toggle needs; last_assigned_at
-- is written by the service role (engine / inbound).
--
-- Does NOT touch handle_new_user.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. PROFILES — availability + round-robin bookkeeping
-- ============================================================
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS availability            TEXT NOT NULL DEFAULT 'available',
  ADD COLUMN IF NOT EXISTS availability_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_assigned_at        TIMESTAMPTZ;

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_availability_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_availability_check
  CHECK (availability IN ('available', 'away'));

CREATE INDEX IF NOT EXISTS idx_profiles_account_availability
  ON profiles(account_id, availability);

-- ============================================================
-- 2. CONVERSATIONS — out-of-hours auto-reply stamp
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS out_of_hours_replied_at TIMESTAMPTZ;
