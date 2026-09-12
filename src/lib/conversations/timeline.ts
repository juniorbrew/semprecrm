// Merged thread timeline: WhatsApp messages, team-only notes and system
// events interleaved by time, then bucketed by calendar day so the
// thread can keep its "Hoje / Ontem / 12 de setembro" separators.

import type { ContactNote, Message } from '@/types'
import type { ConversationEvent } from './events'

export type ThreadItem =
  | { kind: 'message'; id: string; at: string; message: Message }
  | { kind: 'note'; id: string; at: string; note: ContactNote }
  | { kind: 'event'; id: string; at: string; event: ConversationEvent }

const KIND_ORDER: Record<ThreadItem['kind'], number> = {
  message: 0,
  note: 1,
  event: 2,
}

function stamp(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : t
}

/**
 * Interleave messages, notes and events by `created_at`. Ties (same
 * millisecond) keep messages first, then notes, then events, and are
 * otherwise stable — a sent message followed by the resolve pill reads
 * in the order the agent did it.
 */
export function buildThreadTimeline(
  messages: Message[],
  notes: ContactNote[],
  events: ConversationEvent[],
): ThreadItem[] {
  const items: ThreadItem[] = [
    ...messages.map<ThreadItem>((m) => ({
      kind: 'message',
      id: `m:${m.id}`,
      at: m.created_at,
      message: m,
    })),
    ...notes.map<ThreadItem>((n) => ({
      kind: 'note',
      id: `n:${n.id}`,
      at: n.created_at,
      note: n,
    })),
    ...events.map<ThreadItem>((e) => ({
      kind: 'event',
      id: `e:${e.id}`,
      at: e.created_at,
      event: e,
    })),
  ]
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const d = stamp(a.item.at) - stamp(b.item.at)
      if (d !== 0) return d
      const k = KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind]
      if (k !== 0) return k
      return a.index - b.index
    })
    .map(({ item }) => item)
}

/** Local calendar day key (yyyy-mm-dd) for a timestamp. */
export function dayKey(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'invalid'
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface ThreadDayGroup {
  /** ISO timestamp of the first item — feeds the separator label. */
  date: string
  items: ThreadItem[]
}

/** Bucket an already-sorted timeline by local calendar day. */
export function groupTimelineByDay(items: ThreadItem[]): ThreadDayGroup[] {
  const groups: ThreadDayGroup[] = []
  let current = ''
  for (const item of items) {
    const key = dayKey(item.at)
    if (key !== current) {
      current = key
      groups.push({ date: item.at, items: [item] })
    } else {
      groups[groups.length - 1].items.push(item)
    }
  }
  return groups
}
