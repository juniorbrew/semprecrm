-- ============================================================
-- 093 — API keys + outbound webhooks (public API v1).
--
--   1. api_keys: named, scoped, revocable keys. Only the SHA-256 of the
--      key is stored (key_hash); the app shows the plaintext once.
--      `expires_at` carries the rotation grace period (old key keeps
--      working until then); `revoked_at` ends it at once.
--   2. webhook_endpoints: one row per customer URL, per-endpoint event
--      selection, signing secret stored ENCRYPTED (secret_enc) with the
--      previous secret kept for the rotation overlap.
--   3. Transactional outbox: webhook_events + webhook_deliveries are
--      filled by AFTER triggers on messages / conversations / contacts.
--      Every write path (Meta webhook, QR gateway, automations, flows,
--      AI, inbox, public API, imports) goes through those tables, so one
--      set of triggers captures them all, and the event commits (or
--      rolls back) with the row that caused it: no lost or phantom
--      events. The emit step is a no-op unless the account has an
--      enabled endpoint listening, and never fails the originating
--      statement (EXCEPTION -> WARNING).
--   4. webhook_delivery_attempts: one row per HTTP attempt (status,
--      latency, response snippet) for the delivery log.
--   5. webhook_claim_deliveries: service-role RPC that leases due
--      deliveries with FOR UPDATE SKIP LOCKED, so overlapping cron ticks
--      never deliver the same row twice.
--   6. api_idempotency_keys (Idempotency-Key on POST /api/v1/messages) and
--      api_request_log (bounded per-key request log); api_purge() trims both.
--   7. messages.origin gains 'api' (messages sent through the public API).
--
-- Rule from 076: new functions are closed by default. Trigger functions
-- are SECURITY DEFINER (they write tables the invoking role cannot) and
-- are not executable by user roles; the RPCs are service_role only.
-- Secrets and the key hash are not selectable by user roles (column
-- grants); all writes go through the service role in the admin routes.
-- Additive: nothing here changes existing behaviour.
-- Rollback: supabase/rollback/093_rollback.sql.
-- ============================================================

SET lock_timeout = '5s';

-- ---- 1. api_keys ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  key_prefix   TEXT NOT NULL,
  key_last4    TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scopes       TEXT[] NOT NULL CHECK (cardinality(scopes) > 0),
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
-- Added after the first draft: ADD COLUMN IF NOT EXISTS keeps a re-apply idempotent.
ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS note         TEXT CHECK (note IS NULL OR char_length(note) <= 200),
  ADD COLUMN IF NOT EXISTS last_used_ip TEXT,
  ADD COLUMN IF NOT EXISTS allowed_cidrs TEXT[] CHECK (allowed_cidrs IS NULL OR cardinality(allowed_cidrs) <= 10);
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON public.api_keys (account_id, created_at DESC);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_keys_select ON public.api_keys;
CREATE POLICY api_keys_select ON public.api_keys FOR SELECT
  USING (is_account_member(account_id, 'admin'));
REVOKE ALL ON TABLE public.api_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, account_id, name, key_prefix, key_last4, scopes, created_by, created_at, last_used_at, expires_at, revoked_at, note, last_used_ip, allowed_cidrs)
  ON public.api_keys TO authenticated;
GRANT ALL ON TABLE public.api_keys TO service_role;

-- ---- 2. webhook_endpoints ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                 UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  url                        TEXT NOT NULL CHECK (char_length(url) <= 2048 AND url LIKE 'https://%'),
  description                TEXT CHECK (description IS NULL OR char_length(description) <= 200),
  events                     TEXT[] NOT NULL CHECK (cardinality(events) > 0),
  secret_enc                 TEXT NOT NULL,
  previous_secret_enc        TEXT,
  previous_secret_expires_at TIMESTAMPTZ,
  enabled                    BOOLEAN NOT NULL DEFAULT TRUE,
  disabled_reason            TEXT,
  failing_since              TIMESTAMPTZ,
  created_by                 UUID,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_account ON public.webhook_endpoints (account_id, enabled);

ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_endpoints_select ON public.webhook_endpoints;
CREATE POLICY webhook_endpoints_select ON public.webhook_endpoints FOR SELECT
  USING (is_account_member(account_id, 'admin'));
REVOKE ALL ON TABLE public.webhook_endpoints FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, account_id, url, description, events, enabled, disabled_reason, failing_since, created_by, created_at, updated_at, previous_secret_expires_at)
  ON public.webhook_endpoints TO authenticated;
GRANT ALL ON TABLE public.webhook_endpoints TO service_role;

-- ---- 3. outbox ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- contact_id lets the LGPD scrub (lib/lgpd/anonymize.ts) delete a contact's events by
-- index; the FK also removes them on a hard contact delete.
ALTER TABLE public.webhook_events
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES public.contacts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON public.webhook_events (created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_contact ON public.webhook_events (contact_id) WHERE contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL REFERENCES public.webhook_events(id) ON DELETE CASCADE,
  endpoint_id      UUID NOT NULL REFERENCES public.webhook_endpoints(id) ON DELETE CASCADE,
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_until    TIMESTAMPTZ,
  last_status_code INTEGER,
  last_error       TEXT,
  last_attempt_at  TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  resend_of        UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The dispatcher scan: only pending rows, ordered by when they are due.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON public.webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_account_due
  ON public.webhook_deliveries (account_id, next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
  ON public.webhook_deliveries (endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event ON public.webhook_deliveries (event_id);

CREATE TABLE IF NOT EXISTS public.webhook_delivery_attempts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id      UUID NOT NULL REFERENCES public.webhook_deliveries(id) ON DELETE CASCADE,
  account_id       UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  attempt_no       INTEGER NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms      INTEGER,
  status_code      INTEGER,
  error            TEXT,
  response_snippet TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_attempts_delivery ON public.webhook_delivery_attempts (delivery_id, attempt_no);

-- Payloads hold message text: only the service role reads events; admins read
-- the delivery log (status, codes) and attempts through RLS.
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_delivery_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_deliveries_select ON public.webhook_deliveries;
CREATE POLICY webhook_deliveries_select ON public.webhook_deliveries FOR SELECT
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS webhook_delivery_attempts_select ON public.webhook_delivery_attempts;
CREATE POLICY webhook_delivery_attempts_select ON public.webhook_delivery_attempts FOR SELECT
  USING (is_account_member(account_id, 'admin'));
REVOKE ALL ON TABLE public.webhook_events, public.webhook_deliveries, public.webhook_delivery_attempts
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.webhook_deliveries, public.webhook_delivery_attempts TO authenticated;
GRANT ALL ON TABLE public.webhook_events, public.webhook_deliveries, public.webhook_delivery_attempts TO service_role;

-- ---- 4. emit ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.webhook_has_listener(p_account UUID, p_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM webhook_endpoints e
     WHERE e.account_id = p_account AND e.enabled
       AND ('*' = ANY (e.events) OR p_type = ANY (e.events))
  );
$$;

-- One event row + one delivery per enabled endpoint listening for p_type
-- ('*' = everything). Called only from the trigger functions below.
-- Earlier draft signatures (re-apply on a database that already ran it):
DROP FUNCTION IF EXISTS public.webhook_emit(UUID, TEXT, JSONB);
CREATE OR REPLACE FUNCTION public.webhook_emit(p_account UUID, p_type TEXT, p_data JSONB, p_contact UUID DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event UUID;
BEGIN
  IF NOT public.webhook_has_listener(p_account, p_type) THEN
    RETURN;
  END IF;
  INSERT INTO webhook_events (account_id, type, data, contact_id) VALUES (p_account, p_type, p_data, p_contact)
    RETURNING id INTO v_event;
  INSERT INTO webhook_deliveries (event_id, endpoint_id, account_id)
    SELECT v_event, e.id, e.account_id
      FROM webhook_endpoints e
     WHERE e.account_id = p_account AND e.enabled
       AND ('*' = ANY (e.events) OR p_type = ANY (e.events));
END;
$$;
REVOKE ALL ON FUNCTION public.webhook_emit(UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.webhook_has_listener(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- Every trigger below keeps ALL webhook work inside BEGIN ... EXCEPTION: nothing on
-- the webhook side (lookups, listener check, outbox insert) can abort the write of
-- the message / conversation / contact that fired it.

-- messages: INSERT -> message.received (customer) / message.sent (agent, bot)
CREATE OR REPLACE FUNCTION public.webhook_trg_message_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_type    TEXT := CASE WHEN NEW.sender_type = 'customer' THEN 'message.received' ELSE 'message.sent' END;
  v_account UUID;
  v_contact UUID;
  v_phone   TEXT;
  v_name    TEXT;
BEGIN
  BEGIN
    SELECT c.account_id, c.contact_id INTO v_account, v_contact
      FROM conversations c WHERE c.id = NEW.conversation_id;
    IF v_account IS NULL OR NOT public.webhook_has_listener(v_account, v_type) THEN
      RETURN NULL;
    END IF;
    SELECT ct.phone, ct.name INTO v_phone, v_name FROM contacts ct WHERE ct.id = v_contact;
    PERFORM public.webhook_emit(v_account, v_type, jsonb_build_object(
      'id', NEW.id,
      'conversation_id', NEW.conversation_id,
      'contact', jsonb_build_object('id', v_contact, 'phone', v_phone, 'name', v_name),
      'channel', NEW.channel,
      'direction', CASE WHEN NEW.sender_type = 'customer' THEN 'inbound' ELSE 'outbound' END,
      'sender_type', NEW.sender_type,
      'origin', NEW.origin,
      'content_type', NEW.content_type,
      'text', NEW.content_text,
      'media_url', NEW.media_url,
      'template_name', NEW.template_name,
      'whatsapp_message_id', NEW.message_id,
      'status', NEW.status,
      'created_at', NEW.created_at
    ), v_contact);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook emit (message insert) failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.webhook_trg_message_insert() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS webhook_message_insert ON public.messages;
CREATE TRIGGER webhook_message_insert AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.webhook_trg_message_insert();

-- messages: status change -> message.status
CREATE OR REPLACE FUNCTION public.webhook_trg_message_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account UUID;
  v_contact UUID;
BEGIN
  BEGIN
    SELECT c.account_id, c.contact_id INTO v_account, v_contact
      FROM conversations c WHERE c.id = NEW.conversation_id;
    IF v_account IS NULL OR NOT public.webhook_has_listener(v_account, 'message.status') THEN
      RETURN NULL;
    END IF;
    PERFORM public.webhook_emit(v_account, 'message.status', jsonb_build_object(
      'id', NEW.id,
      'conversation_id', NEW.conversation_id,
      'contact_id', v_contact,
      'channel', NEW.channel,
      'whatsapp_message_id', NEW.message_id,
      'status', NEW.status,
      'previous_status', OLD.status,
      'error_code', NEW.error_code,
      'error_title', NEW.error_title,
      'error_details', NEW.error_details
    ), v_contact);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook emit (message status) failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.webhook_trg_message_status() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS webhook_message_status ON public.messages;
CREATE TRIGGER webhook_message_status AFTER UPDATE OF status ON public.messages
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.webhook_trg_message_status();

-- conversations: INSERT -> conversation.created; status -> closed / reopened
CREATE OR REPLACE FUNCTION public.webhook_trg_conversation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_type TEXT;
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      v_type := 'conversation.created';
    ELSIF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
      v_type := 'conversation.closed';
    ELSIF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
      v_type := 'conversation.reopened';
    ELSE
      RETURN NULL;
    END IF;
    IF NOT public.webhook_has_listener(NEW.account_id, v_type) THEN
      RETURN NULL;
    END IF;
    PERFORM public.webhook_emit(NEW.account_id, v_type, jsonb_build_object(
      'id', NEW.id,
      'contact_id', NEW.contact_id,
      'channel', NEW.channel,
      'status', NEW.status,
      'assigned_agent_id', NEW.assigned_agent_id,
      'resolution', NEW.resolution,
      'created_at', NEW.created_at,
      'resolved_at', NEW.resolved_at
    ), NEW.contact_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook emit (conversation) failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.webhook_trg_conversation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS webhook_conversation_insert ON public.conversations;
CREATE TRIGGER webhook_conversation_insert AFTER INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.webhook_trg_conversation();
DROP TRIGGER IF EXISTS webhook_conversation_status ON public.conversations;
CREATE TRIGGER webhook_conversation_status AFTER UPDATE OF status ON public.conversations
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.webhook_trg_conversation();

-- contacts: INSERT -> contact.created
CREATE OR REPLACE FUNCTION public.webhook_trg_contact_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    IF NEW.account_id IS NULL OR NOT public.webhook_has_listener(NEW.account_id, 'contact.created') THEN
      RETURN NULL;
    END IF;
    PERFORM public.webhook_emit(NEW.account_id, 'contact.created', jsonb_build_object(
      'id', NEW.id,
      'phone', NEW.phone,
      'name', NEW.name,
      'email', NEW.email,
      'company', NEW.company,
      'created_at', NEW.created_at
    ), NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook emit (contact) failed: %', SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.webhook_trg_contact_insert() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS webhook_contact_insert ON public.contacts;
CREATE TRIGGER webhook_contact_insert AFTER INSERT ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.webhook_trg_contact_insert();

-- ---- 5. dispatcher RPCs (service role only) ------------------------------------
-- Leases up to p_limit due deliveries (or the single p_delivery_id) for
-- p_lease_seconds and returns them with their endpoint + event. A lease that
-- is not released (crashed worker) simply expires and the row becomes due
-- again. FOR UPDATE SKIP LOCKED: two ticks claiming at once get disjoint rows.
-- Fairness: at most p_per_account rows per account per call, so one tenant with
-- hanging endpoints cannot fill a batch and starve the others.
DROP FUNCTION IF EXISTS public.webhook_claim_deliveries(INTEGER, INTEGER, UUID);
CREATE OR REPLACE FUNCTION public.webhook_claim_deliveries(
  p_limit         INTEGER,
  p_lease_seconds INTEGER DEFAULT 120,
  p_delivery_id   UUID DEFAULT NULL,
  p_per_account   INTEGER DEFAULT 10
)
RETURNS TABLE (
  delivery_id UUID, attempts INTEGER, delivery_created_at TIMESTAMPTZ,
  event_id UUID, event_type TEXT, event_data JSONB, event_created_at TIMESTAMPTZ,
  account_id UUID, endpoint_id UUID, url TEXT, secret_enc TEXT,
  previous_secret_enc TEXT, previous_secret_expires_at TIMESTAMPTZ,
  failing_since TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- Candidates are picked PER ACCOUNT (a handful of rows each), never from one global
  -- "oldest first" window: a tenant with a huge backlog on a slow endpoint cannot hide
  -- everyone else's due rows. Accounts come from the (small) set of enabled endpoints;
  -- idx_webhook_deliveries_account_due makes each probe an index range scan.
  WITH cand AS (
    SELECT x.id, x.next_attempt_at
      FROM (SELECT DISTINCT e0.account_id FROM webhook_endpoints e0 WHERE e0.enabled) a
      CROSS JOIN LATERAL (
        SELECT d.id, d.next_attempt_at
          FROM webhook_deliveries d
          JOIN webhook_endpoints e ON e.id = d.endpoint_id
         WHERE d.account_id = a.account_id
           AND d.status = 'pending'
           AND d.next_attempt_at <= now()
           AND (d.claimed_until IS NULL OR d.claimed_until < now())
           AND e.enabled
           AND (p_delivery_id IS NULL OR d.id = p_delivery_id)
         ORDER BY d.next_attempt_at
         LIMIT GREATEST(p_per_account, 1)
      ) x
  ), due AS (
    SELECT d.id
      FROM webhook_deliveries d
      JOIN cand c ON c.id = d.id
     WHERE d.status = 'pending'
       AND (d.claimed_until IS NULL OR d.claimed_until < now())
     ORDER BY c.next_attempt_at
     LIMIT GREATEST(p_limit, 1)
     FOR UPDATE OF d SKIP LOCKED
  ), leased AS (
    UPDATE webhook_deliveries d
       SET claimed_until = now() + make_interval(secs => p_lease_seconds)
      FROM due WHERE d.id = due.id
    RETURNING d.*
  )
  SELECT l.id, l.attempts, l.created_at,
         ev.id, ev.type, ev.data, ev.created_at,
         l.account_id, e.id, e.url, e.secret_enc,
         e.previous_secret_enc, e.previous_secret_expires_at,
         e.failing_since
    FROM leased l
    JOIN webhook_events ev ON ev.id = l.event_id
    JOIN webhook_endpoints e ON e.id = l.endpoint_id;
$$;

-- Retention: delivery history and payloads live 30 days.
CREATE OR REPLACE FUNCTION public.webhook_purge(p_days INTEGER DEFAULT 30, p_limit INTEGER DEFAULT 5000)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH old AS (
    SELECT id FROM webhook_events
     WHERE created_at < now() - make_interval(days => p_days)
     ORDER BY created_at LIMIT p_limit
  ), gone AS (
    DELETE FROM webhook_events ev USING old WHERE ev.id = old.id RETURNING 1
  )
  SELECT COUNT(*)::INTEGER FROM gone;
$$;

REVOKE ALL ON FUNCTION public.webhook_claim_deliveries(INTEGER, INTEGER, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.webhook_purge(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.webhook_claim_deliveries(INTEGER, INTEGER, UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.webhook_purge(INTEGER, INTEGER) TO service_role;


-- ---- 6. idempotency + request log -----------------------------------------------
-- Idempotency-Key: the row is inserted BEFORE the send (unique per account+key), so
-- two concurrent requests with the same key can never both send.
CREATE TABLE IF NOT EXISTS public.api_idempotency_keys (
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key             TEXT NOT NULL CHECK (char_length(key) BETWEEN 1 AND 255),
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'done')),
  response_status INTEGER,
  response        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
-- Recovery of a request that crashed mid-send: claim_id is a random id per claim, also stored
-- on the message row (messages.api_request_id) so "did this claim send?" is an exact match;
-- conversation_id/contact_id/channel say where the message would be (set right before the send
-- starts; NULL = the send never began, so it is safe to run again).
ALTER TABLE public.api_idempotency_keys
  ADD COLUMN IF NOT EXISTS claim_id        UUID,
  ADD COLUMN IF NOT EXISTS conversation_id UUID,
  ADD COLUMN IF NOT EXISTS contact_id      UUID,
  ADD COLUMN IF NOT EXISTS channel         TEXT;
CREATE INDEX IF NOT EXISTS idx_api_idempotency_created ON public.api_idempotency_keys (created_at);

CREATE TABLE IF NOT EXISTS public.api_request_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key_id     UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  method     TEXT NOT NULL,
  route      TEXT NOT NULL,
  status     INTEGER NOT NULL,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_request_log_key ON public.api_request_log (key_id, at DESC);

ALTER TABLE public.api_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_request_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS api_request_log_select ON public.api_request_log;
CREATE POLICY api_request_log_select ON public.api_request_log FOR SELECT
  USING (is_account_member(account_id, 'admin'));
REVOKE ALL ON TABLE public.api_idempotency_keys, public.api_request_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.api_request_log TO authenticated;
GRANT ALL ON TABLE public.api_idempotency_keys, public.api_request_log TO service_role;

-- Idempotency rows live 24h; the request log keeps 7 days and at most 200 rows per key.
CREATE OR REPLACE FUNCTION public.api_purge()
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH idem AS (
    DELETE FROM api_idempotency_keys WHERE created_at < now() - interval '24 hours' RETURNING 1
  ), old AS (
    DELETE FROM api_request_log WHERE at < now() - interval '7 days' RETURNING 1
  ), over AS (
    DELETE FROM api_request_log l USING (
      SELECT id, row_number() OVER (PARTITION BY key_id ORDER BY at DESC, id DESC) AS rn FROM api_request_log
    ) r WHERE l.id = r.id AND r.rn > 200 RETURNING 1
  )
  SELECT ((SELECT COUNT(*) FROM idem) + (SELECT COUNT(*) FROM old) + (SELECT COUNT(*) FROM over))::INTEGER;
$$;
REVOKE ALL ON FUNCTION public.api_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_purge() TO service_role;

-- ---- 7. messages.origin + 'api' ----------------------------------------------------
-- The idempotency claim that created an API message (NULL for every other message). Nullable,
-- no default: a metadata-only change. Partial index = only the rare API rows are indexed.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS api_request_id UUID;
CREATE INDEX IF NOT EXISTS idx_messages_api_request ON public.messages (api_request_id) WHERE api_request_id IS NOT NULL;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_origin_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_origin_check
  CHECK (origin IS NULL OR origin IN ('phone', 'automation', 'flow', 'system', 'ai', 'csat', 'api')) NOT VALID;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_origin_check;
