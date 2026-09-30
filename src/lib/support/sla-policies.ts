// SLA policies (migration 072): thin Supabase read/write side.
// RLS: members read, admins write. Nothing is seeded; an account with no
// rows behaves exactly like before (only the Radar's `inbox_sla_minutes`).

import type { SupabaseClient } from '@supabase/supabase-js'

import type { ConversationPriority } from '@/types'
import { PRIORITIES } from './model'
import { SLA_LIMITS, type SlaPolicy } from './sla'

type Client = Pick<SupabaseClient, 'from'>

const COLUMNS = 'priority, first_response_minutes, resolution_minutes'

export async function listSlaPolicies(supabase: Client, accountId: string): Promise<SlaPolicy[]> {
  const { data, error } = await supabase.from('sla_policies').select(COLUMNS).eq('account_id', accountId)
  if (error) throw error
  const rows = (data ?? []) as SlaPolicy[]
  return PRIORITIES.flatMap((p) => rows.filter((r) => r.priority === p))
}

function validMinutes(v: number | null, max: number): boolean {
  return v === null || (Number.isInteger(v) && v >= 1 && v <= max)
}

/** Null when the row is fine, else the offending field. */
export function invalidPolicy(p: SlaPolicy): 'first_response_minutes' | 'resolution_minutes' | null {
  if (!validMinutes(p.first_response_minutes, SLA_LIMITS.first_response_minutes)) return 'first_response_minutes'
  if (!validMinutes(p.resolution_minutes, SLA_LIMITS.resolution_minutes)) return 'resolution_minutes'
  return null
}

/**
 * Writes the whole table of four rows: a row with a target is upserted, a
 * row with none is deleted (no target = that priority is not timed).
 * Existing conversations keep the deadlines they were stamped with.
 */
export async function saveSlaPolicies(
  supabase: Client,
  accountId: string,
  policies: readonly SlaPolicy[],
): Promise<void> {
  for (const p of policies) {
    if (invalidPolicy(p)) throw new Error(`invalid SLA policy: ${p.priority}`)
  }
  const keep = policies.filter((p) => p.first_response_minutes !== null || p.resolution_minutes !== null)
  const drop = policies
    .filter((p) => p.first_response_minutes === null && p.resolution_minutes === null)
    .map((p) => p.priority as ConversationPriority)
  if (keep.length) {
    const { error } = await supabase
      .from('sla_policies')
      .upsert(keep.map((p) => ({ account_id: accountId, ...p })), { onConflict: 'account_id,priority' })
    if (error) throw error
  }
  if (drop.length) {
    const { error } = await supabase.from('sla_policies').delete().eq('account_id', accountId).in('priority', drop)
    if (error) throw error
  }
}
