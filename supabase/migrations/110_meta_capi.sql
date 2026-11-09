-- ============================================================
-- 110_meta_capi.sql — Tell Meta about leads and sales (Conversions API), "Origem dos clientes" part B.
--
-- Spec: docs/superpowers/specs/2026-11-09-avisar-meta-capi.md
--
--   1. meta_capi_settings: one row per account (dataset id, token ENCRYPTED, toggles, paused_reason).
--      authenticated: admin-only SELECT through RLS + a column grant WITHOUT token_enc; no write grant at all.
--      Why no write grant: the token must be encrypted (encryption.ts, AES-GCM) before it is stored, so every
--      write goes through the admin API route with the service role (like api_keys / webhook_endpoints).
--   2. meta_capi_events: the outbox. Written only by the trigger below and the service role; admins read it.
--      unique (deal_id, event_name); stable event_id; no personal data and no request body (value / currency /
--      short error only).
--   3. meta_capi_enqueue(): AFTER INSERT / UPDATE OF status trigger on deals. Lead on insert, purchase when the
--      status becomes 'won'. Enqueues only when settings are on (enabled, not paused, dataset + token set, the
--      event toggle on) AND the deal's origin is a Meta-identifiable touch (part A, lead_origins):
--        whatsapp + ctwa_clid | instagram / messenger + kind 'ad' | site_bot / webhook + fbclid.
--      SECURITY DEFINER, exception-safe: it can never fail or block the deal write.
--   4. meta_capi_claim(): service-role RPC, leases due rows (FOR UPDATE SKIP LOCKED) and returns what the sender
--      needs. Accounts blocked by billing (094 account_is_writable) are not claimed; pending rows expire to
--      'failed' after 24 h.
--   5. meta_capi_purge(): deletes terminal events older than 90 days.
--
-- LGPD: the app cancels pending / failed events of an anonymised contact (src/lib/lgpd/anonymize.ts); the sender
-- also cancels any event whose deal lost its contact (hard delete) or whose contact is anonymised.
-- Billing (094): authenticated has no write grant on either table, so there is no RESTRICTIVE policy to add.
-- Rollback: supabase/rollback/110_rollback.sql. SQL test: supabase/tests/meta_capi.sql. Idempotent.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---- settings -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meta_capi_settings (
  account_id      UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  dataset_id      TEXT CHECK (dataset_id IS NULL OR dataset_id ~ '^[0-9]{5,30}$'),
  token_enc       TEXT,
  token_last4     TEXT CHECK (token_last4 IS NULL OR char_length(token_last4) <= 4),
  test_event_code TEXT CHECK (test_event_code IS NULL OR test_event_code ~ '^[A-Za-z0-9_-]{1,40}$'),
  send_lead       BOOLEAN NOT NULL DEFAULT TRUE,
  send_purchase   BOOLEAN NOT NULL DEFAULT TRUE,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  paused_reason   TEXT CHECK (paused_reason IS NULL OR paused_reason IN ('invalid_token')),
  updated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT meta_capi_settings_ready_check CHECK (NOT enabled OR (dataset_id IS NOT NULL AND token_enc IS NOT NULL))
);

DROP TRIGGER IF EXISTS set_updated_at ON public.meta_capi_settings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.meta_capi_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.meta_capi_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.meta_capi_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.meta_capi_settings TO service_role;
GRANT SELECT (account_id, dataset_id, token_last4, test_event_code, send_lead, send_purchase, enabled,
              paused_reason, updated_by, created_at, updated_at)
  ON public.meta_capi_settings TO authenticated;
DROP POLICY IF EXISTS meta_capi_settings_select ON public.meta_capi_settings;
CREATE POLICY meta_capi_settings_select ON public.meta_capi_settings
  FOR SELECT USING (public.is_account_member(account_id, 'admin'));

-- ---- events (outbox) -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.meta_capi_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  deal_id         UUID NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  event_name      TEXT NOT NULL CHECK (event_name IN ('lead', 'purchase')),
  event_id        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_until   TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + interval '24 hours',
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  value           NUMERIC(12,2),
  currency        TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  last_error      TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 200),
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deal_id, event_name)
);
CREATE INDEX IF NOT EXISTS idx_meta_capi_events_due ON public.meta_capi_events (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_meta_capi_events_account ON public.meta_capi_events (account_id, created_at DESC);

ALTER TABLE public.meta_capi_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.meta_capi_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.meta_capi_events TO service_role;
GRANT SELECT (id, account_id, deal_id, event_name, event_id, status, attempts, next_attempt_at, occurred_at,
              value, currency, last_error, sent_at, created_at)
  ON public.meta_capi_events TO authenticated;
DROP POLICY IF EXISTS meta_capi_events_select ON public.meta_capi_events;
CREATE POLICY meta_capi_events_select ON public.meta_capi_events
  FOR SELECT USING (public.is_account_member(account_id, 'admin'));

-- ---- enqueue trigger ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.meta_capi_enqueue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_s public.meta_capi_settings%ROWTYPE;
  v_lead boolean := (TG_OP = 'INSERT');
  v_purchase boolean := (NEW.status = 'won' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'won'));
  v_cur text;
BEGIN
  BEGIN
    IF NEW.origin_id IS NULL OR NOT (v_lead OR v_purchase) THEN
      RETURN NULL;
    END IF;
    SELECT * INTO v_s FROM public.meta_capi_settings s WHERE s.account_id = NEW.account_id;
    IF NOT FOUND OR NOT v_s.enabled OR v_s.paused_reason IS NOT NULL
       OR v_s.dataset_id IS NULL OR v_s.token_enc IS NULL THEN
      RETURN NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.lead_origins o
       WHERE o.id = NEW.origin_id AND o.account_id = NEW.account_id
         AND ((o.channel = 'whatsapp' AND o.click_id_type = 'ctwa_clid')
           OR (o.channel IN ('instagram', 'messenger') AND o.kind = 'ad')
           OR (o.channel IN ('site_bot', 'webhook') AND o.click_id_type = 'fbclid'))
    ) THEN
      RETURN NULL;
    END IF;

    IF v_lead AND v_s.send_lead THEN
      INSERT INTO public.meta_capi_events (account_id, deal_id, event_name, event_id, occurred_at)
      VALUES (NEW.account_id, NEW.id, 'lead', 'sempre-' || NEW.id || '-lead', COALESCE(NEW.created_at, now()))
      ON CONFLICT (deal_id, event_name) DO NOTHING;
    END IF;
    IF v_purchase AND v_s.send_purchase THEN
      v_cur := CASE WHEN NEW.currency ~ '^[A-Z]{3}$' THEN NEW.currency ELSE 'BRL' END;
      INSERT INTO public.meta_capi_events (account_id, deal_id, event_name, event_id, occurred_at, value, currency)
      VALUES (NEW.account_id, NEW.id, 'purchase', 'sempre-' || NEW.id || '-purchase',
              COALESCE(NEW.closed_at, now()), COALESCE(NEW.value, 0), v_cur)
      ON CONFLICT (deal_id, event_name) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'meta_capi_enqueue failed: %', SQLSTATE;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.meta_capi_enqueue() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS meta_capi_enqueue ON public.deals;
CREATE TRIGGER meta_capi_enqueue AFTER INSERT OR UPDATE OF status ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.meta_capi_enqueue();

-- ---- claim -----------------------------------------------------------------
-- Leases up to p_limit due events and returns what the sender needs to build the payload. Billing-blocked
-- accounts, paused / disabled settings and switched-off event kinds are not claimed. Pending rows past their
-- expires_at (24 h without a successful send) become 'failed' first.
-- ponytail: one global window ordered by next_attempt_at (no per-account fairness like 093); at 5 attempts
-- in 24 h and one small row per deal, add a per-account LATERAL if a tenant ever floods the queue.
DROP FUNCTION IF EXISTS public.meta_capi_claim(integer, integer);
CREATE OR REPLACE FUNCTION public.meta_capi_claim(p_limit integer DEFAULT 50, p_lease_seconds integer DEFAULT 120)
RETURNS TABLE (
  id uuid, account_id uuid, deal_id uuid, event_name text, event_id text, attempts integer,
  occurred_at timestamptz, value numeric, currency text,
  dataset_id text, token_enc text, test_event_code text,
  contact_id uuid, contact_phone text, contact_email text, contact_instagram_id text, contact_messenger_id text,
  contact_anonymized boolean,
  origin_channel text, origin_kind text, origin_click_id_type text, origin_click_id text, origin_occurred_at timestamptz,
  waba_id text, channel_external_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.meta_capi_events e
     SET status = 'failed', last_error = 'Expirou: mais de 24 horas sem conseguir enviar', claimed_until = NULL
   WHERE e.status = 'pending' AND e.expires_at < now();

  RETURN QUERY
  WITH due AS (
    SELECT e0.id
      FROM public.meta_capi_events e0
      JOIN public.meta_capi_settings s ON s.account_id = e0.account_id
     WHERE e0.status = 'pending'
       AND e0.next_attempt_at <= now()
       AND (e0.claimed_until IS NULL OR e0.claimed_until < now())
       AND s.enabled AND s.paused_reason IS NULL AND s.dataset_id IS NOT NULL AND s.token_enc IS NOT NULL
       AND ((e0.event_name = 'lead' AND s.send_lead) OR (e0.event_name = 'purchase' AND s.send_purchase))
       AND private.account_is_writable(e0.account_id)
     ORDER BY e0.next_attempt_at
     LIMIT GREATEST(p_limit, 1)
     FOR UPDATE OF e0 SKIP LOCKED
  ), leased AS (
    UPDATE public.meta_capi_events e
       SET claimed_until = now() + make_interval(secs => GREATEST(p_lease_seconds, 10))
      FROM due WHERE e.id = due.id
    RETURNING e.*
  )
  SELECT l.id, l.account_id, l.deal_id, l.event_name, l.event_id, l.attempts,
         l.occurred_at, l.value, l.currency,
         s.dataset_id, s.token_enc, s.test_event_code,
         c.id, c.phone, c.email, c.instagram_id, c.messenger_id, (c.anonymized_at IS NOT NULL),
         o.channel, o.kind, o.click_id_type, o.click_id, o.occurred_at,
         (SELECT w.waba_id FROM public.whatsapp_config w WHERE w.account_id = l.account_id LIMIT 1),
         (SELECT m.external_id FROM public.meta_messaging_channels m
           WHERE m.account_id = l.account_id AND m.kind = o.channel LIMIT 1)
    FROM leased l
    JOIN public.meta_capi_settings s ON s.account_id = l.account_id
    LEFT JOIN public.deals d ON d.id = l.deal_id
    LEFT JOIN public.contacts c ON c.id = d.contact_id
    LEFT JOIN public.lead_origins o ON o.id = d.origin_id;
END;
$$;

-- ---- purge -------------------------------------------------------------------
-- Terminal rows (sent / failed / cancelled) older than p_days. Caveat: the unique (deal_id, event_name) goes
-- with the row, so a deal reopened and won again after the purge would enqueue a second purchase.
CREATE OR REPLACE FUNCTION public.meta_capi_purge(p_days integer DEFAULT 90, p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH old AS (
    SELECT e.id FROM public.meta_capi_events e
     WHERE e.status IN ('sent', 'failed', 'cancelled')
       AND e.created_at < now() - make_interval(days => p_days)
     ORDER BY e.created_at LIMIT p_limit
  ), gone AS (
    DELETE FROM public.meta_capi_events x USING old WHERE x.id = old.id RETURNING 1
  )
  SELECT count(*)::integer FROM gone;
$$;

REVOKE ALL ON FUNCTION public.meta_capi_claim(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.meta_capi_purge(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meta_capi_claim(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.meta_capi_purge(integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
