import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { buildContactExport } from './export'

// Minimal client: every query resolves to the rows registered for its
// table (filters recorded, not applied — the shape is what is tested).
function makeDb(tables: Record<string, Record<string, unknown>[]>) {
  const filters: Record<string, [string, unknown][]> = {}
  const db = {
    from(table: string) {
      filters[table] = []
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'order', 'in']) b[m] = () => b
      b.eq = (col: string, val: unknown) => {
        filters[table].push([col, val])
        return b
      }
      b.maybeSingle = async () => ({ data: tables[table]?.[0] ?? null, error: null })
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok)
      return b
    },
  }
  return { db: db as unknown as SupabaseClient, filters }
}

describe('buildContactExport — AI contact memory (064)', () => {
  it('includes every memory fact of the contact, scoped to the account', async () => {
    const { db, filters } = makeDb({
      contacts: [{ id: 'c1', name: 'Maria' }],
      ai_contact_memories: [
        { id: 'm1', fact: 'Prefere entrega à tarde', status: 'active', source: 'manual' },
        { id: 'm2', fact: 'Trabalha com eventos', status: 'proposed', source: 'ai' },
      ],
      ai_handoffs: [{ id: 'h1', reason: 'Pediu atendente', last_customer_words: 'quero falar com alguém' }],
    })
    const out = await buildContactExport(db, 'acc', 'c1', () => new Date('2026-09-29T00:00:00Z'))
    expect(out.ai_memories.map((m) => m.fact)).toEqual(['Prefere entrega à tarde', 'Trabalha com eventos'])
    expect(filters.ai_contact_memories).toEqual([
      ['account_id', 'acc'],
      ['contact_id', 'c1'],
    ])
    // Automatic-reply hand-overs (066) quote the customer too.
    expect(out.ai_handoffs).toEqual([{ id: 'h1', reason: 'Pediu atendente', last_customer_words: 'quero falar com alguém' }])
    expect(filters.ai_handoffs).toEqual([
      ['account_id', 'acc'],
      ['contact_id', 'c1'],
    ])
    expect(out.warnings).toEqual([])
  })
})

describe('buildContactExport — conversation events', () => {
  it('includes the activity log, transfer reasons included, under each conversation', async () => {
    const { db } = makeDb({
      contacts: [{ id: 'c1', name: 'Maria' }],
      conversations: [{ id: 'conv1' }],
      conversation_events: [
        { id: 'e1', conversation_id: 'conv1', event_type: 'assigned', payload: { reason: 'boleto vencido' } },
        { id: 'e2', conversation_id: 'other', event_type: 'assigned', payload: {} },
      ],
    })
    const out = await buildContactExport(db, 'acc', 'c1')
    expect(out.conversations[0].events).toEqual([
      { id: 'e1', conversation_id: 'conv1', event_type: 'assigned', payload: { reason: 'boleto vencido' } },
    ])
    expect(out.warnings).toEqual([])
  })
})

describe('buildContactExport — support triage (071)', () => {
  it('exports the triage fields of each conversation (full row)', async () => {
    const row = {
      id: 'conv1',
      subject: 'Boleto da Maria vencido',
      sentiment: 'negative',
      priority: 'high',
      category_id: 'cat1',
      triage_source: 'ai',
      resolution: 'resolved',
    }
    const { db } = makeDb({ contacts: [{ id: 'c1', name: 'Maria' }], conversations: [row] })
    const out = await buildContactExport(db, 'acc', 'c1')
    expect(out.conversations[0]).toMatchObject(row)
  })
})
