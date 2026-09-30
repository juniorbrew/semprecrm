/**
 * Message thread paging: the newest page opens the thread, "Carregar
 * mensagens anteriores" prepends older ones. Pure helpers — cursor
 * filter, merge / dedup, resync size, scroll anchoring.
 */
import type { Message } from '@/types'

export const MESSAGE_PAGE_SIZE = 50
/** A resync refetches what is loaded (so it never collapses the thread), capped. */
export const MESSAGE_RESYNC_MAX = 500

type Cursor = Pick<Message, 'id' | 'created_at'>

function ms(iso: string | undefined | null): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

export function compareMessages(a: Cursor, b: Cursor): number {
  const d = ms(a.created_at) - ms(b.created_at)
  if (d !== 0) return d
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Oldest persisted (non-optimistic) message: the "older than" cursor. */
export function oldestPersisted(messages: readonly Message[]): Message | null {
  let oldest: Message | null = null
  for (const m of messages) {
    if (m.id.startsWith('temp-')) continue
    if (!oldest || compareMessages(m, oldest) < 0) oldest = m
  }
  return oldest
}

/**
 * PostgREST `.or()` filter for rows strictly older than `cursor` in
 * (created_at, id) order. Values are quoted so timestamps' `:` `+` never
 * confuse the parser.
 */
export function olderThanFilter(cursor: Cursor): string {
  const ts = `"${cursor.created_at}"`
  return `created_at.lt.${ts},and(created_at.eq.${ts},id.lt."${cursor.id}")`
}

/**
 * A page fetched newest-first with `limit + 1` rows -> ascending page
 * plus whether older rows remain.
 */
export function pageFromNewestFirst(
  rows: readonly Message[],
  limit: number,
): { messages: Message[]; hasMore: boolean } {
  const hasMore = rows.length > limit
  return { messages: rows.slice(0, limit).reverse(), hasMore }
}

/** Prepend an older page: drops ids already loaded, keeps ascending order. */
export function mergeOlder(current: readonly Message[], older: readonly Message[]): Message[] {
  const seen = new Set(current.map((m) => m.id))
  const fresh = older.filter((m) => !seen.has(m.id)).sort(compareMessages)
  return [...fresh, ...current]
}

/** How many messages a resync should refetch (rows loaded, at least one page). */
export function resyncLimit(loaded: readonly Message[]): number {
  const persisted = loaded.filter((m) => !m.id.startsWith('temp-')).length
  return Math.min(Math.max(persisted, MESSAGE_PAGE_SIZE), MESSAGE_RESYNC_MAX)
}

/** scrollTop that keeps the same message under the eye after content was prepended. */
export function anchoredScrollTop(
  prev: { scrollTop: number; scrollHeight: number },
  nextScrollHeight: number,
): number {
  return prev.scrollTop + (nextScrollHeight - prev.scrollHeight)
}

/**
 * Notes / events older than the oldest loaded message would float above
 * messages that are not loaded yet; hide them until the history reaches
 * them. Everything is visible once there is nothing older to load.
 */
export function withinLoadedWindow<T extends { created_at: string }>(
  items: readonly T[],
  oldestLoadedAt: string | null,
  hasOlder: boolean,
): T[] {
  if (!hasOlder || !oldestLoadedAt) return items.slice()
  const floor = ms(oldestLoadedAt)
  return items.filter((i) => ms(i.created_at) >= floor)
}

/** Reply parents referenced by `messages` that are not loaded (fetch them on demand). */
export function missingParentIds(
  messages: readonly Message[],
  known: ReadonlySet<string>,
): string[] {
  const have = new Set(messages.map((m) => m.id))
  const out = new Set<string>()
  for (const m of messages) {
    const p = m.reply_to_message_id
    if (p && !have.has(p) && !known.has(p)) out.add(p)
  }
  return [...out]
}
