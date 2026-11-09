import { describe, expect, it, vi } from 'vitest'

import {
  createDealField,
  dealFieldsErrorMessage,
  deleteDealField,
  listDealFields,
  listDealFieldValues,
  listItemSums,
  listValuesForDeals,
  reorderDealFields,
  setDealFieldValue,
  updateDealField,
} from './data'
import type { DealField } from './types'

/** A thenable query builder: every chained call returns itself and records the call. */
function builder(result: { data?: unknown; error?: unknown; count?: number }) {
  const calls: [string, unknown[]][] = []
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in', 'order']) {
    b[m] = (...args: unknown[]) => {
      calls.push([m, args])
      return b
    }
  }
  b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null, ...result })
  return { b, calls }
}
function client(results: Record<string, { data?: unknown; error?: unknown }[]>, rpcResults: { data?: unknown; error?: unknown }[] = []) {
  const used: Record<string, ReturnType<typeof builder>[]> = {}
  const rpc = vi.fn<(fn: string, args: unknown) => Promise<{ data?: unknown; error?: unknown }>>(
    async () => rpcResults.shift() ?? { data: [], error: null },
  )
  const from = vi.fn((table: string) => {
    const next = results[table]?.shift() ?? {}
    const q = builder(next)
    ;(used[table] ??= []).push(q)
    return q.b
  })
  return { db: { from, rpc } as never, from, rpc, used }
}

const FIELD = (over: Partial<DealField> = {}): DealField => ({
  id: 'f1', account_id: 'acc', name: 'Custo', kind: 'currency', expression: null, result_format: null, show_on_card: false, position: 0, ...over,
})

describe('listDealFields', () => {
  it('orders by position and maps rows', async () => {
    const { db, used } = client({
      deal_fields: [{ data: [{ id: 'f1', account_id: 'a', name: 'Custo', kind: 'currency', expression: null, result_format: null, show_on_card: true, position: '2' }] }],
    })
    const rows = await listDealFields(db)
    expect(rows).toEqual([{ id: 'f1', account_id: 'a', name: 'Custo', kind: 'currency', expression: null, result_format: null, show_on_card: true, position: 2 }])
    expect(used.deal_fields[0].calls.map((c) => c[0])).toEqual(['select', 'order', 'order'])
  })
  it('throws the database error', async () => {
    const { db } = client({ deal_fields: [{ error: new Error('nope') }] })
    await expect(listDealFields(db)).rejects.toThrow('nope')
  })
})

describe('createDealField / updateDealField / deleteDealField', () => {
  it('trims the name and only sends expression for formulas', async () => {
    const { db, used } = client({ deal_fields: [{}, {}] })
    await createDealField(db, 'acc', { name: '  Frete ', kind: 'number', expression: '{valor}', result_format: 'number' }, 3)
    expect(used.deal_fields[0].calls[0]).toEqual(['insert', [{
      account_id: 'acc', name: 'Frete', kind: 'number', expression: null, result_format: null, show_on_card: false, position: 3,
    }]])
    await createDealField(db, 'acc', { name: 'Margem', kind: 'formula', expression: '{valor}', result_format: 'currency', show_on_card: true }, 4)
    expect(used.deal_fields[1].calls[0][1][0]).toMatchObject({ kind: 'formula', expression: '{valor}', result_format: 'currency', show_on_card: true })
  })
  it('surfaces insert errors', async () => {
    const { db } = client({ deal_fields: [{ error: { code: '23505' } }] })
    await expect(createDealField(db, 'acc', { name: 'x', kind: 'number' }, 0)).rejects.toMatchObject({ code: '23505' })
  })
  it('updates only what was given', async () => {
    const { db, used } = client({ deal_fields: [{}] })
    await updateDealField(db, 'f1', { name: ' Novo ', show_on_card: true })
    expect(used.deal_fields[0].calls).toEqual([['update', [{ name: 'Novo', show_on_card: true }]], ['eq', ['id', 'f1']]])
  })
  it('deletes by id', async () => {
    const { db, used } = client({ deal_fields: [{}] })
    await deleteDealField(db, 'f1')
    expect(used.deal_fields[0].calls).toEqual([['delete', []], ['eq', ['id', 'f1']]])
  })
})

describe('reorderDealFields', () => {
  it('writes only the rows that moved', async () => {
    const fields = [FIELD({ id: 'a', position: 0 }), FIELD({ id: 'b', position: 1 }), FIELD({ id: 'c', position: 2 })]
    const { db, used } = client({ deal_fields: [{}, {}] })
    await reorderDealFields(db, fields, ['a', 'c', 'b'])
    expect(used.deal_fields).toHaveLength(2)
    expect(used.deal_fields.map((q) => q.calls[0][1][0])).toEqual([{ position: 1 }, { position: 2 }])
    expect(used.deal_fields.map((q) => q.calls[1][1][1])).toEqual(['c', 'b'])
  })
  it('does nothing when the order is unchanged and throws on failure', async () => {
    const fields = [FIELD({ id: 'a', position: 0 }), FIELD({ id: 'b', position: 1 })]
    const none = client({})
    await reorderDealFields(none.db, fields, ['a', 'b'])
    expect(none.from).not.toHaveBeenCalled()
    const bad = client({ deal_fields: [{ error: new Error('boom') }] })
    await expect(reorderDealFields(bad.db, fields, ['b', 'a'])).rejects.toThrow('boom')
  })
})

describe('values', () => {
  it('lists one deal values as numbers', async () => {
    const { db } = client({ deal_field_values: [{ data: [{ deal_id: 'd', field_id: 'f1', value: '12.5' }, { deal_id: 'd', field_id: 'f2', value: 3 }] }] })
    expect(await listDealFieldValues(db, 'd')).toEqual({ f1: 12.5, f2: 3 })
  })
  it('loads many deals in chunks of 100, one request each, filtered by field', async () => {
    const ids = Array.from({ length: 230 }, (_, i) => `d${i}`)
    const { db, from, used } = client({
      deal_field_values: [
        { data: [{ deal_id: 'd1', field_id: 'f1', value: '1' }] },
        { data: [{ deal_id: 'd150', field_id: 'f1', value: '2' }] },
        { data: [] },
      ],
    })
    const out = await listValuesForDeals(db, ids, ['f1'])
    expect(from).toHaveBeenCalledTimes(3)
    expect(out).toEqual({ d1: { f1: 1 }, d150: { f1: 2 } })
    const inCalls = used.deal_field_values.map((q) => q.calls.filter((c) => c[0] === 'in'))
    expect((inCalls[0][0][1][1] as string[]).length).toBe(100)
    expect((inCalls[2][0][1][1] as string[]).length).toBe(30)
    expect(inCalls[0][1][1]).toEqual(['field_id', ['f1']])
  })
  it('skips the request when there is nothing to load', async () => {
    const { db, from } = client({})
    expect(await listValuesForDeals(db, [], ['f1'])).toEqual({})
    expect(await listValuesForDeals(db, ['d'], [])).toEqual({})
    expect(await listItemSums(db, [])).toEqual({})
    expect(from).not.toHaveBeenCalled()
  })
  it('sums item lines per deal in the database, 100 deals per call, and merges the pages', async () => {
    const ids = Array.from({ length: 230 }, (_, i) => `d${i}`)
    const { db, rpc } = client({}, [
      { data: [{ deal_id: 'd1', total: '30.5' }] },
      { data: [{ deal_id: 'd150', total: 5 }] },
      { data: [] },
    ])
    expect(await listItemSums(db, ids)).toEqual({ d1: 30.5, d150: 5 })
    expect(rpc).toHaveBeenCalledTimes(3)
    expect(rpc.mock.calls[0][0]).toBe('deal_items_sums')
    expect((rpc.mock.calls[0][1] as { p_deal_ids: string[] }).p_deal_ids).toHaveLength(100)
    expect((rpc.mock.calls[2][1] as { p_deal_ids: string[] }).p_deal_ids).toHaveLength(30)
  })
  it('throws when the sums call fails', async () => {
    const { db } = client({}, [{ error: new Error('rpc down') }])
    await expect(listItemSums(db, ['d'])).rejects.toThrow('rpc down')
  })
  it('never asks for more than 1000 rows in one request (PostgREST cuts there silently)', async () => {
    // 50 fields x 400 deals = 20000 rows: every request must cover at most 1000 / 50 = 20 deals
    const ids = Array.from({ length: 400 }, (_, i) => `d${i}`)
    const fields = Array.from({ length: 50 }, (_, i) => `f${i}`)
    const { db, used } = client({ deal_field_values: Array.from({ length: 20 }, () => ({ data: [] })) })
    await listValuesForDeals(db, ids, fields)
    const sizes = used.deal_field_values.map((q) => (q.calls.find((c) => c[0] === 'in')![1][1] as string[]).length)
    expect(sizes.length).toBe(20)
    for (const n of sizes) expect(n * fields.length).toBeLessThanOrEqual(1000)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(400)
  })
  it('throws when a chunk fails', async () => {
    const { db } = client({ deal_field_values: [{ error: new Error('bad') }] })
    await expect(listValuesForDeals(db, ['d'], ['f'])).rejects.toThrow('bad')
  })
  it('upserts a value stamped for the deal and clears with a delete', async () => {
    const { db, used } = client({ deal_field_values: [{}, {}] })
    await setDealFieldValue(db, 'acc', 'd', 'f', 7)
    expect(used.deal_field_values[0].calls[0]).toEqual(['upsert', [
      { deal_id: 'd', field_id: 'f', account_id: 'acc', value: 7 }, { onConflict: 'deal_id,field_id' },
    ]])
    await setDealFieldValue(db, 'acc', 'd', 'f', null)
    expect(used.deal_field_values[1].calls).toEqual([['delete', []], ['eq', ['deal_id', 'd']], ['eq', ['field_id', 'f']]])
  })
  it('surfaces write errors', async () => {
    const { db } = client({ deal_field_values: [{ error: { code: '42501' } }] })
    await expect(setDealFieldValue(db, 'acc', 'd', 'f', 1)).rejects.toMatchObject({ code: '42501' })
  })
})

describe('dealFieldsErrorMessage', () => {
  it('maps database errors to message keys', () => {
    expect(dealFieldsErrorMessage({ code: '23505' })).toBe('A field with this name already exists')
    expect(dealFieldsErrorMessage({ code: '54000', message: 'deal_fields_card_limit: x' })).toBe('At most 2 fields can show on the card')
    expect(dealFieldsErrorMessage({ code: '54000', message: 'deal_fields_limit: x' })).toBe('An account can have at most 50 deal fields')
    expect(dealFieldsErrorMessage({ code: '42501' })).toMatch(/permission/)
    expect(dealFieldsErrorMessage({ code: '23514' })).toMatch(/rejected/)
    expect(dealFieldsErrorMessage(null)).toBe('Something went wrong. Please try again.')
  })
})
