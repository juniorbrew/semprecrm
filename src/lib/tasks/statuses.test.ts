import { describe, expect, it } from 'vitest'
import {
  canDeleteStatus,
  defaultStatus,
  defaultStatusForKind,
  doneStatus,
  isTaskDone,
  nextStatusPosition,
  openStatusIds,
  renumberPositions,
  sortStatuses,
  validateStatusSet,
  withDefault,
} from './statuses'
import type { TaskStatus } from './types'

const mk = (
  id: string,
  kind: TaskStatus['kind'],
  position: number,
  extra: Partial<TaskStatus> = {},
): TaskStatus => ({
  id,
  account_id: 'acc',
  name: id,
  color: '#000',
  position,
  kind,
  is_default: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...extra,
})

const todo = mk('todo', 'open', 0, { is_default: true, name: 'A fazer' })
const doing = mk('doing', 'in_progress', 1, { name: 'Em andamento' })
const done = mk('done', 'done', 2, { name: 'Concluída' })
const archived = mk('archived', 'done', 3, { name: 'Arquivada' })
const all = [done, doing, todo, archived]

describe('sortStatuses', () => {
  it('orders by position', () => {
    expect(sortStatuses(all).map((s) => s.id)).toEqual(['todo', 'doing', 'done', 'archived'])
  })
})

describe('defaultStatus / doneStatus', () => {
  it('prefers the flagged default', () => {
    expect(defaultStatus(all)?.id).toBe('todo')
  })
  it('falls back to the first open status, then the first status', () => {
    const noFlag = all.map((s) => ({ ...s, is_default: false }))
    expect(defaultStatus(noFlag)?.id).toBe('todo')
    expect(defaultStatus([doing, done])?.id).toBe('doing')
    expect(defaultStatus([])).toBeNull()
  })
  it('doneStatus is the first done column in board order', () => {
    expect(doneStatus(all)?.id).toBe('done')
    expect(doneStatus([todo, doing])).toBeNull()
  })
})

describe('defaultStatusForKind', () => {
  it('skips the excluded id and prefers the default flag', () => {
    expect(defaultStatusForKind(all, 'done', 'done')?.id).toBe('archived')
    expect(defaultStatusForKind(all, 'done')?.id).toBe('done')
    expect(defaultStatusForKind(all, 'open', 'todo')).toBeNull()
  })
})

describe('isTaskDone / openStatusIds', () => {
  it('reads the kind of the task status', () => {
    expect(isTaskDone({ status_id: 'done' }, all)).toBe(true)
    expect(isTaskDone({ status_id: 'todo' }, all)).toBe(false)
    expect(isTaskDone({ status_id: 'missing' }, all)).toBe(false)
  })
  it('lists non-done ids', () => {
    expect(openStatusIds(all).sort()).toEqual(['doing', 'todo'])
  })
})

describe('validateStatusSet', () => {
  it('accepts the default seed', () => {
    expect(validateStatusSet([todo, doing, done])).toEqual([])
  })
  it('requires one of each kind', () => {
    const problems = validateStatusSet([todo, done])
    expect(problems).toContainEqual({ code: 'missing_kind', kind: 'in_progress' })
  })
  it('requires exactly one default', () => {
    expect(validateStatusSet([{ ...todo, is_default: false }, doing, done])).toContainEqual({
      code: 'no_default',
    })
    expect(validateStatusSet([todo, { ...doing, is_default: true }, done])).toContainEqual({
      code: 'multiple_defaults',
    })
  })
  it('flags empty names', () => {
    expect(validateStatusSet([{ ...todo, name: '  ' }, doing, done])).toContainEqual({
      code: 'empty_name',
      id: 'todo',
    })
  })
})

describe('canDeleteStatus', () => {
  it('allows deleting when another status of the kind remains', () => {
    expect(canDeleteStatus(all, 'done')).toBe(true)
    expect(canDeleteStatus(all, 'archived')).toBe(true)
  })
  it('refuses the last of a kind or an unknown id', () => {
    expect(canDeleteStatus(all, 'todo')).toBe(false)
    expect(canDeleteStatus(all, 'doing')).toBe(false)
    expect(canDeleteStatus(all, 'nope')).toBe(false)
  })
})

describe('positions and default flag helpers', () => {
  it('nextStatusPosition appends after the max', () => {
    expect(nextStatusPosition(all)).toBe(4)
    expect(nextStatusPosition([])).toBe(0)
  })
  it('withDefault flags exactly one', () => {
    const out = withDefault(all, 'doing')
    expect(out.filter((s) => s.is_default).map((s) => s.id)).toEqual(['doing'])
  })
  it('renumberPositions follows array order', () => {
    expect(renumberPositions([done, todo]).map((s) => s.position)).toEqual([0, 1])
  })
})
