-- ============================================================
-- 115 — Página de agendamento: entrar com e-mail (código) ou Google
-- (spec docs/superpowers/specs/2026-11-16-agendamento-login-email-google.md).
--
--   * booking_identities: quem entrou por e-mail ou Google numa conta. A sessão
--     dessas pessoas é da IDENTIDADE, não do contato: o celular que digitam não
--     é confirmado, então elas só veem os horários que elas mesmas marcaram.
--   * booking_identity_events: qual identidade marcou qual horário.
--   * booking_email_codes: código de 6 números enviado por e-mail (só o HMAC
--     fica guardado), 10 min, 5 tentativas, preso ao aparelho que pediu.
--   * booking_client_book ganha p_identity_id + p_notes: com a mesma trava,
--     conta os futuros do contato E da identidade e grava o vínculo.
-- Tudo só service role (o público chega pelas rotas do servidor).
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.booking_identities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('email', 'google')),
  -- e-mail em minúsculas (kind email) ou o `sub` do Google.
  subject        TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 320),
  email          TEXT CHECK (email IS NULL OR length(email) <= 320),
  name           TEXT CHECK (name IS NULL OR length(name) <= 80),
  -- O contato do celular informado no 1º horário (não confirmado).
  contact_id     UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  revoked_before TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, subject)
);
ALTER TABLE public.booking_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_identities FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.booking_identities TO service_role;

CREATE TABLE IF NOT EXISTS public.booking_identity_events (
  event_id    UUID PRIMARY KEY REFERENCES public.calendar_events(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  identity_id UUID NOT NULL REFERENCES public.booking_identities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_booking_identity_events_identity ON public.booking_identity_events (identity_id);
ALTER TABLE public.booking_identity_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_identity_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.booking_identity_events TO service_role;

CREATE TABLE IF NOT EXISTS public.booking_email_codes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  page_id      UUID NOT NULL REFERENCES public.booking_pages(id) ON DELETE CASCADE,
  email        TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  code_hash    TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  browser_hash TEXT NOT NULL CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_email_codes_browser ON public.booking_email_codes (browser_hash);
CREATE INDEX IF NOT EXISTS idx_booking_email_codes_expires ON public.booking_email_codes (expires_at);
CREATE INDEX IF NOT EXISTS idx_booking_email_codes_email ON public.booking_email_codes (page_id, email);
ALTER TABLE public.booking_email_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_email_codes FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.booking_email_codes TO service_role;

-- ---- booking_client_book com identidade ---------------------------------------
DROP FUNCTION IF EXISTS public.booking_client_book(uuid, uuid, uuid, uuid, timestamptz, integer, text);
CREATE OR REPLACE FUNCTION public.booking_client_book(
  p_account_id UUID,
  p_service_id UUID,
  p_resource_id UUID,
  p_contact_id UUID,
  p_starts_at TIMESTAMPTZ,
  p_max_future INTEGER,
  p_idempotency_key TEXT,
  p_identity_id UUID DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
) RETURNS public.calendar_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_open INTEGER;
  v_row  public.calendar_events;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('booking-client:' || p_contact_id::text, 0));
  SELECT count(*) INTO v_open FROM public.calendar_events
   WHERE account_id = p_account_id AND contact_id = p_contact_id AND service_id IS NOT NULL
     AND status IN ('scheduled', 'confirmed') AND ends_at >= now()
     AND idempotency_key IS DISTINCT FROM p_idempotency_key;
  IF v_open >= p_max_future THEN
    RAISE EXCEPTION 'booking_client_limit' USING ERRCODE = 'AG012';
  END IF;

  IF p_identity_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.booking_identities WHERE id = p_identity_id AND account_id = p_account_id) THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('booking-identity:' || p_identity_id::text, 0));
    SELECT count(*) INTO v_open FROM public.booking_identity_events l
      JOIN public.calendar_events e ON e.id = l.event_id
     WHERE l.identity_id = p_identity_id AND e.status IN ('scheduled', 'confirmed') AND e.ends_at >= now()
       AND e.idempotency_key IS DISTINCT FROM p_idempotency_key;
    IF v_open >= p_max_future THEN
      RAISE EXCEPTION 'booking_client_limit' USING ERRCODE = 'AG012';
    END IF;
  END IF;

  v_row := public.agenda_book_appointment(
    p_account_id, p_service_id, p_resource_id, p_contact_id, p_starts_at,
    NULL, 'client', left(p_notes, 500), p_idempotency_key, 'scheduled', NULL, false);

  IF p_identity_id IS NOT NULL THEN
    INSERT INTO public.booking_identity_events (event_id, account_id, identity_id)
    VALUES (v_row.id, p_account_id, p_identity_id)
    ON CONFLICT (event_id) DO NOTHING;
  END IF;
  RETURN v_row;
END;
$$;
ALTER FUNCTION public.booking_client_book(uuid, uuid, uuid, uuid, timestamptz, integer, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.booking_client_book(uuid, uuid, uuid, uuid, timestamptz, integer, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_client_book(uuid, uuid, uuid, uuid, timestamptz, integer, text, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
