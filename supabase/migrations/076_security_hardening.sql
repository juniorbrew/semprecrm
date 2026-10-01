-- ============================================================
-- 076_security_hardening.sql — database hardening from the internal
-- security audit. Every item was reproduced on the local database first;
-- supabase/tests/security_hardening.sql proves each fix (attack fails,
-- legitimate path still works).
--
-- "User roles" below = current_user IN ('authenticated', 'anon'), i.e. a
-- PostgREST request with a user/anon JWT. service_role and SECURITY
-- DEFINER functions owned by postgres (current_user = postgres) are the
-- trusted server paths and keep working.
--
--  1. accounts: an account admin could UPDATE plan, plan_status,
--     plan_expires_at, module_overrides, limit_overrides, platform_notes,
--     owner_user_id on their own account. BEFORE UPDATE trigger
--     enforce_account_platform_columns rejects that for user roles —
--     including a platform admin writing the table directly through
--     accounts_platform_update, which would skip the gated, audited
--     /api/platform route. platform_update_account and
--     transfer_account_ownership are SECURITY DEFINER (run as postgres)
--     and keep working. platform_notes is no longer readable by
--     user roles: table-level SELECT is replaced by a column list without
--     it (the app never selects accounts with '*'; platform admins read the
--     notes through platform_list_accounts()). A NEW accounts column must be
--     added to that GRANT to be readable by the app.
--  2. storage: dropped the public SELECT policies of chat-media,
--     flow-media, avatars and account-branding (they let anon LIST every
--     tenant's files). Public buckets still serve objects by URL — the
--     storage API reads /object/public/* as superuser, no policy involved.
--     A SELECT policy scoped to the caller's own folder is kept for
--     authenticated, because upload(upsert: true) and remove() need it.
--     flow-media writes now require agent+ (viewers cannot upload, replace
--     or delete media); the legacy "<user id>/" folder of flow-media is no
--     longer writable (the app writes only "account-<id>/"; old objects are
--     still served). chat-media WRITE policies are NOT touched here:
--     migration 078 owns them (agent+ through chat_media_writable()).
--     SVG removed from account-branding (stored XSS through a same-origin
--     logo).
--  3. Function privileges: _bcast_bump, recompute_broadcast_counts,
--     chat_insert_system_message, merge_duplicate_contacts,
--     seed_task_statuses, seed_deal_loss_reasons and EVERY trigger
--     function are no longer executable by PUBLIC/anon/authenticated.
--     An explicit list of signed-in-only SECURITY DEFINER RPCs (member
--     management, invitation redeem, platform_*, chat_* RPCs) loses anon;
--     every other function keeps its current grants — in particular the
--     helpers called by RLS / storage policies (is_account_member,
--     is_chat_thread_member, chat_internal_object_allowed,
--     can_read/edit_calendar_event) and peek_invitation (anonymous invite
--     page) stay executable by anon. New functions are
--     closed by default (default privileges): a future migration MUST
--     GRANT EXECUTE explicitly to whoever calls it, including functions
--     used inside RLS policies. TRUNCATE / TRIGGER / REFERENCES revoked
--     from anon/authenticated on every table (and by default for new ones).
--  4. calendar_connections_public: the view (owned by postgres, no
--     security_invoker) was auto-updatable and writable by authenticated —
--     anyone could insert a connection into another account. Read-only now.
--  5. lead_sources: the row holds the webhook credential (token) and was
--     readable by every member. SELECT is admin+ now; agents keep the
--     automation trigger picker through the token-less view
--     lead_sources_public (id, account_id, name, is_active).
--  6. profiles: dropped profiles_insert. Profiles are created only by
--     handle_new_user() (SECURITY DEFINER); the policy let a user without a
--     profile insert one as owner of any account.
--  7. Cross-tenant references: one generic guard, enforce_same_account(),
--     attached per (table, column) — a referenced contact / deal / stage /
--     user / ... must belong to the row's own account. Applies to every
--     role (service role included); one indexed lookup per reference, only
--     when the column (or the row's account) changes. Not attached to the
--     service-only tables (automation queues, AI jobs, CSAT jobs, logs)
--     nor where a guard already exists (conversations.category_id/team_id,
--     deals.company_id, contact_companies, ai_knowledge_chunks,
--     team_members, routing_rules) or RLS already checks the parent
--     (conversation_events, ai_contact_memories). The guard only fires
--     when the guarded column (or the row's account / anchor) actually
--     changes, so pre-existing cross-tenant rows keep working until someone
--     points that column at another cross-tenant value. Run check 6 of
--     supabase/tests/security_hardening_prod_check.sql before deploying.
--
-- Run at a quiet hour: lock_timeout = 5s makes the migration fail fast
-- (and roll back) instead of queueing behind long transactions on the
-- altered tables; just retry on a lock timeout.
-- Rollback: supabase/rollback/076_rollback.sql (forward script, by hand).
--  8. contacts (LGPD): for user roles, anonymized_at cannot change, an
--     anonymized row cannot change at all, and opted_out_at can only be
--     cleared by agent+ (the inbox "reactivate" button, contact-sidebar.tsx,
--     clears it with the user's session — kept on purpose). Anonymization
--     runs with the service role.
--  9. whatsapp_config: access_token / verify_token ciphertext is no longer
--     readable by user roles (column list GRANT without them). Every server
--     route that needs the token now reads it with the service role,
--     filtered by the caller's account.
-- 10. ai_contact_memories: for user roles an AI-sourced fact is always
--     inserted as 'proposed' (approval flow), activating needs agent+
--     (approved_by is stamped with auth.uid() by ai_contact_memories_stamp),
--     and for every role a fact holding a CPF (formatted, or 11 digits with
--     valid check digits) or a 13–19 digit Luhn-valid number is rejected.
-- 11. KNOWN LIMITATION, not changed: the internal chat presence channel
--     (realtime) is public — realtime.messages has no authorization
--     policy, so a user who knows a channel name can join it. Fixing it
--     means private channels + realtime.messages policies + client changes.
--
-- Intentionally NOT changed:
--   * MFA (aal2) enforcement in RLS: a product decision (who must enrol,
--     recovery flow); enforcing it in policies would lock out every
--     account without MFA.
--   * realtime authorization (item 11).
--   * supabase_admin's default privileges (owned by another role; our
--     migrations run as postgres).
--
-- Idempotent.
-- ============================================================

SET lock_timeout = '5s';


-- ============================================================
-- 1. accounts — platform-managed columns
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_account_platform_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND (NEW.plan IS DISTINCT FROM OLD.plan
          OR NEW.plan_status IS DISTINCT FROM OLD.plan_status
          OR NEW.plan_expires_at IS DISTINCT FROM OLD.plan_expires_at
          OR NEW.module_overrides IS DISTINCT FROM OLD.module_overrides
          OR NEW.limit_overrides IS DISTINCT FROM OLD.limit_overrides
          OR NEW.platform_notes IS DISTINCT FROM OLD.platform_notes
          OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id)
  THEN
    RAISE EXCEPTION
      'plan, overrides, platform notes and owner are managed by the platform'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_account_platform_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_account_platform_columns ON public.accounts;
CREATE TRIGGER enforce_account_platform_columns
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_platform_columns();

REVOKE SELECT ON public.accounts FROM anon, authenticated;
GRANT SELECT (
  id, name, owner_user_id, created_at, updated_at, default_currency,
  plan, plan_status, plan_expires_at, module_overrides, limit_overrides,
  preferences, branding, person_type, tax_id, legal_name, address, phone, email
) ON public.accounts TO authenticated;


-- ============================================================
-- 2. storage
-- ============================================================

DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Account branding is publicly readable" ON storage.objects;

-- "account-<uuid>/..." → is the caller at least p_role there? The CASE
-- keeps the uuid cast away from any other folder name.
DROP POLICY IF EXISTS "Members read own chat media" ON storage.objects;
CREATE POLICY "Members read own chat media" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'chat-media' AND CASE
    WHEN (storage.foldername(name))[1] ~ '^account-[0-9a-f-]{36}$'
    THEN public.is_account_member(substring((storage.foldername(name))[1] FROM 9)::uuid)
    ELSE false END);

-- chat-media INSERT/UPDATE/DELETE: owned by migration 078 (not changed here).

DROP POLICY IF EXISTS "Members read own flow media" ON storage.objects;
CREATE POLICY "Members read own flow media" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'flow-media' AND CASE
    WHEN (storage.foldername(name))[1] ~ '^account-[0-9a-f-]{36}$'
    THEN public.is_account_member(substring((storage.foldername(name))[1] FROM 9)::uuid)
    ELSE false END);

DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'flow-media' AND CASE
    WHEN (storage.foldername(name))[1] ~ '^account-[0-9a-f-]{36}$'
    THEN public.is_account_member(substring((storage.foldername(name))[1] FROM 9)::uuid, 'agent')
    ELSE false END);

DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'flow-media' AND CASE
    WHEN (storage.foldername(name))[1] ~ '^account-[0-9a-f-]{36}$'
    THEN public.is_account_member(substring((storage.foldername(name))[1] FROM 9)::uuid, 'agent')
    ELSE false END);

DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'flow-media' AND CASE
    WHEN (storage.foldername(name))[1] ~ '^account-[0-9a-f-]{36}$'
    THEN public.is_account_member(substring((storage.foldername(name))[1] FROM 9)::uuid, 'agent')
    ELSE false END);

DROP POLICY IF EXISTS "Users read own avatar" ON storage.objects;
CREATE POLICY "Users read own avatar" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND (auth.uid())::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Admins read own account branding" ON storage.objects;
CREATE POLICY "Admins read own account branding" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'account-branding' AND CASE
    WHEN (storage.foldername(name))[1] ~ '^account-[0-9a-f-]{36}$'
    THEN public.is_account_member(substring((storage.foldername(name))[1] FROM 9)::uuid, 'admin')
    ELSE false END);

UPDATE storage.buckets
   SET allowed_mime_types = array_remove(allowed_mime_types, 'image/svg+xml')
 WHERE id = 'account-branding'
   AND 'image/svg+xml' = ANY (allowed_mime_types);


-- ============================================================
-- 3. function and table privileges
-- ============================================================

REVOKE EXECUTE ON FUNCTION public._bcast_bump(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recompute_broadcast_counts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.chat_insert_system_message(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.merge_duplicate_contacts() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_task_statuses(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.seed_deal_loss_reasons(uuid) FROM PUBLIC, anon, authenticated;

-- Trigger functions are run by the trigger mechanism (no EXECUTE check).
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prorettype = 'trigger'::regtype
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END $$;

-- Signed-in only (no RLS/storage policy and no anonymous page calls them).
REVOKE EXECUTE ON FUNCTION public.set_member_role(uuid, account_role_enum) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.remove_account_member(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.transfer_account_ownership(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.redeem_invitation(text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_list_accounts() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.platform_update_account(uuid, jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.chat_get_or_create_direct_thread(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.chat_can_manage_group(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.chat_create_group(text, uuid[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.chat_add_members(uuid, uuid[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.chat_remove_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.chat_leave_group(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.chat_mark_delivered(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.chat_mark_read(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.chat_unread_counts() FROM PUBLIC, anon;

-- New functions: closed by default. The schema entry is Supabase's grant
-- to anon/authenticated; the global entry is PostgreSQL's built-in
-- EXECUTE-to-PUBLIC (anon and authenticated are members of PUBLIC, so the
-- schema revoke alone would not close anything).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;


-- ============================================================
-- 4. calendar_connections_public — read-only
-- ============================================================

REVOKE ALL ON public.calendar_connections_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.calendar_connections_public TO authenticated, service_role;


-- ============================================================
-- 5. lead_sources — the token is admin-only
-- ============================================================

DROP POLICY IF EXISTS lead_sources_select ON public.lead_sources;
CREATE POLICY lead_sources_select ON public.lead_sources
  FOR SELECT USING (is_account_member(account_id, 'admin'));

-- What an agent needs to pick a source in the automation builder. Owned
-- by postgres (reads past the admin-only policy); the WHERE clause is the
-- access rule; read-only.
CREATE OR REPLACE VIEW public.lead_sources_public
WITH (security_barrier = true) AS
  SELECT id, account_id, name, is_active
    FROM public.lead_sources
   WHERE is_account_member(account_id);

ALTER VIEW public.lead_sources_public OWNER TO postgres;
REVOKE ALL ON public.lead_sources_public FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.lead_sources_public TO authenticated, service_role;


-- ============================================================
-- 6. profiles — created only by handle_new_user()
-- ============================================================

DROP POLICY IF EXISTS profiles_insert ON public.profiles;


-- ============================================================
-- 7. cross-tenant references
--
-- enforce_same_account(col, ref [, anchor_col, anchor_ref])
--   col         column of NEW holding the reference (uuid)
--   ref         'table' (looked up by id), 'table.key', or a full
--               "SELECT account_id ... WHERE ... = $1" for a two-hop parent
--   anchor_*    for tables without account_id: the row's account is the
--               account of NEW.anchor_col looked up through anchor_ref
-- Lookups run as the owner (no RLS) on primary keys / unique keys. The
-- arguments come only from migrations (DDL), never from user input.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_same_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new jsonb := to_jsonb(NEW);
  v_val text := v_new ->> TG_ARGV[0];
  v_self_col text := CASE WHEN TG_NARGS >= 4 THEN TG_ARGV[2] ELSE 'account_id' END;
  v_spec text;
  v_key text;
  v_self uuid;
  v_other uuid;
BEGIN
  IF v_val IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND to_jsonb(OLD) ->> TG_ARGV[0] IS NOT DISTINCT FROM v_val
     AND to_jsonb(OLD) ->> v_self_col IS NOT DISTINCT FROM v_new ->> v_self_col
  THEN
    RETURN NEW;
  END IF;

  IF TG_NARGS >= 4 THEN
    v_key := v_new ->> TG_ARGV[2];
    IF v_key IS NULL THEN
      RETURN NEW;
    END IF;
    v_spec := TG_ARGV[3];
    IF v_spec ~* '^\s*select\s' THEN
      EXECUTE v_spec INTO v_self USING v_key::uuid;
    ELSE
      EXECUTE format('SELECT account_id FROM public.%I WHERE %I = $1',
                     split_part(v_spec, '.', 1),
                     COALESCE(NULLIF(split_part(v_spec, '.', 2), ''), 'id'))
        INTO v_self USING v_key::uuid;
    END IF;
    IF v_self IS NULL THEN
      RETURN NEW;  -- missing parent: the foreign key reports it
    END IF;
  ELSE
    v_self := (v_new ->> 'account_id')::uuid;
  END IF;

  v_spec := TG_ARGV[1];
  IF v_spec ~* '^\s*select\s' THEN
    EXECUTE v_spec INTO v_other USING v_val::uuid;
  ELSE
    EXECUTE format('SELECT account_id FROM public.%I WHERE %I = $1',
                   split_part(v_spec, '.', 1),
                   COALESCE(NULLIF(split_part(v_spec, '.', 2), ''), 'id'))
      INTO v_other USING v_val::uuid;
  END IF;

  IF v_other IS DISTINCT FROM v_self THEN
    RAISE EXCEPTION '%.% must reference a row of the same account', TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_same_account() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.enforce_same_account() FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  r record;
  v_stage text := 'SELECT p.account_id FROM public.pipeline_stages s JOIN public.pipelines p ON p.id = s.pipeline_id WHERE s.id = $1';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- table,                  column,                ref,                 anchor col,     anchor ref
      ('contact_notes',          'contact_id',          'contacts',          NULL,           NULL),
      ('conversations',          'contact_id',          'contacts',          NULL,           NULL),
      ('deals',                  'contact_id',          'contacts',          NULL,           NULL),
      ('deals',                  'conversation_id',     'conversations',     NULL,           NULL),
      ('deals',                  'pipeline_id',         'pipelines',         NULL,           NULL),
      ('deals',                  'stage_id',            v_stage,             NULL,           NULL),
      ('deals',                  'loss_reason_id',      'deal_loss_reasons', NULL,           NULL),
      ('deals',                  'assigned_to',         'profiles',          NULL,           NULL),
      ('tasks',                  'contact_id',          'contacts',          NULL,           NULL),
      ('tasks',                  'conversation_id',     'conversations',     NULL,           NULL),
      ('tasks',                  'deal_id',             'deals',             NULL,           NULL),
      ('tasks',                  'status_id',           'task_statuses',     NULL,           NULL),
      ('tasks',                  'assignee_user_id',    'profiles.user_id',  NULL,           NULL),
      ('task_comments',          'task_id',             'tasks',             NULL,           NULL),
      ('lead_sources',           'pipeline_id',         'pipelines',         NULL,           NULL),
      ('lead_sources',           'stage_id',            v_stage,             NULL,           NULL),
      ('lead_sources',           'assignee_user_id',    'profiles.user_id',  NULL,           NULL),
      ('calendar_events',        'contact_id',          'contacts',          NULL,           NULL),
      ('calendar_events',        'conversation_id',     'conversations',     NULL,           NULL),
      ('calendar_events',        'deal_id',             'deals',             NULL,           NULL),
      ('calendar_events',        'task_id',             'tasks',             NULL,           NULL),
      ('calendar_events',        'chat_thread_id',      'chat_threads',      NULL,           NULL),
      ('calendar_events',        'owner_user_id',       'profiles.user_id',  NULL,           NULL),
      ('calendar_events',        'external_connection_id', 'calendar_connections', NULL,     NULL),
      ('contact_tags',           'tag_id',              'tags',              'contact_id',   'contacts'),
      ('contact_custom_values',  'custom_field_id',     'custom_fields',     'contact_id',   'contacts'),
      ('broadcast_recipients',   'contact_id',          'contacts',          'broadcast_id', 'broadcasts'),
      ('calendar_event_attendees','user_id',            'profiles.user_id',  'event_id',     'calendar_events')
    ) AS t(tbl, col, ref, anchor_col, anchor_ref)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
                   r.tbl || '_same_account_' || r.col, r.tbl);
    IF r.anchor_col IS NULL THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I, account_id ON public.%I '
        'FOR EACH ROW EXECUTE FUNCTION public.enforce_same_account(%L, %L)',
        r.tbl || '_same_account_' || r.col, r.col, r.tbl, r.col, r.ref);
    ELSE
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I, %I ON public.%I '
        'FOR EACH ROW EXECUTE FUNCTION public.enforce_same_account(%L, %L, %L, %L)',
        r.tbl || '_same_account_' || r.col, r.col, r.anchor_col, r.tbl,
        r.col, r.ref, r.anchor_col, r.anchor_ref);
    END IF;
  END LOOP;
END $$;


-- ============================================================
-- 8. contacts — LGPD markers
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_contact_lgpd_markers()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF OLD.anonymized_at IS NOT NULL THEN
    RAISE EXCEPTION 'anonymized contacts cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.anonymized_at IS DISTINCT FROM OLD.anonymized_at THEN
    RAISE EXCEPTION 'anonymized_at is set only by the anonymization flow'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Clearing an opt-out = the inbox "reactivate" button (agent+).
  IF OLD.opted_out_at IS NOT NULL AND NEW.opted_out_at IS NULL
     AND NOT public.is_account_member(OLD.account_id, 'agent')
  THEN
    RAISE EXCEPTION 'only an agent of the account can reactivate an opted-out contact'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_contact_lgpd_markers() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.enforce_contact_lgpd_markers() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_contact_lgpd_markers ON public.contacts;
CREATE TRIGGER enforce_contact_lgpd_markers
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_contact_lgpd_markers();


-- ============================================================
-- 9. whatsapp_config — ciphertext is server-only
-- ============================================================

REVOKE SELECT ON public.whatsapp_config FROM anon, authenticated;
GRANT SELECT (
  id, user_id, phone_number_id, waba_id, status, connected_at, created_at,
  updated_at, registered_at, subscribed_apps_at, last_registration_error, account_id
) ON public.whatsapp_config TO authenticated;


-- ============================================================
-- 10. ai_contact_memories — approval flow and sensitive data
-- ============================================================

-- Mirrors isSensitiveFact()'s document check in src/lib/ai/memory.ts:
-- formatted CPF, bare 11 digits with valid CPF check digits, or a card-
-- shaped run (13–19 digits, or 4-digit groups) that passes Luhn.
CREATE OR REPLACE FUNCTION public.ai_fact_has_document_number(p_text text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  m text[];
  d text;
  s int;
  r int;
  i int;
  x int;
BEGIN
  IF p_text ~ '(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)' THEN
    RETURN true;
  END IF;

  FOR m IN SELECT regexp_matches(p_text, '(?<![\d.-])(\d{11})(?![\d.-])', 'g') LOOP
    d := m[1];
    IF d !~ '^(\d)\1{10}$' THEN
      s := 0;
      FOR i IN 1..9 LOOP s := s + substr(d, i, 1)::int * (11 - i); END LOOP;
      r := (s * 10) % 11; IF r = 10 THEN r := 0; END IF;
      IF r = substr(d, 10, 1)::int THEN
        s := 0;
        FOR i IN 1..10 LOOP s := s + substr(d, i, 1)::int * (12 - i); END LOOP;
        r := (s * 10) % 11; IF r = 10 THEN r := 0; END IF;
        IF r = substr(d, 11, 1)::int THEN
          RETURN true;
        END IF;
      END IF;
    END IF;
  END LOOP;

  FOR m IN SELECT regexp_matches(p_text,
      '(?<![\d-])(\d{13,19}|\d{4}(?:[ -]\d{4}){2,3}(?:\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{4,5})(?!\d)', 'g') LOOP
    d := regexp_replace(m[1], '\D', '', 'g');
    IF length(d) BETWEEN 13 AND 19 THEN
      s := 0;
      FOR i IN 0..length(d) - 1 LOOP
        x := substr(d, length(d) - i, 1)::int;
        IF i % 2 = 1 THEN x := x * 2; IF x > 9 THEN x := x - 9; END IF; END IF;
        s := s + x;
      END LOOP;
      IF s % 10 = 0 THEN
        RETURN true;
      END IF;
    END IF;
  END LOOP;
  RETURN false;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ai_fact_has_document_number(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ai_contact_memories_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.fact IS DISTINCT FROM OLD.fact)
     AND public.ai_fact_has_document_number(NEW.fact)
  THEN
    RAISE EXCEPTION 'contact memory looks like a document or card number'
      USING ERRCODE = 'check_violation';
  END IF;

  IF current_user IN ('authenticated', 'anon') THEN
    -- An AI fact enters as a proposal; an agent approves it later.
    IF TG_OP = 'INSERT' AND NEW.source = 'ai' THEN
      NEW.status := 'proposed';
    END IF;
    IF NEW.status = 'active'
       AND (TG_OP = 'INSERT' OR OLD.status <> 'active' OR NEW.fact IS DISTINCT FROM OLD.fact)
       AND NOT public.is_account_member(NEW.account_id, 'agent')
    THEN
      RAISE EXCEPTION 'only an agent of the account can approve a contact memory'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.ai_contact_memories_guard() OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION public.ai_contact_memories_guard() FROM PUBLIC, anon, authenticated;

-- Fires before ai_contact_memories_stamp (alphabetical), which then
-- stamps approved_by from the final status.
DROP TRIGGER IF EXISTS ai_contact_memories_guard ON public.ai_contact_memories;
CREATE TRIGGER ai_contact_memories_guard
  BEFORE INSERT OR UPDATE ON public.ai_contact_memories
  FOR EACH ROW EXECUTE FUNCTION public.ai_contact_memories_guard();

-- PostgREST: pick up the new view, grants and policies now.
NOTIFY pgrst, 'reload schema';
