-- ============================================================
-- 062_automation_update_live_conversation.sql — automation assign /
-- close steps stop touching resolved conversations.
--
-- Since 060 a contact can have many resolved conversations plus at most
-- one live (open / pending) one. `automation_update_conversations`
-- (048) updated EVERY conversation of the contact, so an "assign" step
-- re-assigned old resolved threads and a "close" step stamped them
-- again. Redefined with an optional `p_conversation_id`:
--   * given  → only that conversation (the one the run is about);
--   * NULL   → only the contact's non-closed conversations.
-- The 6-argument version is dropped first so PostgREST never sees two
-- overloads; callers that still send 6 named arguments get the default.
-- Apply BEFORE deploying the app that sends p_conversation_id.
--
-- Service role only, as in 048. Idempotent.
-- ============================================================

DROP FUNCTION IF EXISTS automation_update_conversations(UUID, UUID, UUID, TEXT, INTEGER, UUID);

CREATE OR REPLACE FUNCTION automation_update_conversations(
  p_account_id UUID,
  p_contact_id UUID,
  p_assigned_agent_id UUID,
  p_status TEXT,
  p_depth INTEGER,
  p_origin UUID,
  p_conversation_id UUID DEFAULT NULL
)
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'pending', 'closed') THEN
    RAISE EXCEPTION 'invalid conversation status %', p_status;
  END IF;
  PERFORM set_config('app.automation_depth', p_depth::TEXT, TRUE);
  PERFORM set_config('app.automation_origin', COALESCE(p_origin::TEXT, ''), TRUE);
  RETURN QUERY
    UPDATE conversations
       SET assigned_agent_id = COALESCE(p_assigned_agent_id, assigned_agent_id),
           status = COALESCE(p_status, status),
           updated_at = NOW()
     WHERE account_id = p_account_id
       AND contact_id = p_contact_id
       AND (
         (p_conversation_id IS NOT NULL AND id = p_conversation_id)
         OR (p_conversation_id IS NULL AND status <> 'closed')
       )
    RETURNING id;
END;
$$;

REVOKE ALL ON FUNCTION automation_update_conversations(UUID, UUID, UUID, TEXT, INTEGER, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION automation_update_conversations(UUID, UUID, UUID, TEXT, INTEGER, UUID, UUID) TO service_role;
