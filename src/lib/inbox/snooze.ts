// ============================================================
// "Adiar conversa" (snooze, migration 079) — pure helpers for the inbox.
//
// The DB is the source of truth: the client only writes `snoozed_until`
// and `snooze_note` on `conversations`; the guard trigger validates the
// time (now + 1 min .. now + 366 d), stamps the rest and logs the event.
// Times use the browser's clock, like the "Lembrar" reminders.
// ============================================================

import type { Conversation } from '@/types'
import type { Language } from '@/lib/i18n'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

function dayStart(d: Date): number {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}

/**
 * "hoje 15:00" / "amanhã 09:00" / "seg 09:00" (within the week) /
 * "12/10 09:00" — for the Adiadas rows, the toast and the header chip.
 */
export function formatSnoozeWhen(when: Date, language: Language, now: number = Date.now()): string {
  const time = when.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
  const days = Math.round((dayStart(when) - dayStart(new Date(now))) / DAY_MS)
  const pt = language === 'pt-BR'
  if (days === 0) return pt ? `hoje ${time}` : `today ${time}`
  if (days === 1) return pt ? `amanhã ${time}` : `tomorrow ${time}`
  if (days > 1 && days < 7) {
    const weekday = when.toLocaleDateString(language, { weekday: 'short' }).replace(/\.$/, '')
    return `${weekday} ${time}`
  }
  const date = when.toLocaleDateString(language, { day: '2-digit', month: '2-digit' })
  return `${date} ${time}`
}

/**
 * "Voltou do adiar": it woke (timer / customer reply) and nothing newer from
 * the customer has been read since. The `last_customer_message_at` check
 * keeps an old, already-read wake from coming back when the customer
 * writes days later. Opening the conversation zeroes `unread_count`.
 */
export function showsSnoozeWokeMarker(
  c: Pick<Conversation, 'snooze_woke_at' | 'last_customer_message_at' | 'unread_count' | 'snoozed_until'>,
): boolean {
  if (!c.snooze_woke_at || c.snoozed_until || !(c.unread_count > 0)) return false
  const woke = Date.parse(c.snooze_woke_at)
  if (Number.isNaN(woke)) return false
  const customer = c.last_customer_message_at ? Date.parse(c.last_customer_message_at) : NaN
  return Number.isNaN(customer) || woke >= customer
}
