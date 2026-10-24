-- ============================================================
-- 094 — Billing part 3: database-level write block ("fase 2 do bloqueio").
--
-- Part 2 made trial_expired / past_due accounts read-only in the app and in
-- the server routes that start outbound work. Writes to CRM data made with
-- the user's own JWT (PostgREST/RLS) still succeeded. This migration closes
-- that gap in the database:
--
--   1. account_is_writable(account) — one SQL twin of the app rule
--      (resolveEntitlements().blocked === false, src/lib/plans.ts):
--        plan_status trial   -> writable until plan_expires_at (NULL = no expiry)
--        plan_status active  -> writable (plan_expires_at is IGNORED: a
--                               platform "Valid until" never blocks an active
--                               account; billing_expire_lapsed() flips it to
--                               past_due instead)
--        past_due / canceled / suspended / unknown status or plan, no plan
--        version, unknown account -> NOT writable (fail closed)
--      The "plan_unavailable" case of the app (unreadable plan definition) is
--      guaranteed away by the FK (plan, plan_version_id) and the definition
--      CHECK of 081; the function still requires the version row to exist.
--   2. RESTRICTIVE policies (INSERT / UPDATE / DELETE, TO authenticated) on the
--      CRM data tables. They AND with the existing permissive policies, so
--      nothing is rewritten, SELECT is never touched, and service_role (webhooks,
--      gateway callbacks, crons, admin-client routes) bypasses RLS as before.
--   3. readonly_guard() BEFORE triggers where a policy is too coarse or where a
--      SECURITY DEFINER RPC would skip RLS:
--        conversations  UPDATE: only unread_count may change (mark as read)
--        contacts       UPDATE: only consent_status / consent_updated_at /
--                       opted_out_at may change (LGPD opt-out must stay possible)
--        ai_knowledge_items, ai_knowledge_chunks, ai_agents: any write — they
--        are also written by SECURITY DEFINER RPCs (ai_knowledge_save_item ...)
--        which run as the table owner and skip RLS.
--      A "user context" is current_user IN (authenticated, anon) or a request
--      carrying a user (auth.uid() IS NOT NULL, i.e. inside a definer RPC called
--      with a JWT). service_role / postgres jobs have neither and pass.
--
-- Tables that stay writable on purpose (see the PR inventory): profiles,
-- accounts (company data / preferences; platform columns are still guarded by
-- 076), push_subscriptions, whatsapp_config, wa_qr_sessions (reconnect),
-- internal chat (chat_*). Owner-accepted exceptions: account_invitations and
-- storage uploads (storage.objects) stay writable while read-only.
--
-- The rule function lives in schema private (not exposed by PostgREST).
-- remove_account_member is redefined so a removed member's new personal account
-- starts a 14-day trial like handle_new_user (it had plan_expires_at NULL, which
-- would be writable forever).
--
-- Rule from 076: new functions are closed by default; EXECUTE is granted
-- explicitly. The policies run as the caller, so `authenticated` needs EXECUTE.
-- Rollback: supabase/rollback/094_rollback.sql. Verify on a real Postgres with
-- supabase/tests/billing_db_block.sql (ends in ROLLBACK).
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Own schema: PostgREST exposes only public/graphql_public, so this is not
-- callable through /rest/v1/rpc (no 1-bit "is account X read-only" oracle for
-- any uuid). Policies and triggers run as the caller, hence USAGE + EXECUTE.
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.account_is_writable(p_account uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT a.plan_status IN ('trial', 'active')
       AND a.plan IN ('trial', 'basico', 'pro', 'empresa')
       AND EXISTS (
         SELECT 1 FROM public.platform_plan_versions v
          WHERE v.id = a.plan_version_id AND v.plan = a.plan
       )
       AND (
         a.plan_status <> 'trial'
         OR a.plan_expires_at IS NULL
         OR a.plan_expires_at > now()
       )
      FROM public.accounts a
     WHERE a.id = p_account
  ), false)
$$;

REVOKE ALL ON FUNCTION private.account_is_writable(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.account_is_writable(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION private.account_is_writable(uuid) IS
  'SQL twin of resolveEntitlements().blocked === false (src/lib/plans.ts). Used by the read-only RESTRICTIVE policies (094).';

-- Guard trigger (SECURITY INVOKER on purpose: current_user must be the caller).
-- TG_ARGV = columns a read-only account may still change
-- (UPDATE only). Raises 42501 with a recognisable message for the app.
CREATE OR REPLACE FUNCTION public.readonly_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_old_account uuid;
  v_allowed text[];
BEGIN
  IF NOT (current_user IN ('authenticated', 'anon') OR auth.uid() IS NOT NULL) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_account := (to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END) ->> 'account_id')::uuid;
  -- UPDATE: the row's previous account must be writable too (an account_id
  -- change must not move a row out of a read-only account).
  v_old_account := CASE WHEN TG_OP = 'UPDATE' THEN (to_jsonb(OLD) ->> 'account_id')::uuid END;
  IF private.account_is_writable(v_account)
     AND (v_old_account IS NULL OR v_old_account = v_account OR private.account_is_writable(v_old_account)) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    -- Generated columns (e.g. contacts.phone_normalized) are not computed yet in a
    -- BEFORE trigger, so they always look "changed": leave them out of the diff.
    v_allowed := TG_ARGV || ARRAY['updated_at'] || COALESCE((
      SELECT array_agg(attname::text) FROM pg_attribute
       WHERE attrelid = TG_RELID AND attgenerated <> '' AND NOT attisdropped
    ), ARRAY[]::text[]);
    IF v_old_account IS NOT DISTINCT FROM v_account
       AND (to_jsonb(NEW) - v_allowed) IS NOT DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'read_only_account: this account is read-only (trial ended or payment overdue)'
    USING ERRCODE = '42501';
END $$;

REVOKE ALL ON FUNCTION public.readonly_guard() FROM PUBLIC, anon, authenticated;

-- "_00_" sorts before every existing trigger of these tables, so the guard
-- compares NEW with OLD before any other BEFORE trigger rewrites NEW.
DROP TRIGGER IF EXISTS _00_readonly_guard ON public.conversations;
CREATE TRIGGER _00_readonly_guard BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.readonly_guard('unread_count');

DROP TRIGGER IF EXISTS _00_readonly_guard ON public.contacts;
CREATE TRIGGER _00_readonly_guard BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.readonly_guard('consent_status', 'consent_updated_at', 'opted_out_at');

DROP TRIGGER IF EXISTS _00_readonly_guard ON public.ai_knowledge_items;
CREATE TRIGGER _00_readonly_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ai_knowledge_items
  FOR EACH ROW EXECUTE FUNCTION public.readonly_guard();

DROP TRIGGER IF EXISTS _00_readonly_guard ON public.ai_knowledge_chunks;
CREATE TRIGGER _00_readonly_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ai_knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION public.readonly_guard();

DROP TRIGGER IF EXISTS _00_readonly_guard ON public.ai_knowledge_item_versions;
CREATE TRIGGER _00_readonly_guard BEFORE INSERT ON public.ai_knowledge_item_versions
  FOR EACH ROW EXECUTE FUNCTION public.readonly_guard();

DROP TRIGGER IF EXISTS _00_readonly_guard ON public.ai_agents;
CREATE TRIGGER _00_readonly_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ai_agents
  FOR EACH ROW EXECUTE FUNCTION public.readonly_guard();

-- remove_account_member (018): same signature, SECURITY DEFINER and search_path;
-- CREATE OR REPLACE keeps owner and grants.
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID  -- the new personal account id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_new_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
  INTO v_target_account_id, v_target_role, v_target_name, v_target_email
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  -- Spin up a fresh personal account for the removed user. Mirror
  -- of handle_new_user's logic — keep them whole, just relocated.
  -- 094: same 14-day trial window as handle_new_user (a NULL expiry would be
  -- writable forever under private.account_is_writable).
  INSERT INTO accounts (name, owner_user_id, plan, plan_status, plan_expires_at)
  VALUES (
    COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
    p_user_id,
    'trial',
    'trial',
    NOW() + INTERVAL '14 days'
  )
  RETURNING id INTO v_new_account_id;

  UPDATE profiles
  SET account_id = v_new_account_id,
      account_role = 'owner'
  WHERE user_id = p_user_id;

  RETURN v_new_account_id;
END;
$$;

-- ---------- RESTRICTIVE policies ----------
-- Perf note: the policies call the function with a per-row column, so it is
-- evaluated per row; wrapping it in (SELECT ...) would not make it once per
-- statement here. It is one primary-key lookup, only on writes by users.

DROP POLICY IF EXISTS contacts_readonly_insert ON public.contacts;
CREATE POLICY contacts_readonly_insert ON public.contacts AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS contacts_readonly_delete ON public.contacts;
CREATE POLICY contacts_readonly_delete ON public.contacts AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS tags_readonly_insert ON public.tags;
CREATE POLICY tags_readonly_insert ON public.tags AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS tags_readonly_update ON public.tags;
CREATE POLICY tags_readonly_update ON public.tags AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS tags_readonly_delete ON public.tags;
CREATE POLICY tags_readonly_delete ON public.tags AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS custom_fields_readonly_insert ON public.custom_fields;
CREATE POLICY custom_fields_readonly_insert ON public.custom_fields AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS custom_fields_readonly_update ON public.custom_fields;
CREATE POLICY custom_fields_readonly_update ON public.custom_fields AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS custom_fields_readonly_delete ON public.custom_fields;
CREATE POLICY custom_fields_readonly_delete ON public.custom_fields AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS contact_notes_readonly_insert ON public.contact_notes;
CREATE POLICY contact_notes_readonly_insert ON public.contact_notes AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS contact_notes_readonly_update ON public.contact_notes;
CREATE POLICY contact_notes_readonly_update ON public.contact_notes AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS contact_notes_readonly_delete ON public.contact_notes;
CREATE POLICY contact_notes_readonly_delete ON public.contact_notes AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS conversations_readonly_insert ON public.conversations;
CREATE POLICY conversations_readonly_insert ON public.conversations AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS conversations_readonly_delete ON public.conversations;
CREATE POLICY conversations_readonly_delete ON public.conversations AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS message_templates_readonly_insert ON public.message_templates;
CREATE POLICY message_templates_readonly_insert ON public.message_templates AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS message_templates_readonly_update ON public.message_templates;
CREATE POLICY message_templates_readonly_update ON public.message_templates AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS message_templates_readonly_delete ON public.message_templates;
CREATE POLICY message_templates_readonly_delete ON public.message_templates AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS pipelines_readonly_insert ON public.pipelines;
CREATE POLICY pipelines_readonly_insert ON public.pipelines AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS pipelines_readonly_update ON public.pipelines;
CREATE POLICY pipelines_readonly_update ON public.pipelines AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS pipelines_readonly_delete ON public.pipelines;
CREATE POLICY pipelines_readonly_delete ON public.pipelines AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS deals_readonly_insert ON public.deals;
CREATE POLICY deals_readonly_insert ON public.deals AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deals_readonly_update ON public.deals;
CREATE POLICY deals_readonly_update ON public.deals AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deals_readonly_delete ON public.deals;
CREATE POLICY deals_readonly_delete ON public.deals AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS broadcasts_readonly_insert ON public.broadcasts;
CREATE POLICY broadcasts_readonly_insert ON public.broadcasts AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS broadcasts_readonly_update ON public.broadcasts;
CREATE POLICY broadcasts_readonly_update ON public.broadcasts AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS broadcasts_readonly_delete ON public.broadcasts;
CREATE POLICY broadcasts_readonly_delete ON public.broadcasts AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS automations_readonly_insert ON public.automations;
CREATE POLICY automations_readonly_insert ON public.automations AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS automations_readonly_update ON public.automations;
CREATE POLICY automations_readonly_update ON public.automations AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS automations_readonly_delete ON public.automations;
CREATE POLICY automations_readonly_delete ON public.automations AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS flows_readonly_insert ON public.flows;
CREATE POLICY flows_readonly_insert ON public.flows AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS flows_readonly_update ON public.flows;
CREATE POLICY flows_readonly_update ON public.flows AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS flows_readonly_delete ON public.flows;
CREATE POLICY flows_readonly_delete ON public.flows AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS companies_readonly_insert ON public.companies;
CREATE POLICY companies_readonly_insert ON public.companies AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS companies_readonly_update ON public.companies;
CREATE POLICY companies_readonly_update ON public.companies AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS companies_readonly_delete ON public.companies;
CREATE POLICY companies_readonly_delete ON public.companies AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS contact_companies_readonly_insert ON public.contact_companies;
CREATE POLICY contact_companies_readonly_insert ON public.contact_companies AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS contact_companies_readonly_update ON public.contact_companies;
CREATE POLICY contact_companies_readonly_update ON public.contact_companies AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS contact_companies_readonly_delete ON public.contact_companies;
CREATE POLICY contact_companies_readonly_delete ON public.contact_companies AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS tasks_readonly_insert ON public.tasks;
CREATE POLICY tasks_readonly_insert ON public.tasks AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS tasks_readonly_update ON public.tasks;
CREATE POLICY tasks_readonly_update ON public.tasks AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS tasks_readonly_delete ON public.tasks;
CREATE POLICY tasks_readonly_delete ON public.tasks AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS task_statuses_readonly_insert ON public.task_statuses;
CREATE POLICY task_statuses_readonly_insert ON public.task_statuses AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS task_statuses_readonly_update ON public.task_statuses;
CREATE POLICY task_statuses_readonly_update ON public.task_statuses AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS task_statuses_readonly_delete ON public.task_statuses;
CREATE POLICY task_statuses_readonly_delete ON public.task_statuses AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS task_comments_readonly_insert ON public.task_comments;
CREATE POLICY task_comments_readonly_insert ON public.task_comments AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS task_comments_readonly_update ON public.task_comments;
CREATE POLICY task_comments_readonly_update ON public.task_comments AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS task_comments_readonly_delete ON public.task_comments;
CREATE POLICY task_comments_readonly_delete ON public.task_comments AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS quick_replies_readonly_insert ON public.quick_replies;
CREATE POLICY quick_replies_readonly_insert ON public.quick_replies AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS quick_replies_readonly_update ON public.quick_replies;
CREATE POLICY quick_replies_readonly_update ON public.quick_replies AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS quick_replies_readonly_delete ON public.quick_replies;
CREATE POLICY quick_replies_readonly_delete ON public.quick_replies AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS lead_sources_readonly_insert ON public.lead_sources;
CREATE POLICY lead_sources_readonly_insert ON public.lead_sources AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS lead_sources_readonly_update ON public.lead_sources;
CREATE POLICY lead_sources_readonly_update ON public.lead_sources AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS lead_sources_readonly_delete ON public.lead_sources;
CREATE POLICY lead_sources_readonly_delete ON public.lead_sources AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS deal_loss_reasons_readonly_insert ON public.deal_loss_reasons;
CREATE POLICY deal_loss_reasons_readonly_insert ON public.deal_loss_reasons AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deal_loss_reasons_readonly_update ON public.deal_loss_reasons;
CREATE POLICY deal_loss_reasons_readonly_update ON public.deal_loss_reasons AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS deal_loss_reasons_readonly_delete ON public.deal_loss_reasons;
CREATE POLICY deal_loss_reasons_readonly_delete ON public.deal_loss_reasons AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS calendar_events_readonly_insert ON public.calendar_events;
CREATE POLICY calendar_events_readonly_insert ON public.calendar_events AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS calendar_events_readonly_update ON public.calendar_events;
CREATE POLICY calendar_events_readonly_update ON public.calendar_events AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS calendar_events_readonly_delete ON public.calendar_events;
CREATE POLICY calendar_events_readonly_delete ON public.calendar_events AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS conversation_categories_readonly_insert ON public.conversation_categories;
CREATE POLICY conversation_categories_readonly_insert ON public.conversation_categories AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS conversation_categories_readonly_update ON public.conversation_categories;
CREATE POLICY conversation_categories_readonly_update ON public.conversation_categories AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS conversation_categories_readonly_delete ON public.conversation_categories;
CREATE POLICY conversation_categories_readonly_delete ON public.conversation_categories AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS conversation_events_readonly_insert ON public.conversation_events;
CREATE POLICY conversation_events_readonly_insert ON public.conversation_events AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS conversation_events_readonly_update ON public.conversation_events;
CREATE POLICY conversation_events_readonly_update ON public.conversation_events AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS conversation_events_readonly_delete ON public.conversation_events;
CREATE POLICY conversation_events_readonly_delete ON public.conversation_events AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS csat_settings_readonly_insert ON public.csat_settings;
CREATE POLICY csat_settings_readonly_insert ON public.csat_settings AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS csat_settings_readonly_update ON public.csat_settings;
CREATE POLICY csat_settings_readonly_update ON public.csat_settings AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS csat_settings_readonly_delete ON public.csat_settings;
CREATE POLICY csat_settings_readonly_delete ON public.csat_settings AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS sla_policies_readonly_insert ON public.sla_policies;
CREATE POLICY sla_policies_readonly_insert ON public.sla_policies AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS sla_policies_readonly_update ON public.sla_policies;
CREATE POLICY sla_policies_readonly_update ON public.sla_policies AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS sla_policies_readonly_delete ON public.sla_policies;
CREATE POLICY sla_policies_readonly_delete ON public.sla_policies AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS teams_readonly_insert ON public.teams;
CREATE POLICY teams_readonly_insert ON public.teams AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS teams_readonly_update ON public.teams;
CREATE POLICY teams_readonly_update ON public.teams AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS teams_readonly_delete ON public.teams;
CREATE POLICY teams_readonly_delete ON public.teams AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS team_members_readonly_insert ON public.team_members;
CREATE POLICY team_members_readonly_insert ON public.team_members AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS team_members_readonly_update ON public.team_members;
CREATE POLICY team_members_readonly_update ON public.team_members AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS team_members_readonly_delete ON public.team_members;
CREATE POLICY team_members_readonly_delete ON public.team_members AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS routing_rules_readonly_insert ON public.routing_rules;
CREATE POLICY routing_rules_readonly_insert ON public.routing_rules AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS routing_rules_readonly_update ON public.routing_rules;
CREATE POLICY routing_rules_readonly_update ON public.routing_rules AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS routing_rules_readonly_delete ON public.routing_rules;
CREATE POLICY routing_rules_readonly_delete ON public.routing_rules AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS ai_agents_readonly_insert ON public.ai_agents;
CREATE POLICY ai_agents_readonly_insert ON public.ai_agents AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ai_agents_readonly_update ON public.ai_agents;
CREATE POLICY ai_agents_readonly_update ON public.ai_agents AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ai_agents_readonly_delete ON public.ai_agents;
CREATE POLICY ai_agents_readonly_delete ON public.ai_agents AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS ai_settings_readonly_insert ON public.ai_settings;
CREATE POLICY ai_settings_readonly_insert ON public.ai_settings AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ai_settings_readonly_update ON public.ai_settings;
CREATE POLICY ai_settings_readonly_update ON public.ai_settings AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ai_settings_readonly_delete ON public.ai_settings;
CREATE POLICY ai_settings_readonly_delete ON public.ai_settings AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS ai_knowledge_items_readonly_insert ON public.ai_knowledge_items;
CREATE POLICY ai_knowledge_items_readonly_insert ON public.ai_knowledge_items AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ai_knowledge_items_readonly_update ON public.ai_knowledge_items;
CREATE POLICY ai_knowledge_items_readonly_update ON public.ai_knowledge_items AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ai_knowledge_items_readonly_delete ON public.ai_knowledge_items;
CREATE POLICY ai_knowledge_items_readonly_delete ON public.ai_knowledge_items AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS ai_knowledge_chunks_readonly_insert ON public.ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_readonly_insert ON public.ai_knowledge_chunks AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ai_knowledge_chunks_readonly_update ON public.ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_readonly_update ON public.ai_knowledge_chunks AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ai_knowledge_chunks_readonly_delete ON public.ai_knowledge_chunks;
CREATE POLICY ai_knowledge_chunks_readonly_delete ON public.ai_knowledge_chunks AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS ai_contact_memories_readonly_insert ON public.ai_contact_memories;
CREATE POLICY ai_contact_memories_readonly_insert ON public.ai_contact_memories AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ai_contact_memories_readonly_update ON public.ai_contact_memories;
CREATE POLICY ai_contact_memories_readonly_update ON public.ai_contact_memories AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable(account_id)) WITH CHECK (private.account_is_writable(account_id));
DROP POLICY IF EXISTS ai_contact_memories_readonly_delete ON public.ai_contact_memories;
CREATE POLICY ai_contact_memories_readonly_delete ON public.ai_contact_memories AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable(account_id));

DROP POLICY IF EXISTS contact_tags_readonly_insert ON public.contact_tags;
CREATE POLICY contact_tags_readonly_insert ON public.contact_tags AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.contacts p WHERE p.id = public.contact_tags.contact_id)));
DROP POLICY IF EXISTS contact_tags_readonly_update ON public.contact_tags;
CREATE POLICY contact_tags_readonly_update ON public.contact_tags AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.contacts p WHERE p.id = public.contact_tags.contact_id))) WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.contacts p WHERE p.id = public.contact_tags.contact_id)));
DROP POLICY IF EXISTS contact_tags_readonly_delete ON public.contact_tags;
CREATE POLICY contact_tags_readonly_delete ON public.contact_tags AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.contacts p WHERE p.id = public.contact_tags.contact_id)));

DROP POLICY IF EXISTS contact_custom_values_readonly_insert ON public.contact_custom_values;
CREATE POLICY contact_custom_values_readonly_insert ON public.contact_custom_values AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.contacts p WHERE p.id = public.contact_custom_values.contact_id)));
DROP POLICY IF EXISTS contact_custom_values_readonly_update ON public.contact_custom_values;
CREATE POLICY contact_custom_values_readonly_update ON public.contact_custom_values AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.contacts p WHERE p.id = public.contact_custom_values.contact_id))) WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.contacts p WHERE p.id = public.contact_custom_values.contact_id)));
DROP POLICY IF EXISTS contact_custom_values_readonly_delete ON public.contact_custom_values;
CREATE POLICY contact_custom_values_readonly_delete ON public.contact_custom_values AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.contacts p WHERE p.id = public.contact_custom_values.contact_id)));

DROP POLICY IF EXISTS messages_readonly_insert ON public.messages;
CREATE POLICY messages_readonly_insert ON public.messages AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.conversations p WHERE p.id = public.messages.conversation_id)));
DROP POLICY IF EXISTS messages_readonly_update ON public.messages;
CREATE POLICY messages_readonly_update ON public.messages AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.conversations p WHERE p.id = public.messages.conversation_id))) WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.conversations p WHERE p.id = public.messages.conversation_id)));
DROP POLICY IF EXISTS messages_readonly_delete ON public.messages;
CREATE POLICY messages_readonly_delete ON public.messages AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.conversations p WHERE p.id = public.messages.conversation_id)));

DROP POLICY IF EXISTS pipeline_stages_readonly_insert ON public.pipeline_stages;
CREATE POLICY pipeline_stages_readonly_insert ON public.pipeline_stages AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.pipelines p WHERE p.id = public.pipeline_stages.pipeline_id)));
DROP POLICY IF EXISTS pipeline_stages_readonly_update ON public.pipeline_stages;
CREATE POLICY pipeline_stages_readonly_update ON public.pipeline_stages AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.pipelines p WHERE p.id = public.pipeline_stages.pipeline_id))) WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.pipelines p WHERE p.id = public.pipeline_stages.pipeline_id)));
DROP POLICY IF EXISTS pipeline_stages_readonly_delete ON public.pipeline_stages;
CREATE POLICY pipeline_stages_readonly_delete ON public.pipeline_stages AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.pipelines p WHERE p.id = public.pipeline_stages.pipeline_id)));

DROP POLICY IF EXISTS broadcast_recipients_readonly_insert ON public.broadcast_recipients;
CREATE POLICY broadcast_recipients_readonly_insert ON public.broadcast_recipients AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.broadcasts p WHERE p.id = public.broadcast_recipients.broadcast_id)));
DROP POLICY IF EXISTS broadcast_recipients_readonly_update ON public.broadcast_recipients;
CREATE POLICY broadcast_recipients_readonly_update ON public.broadcast_recipients AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.broadcasts p WHERE p.id = public.broadcast_recipients.broadcast_id))) WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.broadcasts p WHERE p.id = public.broadcast_recipients.broadcast_id)));
DROP POLICY IF EXISTS broadcast_recipients_readonly_delete ON public.broadcast_recipients;
CREATE POLICY broadcast_recipients_readonly_delete ON public.broadcast_recipients AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.broadcasts p WHERE p.id = public.broadcast_recipients.broadcast_id)));

DROP POLICY IF EXISTS automation_steps_readonly_insert ON public.automation_steps;
CREATE POLICY automation_steps_readonly_insert ON public.automation_steps AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.automations p WHERE p.id = public.automation_steps.automation_id)));
DROP POLICY IF EXISTS automation_steps_readonly_update ON public.automation_steps;
CREATE POLICY automation_steps_readonly_update ON public.automation_steps AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.automations p WHERE p.id = public.automation_steps.automation_id))) WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.automations p WHERE p.id = public.automation_steps.automation_id)));
DROP POLICY IF EXISTS automation_steps_readonly_delete ON public.automation_steps;
CREATE POLICY automation_steps_readonly_delete ON public.automation_steps AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.automations p WHERE p.id = public.automation_steps.automation_id)));

DROP POLICY IF EXISTS flow_nodes_readonly_insert ON public.flow_nodes;
CREATE POLICY flow_nodes_readonly_insert ON public.flow_nodes AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.flows p WHERE p.id = public.flow_nodes.flow_id)));
DROP POLICY IF EXISTS flow_nodes_readonly_update ON public.flow_nodes;
CREATE POLICY flow_nodes_readonly_update ON public.flow_nodes AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.flows p WHERE p.id = public.flow_nodes.flow_id))) WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.flows p WHERE p.id = public.flow_nodes.flow_id)));
DROP POLICY IF EXISTS flow_nodes_readonly_delete ON public.flow_nodes;
CREATE POLICY flow_nodes_readonly_delete ON public.flow_nodes AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.flows p WHERE p.id = public.flow_nodes.flow_id)));

DROP POLICY IF EXISTS calendar_event_attendees_readonly_insert ON public.calendar_event_attendees;
CREATE POLICY calendar_event_attendees_readonly_insert ON public.calendar_event_attendees AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.calendar_events p WHERE p.id = public.calendar_event_attendees.event_id)));
DROP POLICY IF EXISTS calendar_event_attendees_readonly_update ON public.calendar_event_attendees;
CREATE POLICY calendar_event_attendees_readonly_update ON public.calendar_event_attendees AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.calendar_events p WHERE p.id = public.calendar_event_attendees.event_id))) WITH CHECK (private.account_is_writable((SELECT p.account_id FROM public.calendar_events p WHERE p.id = public.calendar_event_attendees.event_id)));
DROP POLICY IF EXISTS calendar_event_attendees_readonly_delete ON public.calendar_event_attendees;
CREATE POLICY calendar_event_attendees_readonly_delete ON public.calendar_event_attendees AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable((SELECT p.account_id FROM public.calendar_events p WHERE p.id = public.calendar_event_attendees.event_id)));

DROP POLICY IF EXISTS message_reactions_readonly_insert ON public.message_reactions;
CREATE POLICY message_reactions_readonly_insert ON public.message_reactions AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (private.account_is_writable((SELECT c.account_id FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id WHERE m.id = public.message_reactions.message_id)));
DROP POLICY IF EXISTS message_reactions_readonly_update ON public.message_reactions;
CREATE POLICY message_reactions_readonly_update ON public.message_reactions AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (private.account_is_writable((SELECT c.account_id FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id WHERE m.id = public.message_reactions.message_id))) WITH CHECK (private.account_is_writable((SELECT c.account_id FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id WHERE m.id = public.message_reactions.message_id)));
DROP POLICY IF EXISTS message_reactions_readonly_delete ON public.message_reactions;
CREATE POLICY message_reactions_readonly_delete ON public.message_reactions AS RESTRICTIVE FOR DELETE TO authenticated
  USING (private.account_is_writable((SELECT c.account_id FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id WHERE m.id = public.message_reactions.message_id)));
COMMIT;
