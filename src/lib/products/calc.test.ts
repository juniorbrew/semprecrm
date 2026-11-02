import { describe, expect, it } from 'vitest'

import { itemsTotal, lineTotal, lineTotalCents, validateItemDraft, validateProductDraft } from './calc'

describe('lineTotal', () => {
  it('multiplies quantity by price', () => {
    expect(lineTotal(2, 100, 0)).toBe(200)
    expect(lineTotal(1.5, 10, 0)).toBe(15)
  })
  it('applies the discount', () => {
    expect(lineTotal(1, 50, 10)).toBe(45)
    expect(lineTotal(3, 19.9, 7.5)).toBe(55.22) // 59.7 * 0.925 = 55.2225
  })
  it('discount 0 keeps the full price and 100 is free', () => {
    expect(lineTotal(4, 25, 0)).toBe(100)
    expect(lineTotal(4, 25, 100)).toBe(0)
  })
  it('rounds half up to two decimals like Postgres round()', () => {
    expect(lineTotal(1.5, 33.33, 0)).toBe(50) // 49.995
    expect(lineTotal(1.01, 0.99, 50)).toBe(0.5) // 0.49995
    expect(lineTotal(0.01, 0.01, 0)).toBe(0) // 0.0001
    expect(lineTotalCents(0.5, 0.01, 0)).toBe(BigInt(1)) // 0.005 -> 0.01
  })
  it('stays exact at the database ceiling (no float drift)', () => {
    expect(lineTotal(1, 9_999_999_999.99, 0)).toBe(9_999_999_999.99)
    expect(lineTotal(1_000_000, 99.99, 0)).toBe(99_990_000)
  })
})

describe('itemsTotal', () => {
  it('sums the lines', () => {
    expect(itemsTotal([
      { quantity: 2, unit_price: 100, discount_pct: 0 },
      { quantity: 1, unit_price: 50, discount_pct: 10 },
    ])).toEqual({ total: 245, overflow: false })
  })
  it('empty sum is 0', () => {
    expect(itemsTotal([])).toEqual({ total: 0, overflow: false })
  })
  it('flags a sum that does not fit NUMERIC(12,2)', () => {
    expect(itemsTotal([{ quantity: 1, unit_price: 9_999_999_999.99, discount_pct: 0 }]).overflow).toBe(false)
    expect(itemsTotal([
      { quantity: 1, unit_price: 9_999_999_999.99, discount_pct: 0 },
      { quantity: 1, unit_price: 0.01, discount_pct: 0 },
    ]).overflow).toBe(true)
  })
})

describe('validateItemDraft', () => {
  const ok = { name: ' Plano Mensal ', unitPrice: 'R$ 1.500,00', quantity: '1,5', discount: '10%' }
  it('accepts pt-BR formats and trims the name', () => {
    expect(validateItemDraft(ok)).toEqual({
      ok: true,
      values: { name: 'Plano Mensal', unit_price: 1500, quantity: 1.5, discount_pct: 10 },
    })
  })
  it('empty price and discount mean zero', () => {
    expect(validateItemDraft({ ...ok, unitPrice: '', discount: '' })).toMatchObject({
      ok: true,
      values: { unit_price: 0, discount_pct: 0 },
    })
  })
  it('reports every wrong field', () => {
    const r = validateItemDraft({ name: ' ', unitPrice: 'abc', quantity: '0', discount: '101' })
    expect(r).toEqual({ ok: false, errors: ['name', 'price', 'quantity', 'discount'] })
  })
  it('rejects too many decimals, negative-looking text and huge numbers', () => {
    expect(validateItemDraft({ ...ok, quantity: '1,555' })).toMatchObject({ ok: false, errors: ['quantity'] })
    expect(validateItemDraft({ ...ok, unitPrice: '-5' })).toMatchObject({ ok: false, errors: ['price'] })
    expect(validateItemDraft({ ...ok, quantity: '1000000,01' })).toMatchObject({ ok: false, errors: ['quantity-max'] })
    expect(validateItemDraft({ ...ok, unitPrice: '10.000.000.000,00' })).toMatchObject({ ok: false, errors: ['price-max'] })
    expect(validateItemDraft({ ...ok, name: 'x'.repeat(121) })).toMatchObject({ ok: false, errors: ['name-max'] })
  })
  it('rejects a line that alone overflows the deal value', () => {
    expect(validateItemDraft({ ...ok, unitPrice: '10000', quantity: '1000000', discount: '' })).toEqual({
      ok: false,
      errors: ['total-max'],
    })
  })
  it('discount of exactly 100 is allowed', () => {
    expect(validateItemDraft({ ...ok, discount: '100' })).toMatchObject({ ok: true })
  })
})

describe('validateProductDraft', () => {
  it('trims, turns blank optional fields into null and parses the price', () => {
    expect(validateProductDraft({ name: ' Instalação ', code: ' ', unitPrice: '300,5', description: '' })).toEqual({
      ok: true,
      values: { name: 'Instalação', code: null, unit_price: 300.5, description: null },
    })
  })
  it('enforces the limits of the table', () => {
    expect(validateProductDraft({ name: '', code: 'x'.repeat(41), unitPrice: 'x', description: 'y'.repeat(301) })).toEqual({
      ok: false,
      errors: ['name', 'code-max', 'description-max', 'price'],
    })
    expect(validateProductDraft({ name: 'n'.repeat(81), code: '', unitPrice: '', description: '' })).toEqual({
      ok: false,
      errors: ['name-max'],
    })
  })
})
