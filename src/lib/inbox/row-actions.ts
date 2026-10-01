// ============================================================
// List row quick actions (Resolver / Reabrir / Assumir) — the same writes
// the thread header makes, without opening the thread:
//
//   resolve   status → closed (the DB trigger stamps resolution/resolved_at)
//   reopen    status → open, refused while the contact has another live
//             conversation (migration 060; `reopenBlockedBy`)
//   claim     assign to me as a compare-and-set (`updateConversationAssignee`)
//
// Each logs the same `conversation_events` row the header logs, so the
// thread's pills read the same. RLS (agent+) is unchanged.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { updateConversationAssignee } from '@/lib/conversations/assign'
import { insertConversationEvent } from '@/lib/conversations/events'
import { findOtherActiveConversation, reopenBlockedBy } from '@/lib/conversations/find-by-contact'
import { transferEventPayload } from '@/lib/conversations/transfer-reason'
import type { Conversation } from '@/types'

export interface RowActor {
  accountId: string
  userId: string
  name?: string
}

export type RowActionResult =
  | { status: 'ok' }
  | { status: 'failed' }
  /** Reopen refused: the contact has another live conversation. */
  | { status: 'blocked'; otherId: string | null }
  /** Claim lost: someone else holds it now. */
  | { status: 'conflict'; assignee: string | null }

type Row = Pick<Conversation, 'id' | 'status' | 'contact_id' | 'assigned_agent_id'>

export async function setRowStatus(
  db: SupabaseClient,
  conv: Row,
  next: Conversation['status'],
  actor: RowActor,
): Promise<RowActionResult> {
  if (conv.status === next) return { status: 'ok' }
  const blocker = await reopenBlockedBy(db, conv, next)
  if (blocker) return { status: 'blocked', otherId: blocker.id }
  const { error } = await db.from('conversations').update({ status: next }).eq('id', conv.id)
  if (error) {
    if (conv.status === 'closed' && error.code === '23505') {
      const other = await findOtherActiveConversation(db, conv.contact_id, conv.id)
      return { status: 'blocked', otherId: other?.id ?? null }
    }
    console.error('Failed to update status from the list:', error)
    return { status: 'failed' }
  }
  void insertConversationEvent(db, {
    account_id: actor.accountId,
    conversation_id: conv.id,
    actor_user_id: actor.userId,
    event_type: 'status_changed',
    payload: { actor_name: actor.name, status: next, previous_status: conv.status },
  })
  return { status: 'ok' }
}

export async function claimRow(db: SupabaseClient, conv: Row, actor: RowActor): Promise<RowActionResult> {
  const result = await updateConversationAssignee(db, {
    conversationId: conv.id,
    agentId: actor.userId,
    expectCurrent: conv.assigned_agent_id ?? null,
  })
  if (result.status === 'failed') {
    console.error('Failed to claim from the list:', result.error)
    return { status: 'failed' }
  }
  if (result.status === 'conflict') return result
  void insertConversationEvent(db, {
    account_id: actor.accountId,
    conversation_id: conv.id,
    actor_user_id: actor.userId,
    event_type: 'assigned',
    payload: {
      actor_name: actor.name,
      ...transferEventPayload({ assigneeUserId: actor.userId, assigneeName: actor.name, selfAssigned: true }),
    },
  })
  return { status: 'ok' }
}
