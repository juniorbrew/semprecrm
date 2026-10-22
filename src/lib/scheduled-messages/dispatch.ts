// ============================================================
// Scheduled-message dispatch (migration 092), run by the cron every tick and
// by "enviar agora".
//
// `scheduled_messages_claim()` flips pending -> sending in ONE SQL statement
// (FOR UPDATE SKIP LOCKED), so overlapping ticks split the rows and a message
// is never sent twice. Each claimed row is then checked (author still agent+,
// LGPD, newer conversation, official 24 h window) and sent through the same
// engine senders automations use, persisted as the author's own agent
// message. Every outcome is written back: `sent`, or `failed` with a pt-BR
// reason the thread shows (+ a best-effort push to the author). Nothing fails
// silently, and a failed row is never retried on its own (retry is a click).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { hasMinRole, isAccountRole } from '@/lib/auth/roles'
import { findOtherActiveConversation } from '@/lib/conversations/find-by-contact'
import { engineSendText } from '@/lib/automations/meta-send'
import { pauseActiveFlowRuns } from '@/lib/flows/pause-on-agent'
import { conversationUrl } from '@/lib/push/notify'
import { isPushConfigured, sendPushToUsers } from '@/lib/push/send'
import { isWithinServiceWindow } from './schedule'

export const DISPATCH_BATCH = 25
export const DISPATCH_MAX_BATCHES = 4

export interface ScheduledRow {
  id: string
  account_id: string
  conversation_id: string
  contact_id: string
  created_by: string
  content_text: string
}

export type SendScheduled = (row: ScheduledRow) => Promise<{ whatsapp_message_id: string }>

export interface DispatchDeps {
  send?: SendScheduled
  notifyFailure?: (row: ScheduledRow, reason: string) => Promise<void>
  findOtherActive?: typeof findOtherActiveConversation
}

export interface DispatchResult {
  claimed: number
  sent: number
  failed: number
}

class Reject extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const defaultSend: SendScheduled = (row) =>
  engineSendText({
    accountId: row.account_id,
    userId: row.created_by,
    agentId: row.created_by,
    conversationId: row.conversation_id,
    contactId: row.contact_id,
    text: row.content_text,
  })

/** Checks that must hold at send time (the world changed since scheduling). */
export async function precheck(
  db: SupabaseClient,
  row: ScheduledRow,
  now: Date,
  findOtherActive: typeof findOtherActiveConversation,
): Promise<void> {
  const { data: author } = await db
    .from('profiles')
    .select('account_role')
    .eq('user_id', row.created_by)
    .eq('account_id', row.account_id)
    .maybeSingle()
  const role = (author as { account_role?: unknown } | null)?.account_role
  if (!isAccountRole(role) || !hasMinRole(role, 'agent')) {
    throw new Reject('author_not_allowed', 'Quem agendou não pode mais enviar mensagens nesta conta.')
  }

  const { data: conv } = await db
    .from('conversations')
    .select('id, status, channel, contact_id, last_customer_message_at')
    .eq('id', row.conversation_id)
    .eq('account_id', row.account_id)
    .maybeSingle()
  const c = conv as {
    status: string
    channel: string | null
    last_customer_message_at: string | null
  } | null
  if (!c) throw new Reject('conversation_gone', 'A conversa não existe mais.')

  const { data: contact } = await db
    .from('contacts')
    .select('id, anonymized_at')
    .eq('id', row.contact_id)
    .eq('account_id', row.account_id)
    .maybeSingle()
  const k = contact as { anonymized_at: string | null } | null
  if (!k) throw new Reject('conversation_gone', 'O contato não existe mais.')
  if (k.anonymized_at) {
    throw new Reject('contact_anonymized', 'Este contato foi anonimizado (LGPD) e não pode receber mensagens.')
  }

  if (c.status === 'closed' && (await findOtherActive(db, row.contact_id, row.conversation_id))) {
    throw new Reject(
      'newer_conversation',
      'A conversa foi encerrada e o cliente já tem outra em andamento. Copie o texto e responda por ela.',
    )
  }

  if (c.channel !== 'qr' && !isWithinServiceWindow(c.last_customer_message_at, now)) {
    throw new Reject(
      'window_closed',
      'A janela de 24 h do WhatsApp estava encerrada no horário do envio: só modelos aprovados podem ser enviados até o cliente responder de novo.',
    )
  }
}

/** A DB failure AFTER the provider accepted the message: it went out, never retry it. */
const ALREADY_SENT_RE = /(sent to Meta|sent via gateway) but DB insert failed/i

async function pushFailure(db: SupabaseClient, row: ScheduledRow, reason: string): Promise<void> {
  if (!isPushConfigured()) return
  await sendPushToUsers(db, [row.created_by], {
    title: 'Mensagem agendada não enviada',
    body: reason.slice(0, 140),
    url: conversationUrl(row.conversation_id),
    tag: `scheduled:${row.id}`,
  })
}

const WRITE_TRIES = 3

/**
 * Writes the outcome of a claimed row, checking the result and retrying. If
 * it never lands the row stays `sending`; the SQL sweep then parks it as
 * `maybe_sent`, which only an explicit, confirmed retry can re-send. Never
 * throws: the provider call already happened.
 */
async function writeOutcome(db: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<boolean> {
  for (let i = 0; i < WRITE_TRIES; i++) {
    try {
      const { error } = await db.from('scheduled_messages').update(patch).eq('id', id).eq('status', 'sending')
      if (!error) return true
      console.error('[scheduled] outcome write failed:', error.message)
    } catch (err) {
      console.error('[scheduled] outcome write threw:', err instanceof Error ? err.message : err)
    }
  }
  return false
}

async function dispatchRow(db: SupabaseClient, row: ScheduledRow, now: Date, deps: DispatchDeps): Promise<boolean> {
  const send = deps.send ?? defaultSend
  const stamp = now.toISOString()
  try {
    await precheck(db, row, now, deps.findOtherActive ?? findOtherActiveConversation)
    const sent = await send(row)
    // It is an agent's message: a running bot flow must yield, like on a manual send.
    await pauseActiveFlowRuns(row.account_id, row.contact_id, db)
    await writeOutcome(db, row.id, {
      status: 'sent',
      sent_at: stamp,
      wa_message_id: sent.whatsapp_message_id,
      updated_at: stamp,
    })
    return true
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    if (!(err instanceof Reject) && ALREADY_SENT_RE.test(raw)) {
      await writeOutcome(db, row.id, {
        status: 'sent',
        sent_at: stamp,
        error_code: 'not_saved',
        error_text: 'Enviada, mas não foi gravada na conversa.',
        updated_at: stamp,
      })
      return true
    }
    const code = err instanceof Reject ? err.code : 'send_failed'
    const reason = err instanceof Reject ? err.message : `Falha ao enviar: ${raw}`.slice(0, 480)
    await writeOutcome(db, row.id, { status: 'failed', error_code: code, error_text: reason, updated_at: stamp })
    try {
      await (deps.notifyFailure ?? ((r, why) => pushFailure(db, r, why)))(row, reason)
    } catch (pushErr) {
      console.error('[scheduled] failure push threw:', pushErr instanceof Error ? pushErr.message : pushErr)
    }
    return false
  }
}

/**
 * Claims what is due (or the single row `id` for "enviar agora"/retry) and
 * sends it. Batches loop while a batch comes back full, capped per call; the
 * rest waits for the next tick.
 */
export async function runScheduledDispatch(
  db: SupabaseClient,
  opts: { now?: Date; id?: string; confirm?: boolean } & DispatchDeps = {},
): Promise<DispatchResult> {
  const now = opts.now ?? new Date()
  const out: DispatchResult = { claimed: 0, sent: 0, failed: 0 }
  for (let i = 0; i < (opts.id ? 1 : DISPATCH_MAX_BATCHES); i++) {
    const { data, error } = await db.rpc('scheduled_messages_claim', {
      p_now: now.toISOString(),
      p_limit: DISPATCH_BATCH,
      p_id: opts.id ?? null,
      p_confirm: !!opts.id && opts.confirm === true,
    })
    if (error) {
      // Migration 092 not applied yet reads as nothing to do.
      if (/42883|PGRST202|does not exist|schema cache/i.test(`${error.code ?? ''} ${error.message}`)) return out
      throw new Error(`claim failed: ${error.message}`)
    }
    const rows = (data ?? []) as ScheduledRow[]
    out.claimed += rows.length
    // Sequential: QR numbers are rate-sensitive and order matters per conversation.
    for (const row of rows) {
      if (await dispatchRow(db, row, now, opts)) out.sent++
      else out.failed++
    }
    if (rows.length < DISPATCH_BATCH) break
  }
  return out
}
