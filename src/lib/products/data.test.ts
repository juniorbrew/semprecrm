import { describe, expect, it, vi } from 'vitest'

import {
  addDealItem,
  countDealItems,
  createProduct,
  listDealItems,
  listProducts,
  productsErrorMessage,
  removeDealItem,
  setProductArchived,
  updateDealItem,
} from './data'

/** Chainable PostgREST stand-in: every method returns the builder; awaiting it resolves `result`. */
function builder(result: unknown) {
  const calls: [string, unknown[]][] = []
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'order']) {
    b[m] = (...args: unknown[]) => {
      calls.push([m, args])
      return b
    }
  }
  b.then = (resolve: (v: unknown) => unknown) => resolve(result)
  return { b, calls }
}
function client(result: unknown) {
  const { b, calls } = builder(result)
  const from = vi.fn(() => b)
  return { db: { from } as never, from, calls }
}

describe('products', () => {
  it('lists only active products by default and coerces numerics', async () => {
    const { db, from, calls } = client({
      data: [{ id: 'p1', account_id: 'a', name: 'Plano', code: null, unit_price: '99.90', description: null, archived_at: null }],
      error: null,
    })
    const rows = await listProducts(db)
    expect(from).toHaveBeenCalledWith('products')
    expect(calls).toContainEqual(['is', ['archived_at', null]])
    expect(rows[0]).toMatchObject({ id: 'p1', unit_price: 99.9, code: null })
  })
  it('includeArchived drops the filter', async () => {
    const { db, calls } = client({ data: [], error: null })
    await listProducts(db, { includeArchived: true })
    expect(calls.some(([m]) => m === 'is')).toBe(false)
  })
  it('creates with the account and archives with a timestamp / unarchives with null', async () => {
    const c = client({ error: null })
    await createProduct(c.db, 'acc', { name: 'X', code: null, unit_price: 1, description: null })
    expect(c.calls[0]).toEqual(['insert', [{ account_id: 'acc', name: 'X', code: null, unit_price: 1, description: null }]])

    const a = client({ error: null })
    await setProductArchived(a.db, 'p1', true)
    expect((a.calls[0][1][0] as { archived_at: string }).archived_at).toMatch(/^\d{4}-/)
    const u = client({ error: null })
    await setProductArchived(u.db, 'p1', false)
    expect(u.calls[0]).toEqual(['update', [{ archived_at: null }]])
  })
  it('throws the database error', async () => {
    const { db } = client({ error: { code: '23505', message: 'dup' } })
    await expect(createProduct(db, 'a', { name: 'X', code: null, unit_price: 0, description: null })).rejects.toMatchObject({ code: '23505' })
  })
})

describe('deal items', () => {
  it('reads the lines of one deal in order', async () => {
    const { db, from, calls } = client({
      data: [{ id: 'i1', account_id: 'a', deal_id: 'd', product_id: null, name: 'Avulso', unit_price: '10.00', quantity: '1.50', discount_pct: '5.00', position: 0, line_total: '14.25' }],
      error: null,
    })
    const rows = await listDealItems(db, 'd')
    expect(from).toHaveBeenCalledWith('deal_items')
    expect(calls).toContainEqual(['eq', ['deal_id', 'd']])
    expect(rows[0]).toMatchObject({ unit_price: 10, quantity: 1.5, discount_pct: 5, line_total: 14.25 })
  })
  it('adds a line with the account, deal, product copy and position, and never sends deals.value', async () => {
    const { db, calls } = client({ error: null })
    await addDealItem(db, 'acc', 'd', { name: 'Plano', unit_price: 100, quantity: 2, discount_pct: 0 }, { productId: 'p1', position: 3 })
    expect(calls[0]).toEqual(['insert', [{ account_id: 'acc', deal_id: 'd', product_id: 'p1', position: 3, name: 'Plano', unit_price: 100, quantity: 2, discount_pct: 0 }]])
  })
  it('free-text lines have no product', async () => {
    const { db, calls } = client({ error: null })
    await addDealItem(db, 'acc', 'd', { name: 'Avulso', unit_price: 1, quantity: 1, discount_pct: 0 })
    expect((calls[0][1][0] as { product_id: unknown }).product_id).toBeNull()
  })
  it('updates and removes by id', async () => {
    const u = client({ error: null })
    await updateDealItem(u.db, 'i1', { name: 'N', unit_price: 1, quantity: 2, discount_pct: 3 })
    expect(u.calls).toContainEqual(['eq', ['id', 'i1']])
    const r = client({ error: null })
    await removeDealItem(r.db, 'i1')
    expect(r.calls).toEqual([['delete', []], ['eq', ['id', 'i1']]])
  })
  it('counts lines', async () => {
    expect(await countDealItems(client({ count: 3, error: null }).db, 'd')).toBe(3)
    expect(await countDealItems(client({ count: null, error: null }).db, 'd')).toBe(0)
  })
})

describe('productsErrorMessage', () => {
  it('maps the database errors to plain messages', () => {
    expect(productsErrorMessage({ code: '23505' })).toContain('already exists')
    expect(productsErrorMessage({ code: '22003', message: 'deal_items_total_too_large: x' })).toContain('limit')
    expect(productsErrorMessage({ code: '54000', message: 'deal_items_limit: x' })).toContain('200 items')
    expect(productsErrorMessage({ code: '42501' })).toContain('permission')
    expect(productsErrorMessage(new Error('boom'))).toContain('Something went wrong')
  })
})
