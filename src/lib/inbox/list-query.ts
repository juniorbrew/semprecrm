/**
 * Server-paginated inbox list: view -> RPC arguments, keyset cursors,
 * ordering, page merging and the realtime merge rules. Pure functions —
 * the SQL twin lives in supabase/migrations/067_inbox_scale.sql
 * (`inbox_conversation_page`, `inbox_counts`); keep both in step.
 *
 * Ordering per tab:
 *   - Fila: unanswered customer message first (group 0), then the ones
 *     where we spoke last (group 1); inside a group the oldest customer
 *     message first; ties on id. Same order as lib/radar/queue.ts, so the
 *     queue is paginated on the server (no "load everything and sort").
 *   - everything else: last_message_at (created_at when there is none)
 *     newest first; ties on id.
 */
import type { Conversation, WhatsAppChannel } from '@/types'
import { matchesRadar, type RadarKey, type RadarPreferences } from '@/lib/radar/classify'
import { isInQueue, queueWaitingSince } from '@/lib/radar/queue'
import { tabConversations, type InboxTab, type LiveFilter } from './triage'

export const INBOX_PAGE_SIZE = 50
/** A resync refetches as many rows as are loaded, capped (the server's own cap is 1000). */
export const INBOX_RESYNC_MAX = 500

export type InboxRow = Pick<
  Conversation,
  | 'id'
  | 'status'
  | 'created_at'
  | 'last_message_at'
  | 'assigned_agent_id'
  | 'last_customer_message_at'
  | 'last_agent_message_at'
  | 'archived_at'
  | 'unread_count'
>

/** What the list reports upward so realtime rows can be merged correctly. */
export interface InboxListState {
  view: InboxView
  /** More pages exist beyond the loaded ones. */
  hasMore: boolean
  /** Last row the server returned for this view (edge of the loaded window). */
  boundary: InboxRow | null
  /** False while the first page of `view` is still loading. */
  ready: boolean
}

/** Everything that decides which conversations the list shows. */
export interface InboxView {
  tab: InboxTab
  /** Effective live filter (already "live" while a Radar chip is active). */
  live: LiveFilter
  unread: boolean
  radar: RadarKey | null
  /** Normalised search text ('' = none). */
  search: string
  /** Contact has ANY of these tags (migration 068); [] = no filter. */
  tagIds: string[]
  /** One WhatsApp transport (migration 068); null = both. */
  channel: WhatsAppChannel | null
}

/** Trailing RPC arguments shared by the page, counts and search functions. */
export function facetArgs(view: Pick<InboxView, 'tagIds' | 'channel'>): {
  p_tag_ids: string[] | null
  p_channel: WhatsAppChannel | null
} {
  return { p_tag_ids: view.tagIds.length ? view.tagIds : null, p_channel: view.channel }
}

export function viewKey(view: InboxView): string {
  return [
    view.tab,
    view.live,
    view.unread ? 1 : 0,
    view.radar ?? '',
    view.search,
    [...view.tagIds].sort().join(','),
    view.channel ?? '',
  ].join('|')
}

export interface ListCursor {
  /** Fila only: 0 waiting / 1 not waiting. */
  grp: number | null
  ts: string
  id: string
}

function ms(iso: string | null | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/** Fila group: 0 = customer's message unanswered, 1 = we spoke last. */
export function queueGroup(
  c: InboxRow,
): 0 | 1 {
  return queueWaitingSince(c) !== null ? 0 : 1
}

/** Cursor to fetch the page after `last` (the last row the server returned). */
export function cursorFor(tab: InboxTab, last: InboxRow): ListCursor {
  if (tab === 'queue') {
    return { grp: queueGroup(last), ts: last.last_customer_message_at ?? '', id: last.id }
  }
  return { grp: null, ts: last.last_message_at ?? last.created_at, id: last.id }
}

/** Arguments of `inbox_conversation_page` for a view + optional cursor. */
export function pageArgs(
  view: InboxView,
  opts: {
    accountId: string
    prefs: RadarPreferences
    /** ILIKE pattern from `buildSearchPattern`, or null. */
    pattern: string | null
    cursor?: ListCursor | null
    limit?: number
  },
): Record<string, unknown> {
  return {
    p_account_id: opts.accountId,
    p_tab: view.tab,
    p_live: view.live,
    p_unread: view.unread,
    p_radar: view.radar,
    p_sla_minutes: opts.prefs.inbox_sla_minutes,
    p_cooling_hours: opts.prefs.cooling_hours,
    p_pattern: opts.pattern,
    p_cursor_grp: opts.cursor?.grp ?? null,
    p_cursor_ts: opts.cursor?.ts || null,
    p_cursor_id: opts.cursor?.id ?? null,
    p_limit: opts.limit ?? INBOX_PAGE_SIZE,
    ...facetArgs(view),
  }
}

/** Arguments of `inbox_counts`. */
export function countsArgs(
  view: Pick<InboxView, 'live' | 'unread' | 'radar' | 'tagIds' | 'channel'>,
  opts: { accountId: string; prefs: RadarPreferences },
): Record<string, unknown> {
  return {
    p_account_id: opts.accountId,
    p_live: view.live,
    p_unread: view.unread,
    p_radar: view.radar,
    p_sla_minutes: opts.prefs.inbox_sla_minutes,
    p_cooling_hours: opts.prefs.cooling_hours,
    ...facetArgs(view),
  }
}

export interface InboxCounts {
  tabs: Record<InboxTab, number>
  radar: Record<RadarKey, number>
}

export const EMPTY_COUNTS: InboxCounts = {
  tabs: { queue: 0, mine: 0, all: 0, closed: 0, archived: 0 },
  radar: { waiting: 0, unassigned: 0, cooling: 0 },
}

/** Row of `inbox_counts` (bigints may arrive as strings) -> UI shape. */
export function parseCounts(row: Record<string, unknown> | null | undefined): InboxCounts {
  if (!row) return EMPTY_COUNTS
  const n = (key: string) => {
    const v = Number(row[key])
    return Number.isFinite(v) ? v : 0
  }
  return {
    tabs: {
      queue: n('queue_count'),
      mine: n('mine_count'),
      all: n('all_count'),
      closed: n('closed_count'),
      archived: n('archived_count'),
    },
    radar: {
      waiting: n('radar_waiting'),
      unassigned: n('radar_unassigned'),
      cooling: n('radar_cooling'),
    },
  }
}

/** Comparator matching the server order of `tab`. */
export function compareForTab(tab: InboxTab): (a: InboxRow, b: InboxRow) => number {
  if (tab === 'queue') {
    return (a, b) => {
      const g = queueGroup(a) - queueGroup(b)
      if (g !== 0) return g
      const t = ms(a.last_customer_message_at) - ms(b.last_customer_message_at)
      if (t !== 0) return t
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    }
  }
  return (a, b) => {
    const t = ms(b.last_message_at ?? b.created_at) - ms(a.last_message_at ?? a.created_at)
    if (t !== 0) return t
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  }
}

/**
 * Append a fetched page to the loaded rows. Rows already loaded win (they
 * may carry fresher realtime patches); duplicates across pages are dropped.
 */
export function mergePage<T extends { id: string }>(current: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(current.map((c) => c.id))
  const out = current.slice()
  for (const row of page) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  return out
}

interface MatchCtx {
  userId: string | null
  prefs: RadarPreferences
  now: number
}

/** Would this row be listed by `view` (tab + live + unread + radar + channel)? Search and tags are not evaluated. */
export function matchesView(c: Conversation, view: InboxView, ctx: MatchCtx): boolean {
  if (view.channel && (c.channel ?? 'official') !== view.channel) return false
  if (view.radar && !matchesRadar(c, view.radar, ctx.prefs, ctx.now)) return false
  if (view.unread && !(c.unread_count > 0)) return false
  if (view.tab === 'queue') return isInQueue(c, ctx.prefs, ctx.now)
  return tabConversations([c], view.tab, { live: view.live, userId: ctx.userId }).length === 1
}

/**
 * Realtime rule for a row that is NOT in the loaded list (new conversation
 * or an update of one beyond the loaded pages): insert it only when it
 * belongs to the current view AND sorts inside the loaded window — i.e. at
 * or before the last row fetched, or everything is already loaded. A row
 * that sorts after the window shows up when "Carregar mais" reaches it.
 * While a search is active nothing unknown is inserted (matching company
 * names needs the server); the next search / resync covers it.
 */
export function shouldInsertUnknown(
  c: Conversation,
  view: InboxView,
  state: { hasMore: boolean; boundary: InboxRow | null },
  ctx: MatchCtx,
): boolean {
  // Tags live on the contact (not on the row), like the company names in a
  // search: the next resync / "Carregar mais" picks such rows up.
  if (view.search || view.tagIds.length) return false
  if (!matchesView(c, view, ctx)) return false
  if (!state.hasMore || !state.boundary) return true
  return compareForTab(view.tab)(c, state.boundary) <= 0
}

/**
 * Owner badge on list rows: hidden on Minhas (everything is mine), always
 * on Todas, and elsewhere only when the rows really have different owners.
 */
export function showOwnerBadge(
  tab: InboxTab,
  rows: readonly { assigned_agent_id?: string | null }[],
): boolean {
  if (tab === 'mine') return false
  if (tab === 'all') return true
  const owners = new Set<string>()
  for (const r of rows) {
    if (r.assigned_agent_id) owners.add(r.assigned_agent_id)
    if (owners.size > 1) return true
  }
  return false
}
