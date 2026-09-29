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
    })
    const out = await buildContactExport(db, 'acc', 'c1', () => new Date('2026-09-29T00:00:00Z'))
    expect(out.ai_memories.map((m) => m.fact)).toEqual(['Prefere entrega à tarde', 'Trabalha com eventos'])
    expect(filters.ai_contact_memories).toEqual([
      ['account_id', 'acc'],
      ['contact_id', 'c1'],
    ])
    expect(out.warnings).toEqual([])
  })
})
