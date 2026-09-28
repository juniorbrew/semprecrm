import { beforeEach, describe, expect, it, vi } from 'vitest'

// ------------------------------------------------------------
// notifyTaskReminders (inbox "Lembrar", migration 057) and the due-soon
// scan leaving reminder tasks to it. The service-role client is a
// recorder; the Web Push sender is mocked.
// ------------------------------------------------------------

const h = vi.hoisted(() => ({
  send: vi.fn(async (...args: [admin: unknown, users: string[], payload: unknown]) => ({
    users: args[1].length,
    sent: args[1].length,
    failed: 0,
    removed: 0,
    configured: true,
  })),
}))

vi.mock('./send', () => ({ sendPushToUsers: h.send }))

import { notifyTaskReminders, notifyTasksDueSoon } from './notify'

const NOW = new Date('2026-09-27T12:00:00Z')

type Row = Record<string, unknown>

function fakeAdmin(opts: {
  scan: { data: Row[] | null; error?: { code?: string; message: string } | null }
  /** Task ids another tick already claimed. */
  lost?: string[]
  profiles?: Row[]
}) {
  const scans: [string, ...unknown[]][][] = []
  const claims: string[] = []
  const admin = {
    from(table: string) {
      const ops: [string, ...unknown[]][] = []
      let mode: 'select' | 'update' = 'select'
      let claimId = ''
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'is', 'not', 'gte', 'lte', 'order', 'limit', 'in']) {
        b[op] = (...args: unknown[]) => (ops.push([op, ...args]), b)
      }
      b.update = () => ((mode = 'update'), b)
      b.eq = (k: string, v: unknown) => {
        if (k === 'id') claimId = String(v)
        ops.push(['eq', k, v])
        return b
      }
      b.maybeSingle = async () => {
        if (mode === 'update') {
          claims.push(claimId)
          return { data: opts.lost?.includes(claimId) ? null : { id: claimId }, error: null }
        }
        return { data: null, error: null }
      }
      b.then = (res: (v: unknown) => unknown) => {
        if (table === 'tasks') {
          scans.push(ops)
          return Promise.resolve({ data: opts.scan.data, error: opts.scan.error ?? null }).then(res)
        }
        if (table === 'profiles') {
          return Promise.resolve({
            data: opts.profiles ?? [
              { user_id: 'agent-1', account_id: 'acc-1', account_role: 'agent', availability: 'available', notification_prefs: {} },
            ],
            error: null,
          }).then(res)
        }
        return Promise.resolve({ data: [], error: null }).then(res)
      }
      return b
    },
  }
  return { admin: admin as never, scans, claims }
}

const reminder = (over: Row = {}): Row => ({
  id: 'task-1',
  account_id: 'acc-1',
  title: 'Lembrete: Maria',
  description: 'Retornar sobre o orçamento',
  assignee_user_id: 'agent-1',
  remind_at: '2026-09-27T11:59:00Z',
  conversation_id: 'conv-1',
  ...over,
})

beforeEach(() => {
  h.send.mockClear()
})

describe('notifyTaskReminders', () => {
  it('scans due, unclaimed, open reminders of the last hour and pushes to the assignee', async () => {
    const { admin, scans, claims } = fakeAdmin({ scan: { data: [reminder()] } })
    await expect(notifyTaskReminders(admin, NOW)).resolves.toEqual({ scanned: 1, notified: 1 })

    const ops = scans[0]
    expect(ops).toContainEqual(['is', 'reminded_at', null])
    expect(ops).toContainEqual(['is', 'completed_at', null])
    expect(ops).toContainEqual(['lte', 'remind_at', NOW.toISOString()])
    expect(ops).toContainEqual(['gte', 'remind_at', new Date(NOW.getTime() - 3_600_000).toISOString()])
    expect(claims).toEqual(['task-1'])

    const [, users, payload] = h.send.mock.calls[0]
    expect(users).toEqual(['agent-1'])
    expect(payload).toMatchObject({
      title: '⏰ Lembrete: Maria',
      body: 'Retornar sobre o orçamento',
      // Opens the conversation, not the task.
      url: '/inbox?c=conv-1',
      tag: 'task:task-1',
    })
  })

  it('falls back to the task page and a generic body without conversation / note', async () => {
    const { admin } = fakeAdmin({ scan: { data: [reminder({ conversation_id: null, description: null })] } })
    await notifyTaskReminders(admin, NOW)
    expect(h.send.mock.calls[0][2]).toMatchObject({ url: '/tasks?task=task-1', body: 'Lembrete' })
  })

  it('never double-sends a row another tick claimed', async () => {
    const { admin } = fakeAdmin({ scan: { data: [reminder()] }, lost: ['task-1'] })
    await expect(notifyTaskReminders(admin, NOW)).resolves.toEqual({ scanned: 1, notified: 0 })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('respects the assignee turning task pushes off', async () => {
    const { admin } = fakeAdmin({
      scan: { data: [reminder()] },
      profiles: [
        { user_id: 'agent-1', account_id: 'acc-1', account_role: 'agent', availability: 'available', notification_prefs: { task_due: false } },
      ],
    })
    await expect(notifyTaskReminders(admin, NOW)).resolves.toEqual({ scanned: 1, notified: 0 })
    expect(h.send).not.toHaveBeenCalled()
  })

  it('skips quietly on a pre-057 schema', async () => {
    const { admin } = fakeAdmin({ scan: { data: null, error: { code: '42703', message: 'column tasks.remind_at does not exist' } } })
    await expect(notifyTaskReminders(admin, NOW)).resolves.toEqual({ scanned: 0, notified: 0 })
  })
})

describe('notifyTasksDueSoon leaves reminder tasks to notifyTaskReminders', () => {
  it('skips rows with remind_at and still warns plain tasks', async () => {
    const { admin, claims } = fakeAdmin({
      scan: {
        data: [
          { id: 'reminder', account_id: 'acc-1', title: 'Lembrete', assignee_user_id: 'agent-1', due_at: '2026-09-27T12:05:00Z', remind_at: '2026-09-27T12:05:00Z' },
          { id: 'plain', account_id: 'acc-1', title: 'Ligar', assignee_user_id: 'agent-1', due_at: '2026-09-27T12:05:00Z' },
        ],
      },
    })
    await expect(notifyTasksDueSoon(admin, NOW)).resolves.toEqual({ scanned: 1, notified: 1 })
    expect(claims).toEqual(['plain'])
  })
})
