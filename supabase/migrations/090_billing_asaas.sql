-- ============================================================
-- 090: subscription billing with Asaas
-- (docs/superpowers/specs/2026-10-12-billing-asaas-design.md).
--
-- Additive only:
--   * account_billing — the account's Asaas customer and subscription,
--     with the plan, catalog version and price frozen at checkout.
--   * billing_payments — the subscription's charges (status, invoice link).
--   * billing_webhook_events — every Asaas event by its id, stored BEFORE
--     any effect, so a redelivered event is a no-op.
--   * billing_activate / billing_mark_past_due — the only way the billing
--     flow changes accounts.plan* (account + billing row in one
--     transaction). service_role only.
-- Owners/admins read their own billing rows; nobody but the server writes.
--
-- Rollback: DROP FUNCTION billing_activate(UUID, TIMESTAMPTZ),
-- billing_mark_past_due(UUID); DROP TABLE billing_webhook_events,
-- billing_payments, account_billing. No existing row is touched.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.account_billing (
  account_id             UUID PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  asaas_customer_id      TEXT,
  asaas_subscription_id  TEXT UNIQUE,
  plan                   TEXT NOT NULL,
  plan_version_id        UUID NOT NULL,
  cycle                  TEXT NOT NULL CHECK (cycle IN ('monthly', 'annual')),
  value_cents            BIGINT NOT NULL CHECK (value_cents > 0),
  status                 TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'active', 'past_due', 'canceled')),
  current_period_end     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (plan, plan_version_id) REFERENCES public.platform_plan_versions(plan, id)
);
DROP TRIGGER IF EXISTS set_updated_at ON public.account_billing;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.account_billing
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.billing_payments (
  asaas_payment_id       TEXT PRIMARY KEY,
  account_id             UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  asaas_subscription_id  TEXT,
  status                 TEXT NOT NULL,
  billing_type           TEXT,
  value_cents            BIGINT NOT NULL CHECK (value_cents >= 0),
  due_date               DATE,
  invoice_url            TEXT,
  paid_at                TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_payments_account
  ON public.billing_payments(account_id, due_date DESC);
DROP TRIGGER IF EXISTS set_updated_at ON public.billing_payments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.billing_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.billing_webhook_events (
  event_id      TEXT PRIMARY KEY,
  event         TEXT NOT NULL,
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  error         TEXT
);

ALTER TABLE public.account_billing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS account_billing_select ON public.account_billing;
CREATE POLICY account_billing_select ON public.account_billing FOR SELECT
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS billing_payments_select ON public.billing_payments;
CREATE POLICY billing_payments_select ON public.billing_payments FOR SELECT
  USING (is_account_member(account_id, 'admin'));
-- billing_webhook_events: no policy at all — service role only.
REVOKE ALL ON TABLE public.account_billing, public.billing_payments, public.billing_webhook_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.account_billing, public.billing_payments TO authenticated;
GRANT ALL ON TABLE public.account_billing, public.billing_payments, public.billing_webhook_events TO service_role;

-- A confirmed payment of the account's CURRENT subscription: the account
-- gets the plan/version it subscribed to, active until p_period_end (never
-- shortened by an older payment). A late payment of an older charge does
-- not lift past_due. A platform suspension is never lifted by paying.
CREATE OR REPLACE FUNCTION public.billing_activate(p_account_id UUID, p_subscription_id TEXT, p_period_end TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  b public.account_billing%ROWTYPE;
  v_end TIMESTAMPTZ;
BEGIN
  SELECT * INTO b FROM public.account_billing
   WHERE account_id = p_account_id AND asaas_subscription_id = p_subscription_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF; -- replaced meanwhile
  IF b.status = 'past_due' AND p_period_end <= coalesce(b.current_period_end, '-infinity') THEN
    RETURN FALSE; -- an older charge: it does not cover the overdue one
  END IF;
  v_end := greatest(coalesce(b.current_period_end, p_period_end), p_period_end);
  UPDATE public.account_billing
     SET status = 'active', current_period_end = v_end
   WHERE account_id = p_account_id;
  UPDATE public.accounts
     SET plan = b.plan, plan_version_id = b.plan_version_id,
         plan_status = 'active', plan_expires_at = v_end
   WHERE id = p_account_id AND plan_status <> 'suspended';
  RETURN TRUE;
END;
$$;

-- Overdue / refunded / chargeback of the current subscription: the account
-- turns past_due (read-only in the app). Only an active account changes:
-- trial, suspended and canceled stay what they are.
CREATE OR REPLACE FUNCTION public.billing_mark_past_due(p_account_id UUID, p_subscription_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.account_billing SET status = 'past_due'
   WHERE account_id = p_account_id AND asaas_subscription_id = p_subscription_id
     AND status IN ('active', 'past_due');
  IF NOT FOUND THEN RETURN FALSE; END IF;
  UPDATE public.accounts SET plan_status = 'past_due' WHERE id = p_account_id AND plan_status = 'active';
  RETURN TRUE;
END;
$$;

-- Safety net (cron): a paid period that ended without a new confirmed
-- payment (subscription deleted in Asaas, webhook queue paused) turns
-- past_due. current_period_end already includes the grace days.
CREATE OR REPLACE FUNCTION public.billing_expire_lapsed()
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH lapsed AS (
    UPDATE public.account_billing SET status = 'past_due'
     WHERE status = 'active' AND current_period_end < now()
    RETURNING account_id
  )
  UPDATE public.accounts a SET plan_status = 'past_due'
    FROM lapsed WHERE a.id = lapsed.account_id AND a.plan_status = 'active';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.billing_activate(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_mark_past_due(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.billing_expire_lapsed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_activate(UUID, TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_mark_past_due(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.billing_expire_lapsed() TO service_role;

NOTIFY pgrst, 'reload schema';
