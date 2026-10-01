// ============================================================
// CSAT answer interception (migration 074).
//
// Called by ingestInboundMessage right after the contact is known and
// BEFORE the conversation is chosen, flows, automations, AI auto-reply,
// triage, unread counters and the reopen-on-reply rule. So a survey answer
//   - is never read as a keyword or fed to a flow / the AI,
//   - does not reopen the resolved conversation and never starts a new one,
//   - does not bump unread or reorder the inbox: the message is only stored
//     in the surveyed (closed) conversation.
//
// What it consumes (and nothing else):
//   1. the score — a survey `sent` < 48 h ago whose conversation is still
//      closed, when the reply is JUST a score (parseCsatScore);
//   2. the comment — once, within 24 h of the comment question: the next
//      text that is not a question. "não" / "pular" / a repeated score only
//      closes the question without storing anything.
// Anything else (a question, long text, media, a new problem) is a normal
// inbound message; the survey keeps waiting until the cron expires it.
//
// Not consumed either when the contact already has an open / pending
// conversation: they are mid-chat and a "5" there belongs to that chat.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { drainAutomationEvents } from '@/lib/automations/event-queue'
import { engineSendText } from '@/lib/automations/meta-send'
import {
  CSAT_ANSWER_WINDOW_MS,
  CSAT_COMMENT_WINDOW_MS,
  isCommentCandidate,
  isCommentDecline,
  parseCsatScore,
  parseCsatSettings,
  thanksText,
} from './csat'

export interface CsatInboundInput {
  accountId: string
  contactId: string
  /** The contact's conversations, newest first (the pipeline already loaded them). */
  conversations: { id: string; status: string }[]
  type: string
  text: string | null
  /** Provider message id and original timestamp, for the stored message. */
  messageId: string
  createdAt: string
  channel: string
  /** `user_id` for the thanks message (account owner). */
  userId: string
}

export type CsatInboundResult =
  | { consumed: false }
  | { consumed: true; conversationId: string; kind: 'score' | 'comment' | 'declined'; score?: number }

interface PendingRow {
  id: string
  conversation_id: string
  status: 'sent' | 'answered'
  sent_at: string
  comment_requested_at: string | null
  comment_received_at: string | null
}

type SendText = typeof engineSendText

export async function tryConsumeCsat(
  db: SupabaseClient,
  input: CsatInboundInput,
  now: Date = new Date(),
  deps: { send?: SendText; drain?: typeof drainAutomationEvents } = {},
): Promise<CsatInboundResult> {
  const text = (input.text ?? '').trim()
  if (!text || (input.type !== 'text' && input.type !== 'interactive')) return { consumed: false }
  // Mid-chat: a live conversation owns this message.
  if (input.conversations.some((c) => c.status !== 'closed')) return { consumed: false }

  const { data, error } = await db
    .from('csat_responses')
    .select('id, conversation_id, status, sent_at, comment_requested_at, comment_received_at')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .in('status', ['sent', 'answered'])
    .order('sent_at', { ascending: false })
    .limit(5)
  // A missing table (migration not applied) or any read error: carry on as a normal message.
  if (error || !data?.length) return { consumed: false }

  const closed = new Set(input.conversations.filter((c) => c.status === 'closed').map((c) => c.id))
  const rows = (data as PendingRow[]).filter((r) => closed.has(r.conversation_id))
  const nowMs = now.getTime()
  const score = parseCsatScore(text)

  const awaitingScore =
    score !== null
      ? rows.find((r) => r.status === 'sent' && nowMs - Date.parse(r.sent_at) <= CSAT_ANSWER_WINDOW_MS)
      : undefined
  if (awaitingScore && score !== null) {
    return recordScore(db, input, awaitingScore, score, now, deps)
  }

  const awaitingComment = rows.find(
    (r) =>
      r.status === 'answered' &&
      r.comment_requested_at &&
      !r.comment_received_at &&
      nowMs - Date.parse(r.comment_requested_at) <= CSAT_COMMENT_WINDOW_MS,
  )
  if (awaitingComment && (score !== null || isCommentDecline(text) || isCommentCandidate(text))) {
    const declined = score !== null || isCommentDecline(text)
    const { data: won, error: rpcErr } = await db.rpc('csat_record_comment', {
      p_response_id: awaitingComment.id,
      p_comment: declined ? null : text,
      p_now: now.toISOString(),
    })
    if (rpcErr || won !== true) return { consumed: false }
    await storeMessage(db, input, awaitingComment.conversation_id)
    return { consumed: true, conversationId: awaitingComment.conversation_id, kind: declined ? 'declined' : 'comment' }
  }
  return { consumed: false }
}

async function recordScore(
  db: SupabaseClient,
  input: CsatInboundInput,
  row: PendingRow,
  score: number,
  now: Date,
  deps: { send?: SendText; drain?: typeof drainAutomationEvents },
): Promise<CsatInboundResult> {
  const settingsRes = await db.from('csat_settings').select('*').eq('account_id', input.accountId).maybeSingle()
  const settings = parseCsatSettings(settingsRes.data)

  const { data, error } = await db.rpc('csat_record_answer', {
    p_response_id: row.id,
    p_score: score,
    p_ask_comment: settings.ask_comment,
    p_now: now.toISOString(),
  })
  // Lost the race / expired in between: nothing to consume.
  if (error || !((data as unknown[] | null) ?? []).length) return { consumed: false }

  await storeMessage(db, input, row.conversation_id)

  const reply = thanksText(settings)
  if (reply) {
    // Fire and forget: the transport must answer its 200 fast (QR sends are paced).
    void (deps.send ?? engineSendText)({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: row.conversation_id,
      contactId: input.contactId,
      text: reply,
      origin: 'csat',
    }).catch((err: unknown) => console.error('[csat] thanks not sent:', err instanceof Error ? err.message : err))
  }
  // csat_received was queued by csat_record_answer: run it now, not next minute.
  void (deps.drain ?? drainAutomationEvents)({ accountId: input.accountId }).catch((err: unknown) =>
    console.error('[csat] automation drain failed:', err),
  )
  return { consumed: true, conversationId: row.conversation_id, kind: 'score', score }
}

/**
 * Keep the customer's reply in the history of the surveyed conversation.
 * Bookkeeping only: the conversation row (unread, preview, status) is not touched.
 */
async function storeMessage(db: SupabaseClient, input: CsatInboundInput, conversationId: string): Promise<boolean> {
  const { error } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'customer',
    content_type: input.type === 'interactive' ? 'interactive' : 'text',
    content_text: input.text,
    message_id: input.messageId,
    status: 'delivered',
    channel: input.channel,
    created_at: input.createdAt,
  })
  if (error && error.code !== '23505') {
    console.error('[csat] answer not stored:', error.message)
    return false
  }
  return true
}
