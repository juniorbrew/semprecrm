import { describe, expect, it } from 'vitest'

import {
  classifyConversation,
  countRadar,
  formatWaitingAge,
  isRadarKey,
  matchesRadar,
} from './classify'

const NOW = new Date('2026-09-13T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
const hoursAgo = (h: number) => minutesAgo(h * 60)

const prefs = { inbox_sla_minutes: 15, cooling_hours: 24 }

describe('classifyConversation', () => {
  it('flags waiting when the customer spoke last and the SLA has passed', () => {
    const c = classifyConversation(
      {
        status: 'open',
        assigned_agent_id: 'u1',
        last_customer_message_at: minutesAgo(20),
        last_agent_message_at: minutesAgo(60),
      },
      prefs,
      NOW,
    )
    expect(c.waiting).toBe(true)
    expect(c.waitingSince?.toISOString()).toBe(minutesAgo(20))
    expect(c.cooling).toBe(false)
    expect(c.unassigned).toBe(false)
  })

  it('is not waiting inside the SLA window', () => {
    const c = classifyConversation(
      { status: 'open', last_customer_message_at: minutesAgo(10), last_agent_message_at: null },
      prefs,
      NOW,
    )
    expect(c.waiting).toBe(false)
  })

  it('treats a never-answered conversation as customer-last', () => {
    const c = classifyConversation(
      { status: 'pending', last_customer_message_at: minutesAgo(30), last_agent_message_at: null },
      prefs,
      NOW,
    )
    expect(c.waiting).toBe(true)
  })

  it('never flags a closed conversation as waiting or cooling', () => {
    const c = classifyConversation(
      {
        status: 'closed',
        last_customer_message_at: hoursAgo(5),
        last_agent_message_at: hoursAgo(48),
      },
      prefs,
      NOW,
    )
    expect(c).toEqual({ waiting: false, unassigned: false, cooling: false })
  })

  it('flags unassigned only for open conversations with a customer message', () => {
    expect(
      classifyConversation(
        { status: 'open', last_customer_message_at: minutesAgo(1) },
        prefs,
        NOW,
      ).unassigned,
    ).toBe(true)
    expect(
      classifyConversation(
        { status: 'pending', last_customer_message_at: minutesAgo(1) },
        prefs,
        NOW,
      ).unassigned,
    ).toBe(false)
    expect(
      classifyConversation(
        { status: 'open', last_customer_message_at: null, last_agent_message_at: minutesAgo(1) },
        prefs,
        NOW,
      ).unassigned,
    ).toBe(false)
    expect(
      classifyConversation(
        { status: 'open', assigned_agent_id: 'u1', last_customer_message_at: minutesAgo(1) },
        prefs,
        NOW,
      ).unassigned,
    ).toBe(false)
  })

  it('flags cooling when the agent spoke last and the customer went quiet', () => {
    const c = classifyConversation(
      {
        status: 'open',
        assigned_agent_id: 'u1',
        last_customer_message_at: hoursAgo(30),
        last_agent_message_at: hoursAgo(25),
      },
      prefs,
      NOW,
    )
    expect(c.cooling).toBe(true)
    expect(c.coolingSince?.toISOString()).toBe(hoursAgo(25))
    expect(c.waiting).toBe(false)
  })

  it('is not cooling before cooling_hours elapse', () => {
    const c = classifyConversation(
      { status: 'open', last_customer_message_at: hoursAgo(30), last_agent_message_at: hoursAgo(2) },
      prefs,
      NOW,
    )
    expect(c.cooling).toBe(false)
  })

  it('respects account preferences', () => {
    const conv = {
      status: 'open' as const,
      last_customer_message_at: minutesAgo(20),
      last_agent_message_at: null,
    }
    expect(classifyConversation(conv, { inbox_sla_minutes: 30, cooling_hours: 24 }, NOW).waiting).toBe(
      false,
    )
    expect(classifyConversation(conv, { inbox_sla_minutes: 5, cooling_hours: 24 }, NOW).waiting).toBe(
      true,
    )
  })

  it('ignores unparsable timestamps', () => {
    const c = classifyConversation(
      { status: 'open', last_customer_message_at: 'garbage', last_agent_message_at: null },
      prefs,
      NOW,
    )
    expect(c).toEqual({ waiting: false, unassigned: false, cooling: false })
  })
})

describe('countRadar', () => {
  it('counts each bucket and tracks the oldest waiting / cooling case', () => {
    const counts = countRadar(
      [
        { status: 'open', last_customer_message_at: minutesAgo(20) }, // waiting + unassigned
        { status: 'open', assigned_agent_id: 'u1', last_customer_message_at: minutesAgo(90) }, // waiting (oldest)
        { status: 'open', assigned_agent_id: 'u1', last_customer_message_at: minutesAgo(5) }, // fresh
        {
          status: 'pending',
          last_customer_message_at: hoursAgo(50),
          last_agent_message_at: hoursAgo(40),
        }, // cooling
        {
          status: 'open',
          assigned_agent_id: 'u2',
          last_customer_message_at: hoursAgo(50),
          last_agent_message_at: hoursAgo(30),
        }, // cooling
        { status: 'closed', last_customer_message_at: hoursAgo(50) },
      ],
      prefs,
      NOW,
    )
    expect(counts.waiting).toBe(2)
    expect(counts.unassigned).toBe(1)
    expect(counts.cooling).toBe(2)
    expect(counts.oldestWaitingSince?.toISOString()).toBe(minutesAgo(90))
    expect(counts.oldestCoolingSince?.toISOString()).toBe(hoursAgo(40))
  })

  it('returns zeros and nulls for an empty list', () => {
    expect(countRadar([], prefs, NOW)).toEqual({
      waiting: 0,
      unassigned: 0,
      cooling: 0,
      oldestWaitingSince: null,
      oldestCoolingSince: null,
    })
  })
})

describe('helpers', () => {
  it('matchesRadar picks the requested bucket', () => {
    const conv = { status: 'open' as const, last_customer_message_at: minutesAgo(20) }
    expect(matchesRadar(conv, 'waiting', prefs, NOW)).toBe(true)
    expect(matchesRadar(conv, 'unassigned', prefs, NOW)).toBe(true)
    expect(matchesRadar(conv, 'cooling', prefs, NOW)).toBe(false)
  })

  it('isRadarKey guards the query param', () => {
    expect(isRadarKey('waiting')).toBe(true)
    expect(isRadarKey('nope')).toBe(false)
    expect(isRadarKey(null)).toBe(false)
  })

  it('formatWaitingAge is compact in both languages', () => {
    expect(formatWaitingAge(NOW.getTime() - 12 * 60_000, NOW, 'pt-BR')).toBe('há 12 min')
    expect(formatWaitingAge(NOW.getTime() - 12 * 60_000, NOW, 'en-US')).toBe('12m ago')
    expect(formatWaitingAge(NOW.getTime() - 3 * 3_600_000, NOW, 'pt-BR')).toBe('há 3 h')
    expect(formatWaitingAge(NOW.getTime() - 2 * 86_400_000, NOW, 'en-US')).toBe('2d ago')
  })
})
