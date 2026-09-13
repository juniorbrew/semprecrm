import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createCustomField,
  isDuplicateFieldName,
  normalizeFieldName,
  setContactCustomValue,
} from './custom-fields'

const fields = [
  { id: 'a', field_name: 'CEP' },
  { id: 'b', field_name: 'Origem do lead' },
]

describe('normalizeFieldName', () => {
  it('trims and collapses inner whitespace', () => {
    expect(normalizeFieldName('  Origem   do  lead ')).toBe('Origem do lead')
    expect(normalizeFieldName('   ')).toBe('')
  })
})

describe('isDuplicateFieldName', () => {
  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(isDuplicateFieldName(fields, 'cep')).toBe(true)
    expect(isDuplicateFieldName(fields, '  Origem do LEAD ')).toBe(true)
    expect(isDuplicateFieldName(fields, 'Cidade')).toBe(false)
  })

  it('lets a field keep its own name on rename', () => {
    expect(isDuplicateFieldName(fields, 'CEP', 'a')).toBe(false)
    expect(isDuplicateFieldName(fields, 'CEP', 'b')).toBe(true)
  })
})

/** Minimal chainable stub of the PostgREST builder for one table call. */
function fakeSupabase(result: { data?: unknown; error?: unknown }) {
  const calls: { method: string; args: unknown[] }[] = []
  const builder: Record<string, unknown> = {}
  for (const m of ['insert', 'upsert', 'delete', 'eq', 'select']) {
    builder[m] = (...args: unknown[]) => {
      calls.push({ method: m, args })
      return builder
    }
  }
  builder.single = () => Promise.resolve(result)
  // `.eq()` chains resolve when awaited at the end of a delete.
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(result).then(resolve)
  const from = vi.fn(() => builder)
  return { client: { from } as unknown as SupabaseClient, from, calls }
}

describe('createCustomField', () => {
  it('inserts the normalised name with the text type and returns the row', async () => {
    const row = { id: 'x', field_name: 'Cidade', field_type: 'text' }
    const { client, from, calls } = fakeSupabase({ data: row, error: null })
    const created = await createCustomField(client, {
      name: '  Cidade ',
      userId: 'u1',
      accountId: 'acc1',
    })
    expect(from).toHaveBeenCalledWith('custom_fields')
    expect(calls[0]).toEqual({
      method: 'insert',
      args: [
        {
          field_name: 'Cidade',
          field_type: 'text',
          user_id: 'u1',
          account_id: 'acc1',
        },
      ],
    })
    expect(created).toEqual(row)
  })

  it('throws the Supabase error so the caller can toast', async () => {
    const { client } = fakeSupabase({ data: null, error: { message: 'rls' } })
    await expect(
      createCustomField(client, { name: 'X', userId: 'u', accountId: 'a' }),
    ).rejects.toEqual({ message: 'rls' })
  })
})

describe('setContactCustomValue', () => {
  it('upserts a non-empty value on the (contact, field) key', async () => {
    const { client, from, calls } = fakeSupabase({ error: null })
    const stored = await setContactCustomValue(client, {
      contactId: 'c1',
      fieldId: 'f1',
      value: '  01310-100 ',
    })
    expect(stored).toBe('01310-100')
    expect(from).toHaveBeenCalledWith('contact_custom_values')
    expect(calls[0]).toEqual({
      method: 'upsert',
      args: [
        { contact_id: 'c1', custom_field_id: 'f1', value: '01310-100' },
        { onConflict: 'contact_id,custom_field_id' },
      ],
    })
  })

  it('deletes the row when the value is cleared', async () => {
    const { client, calls } = fakeSupabase({ error: null })
    const stored = await setContactCustomValue(client, {
      contactId: 'c1',
      fieldId: 'f1',
      value: '   ',
    })
    expect(stored).toBe('')
    expect(calls.map((c) => c.method)).toEqual(['delete', 'eq', 'eq'])
  })
})
