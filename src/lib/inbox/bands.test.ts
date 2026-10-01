import { describe, expect, it } from 'vitest'

import { bandOf, groupIntoBands, type BandRow, type InboxBand } from './bands'

const NOW = Date.parse('2026-03-02T15:00:00Z')
const at = (min: number) => new Date(NOW + min * 60_000).toISOString()

const row = (id: string, over: Partial<BandRow> = {}): BandRow => ({
  id,
  status: 'open',
  assigned_agent_id: 'agent-1',
  created_at: at(-120),
  last_message_at: at(-5),
  last_customer_message_at: at(-30),
  last_agent_message_at: at(-20),
  first_response_at: at(-20),
  first_response_due_at: null,
  first_response_warn_at: null,
  resolution_due_at: null,
  resolution_warn_at: null,
  ...over,
})

describe('bandOf', () => {
  it.each<[string, Partial<BandRow>, InboxBand]>([
    ['breached first-response SLA', { first_response_at: null, last_agent_message_at: null, first_response_due_at: at(-5), first_response_warn_at: at(-17) }, 'now'],
    ['SLA due in 10 min', { resolution_due_at: at(10), resolution_warn_at: at(-2) }, 'now'],
    ['SLA due in exactly 15 min is not yet "now"', { resolution_due_at: at(15), resolution_warn_at: at(3), last_customer_message_at: at(-1) }, 'ongoing'],
    ['breached SLA wins even when waiting on the customer', { resolution_due_at: at(-1), resolution_warn_at: at(-10) }, 'now'],
    ['no SLA, pending', { status: 'pending' }, 'you'],
    ['no SLA, nobody assigned', { assigned_agent_id: undefined }, 'you'],
    ['new: customer wrote, never answered', { first_response_at: null, last_agent_message_at: null, last_customer_message_at: at(-3) }, 'you'],
    ['unread, assigned and answered before: ongoing', { last_customer_message_at: at(-1), unread_count: 2 } as Partial<BandRow>, 'ongoing'],
    ['we spoke last: waiting on the customer', {}, 'customer'],
    ['outbound only, assigned', { last_customer_message_at: null, first_response_at: null }, 'customer'],
    ['far SLA, we spoke last', { resolution_due_at: at(240), resolution_warn_at: at(180) }, 'customer'],
    ['closed rows ignore the deadline', { status: 'closed', resolution_due_at: at(-60) }, 'customer'],
  ])('%s', (_name, over, band) => {
    expect(bandOf(row('x', over), NOW)).toBe(band)
  })
})

describe('groupIntoBands', () => {
  it('keeps band order, skips empty bands, sorts by nearest deadline then most recent', () => {
    const rows = [
      row('wait-old', { last_message_at: at(-60) }),
      row('wait-new', { last_message_at: at(-1) }),
      row('pending', { status: 'pending' }),
      row('late-2', { resolution_due_at: at(10), resolution_warn_at: at(0) }),
      row('late-1', { resolution_due_at: at(-3), resolution_warn_at: at(-13) }),
      row('pending-sla', { status: 'pending', resolution_due_at: at(120), resolution_warn_at: at(96) }),
    ]
    const groups = groupIntoBands(rows, NOW)
    expect(groups.map((g) => g.band)).toEqual(['now', 'you', 'customer'])
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([
      ['late-1', 'late-2'],
      ['pending-sla', 'pending'],
      ['wait-new', 'wait-old'],
    ])
  })

  it('is empty for an empty list and does not mutate its input', () => {
    expect(groupIntoBands([], NOW)).toEqual([])
    const rows = [row('b', { last_message_at: at(-9) }), row('a', { last_message_at: at(-1) })]
    groupIntoBands(rows, NOW)
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('groups a few hundred rows quickly', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      row(`c${i}`, {
        status: i % 7 === 0 ? 'pending' : 'open',
        last_message_at: at(-i),
        resolution_due_at: i % 3 === 0 ? at(i - 100) : null,
        resolution_warn_at: i % 3 === 0 ? at(i - 120) : null,
      }),
    )
    const t0 = performance.now()
    for (let k = 0; k < 20; k++) groupIntoBands(many, NOW)
    const perRun = (performance.now() - t0) / 20
    expect(groupIntoBands(many, NOW).reduce((n, g) => n + g.rows.length, 0)).toBe(500)
    expect(perRun).toBeLessThan(20)
  })
})
