// ============================================================
// Conversation assignment writes (inbox header: Assumir / Transferir).
//
// `expectCurrent` turns the update into a compare-and-set on the
// assignee the caller last saw (`IS NULL` for an unassigned thread):
// when a teammate took the conversation first, nothing is written and
// the caller learns who holds it now. RLS (agent+) is unchanged.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type AssignOutcome =
  | { status: 'ok' }
  | { status: 'failed'; error: string }
  /** Someone else changed the assignee first; `assignee` is who has it now. */
  | { status: 'conflict'; assignee: string | null }

export async function updateConversationAssignee(
  db: Pick<SupabaseClient, 'from'>,
  params: {
    conversationId: string
    agentId: string | null
    /** The assignee this tab last saw — omit for an unconditional write. */
    expectCurrent?: string | null
  },
): Promise<AssignOutcome> {
  let query = db
    .from('conversations')
    .update({ assigned_agent_id: params.agentId })
    .eq('id', params.conversationId)
  if (params.expectCurrent !== undefined) {
    query = params.expectCurrent
      ? query.eq('assigned_agent_id', params.expectCurrent)
      : query.is('assigned_agent_id', null)
  }
  const { data, error } = await query.select('id')
  if (error) return { status: 'failed', error: error.message }
  if (params.expectCurrent !== undefined && (!data || data.length === 0)) {
    const { data: fresh } = await db
      .from('conversations')
      .select('assigned_agent_id')
      .eq('id', params.conversationId)
      .maybeSingle()
    return {
      status: 'conflict',
      assignee: (fresh as { assigned_agent_id?: string | null } | null)?.assigned_agent_id ?? null,
    }
  }
  return { status: 'ok' }
}
