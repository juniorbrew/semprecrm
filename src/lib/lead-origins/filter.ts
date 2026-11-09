// ============================================================
// Contacts list filter by origin (channel and campaign): PostgREST filters on the contact's FIRST
// touch (same cohort rule as the report). Pure; the query builder is passed in.
// ============================================================

import { ORIGIN_CHANNELS, type OriginChannel } from './types'

/** Embedded inner join: only contacts whose first touch matches the filters stay. */
export const ORIGIN_EMBED = 'first_origin:lead_origins!contacts_first_origin_id_fkey!inner(id)'

export interface OriginFilter {
  channel: OriginChannel | ''
  /** Free text: part of an ad title, utm_campaign or link ref. */
  text: string
}

/** The text without the characters that have meaning inside a PostgREST `or=(...)` value. */
export function cleanOriginText(text: string): string {
  return text.replace(/[,()%*\\"':]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
}

export function hasOriginFilter(f: OriginFilter): boolean {
  return !!f.channel || cleanOriginText(f.text) !== ''
}

interface Filterable {
  eq(column: string, value: string): this
  or(filters: string, options: { referencedTable: string }): this
}

export function applyOriginFilter<Q extends Filterable>(query: Q, f: OriginFilter): Q {
  let q = query
  if (f.channel && ORIGIN_CHANNELS.includes(f.channel)) q = q.eq('first_origin.channel', f.channel)
  const text = cleanOriginText(f.text)
  if (text) {
    const term = `%${text}%`
    q = q.or(`headline.ilike.${term},utm_campaign.ilike.${term},source_id.ilike.${term}`, { referencedTable: 'first_origin' })
  }
  return q
}
