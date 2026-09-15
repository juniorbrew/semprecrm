// ============================================================
// Forward-only ladder for `messages.status`.
//
// Delivery receipts do not arrive in order — on the QR channel the
// `sender` receipt from our own phone (→ "sent") routinely lands
// *after* the contact's delivery receipt — and webhooks get replayed.
// A status update must therefore never move a message back down:
//   sending → sent → delivered → read
// `failed` is a side branch that is only valid from `sending`/`sent`.
// ============================================================

import type { MessageStatus } from '@/types'

export const MESSAGE_STATUS_LADDER: readonly MessageStatus[] = ['sending', 'sent', 'delivered', 'read']

export type MessageAckStatus = 'sent' | 'delivered' | 'read' | 'failed'

export function isMessageAckStatus(value: unknown): value is MessageAckStatus {
  return value === 'sent' || value === 'delivered' || value === 'read' || value === 'failed'
}

/**
 * The statuses a row may currently have for `incoming` to be a forward
 * move. Use it as the `.in('status', …)` filter of the update so the
 * database enforces the ladder atomically (no read-then-write race).
 */
export function statusesBefore(incoming: MessageAckStatus): MessageStatus[] {
  if (incoming === 'failed') return ['sending', 'sent']
  const idx = MESSAGE_STATUS_LADDER.indexOf(incoming)
  return MESSAGE_STATUS_LADDER.slice(0, idx)
}

/** Pure check used where a row is already in hand (tests, UI). */
export function isForwardStatusMove(current: MessageStatus | null | undefined, incoming: MessageAckStatus): boolean {
  if (current == null) return true
  return statusesBefore(incoming).includes(current)
}
