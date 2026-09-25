-- ============================================================
-- 049_read_receipts.sql — "read" (blue ✓✓) confirmations.
--
-- When an agent opens a conversation the app tells WhatsApp the
-- customer's messages were read. `read_receipt_at` is the created_at of
-- the newest customer message already confirmed, so each open only
-- confirms what is new.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS read_receipt_at TIMESTAMPTZ;

COMMENT ON COLUMN conversations.read_receipt_at IS
  'created_at of the newest customer message whose read receipt was sent to WhatsApp.';
