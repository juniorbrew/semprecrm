// ============================================================
// LGPD data export (spec §4) — gathers everything the account holds
// about one contact into a single JSON document. Pure orchestration
// over an injected client so the route stays thin and the shape is
// unit-testable.
//
// The route passes the caller's RLS-scoped client: an admin can read
// every table involved for their own account, and using it (rather
// than the service role) means the export can never leak a row the
// caller could not have seen in the app.
//
// Never silently truncated: every list is read in pages (`.range()`,
// PostgREST caps a response at max_rows = 1000) until a short page, id
// lists are chunked (≤200 per `.in()`), and `manifest` records the row
// count of every section plus whether it loaded completely. A section
// that failed is listed in `warnings` and flagged `complete: false`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { chunk, ID_CHUNK, PAGE_SIZE } from './anonymize'

export const EXPORT_FORMAT_VERSION = 2

type Row = Record<string, unknown>

export interface ManifestEntry {
  count: number
  complete: boolean
}

export interface ContactExport {
  format: 'semprecrm.contact'
  version: number
  exported_at: string
  account_id: string
  /** Row count per section and whether it loaded completely. */
  manifest: Record<string, ManifestEntry>
  contact: Row | null
  custom_fields: { field: string | null; type: string | null; value: unknown }[]
  tags: { id: string; name: string | null; color: string | null }[]
  /** Companies the contact is linked to. */
  companies: { id: string | null; name: string | null; is_primary: unknown }[]
  consent: {
    status: unknown
    updated_at: unknown
    opted_out_at: unknown
    anonymized_at: unknown
  }
  conversations: (Row & {
    messages: Row[]
    /** Activity log (assignments incl. transfer reasons, status changes, labels). */
    events: Row[]
  })[]
  notes: Row[]
  deals: Row[]
  /** Tasks of the contact or of its conversations. */
  tasks: Row[]
  task_comments: Row[]
  calendar_events: Row[]
  /** Flow (chatbot) runs with the variables the customer answered. */
  flow_runs: Row[]
  /** Lead-capture submissions (form / webhook payloads) that created or matched the contact. */
  lead_events: Row[]
  /** "Memória do contato" facts (AI, migration 064), every status. */
  ai_memories: Row[]
  /** Automatic-reply hand-overs (migration 066): reason, what the customer wanted, their last words. */
  ai_handoffs: Row[]
  /** Satisfaction survey (migration 074): score and the customer's free-text comment. */
  csat: Row[]
  /** Consent-related audit events (export / anonymisation) for this contact. */
  consent_events: Row[]
  /** Sections that failed to load (RLS gap, missing migration). */
  warnings: string[]
}

export class ExportNotFoundError extends Error {
  constructor() {
    super('Contact not found')
    this.name = 'ExportNotFoundError'
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Query = any

export async function buildContactExport(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  now: () => Date = () => new Date(),
): Promise<ContactExport> {
  const warnings: string[] = []
  const manifest: Record<string, ManifestEntry> = {}

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (contactErr) throw new Error(contactErr.message)
  if (!contact) throw new ExportNotFoundError()
  const c = contact as Row

  /** Every page of `build()` (ordered by created_at, id) until a short page. */
  async function pages(build: () => Query): Promise<Row[]> {
    const out: Row[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await build().range(from, from + PAGE_SIZE - 1)
      if (error) throw new Error(error.message)
      const rows = (data ?? []) as Row[]
      out.push(...rows)
      if (rows.length < PAGE_SIZE) return out
    }
  }

  /** One section: all pages, every id chunk; recorded in the manifest. */
  async function load(label: string, build: (ids: string[]) => Query, ids?: string[]): Promise<Row[]> {
    const out: Row[] = []
    try {
      if (ids === undefined) out.push(...(await pages(() => build([]))))
      else for (const part of chunk(ids, ID_CHUNK)) out.push(...(await pages(() => build(part))))
      manifest[label] = { count: out.length, complete: true }
    } catch (err) {
      warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
      manifest[label] = { count: out.length, complete: false }
    }
    return out
  }

  const ordered = (q: Query, col = 'created_at') => q.order(col, { ascending: true }).order('id', { ascending: true })
  const byContact = (table: string, cols: string, scoped = true) => {
    const q = db.from(table).select(cols).eq('contact_id', contactId)
    return scoped ? q.eq('account_id', accountId) : q
  }

  const [customRows, tagRows, companyRows, convRows, noteRows, dealRows, taskRowsByContact, auditRows, memoryRows, handoffRows, csatRows, calendarByContact, flowRows, leadRows] =
    await Promise.all([
      load('custom_fields', () =>
        db
          .from('contact_custom_values')
          .select('id, value, created_at, custom_field:custom_fields(field_name, field_type)')
          .eq('contact_id', contactId)
          .order('id', { ascending: true }),
      ),
      load('tags', () =>
        db.from('contact_tags').select('tag_id, tag:tags(id, name, color)').eq('contact_id', contactId).order('tag_id', { ascending: true }),
      ),
      load('companies', () =>
        ordered(byContact('contact_companies', 'company_id, is_primary, created_at, company:companies(id, name)'), 'company_id'),
      ),
      load('conversations', () => ordered(byContact('conversations', '*'))),
      load('notes', () => ordered(byContact('contact_notes', 'id, note_text, user_id, created_at', false))),
      load('deals', () =>
        ordered(
          byContact(
            'deals',
            'id, title, value, currency, status, notes, expected_close_date, pipeline_id, stage_id, conversation_id, loss_reason_id, lost_note, created_at, updated_at',
          ),
        ),
      ),
      load('tasks', () =>
        ordered(
          byContact(
            'tasks',
            'id, title, description, priority, status_id, assignee_user_id, due_at, completed_at, conversation_id, deal_id, created_at, updated_at',
          ),
        ),
      ),
      load('consent_events', () =>
        ordered(
          db
            .from('audit_log')
            .select('id, action, actor_name, metadata, created_at')
            .eq('account_id', accountId)
            .eq('entity_type', 'contact')
            .eq('entity_id', contactId),
        ),
      ),
      load('ai_memories', () => ordered(byContact('ai_contact_memories', 'id, fact, status, source, conversation_id, created_at, updated_at'))),
      load('ai_handoffs', () =>
        ordered(byContact('ai_handoffs', 'id, conversation_id, reason, customer_wants, last_customer_words, notified, created_at')),
      ),
      load('csat', () => ordered(byContact('csat_responses', 'id, conversation_id, status, score, comment, sent_at, answered_at'), 'sent_at')),
      load('calendar_events', () =>
        ordered(
          byContact('calendar_events', 'id, title, description, location, starts_at, ends_at, all_day, status, conversation_id, deal_id, task_id, source, created_at'),
          'starts_at',
        ),
      ),
      load('flow_runs', () =>
        ordered(byContact('flow_runs', 'id, flow_id, conversation_id, status, vars, started_at, ended_at, end_reason'), 'started_at'),
      ),
      load('lead_events', () => ordered(byContact('lead_source_events', 'id, source_id, status, deal_id, payload, created_at'))),
    ])

  const conversationIds = convRows.map((r) => r.id as string)
  const [messageRows, eventRows, convTaskRows] = await Promise.all([
    load(
      'messages',
      (ids) =>
        ordered(
          db
            .from('messages')
            .select('id, conversation_id, sender_type, sender_id, content_type, content_text, media_url, template_name, status, created_at')
            .in('conversation_id', ids),
        ),
      conversationIds,
    ),
    load(
      'conversation_events',
      (ids) =>
        ordered(
          db
            .from('conversation_events')
            .select('id, conversation_id, event_type, actor_user_id, payload, created_at')
            .in('conversation_id', ids),
        ),
      conversationIds,
    ),
    load(
      'tasks_by_conversation',
      (ids) =>
        ordered(
          db
            .from('tasks')
            .select('id, title, description, priority, status_id, assignee_user_id, due_at, completed_at, conversation_id, deal_id, created_at, updated_at')
            .eq('account_id', accountId)
            .in('conversation_id', ids),
        ),
      conversationIds,
    ),
  ])
  delete manifest.tasks_by_conversation
  const seenTasks = new Set(taskRowsByContact.map((t) => t.id))
  const taskRows = [...taskRowsByContact, ...convTaskRows.filter((t) => !seenTasks.has(t.id))]
  manifest.tasks = { count: taskRows.length, complete: manifest.tasks.complete && !warnings.some((w) => w.startsWith('tasks_by_conversation')) }

  const commentRows = await load(
    'task_comments',
    (ids) => ordered(db.from('task_comments').select('id, task_id, user_id, body, created_at').in('task_id', ids)),
    taskRows.map((t) => t.id as string),
  )

  const groupBy = (rows: Row[]) => {
    const m = new Map<string, Row[]>()
    for (const r of rows) {
      const key = r.conversation_id as string
      const list = m.get(key) ?? []
      list.push(r)
      m.set(key, list)
    }
    return m
  }
  const messagesByConversation = groupBy(messageRows)
  const eventsByConversation = groupBy(eventRows)

  const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

  return {
    format: 'semprecrm.contact',
    version: EXPORT_FORMAT_VERSION,
    exported_at: now().toISOString(),
    account_id: accountId,
    manifest,
    contact: c,
    custom_fields: customRows.map((r) => {
      const f = one(r.custom_field as Row | Row[] | null)
      return {
        field: (f?.field_name as string | undefined) ?? null,
        type: (f?.field_type as string | undefined) ?? null,
        value: r.value,
      }
    }),
    tags: tagRows
      .map((r) => one(r.tag as Row | Row[] | null))
      .filter((t): t is Row => !!t)
      .map((t) => ({
        id: t.id as string,
        name: (t.name as string | undefined) ?? null,
        color: (t.color as string | undefined) ?? null,
      })),
    companies: companyRows.map((r) => {
      const co = one(r.company as Row | Row[] | null)
      return {
        id: (co?.id as string | undefined) ?? (r.company_id as string | undefined) ?? null,
        name: (co?.name as string | undefined) ?? null,
        is_primary: r.is_primary ?? false,
      }
    }),
    consent: {
      status: c.consent_status ?? 'unknown',
      updated_at: c.consent_updated_at ?? null,
      opted_out_at: c.opted_out_at ?? null,
      anonymized_at: c.anonymized_at ?? null,
    },
    conversations: convRows.map((conv) => ({
      ...conv,
      messages: messagesByConversation.get(conv.id as string) ?? [],
      events: eventsByConversation.get(conv.id as string) ?? [],
    })),
    notes: noteRows,
    deals: dealRows,
    tasks: taskRows,
    task_comments: commentRows,
    calendar_events: calendarByContact,
    flow_runs: flowRows,
    lead_events: leadRows,
    ai_memories: memoryRows,
    ai_handoffs: handoffRows,
    csat: csatRows,
    consent_events: auditRows,
    warnings,
  }
}
