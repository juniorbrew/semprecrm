import { describe, expect, it } from 'vitest'

import { countRadar } from './classify'
import {
  buildQueue,
  formatQueuePosition,
  formatQueueWait,
  isInQueue,
  queueIndex,
  queueWaitingSince,
} from './queue'

const NOW = new Date('2026-09-13T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
const hoursAgo = (h: number) => minutesAgo(h * 60)
const prefs = { inbox_sla_minutes: 15, cooling_hours: 24 }

type Conv = {
  id: string
  status: 'open' | 'pending' | 'closed'
  assigned_agent_id?: string
  last_customer_message_at?: string | null
  last_agent_message_at?: string | null
}

const conv = (id: string, over: Partial<Conv> = {}): Conv => ({
  id,
  status: 'open',
  last_customer_message_at: minutesAgo(5),
  last_agent_message_at: null,
  ...over,
})

describe('queue membership', () => {
  it('matches the Radar "unassigned" bucket exactly', () => {
    const list = [
      conv('a'),
      conv('b', { assigned_agent_id: 'u1' }),
      conv('c', { status: 'pending' }),
      conv('d', { status: 'closed' }),
      conv('e', { last_customer_message_at: null, last_agent_message_at: minutesAgo(3) }),
      conv('f', { last_agent_message_at: minutesAgo(1) }),
    ]
    const queue = buildQueue(list, prefs, NOW)
    expect(queue.map((e) => e.conversation.id).sort()).toEqual(['a', 'f'])
    expect(queue.length).toBe(countRadar(list, prefs, NOW).unassigned)
    expect(isInQueue(conv('b', { assigned_agent_id: 'u1' }), prefs, NOW)).toBe(false)
  })
})

describe('queue ordering and positions', () => {
  it('puts the longest wait first and numbers from 1', () => {
    const list = [
      conv('recent', { last_customer_message_at: minutesAgo(2) }),
      conv('oldest', { last_customer_message_at: hoursAgo(50) }),
      conv('middle', { last_customer_message_at: hoursAgo(3) }),
    ]
    const queue = buildQueue(list, prefs, NOW)
    expect(queue.map((e) => [e.conversation.id, e.position])).toEqual([
      ['oldest', 1],
      ['middle', 2],
      ['recent', 3],
    ])
    expect(queue[0].waitingSince?.toISOString()).toBe(hoursAgo(50))
  })

  it('places unowned conversations we answered last after the waiting ones', () => {
    const list = [
      // Bot replied after the customer: in the queue, nobody waiting.
      conv('answered', { last_customer_message_at: hoursAgo(10), last_agent_message_at: hoursAgo(9) }),
      conv('waiting', { last_customer_message_at: minutesAgo(1) }),
      conv('answered-older', { last_customer_message_at: hoursAgo(20), last_agent_message_at: hoursAgo(19) }),
    ]
    const queue = buildQueue(list, prefs, NOW)
    expect(queue.map((e) => e.conversation.id)).toEqual(['waiting', 'answered-older', 'answered'])
    expect(queue[0].waitingSince).not.toBeNull()
    expect(queue[1].waitingSince).toBeNull()
  })

  it('is stable for equal timestamps (id tie-break) and ignores input order', () => {
    const same = minutesAgo(30)
    const a = buildQueue([conv('b', { last_customer_message_at: same }), conv('a', { last_customer_message_at: same })], prefs, NOW)
    const b = buildQueue([conv('a', { last_customer_message_at: same }), conv('b', { last_customer_message_at: same })], prefs, NOW)
    expect(a.map((e) => e.conversation.id)).toEqual(['a', 'b'])
    expect(b.map((e) => e.conversation.id)).toEqual(['a', 'b'])
  })

  it('indexes entries by conversation id', () => {
    const index = queueIndex(buildQueue([conv('x'), conv('y', { last_customer_message_at: hoursAgo(1) })], prefs, NOW))
    expect(index.get('y')?.position).toBe(1)
    expect(index.get('x')?.position).toBe(2)
    expect(index.get('nope')).toBeUndefined()
  })

  it('treats a same-instant agent reply as answered (matches classify)', () => {
    const t = minutesAgo(10)
    expect(queueWaitingSince({ status: 'open', last_customer_message_at: t, last_agent_message_at: t })).toBeNull()
    expect(queueWaitingSince({ status: 'open', last_customer_message_at: 'garbage' })).toBeNull()
  })
})

describe('labels', () => {
  it('formats the position per language', () => {
    expect(formatQueuePosition(1, 'pt-BR')).toBe('1º')
    expect(formatQueuePosition(12, 'en-US')).toBe('#12')
  })

  it('formats the wait in minutes, hours and days', () => {
    expect(formatQueueWait(new Date(minutesAgo(12)), NOW, 'pt-BR')).toBe('Aguardando há 12 min')
    expect(formatQueueWait(new Date(hoursAgo(5)), NOW, 'pt-BR')).toBe('Aguardando há 5 h')
    expect(formatQueueWait(new Date(hoursAgo(24)), NOW, 'pt-BR')).toBe('Aguardando há 1 dia')
    expect(formatQueueWait(new Date(hoursAgo(50)), NOW, 'pt-BR')).toBe('Aguardando há 2 dias')
    expect(formatQueueWait(new Date(hoursAgo(50)), NOW, 'en-US')).toBe('Waiting 2d')
    // A clock skew never renders a negative wait.
    expect(formatQueueWait(NOW.getTime() + 60_000, NOW, 'en-US')).toBe('Waiting 0m')
  })
})
