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

// ---- Presets and validation (the popover) ---------------------------------

export type SnoozePreset = 'in1h' | 'laterToday' | 'tomorrow9' | 'nextMonday9'

export const SNOOZE_PRESETS: readonly SnoozePreset[] = ['in1h', 'laterToday', 'tomorrow9', 'nextMonday9']

/** Max ahead, as the guard trigger (366 d); the minimum is 1 minute. */
export const SNOOZE_MAX_AHEAD_MS = 366 * DAY_MS
export const SNOOZE_MIN_AHEAD_MS = MINUTE_MS

function atLocal(base: Date, addDays: number, hour: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + addDays)
  d.setHours(hour, 0, 0, 0)
  return d
}

/**
 * The instant a preset stands for, by the browser clock; null = not offered.
 *   in1h          now + 1 h (whole minute)
 *   laterToday    15:00 before 14:00, 18:00 before 17:00, else hidden
 *   tomorrow9     tomorrow 09:00
 *   nextMonday9   the next Monday strictly after today, 09:00
 */
export function snoozePresetTime(preset: SnoozePreset, now: number = Date.now()): Date | null {
  const base = new Date(now)
  switch (preset) {
    case 'in1h': {
      const d = new Date(now + HOUR_MS)
      d.setSeconds(0, 0)
      return d
    }
    case 'laterToday': {
      const h = base.getHours()
      if (h < 14) return atLocal(base, 0, 15)
      if (h < 17) return atLocal(base, 0, 18)
      return null
    }
    case 'tomorrow9':
      return atLocal(base, 1, 9)
    case 'nextMonday9':
      return atLocal(base, (8 - base.getDay()) % 7 || 7, 9)
  }
}

export function availableSnoozePresets(now: number = Date.now()): { preset: SnoozePreset; when: Date }[] {
  const out: { preset: SnoozePreset; when: Date }[] = []
  for (const preset of SNOOZE_PRESETS) {
    const when = snoozePresetTime(preset, now)
    if (when) out.push({ preset, when })
  }
  return out
}

export type SnoozeTimeError = 'invalid' | 'too_soon' | 'too_far'

/** A real instant, at least 1 minute ahead, within 366 days (the guard's range). */
export function validateSnoozeTime(when: Date | null, now: number = Date.now()): SnoozeTimeError | null {
  if (!when || Number.isNaN(when.getTime())) return 'invalid'
  if (when.getTime() - now < SNOOZE_MIN_AHEAD_MS) return 'too_soon'
  if (when.getTime() - now > SNOOZE_MAX_AHEAD_MS) return 'too_far'
  return null
}

export type SnoozeDbError = 'out_of_range' | 'not_live' | 'failed'

/** The guard's errors: 22023 = time out of range, 23514 = closed / archived. */
export function snoozeErrorFromDb(error: { code?: string | null } | null | undefined): SnoozeDbError {
  if (error?.code === '22023') return 'out_of_range'
  if (error?.code === '23514') return 'not_live'
  return 'failed'
}

export const SNOOZE_NOTE_MAX = 200

/** Trimmed note or null (the column is ≤ 200 chars). */
export function normalizeSnoozeNote(note: string | null | undefined): string | null {
  const t = (note ?? '').trim().slice(0, SNOOZE_NOTE_MAX)
  return t || null
}

/**
 * What "Desfazer" writes back: the previous snooze when it is still valid
 * (re-snoozing changed the time), otherwise awake. `snooze_note` is always
 * sent (null included): the guard clears it on an awake row anyway.
 */
export function snoozeUndoPayload(
  previous: { snoozed_until?: string | null; snooze_note?: string | null },
  now: number = Date.now(),
): { snoozed_until: string | null; snooze_note: string | null } {
  const prev = previous.snoozed_until ? Date.parse(previous.snoozed_until) : NaN
  if (!Number.isNaN(prev) && prev - now >= SNOOZE_MIN_AHEAD_MS) {
    return { snoozed_until: previous.snoozed_until!, snooze_note: previous.snooze_note ?? null }
  }
  return { snoozed_until: null, snooze_note: null }
}

/**
 * A conversation was just snoozed from the header or a row: the list moves
 * the selection on (like "e") when it was the open one.
 */
export const INBOX_SNOOZED_EVENT = 'inbox:snoozed'

export function dispatchInboxSnoozed(conversationId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<string>(INBOX_SNOOZED_EVENT, { detail: conversationId }))
}
