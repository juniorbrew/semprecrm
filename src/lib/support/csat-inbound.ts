// ============================================================
// CSAT answer interception (migration 074).
//
// Called by ingestInboundMessage right after the contact is known and
// BEFORE the conversation is chosen, flows, automations, AI auto-reply,
// triage, unread counters and the reopen-on-reply rule. A consumed reply
//   - is never read as a keyword or fed to a flow / the AI,
//   - does not reopen the resolved conversation and never starts a new one,
//   - does not bump unread, reorder the inbox or un-archive: it is only
//     stored in the surveyed (closed) conversation, with origin 'csat'.
//
// What it consumes (and nothing else; when in doubt the message flows):
//   1. a lone score ("5", "nota 4", "três", 👍) on a survey `sent` < 48 h ago;
//   2. a short polite non-score reply while the survey waits ("obrigado",
//      "ótimo", "10", "👍👍"): stored only, the survey keeps waiting;
//   3. the comment, once, within 10 minutes of the comment question having been
//      SENT: a short neutral text. "não" / "pular" only close the question.
// Two cases are recorded AND flow normally (consumed: false, stored once by the
// pipeline): "5 mas demorou" (score + comment in one message) and a comment that
// reads as a complaint / request or follows a score of 1-2.
// A question, a long text or media is a plain message and records nothing.
//
// Never consumed either: when the contact has an open / pending conversation,
// when a flow run is active, or when the survey is no longer the latest outbound
// message (a flow menu or a broadcast came after it).
// Any error falls through as a normal message: an inbound message is never lost.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { drainAutomationEvents } from '@/lib/automations/event-queue'
import { engineSendText } from '@/lib/automations/meta-send'
import {
  CSAT_ANSWER_WINDOW_MS,
  CSAT_COMMENT_WINDOW_MS,
  isPoliteReply,
  judgeComment,
  parseCsatScore,
  parseCsatSettings,
  parseScoreWithComment,
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
  | { consumed: true; conversationId: string; kind: 'score' | 'comment' | 'declined' | 'polite'; score?: number }

interface PendingRow {
  id: string
  conversation_id: string
  status: 'sent' | 'answered'
  score: number | null
  sent_at: string
  comment_requested_at: string | null
  comment_received_at: string | null
}

type SendText = typeof engineSendText
type Deps = { send?: SendText; drain?: typeof drainAutomationEvents }

const NOT_CONSUMED: CsatInboundResult = { consumed: false }

export async function tryConsumeCsat(
  db: SupabaseClient,
  input: CsatInboundInput,
  now: Date = new Date(),
  deps: Deps = {},
): Promise<CsatInboundResult> {
  try {
    return await consume(db, input, now, deps)
  } catch (err) {
    console.error('[csat] interception failed, message goes through:', err instanceof Error ? err.message : err)
    return NOT_CONSUMED
  }
}

async function consume(db: SupabaseClient, input: CsatInboundInput, now: Date, deps: Deps): Promise<CsatInboundResult> {
  const text = (input.text ?? '').trim()
  if (!text || (input.type !== 'text' && input.type !== 'interactive')) return NOT_CONSUMED
  // Mid-chat: a live conversation owns this message.
  if (input.conversations.some((c) => c.status !== 'closed')) return NOT_CONSUMED

  const { data, error } = await db
    .from('csat_responses')
    .select('id, conversation_id, status, score, sent_at, comment_requested_at, comment_received_at')
    .eq('account_id', input.accountId)
    .eq('contact_id', input.contactId)
    .in('status', ['sent', 'answered'])
    .order('sent_at', { ascending: false })
    .limit(5)
  // A missing table (migration not applied) or any read error: a normal message.
  if (error || !data?.length) return NOT_CONSUMED

  const closed = new Set(input.conversations.filter((c) => c.status === 'closed').map((c) => c.id))
  const rows = (data as PendingRow[]).filter((r) => closed.has(r.conversation_id))
  if (!rows.length) return NOT_CONSUMED
  const nowMs = now.getTime()

  const awaitingScore = rows.find((r) => r.status === 'sent' && nowMs - Date.parse(r.sent_at) <= CSAT_ANSWER_WINDOW_MS)
  const awaitingComment = rows.find(
    (r) =>
      r.status === 'answered' &&
      r.comment_requested_at &&
      !r.comment_received_at &&
      nowMs - Date.parse(r.comment_requested_at) <= CSAT_COMMENT_WINDOW_MS,
  )
  if (!awaitingScore && !awaitingComment) return NOT_CONSUMED

  // The survey (or the thanks) must still be the last thing we said to this
  // contact, and no flow may be waiting for an answer.
  if (!(await surveyIsLastWord(db, input))) return NOT_CONSUMED

  if (awaitingScore) {
    const score = parseCsatScore(text)
    if (score !== null) return recordScore(db, input, awaitingScore, score, null, now, deps)
    const withComment = parseScoreWithComment(text)
    if (withComment) return recordScore(db, input, awaitingScore, withComment.score, withComment.comment, now, deps)
    if (isPoliteReply(text)) {
      return (await storeMessage(db, input, awaitingScore.conversation_id))
        ? { consumed: true, conversationId: awaitingScore.conversation_id, kind: 'polite' }
        : NOT_CONSUMED
    }
  }

  if (awaitingComment) {
    const verdict = judgeComment(text, awaitingComment.score)
    if (verdict === 'flow') return NOT_CONSUMED
    const { data: won, error: rpcErr } = await db.rpc('csat_record_comment', {
      p_response_id: awaitingComment.id,
      p_comment: verdict === 'decline' ? null : text,
      p_now: now.toISOString(),
    })
    if (rpcErr) return NOT_CONSUMED
    if (won !== true) return duplicateOrNot(db, input, awaitingComment.conversation_id, 'comment')
    // A complaint or request keeps its comment but is also a normal message.
    if (verdict === 'record') return NOT_CONSUMED
    if (!(await storeMessage(db, input, awaitingComment.conversation_id))) return NOT_CONSUMED
    return { consumed: true, conversationId: awaitingComment.conversation_id, kind: verdict === 'decline' ? 'declined' : 'comment' }
  }
  return NOT_CONSUMED
}

/** The latest outbound message to this contact is ours (origin csat) and no flow is active. */
async function surveyIsLastWord(db: SupabaseClient, input: CsatInboundInput): Promise<boolean> {
  const ids = input.conversations.map((c) => c.id)
  const [last, flow] = await Promise.all([
    db
      .from('messages')
      .select('origin, created_at')
      .in('conversation_id', ids)
      .neq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1),
    db
      .from('flow_runs')
      .select('id')
      .eq('account_id', input.accountId)
      .eq('contact_id', input.contactId)
      .eq('status', 'active')
      .limit(1),
  ])
  if (last.error || flow.error) return false
  const latest = ((last.data ?? []) as { origin: string | null }[])[0]
  return latest?.origin === 'csat' && !(flow.data ?? []).length
}

async function recordScore(
  db: SupabaseClient,
  input: CsatInboundInput,
  row: PendingRow,
  score: number,
  comment: string | null,
  now: Date,
  deps: Deps,
): Promise<CsatInboundResult> {
  const settingsRes = await db.from('csat_settings').select('*').eq('account_id', input.accountId).maybeSingle()
  const settings = parseCsatSettings(settingsRes.data)

  const { data, error } = await db.rpc('csat_record_answer', {
    p_response_id: row.id,
    p_score: score,
    p_comment: comment,
    p_now: now.toISOString(),
  })
  if (error) return NOT_CONSUMED
  // Lost the race (or expired in between): nothing to record. If the winner
  // already stored this very message it is a duplicate delivery: stop here.
  if (!((data as unknown[] | null) ?? []).length) return duplicateOrNot(db, input, row.conversation_id, 'score')

  // "5 mas demorou" keeps the score and the comment but is also a normal message.
  const consumed = comment === null
  const stored = consumed ? await storeMessage(db, input, row.conversation_id) : true

  // Thanks (+ the comment question only when the customer has not commented yet).
  const reply = comment === null ? thanksText(settings) : settings.thanks_text.trim()
  const askComment = comment === null && settings.ask_comment
  if (reply) {
    // Fire and forget: the transport must answer its 200 fast (QR sends are paced).
    // The comment question only counts once it really went out.
    void (deps.send ?? engineSendText)({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: row.conversation_id,
      contactId: input.contactId,
      text: reply,
      origin: 'csat',
    })
      .then(async () => {
        if (askComment) await db.rpc('csat_request_comment', { p_response_id: row.id, p_now: new Date().toISOString() })
      })
      .catch((err: unknown) => console.error('[csat] thanks not sent:', err instanceof Error ? err.message : err))
  }
  // csat_received was queued by csat_record_answer: run it now, not next minute.
  void (deps.drain ?? drainAutomationEvents)({ accountId: input.accountId }).catch((err: unknown) =>
    console.error('[csat] automation drain failed:', err),
  )
  if (!consumed || !stored) return NOT_CONSUMED
  return { consumed: true, conversationId: row.conversation_id, kind: 'score', score }
}

/** A lost race is only a duplicate when the winner stored this same provider message. */
async function duplicateOrNot(
  db: SupabaseClient,
  input: CsatInboundInput,
  conversationId: string,
  kind: 'score' | 'comment',
): Promise<CsatInboundResult> {
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', input.messageId)
    .limit(1)
  return (data ?? []).length ? { consumed: true, conversationId, kind } : NOT_CONSUMED
}

/**
 * Keep the customer's reply in the history of the surveyed conversation, with
 * origin 'csat' so the bookkeeping triggers ignore it (no un-archive, no
 * last_customer_message_at bump). The conversation row itself is not touched.
 * False when it could not be stored: the caller then lets the message flow.
 */
async function storeMessage(db: SupabaseClient, input: CsatInboundInput, conversationId: string): Promise<boolean> {
  const { error } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'customer',
    origin: 'csat',
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
