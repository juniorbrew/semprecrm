-- ============================================================
-- 112_platform_usage.sql — Platform → Uso: counts per company for one month (Entrega 10, part B).
--
-- Spec: docs/superpowers/specs/2026-11-15-indicadores-e-extras.md (Parte B)
--
-- platform_usage(p_month): one row per account, COUNTS ONLY (no text, no end-customer data).
--   p_month           any day of the month; the month is [first day, +1 month) in America/Sao_Paulo.
--   conversations     conversations created in the month
--   messages_received messages with sender_type 'customer' in the month
--   messages_sent     messages with sender_type 'agent' or 'bot' in the month
--   ai_calls          ai_usage rows of the month (status 'ok' only: errors/blocked cost nothing)
--   ai_cost_usd       sum of ai_usage.cost_cents / 100 (USD)
--   contacts_7d       contacts created in the last 7 days (rolling, independent of p_month)
--   last_activity_at  latest conversations.last_message_at of the account (NULL = never)
-- Plan, billing status and limits come from platform_list_accounts() (already gated); this function
-- only adds the usage numbers. SECURITY DEFINER, executable by service_role ONLY (076 rule): the
-- server route checks the platform owner first, then calls it with the service-role client.
-- messages has no account_id, so messages are reached through conversations. A conversation can only hold
-- an in-month message if COALESCE(last_message_at, created_at) >= month start (ASSUMPTION: last_message_at is the
-- latest message time when set, and created_at bounds it when NULL, e.g. imports). That is the 067 index
-- expression, and idx_messages_conversation_created (conversation_id, created_at) serves the inner range.
--
-- Rollback: supabase/rollback/112_rollback.sql. SQL test: supabase/tests/platform_usage.sql. Idempotent.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.platform_usage(p_month date)
RETURNS TABLE (
  account_id        uuid,
  conversations     bigint,
  messages_received bigint,
  messages_sent     bigint,
  ai_calls          bigint,
  ai_cost_usd       numeric,
  contacts_7d       bigint,
  last_activity_at  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '15s'
AS $$
  WITH b AS (
    SELECT (date_trunc('month', p_month)::timestamp AT TIME ZONE 'America/Sao_Paulo')                        AS s,
           ((date_trunc('month', p_month) + interval '1 month')::timestamp AT TIME ZONE 'America/Sao_Paulo') AS e
  ),
  conv AS (
    SELECT c.account_id, count(*) AS n
      FROM public.conversations c, b
     WHERE c.created_at >= b.s AND c.created_at < b.e
     GROUP BY c.account_id
  ),
  last_act AS (
    SELECT c.account_id, max(COALESCE(c.last_message_at, c.created_at)) AS last_at
      FROM public.conversations c
     GROUP BY c.account_id
  ),
  msg AS (
    SELECT c.account_id,
           count(*) FILTER (WHERE m.sender_type = 'customer')            AS received,
           count(*) FILTER (WHERE m.sender_type IN ('agent', 'bot'))     AS sent
      FROM b
      CROSS JOIN public.conversations c
      CROSS JOIN LATERAL (
        SELECT mm.sender_type FROM public.messages mm
         WHERE mm.conversation_id = c.id AND mm.created_at >= b.s AND mm.created_at < b.e
      ) m
     WHERE COALESCE(c.last_message_at, c.created_at) >= b.s
     GROUP BY c.account_id
  ),
  ai AS (
    SELECT u.account_id, count(*) AS n, coalesce(sum(u.cost_cents), 0) / 100 AS usd
      FROM public.ai_usage u, b
     WHERE u.status = 'ok' AND u.created_at >= b.s AND u.created_at < b.e
     GROUP BY u.account_id
  ),
  -- ponytail: no (account_id, created_at) index on contacts; add one if this scan shows up in slow logs.
  ppl AS (
    SELECT ct.account_id, count(*) AS n
      FROM public.contacts ct
     WHERE ct.created_at >= now() - interval '7 days'
     GROUP BY ct.account_id
  )
  SELECT a.id,
         coalesce(conv.n, 0),
         coalesce(msg.received, 0),
         coalesce(msg.sent, 0),
         coalesce(ai.n, 0),
         coalesce(ai.usd, 0),
         coalesce(ppl.n, 0),
         last_act.last_at
    FROM public.accounts a
    LEFT JOIN conv ON conv.account_id = a.id
    LEFT JOIN last_act ON last_act.account_id = a.id
    LEFT JOIN msg  ON msg.account_id  = a.id
    LEFT JOIN ai   ON ai.account_id   = a.id
    LEFT JOIN ppl  ON ppl.account_id  = a.id
   ORDER BY a.id;
$$;

ALTER FUNCTION public.platform_usage(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_usage(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_usage(date) TO service_role;

COMMIT;
