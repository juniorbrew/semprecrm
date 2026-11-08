// Deal fields data access (migration 107). Called from the browser with the user
// session: RLS decides who reads / writes (fields: admins write, members read;
// values: whoever can edit the deal). Formula results are never stored.

import type { SupabaseClient } from '@supabase/supabase-js'

import type { DealField, DealFieldInput, FieldValues } from './types'

type Client = Pick<SupabaseClient, 'from'>
type RpcClient = Pick<SupabaseClient, 'from' | 'rpc'>

const FIELD_COLS = 'id, account_id, name, kind, expression, result_format, show_on_card, position'
/** .in() filters travel in the URL: keep each request small. */
const CHUNK = 100
/** PostgREST cuts a response at max_rows (1000) without saying so: no request may ask for more. */
const MAX_ROWS = 1000

function toField(r: Record<string, unknown>): DealField {
  return {
    id: r.id as string,
    account_id: r.account_id as string,
    name: r.name as string,
    kind: r.kind as DealField['kind'],
    expression: (r.expression as string | null) ?? null,
    result_format: (r.result_format as DealField['result_format']) ?? null,
    show_on_card: Boolean(r.show_on_card),
    position: Number(r.position),
  }
}

function chunked<T>(items: T[], size: number = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Fields in the admin's order. */
export async function listDealFields(db: Client): Promise<DealField[]> {
  const { data, error } = await db
    .from('deal_fields')
    .select(FIELD_COLS)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map(toField)
}

export async function createDealField(
  db: Client,
  accountId: string,
  input: DealFieldInput,
  position: number,
): Promise<void> {
  const { error } = await db.from('deal_fields').insert({
    account_id: accountId,
    name: input.name.trim(),
    kind: input.kind,
    expression: input.kind === 'formula' ? input.expression ?? null : null,
    result_format: input.kind === 'formula' ? input.result_format ?? null : null,
    show_on_card: input.show_on_card ?? false,
    position,
    // created_by is stamped by the database from the session.
  })
  if (error) throw error
}

/** Whether a field is a formula never changes, so `kind` only moves between the number kinds. */
export async function updateDealField(db: Client, id: string, input: Partial<DealFieldInput>): Promise<void> {
  const patch: Record<string, unknown> = {}
  if (input.name !== undefined) patch.name = input.name.trim()
  if (input.kind !== undefined) patch.kind = input.kind
  if (input.expression !== undefined) patch.expression = input.expression
  if (input.result_format !== undefined) patch.result_format = input.result_format
  if (input.show_on_card !== undefined) patch.show_on_card = input.show_on_card
  const { error } = await db.from('deal_fields').update(patch).eq('id', id)
  if (error) throw error
}

/** Rewrite positions to match `orderedIds` (only the rows that moved). */
export async function reorderDealFields(db: Client, fields: DealField[], orderedIds: string[]): Promise<void> {
  const current = new Map(fields.map((f) => [f.id, f.position]))
  const moves = orderedIds.map((id, position) => ({ id, position })).filter((m) => current.get(m.id) !== m.position)
  const results = await Promise.all(
    moves.map((m) => db.from('deal_fields').update({ position: m.position }).eq('id', m.id)),
  )
  const failed = results.find((r) => r.error)
  if (failed?.error) throw failed.error
}

/** Deletes the field and (CASCADE) every value of it. */
export async function deleteDealField(db: Client, id: string): Promise<void> {
  const { error } = await db.from('deal_fields').delete().eq('id', id)
  if (error) throw error
}

function groupValues(rows: Record<string, unknown>[]): Record<string, FieldValues> {
  const out: Record<string, FieldValues> = {}
  for (const r of rows) {
    const dealId = r.deal_id as string
    const bucket = out[dealId] ?? (out[dealId] = {})
    bucket[r.field_id as string] = Number(r.value)
  }
  return out
}

/** The values of one deal. */
export async function listDealFieldValues(db: Client, dealId: string): Promise<FieldValues> {
  const { data, error } = await db.from('deal_field_values').select('deal_id, field_id, value').eq('deal_id', dealId)
  if (error) throw error
  return groupValues((data ?? []) as Record<string, unknown>[])[dealId] ?? {}
}

/**
 * The values of many deals in a few requests (board cards): only the fields asked for.
 * Each request covers as many deals as keep it under MAX_ROWS (deals x fields), so nothing is
 * cut silently. Deals with no values are absent from the result.
 */
export async function listValuesForDeals(
  db: Client,
  dealIds: string[],
  fieldIds: string[],
): Promise<Record<string, FieldValues>> {
  if (dealIds.length === 0 || fieldIds.length === 0) return {}
  const pages = await Promise.all(
    chunked(dealIds, Math.max(1, Math.min(CHUNK, Math.floor(MAX_ROWS / fieldIds.length)))).map((ids) =>
      db.from('deal_field_values').select('deal_id, field_id, value').in('deal_id', ids).in('field_id', fieldIds),
    ),
  )
  const rows: Record<string, unknown>[] = []
  for (const p of pages) {
    if (p.error) throw p.error
    rows.push(...((p.data ?? []) as Record<string, unknown>[]))
  }
  return groupValues(rows)
}

/** Sum of the item lines per deal ({Itens}), added up in the database (deal_items_sums); deals without items are absent. */
export async function listItemSums(db: RpcClient, dealIds: string[]): Promise<Record<string, number>> {
  if (dealIds.length === 0) return {}
  const pages = await Promise.all(
    chunked(dealIds).map((ids) => db.rpc('deal_items_sums', { p_deal_ids: ids })),
  )
  const sums: Record<string, number> = {}
  for (const p of pages) {
    if (p.error) throw p.error
    for (const r of (p.data ?? []) as Record<string, unknown>[]) sums[r.deal_id as string] = Number(r.total)
  }
  return sums
}

/** Set a value, or clear it (null): a cleared field has no row. */
export async function setDealFieldValue(
  db: Client,
  accountId: string,
  dealId: string,
  fieldId: string,
  value: number | null,
): Promise<void> {
  if (value === null) {
    const { error } = await db.from('deal_field_values').delete().eq('deal_id', dealId).eq('field_id', fieldId)
    if (error) throw error
    return
  }
  const { error } = await db
    .from('deal_field_values')
    .upsert(
      { deal_id: dealId, field_id: fieldId, account_id: accountId, value },
      { onConflict: 'deal_id,field_id' },
    )
  if (error) throw error
}

/** English message key for `t()` from a Postgres / PostgREST error. */
export function dealFieldsErrorMessage(err: unknown): string {
  const e = (err ?? {}) as { code?: string; message?: string }
  if (e.code === '23505') return 'A field with this name already exists'
  if (e.message?.includes('deal_fields_card_limit')) return 'At most 2 fields can show on the card'
  if (e.code === '54000' || e.message?.includes('deal_fields_limit')) return 'An account can have at most 50 deal fields'
  if (e.code === '42501') return 'You do not have permission to change this, or the account is read-only'
  if (e.code === '23514' || e.code === '23503') return 'The data was rejected. Check the values and try again'
  return 'Something went wrong. Please try again.'
}
