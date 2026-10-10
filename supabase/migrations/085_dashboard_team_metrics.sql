-- ============================================================
-- 085: team metrics ("Equipe" block of the dashboard) in SQL.
--
-- src/lib/dashboard/team-metrics.ts read every agent message of the
-- period (up to 90 days), every close event, first response, completed
-- task and open assignment, and counted them in the browser. PostgREST
-- caps a read at max_rows (1000), so a busy team was undercounted.
-- This returns the per-user numbers; the client only joins them to the
-- roster (users that are not members any more are dropped there).
--
-- Same rules as the old client loop:
--   handled  distinct conversations with an agent message from the user
--   resolved status_changed events to 'closed' with the user as actor
--   first response mean / median / samples over conversations the user
--            answered first (seconds >= 0)
--   tasks    completed by the assignee
--   open     conversations open right now assigned to the user (no period)
--
-- SECURITY INVOKER: RLS applies as it did to the table reads; the
-- account filter is explicit like before. Grants explicit (076).
-- ============================================================

CREATE OR REPLACE FUNCTION public.dashboard_team_metrics(p_account_id uuid, p_since timestamptz)
RETURNS TABLE (
  user_id                       uuid,
  handled                       integer,
  resolved                      integer,
  first_response_avg_seconds    double precision,
  first_response_median_seconds double precision,
  first_response_samples        integer,
  tasks_completed               integer,
  open_assigned                 integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH handled AS (
    SELECT m.sender_id AS uid, count(DISTINCT m.conversation_id) AS n
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
     WHERE c.account_id = p_account_id
       AND m.sender_type = 'agent'
       AND m.sender_id IS NOT NULL
       AND m.created_at >= p_since
     GROUP BY m.sender_id
  ),
  resolved AS (
    SELECT e.actor_user_id AS uid, count(*) AS n
      FROM public.conversation_events e
     WHERE e.account_id = p_account_id
       AND e.event_type = 'status_changed'
       AND e.actor_user_id IS NOT NULL
       AND e.payload->>'status' = 'closed'
       AND e.created_at >= p_since
     GROUP BY e.actor_user_id
  ),
  fr AS (
    SELECT c.first_response_by AS uid,
           avg(c.first_response_seconds)::double precision AS avg_s,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY c.first_response_seconds) AS median_s,
           count(*) AS n
      FROM public.conversations c
     WHERE c.account_id = p_account_id
       AND c.first_response_at >= p_since
       AND c.first_response_by IS NOT NULL
       AND c.first_response_seconds >= 0
     GROUP BY c.first_response_by
  ),
  tasks_done AS (
    SELECT t.assignee_user_id AS uid, count(*) AS n
      FROM public.tasks t
     WHERE t.account_id = p_account_id
       AND t.assignee_user_id IS NOT NULL
       AND t.completed_at >= p_since
     GROUP BY t.assignee_user_id
  ),
  open_now AS (
    SELECT c.assigned_agent_id AS uid, count(*) AS n
      FROM public.conversations c
     WHERE c.account_id = p_account_id
       AND c.status = 'open'
       AND c.assigned_agent_id IS NOT NULL
     GROUP BY c.assigned_agent_id
  ),
  users AS (
    SELECT uid FROM handled
    UNION SELECT uid FROM resolved
    UNION SELECT uid FROM fr
    UNION SELECT uid FROM tasks_done
    UNION SELECT uid FROM open_now
  )
  SELECT u.uid,
         coalesce(h.n, 0)::integer,
         coalesce(r.n, 0)::integer,
         fr.avg_s,
         fr.median_s,
         coalesce(fr.n, 0)::integer,
         coalesce(t.n, 0)::integer,
         coalesce(o.n, 0)::integer
    FROM users u
    LEFT JOIN handled h ON h.uid = u.uid
    LEFT JOIN resolved r ON r.uid = u.uid
    LEFT JOIN fr ON fr.uid = u.uid
    LEFT JOIN tasks_done t ON t.uid = u.uid
    LEFT JOIN open_now o ON o.uid = u.uid;
$$;

REVOKE ALL ON FUNCTION public.dashboard_team_metrics(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_team_metrics(uuid, timestamptz) TO authenticated, service_role;
