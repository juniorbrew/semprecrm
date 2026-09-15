// ============================================================
// `conversation_inactive` trigger — the follow-up scan (spec §3).
//
// Called from /api/automations/cron after the pending wait steps are
// drained. For every active automation of this trigger type it looks
// for conversations of that account that have been silent for
// `hours`, whose last message came from `last_from`, in one of
// `statuses`, and that have not already fired for this silence
// (`automation_inactivity_fires.fired_for >= last_message_at`).
// Each match dispatches the engine once and records the fire, so a
// conversation nudges once per silence; a new message moves
// `last_message_at` forward and re-arms it.
//
// Takes the Supabase client as a parameter so it is unit-testable with
// a plain mock; never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import type { Automation, ConversationInactiveTriggerConfig } from '@/types'
import { runAutomationsForTrigger } from './engine'
import { INACTIVE_HOURS_MAX, INACTIVE_HOURS_MIN } from './validate'

export { INACTIVE_HOURS_MAX, INACTIVE_HOURS_MIN }

/** Conversations examined / fired per automation per tick. */
export const INACTIVITY_BATCH_SIZE = 200
/** Upper bound on candidate pages per automation per tick (stall guard). */
const MAX_PAGES = 5

export interface InactivityScanResult {
  /** Active `conversation_inactive` automations seen. */
  automations: number
  /** Conversations that matched and were dispatched. */
  fired: number
  /** Conversations skipped because they already fired for this silence. */
  skipped: number
  errors: string[]
}

export type LastFrom = ConversationInactiveTriggerConfig['last_from']

/**
 * Normalise a stored trigger config. Returns null when the config is
 * unusable (the validator should have refused activation, but rows can
 * be edited by hand).
 */
export function parseInactiveConfig(raw: unknown): ConversationInactiveTriggerConfig | null {
  const cfg = (raw ?? {}) as Record<string, unknown>
  const hours = typeof cfg.hours === 'string' ? Number(cfg.hours) : cfg.hours
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return null
  if (hours < INACTIVE_HOURS_MIN || hours > INACTIVE_HOURS_MAX) return null
  const lastFrom: LastFrom =
    cfg.last_from === 'customer' || cfg.last_from === 'any' ? cfg.last_from : 'agent'
  const statuses = Array.isArray(cfg.statuses)
    ? (cfg.statuses.filter((s) => s === 'open' || s === 'pending') as ('open' | 'pending')[])
    : []
  if (statuses.length === 0) return null
  return { hours, last_from: lastFrom, statuses: Array.from(new Set(statuses)) }
}

interface CandidateRow {
  id: string
  account_id: string
  contact_id: string | null
  status: string
  last_message_at: string | null
  last_customer_message_at: string | null
  last_agent_message_at: string | null
}

function stamp(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

/** Who wrote last, from the two per-side timestamps. */
export function lastSender(row: {
  last_customer_message_at: string | null
  last_agent_message_at: string | null
}): 'agent' | 'customer' | null {
  const c = stamp(row.last_customer_message_at)
  const a = stamp(row.last_agent_message_at)
  if (c === null && a === null) return null
  if (a === null) return 'customer'
  if (c === null) return 'agent'
  return a >= c ? 'agent' : 'customer'
}

export function matchesLastFrom(
  row: { last_customer_message_at: string | null; last_agent_message_at: string | null },
  lastFrom: LastFrom,
): boolean {
  if (lastFrom === 'any') return true
  return lastSender(row) === lastFrom
}

export async function scanInactiveConversations(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<InactivityScanResult> {
  const result: InactivityScanResult = { automations: 0, fired: 0, skipped: 0, errors: [] }

  const { data: automations, error } = await db
    .from('automations')
    .select('*')
    .eq('trigger_type', 'conversation_inactive')
    .eq('is_active', true)

  if (error) {
    result.errors.push(`automations: ${error.message}`)
    return result
  }
  if (!automations || automations.length === 0) return result

  for (const automation of automations as Automation[]) {
    result.automations += 1
    try {
      await scanOne(db, automation, now, result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[inactivity] scan failed:', automation.id, msg)
      result.errors.push(`${automation.id}: ${msg}`)
    }
  }
  return result
}

async function scanOne(
  db: SupabaseClient,
  automation: Automation,
  now: Date,
  result: InactivityScanResult,
): Promise<void> {
  const cfg = parseInactiveConfig(automation.trigger_config)
  if (!cfg) {
    result.errors.push(`${automation.id}: invalid trigger config`)
    return
  }

  const cutoff = new Date(now.getTime() - cfg.hours * 3_600_000).toISOString()
  const nowIso = now.toISOString()
  let fired = 0

  for (let page = 0; page < MAX_PAGES && fired < INACTIVITY_BATCH_SIZE; page++) {
    const from = page * INACTIVITY_BATCH_SIZE
    const { data, error } = await db
      .from('conversations')
      .select(
        'id, account_id, contact_id, status, last_message_at, last_customer_message_at, last_agent_message_at',
      )
      .eq('account_id', automation.account_id)
      .in('status', cfg.statuses)
      .not('last_message_at', 'is', null)
      .lte('last_message_at', cutoff)
      .order('last_message_at', { ascending: true })
      .range(from, from + INACTIVITY_BATCH_SIZE - 1)

    if (error) {
      result.errors.push(`${automation.id}: conversations: ${error.message}`)
      return
    }
    const rows = (data ?? []) as CandidateRow[]
    if (rows.length === 0) return

    const candidates = rows.filter((r) => r.contact_id && matchesLastFrom(r, cfg.last_from))
    if (candidates.length > 0) {
      const { data: fires, error: firesErr } = await db
        .from('automation_inactivity_fires')
        .select('conversation_id, fired_for')
        .eq('automation_id', automation.id)
        .in(
          'conversation_id',
          candidates.map((c) => c.id),
        )
      if (firesErr) {
        result.errors.push(`${automation.id}: fires: ${firesErr.message}`)
        return
      }
      const firedFor = new Map<string, number>()
      for (const f of (fires ?? []) as { conversation_id: string; fired_for: string }[]) {
        const t = stamp(f.fired_for)
        if (t !== null) firedFor.set(f.conversation_id, t)
      }

      for (const conv of candidates) {
        if (fired >= INACTIVITY_BATCH_SIZE) break
        const lastAt = stamp(conv.last_message_at) ?? 0
        const prev = firedFor.get(conv.id)
        if (prev !== undefined && prev >= lastAt) {
          result.skipped += 1
          continue
        }

        // Record the fire first so an overlapping tick cannot double-send.
        const { error: upErr } = await db
          .from('automation_inactivity_fires')
          .upsert(
            { automation_id: automation.id, conversation_id: conv.id, fired_for: nowIso },
            { onConflict: 'automation_id,conversation_id' },
          )
        if (upErr) {
          result.errors.push(`${automation.id}/${conv.id}: fire upsert: ${upErr.message}`)
          continue
        }

        await runAutomationsForTrigger({
          accountId: automation.account_id,
          triggerType: 'conversation_inactive',
          contactId: conv.contact_id,
          context: {
            conversation_id: conv.id,
            vars: {
              inactive_automation_id: automation.id,
              inactive_hours: cfg.hours,
              last_message_at: conv.last_message_at,
              last_from: lastSender(conv) ?? 'unknown',
            },
          },
        })
        fired += 1
        result.fired += 1
      }
    }

    if (rows.length < INACTIVITY_BATCH_SIZE) return
  }
}
