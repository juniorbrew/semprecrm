// Products and deal items data access (migration 104). Called from the browser
// with the user session: RLS decides who reads / writes (catalog: admins write,
// members read; items: whoever can edit the deal). deals.value is NOT sent from
// here: the database recomputes it from the items.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { DealItem, ItemValues, Product, ProductValues } from './types'

type Client = Pick<SupabaseClient, 'from'>

const PRODUCT_COLS = 'id, account_id, name, code, unit_price, description, archived_at'
const ITEM_COLS = 'id, account_id, deal_id, product_id, name, unit_price, quantity, discount_pct, position, line_total'

function toProduct(r: Record<string, unknown>): Product {
  return {
    id: r.id as string,
    account_id: r.account_id as string,
    name: r.name as string,
    code: (r.code as string | null) ?? null,
    unit_price: Number(r.unit_price),
    description: (r.description as string | null) ?? null,
    archived_at: (r.archived_at as string | null) ?? null,
  }
}

function toItem(r: Record<string, unknown>): DealItem {
  return {
    id: r.id as string,
    account_id: r.account_id as string,
    deal_id: r.deal_id as string,
    product_id: (r.product_id as string | null) ?? null,
    name: r.name as string,
    unit_price: Number(r.unit_price),
    quantity: Number(r.quantity),
    discount_pct: Number(r.discount_pct),
    position: Number(r.position),
    line_total: Number(r.line_total),
  }
}

/** Catalog, A to Z. Archived products only when asked (they are history, not choices). */
export async function listProducts(db: Client, opts: { includeArchived?: boolean } = {}): Promise<Product[]> {
  let q = db.from('products').select(PRODUCT_COLS).order('name', { ascending: true })
  if (!opts.includeArchived) q = q.is('archived_at', null)
  const { data, error } = await q
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map(toProduct)
}

export async function createProduct(db: Client, accountId: string, values: ProductValues): Promise<void> {
  const { error } = await db.from('products').insert({ account_id: accountId, ...values })
  if (error) throw error
}

export async function updateProduct(db: Client, id: string, values: ProductValues): Promise<void> {
  const { error } = await db.from('products').update(values).eq('id', id)
  if (error) throw error
}

export async function setProductArchived(db: Client, id: string, archived: boolean): Promise<void> {
  const { error } = await db
    .from('products')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', id)
  if (error) throw error
}

export async function listDealItems(db: Client, dealId: string): Promise<DealItem[]> {
  const { data, error } = await db
    .from('deal_items')
    .select(ITEM_COLS)
    .eq('deal_id', dealId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map(toItem)
}

/** Number of lines of a deal (the form only needs to know whether the value is calculated). */
export async function countDealItems(db: Client, dealId: string): Promise<number> {
  const { count, error } = await db
    .from('deal_items')
    .select('id', { count: 'exact', head: true })
    .eq('deal_id', dealId)
  if (error) throw error
  return count ?? 0
}

export async function addDealItem(
  db: Client,
  accountId: string,
  dealId: string,
  values: ItemValues,
  opts: { productId?: string | null; position?: number } = {},
): Promise<void> {
  const { error } = await db.from('deal_items').insert({
    account_id: accountId,
    deal_id: dealId,
    product_id: opts.productId ?? null,
    position: opts.position ?? 0,
    ...values,
  })
  if (error) throw error
}

export async function updateDealItem(db: Client, id: string, values: ItemValues): Promise<void> {
  const { error } = await db.from('deal_items').update(values).eq('id', id)
  if (error) throw error
}

export async function removeDealItem(db: Client, id: string): Promise<void> {
  const { error } = await db.from('deal_items').delete().eq('id', id)
  if (error) throw error
}

/** English message key for `t()` from a Postgres / PostgREST error. */
export function productsErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { code?: string; message?: string }
  if (e.code === '23505') return 'A product with this name already exists'
  if (e.code === '22003' || e.message?.includes('deal_items_total_too_large')) {
    return 'The items add up to more than the deal value limit'
  }
  if (e.code === '42501') return 'You do not have permission to change this, or the account is read-only'
  if (e.code === '23514' || e.code === '23503') return 'The data was rejected. Check the values and try again'
  return 'Something went wrong. Please try again.'
}
