// ============================================================
// Inbox thread header — which queue actions to show / enable.
//
//   Assumir     assign to me (the "Assign" dropdown's shortcut); "✓ Sua"
//               when it already is
//   Transferir  hand over to another member (the assignee dropdown)
//   Lembrar     reminder task at a chosen time (Tasks module)
//   Resolver    close — the existing split button ("Fechar")
//   Arquivar    close + move out of the lists (migration 056)
//
// Every action writes `conversations` or `tasks`, whose RLS requires
// agent+ (migrations 017 / 027) — the same line `canSendMessages`
// draws. Viewers still see the controls, disabled, so the header does
// not change shape by role. Pure; the UI passes the role it has.
// ============================================================

import { canSendMessages, type AccountRole } from '@/lib/auth/roles'
import type { Conversation } from '@/types'

export type HeaderConversation = Pick<Conversation, 'status' | 'assigned_agent_id'> & {
  archived_at?: string | null
}

export interface HeaderActionState {
  visible: boolean
  enabled: boolean
}

export interface HeaderActions {
  /** Agent+ — false for viewers and while the role is unknown. */
  canWrite: boolean
  claim: HeaderActionState
  /**
   * Open thread already assigned to the current user: the header shows a
   * static "✓ Sua" instead of the Assumir button.
   */
  claimIsMine: boolean
  transfer: HeaderActionState
  remind: HeaderActionState
  close: HeaderActionState
  archive: HeaderActionState
  unarchive: HeaderActionState
}

export function conversationHeaderActions(params: {
  role: AccountRole | null | undefined
  userId: string | null | undefined
  conversation: HeaderConversation
  /** Tasks module on the plan — reminders are tasks. */
  tasksEnabled: boolean
}): HeaderActions {
  const { role, userId, conversation, tasksEnabled } = params
  const canWrite = !!role && canSendMessages(role)
  const archived = !!conversation.archived_at
  const closed = conversation.status === 'closed'
  const mine = !!userId && conversation.assigned_agent_id === userId
  const state = (visible: boolean): HeaderActionState => ({ visible, enabled: visible && canWrite })

  return {
    canWrite,
    // Shown on an open thread that is not mine yet; once it is mine the
    // header shows "✓ Sua" (claimIsMine) instead of a dead button.
    claim: state(!closed && !!userId && !mine),
    claimIsMine: !closed && mine,
    transfer: state(true),
    remind: state(tasksEnabled && !!userId),
    close: state(true),
    archive: state(!archived),
    unarchive: state(archived),
  }
}
