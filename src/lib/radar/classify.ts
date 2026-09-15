// ============================================================
// Radar — conversations at risk (spec §3).
//
// Pure functions over the two `conversations` timestamps kept by the
// migration-030 trigger. Shared by the dashboard card, the inbox chips
// and the row indicator so the three always agree.
//
//   waiting     status ≠ closed, last message came from the customer and
//               has been unanswered for more than `inbox_sla_minutes`.
//   unassigned  status = open, nobody assigned, and the customer has
//               written at least once.
//   cooling     status ≠ closed, last message came from us and the
//               customer has been silent for more than `cooling_hours`.
// ============================================================

import type { AccountPreferences, Conversation } from '@/types'

export type RadarKey = 'waiting' | 'unassigned' | 'cooling'

export const RADAR_KEYS: RadarKey[] = ['waiting', 'unassigned', 'cooling']

export function isRadarKey(value: unknown): value is RadarKey {
  return typeof value === 'string' && (RADAR_KEYS as string[]).includes(value)
}

export type RadarConversation = Pick<
  Conversation,
  'status' | 'assigned_agent_id' | 'last_customer_message_at' | 'last_agent_message_at'
>

export type RadarPreferences = Pick<AccountPreferences, 'inbox_sla_minutes' | 'cooling_hours'>

export interface RadarClassification {
  waiting: boolean
  unassigned: boolean
  cooling: boolean
  /** When `waiting`: the unanswered customer message's timestamp. */
  waitingSince?: Date
  /** When `cooling`: the last agent message's timestamp. */
  coolingSince?: Date
}

function stamp(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

export function classifyConversation(
  conv: RadarConversation,
  prefs: RadarPreferences,
  now: Date | number = Date.now(),
): RadarClassification {
  const nowMs = typeof now === 'number' ? now : now.getTime()
  const customerAt = stamp(conv.last_customer_message_at)
  const agentAt = stamp(conv.last_agent_message_at)
  const notClosed = conv.status !== 'closed'

  // Customer spoke last (an agent-less conversation counts as "-infinity").
  const customerLast = customerAt !== null && (agentAt === null || customerAt > agentAt)
  const agentLast = agentAt !== null && (customerAt === null || agentAt > customerAt)

  const slaMs = Math.max(0, prefs.inbox_sla_minutes) * 60_000
  const coolingMs = Math.max(0, prefs.cooling_hours) * 3_600_000

  const waiting = notClosed && customerLast && nowMs - (customerAt as number) > slaMs
  const unassigned = conv.status === 'open' && !conv.assigned_agent_id && customerAt !== null
  const cooling = notClosed && agentLast && nowMs - (agentAt as number) > coolingMs

  const out: RadarClassification = { waiting, unassigned, cooling }
  if (waiting) out.waitingSince = new Date(customerAt as number)
  if (cooling) out.coolingSince = new Date(agentAt as number)
  return out
}

export interface RadarCounts {
  waiting: number
  unassigned: number
  cooling: number
  /** Oldest unanswered customer message among the waiting ones. */
  oldestWaitingSince: Date | null
  /** Oldest agent message among the cooling ones. */
  oldestCoolingSince: Date | null
}

export function countRadar(
  list: RadarConversation[],
  prefs: RadarPreferences,
  now: Date | number = Date.now(),
): RadarCounts {
  const counts: RadarCounts = {
    waiting: 0,
    unassigned: 0,
    cooling: 0,
    oldestWaitingSince: null,
    oldestCoolingSince: null,
  }
  for (const conv of list) {
    const c = classifyConversation(conv, prefs, now)
    if (c.waiting) {
      counts.waiting += 1
      if (
        c.waitingSince &&
        (!counts.oldestWaitingSince || c.waitingSince < counts.oldestWaitingSince)
      ) {
        counts.oldestWaitingSince = c.waitingSince
      }
    }
    if (c.unassigned) counts.unassigned += 1
    if (c.cooling) {
      counts.cooling += 1
      if (
        c.coolingSince &&
        (!counts.oldestCoolingSince || c.coolingSince < counts.oldestCoolingSince)
      ) {
        counts.oldestCoolingSince = c.coolingSince
      }
    }
  }
  return counts
}

/** Filter helper for the inbox chips / `?radar=` deep links. */
export function matchesRadar(
  conv: RadarConversation,
  key: RadarKey,
  prefs: RadarPreferences,
  now: Date | number = Date.now(),
): boolean {
  return classifyConversation(conv, prefs, now)[key]
}

/**
 * "há 12 min" / "12m ago" — compact relative age for the waiting
 * indicator and the dashboard's "oldest case" sentence.
 */
export function formatWaitingAge(
  since: Date | number,
  now: Date | number,
  language: 'pt-BR' | 'en-US',
): string {
  const sinceMs = typeof since === 'number' ? since : since.getTime()
  const nowMs = typeof now === 'number' ? now : now.getTime()
  const pt = language === 'pt-BR'
  const min = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000))
  if (min < 60) return pt ? `há ${min} min` : `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return pt ? `há ${h} h` : `${h}h ago`
  const d = Math.floor(h / 24)
  return pt ? `há ${d} d` : `${d}d ago`
}
