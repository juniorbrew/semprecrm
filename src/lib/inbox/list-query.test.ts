import { describe, expect, it } from 'vitest'

import type { Conversation } from '@/types'
import { buildQueue } from '@/lib/radar/queue'
import { countRadar } from '@/lib/radar/classify'
import { tabConversations, tabCounts, type InboxTab, type LiveFilter } from './triage'
import {
  compareForTab,
  countsArgs,
  cursorFor,
  matchesView,
  mergePage,
  pageArgs,
  parseCounts,
  queueGroup,
  shouldInsertUnknown,
  showOwnerBadge,
  viewKey,
  type InboxRow,
  type InboxView,
} from './list-query'

const NOW = Date.parse('2026-09-30T12:00:00Z')
const prefs = { inbox_sla_minutes: 15, cooling_hours: 24 }
const ME = 'u1'

const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    user_id: 'x',
    contact_id: 'c-' + id,
    status: 'open',
    unread_count: 0,
    created_at: iso(10_000),
    updated_at: iso(1),
    last_message_at: iso(60),
    last_customer_message_at: iso(60),
    last_agent_message_at: null,
    ...over,
  }
}

/** A mixed account: every tab / radar bucket has members. */
const fixtures: Conversation[] = [
  conv('a1', { last_message_at: iso(5), last_customer_message_at: iso(5) }),
  conv('a2', { last_message_at: iso(500), last_customer_message_at: iso(500) }),
  conv('a3', { last_message_at: iso(90), last_customer_message_at: iso(300), last_agent_message_at: iso(90) }),
  conv('a4', { last_message_at: iso(90), last_customer_message_at: iso(300), last_agent_message_at: iso(90) }),
  conv('m1', { assigned_agent_id: ME, last_message_at: iso(20), last_customer_message_at: iso(20), unread_count: 2 }),
  conv('m2', { assigned_agent_id: ME, status: 'pending', last_message_at: iso(200), last_customer_message_at: iso(400), last_agent_message_at: iso(200) }),
  conv('o1', { assigned_agent_id: 'u2', last_message_at: iso(30) }),
  conv('c1', { status: 'closed', assigned_agent_id: ME, last_message_at: iso(1000) }),
  conv('c2', { status: 'closed', last_message_at: iso(900), last_customer_message_at: null }),
  conv('r1', { status: 'closed', archived_at: iso(50), last_message_at: iso(2000) }),
  conv('n1', { last_message_at: undefined, last_customer_message_at: null, created_at: iso(15) }),
]

/**
 * Independent model of what inbox_conversation_page does in SQL (tab
 * predicate + order), written from the SQL text, not from triage.ts.
 */
function serverModel(tab: InboxTab, live: LiveFilter, rows: Conversation[]): Conversation[] {
  const recent = (c: Conversation) => Date.parse(c.last_message_at ?? c.created_at)
  const grp = (c: Conversation) =>
    !c.last_agent_message_at || Date.parse(c.last_agent_message_at) < Date.parse(c.last_customer_message_at ?? '') ? 0 : 1
  const liveSql = (c: Conversation) =>
    !c.archived_at && (live === 'live' ? c.status === 'open' || c.status === 'pending' : c.status === live)
  const pick = rows.filter((c) => {
    if (tab === 'queue') return c.status === 'open' && !c.assigned_agent_id && !!c.last_customer_message_at
    if (tab === 'closed') return !c.archived_at && c.status === 'closed'
    if (tab === 'archived') return !!c.archived_at
    if (tab === 'mine') return liveSql(c) && c.assigned_agent_id === ME
    return liveSql(c)
  })
  return pick.sort((a, b) =>
    tab === 'queue'
      ? grp(a) - grp(b) ||
        Date.parse(a.last_customer_message_at!) - Date.parse(b.last_customer_message_at!) ||
        (a.id < b.id ? -1 : 1)
      : recent(b) - recent(a) || (a.id < b.id ? 1 : -1),
  )
}

/** Walk the model page by page with the cursors the client would send. */
function walk(tab: InboxTab, live: LiveFilter, size: number): string[] {
  const all = serverModel(tab, live, fixtures)
  const out: string[] = []
  let cursor: ReturnType<typeof cursorFor> | null = null
  for (let guard = 0; guard < 50; guard++) {
    const rest: Conversation[] = cursor
      ? all.filter((c) => compareForTab(tab)(c, { ...all.find((r) => r.id === cursor!.id)! }) > 0)
      : all
    const page = rest.slice(0, size)
    out.push(...page.map((c) => c.id))
    if (page.length < size) break
    cursor = cursorFor(tab, page[page.length - 1])
  }
  return out
}

describe('tab filtering: server model == triage.ts', () => {
  const tabs: Exclude<InboxTab, 'queue'>[] = ['mine', 'all', 'closed', 'archived']
  for (const live of ['live', 'open', 'pending'] as LiveFilter[]) {
    for (const tab of tabs) {
      it(`${tab} / ${live}`, () => {
        const viaTriage = tabConversations(fixtures, tab, { live, userId: ME })
          .map((c) => c.id)
          .sort()
        const viaServer = serverModel(tab, live, fixtures)
          .map((c) => c.id)
          .sort()
        expect(viaServer).toEqual(viaTriage)
      })
    }
  }

  it('queue: same members, same order as buildQueue', () => {
    const client = buildQueue(fixtures, prefs, NOW).map((e) => e.conversation.id)
    expect(serverModel('queue', 'live', fixtures).map((c) => c.id)).toEqual(client)
    // and compareForTab sorts a shuffled pool into that order
    const sorted = [...fixtures]
      .filter((c) => client.includes(c.id))
      .reverse()
      .sort(compareForTab('queue'))
      .map((c) => c.id)
    expect(sorted).toEqual(client)
  })

  it('recency tabs: compareForTab reproduces the server order (created_at when no message)', () => {
    const server = serverModel('all', 'live', fixtures).map((c) => c.id)
    const sorted = fixtures
      .filter((c) => server.includes(c.id))
      .sort(compareForTab('all'))
      .map((c) => c.id)
    expect(sorted).toEqual(server)
    expect(server.indexOf('n1')).toBeGreaterThan(server.indexOf('a1')) // no longer floats to the top
  })
})

describe('keyset pagination', () => {
  for (const tab of ['queue', 'all', 'mine', 'closed'] as InboxTab[]) {
    it(`walking ${tab} in pages of 2 yields every row once, in order`, () => {
      const expected = serverModel(tab, 'live', fixtures).map((c) => c.id)
      expect(walk(tab, 'live', 2)).toEqual(expected)
      expect(new Set(expected).size).toBe(expected.length)
    })
  }

  it('queue cursor carries the wait group and the customer timestamp', () => {
    const waiting = conv('w', { last_customer_message_at: iso(100), last_agent_message_at: iso(200) })
    const answered = conv('x', { last_customer_message_at: iso(100), last_agent_message_at: iso(50) })
    expect(queueGroup(waiting)).toBe(0)
    expect(queueGroup(answered)).toBe(1)
    expect(cursorFor('queue', answered)).toEqual({ grp: 1, ts: iso(100), id: 'x' })
  })

  it('recency cursor falls back to created_at', () => {
    const c = conv('n', { last_message_at: undefined })
    expect(cursorFor('all', c)).toEqual({ grp: null, ts: c.created_at, id: 'n' })
  })

  it('pageArgs maps the view and cursor to the RPC parameters', () => {
    const view: InboxView = { tab: 'mine', live: 'open', unread: true, radar: 'waiting', search: 'ana', tagIds: ['t1', 't2'], channel: 'qr' }
    const args = pageArgs(view, {
      accountId: 'acc',
      prefs,
      pattern: '%ana%',
      cursor: { grp: null, ts: 'T', id: 'I' },
      limit: 20,
    })
    expect(args).toEqual({
      p_account_id: 'acc',
      p_tab: 'mine',
      p_live: 'open',
      p_unread: true,
      p_radar: 'waiting',
      p_sla_minutes: 15,
      p_cooling_hours: 24,
      p_pattern: '%ana%',
      p_cursor_grp: null,
      p_cursor_ts: 'T',
      p_cursor_id: 'I',
      p_limit: 20,
      p_tag_ids: ['t1', 't2'],
      p_channel: 'qr',
      p_category_id: null,
      p_priority: null,
    })
    const first = pageArgs({ ...view, radar: null, search: '' }, { accountId: 'acc', prefs, pattern: null })
    // No tags / channel -> NULL parameters (backwards compatible with 067 callers).
    expect(first.p_tag_ids).toEqual(['t1', 't2'])
    expect(first.p_channel).toBe('qr')
    expect(pageArgs({ ...view, tagIds: [], channel: null }, { accountId: 'acc', prefs, pattern: null })).toMatchObject({
      p_tag_ids: null,
      p_channel: null,
    })
    expect(first.p_cursor_id).toBeNull()
    expect(first.p_limit).toBe(50)
  })

  it('viewKey changes with every filter that changes the rows', () => {
    const base: InboxView = { tab: 'all', live: 'live', unread: false, radar: null, search: '', tagIds: [], channel: null }
    const keys = new Set([
      viewKey(base),
      viewKey({ ...base, tab: 'queue' }),
      viewKey({ ...base, live: 'open' }),
      viewKey({ ...base, unread: true }),
      viewKey({ ...base, radar: 'cooling' }),
      viewKey({ ...base, search: 'x' }),
      viewKey({ ...base, tagIds: ['a'] }),
      viewKey({ ...base, channel: 'qr' }),
    ])
    expect(keys.size).toBe(8)
    // Tag order does not matter.
    expect(viewKey({ ...base, tagIds: ['b', 'a'] })).toBe(viewKey({ ...base, tagIds: ['a', 'b'] }))
  })
})

describe('counts parity', () => {
  // counts as inbox_counts computes them, written from the SQL text
  const liveOf = (live: LiveFilter) => (c: Conversation) =>
    !c.archived_at && (live === 'live' ? c.status !== 'closed' : c.status === live)

  for (const live of ['live', 'open', 'pending'] as LiveFilter[]) {
    it(`tab badges == tabCounts (${live})`, () => {
      const sql = {
        queue: fixtures.filter((c) => c.status === 'open' && !c.assigned_agent_id && !!c.last_customer_message_at).length,
        mine: fixtures.filter((c) => liveOf(live)(c) && c.assigned_agent_id === ME).length,
        all: fixtures.filter(liveOf(live)).length,
        closed: fixtures.filter((c) => !c.archived_at && c.status === 'closed').length,
        archived: fixtures.filter((c) => !!c.archived_at).length,
      }
      const queueLength = buildQueue(fixtures, prefs, NOW).length
      expect(tabCounts(fixtures, { live, userId: ME, queueLength })).toEqual(sql)
    })
  }

  it('radar chips == countRadar', () => {
    const r = countRadar(fixtures, prefs, NOW)
    const parsed = parseCounts({
      queue_count: '1',
      radar_waiting: String(r.waiting),
      radar_unassigned: String(r.unassigned),
      radar_cooling: String(r.cooling),
    })
    expect(parsed.radar).toEqual({ waiting: r.waiting, unassigned: r.unassigned, cooling: r.cooling })
    expect(r.unassigned).toBe(buildQueue(fixtures, prefs, NOW).length)
  })

  it('parseCounts tolerates bigint strings, junk and null', () => {
    expect(parseCounts({ queue_count: '7', mine_count: 3, all_count: 'x' }).tabs).toEqual({
      queue: 7,
      mine: 3,
      all: 0,
      closed: 0,
      archived: 0,
    })
    expect(parseCounts(null).tabs.all).toBe(0)
  })

  it('category and priority map to p_category_id / p_priority, equally for list and counts (071)', () => {
    const facets = { tagIds: [], channel: null, categoryId: 'cat-1', priority: 'urgent' as const }
    const list = pageArgs({ tab: 'all', live: 'live', unread: false, radar: null, search: '', ...facets }, { accountId: 'a', prefs, pattern: null })
    const counts = countsArgs({ live: 'live', unread: false, radar: null, ...facets }, { accountId: 'a', prefs })
    expect(list).toMatchObject({ p_category_id: 'cat-1', p_priority: 'urgent' })
    expect(counts).toMatchObject({ p_category_id: 'cat-1', p_priority: 'urgent' })
    // Absent = NULL (backwards compatible).
    expect(pageArgs({ tab: 'all', live: 'live', unread: false, radar: null, search: '', tagIds: [], channel: null }, { accountId: 'a', prefs, pattern: null })).toMatchObject({
      p_category_id: null,
      p_priority: null,
    })
  })

  it('viewKey changes with category and priority', () => {
    const base: InboxView = { tab: 'all', live: 'live', unread: false, radar: null, search: '', tagIds: [], channel: null }
    const keys = new Set([viewKey(base), viewKey({ ...base, categoryId: 'c' }), viewKey({ ...base, priority: 'high' })])
    expect(keys.size).toBe(3)
  })

  it('countsArgs carries the filters and the SLA', () => {
    expect(
      countsArgs({ live: 'open', unread: false, radar: null, tagIds: [], channel: null }, { accountId: 'a', prefs }),
    ).toEqual({
      p_account_id: 'a',
      p_live: 'open',
      p_unread: false,
      p_radar: null,
      p_sla_minutes: 15,
      p_cooling_hours: 24,
      p_tag_ids: null,
      p_channel: null,
      p_category_id: null,
      p_priority: null,
    })
    // Counts and list receive the same facet arguments (parity with 068).
    const facets = { tagIds: ['t1'], channel: 'official' as const }
    const list = pageArgs({ tab: 'all', live: 'live', unread: false, radar: null, search: '', ...facets }, { accountId: 'a', prefs, pattern: null })
    const counts = countsArgs({ live: 'live', unread: false, radar: null, ...facets }, { accountId: 'a', prefs })
    expect([counts.p_tag_ids, counts.p_channel]).toEqual([list.p_tag_ids, list.p_channel])
  })
})

describe('mergePage', () => {
  it('appends new rows, keeps the loaded copy of duplicates and their order', () => {
    const loaded = [conv('a', { unread_count: 5 }), conv('b')]
    const page = [conv('b', { unread_count: 0 }), conv('c')]
    const merged = mergePage(loaded, page)
    expect(merged.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(merged[1]).toBe(loaded[1])
  })
})

describe('realtime merge rules', () => {
  const ctx = { userId: ME, prefs, now: NOW }
  const view = (over: Partial<InboxView> = {}): InboxView => ({
    tab: 'all',
    live: 'live',
    unread: false,
    radar: null,
    search: '',
    tagIds: [],
    channel: null,
    ...over,
  })
  const boundary = (c: Conversation): InboxRow => c

  it('a new live conversation is inserted on Todas', () => {
    expect(shouldInsertUnknown(conv('new'), view(), { hasMore: true, boundary: boundary(conv('old', { last_message_at: iso(600) })) }, ctx)).toBe(true)
  })

  it('a conversation that does not match the tab is ignored', () => {
    const closed = conv('z', { status: 'closed' })
    expect(shouldInsertUnknown(closed, view(), { hasMore: false, boundary: null }, ctx)).toBe(false)
    expect(shouldInsertUnknown(closed, view({ tab: 'closed' }), { hasMore: false, boundary: null }, ctx)).toBe(true)
    expect(shouldInsertUnknown(conv('u'), view({ tab: 'mine' }), { hasMore: false, boundary: null }, ctx)).toBe(false)
    expect(shouldInsertUnknown(conv('u', { assigned_agent_id: ME }), view({ tab: 'mine' }), { hasMore: false, boundary: null }, ctx)).toBe(true)
    expect(shouldInsertUnknown(conv('u'), view({ unread: true }), { hasMore: false, boundary: null }, ctx)).toBe(false)
  })

  it('a row older than the loaded window waits for "Carregar mais"', () => {
    const b = boundary(conv('edge', { last_message_at: iso(100) }))
    expect(shouldInsertUnknown(conv('old', { last_message_at: iso(400) }), view(), { hasMore: true, boundary: b }, ctx)).toBe(false)
    expect(shouldInsertUnknown(conv('old', { last_message_at: iso(400) }), view(), { hasMore: false, boundary: b }, ctx)).toBe(true)
  })

  it('Fila: a fresh arrival goes to the end, so it is skipped while more pages exist', () => {
    const b = boundary(conv('edge', { last_customer_message_at: iso(120) }))
    const fresh = conv('fresh', { last_customer_message_at: iso(1) })
    const older = conv('older', { last_customer_message_at: iso(500) })
    const q = view({ tab: 'queue' })
    expect(shouldInsertUnknown(fresh, q, { hasMore: true, boundary: b }, ctx)).toBe(false)
    expect(shouldInsertUnknown(older, q, { hasMore: true, boundary: b }, ctx)).toBe(true)
    expect(shouldInsertUnknown(fresh, q, { hasMore: false, boundary: b }, ctx)).toBe(true)
  })

  it('category / priority filters are checked locally on realtime rows (071)', () => {
    const st = { hasMore: false, boundary: null }
    expect(shouldInsertUnknown(conv('n', { category_id: 'c1' }), view({ categoryId: 'c1' }), st, ctx)).toBe(true)
    expect(shouldInsertUnknown(conv('n', { category_id: 'c2' }), view({ categoryId: 'c1' }), st, ctx)).toBe(false)
    expect(shouldInsertUnknown(conv('n'), view({ categoryId: 'c1' }), st, ctx)).toBe(false)
    expect(shouldInsertUnknown(conv('n', { priority: 'urgent' }), view({ priority: 'urgent' }), st, ctx)).toBe(true)
    expect(shouldInsertUnknown(conv('n'), view({ priority: 'urgent' }), st, ctx)).toBe(false) // default normal
    expect(shouldInsertUnknown(conv('n'), view({ priority: 'normal' }), st, ctx)).toBe(true)
  })

  it('nothing unknown is inserted while a search is active', () => {
    expect(shouldInsertUnknown(conv('n'), view({ search: 'ana' }), { hasMore: false, boundary: null }, ctx)).toBe(false)
  })

  it('a tag filter defers unknown rows to the server; a channel filter is checked locally', () => {
    const st = { hasMore: false, boundary: null }
    expect(shouldInsertUnknown(conv('n'), view({ tagIds: ['t'] }), st, ctx)).toBe(false)
    expect(shouldInsertUnknown(conv('n', { channel: 'qr' }), view({ channel: 'qr' }), st, ctx)).toBe(true)
    expect(shouldInsertUnknown(conv('n', { channel: 'official' }), view({ channel: 'qr' }), st, ctx)).toBe(false)
    expect(shouldInsertUnknown(conv('n'), view({ channel: 'official' }), st, ctx)).toBe(true)
  })

  it('matchesView honours the Radar bucket', () => {
    const waiting = conv('w', { last_customer_message_at: iso(120) })
    expect(matchesView(waiting, view({ radar: 'waiting' }), ctx)).toBe(true)
    expect(matchesView(conv('f', { last_customer_message_at: iso(1) }), view({ radar: 'waiting' }), ctx)).toBe(false)
  })
})

describe('showOwnerBadge', () => {
  const a = { assigned_agent_id: 'a' }
  const b = { assigned_agent_id: 'b' }
  const none = { assigned_agent_id: null }
  it('hidden on Minhas, always on Todas', () => {
    expect(showOwnerBadge('mine', [a, b])).toBe(false)
    expect(showOwnerBadge('all', [a])).toBe(true)
    expect(showOwnerBadge('all', [])).toBe(true)
  })
  it('elsewhere only with mixed owners', () => {
    expect(showOwnerBadge('closed', [a, a, none])).toBe(false)
    expect(showOwnerBadge('closed', [a, none, b])).toBe(true)
    expect(showOwnerBadge('queue', [none, none])).toBe(false)
  })
})
