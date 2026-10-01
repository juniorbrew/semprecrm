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

import type { SupabaseClient } from '@supabase/supabase-js'

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

/**
 * Forward-only status update for the row(s) with provider id `messageId`,
 * limited to conversations of `accountId`. Provider ids are not unique
 * across tenants (and the QR ack's id comes from the gateway body), so an
 * unscoped `.eq('message_id', …)` could touch another account's message.
 * Two steps because PostgREST cannot filter an UPDATE through a join; the
 * `.in('status', allowedFrom)` guard stays atomic in the second step.
 */
export async function updateAccountMessageStatus(
  db: SupabaseClient,
  args: {
    accountId: string
    messageId: string
    channel?: 'qr' | 'official'
    patch: Record<string, unknown>
    allowedFrom: readonly string[]
  },
): Promise<{ error: { message: string; code?: string } | null }> {
  let query = db
    .from('messages')
    .select('id, conversations!inner(account_id)')
    .eq('message_id', args.messageId)
    .eq('conversations.account_id', args.accountId)
  if (args.channel) query = query.eq('channel', args.channel)
  const { data, error } = await query
  if (error) return { error }
  const ids = ((data ?? []) as { id: string }[]).map((r) => r.id)
  if (ids.length === 0) return { error: null }
  const { error: updErr } = await db
    .from('messages')
    .update(args.patch)
    .in('id', ids)
    .in('status', [...args.allowedFrom])
  return { error: updErr }
}
