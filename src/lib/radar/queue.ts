// ============================================================
// Inbox queue ("Fila") — position and wait time.
//
// Membership is the Radar's `unassigned` bucket (classify.ts), so the
// Fila tab, the "Sem responsável" chip and the dashboard card always
// count the same conversations: status = open, nobody assigned and
// the customer has written at least once.
//
// Order: longest wait first. A conversation whose customer spoke last
// waits since that unanswered message — the same `waitingSince` the
// Radar's `waiting` bucket uses (last_customer_message_at). Unowned
// conversations where the last word was ours (a bot / automation
// reply, or an agent who answered without taking it) are still in the
// queue but nobody is waiting on them right now, so they go after the
// waiting ones, oldest customer message first.
//
// Pure functions, injectable `now`, no I/O.
// ============================================================

import { classifyConversation, type RadarConversation, type RadarPreferences } from './classify'

export type QueueConversation = RadarConversation & { id: string }

export interface QueueEntry<T extends QueueConversation = QueueConversation> {
  conversation: T
  /** 1-based position in the queue. */
  position: number
  /**
   * When the customer's unanswered message arrived — null when the
   * last message was ours (in the queue, but nobody waiting on us).
   */
  waitingSince: Date | null
}

function stamp(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

/** Unanswered-customer-message timestamp, or null when we spoke last. */
export function queueWaitingSince(conv: RadarConversation): Date | null {
  const customerAt = stamp(conv.last_customer_message_at)
  if (customerAt === null) return null
  const agentAt = stamp(conv.last_agent_message_at)
  if (agentAt !== null && agentAt >= customerAt) return null
  return new Date(customerAt)
}

/** True when the conversation belongs in the queue (Radar `unassigned`). */
export function isInQueue(
  conv: RadarConversation,
  prefs: RadarPreferences,
  now: Date | number = Date.now(),
): boolean {
  return classifyConversation(conv, prefs, now).unassigned
}

/**
 * The queue, ordered by longest wait, with 1-based positions. Input
 * order does not matter; ties break on the conversation id so the
 * numbering is stable between renders.
 */
export function buildQueue<T extends QueueConversation>(
  list: readonly T[],
  prefs: RadarPreferences,
  now: Date | number = Date.now(),
): QueueEntry<T>[] {
  const members = list
    .filter((c) => isInQueue(c, prefs, now))
    .map((conversation) => ({
      conversation,
      waitingSince: queueWaitingSince(conversation),
      customerAt: stamp(conversation.last_customer_message_at) ?? Number.POSITIVE_INFINITY,
    }))

  members.sort((a, b) => {
    const aWaiting = a.waitingSince !== null
    const bWaiting = b.waitingSince !== null
    if (aWaiting !== bWaiting) return aWaiting ? -1 : 1
    const aKey = a.waitingSince ? a.waitingSince.getTime() : a.customerAt
    const bKey = b.waitingSince ? b.waitingSince.getTime() : b.customerAt
    if (aKey !== bKey) return aKey - bKey
    return a.conversation.id < b.conversation.id ? -1 : a.conversation.id > b.conversation.id ? 1 : 0
  })

  return members.map((m, i) => ({
    conversation: m.conversation,
    position: i + 1,
    waitingSince: m.waitingSince,
  }))
}

/** Position lookup for the list rows: conversation id → entry. */
export function queueIndex<T extends QueueConversation>(
  entries: readonly QueueEntry<T>[],
): Map<string, QueueEntry<T>> {
  return new Map(entries.map((e) => [e.conversation.id, e]))
}

/** "1º" (pt-BR) / "#1" (en-US). */
export function formatQueuePosition(position: number, language: 'pt-BR' | 'en-US'): string {
  return language === 'pt-BR' ? `${position}º` : `#${position}`
}

/**
 * "Aguardando há 2 d" / "Waiting 2d" — the wait since the unanswered
 * message, in the same units as the Radar's `formatWaitingAge`.
 */
export function formatQueueWait(
  since: Date | number,
  now: Date | number,
  language: 'pt-BR' | 'en-US',
): string {
  const sinceMs = typeof since === 'number' ? since : since.getTime()
  const nowMs = typeof now === 'number' ? now : now.getTime()
  const pt = language === 'pt-BR'
  const min = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000))
  let amount: string
  if (min < 60) amount = pt ? `${min} min` : `${min}m`
  else if (min < 24 * 60) {
    const h = Math.floor(min / 60)
    amount = pt ? `${h} h` : `${h}h`
  } else {
    const d = Math.floor(min / (24 * 60))
    amount = pt ? `${d} ${d === 1 ? 'dia' : 'dias'}` : `${d}d`
  }
  return pt ? `Aguardando há ${amount}` : `Waiting ${amount}`
}
