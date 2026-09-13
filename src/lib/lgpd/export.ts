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
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export const EXPORT_FORMAT_VERSION = 1

export interface ContactExport {
  format: 'semprecrm.contact'
  version: number
  exported_at: string
  account_id: string
  contact: Record<string, unknown> | null
  custom_fields: { field: string | null; type: string | null; value: unknown }[]
  tags: { id: string; name: string | null; color: string | null }[]
  consent: {
    status: unknown
    updated_at: unknown
    opted_out_at: unknown
    anonymized_at: unknown
  }
  conversations: (Record<string, unknown> & { messages: Record<string, unknown>[] })[]
  notes: Record<string, unknown>[]
  deals: Record<string, unknown>[]
  tasks: Record<string, unknown>[]
  /** Consent-related audit events (export / anonymisation) for this contact. */
  consent_events: Record<string, unknown>[]
  /** Tables that failed to load (RLS gap, missing migration) — never fatal. */
  warnings: string[]
}

export class ExportNotFoundError extends Error {
  constructor() {
    super('Contact not found')
    this.name = 'ExportNotFoundError'
  }
}

type Row = Record<string, unknown>

export async function buildContactExport(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  now: () => Date = () => new Date(),
): Promise<ContactExport> {
  const warnings: string[] = []

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (contactErr) throw new Error(contactErr.message)
  if (!contact) throw new ExportNotFoundError()
  const c = contact as Row

  async function load<T = Row>(
    label: string,
    run: () => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ): Promise<T[]> {
    try {
      const { data, error } = await run()
      if (error) {
        warnings.push(`${label}: ${error.message}`)
        return []
      }
      return (data ?? []) as T[]
    } catch (err) {
      warnings.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }

  const [customRows, tagRows, convRows, noteRows, dealRows, taskRows, auditRows] =
    await Promise.all([
      load('custom_fields', () =>
        db
          .from('contact_custom_values')
          .select('value, created_at, custom_field:custom_fields(field_name, field_type)')
          .eq('contact_id', contactId),
      ),
      load('tags', () =>
        db.from('contact_tags').select('tag:tags(id, name, color)').eq('contact_id', contactId),
      ),
      load('conversations', () =>
        db
          .from('conversations')
          .select('*')
          .eq('contact_id', contactId)
          .order('created_at', { ascending: true }),
      ),
      load('notes', () =>
        db
          .from('contact_notes')
          .select('id, note_text, user_id, created_at')
          .eq('contact_id', contactId)
          .order('created_at', { ascending: true }),
      ),
      load('deals', () =>
        db
          .from('deals')
          .select(
            'id, title, value, currency, status, notes, expected_close_date, pipeline_id, stage_id, conversation_id, loss_reason_id, lost_note, created_at, updated_at',
          )
          .eq('contact_id', contactId)
          .order('created_at', { ascending: true }),
      ),
      load('tasks', () =>
        db
          .from('tasks')
          .select(
            'id, title, description, priority, status_id, assignee_user_id, due_at, completed_at, conversation_id, deal_id, created_at, updated_at',
          )
          .eq('contact_id', contactId)
          .order('created_at', { ascending: true }),
      ),
      load('consent_events', () =>
        db
          .from('audit_log')
          .select('id, action, actor_name, metadata, created_at')
          .eq('account_id', accountId)
          .eq('entity_type', 'contact')
          .eq('entity_id', contactId)
          .order('created_at', { ascending: true }),
      ),
    ])

  const conversationIds = convRows.map((r) => r.id as string)
  let messageRows: Row[] = []
  if (conversationIds.length > 0) {
    messageRows = await load('messages', () =>
      db
        .from('messages')
        .select(
          'id, conversation_id, sender_type, sender_id, content_type, content_text, media_url, template_name, status, created_at',
        )
        .in('conversation_id', conversationIds)
        .order('created_at', { ascending: true }),
    )
  }
  const byConversation = new Map<string, Row[]>()
  for (const m of messageRows) {
    const key = m.conversation_id as string
    const list = byConversation.get(key) ?? []
    list.push(m)
    byConversation.set(key, list)
  }

  const one = <T>(v: T | T[] | null | undefined): T | null =>
    Array.isArray(v) ? (v[0] ?? null) : (v ?? null)

  return {
    format: 'semprecrm.contact',
    version: EXPORT_FORMAT_VERSION,
    exported_at: now().toISOString(),
    account_id: accountId,
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
    consent: {
      status: c.consent_status ?? 'unknown',
      updated_at: c.consent_updated_at ?? null,
      opted_out_at: c.opted_out_at ?? null,
      anonymized_at: c.anonymized_at ?? null,
    },
    conversations: convRows.map((conv) => ({
      ...conv,
      messages: byConversation.get(conv.id as string) ?? [],
    })),
    notes: noteRows,
    deals: dealRows,
    tasks: taskRows,
    consent_events: auditRows,
    warnings,
  }
}
