-- ============================================================
-- 028_quick_replies.sql — Quick replies (canned responses) per
-- account, inserted from the inbox composer via "/atalho".
--
-- Spec: docs/superpowers/specs/2026-09-13-parity-round1-design.md
--       section "1. Respostas rápidas"
--
-- What this migration does
--   1. Creates `quick_replies` — shortcut (lower-case, no spaces,
--      unique per account), title, body with {{variables}}.
--   2. RLS: viewer+ reads, agent+ writes (operational data, same
--      tier as tasks / messages).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS quick_replies (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shortcut    TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Shortcut format mirrors the app validation (^[a-z0-9_-]{1,30}$) so a
-- row written outside the UI can't break the "/atalho" matcher.
ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_shortcut_format_check;
ALTER TABLE quick_replies ADD CONSTRAINT quick_replies_shortcut_format_check
  CHECK (shortcut ~ '^[a-z0-9_-]{1,30}$');

ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_title_check;
ALTER TABLE quick_replies ADD CONSTRAINT quick_replies_title_check
  CHECK (length(btrim(title)) > 0);

ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_body_check;
ALTER TABLE quick_replies ADD CONSTRAINT quick_replies_body_check
  CHECK (length(btrim(body)) > 0);

ALTER TABLE quick_replies DROP CONSTRAINT IF EXISTS quick_replies_account_shortcut_key;
ALTER TABLE quick_replies ADD CONSTRAINT quick_replies_account_shortcut_key
  UNIQUE (account_id, shortcut);

CREATE INDEX IF NOT EXISTS idx_quick_replies_account ON quick_replies(account_id, shortcut);

DROP TRIGGER IF EXISTS set_updated_at ON quick_replies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON quick_replies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE quick_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quick_replies_select ON quick_replies;
CREATE POLICY quick_replies_select ON quick_replies FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS quick_replies_insert ON quick_replies;
CREATE POLICY quick_replies_insert ON quick_replies FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS quick_replies_update ON quick_replies;
CREATE POLICY quick_replies_update ON quick_replies FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS quick_replies_delete ON quick_replies;
CREATE POLICY quick_replies_delete ON quick_replies FOR DELETE
  USING (is_account_member(account_id, 'agent'));
