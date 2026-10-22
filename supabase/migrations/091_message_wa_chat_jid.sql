-- ============================================================
-- 091: messages.wa_chat_jid — the WhatsApp chat a QR-channel message
-- arrived in, exactly as Baileys addressed it (`5511…@s.whatsapp.net`
-- or `123…@lid`).
--
-- A reaction must name the reacted message by its original key. The
-- gateway keeps the keys of recent messages in memory only, so after a
-- restart a reaction to an older customer message in a LID chat was
-- sent with the phone jid: WhatsApp accepted it and never showed it.
-- With the jid stored on the row the app hands it to the gateway.
--
-- Nullable, no default: official-channel rows and rows received before
-- this migration stay NULL (the gateway falls back to the phone jid).
--
-- Rollback: ALTER TABLE public.messages DROP COLUMN wa_chat_jid;
-- ============================================================

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS wa_chat_jid TEXT;
