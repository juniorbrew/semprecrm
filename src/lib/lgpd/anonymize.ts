// ============================================================
// LGPD anonymisation (migrations 035, 077) and the personal-data scrub
// shared with the contact delete — pure orchestration over an injected
// Supabase client so the sequence is unit-testable.
//
// anonymizeContact — irreversible, in this order:
//   0. If the contact had opted out, its number goes to the suppression
//      list (HMAC only, lib/lgpd/suppression.ts) so the opt-out survives.
//   1. MARK first, in one update: anonymized_at + opted_out_at, name →
//      "Contato anonimizado", phone → `anon-<8 hex>`, email / company /
//      avatar_url → null. Everything that writes to a contact already
//      respects anonymized_at (inbound, AI, automations, send, avatars),
//      and the phone no longer matches the customer's number, so no
//      in-flight writer can re-populate the row while the scrub runs.
//   2. SCRUB idempotently, in pages (≤200 ids per `.in()`, ≤1000 rows
//      per read — PostgREST max_rows), every table listed in
//      SCRUBBED_TABLES. Chat-media objects are removed from Storage
//      first and a message's media_url is nulled only once its object
//      is gone; a failed removal keeps the reference and is reported.
//   3. COMPLETE: anonymization_completed_at is stamped only when every
//      step succeeded. Otherwise the result carries `completed: false`
//      and the warnings; an admin re-runs the same route, which resumes
//      (a marked-but-incomplete contact is not "already anonymized").
//
// Conversations, deals, tasks and calendar events keep their rows and
// their link to the contact (statistics / history); their free text is
// replaced with neutral placeholders.
//
// Known limitation: calendar events synced to Google / Microsoft keep
// their remote copy until the next sync pushes the neutral title (the
// local text is cleared here).
//
// scrubContactData(mode 'delete') is the same scrub minus what the
// contact delete cascades anyway (conversations, notes, memories, …):
// media objects and the ON DELETE SET NULL tables (deals, tasks,
// calendar, flows, lead events, broadcasts, automation logs).
//
// Callers pass the service-role client: the storage delete and the
// cross-table updates cross RLS boundaries a member session cannot.
// ============================================================

import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { CONTACT_AVATARS_BUCKET, contactAvatarPath } from '@/lib/whatsapp/contact-avatar'
import { recordSuppression } from './suppression'

export const ANONYMIZED_NAME = 'Contato anonimizado'
export const REMOVED_CONTENT = '[conteúdo removido]'
export const ANONYMIZED_DEAL_TITLE = 'Negócio anonimizado'
export const ANONYMIZED_TASK_TITLE = 'Tarefa anonimizada'
export const ANONYMIZED_EVENT_TITLE = 'Compromisso anonimizado'
export const CHAT_MEDIA_BUCKET = 'chat-media'

/** Max ids per `.in()` filter (URL length). */
export const ID_CHUNK = 200
/** Rows per read (PostgREST max_rows = 1000). */
export const PAGE_SIZE = 1000
/** Objects per Storage remove call. */
const STORAGE_CHUNK = 100

/**
 * Every table the scrub writes, with what happens to it. The coverage
 * test asserts each one is actually touched. `cascade` steps are skipped
 * on a hard delete (the rows go with the contact).
 */
export const SCRUBBED_TABLES = {
  messages: 'content_text / error_details replaced, media_url nulled after the object is removed',
  conversations: 'last_message_text replaced, subject / sentiment nulled (cascade)',
  conversation_events: 'ai_handoff / deal_stage_changed payload emptied, free-text keys dropped (cascade)',
  contact_notes: 'deleted (cascade)',
  contact_custom_values: 'deleted (cascade)',
  contact_companies: 'links deleted (cascade)',
  ai_contact_memories: 'deleted (cascade)',
  ai_handoffs: 'deleted (cascade)',
  ai_reply_jobs: 'deleted (cascade)',
  csat_responses: 'comment nulled (cascade)',
  automation_event_queue: 'context emptied (cascade)',
  deals: 'title neutral, notes / lost_note nulled',
  tasks: 'title neutral, description nulled',
  task_comments: 'body replaced',
  calendar_events: 'title neutral, description / location nulled',
  flow_runs: 'vars emptied',
  flow_run_events: 'payload emptied',
  lead_source_events: 'payload emptied',
  broadcast_recipients: 'template_params nulled',
  automation_pending_executions: 'context emptied, pending ones cancelled',
  automation_logs: 'error_message nulled',
  audit_log: 'contact_name / phone / email dropped from the contact’s rows',
} as const
export type ScrubbedTable = keyof typeof SCRUBBED_TABLES

/** Payload keys that may carry free text about the customer. */
const PII_PAYLOAD_KEYS = [
  'reason',
  'note',
  'text',
  'comment',
  'title',
  'deal_title',
  'contact_name',
  'customer_wants',
  'last_customer_words',
  'message',
  'summary',
]
const AUDIT_PII_KEYS = ['contact_name', 'phone', 'email', 'name']

export function generateAnonymousPhone(
  randomHex: () => string = () => randomBytes(4).toString('hex'),
): string {
  return `anon-${randomHex()}`
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Object path inside the `chat-media` bucket for a URL produced by
 * Supabase Storage (`…/storage/v1/object/public/chat-media/<path>`, or
 * the sign / authenticated variants), or `null` when the URL is not
 * ours (Meta CDN links, other buckets).
 */
export function extractChatMediaPath(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null
  const m = url.match(
    new RegExp(`/object/(?:public|sign|authenticated)/${CHAT_MEDIA_BUCKET}/([^?#]+)`),
  )
  if (!m || !m[1]) return null
  return safeDecode(m[1])
}

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Query = any
type Res = { data?: unknown; error: { message: string; code?: string } | null; count?: number | null }

function must<T extends Res>(res: T, label: string): T {
  if (res.error) throw new Error(`${label}: ${res.error.message}`)
  return res
}

/**
 * Keyset pagination by `id` (stable while rows are being updated):
 * calls `onPage` with every page of ≤ PAGE_SIZE rows.
 */
export async function eachPage<T extends { id: string }>(
  build: () => Query,
  onPage: (rows: T[]) => Promise<void>,
  label: string,
): Promise<number> {
  let last: string | null = null
  let total = 0
  for (;;) {
    let q = build().order('id', { ascending: true }).limit(PAGE_SIZE)
    if (last) q = q.gt('id', last)
    const { data } = must((await q) as Res, label)
    const rows = (data ?? []) as T[]
    total += rows.length
    if (rows.length > 0) await onPage(rows)
    if (rows.length < PAGE_SIZE) return total
    last = rows[rows.length - 1].id
  }
}

function stripKeys(
  payload: Record<string, unknown> | null,
  keys: string[],
): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null
  if (!keys.some((k) => k in payload)) return null
  const next = { ...payload }
  for (const k of keys) delete next[k]
  return next
}

export interface ScrubReport {
  conversations: number
  /** Rows written / deleted per table. */
  counts: Partial<Record<ScrubbedTable | 'chat_media' | 'avatar', number>>
  mediaDeleted: number
  /** Every step that failed; empty means the scrub is complete. */
  warnings: string[]
}

export interface ScrubOptions {
  mode: 'anonymize' | 'delete'
}

/**
 * Remove the contact's personal data from every related table. Never
 * throws: each failed step lands in `warnings` and the rest still run
 * (every step is idempotent, so a re-run finishes the job).
 */
export async function scrubContactData(
  admin: SupabaseClient,
  accountId: string,
  contactId: string,
  opts: ScrubOptions,
): Promise<ScrubReport> {
  const anonymize = opts.mode === 'anonymize'
  const warnings: string[] = []
  const counts: ScrubReport['counts'] = {}
  let mediaDeleted = 0
  const add = (key: keyof ScrubReport['counts'], n: number | null | undefined) => {
    counts[key] = (counts[key] ?? 0) + (n ?? 0)
  }
  async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn()
      return true
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : `${name}: ${String(err)}`)
      return false
    }
  }
  const byContact = (table: string, cols = 'id') =>
    admin.from(table).select(cols).eq('contact_id', contactId).eq('account_id', accountId)

  // Conversations of the contact (all pages).
  const conversationIds: string[] = []
  const conversationsOk = await step('conversations', async () => {
    await eachPage<{ id: string }>(
      () => byContact('conversations'),
      async (rows) => {
        conversationIds.push(...rows.map((r) => r.id))
      },
      'conversations lookup',
    )
  })
  const convChunks = chunk(conversationIds, ID_CHUNK)

  // Messages: remove media objects, then scrub the rows.
  if (conversationsOk) {
    await step('messages', async () => {
      for (const ids of convChunks) {
        await eachPage<{ id: string; media_url: string | null }>(
          () => admin.from('messages').select('id, media_url').in('conversation_id', ids),
          async (rows) => {
            const paths = [...new Set(rows.map((r) => extractChatMediaPath(r.media_url)).filter((p): p is string => !!p))]
            const failed = new Set<string>()
            for (const batch of chunk(paths, STORAGE_CHUNK)) {
              const { data, error } = await admin.storage.from(CHAT_MEDIA_BUCKET).remove(batch)
              if (error) {
                batch.forEach((p) => failed.add(p))
                warnings.push(`chat-media remove: ${error.message} (${batch.length} objects kept)`)
              } else {
                mediaDeleted += Array.isArray(data) ? data.length : batch.length
              }
            }
            const kept = rows.filter((r) => {
              const p = extractChatMediaPath(r.media_url)
              return p !== null && failed.has(p)
            })
            const keptIds = new Set(kept.map((r) => r.id))
            const done = rows.filter((r) => !keptIds.has(r.id)).map((r) => r.id)
            for (const part of chunk(done, ID_CHUNK)) {
              must(
                await admin
                  .from('messages')
                  .update({ content_text: REMOVED_CONTENT, media_url: null, error_details: null })
                  .in('id', part),
                'messages scrub',
              )
              add('messages', part.length)
            }
            for (const part of chunk([...keptIds], ID_CHUNK)) {
              must(
                await admin
                  .from('messages')
                  .update({ content_text: REMOVED_CONTENT, error_details: null })
                  .in('id', part),
                'messages scrub (media kept)',
              )
              add('messages', part.length)
            }
          },
          'messages lookup',
        )
      }
    })
  }

  if (anonymize && conversationsOk) {
    await step('conversations', async () => {
      for (const ids of convChunks) {
        // Support triage (071): the free-text subject may name the
        // customer; the sentiment is a judgement about a person.
        must(
          await admin.from('conversations').update({ subject: null, sentiment: null }).in('id', ids),
          'conversations triage',
        )
        // The conversation list preview also carries the last body.
        must(
          await admin
            .from('conversations')
            .update({ last_message_text: REMOVED_CONTENT })
            .in('id', ids)
            .not('last_message_text', 'is', null),
          'conversations preview',
        )
        add('conversations', ids.length)
      }
    })

    await step('conversation_events', async () => {
      for (const ids of convChunks) {
        // AI hand-over pills (066) carry the reason; deal-move pills (070)
        // the deal title — both emptied.
        for (const type of ['ai_handoff', 'deal_stage_changed']) {
          must(
            await admin
              .from('conversation_events')
              .update({ payload: {} })
              .in('conversation_id', ids)
              .eq('event_type', type),
            `${type} events`,
          )
        }
        // Any other pill (transfer reason, …): drop only the free-text keys.
        await eachPage<{ id: string; event_type: string; payload: Record<string, unknown> | null }>(
          () =>
            admin
              .from('conversation_events')
              .select('id, event_type, payload')
              .in('conversation_id', ids),
          async (rows) => {
            for (const row of rows) {
              const next = stripKeys(row.payload, PII_PAYLOAD_KEYS)
              if (!next) continue
              must(
                await admin.from('conversation_events').update({ payload: next }).eq('id', row.id),
                `event ${row.id}`,
              )
              add('conversation_events', 1)
            }
          },
          'conversation_events lookup',
        )
      }
    })
  }

  // Tasks of the contact or of its conversations; their comments.
  await step('tasks', async () => {
    const taskIds = new Set<string>()
    const collect = async (rows: { id: string }[]) => {
      rows.forEach((r) => taskIds.add(r.id))
    }
    await eachPage(() => byContact('tasks'), collect, 'tasks lookup')
    if (conversationsOk) {
      for (const ids of convChunks) {
        await eachPage(
          () => admin.from('tasks').select('id').eq('account_id', accountId).in('conversation_id', ids),
          collect,
          'tasks lookup',
        )
      }
    }
    for (const part of chunk([...taskIds], ID_CHUNK)) {
      must(
        await admin.from('tasks').update({ title: ANONYMIZED_TASK_TITLE, description: null }).in('id', part),
        'tasks scrub',
      )
      add('tasks', part.length)
      const res = must(
        await admin
          .from('task_comments')
          .update({ body: REMOVED_CONTENT }, { count: 'exact' })
          .in('task_id', part),
        'task_comments scrub',
      )
      add('task_comments', res.count)
    }
  })

  // Calendar events of the contact or of its conversations.
  await step('calendar_events', async () => {
    const payload = { title: ANONYMIZED_EVENT_TITLE, description: null, location: null }
    const res = must(
      await admin
        .from('calendar_events')
        .update(payload, { count: 'exact' })
        .eq('contact_id', contactId)
        .eq('account_id', accountId),
      'calendar_events scrub',
    )
    add('calendar_events', res.count)
    if (conversationsOk) {
      for (const ids of convChunks) {
        const r = must(
          await admin
            .from('calendar_events')
            .update(payload, { count: 'exact' })
            .eq('account_id', accountId)
            .in('conversation_id', ids),
          'calendar_events scrub',
        )
        add('calendar_events', r.count)
      }
    }
  })

  // Deals (lead capture titles them with the person's name / phone).
  await step('deals', async () => {
    const res = must(
      await admin
        .from('deals')
        .update({ title: ANONYMIZED_DEAL_TITLE, notes: null, lost_note: null }, { count: 'exact' })
        .eq('contact_id', contactId)
        .eq('account_id', accountId),
      'deals scrub',
    )
    add('deals', res.count)
  })

  // Flow runs: collected variables (answers typed by the customer) and
  // the per-run event log.
  await step('flow_runs', async () => {
    await eachPage<{ id: string }>(
      () => byContact('flow_runs'),
      async (rows) => {
        for (const part of chunk(rows.map((r) => r.id), ID_CHUNK)) {
          must(await admin.from('flow_runs').update({ vars: {} }).in('id', part), 'flow_runs scrub')
          add('flow_runs', part.length)
          const res = must(
            await admin.from('flow_run_events').update({ payload: {} }, { count: 'exact' }).in('flow_run_id', part),
            'flow_run_events scrub',
          )
          add('flow_run_events', res.count)
        }
      },
      'flow_runs lookup',
    )
  })

  await step('lead_source_events', async () => {
    const res = must(
      await admin
        .from('lead_source_events')
        .update({ payload: {} }, { count: 'exact' })
        .eq('contact_id', contactId)
        .eq('account_id', accountId),
      'lead_source_events scrub',
    )
    add('lead_source_events', res.count)
  })

  // broadcast_recipients has no account_id; the contact id is account-scoped.
  await step('broadcast_recipients', async () => {
    const res = must(
      await admin
        .from('broadcast_recipients')
        .update({ template_params: null }, { count: 'exact' })
        .eq('contact_id', contactId),
      'broadcast_recipients scrub',
    )
    add('broadcast_recipients', res.count)
  })

  await step('automation_pending_executions', async () => {
    must(
      await admin
        .from('automation_pending_executions')
        .update({ status: 'cancelled' })
        .eq('contact_id', contactId)
        .eq('account_id', accountId)
        .eq('status', 'pending'),
      'automation_pending_executions cancel',
    )
    const res = must(
      await admin
        .from('automation_pending_executions')
        .update({ context: {} }, { count: 'exact' })
        .eq('contact_id', contactId)
        .eq('account_id', accountId),
      'automation_pending_executions scrub',
    )
    add('automation_pending_executions', res.count)
  })

  await step('automation_logs', async () => {
    const res = must(
      await admin
        .from('automation_logs')
        .update({ error_message: null }, { count: 'exact' })
        .eq('contact_id', contactId)
        .eq('account_id', accountId)
        .not('error_message', 'is', null),
      'automation_logs scrub',
    )
    add('automation_logs', res.count)
  })

  // Audit trail: rows stay, the name / phone snapshot goes.
  await step('audit_log', async () => {
    await eachPage<{ id: string; metadata: Record<string, unknown> | null }>(
      () =>
        admin
          .from('audit_log')
          .select('id, metadata')
          .eq('account_id', accountId)
          .eq('entity_type', 'contact')
          .eq('entity_id', contactId),
      async (rows) => {
        for (const row of rows) {
          const next = stripKeys(row.metadata, AUDIT_PII_KEYS)
          if (!next) continue
          must(await admin.from('audit_log').update({ metadata: next }).eq('id', row.id), `audit ${row.id}`)
          add('audit_log', 1)
        }
      },
      'audit_log lookup',
    )
  })

  if (anonymize) {
    for (const table of [
      'contact_notes',
      'contact_custom_values',
      'contact_companies',
      'ai_contact_memories',
      'ai_handoffs',
      'ai_reply_jobs',
    ] as const) {
      await step(table, async () => {
        let q = admin.from(table).delete({ count: 'exact' }).eq('contact_id', contactId)
        // contact_custom_values has no account_id; the contact id is account-scoped.
        if (table !== 'contact_custom_values') q = q.eq('account_id', accountId)
        const res = must(await q, `${table} delete`)
        add(table, res.count)
      })
    }

    // Satisfaction survey (074): the score stays, the comment goes.
    await step('csat_responses', async () => {
      const res = must(
        await admin
          .from('csat_responses')
          .update({ comment: null }, { count: 'exact' })
          .eq('contact_id', contactId)
          .eq('account_id', accountId),
        'csat comments',
      )
      add('csat_responses', res.count)
    })

    await step('automation_event_queue', async () => {
      const res = must(
        await admin
          .from('automation_event_queue')
          .update({ context: {} }, { count: 'exact' })
          .eq('contact_id', contactId)
          .eq('account_id', accountId),
        'automation_event_queue scrub',
      )
      add('automation_event_queue', res.count)
    })
  }

  // Stored profile photo (QR channel, migration 055). Removing a missing
  // object is a no-op for Storage, so this runs for every contact.
  await step('avatar', async () => {
    const { error } = await admin.storage
      .from(CONTACT_AVATARS_BUCKET)
      .remove([contactAvatarPath(accountId, contactId)])
    if (error) throw new Error(`avatar remove: ${error.message}`)
    add('avatar', 1)
  })

  add('chat_media', mediaDeleted)
  return { conversations: conversationIds.length, counts, mediaDeleted, warnings }
}

export interface AnonymizeResult {
  contactId: string
  anonymizedAt: string
  /** True when this call resumed a previously incomplete anonymisation. */
  resumed: boolean
  /** True when every step succeeded (anonymization_completed_at set). */
  completed: boolean
  conversations: number
  messagesScrubbed: number
  mediaDeleted: number
  notesDeleted: number
  customValuesDeleted: number
  memoriesDeleted: number
  counts: ScrubReport['counts']
  /** Steps that failed — the anonymisation must be re-run. */
  warnings: string[]
}

export class AnonymizeError extends Error {
  readonly code: 'not_found' | 'already_anonymized' | 'db_error'
  constructor(code: AnonymizeError['code'], message: string) {
    super(message)
    this.name = 'AnonymizeError'
    this.code = code
  }
}

export interface AnonymizeOptions {
  now?: () => Date
  randomHex?: () => string
  /** Suppression-list secret (defaults to ENCRYPTION_KEY). */
  secret?: string
}

/**
 * Anonymise `contactId` inside `accountId` (see header). Throws
 * `AnonymizeError` for a missing / fully anonymised contact or when the
 * contact row itself cannot be marked; scrub failures come back as
 * `completed: false` + `warnings`.
 */
export async function anonymizeContact(
  admin: SupabaseClient,
  accountId: string,
  contactId: string,
  opts: AnonymizeOptions = {},
): Promise<AnonymizeResult> {
  const now = (opts.now ?? (() => new Date()))().toISOString()

  const { data: contact, error: contactErr } = await admin
    .from('contacts')
    .select('id, account_id, phone, opted_out_at, anonymized_at, anonymization_completed_at')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (contactErr) throw new AnonymizeError('db_error', contactErr.message)
  if (!contact) throw new AnonymizeError('not_found', 'Contact not found')
  const row = contact as {
    phone: string | null
    opted_out_at: string | null
    anonymized_at: string | null
    anonymization_completed_at: string | null
  }
  if (row.anonymization_completed_at) {
    throw new AnonymizeError('already_anonymized', 'Contact is already anonymized')
  }

  const resumed = !!row.anonymized_at
  const anonymizedAt = row.anonymized_at ?? now
  if (!resumed) {
    // 0. Keep the opt-out across the anonymisation — before the phone goes.
    if (row.opted_out_at) {
      try {
        await recordSuppression(admin, accountId, row.phone, opts.secret)
      } catch (err) {
        throw new AnonymizeError('db_error', err instanceof Error ? err.message : String(err))
      }
    }

    // 1. Mark. The per-account UNIQUE on `phone_normalized` could in
    //    theory collide on the digit projection of the random hex, so a
    //    23505 gets a fresh value and a retry.
    let updErr: { code?: string; message: string } | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await admin
        .from('contacts')
        .update({
          name: ANONYMIZED_NAME,
          phone: generateAnonymousPhone(opts.randomHex),
          email: null,
          company: null,
          avatar_url: null,
          opted_out_at: row.opted_out_at ?? now,
          anonymized_at: now,
          updated_at: now,
        })
        .eq('id', contactId)
        .eq('account_id', accountId)
        .is('anonymized_at', null)
      updErr = res.error
      if (!updErr || updErr.code !== '23505') break
    }
    if (updErr) throw new AnonymizeError('db_error', updErr.message)
  }

  // 2. Scrub.
  const report = await scrubContactData(admin, accountId, contactId, { mode: 'anonymize' })
  const warnings = [...report.warnings]

  // 3. Complete — only when nothing failed.
  let completed = false
  if (warnings.length === 0) {
    const { error } = await admin
      .from('contacts')
      .update({ anonymization_completed_at: now, updated_at: now })
      .eq('id', contactId)
      .eq('account_id', accountId)
    if (error) warnings.push(`contacts complete: ${error.message}`)
    else completed = true
  }

  return {
    contactId,
    anonymizedAt,
    resumed,
    completed,
    conversations: report.conversations,
    messagesScrubbed: report.counts.messages ?? 0,
    mediaDeleted: report.mediaDeleted,
    notesDeleted: report.counts.contact_notes ?? 0,
    customValuesDeleted: report.counts.contact_custom_values ?? 0,
    memoriesDeleted: report.counts.ai_contact_memories ?? 0,
    counts: report.counts,
    warnings,
  }
}

export class DeleteContactError extends Error {
  readonly code: 'not_found' | 'scrub_incomplete' | 'db_error'
  readonly warnings: string[]
  constructor(code: DeleteContactError['code'], message: string, warnings: string[] = []) {
    super(message)
    this.name = 'DeleteContactError'
    this.code = code
    this.warnings = warnings
  }
}

/**
 * Hard delete: scrub (media objects + SET NULL tables), detach deals from
 * the conversations about to cascade away (deals.conversation_id has no
 * ON DELETE action and would block the delete), then delete the row.
 * Refuses to delete when the scrub was incomplete — a removed contact
 * would leave its public media behind with no way to find it again.
 */
export async function deleteContact(
  admin: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<ScrubReport> {
  const { data: contact, error } = await admin
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new DeleteContactError('db_error', error.message)
  if (!contact) throw new DeleteContactError('not_found', 'Contact not found')

  const report = await scrubContactData(admin, accountId, contactId, { mode: 'delete' })
  if (report.warnings.length > 0) {
    throw new DeleteContactError('scrub_incomplete', 'Personal data scrub incomplete', report.warnings)
  }

  try {
    await eachPage<{ id: string }>(
      () => admin.from('conversations').select('id').eq('contact_id', contactId).eq('account_id', accountId),
      async (rows) => {
        for (const part of chunk(rows.map((r) => r.id), ID_CHUNK)) {
          must(
            await admin.from('deals').update({ conversation_id: null }).eq('account_id', accountId).in('conversation_id', part),
            'deals detach',
          )
        }
      },
      'conversations lookup',
    )
  } catch (err) {
    throw new DeleteContactError('db_error', err instanceof Error ? err.message : String(err))
  }

  const { error: delErr } = await admin
    .from('contacts')
    .delete()
    .eq('id', contactId)
    .eq('account_id', accountId)
  if (delErr) throw new DeleteContactError('db_error', delErr.message)
  return report
}
