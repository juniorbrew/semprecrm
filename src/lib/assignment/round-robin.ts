// ============================================================
// Round-robin assignment (spec round 2 §2).
//
// Candidates are the account's members with role agent or above whose
// `profiles.availability` is 'available'. The pick is the one with the
// fewest open conversations already assigned; ties go to the oldest
// `last_assigned_at` (never assigned first). The winner's
// `last_assigned_at` is stamped so the next tie goes elsewhere.
//
// Used by the automation step `assign_conversation` (mode round_robin)
// and by the inbound auto-assign. Pure selection lives in
// `selectRoundRobin` so it is unit-testable without a database.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { hasMinRole, isAccountRole } from '@/lib/auth/roles'

export interface RoundRobinCandidate {
  user_id: string
  account_role: string
  availability: 'available' | 'away' | string | null
  /** ISO timestamp or null (never assigned). */
  last_assigned_at: string | null
}

export interface RoundRobinLoad {
  /** Open conversations currently assigned to each candidate. */
  openByUser: Map<string, number>
}

function stamp(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t
}

/**
 * Pick the next assignee. Returns null when nobody qualifies (no agent+
 * member is available) — the conversation then stays unassigned and
 * surfaces in the Radar.
 */
export function selectRoundRobin(
  candidates: RoundRobinCandidate[],
  load: RoundRobinLoad,
): string | null {
  const eligible = candidates.filter(
    (c) =>
      c.availability === 'available' &&
      isAccountRole(c.account_role) &&
      hasMinRole(c.account_role, 'agent'),
  )
  if (eligible.length === 0) return null

  eligible.sort((a, b) => {
    const la = load.openByUser.get(a.user_id) ?? 0
    const lb = load.openByUser.get(b.user_id) ?? 0
    if (la !== lb) return la - lb
    const ta = stamp(a.last_assigned_at)
    const tb = stamp(b.last_assigned_at)
    if (ta !== tb) return ta - tb
    // Deterministic last resort so tests and reruns agree.
    return a.user_id.localeCompare(b.user_id)
  })
  return eligible[0].user_id
}

export interface PickRoundRobinOptions {
  /** Injected clock for tests. */
  now?: Date
}

/**
 * Load the account's members and their open-conversation counts, pick
 * one, and stamp `profiles.last_assigned_at`. Does NOT assign the
 * conversation itself — callers do that and log the event. Never
 * throws; a read failure resolves to null.
 */
export async function pickRoundRobinAssignee(
  db: SupabaseClient,
  accountId: string,
  opts: PickRoundRobinOptions = {},
): Promise<string | null> {
  try {
    const { data: members, error: membersErr } = await db
      .from('profiles')
      .select('user_id, account_role, availability, last_assigned_at')
      .eq('account_id', accountId)
      .eq('availability', 'available')
    if (membersErr) {
      console.error('[round-robin] members lookup failed:', membersErr)
      return null
    }
    const candidates = (members ?? []) as RoundRobinCandidate[]
    if (candidates.length === 0) return null

    const { data: open, error: openErr } = await db
      .from('conversations')
      .select('assigned_agent_id')
      .eq('account_id', accountId)
      .eq('status', 'open')
      .not('assigned_agent_id', 'is', null)
    if (openErr) {
      console.error('[round-robin] open conversations lookup failed:', openErr)
      return null
    }
    const openByUser = new Map<string, number>()
    for (const row of (open ?? []) as { assigned_agent_id: string | null }[]) {
      if (!row.assigned_agent_id) continue
      openByUser.set(row.assigned_agent_id, (openByUser.get(row.assigned_agent_id) ?? 0) + 1)
    }

    const picked = selectRoundRobin(candidates, { openByUser })
    if (!picked) return null

    const { error: stampErr } = await db
      .from('profiles')
      .update({ last_assigned_at: (opts.now ?? new Date()).toISOString() })
      .eq('account_id', accountId)
      .eq('user_id', picked)
    if (stampErr) console.error('[round-robin] last_assigned_at update failed:', stampErr)

    return picked
  } catch (err) {
    console.error('[round-robin] pickRoundRobinAssignee failed:', err)
    return null
  }
}
