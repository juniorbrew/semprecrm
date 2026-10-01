// ============================================================
// CSAT cron (migration 074), run every tick by scripts/cron-tick.mjs.
//
// 1. csat_expire(): surveys unanswered after 48 h become `expired`.
// 2. csat_claim_jobs(): due jobs (a conversation was resolved
//    `delay_minutes` ago), claimed with SKIP LOCKED so overlapping ticks
//    never take the same one.
// 3. Per job: re-read the conversation, decide eligibility NOW
//    (csatSkipReason), reserve the survey row (unique per conversation —
//    the second reservation of the same conversation finds a duplicate and
//    sends nothing), send, then record message id + `csat_sent` event.
//    A failed send removes the reservation and leaves the job to be tried
//    again (3 attempts, see csat_claim_jobs / csat_expire).
// Idempotent: a repeated tick finds no due job and no new expiry.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { engineSendText } from '@/lib/automations/meta-send'
import {
  CSAT_JOB_ONLY_REASONS,
  csatSkipReason,
  parseCsatSettings,
  surveyText,
  type CsatSkipReason,
} from './csat'

/** Jobs handled per tick (QR sends are paced ~1.2 s apart); the rest waits. */
export const CSAT_JOBS_PER_TICK = 25

export interface CsatCronResult {
  claimed: number
  sent: number
  skipped: number
  errors: number
  expired: number
}

interface Job {
  id: number
  account_id: string
  conversation_id: string
  service_count: number
}

type Send = (args: {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
  origin: 'csat'
}) => Promise<{ whatsapp_message_id: string }>

/** Missing function / table (migration 074 not applied yet) reads as nothing to do. */
const MISSING_RE = /42883|42P01|PGRST202|PGRST205|does not exist|schema cache/i
const isMissing = (e: { code?: string; message?: string }) => MISSING_RE.test(`${e.code ?? ''} ${e.message ?? ''}`)

export async function runCsatCron(
  db: SupabaseClient,
  now: Date = new Date(),
  send: Send = engineSendText,
): Promise<CsatCronResult> {
  const out: CsatCronResult = { claimed: 0, sent: 0, skipped: 0, errors: 0, expired: 0 }

  const expired = await db.rpc('csat_expire', { p_now: now.toISOString() })
  if (expired.error) {
    if (!isMissing(expired.error)) console.error('[csat] expire failed:', expired.error.message)
    return out
  }
  out.expired = Number(expired.data) || 0

  const claimed = await db.rpc('csat_claim_jobs', { p_now: now.toISOString(), p_limit: CSAT_JOBS_PER_TICK })
  if (claimed.error) {
    if (!isMissing(claimed.error)) console.error('[csat] claim failed:', claimed.error.message)
    return out
  }
  const jobs = (claimed.data ?? []) as Job[]
  out.claimed = jobs.length

  for (const job of jobs) {
    try {
      const result = await handleJob(db, job, now, send)
      if (result === 'sent') out.sent += 1
      else out.skipped += 1
    } catch (err) {
      out.errors += 1
      console.error('[csat] job', job.id, 'failed:', err instanceof Error ? err.message : err)
      // Release the claim; csat_claim_jobs picks it up again (max 3 attempts).
      await db.from('csat_jobs').update({ claimed_at: null }).eq('id', job.id).is('processed_at', null)
    }
  }
  return out
}

async function finish(db: SupabaseClient, job: Job, result: string, now: Date) {
  const { error } = await db.from('csat_jobs').update({ processed_at: now.toISOString(), result }).eq('id', job.id)
  if (error) throw new Error(`cannot finish job: ${error.message}`)
}

async function handleJob(db: SupabaseClient, job: Job, now: Date, send: Send): Promise<'sent' | CsatSkipReason | 'duplicate'> {
  const [convRes, settingsRes] = await Promise.all([
    db
      .from('conversations')
      .select(
        'id, account_id, user_id, contact_id, status, service_count, resolution, category_id, team_id, priority, assigned_agent_id, channel, last_customer_message_at',
      )
      .eq('id', job.conversation_id)
      .eq('account_id', job.account_id)
      .maybeSingle(),
    db.from('csat_settings').select('*').eq('account_id', job.account_id).maybeSingle(),
  ])
  if (convRes.error) throw new Error(`conversation lookup: ${convRes.error.message}`)
  if (settingsRes.error) throw new Error(`settings lookup: ${settingsRes.error.message}`)
  const conv = convRes.data as Record<string, any> | null // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!conv) {
    await finish(db, job, 'missing', now)
    return 'reopened'
  }
  const settings = parseCsatSettings(settingsRes.data)

  const [contactRes, lastRes] = await Promise.all([
    db
      .from('contacts')
      .select('id, phone, opted_out_at, anonymized_at')
      .eq('id', conv.contact_id)
      .eq('account_id', job.account_id)
      .maybeSingle(),
    db
      .from('csat_responses')
      .select('sent_at')
      .eq('contact_id', conv.contact_id)
      .in('status', ['sent', 'answered'])
      .neq('conversation_id', job.conversation_id)
      .order('sent_at', { ascending: false })
      .limit(1),
  ])
  if (contactRes.error) throw new Error(`contact lookup: ${contactRes.error.message}`)
  if (lastRes.error) throw new Error(`cooldown lookup: ${lastRes.error.message}`)
  const contact = contactRes.data as { id: string; phone: string | null; opted_out_at: string | null; anonymized_at: string | null } | null
  if (!contact) {
    await finish(db, job, 'missing', now)
    return 'reopened'
  }

  const reason = csatSkipReason({
    settings,
    conversation: conv as never,
    jobServiceCount: job.service_count,
    contact,
    lastSentAt: ((lastRes.data ?? [])[0] as { sent_at: string } | undefined)?.sent_at ?? null,
    now,
  })

  const snapshot = {
    account_id: job.account_id,
    conversation_id: job.conversation_id,
    contact_id: conv.contact_id,
    team_id: conv.team_id ?? null,
    category_id: conv.category_id ?? null,
    priority: conv.priority ?? null,
    assigned_agent_id: conv.assigned_agent_id ?? null,
  }

  if (reason && CSAT_JOB_ONLY_REASONS.includes(reason)) {
    await finish(db, job, reason, now)
    return reason
  }
  if (reason) {
    const { error } = await db
      .from('csat_responses')
      .upsert({ ...snapshot, status: 'skipped', skip_reason: reason, sent_at: now.toISOString() }, { onConflict: 'conversation_id', ignoreDuplicates: true })
    if (error) throw new Error(`skip row: ${error.message}`)
    await finish(db, job, reason, now)
    return reason
  }

  // Reserve first: the unique row decides who sends, so a duplicate job or a
  // concurrent tick cannot survey the same conversation twice.
  const reserved = await db
    .from('csat_responses')
    .upsert({ ...snapshot, status: 'sent', sent_at: now.toISOString() }, { onConflict: 'conversation_id', ignoreDuplicates: true })
    .select('id')
  if (reserved.error) throw new Error(`reserve: ${reserved.error.message}`)
  const row = ((reserved.data ?? []) as { id: string }[])[0]
  if (!row) {
    await finish(db, job, 'duplicate', now)
    return 'duplicate'
  }

  let sent: { whatsapp_message_id: string }
  try {
    sent = await send({
      accountId: job.account_id,
      userId: conv.user_id,
      conversationId: job.conversation_id,
      contactId: conv.contact_id,
      text: surveyText(settings),
      origin: 'csat',
    })
  } catch (err) {
    await db.from('csat_responses').delete().eq('id', row.id).eq('status', 'sent').is('message_id', null)
    throw err
  }

  const upd = await db.from('csat_responses').update({ message_id: sent.whatsapp_message_id }).eq('id', row.id)
  if (upd.error) console.error('[csat] message id not stored:', upd.error.message)
  const ev = await db.from('conversation_events').insert({
    account_id: job.account_id,
    conversation_id: job.conversation_id,
    actor_user_id: null,
    event_type: 'csat_sent',
    payload: {},
  })
  if (ev.error) console.error('[csat] csat_sent event not stored:', ev.error.message)
  await finish(db, job, 'sent', now)
  return 'sent'
}
