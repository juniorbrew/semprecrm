-- Forward rollback of 100_meta_messaging_channels.sql. NOT a migration: run by
-- hand (as postgres). Roll the APP back first (webhook + inbox build).
-- Destroys every Instagram / Messenger conversation, message, contact and
-- connection (they cannot exist under the old CHECKs / NOT NULL). The inbox /
-- report RPCs keep the wider channel guard from 100: it only accepts more
-- values, so leaving it in place is harmless.
BEGIN;
DELETE FROM public.contacts WHERE phone IS NULL;  -- cascades their conversations / messages
DELETE FROM public.messages WHERE channel IN ('instagram', 'messenger');
DELETE FROM public.conversations WHERE channel IN ('instagram', 'messenger');
UPDATE public.ai_agents SET channels = ARRAY(SELECT c FROM unnest(channels) c WHERE c IN ('official', 'qr'));
DROP TABLE IF EXISTS public.meta_messaging_channels;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_identity_check;
DROP INDEX IF EXISTS public.idx_contacts_account_instagram_id;
DROP INDEX IF EXISTS public.idx_contacts_account_messenger_id;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_instagram_id_check;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_messenger_id_check;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS instagram_id;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS messenger_id;
ALTER TABLE public.contacts ALTER COLUMN phone SET NOT NULL;
ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('official', 'qr'));
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_channel_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_channel_check CHECK (channel IN ('official', 'qr'));
ALTER TABLE public.ai_agents DROP CONSTRAINT IF EXISTS ai_agents_channels_check;
ALTER TABLE public.ai_agents ADD CONSTRAINT ai_agents_channels_check CHECK (channels <@ ARRAY['official', 'qr']::TEXT[]);
COMMIT;
