/**
 * Inbox list tabs. Fila / Minhas / Todas only ever show live
 * conversations (open + pending); resolved ones move to Encerradas and
 * archived ones (migration 056) to Arquivadas, so a just-resolved thread
 * leaves the working lists instead of lingering behind a status chip.
 */
import type { ConversationPriority, ConversationStatus, WhatsAppChannel } from '@/types'

export type InboxTab = 'queue' | 'mine' | 'all' | 'closed' | 'archived'
/** Narrows the live tabs (Minhas / Todas) only. */
export type LiveFilter = 'live' | 'open' | 'pending'

export const INBOX_TABS: InboxTab[] = ['queue', 'mine', 'all', 'closed', 'archived']
export const LIVE_FILTERS: LiveFilter[] = ['live', 'open', 'pending']

type Row = {
  status: ConversationStatus
  archived_at?: string | null
  assigned_agent_id?: string | null
  last_message_at?: string | null
}

export function isLive(c: Row): boolean {
  return !c.archived_at && (c.status === 'open' || c.status === 'pending')
}

export function matchesLiveFilter(c: Row, filter: LiveFilter): boolean {
  return isLive(c) && (filter === 'live' || c.status === filter)
}

export function isClosedTab(c: Row): boolean {
  return !c.archived_at && c.status === 'closed'
}

export function isArchivedTab(c: Row): boolean {
  return !!c.archived_at
}

/** Encerradas: resolved, not archived, newest activity first. */
export function closedConversations<T extends Row>(list: T[]): T[] {
  return list
    .filter(isClosedTab)
    .sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''))
}

/**
 * Rows for every tab except the Fila (which is built by lib/radar/queue).
 * `list` is already narrowed by Radar / unread.
 */
export function tabConversations<T extends Row>(
  list: T[],
  tab: Exclude<InboxTab, 'queue'>,
  opts: { live: LiveFilter; userId: string | null },
): T[] {
  if (tab === 'closed') return closedConversations(list)
  if (tab === 'archived') return list.filter(isArchivedTab)
  const live = list.filter((c) => matchesLiveFilter(c, opts.live))
  if (tab === 'all') return live
  return live.filter((c) => !!opts.userId && c.assigned_agent_id === opts.userId)
}

export function tabCounts<T extends Row>(
  list: T[],
  opts: { live: LiveFilter; userId: string | null; queueLength: number },
): Record<InboxTab, number> {
  let mine = 0
  let all = 0
  let closed = 0
  let archived = 0
  for (const c of list) {
    if (isArchivedTab(c)) archived += 1
    else if (isClosedTab(c)) closed += 1
    if (!matchesLiveFilter(c, opts.live)) continue
    all += 1
    if (opts.userId && c.assigned_agent_id === opts.userId) mine += 1
  }
  return { queue: opts.queueLength, mine, all, closed, archived }
}

/** The tab a conversation lives in when it is not live (deep links). */
export function tabForConversation(c: Row): InboxTab | null {
  if (isArchivedTab(c)) return 'archived'
  if (isClosedTab(c)) return 'closed'
  return null
}

export interface TriageState {
  tab: InboxTab
  live: LiveFilter
  /** Contact-tag filter (any of); [] = none. */
  tagIds: string[]
  /** WhatsApp transport filter; null = both. */
  channel: WhatsAppChannel | null
  /** Support category filter (migration 071); null = any. */
  categoryId?: string | null
  /** Support priority filter (migration 071); null = any. */
  priority?: ConversationPriority | null
  /** Team filter (migration 073); null = any. */
  teamId?: string | null
  /** Only conversations past a pending SLA target (migration 072). */
  slaBreached?: boolean
}

export const DEFAULT_TRIAGE: TriageState = {
  tab: 'all',
  live: 'live',
  tagIds: [],
  channel: null,
  categoryId: null,
  priority: null,
  teamId: null,
  slaBreached: false,
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TAG_FILTER = 20

/**
 * Reads the persisted `{ tab, status }` / `{ tab, live }` blob. Old shapes:
 * tab "unassigned" (pre-Fila) → queue; status "closed" / "archived" →
 * those tabs; "open" / "pending" → live filter; "all" → default.
 */
export function migrateTriage(raw: unknown): TriageState {
  if (!raw || typeof raw !== 'object') return DEFAULT_TRIAGE
  const stored = raw as {
    tab?: unknown
    status?: unknown
    live?: unknown
    tagIds?: unknown
    channel?: unknown
    categoryId?: unknown
    priority?: unknown
    teamId?: unknown
    slaBreached?: unknown
  }
  let tab: InboxTab =
    stored.tab === 'unassigned'
      ? 'queue'
      : INBOX_TABS.includes(stored.tab as InboxTab)
        ? (stored.tab as InboxTab)
        : DEFAULT_TRIAGE.tab
  let live: LiveFilter = LIVE_FILTERS.includes(stored.live as LiveFilter)
    ? (stored.live as LiveFilter)
    : DEFAULT_TRIAGE.live
  if (stored.live === undefined) {
    // Legacy status chip.
    if (stored.status === 'open' || stored.status === 'pending') live = stored.status
    else if (
      (stored.status === 'closed' || stored.status === 'archived') &&
      (tab === 'mine' || tab === 'all')
    ) {
      tab = stored.status
    }
  }
  // Stored ids are untrusted (localStorage): keep only well-formed uuids.
  const tagIds = Array.isArray(stored.tagIds)
    ? Array.from(
        new Set(stored.tagIds.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v))),
      ).slice(0, MAX_TAG_FILTER)
    : []
  const channel: WhatsAppChannel | null =
    stored.channel === 'official' || stored.channel === 'qr' ? stored.channel : null
  const categoryId =
    typeof stored.categoryId === 'string' && UUID_RE.test(stored.categoryId) ? stored.categoryId : null
  const priority: ConversationPriority | null =
    stored.priority === 'low' || stored.priority === 'normal' || stored.priority === 'high' || stored.priority === 'urgent'
      ? stored.priority
      : null
  const teamId = typeof stored.teamId === 'string' && UUID_RE.test(stored.teamId) ? stored.teamId : null
  return { tab, live, tagIds, channel, categoryId, priority, teamId, slaBreached: stored.slaBreached === true }
}
