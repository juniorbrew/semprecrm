-- Forward rollback of 093_webhooks_api_keys.sql. NOT a migration: run by hand
-- (as postgres). Roll the APP back first (cron route, /api/v1, settings tab).
-- Destroys API keys, endpoints, events and delivery history. messages.origin
-- 'api' is left allowed (harmless); remove it only after deleting such rows.
BEGIN;
DROP TRIGGER IF EXISTS webhook_message_insert ON public.messages;
DROP TRIGGER IF EXISTS webhook_message_status ON public.messages;
DROP TRIGGER IF EXISTS webhook_conversation_insert ON public.conversations;
DROP TRIGGER IF EXISTS webhook_conversation_status ON public.conversations;
DROP TRIGGER IF EXISTS webhook_contact_insert ON public.contacts;
DROP FUNCTION IF EXISTS public.webhook_trg_message_insert();
DROP FUNCTION IF EXISTS public.webhook_trg_message_status();
DROP FUNCTION IF EXISTS public.webhook_trg_conversation();
DROP FUNCTION IF EXISTS public.webhook_trg_contact_insert();
DROP FUNCTION IF EXISTS public.webhook_claim_deliveries(integer, integer, uuid, integer);
DROP FUNCTION IF EXISTS public.webhook_purge(integer, integer);
DROP FUNCTION IF EXISTS public.webhook_emit(uuid, text, jsonb, uuid);
DROP FUNCTION IF EXISTS public.webhook_has_listener(uuid, text);
DROP FUNCTION IF EXISTS public.api_purge();
DROP TABLE IF EXISTS public.api_request_log, public.api_idempotency_keys;
DROP TABLE IF EXISTS public.webhook_delivery_attempts, public.webhook_deliveries,
  public.webhook_events, public.webhook_endpoints, public.api_keys;
DROP INDEX IF EXISTS public.idx_messages_api_request;
ALTER TABLE public.messages DROP COLUMN IF EXISTS api_request_id;
COMMIT;
