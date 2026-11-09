-- ============================================================
-- 109_lead_origins.sql — Where customers came from ("Origem dos clientes", part A).
--
-- Spec: docs/superpowers/specs/2026-11-09-origem-dos-clientes.md
--
-- What this migration does
--   1. lead_origins: one row per "touch" — an ad, post, link, campaign or referrer that
--      actually arrived with a contact (WhatsApp referral, Baileys externalAdReply,
--      Instagram/Messenger referral, site bot / form UTMs). Only the server (service
--      role) writes. Every member of the account reads, EXCEPT the column click_id
--      (ctwa_clid / gclid / fbclid): authenticated has a column-level SELECT grant
--      without it, so `select *` is refused for the browser and the id stays server-side
--      (part B sends it to Meta).
--   2. contacts.first_origin_id / last_origin_id and deals.origin_id (+ origin_set_by /
--      origin_set_at), all FK -> lead_origins ON DELETE SET NULL.
--   3. Guards (SECURITY INVOKER, pinned search_path):
--        lead_origins_guard     contact and conversation belong to the row's account;
--                               account and contact never change.
--        contacts_origin_guard  user roles never write the origin pointers; a pointer must
--                               name a touch of the same contact and account.
--        deals_origin_guard     BEFORE INSERT: when origin_id is null, copy the contact's last
--                               touch if it happened in the last 30 days (one place for every
--                               writer: deal form, automations, lead capture, AI). User roles
--                               cannot choose it on insert. BEFORE UPDATE: only admin+ (owner
--                               counts) may change origin_id; stamps origin_set_by / origin_set_at.
--   4. record_lead_origin(): the single write path of a touch (service_role only): advisory lock,
--      24h dedup, 50-per-day cap, insert and pointers in ONE statement.
--   5. origin_report(): the numbers of Reports -> "Origem dos clientes", SECURITY INVOKER
--      (RLS scopes the rows), grants in the 083-086 style; finite period of at most 400 days.
--
-- Billing block (094): authenticated has no write grant on lead_origins, so there is no
-- read-only RESTRICTIVE policy to add; deals / contacts keep theirs (an origin change on a
-- read-only account is refused by the deals RESTRICTIVE UPDATE policy).
-- LGPD: lead_origins.contact_id is ON DELETE CASCADE (hard delete); anonymization deletes the
-- rows (src/lib/lgpd/anonymize.ts) and the pointers go NULL through the FKs.
--
-- Grants follow 076/104: nothing for PUBLIC/anon.
-- Rollback: supabase/rollback/109_rollback.sql. SQL test: supabase/tests/lead_origins.sql.
-- Idempotent.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.lead_origins (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  channel         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  ad_id           TEXT,
  source_id       TEXT,
  source_url      TEXT,
  headline        TEXT,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  utm_content     TEXT,
  utm_term        TEXT,
  referrer_host   TEXT,
  click_id_type   TEXT,
  click_id        TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.lead_origins DROP CONSTRAINT IF EXISTS lead_origins_channel_check;
ALTER TABLE public.lead_origins ADD CONSTRAINT lead_origins_channel_check
  CHECK (channel IN ('whatsapp', 'whatsapp_qr', 'instagram', 'messenger', 'site_bot', 'webhook'));
ALTER TABLE public.lead_origins DROP CONSTRAINT IF EXISTS lead_origins_kind_check;
ALTER TABLE public.lead_origins ADD CONSTRAINT lead_origins_kind_check
  CHECK (kind IN ('ad', 'post', 'link', 'campaign', 'referrer'));
ALTER TABLE public.lead_origins DROP CONSTRAINT IF EXISTS lead_origins_click_id_type_check;
ALTER TABLE public.lead_origins ADD CONSTRAINT lead_origins_click_id_type_check
  CHECK (click_id_type IS NULL OR click_id_type IN ('ctwa_clid', 'gclid', 'fbclid'));
ALTER TABLE public.lead_origins DROP CONSTRAINT IF EXISTS lead_origins_click_id_pair_check;
ALTER TABLE public.lead_origins ADD CONSTRAINT lead_origins_click_id_pair_check
  CHECK ((click_id IS NULL) = (click_id_type IS NULL));
ALTER TABLE public.lead_origins DROP CONSTRAINT IF EXISTS lead_origins_text_len_check;
ALTER TABLE public.lead_origins ADD CONSTRAINT lead_origins_text_len_check CHECK (
  char_length(ad_id) <= 120 AND char_length(source_id) <= 200 AND char_length(source_url) <= 1000
  AND char_length(headline) <= 300 AND char_length(utm_source) <= 120 AND char_length(utm_medium) <= 120
  AND char_length(utm_campaign) <= 200 AND char_length(utm_content) <= 200 AND char_length(utm_term) <= 200
  AND char_length(referrer_host) <= 253 AND char_length(click_id) <= 600
);
-- Empty strings are "no value": the report and the labels look at NULL only.
ALTER TABLE public.lead_origins DROP CONSTRAINT IF EXISTS lead_origins_no_blank_check;
ALTER TABLE public.lead_origins ADD CONSTRAINT lead_origins_no_blank_check CHECK (
  btrim(ad_id) <> '' AND btrim(source_id) <> '' AND btrim(source_url) <> '' AND btrim(headline) <> ''
  AND btrim(utm_source) <> '' AND btrim(utm_medium) <> '' AND btrim(utm_campaign) <> ''
  AND btrim(utm_content) <> '' AND btrim(utm_term) <> '' AND btrim(referrer_host) <> '' AND btrim(click_id) <> ''
);

CREATE INDEX IF NOT EXISTS idx_lead_origins_account_time ON public.lead_origins (account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_lead_origins_contact_time ON public.lead_origins (contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_origins_conversation ON public.lead_origins (conversation_id) WHERE conversation_id IS NOT NULL;

-- ---- pointers ---------------------------------------------------------------
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS first_origin_id UUID;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS last_origin_id  UUID;
ALTER TABLE public.deals    ADD COLUMN IF NOT EXISTS origin_id       UUID;
ALTER TABLE public.deals    ADD COLUMN IF NOT EXISTS origin_set_by   UUID;
ALTER TABLE public.deals    ADD COLUMN IF NOT EXISTS origin_set_at   TIMESTAMPTZ;

ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_first_origin_id_fkey;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_first_origin_id_fkey
  FOREIGN KEY (first_origin_id) REFERENCES public.lead_origins(id) ON DELETE SET NULL;
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_last_origin_id_fkey;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_last_origin_id_fkey
  FOREIGN KEY (last_origin_id) REFERENCES public.lead_origins(id) ON DELETE SET NULL;
ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_origin_id_fkey;
ALTER TABLE public.deals ADD CONSTRAINT deals_origin_id_fkey
  FOREIGN KEY (origin_id) REFERENCES public.lead_origins(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;  -- a hard delete of a contact cascades to its touches AND updates its deals
                                   -- (contact_id SET NULL) in one statement: check at commit, after the SET NULL
ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_origin_set_by_fkey;
ALTER TABLE public.deals ADD CONSTRAINT deals_origin_set_by_fkey
  FOREIGN KEY (origin_set_by) REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_first_origin ON public.contacts (first_origin_id) WHERE first_origin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deals_origin ON public.deals (origin_id) WHERE origin_id IS NOT NULL;

-- ---- guards ---------------------------------------------------------------
-- A user session (PostgREST JWT), as opposed to service_role / postgres (same test as 094 / 076).
CREATE OR REPLACE FUNCTION private.is_user_session()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_temp
AS $$ SELECT current_user IN ('authenticated', 'anon') OR auth.uid() IS NOT NULL $$;
REVOKE ALL ON FUNCTION private.is_user_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_user_session() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.lead_origins_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.contact_id IS DISTINCT FROM OLD.contact_id) THEN
    RAISE EXCEPTION 'the account and contact of a touch never change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM public.contacts c WHERE c.id = NEW.contact_id AND c.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'contact does not belong to this account' USING ERRCODE = '23503';
  END IF;
  IF NEW.conversation_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id) AND NOT EXISTS (
    SELECT 1 FROM public.conversations v
     WHERE v.id = NEW.conversation_id AND v.account_id = NEW.account_id AND v.contact_id = NEW.contact_id
  ) THEN
    RAISE EXCEPTION 'conversation does not belong to this contact' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.lead_origins_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS lead_origins_guard ON public.lead_origins;
CREATE TRIGGER lead_origins_guard BEFORE INSERT OR UPDATE ON public.lead_origins
  FOR EACH ROW EXECUTE FUNCTION public.lead_origins_guard();

CREATE OR REPLACE FUNCTION public.contacts_origin_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.first_origin_id IS NOT DISTINCT FROM OLD.first_origin_id
     AND NEW.last_origin_id IS NOT DISTINCT FROM OLD.last_origin_id THEN
    RETURN NEW;
  END IF;
  IF private.is_user_session() THEN
    IF TG_OP = 'INSERT' THEN
      NEW.first_origin_id := NULL;
      NEW.last_origin_id := NULL;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'origin pointers are written by the server only' USING ERRCODE = '42501';
  END IF;
  -- Only a pointer that CHANGES is checked: the FK's ON DELETE SET NULL updates one column while the
  -- other still names a touch that is being deleted in the same statement.
  FOREACH v_id IN ARRAY ARRAY[
    CASE WHEN TG_OP = 'INSERT' OR NEW.first_origin_id IS DISTINCT FROM OLD.first_origin_id THEN NEW.first_origin_id END,
    CASE WHEN TG_OP = 'INSERT' OR NEW.last_origin_id IS DISTINCT FROM OLD.last_origin_id THEN NEW.last_origin_id END
  ] LOOP
    IF v_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.lead_origins o WHERE o.id = v_id AND o.contact_id = NEW.id AND o.account_id = NEW.account_id
    ) THEN
      RAISE EXCEPTION 'origin does not belong to this contact' USING ERRCODE = '23503';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.contacts_origin_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS contacts_origin_guard ON public.contacts;
CREATE TRIGGER contacts_origin_guard BEFORE INSERT OR UPDATE OF first_origin_id, last_origin_id ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_origin_guard();

CREATE OR REPLACE FUNCTION public.deals_origin_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user boolean := private.is_user_session();
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A user session never chooses the origin of a new deal: it is the contact's last touch.
    IF v_user THEN
      NEW.origin_id := NULL;
      NEW.origin_set_by := NULL;
      NEW.origin_set_at := NULL;
    END IF;
    IF NEW.origin_id IS NULL AND NEW.contact_id IS NOT NULL THEN
      SELECT o.id INTO NEW.origin_id
        FROM public.contacts c
        JOIN public.lead_origins o ON o.id = c.last_origin_id
       WHERE c.id = NEW.contact_id AND c.account_id = NEW.account_id
         AND o.occurred_at >= now() - interval '30 days';
    END IF;
  ELSE
    IF NEW.origin_id IS NOT DISTINCT FROM OLD.origin_id THEN
      -- The stamp only moves together with the origin.
      IF v_user THEN
        NEW.origin_set_by := OLD.origin_set_by;
        NEW.origin_set_at := OLD.origin_set_at;
      END IF;
      RETURN NEW;
    END IF;
    IF v_user THEN
      IF NOT public.is_account_member(NEW.account_id, 'admin') THEN
        RAISE EXCEPTION 'only an admin can change the origin of a deal' USING ERRCODE = '42501';
      END IF;
      NEW.origin_set_by := auth.uid();
      NEW.origin_set_at := now();
    END IF;
  END IF;
  IF NEW.origin_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.lead_origins o WHERE o.id = NEW.origin_id AND o.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'origin does not belong to this account' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.deals_origin_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS deals_origin_guard ON public.deals;
CREATE TRIGGER deals_origin_guard BEFORE INSERT OR UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deals_origin_guard();

-- ---- grants + RLS -------------------------------------------------------------
REVOKE ALL ON public.lead_origins FROM PUBLIC, anon, authenticated;
-- Every column but click_id (server-side only).
GRANT SELECT (id, account_id, contact_id, conversation_id, channel, kind, ad_id, source_id, source_url, headline,
              utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer_host, click_id_type,
              occurred_at, created_at)
  ON public.lead_origins TO authenticated;
GRANT ALL ON public.lead_origins TO service_role;

ALTER TABLE public.lead_origins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_origins_select ON public.lead_origins;
CREATE POLICY lead_origins_select ON public.lead_origins FOR SELECT USING (public.is_account_member(account_id));

-- ---- origin buckets ---------------------------------------------------------------
-- What a touch is called in the report (ad > campaign > referrer > paid click id > direct). A NULL
-- kind (no touch) is "direct". Same order as originName() in src/lib/lead-origins/label.ts.
CREATE OR REPLACE FUNCTION private.origin_bucket(
  p_kind text, p_channel text, p_headline text, p_ad_id text, p_source_id text,
  p_utm_campaign text, p_utm_source text, p_referrer_host text, p_click_id_type text
)
RETURNS TABLE (t text, ch text, nm text, src text)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_temp
AS $$
  SELECT
    CASE WHEN p_kind IN ('ad', 'post') THEN 'ad'
         WHEN p_utm_campaign IS NOT NULL OR (p_kind = 'link' AND p_source_id IS NOT NULL) THEN 'campaign'
         WHEN p_referrer_host IS NOT NULL THEN 'referrer'
         WHEN p_click_id_type IN ('gclid', 'fbclid') THEN 'paid'
         ELSE 'direct' END,
    CASE WHEN p_kind IS NULL THEN '' ELSE coalesce(p_channel, '') END,
    CASE WHEN p_kind IN ('ad', 'post') THEN coalesce(p_headline, p_ad_id, p_source_id, '')
         WHEN p_utm_campaign IS NOT NULL THEN p_utm_campaign
         WHEN p_kind = 'link' AND p_source_id IS NOT NULL THEN p_source_id
         WHEN p_referrer_host IS NOT NULL THEN p_referrer_host
         WHEN p_click_id_type = 'gclid' THEN 'Google Ads'
         WHEN p_click_id_type = 'fbclid' THEN 'Facebook/Instagram Ads'
         ELSE '' END,
    CASE WHEN p_kind IS NOT NULL AND p_kind NOT IN ('ad', 'post') THEN coalesce(p_utm_source, '') ELSE '' END
$$;
REVOKE ALL ON FUNCTION private.origin_bucket(text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.origin_bucket(text, text, text, text, text, text, text, text, text) TO authenticated, service_role;

-- ---- record_lead_origin ------------------------------------------------------------
-- The ONE write path of a touch (service_role only; the app's recordTouch is a single rpc call), so a
-- slow or killed request never leaves a touch without its pointers. Under an advisory lock on the
-- contact (two deliveries of the same ad never both insert):
--   * at most 50 touches per contact in 24h (a sender cannot flood the table);
--   * the same touch (channel, kind, ad / source / source_url / utm_source / utm_campaign / utm_content /
--     referrer host) in the same conversation inside 24h is not a new touch;
--   * pointers: a TRUSTED touch (the contact came through a channel the sender cannot fake, or this very
--     submission created the contact) moves last_origin_id when it is not older than the current last
--     touch. An untrusted one (a site / form submission for a customer that already exists) is still
--     stored as history but moves nothing, so a stranger who types a known number can neither claim the
--     last touch (new deals inherit it for 30 days) nor the first one. Either pointer is filled when it
--     is still NULL, trusted or not.
-- Returns the new touch id, or NULL when nothing was written.
-- (dropped first: CREATE OR REPLACE cannot rename a parameter, and this migration is re-run while in development)
DROP FUNCTION IF EXISTS public.record_lead_origin(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, timestamptz, boolean);
CREATE OR REPLACE FUNCTION public.record_lead_origin(
  p_account_id      uuid,
  p_contact_id      uuid,
  p_conversation_id uuid,
  p_channel         text,
  p_kind            text,
  p_ad_id           text,
  p_source_id       text,
  p_source_url      text,
  p_headline        text,
  p_utm_source      text,
  p_utm_medium      text,
  p_utm_campaign    text,
  p_utm_content     text,
  p_utm_term        text,
  p_referrer_host   text,
  p_click_id_type   text,
  p_click_id        text,
  p_occurred_at     timestamptz,
  p_trusted_pointers boolean
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_contact_id::text));

  IF (SELECT count(*) FROM public.lead_origins o
       WHERE o.contact_id = p_contact_id AND o.occurred_at >= p_occurred_at - interval '24 hours') >= 50 THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.lead_origins o
     WHERE o.contact_id = p_contact_id
       AND o.occurred_at >= p_occurred_at - interval '24 hours'
       AND o.conversation_id IS NOT DISTINCT FROM p_conversation_id
       AND o.channel = p_channel AND o.kind = p_kind
       AND o.ad_id IS NOT DISTINCT FROM p_ad_id
       AND o.source_id IS NOT DISTINCT FROM p_source_id
       AND o.source_url IS NOT DISTINCT FROM p_source_url
       AND o.utm_source IS NOT DISTINCT FROM p_utm_source
       AND o.utm_campaign IS NOT DISTINCT FROM p_utm_campaign
       AND o.utm_content IS NOT DISTINCT FROM p_utm_content
       AND o.referrer_host IS NOT DISTINCT FROM p_referrer_host
     ORDER BY o.occurred_at DESC
     LIMIT 1
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.lead_origins (
    account_id, contact_id, conversation_id, channel, kind, ad_id, source_id, source_url, headline,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, referrer_host, click_id_type, click_id, occurred_at
  ) VALUES (
    p_account_id, p_contact_id, p_conversation_id, p_channel, p_kind, p_ad_id, p_source_id, p_source_url, p_headline,
    p_utm_source, p_utm_medium, p_utm_campaign, p_utm_content, p_utm_term, p_referrer_host, p_click_id_type, p_click_id, p_occurred_at
  ) RETURNING id INTO v_id;

  UPDATE public.contacts c
     SET last_origin_id = v_id
   WHERE c.id = p_contact_id AND c.account_id = p_account_id
     AND (c.last_origin_id IS NULL
          OR (p_trusted_pointers
              AND p_occurred_at >= (SELECT o.occurred_at FROM public.lead_origins o WHERE o.id = c.last_origin_id)));

  UPDATE public.contacts c
     SET first_origin_id = v_id
   WHERE c.id = p_contact_id AND c.account_id = p_account_id AND c.first_origin_id IS NULL;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_lead_origin(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, timestamptz, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_lead_origin(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, text, timestamptz, boolean)
  TO service_role;

-- ---- origin_report ----------------------------------------------------------
-- One row per origin bucket. Bucket = what the customer sees (spec): an ad (kind ad / post:
-- headline, else the ad / source id) per channel; else a campaign (utm_campaign, or the ref of a
-- link) per utm_source; else the referrer host; else "paid" (only a Google / Facebook click id:
-- "Google Ads" / "Facebook/Instagram Ads"); else "direct" (no touch at all). Cohorts are
-- by creation date: customers = contacts created in [p_start, p_end) by their FIRST touch;
-- deals = deals created in the range by deals.origin_id; won = those of them now won.
-- Only the touches those rows point at are classified (a lateral join by primary key), never the whole
-- table. p_channel keeps only buckets of that channel (direct is dropped); p_pipeline_id narrows the
-- deals and counts only contacts that have a deal in that pipeline. The range must be finite and at
-- most 400 days. Names are the customer's free text (ad / campaign): the app shows them as data.
CREATE OR REPLACE FUNCTION public.origin_report(
  p_start       timestamptz,
  p_end         timestamptz,
  p_channel     text DEFAULT NULL,
  p_pipeline_id uuid DEFAULT NULL
)
RETURNS TABLE (
  origin_type    text,
  channel        text,
  name           text,
  source         text,
  customers      integer,
  deals_created  integer,
  deals_won      integer,
  won_value      numeric,
  conversion_pct numeric,
  avg_ticket     numeric
)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) THEN
    RAISE EXCEPTION 'origin_report needs a finite period' USING ERRCODE = '22023';
  END IF;
  IF p_end - p_start > interval '400 days' THEN
    RAISE EXCEPTION 'origin_report period is limited to 400 days' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH cust AS (
    SELECT b.t, b.ch, b.nm, b.src, count(*)::integer AS n
      FROM public.contacts c
      LEFT JOIN public.lead_origins o ON o.id = c.first_origin_id
      CROSS JOIN LATERAL (SELECT * FROM private.origin_bucket(o.kind, o.channel, o.headline, o.ad_id, o.source_id,
                                                              o.utm_campaign, o.utm_source, o.referrer_host, o.click_id_type)) b
     WHERE c.created_at >= p_start AND c.created_at < p_end
       AND (p_pipeline_id IS NULL OR EXISTS (
             SELECT 1 FROM public.deals d WHERE d.contact_id = c.id AND d.pipeline_id = p_pipeline_id))
     GROUP BY 1, 2, 3, 4
  ),
  dl AS (
    SELECT b.t, b.ch, b.nm, b.src,
           count(*)::integer AS created,
           (count(*) FILTER (WHERE d.status = 'won'))::integer AS won,
           coalesce(sum(d.value) FILTER (WHERE d.status = 'won'), 0) AS won_value
      FROM public.deals d
      LEFT JOIN public.lead_origins o ON o.id = d.origin_id
      CROSS JOIN LATERAL (SELECT * FROM private.origin_bucket(o.kind, o.channel, o.headline, o.ad_id, o.source_id,
                                                              o.utm_campaign, o.utm_source, o.referrer_host, o.click_id_type)) b
     WHERE d.created_at >= p_start AND d.created_at < p_end
       AND (p_pipeline_id IS NULL OR d.pipeline_id = p_pipeline_id)
     GROUP BY 1, 2, 3, 4
  ),
  joined AS (
    SELECT coalesce(c.t, d.t) AS t, coalesce(c.ch, d.ch) AS ch, coalesce(c.nm, d.nm) AS nm, coalesce(c.src, d.src) AS src,
           coalesce(c.n, 0) AS customers, coalesce(d.created, 0) AS created, coalesce(d.won, 0) AS won,
           coalesce(d.won_value, 0) AS won_value
      FROM cust c
      FULL JOIN dl d ON d.t = c.t AND d.ch = c.ch AND d.nm = c.nm AND d.src = c.src
  )
  SELECT j.t, j.ch, j.nm, j.src, j.customers, j.created, j.won, j.won_value,
         CASE WHEN j.created > 0 THEN round(100.0 * j.won / j.created, 1) ELSE 0 END,
         CASE WHEN j.won > 0 THEN round(j.won_value / j.won, 2) ELSE 0 END
    FROM joined j
   WHERE p_channel IS NULL OR j.ch = p_channel
   ORDER BY j.won_value DESC, j.won DESC, j.customers DESC, j.nm
   LIMIT 500;
END;
$$;
REVOKE ALL ON FUNCTION public.origin_report(timestamptz, timestamptz, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.origin_report(timestamptz, timestamptz, text, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
