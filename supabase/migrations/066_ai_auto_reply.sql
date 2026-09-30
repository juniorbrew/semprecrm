-- ============================================================
-- 066_ai_auto_reply.sql — AI phase 4: the automatic-reply runtime
-- (an agent in mode 'auto' answers customers by itself) and the
-- hand-over to a person. Module `ai`.
--
-- What this migration does
--   1. conversations.ai_paused_until — the AI does not answer this
--      conversation until then ('infinity' = until someone resumes it:
--      hand-over, "Pausar IA"). conversations.ai_last_reply_at — last
--      automatic reply (inbox "IA" badge).
--   2. Trigger `messages_pause_ai_on_human_reply`: any HUMAN outbound
--      message (sender_type 'agent' — inbox send, or a phone / WhatsApp
--      Web echo that counts as a reply, same 15 s rule as 059) pauses the
--      AI in that conversation for 30 minutes (never shortens a longer
--      pause). This is the "human is talking" rule: SempreCRM round-robins
--      conversations to agents at the first message, so "has an assignee"
--      cannot mean "a human took over" — a human MESSAGE does.
--   3. messages.origin accepts 'ai'; ai_usage.feature accepts
--      'auto_reply'; conversation_events accepts 'ai_handoff',
--      'ai_paused', 'ai_resumed'.
--   4. ai_reply_jobs — durable, debounced queue. At most ONE queued job
--      per conversation (partial unique index): later customer messages
--      attach to it (inbound_message_ids) and the run time stays anchored
--      to the first one. `sent_parts` / `reply_parts` make a retry resume
--      where it stopped instead of sending a bubble twice.
--   5. ai_handoffs — why the AI handed a conversation to the team
--      (the thread card "Por que a IA passou para você").
--   6. RPCs (service_role only): ai_reply_enqueue, ai_reply_claim
--      (FOR UPDATE SKIP LOCKED + stale-running reaper) and
--      ai_knowledge_search_service (knowledge search for the server-side
--      runtime, which has no signed-in user; strictly one account).
--
-- RLS: jobs are readable by agent+ of the account (agents page), hand-
-- overs by any member (thread card); only the service role writes.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. CONVERSATIONS
-- ============================================================
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_paused_until TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_last_reply_at TIMESTAMPTZ;

-- ============================================================
-- 2. HUMAN REPLY PAUSES THE AI
-- ============================================================
CREATE OR REPLACE FUNCTION public.messages_pause_ai_on_human_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_customer TIMESTAMPTZ;
BEGIN
  IF NEW.sender_type IS DISTINCT FROM 'agent' THEN
    RETURN NEW;
  END IF;
  -- WhatsApp Business greeting / away message right after the customer
  -- is not a person answering (059).
  IF NEW.origin = 'phone' THEN
    SELECT last_customer_message_at INTO v_last_customer FROM conversations WHERE id = NEW.conversation_id;
    IF NOT public.phone_echo_counts_as_reply(NEW.created_at, v_last_customer) THEN
      RETURN NEW;
    END IF;
  END IF;
  UPDATE conversations
     SET ai_paused_until = GREATEST(COALESCE(ai_paused_until, '-infinity'::timestamptz), NOW() + INTERVAL '30 minutes')
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.messages_pause_ai_on_human_reply() OWNER TO postgres;

DROP TRIGGER IF EXISTS messages_pause_ai_on_human_reply ON public.messages;
CREATE TRIGGER messages_pause_ai_on_human_reply AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_pause_ai_on_human_reply();

-- ============================================================
-- 3. CHECK lists
-- ============================================================
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_origin_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_origin_check
  CHECK (origin IS NULL OR origin IN ('phone', 'automation', 'flow', 'system', 'ai'));

ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_feature_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_feature_check
  CHECK (feature IN ('suggest_reply', 'memory_extract', 'agent_test', 'auto_reply'));

ALTER TABLE conversation_events DROP CONSTRAINT IF EXISTS conversation_events_event_type_check;
ALTER TABLE conversation_events ADD CONSTRAINT conversation_events_event_type_check
  CHECK (
    event_type IN (
      'assigned',
      'unassigned',
      'status_changed',
      'label_added',
      'label_removed',
      'note_added',
      'contact_opted_out',
      'contact_opted_in',
      'ai_handoff',
      'ai_paused',
      'ai_resumed'
    )
  );

-- ============================================================
-- 4. AI_REPLY_JOBS
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_reply_jobs (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id      UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id           UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id             UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'queued',
  run_after            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts             INT NOT NULL DEFAULT 0,
  last_error           TEXT,
  skip_reason          TEXT,
  outcome              TEXT,
  inbound_message_ids  UUID[] NOT NULL DEFAULT '{}',
  reply_parts          TEXT[],
  sent_parts           INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_reply_jobs DROP CONSTRAINT IF EXISTS ai_reply_jobs_status_check;
ALTER TABLE ai_reply_jobs ADD CONSTRAINT ai_reply_jobs_status_check
  CHECK (status IN ('queued', 'running', 'done', 'skipped', 'failed'));
ALTER TABLE ai_reply_jobs DROP CONSTRAINT IF EXISTS ai_reply_jobs_outcome_check;
ALTER TABLE ai_reply_jobs ADD CONSTRAINT ai_reply_jobs_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('replied', 'handoff', 'opted_out'));
ALTER TABLE ai_reply_jobs DROP CONSTRAINT IF EXISTS ai_reply_jobs_text_check;
ALTER TABLE ai_reply_jobs ADD CONSTRAINT ai_reply_jobs_text_check
  CHECK (
    (last_error IS NULL OR char_length(last_error) <= 500)
    AND (skip_reason IS NULL OR char_length(skip_reason) <= 60)
    AND cardinality(inbound_message_ids) <= 200
    AND sent_parts >= 0
  );

-- One pending job per conversation: the debounce anchor.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_reply_jobs_queued
  ON ai_reply_jobs(conversation_id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_ai_reply_jobs_due
  ON ai_reply_jobs(run_after) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_ai_reply_jobs_running
  ON ai_reply_jobs(updated_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_ai_reply_jobs_agent
  ON ai_reply_jobs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_reply_jobs_conversation
  ON ai_reply_jobs(conversation_id, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON ai_reply_jobs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_reply_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE ai_reply_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_reply_jobs_select ON ai_reply_jobs;
CREATE POLICY ai_reply_jobs_select ON ai_reply_jobs FOR SELECT
  USING (is_account_member(account_id, 'agent'));

REVOKE ALL ON TABLE ai_reply_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE ai_reply_jobs TO authenticated;
GRANT ALL ON TABLE ai_reply_jobs TO service_role;

-- ============================================================
-- 5. AI_HANDOFFS
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_handoffs (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id      UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id           UUID REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id             UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  job_id               UUID REFERENCES ai_reply_jobs(id) ON DELETE SET NULL,
  reason               TEXT NOT NULL,
  customer_wants       TEXT,
  last_customer_words  TEXT,
  notified             BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ai_handoffs DROP CONSTRAINT IF EXISTS ai_handoffs_text_check;
ALTER TABLE ai_handoffs ADD CONSTRAINT ai_handoffs_text_check
  CHECK (
    char_length(reason) BETWEEN 1 AND 300
    AND (customer_wants IS NULL OR char_length(customer_wants) <= 300)
    AND (last_customer_words IS NULL OR char_length(last_customer_words) <= 600)
  );

CREATE INDEX IF NOT EXISTS idx_ai_handoffs_conversation
  ON ai_handoffs(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_handoffs_contact ON ai_handoffs(contact_id);

ALTER TABLE ai_handoffs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_handoffs_select ON ai_handoffs;
CREATE POLICY ai_handoffs_select ON ai_handoffs FOR SELECT
  USING (is_account_member(account_id));

REVOKE ALL ON TABLE ai_handoffs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE ai_handoffs TO authenticated;
GRANT ALL ON TABLE ai_handoffs TO service_role;

-- ============================================================
-- 6. RPCs (service role only)
-- ============================================================

-- Debounced enqueue: a new queued job runs `p_delay_seconds` after the
-- FIRST message; later messages only attach their id. Returns the job id.
CREATE OR REPLACE FUNCTION public.ai_reply_enqueue(
  p_account_id      UUID,
  p_conversation_id UUID,
  p_contact_id      UUID,
  p_agent_id        UUID,
  p_message_id      UUID,
  p_delay_seconds   INT DEFAULT 8
) RETURNS UUID
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO ai_reply_jobs (account_id, conversation_id, contact_id, agent_id, run_after, inbound_message_ids)
  VALUES (
    p_account_id, p_conversation_id, p_contact_id, p_agent_id,
    NOW() + make_interval(secs => greatest(0, least(coalesce(p_delay_seconds, 8), 300))),
    CASE WHEN p_message_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p_message_id] END
  )
  ON CONFLICT (conversation_id) WHERE status = 'queued'
  DO UPDATE SET
    agent_id = EXCLUDED.agent_id,
    inbound_message_ids = CASE
      WHEN p_message_id IS NULL OR p_message_id = ANY (ai_reply_jobs.inbound_message_ids)
        OR cardinality(ai_reply_jobs.inbound_message_ids) >= 200
      THEN ai_reply_jobs.inbound_message_ids
      ELSE array_append(ai_reply_jobs.inbound_message_ids, p_message_id)
    END
  RETURNING id;
$$;

REVOKE ALL ON FUNCTION public.ai_reply_enqueue(UUID, UUID, UUID, UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_reply_enqueue(UUID, UUID, UUID, UUID, UUID, INT) TO service_role;

-- Claim due jobs. First the reaper: a job 'running' for more than 2
-- minutes (crashed worker) goes back to the queue — or fails after 3
-- attempts, or is dropped when a newer queued job of the same
-- conversation will answer anyway. Then up to p_limit due jobs whose
-- conversation has no job running are flipped to 'running' (attempts+1)
-- with FOR UPDATE SKIP LOCKED, so concurrent drains never share a job.
CREATE OR REPLACE FUNCTION public.ai_reply_claim(p_limit INT DEFAULT 10)
RETURNS SETOF ai_reply_jobs
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  UPDATE ai_reply_jobs j
     SET status = CASE
           WHEN j.attempts >= 3 THEN 'failed'
           WHEN EXISTS (SELECT 1 FROM ai_reply_jobs q WHERE q.conversation_id = j.conversation_id AND q.status = 'queued') THEN 'skipped'
           ELSE 'queued'
         END,
         skip_reason = CASE
           WHEN j.attempts < 3 AND EXISTS (SELECT 1 FROM ai_reply_jobs q WHERE q.conversation_id = j.conversation_id AND q.status = 'queued')
           THEN 'superseded' ELSE j.skip_reason END,
         last_error = 'stale: worker stopped while running',
         run_after = NOW()
   WHERE j.status = 'running'
     AND j.updated_at < NOW() - INTERVAL '2 minutes';

  RETURN QUERY
  WITH picked AS (
    SELECT j.id
      FROM ai_reply_jobs j
     WHERE j.status = 'queued'
       AND j.run_after <= NOW()
       AND NOT EXISTS (
         SELECT 1 FROM ai_reply_jobs r WHERE r.conversation_id = j.conversation_id AND r.status = 'running'
       )
     ORDER BY j.run_after
     LIMIT least(greatest(coalesce(p_limit, 10), 1), 50)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE ai_reply_jobs j
     SET status = 'running', attempts = j.attempts + 1
    FROM picked
   WHERE j.id = picked.id
  RETURNING j.*;
END;
$$;

REVOKE ALL ON FUNCTION public.ai_reply_claim(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_reply_claim(INT) TO service_role;

-- Knowledge search for the runtime. Same ranking as
-- ai_knowledge_search (063) — which now delegates here after its
-- membership check — but callable only by the service role, strictly
-- filtered by p_account_id.
CREATE OR REPLACE FUNCTION public.ai_knowledge_search_service(
  p_account_id UUID,
  p_query      TEXT,
  p_limit      INTEGER DEFAULT 5
) RETURNS TABLE (
  chunk_id  UUID,
  item_id   UUID,
  title     TEXT,
  kind      TEXT,
  content   TEXT,
  rank      REAL
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
  v_query TEXT := left(coalesce(p_query, ''), 2000);
  v_norm  TEXT;
  v_ts    tsquery;
  v_short BOOLEAN;
BEGIN
  IF p_account_id IS NULL OR btrim(v_query) = '' THEN
    RETURN;
  END IF;

  v_norm := regexp_replace(
    public.ai_kb_norm(v_query),
    '\m(oi+|ola|ole|opa|eai|bom|boa|bons|boas|dia|tarde|noite|tudo|bem|td|blz|beleza|obrigad[oa]s?|obg|valeu|vlw|ok|okay|pfv|pf|grat[oa])\M',
    ' ', 'g');
  v_norm := btrim(regexp_replace(v_norm, '[^[:alnum:]]+', ' ', 'g'));
  IF v_norm = '' THEN
    RETURN;
  END IF;
  v_short := char_length(v_norm) BETWEEN 3 AND 60;

  SELECT (string_agg('''' || replace(replace(lex, '\', '\\'), '''', '''''') || '''', ' | '))::tsquery
    INTO v_ts
    FROM unnest(tsvector_to_array(public.ai_kb_tsv(v_norm))) AS lex;

  IF v_ts IS NULL AND NOT v_short THEN
    RETURN;
  END IF;

  PERFORM set_config('pg_trgm.word_similarity_threshold', '0.5', true);

  RETURN QUERY
  SELECT r.chunk_id, r.item_id, r.title, r.kind, r.content, r.rank
    FROM (
      SELECT c.id AS chunk_id, c.item_id, i.title, i.kind, c.content, c.chunk_index,
             (COALESCE(ts_rank_cd(c.tsv, v_ts, 32), 0)
              + CASE WHEN v_short THEN word_similarity(v_norm, public.ai_kb_norm(c.content)) * 0.5 ELSE 0 END
             )::REAL AS rank
        FROM ai_knowledge_chunks c
        JOIN ai_knowledge_items i ON i.id = c.item_id AND i.account_id = c.account_id
       WHERE c.account_id = p_account_id
         AND i.enabled
         AND (
           (v_ts IS NOT NULL AND c.tsv @@ v_ts)
           OR (v_short AND v_norm <% public.ai_kb_norm(c.content))
         )
    ) r
   WHERE r.rank >= 0.2
   ORDER BY r.rank DESC, r.item_id, r.chunk_index
   LIMIT least(greatest(coalesce(p_limit, 5), 1), 20);
END;
$$;

ALTER FUNCTION public.ai_knowledge_search_service(UUID, TEXT, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ai_knowledge_search_service(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_knowledge_search_service(UUID, TEXT, INTEGER) TO service_role;

-- 063's search keeps its contract (agent+ of the account) and now
-- shares the ranking body above.
CREATE OR REPLACE FUNCTION public.ai_knowledge_search(
  p_account_id UUID,
  p_query      TEXT,
  p_limit      INTEGER DEFAULT 5
) RETURNS TABLE (
  chunk_id  UUID,
  item_id   UUID,
  title     TEXT,
  kind      TEXT,
  content   TEXT,
  rank      REAL
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $$
BEGIN
  IF NOT is_account_member(p_account_id, 'agent') THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM public.ai_knowledge_search_service(p_account_id, p_query, p_limit);
END;
$$;

ALTER FUNCTION public.ai_knowledge_search(UUID, TEXT, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ai_knowledge_search(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ai_knowledge_search(UUID, TEXT, INTEGER) TO authenticated, service_role;
