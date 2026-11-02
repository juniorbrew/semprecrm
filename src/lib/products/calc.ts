// Pure math and validation for deal products. The database is the source of
// truth for deals.value (sum of line totals, migration 104); this mirrors its
// rounding exactly so the screen can preview a line before it is saved.

import { DEAL_VALUE_MAX } from '@/lib/pipelines/deal-fields'
import { parsePtBrAmount } from '@/lib/sales-goals/pace'

import type { ItemValues, ProductValues } from './types'

export const QUANTITY_MAX = 1_000_000
export const PRODUCT_NAME_MAX = 80
export const PRODUCT_CODE_MAX = 40
export const PRODUCT_DESCRIPTION_MAX = 300
export const ITEM_NAME_MAX = 120

const hundredths = (n: number) => BigInt(Math.round(n * 100))
const MAX_CENTS = hundredths(DEAL_VALUE_MAX)

/**
 * Line total in cents, exact (BigInt) and rounded half up like Postgres
 * round(quantity * unit_price * (100 - discount) / 100, 2). Inputs have at most
 * two decimals.
 */
export function lineTotalCents(quantity: number, unitPrice: number, discountPct: number): bigint {
  const product = hundredths(quantity) * hundredths(unitPrice) * (10_000n - hundredths(discountPct))
  return (product + 500_000n) / 1_000_000n
}

/** Line total in currency units (2 decimals). */
export function lineTotal(quantity: number, unitPrice: number, discountPct: number): number {
  return Number(lineTotalCents(quantity, unitPrice, discountPct)) / 100
}

/** Sum of the lines; `overflow` when it does not fit deals.value NUMERIC(12,2). */
export function itemsTotal(lines: { quantity: number; unit_price: number; discount_pct: number }[]): {
  total: number
  overflow: boolean
} {
  const cents = lines.reduce((acc, l) => acc + lineTotalCents(l.quantity, l.unit_price, l.discount_pct), 0n)
  return { total: Number(cents) / 100, overflow: cents > MAX_CENTS }
}

// ---- validation ---------------------------------------------------------

export interface ItemDraft {
  name: string
  /** As typed: "R$ 1.500,00", "1500,5". */
  unitPrice: string
  /** As typed: "2", "1,5". */
  quantity: string
  /** Percent as typed: "10", "7,5", "10%". */
  discount: string
}

export type ItemError = 'name' | 'name-max' | 'price' | 'price-max' | 'quantity' | 'quantity-max' | 'discount' | 'total-max'

export function validateItemDraft(
  draft: ItemDraft,
): { ok: true; values: ItemValues } | { ok: false; errors: ItemError[] } {
  const errors: ItemError[] = []
  const name = draft.name.trim()
  if (!name) errors.push('name')
  else if (name.length > ITEM_NAME_MAX) errors.push('name-max')

  const priceText = draft.unitPrice.trim()
  const unit_price = priceText === '' ? 0 : parsePtBrAmount(priceText)
  if (unit_price === null) errors.push('price')
  else if (unit_price > DEAL_VALUE_MAX) errors.push('price-max')

  const quantity = parsePtBrAmount(draft.quantity)
  if (quantity === null || !(quantity > 0)) errors.push('quantity')
  else if (quantity > QUANTITY_MAX) errors.push('quantity-max')

  const discountText = draft.discount.trim().replace(/%$/, '')
  const discount_pct = discountText === '' ? 0 : parsePtBrAmount(discountText)
  if (discount_pct === null || discount_pct > 100) errors.push('discount')

  if (errors.length === 0 && lineTotalCents(quantity!, unit_price!, discount_pct!) > MAX_CENTS) errors.push('total-max')
  if (errors.length) return { ok: false, errors }
  return { ok: true, values: { name, unit_price: unit_price!, quantity: quantity!, discount_pct: discount_pct! } }
}

export interface ProductDraft {
  name: string
  code: string
  unitPrice: string
  description: string
}

export type ProductError = 'name' | 'name-max' | 'code-max' | 'price' | 'price-max' | 'description-max'

export function validateProductDraft(
  draft: ProductDraft,
): { ok: true; values: ProductValues } | { ok: false; errors: ProductError[] } {
  const errors: ProductError[] = []
  const name = draft.name.trim()
  if (!name) errors.push('name')
  else if (name.length > PRODUCT_NAME_MAX) errors.push('name-max')
  const code = draft.code.trim()
  if (code.length > PRODUCT_CODE_MAX) errors.push('code-max')
  const description = draft.description.trim()
  if (description.length > PRODUCT_DESCRIPTION_MAX) errors.push('description-max')
  const priceText = draft.unitPrice.trim()
  const unit_price = priceText === '' ? 0 : parsePtBrAmount(priceText)
  if (unit_price === null) errors.push('price')
  else if (unit_price > DEAL_VALUE_MAX) errors.push('price-max')
  if (errors.length) return { ok: false, errors }
  return { ok: true, values: { name, code: code || null, unit_price: unit_price!, description: description || null } }
}

/** 1500.5 to the pt-BR text the inputs show ("1500,5"). */
export function toInputNumber(n: number): string {
  return String(n).replace('.', ',')
}
