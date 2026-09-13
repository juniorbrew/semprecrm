import { describe, expect, it } from 'vitest'
import { applyTaskFilters, computeTaskCounts, groupByStatus, sortTasks } from './filter'
import type { Task, TaskStatus } from './types'

const now = new Date(2026, 8, 12, 12, 0, 0).getTime()
const at = (d: number, h: number) => new Date(2026, 8, d, h, 0, 0).toISOString()

const status = (id: string, kind: TaskStatus['kind'], position: number): TaskStatus => ({
  id,
  account_id: 'acc',
  name: id,
  color: '#000',
  position,
  kind,
  is_default: kind === 'open',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})
const statuses = [
  status('todo', 'open', 0),
  status('doing', 'in_progress', 1),
  status('done', 'done', 2),
]

let seq = 0
const task = (overrides: Partial<Task>): Task => ({
  id: `t${++seq}`,
  account_id: 'acc',
  status_id: 'todo',
  title: `Task ${seq}`,
  description: null,
  priority: 'normal',
  assignee_user_id: null,
  created_by: null,
  contact_id: null,
  conversation_id: null,
  deal_id: null,
  due_at: null,
  completed_at: null,
  position: 0,
  created_at: new Date(2026, 8, 1, 0, seq).toISOString(),
  updated_at: '2026-09-01T00:00:00Z',
  ...overrides,
})

const me = 'user-me'
const other = 'user-other'

const overdueMine = task({ id: 'overdueMine', assignee_user_id: me, due_at: at(10, 9) })
const todayLater = task({
  id: 'todayLater',
  assignee_user_id: other,
  due_at: at(12, 18),
  priority: 'high',
})
const tomorrow = task({
  id: 'tomorrow',
  assignee_user_id: me,
  due_at: at(13, 9),
  status_id: 'doing',
})
const undated = task({ id: 'undated', title: 'Ligar para Maria', priority: 'urgent' })
const finished = task({
  id: 'finished',
  status_id: 'done',
  assignee_user_id: me,
  due_at: at(9, 9),
})
const withContact = task({
  id: 'withContact',
  contact: { id: 'c1', name: 'João Silva', phone: '5511999', avatar_url: null },
})
const all = [overdueMine, todayLater, tomorrow, undated, finished, withContact]
const ctx = { userId: me, statuses, now }

describe('applyTaskFilters — scope chips', () => {
  it('all keeps everything, done included', () => {
    expect(applyTaskFilters(all, { scope: 'all' }, ctx)).toHaveLength(6)
  })
  it('mine = assigned to me and not done', () => {
    expect(applyTaskFilters(all, { scope: 'mine' }, ctx).map((t) => t.id)).toEqual([
      'overdueMine',
      'tomorrow',
    ])
  })
  it('mine is empty without a signed-in user', () => {
    expect(applyTaskFilters(all, { scope: 'mine' }, { ...ctx, userId: null })).toEqual([])
  })
  it('today = due today or overdue, not done', () => {
    expect(applyTaskFilters(all, { scope: 'today' }, ctx).map((t) => t.id)).toEqual([
      'overdueMine',
      'todayLater',
    ])
  })
  it('overdue = strictly past due, not done', () => {
    expect(applyTaskFilters(all, { scope: 'overdue' }, ctx).map((t) => t.id)).toEqual([
      'overdueMine',
    ])
  })
})

describe('applyTaskFilters — selects and search', () => {
  it('assignee, unassigned, status and priority narrow the list', () => {
    expect(
      applyTaskFilters(all, { scope: 'all', assigneeUserId: other }, ctx).map((t) => t.id),
    ).toEqual(['todayLater'])
    expect(
      applyTaskFilters(all, { scope: 'all', assigneeUserId: 'unassigned' }, ctx).map(
        (t) => t.id,
      ),
    ).toEqual(['undated', 'withContact'])
    expect(
      applyTaskFilters(all, { scope: 'all', statusId: 'doing' }, ctx).map((t) => t.id),
    ).toEqual(['tomorrow'])
    expect(
      applyTaskFilters(all, { scope: 'all', priority: 'urgent' }, ctx).map((t) => t.id),
    ).toEqual(['undated'])
  })
  it('search matches title and contact name, case-insensitively', () => {
    expect(
      applyTaskFilters(all, { scope: 'all', search: 'maria' }, ctx).map((t) => t.id),
    ).toEqual(['undated'])
    expect(
      applyTaskFilters(all, { scope: 'all', search: 'joão' }, ctx).map((t) => t.id),
    ).toEqual(['withContact'])
    expect(applyTaskFilters(all, { scope: 'all', search: '   ' }, ctx)).toHaveLength(6)
  })
  it('combines chip and selects', () => {
    expect(
      applyTaskFilters(all, { scope: 'mine', statusId: 'doing' }, ctx).map((t) => t.id),
    ).toEqual(['tomorrow'])
  })
})

describe('sortTasks', () => {
  it('open first, then soonest due, undated last, then priority', () => {
    const ids = sortTasks(all, statuses).map((t) => t.id)
    expect(ids.indexOf('finished')).toBe(ids.length - 1)
    expect(ids.slice(0, 3)).toEqual(['overdueMine', 'todayLater', 'tomorrow'])
    // Both undated: urgent before normal.
    expect(ids.indexOf('undated')).toBeLessThan(ids.indexOf('withContact'))
  })
})

describe('computeTaskCounts', () => {
  it('counts open / overdue / today / mine, skipping done', () => {
    expect(computeTaskCounts(all, ctx)).toEqual({ open: 5, overdue: 1, dueToday: 1, mine: 2 })
  })
})

describe('groupByStatus', () => {
  it('gives every status a bucket and orders by position', () => {
    const a = task({ id: 'a', position: 2 })
    const b = task({ id: 'b', position: 1 })
    const groups = groupByStatus([a, b, tomorrow], statuses)
    expect([...groups.keys()]).toEqual(['todo', 'doing', 'done'])
    expect(groups.get('todo')?.map((t) => t.id)).toEqual(['b', 'a'])
    expect(groups.get('doing')?.map((t) => t.id)).toEqual(['tomorrow'])
    expect(groups.get('done')).toEqual([])
  })
})
