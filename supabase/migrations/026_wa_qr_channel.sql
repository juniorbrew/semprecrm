-- ============================================================
-- 026_wa_qr_channel.sql — WhatsApp via QR code (WhatsApp Web)
-- as a second channel next to the official Cloud API.
--
-- Spec: docs/superpowers/specs/2026-09-12-whatsapp-qr-channel-design.md
--
-- What this migration does
--   1. Creates `wa_qr_sessions` — one row per account mirroring the
--      state of the Baileys session the `services/wa-gateway`
--      process holds for that account (status, phone, name).
--   2. Adds `channel` to `conversations` and `messages`
--      ('official' | 'qr', default 'official') so the inbox can
--      badge each thread and the send path can pick the transport.
--   3. Updates `platform_list_accounts()` so `channels_count`
--      counts the official config AND a non-disconnected QR
--      session — the same rule the app uses for `max_channels`.
--
-- RLS: members read (viewer+), admin+ write; service role (the
-- gateway event routes) bypasses RLS as usual.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- WA_QR_SESSIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS wa_qr_sessions (
  account_id    UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'disconnected',
  phone_number  TEXT,
  display_name  TEXT,
  connected_at  TIMESTAMPTZ,
  last_error    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE wa_qr_sessions DROP CONSTRAINT IF EXISTS wa_qr_sessions_status_check;
ALTER TABLE wa_qr_sessions ADD CONSTRAINT wa_qr_sessions_status_check
  CHECK (status IN ('disconnected', 'qr', 'connecting', 'connected'));

CREATE INDEX IF NOT EXISTS idx_wa_qr_sessions_status ON wa_qr_sessions(status);

ALTER TABLE wa_qr_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wa_qr_sessions_select ON wa_qr_sessions;
CREATE POLICY wa_qr_sessions_select ON wa_qr_sessions FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS wa_qr_sessions_insert ON wa_qr_sessions;
CREATE POLICY wa_qr_sessions_insert ON wa_qr_sessions FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS wa_qr_sessions_update ON wa_qr_sessions;
CREATE POLICY wa_qr_sessions_update ON wa_qr_sessions FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS wa_qr_sessions_delete ON wa_qr_sessions;
CREATE POLICY wa_qr_sessions_delete ON wa_qr_sessions FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- CHANNEL COLUMNS — conversations + messages
--
-- Existing rows all came in through the Meta webhook, so the
-- default 'official' is also the correct backfill.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'official';

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('official', 'qr'));

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'official';

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_channel_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_check
  CHECK (channel IN ('official', 'qr'));

-- The ack route updates `messages.status` by (message_id, channel).
CREATE INDEX IF NOT EXISTS idx_messages_channel_message_id
  ON messages(channel, message_id);

-- ============================================================
-- platform_list_accounts() — channels_count now includes the QR
-- session (when not disconnected). Same body as 025 otherwise.
-- ============================================================
DROP FUNCTION IF EXISTS public.platform_list_accounts();
CREATE OR REPLACE FUNCTION public.platform_list_accounts()
RETURNS TABLE (
  id                    UUID,
  name                  TEXT,
  owner_user_id         UUID,
  owner_email           TEXT,
  owner_name            TEXT,
  plan                  TEXT,
  plan_status           TEXT,
  plan_expires_at       TIMESTAMPTZ,
  module_overrides      JSONB,
  limit_overrides       JSONB,
  platform_notes        TEXT,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ,
  members_count         BIGINT,
  channels_count        BIGINT,
  pending_invites_count BIGINT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin only' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.name,
    a.owner_user_id,
    op.email                      AS owner_email,
    op.full_name                  AS owner_name,
    a.plan,
    a.plan_status,
    a.plan_expires_at,
    a.module_overrides,
    a.limit_overrides,
    a.platform_notes,
    a.created_at,
    a.updated_at,
    (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id)            AS members_count,
    (SELECT COUNT(*) FROM whatsapp_config w WHERE w.account_id = a.id)
      + (SELECT COUNT(*) FROM wa_qr_sessions q
           WHERE q.account_id = a.id
             AND q.status <> 'disconnected')                               AS channels_count,
    (SELECT COUNT(*) FROM account_invitations i
       WHERE i.account_id = a.id
         AND i.accepted_at IS NULL
         AND i.expires_at > NOW())                                         AS pending_invites_count
  FROM accounts a
  LEFT JOIN profiles op ON op.user_id = a.owner_user_id
  ORDER BY a.created_at DESC;
END;
$$;

ALTER FUNCTION public.platform_list_accounts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_list_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_list_accounts() TO authenticated, service_role;
