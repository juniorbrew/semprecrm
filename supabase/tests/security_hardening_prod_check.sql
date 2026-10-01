-- ============================================================
-- Read-only pre-deploy checks for migration 076 (run on production
-- BEFORE applying it; nothing here writes). Expected results inline.
-- ============================================================

-- 1. Must be postgres (076 alters postgres's default privileges).
SELECT current_user;

-- 2. Columns: 076 grants SELECT on an explicit column list. Every listed
--    column must exist, and any extra column here would become unreadable
--    to the app. Expected:
--    accounts: id, name, owner_user_id, created_at, updated_at, default_currency,
--      plan, plan_status, plan_expires_at, module_overrides, limit_overrides,
--      platform_notes, preferences, branding, person_type, tax_id, legal_name,
--      address, phone, email
--    whatsapp_config: id, user_id, phone_number_id, waba_id, access_token,
--      verify_token, status, connected_at, created_at, updated_at, registered_at,
--      subscribed_apps_at, last_registration_error, account_id
SELECT table_name, string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name IN ('accounts', 'whatsapp_config')
 GROUP BY 1;

-- 3. Functions referenced by RLS / storage policies (they must stay
--    executable by anon/authenticated). Expected: can_edit_calendar_event,
--    can_read_calendar_event, chat_internal_object_allowed, foldername,
--    is_account_member, is_chat_thread_member, is_platform_admin, uid.
SELECT DISTINCT m[1]
  FROM pg_policies, regexp_matches(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '([a-z_]+)\(', 'g') m
 ORDER BY 1;

-- 4. Every function 076 revokes must exist with this signature (a missing
--    one aborts the migration). Expected: no row.
SELECT s FROM unnest(ARRAY[
  'public._bcast_bump(uuid,text,integer)', 'public.recompute_broadcast_counts(uuid)',
  'public.chat_insert_system_message(uuid,uuid,jsonb)', 'public.merge_duplicate_contacts()',
  'public.seed_task_statuses(uuid)', 'public.seed_deal_loss_reasons(uuid)',
  'public.set_member_role(uuid,account_role_enum)', 'public.remove_account_member(uuid)',
  'public.transfer_account_ownership(uuid)', 'public.redeem_invitation(text)',
  'public.platform_list_accounts()', 'public.platform_update_account(uuid,jsonb)',
  'public.chat_get_or_create_direct_thread(uuid)', 'public.chat_can_manage_group(uuid)',
  'public.chat_create_group(text,uuid[])', 'public.chat_add_members(uuid,uuid[])',
  'public.chat_remove_member(uuid,uuid)', 'public.chat_leave_group(uuid)',
  'public.chat_mark_delivered(uuid)', 'public.chat_mark_read(uuid)', 'public.chat_unread_counts()'
]) s WHERE to_regprocedure(s) IS NULL;

-- 5. SVG logos already uploaded keep being served by URL (076 only blocks
--    new ones). Expected: 0, otherwise replace them.
SELECT count(*) FROM storage.objects WHERE bucket_id = 'account-branding' AND name ILIKE '%.svg';

-- 6. Cross-tenant references that enforce_same_account() would reject on
--    the next edit of that column. Expected: every count = 0.
SELECT 'contact_notes.contact_id' AS ref, count(*) AS violations FROM public.contact_notes x WHERE x.contact_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.contacts r WHERE r.id = x.contact_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'conversations.contact_id' AS ref, count(*) AS violations FROM public.conversations x WHERE x.contact_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.contacts r WHERE r.id = x.contact_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'deals.contact_id' AS ref, count(*) AS violations FROM public.deals x WHERE x.contact_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.contacts r WHERE r.id = x.contact_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'deals.conversation_id' AS ref, count(*) AS violations FROM public.deals x WHERE x.conversation_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.conversations r WHERE r.id = x.conversation_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'deals.pipeline_id' AS ref, count(*) AS violations FROM public.deals x WHERE x.pipeline_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.pipelines r WHERE r.id = x.pipeline_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'deals.stage_id' AS ref, count(*) AS violations FROM public.deals x WHERE x.stage_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT p.account_id FROM public.pipeline_stages s JOIN public.pipelines p ON p.id = s.pipeline_id WHERE s.id = x.stage_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'deals.loss_reason_id' AS ref, count(*) AS violations FROM public.deals x WHERE x.loss_reason_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.deal_loss_reasons r WHERE r.id = x.loss_reason_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'deals.assigned_to' AS ref, count(*) AS violations FROM public.deals x WHERE x.assigned_to IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.profiles r WHERE r.id = x.assigned_to) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'tasks.contact_id' AS ref, count(*) AS violations FROM public.tasks x WHERE x.contact_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.contacts r WHERE r.id = x.contact_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'tasks.conversation_id' AS ref, count(*) AS violations FROM public.tasks x WHERE x.conversation_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.conversations r WHERE r.id = x.conversation_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'tasks.deal_id' AS ref, count(*) AS violations FROM public.tasks x WHERE x.deal_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.deals r WHERE r.id = x.deal_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'tasks.status_id' AS ref, count(*) AS violations FROM public.tasks x WHERE x.status_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.task_statuses r WHERE r.id = x.status_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'tasks.assignee_user_id' AS ref, count(*) AS violations FROM public.tasks x WHERE x.assignee_user_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.profiles r WHERE r.user_id = x.assignee_user_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'task_comments.task_id' AS ref, count(*) AS violations FROM public.task_comments x WHERE x.task_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.tasks r WHERE r.id = x.task_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'lead_sources.pipeline_id' AS ref, count(*) AS violations FROM public.lead_sources x WHERE x.pipeline_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.pipelines r WHERE r.id = x.pipeline_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'lead_sources.stage_id' AS ref, count(*) AS violations FROM public.lead_sources x WHERE x.stage_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT p.account_id FROM public.pipeline_stages s JOIN public.pipelines p ON p.id = s.pipeline_id WHERE s.id = x.stage_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'lead_sources.assignee_user_id' AS ref, count(*) AS violations FROM public.lead_sources x WHERE x.assignee_user_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.profiles r WHERE r.user_id = x.assignee_user_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'calendar_events.contact_id' AS ref, count(*) AS violations FROM public.calendar_events x WHERE x.contact_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.contacts r WHERE r.id = x.contact_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'calendar_events.conversation_id' AS ref, count(*) AS violations FROM public.calendar_events x WHERE x.conversation_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.conversations r WHERE r.id = x.conversation_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'calendar_events.deal_id' AS ref, count(*) AS violations FROM public.calendar_events x WHERE x.deal_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.deals r WHERE r.id = x.deal_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'calendar_events.task_id' AS ref, count(*) AS violations FROM public.calendar_events x WHERE x.task_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.tasks r WHERE r.id = x.task_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'calendar_events.chat_thread_id' AS ref, count(*) AS violations FROM public.calendar_events x WHERE x.chat_thread_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.chat_threads r WHERE r.id = x.chat_thread_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'calendar_events.owner_user_id' AS ref, count(*) AS violations FROM public.calendar_events x WHERE x.owner_user_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.profiles r WHERE r.user_id = x.owner_user_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'calendar_events.external_connection_id' AS ref, count(*) AS violations FROM public.calendar_events x WHERE x.external_connection_id IS NOT NULL AND x.account_id IS NOT NULL AND (SELECT r.account_id FROM public.calendar_connections r WHERE r.id = x.external_connection_id) IS DISTINCT FROM x.account_id
UNION ALL
SELECT 'contact_tags.tag_id' AS ref, count(*) AS violations FROM public.contact_tags x WHERE x.tag_id IS NOT NULL AND (SELECT r.account_id FROM public.contacts r WHERE r.id = x.contact_id) IS NOT NULL AND (SELECT r.account_id FROM public.tags r WHERE r.id = x.tag_id) IS DISTINCT FROM (SELECT r.account_id FROM public.contacts r WHERE r.id = x.contact_id)
UNION ALL
SELECT 'contact_custom_values.custom_field_id' AS ref, count(*) AS violations FROM public.contact_custom_values x WHERE x.custom_field_id IS NOT NULL AND (SELECT r.account_id FROM public.contacts r WHERE r.id = x.contact_id) IS NOT NULL AND (SELECT r.account_id FROM public.custom_fields r WHERE r.id = x.custom_field_id) IS DISTINCT FROM (SELECT r.account_id FROM public.contacts r WHERE r.id = x.contact_id)
UNION ALL
SELECT 'broadcast_recipients.contact_id' AS ref, count(*) AS violations FROM public.broadcast_recipients x WHERE x.contact_id IS NOT NULL AND (SELECT r.account_id FROM public.broadcasts r WHERE r.id = x.broadcast_id) IS NOT NULL AND (SELECT r.account_id FROM public.contacts r WHERE r.id = x.contact_id) IS DISTINCT FROM (SELECT r.account_id FROM public.broadcasts r WHERE r.id = x.broadcast_id)
UNION ALL
SELECT 'calendar_event_attendees.user_id' AS ref, count(*) AS violations FROM public.calendar_event_attendees x WHERE x.user_id IS NOT NULL AND (SELECT r.account_id FROM public.calendar_events r WHERE r.id = x.event_id) IS NOT NULL AND (SELECT r.account_id FROM public.profiles r WHERE r.user_id = x.user_id) IS DISTINCT FROM (SELECT r.account_id FROM public.calendar_events r WHERE r.id = x.event_id)
ORDER BY 2 DESC, 1;
