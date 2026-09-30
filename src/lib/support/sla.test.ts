import { describe, expect, it } from 'vitest'

import {
  activeSlaTarget,
  formatSlaSpan,
  isSlaBreached,
  joinMinutes,
  slaLabel,
  slaLevel,
  splitMinutes,
  type SlaFields,
} from './sla'

const NOW = Date.parse('2026-03-02T15:00:00Z')
const at = (minFromNow: number) => new Date(NOW + minFromNow * 60_000).toISOString()

const fresh = (over: Partial<SlaFields> = {}): SlaFields => ({
  status: 'open',
  last_customer_message_at: at(-10),
  first_response_at: null,
  first_response_due_at: at(60),
  first_response_warn_at: at(48),
  resolution_due_at: at(480),
  resolution_warn_at: at(384),
  ...over,
})

describe('activeSlaTarget', () => {
  it('waits for the first response, then for the resolution', () => {
    expect(activeSlaTarget(fresh())?.kind).toBe('first_response')
    expect(activeSlaTarget(fresh({ first_response_at: at(-5) }))?.kind).toBe('resolution')
  })

  it('is null without a policy (old rows, accounts without deadlines) and once closed', () => {
    expect(activeSlaTarget({ status: 'open' })).toBeNull()
    expect(activeSlaTarget(fresh({ first_response_due_at: null, resolution_due_at: null }))).toBeNull()
    expect(activeSlaTarget(fresh({ status: 'closed' }))).toBeNull()
  })

  it('only a resolution deadline: that is what the row waits for', () => {
    expect(activeSlaTarget(fresh({ first_response_due_at: null, first_response_warn_at: null }))?.kind).toBe('resolution')
  })

  it('ignores unparsable timestamps', () => {
    expect(activeSlaTarget(fresh({ first_response_due_at: 'nope', resolution_due_at: null }))).toBeNull()
  })
})

describe('slaLevel', () => {
  const t = activeSlaTarget(fresh())!
  it('is ok while more than 20% is left, amber from 80% used, red once missed', () => {
    expect(slaLevel(t, NOW)).toBe('ok')
    expect(slaLevel(t, NOW + 47 * 60_000)).toBe('ok')
    expect(slaLevel(t, NOW + 48 * 60_000)).toBe('warning')
    expect(slaLevel(t, NOW + 59 * 60_000)).toBe('warning')
    expect(slaLevel(t, NOW + 60 * 60_000)).toBe('breached')
    expect(slaLevel(t, NOW + 600 * 60_000)).toBe('breached')
  })

  it('a target without a warning mark goes straight from ok to breached', () => {
    const noWarn = activeSlaTarget(fresh({ first_response_warn_at: null }))!
    expect(slaLevel(noWarn, NOW + 59 * 60_000)).toBe('ok')
    expect(slaLevel(noWarn, NOW + 60 * 60_000)).toBe('breached')
  })
})

describe('isSlaBreached (mirror of the SQL filter)', () => {
  it('a pending first-response target past its due date', () => {
    expect(isSlaBreached(fresh({ first_response_due_at: at(-1) }), NOW)).toBe(true)
    expect(isSlaBreached(fresh(), NOW)).toBe(false)
  })
  it('an answered conversation only breaches through the resolution target', () => {
    expect(isSlaBreached(fresh({ first_response_at: at(-30), first_response_due_at: at(-10) }), NOW)).toBe(false)
    expect(isSlaBreached(fresh({ first_response_at: at(-30), first_response_due_at: at(-10), resolution_due_at: at(-1) }), NOW)).toBe(true)
  })
  it('an agent-started conversation cannot breach the first response before the customer writes', () => {
    expect(isSlaBreached(fresh({ last_customer_message_at: null, first_response_due_at: at(-100) }), NOW)).toBe(false)
    // ...but its resolution deadline still can.
    expect(isSlaBreached(fresh({ last_customer_message_at: null, first_response_due_at: at(-100), resolution_due_at: at(-1) }), NOW)).toBe(true)
  })
  it('closed conversations never count', () => {
    expect(isSlaBreached(fresh({ status: 'closed', first_response_due_at: at(-100), resolution_due_at: at(-100) }), NOW)).toBe(false)
  })
  it('no deadlines, no breach', () => {
    expect(isSlaBreached({ status: 'open' }, NOW)).toBe(false)
  })
})

describe('labels', () => {
  it('formats a span compactly', () => {
    expect(formatSlaSpan(80 * 60_000, 'pt-BR')).toBe('1h 20min')
    expect(formatSlaSpan(45 * 60_000, 'pt-BR')).toBe('45min')
    expect(formatSlaSpan(120 * 60_000, 'pt-BR')).toBe('2h')
    expect(formatSlaSpan(27 * 3_600_000, 'pt-BR')).toBe('1d 3h')
    expect(formatSlaSpan(48 * 3_600_000, 'pt-BR')).toBe('2d')
    expect(formatSlaSpan(20_000, 'pt-BR')).toBe('menos de 1 min')
    expect(formatSlaSpan(20_000, 'en-US')).toBe('under 1 min')
  })

  it('says how long is left, or how long ago it was missed', () => {
    const t = activeSlaTarget(fresh())!
    expect(slaLabel(t, NOW, 'pt-BR')).toBe('1h')
    expect(slaLabel(t, NOW + 40 * 60_000, 'pt-BR')).toBe('20min')
    expect(slaLabel(t, NOW + 75 * 60_000, 'pt-BR')).toBe('estourado há 15min')
    expect(slaLabel(t, NOW + 75 * 60_000, 'en-US')).toBe('15min overdue')
  })
})

describe('policy inputs', () => {
  it('round-trips minutes <-> value + unit', () => {
    expect(splitMinutes(null)).toEqual({ value: '', unit: 'h' })
    expect(splitMinutes(120)).toEqual({ value: '2', unit: 'h' })
    expect(splitMinutes(90)).toEqual({ value: '90', unit: 'min' })
    expect(splitMinutes(30)).toEqual({ value: '30', unit: 'min' })
    expect(joinMinutes('2', 'h')).toBe(120)
    expect(joinMinutes('1,5', 'h')).toBe(90)
    expect(joinMinutes('45', 'min')).toBe(45)
  })
  it('empty or unusable input means no deadline', () => {
    for (const v of ['', '  ', '0', '-3', 'abc']) expect(joinMinutes(v, 'h')).toBeNull()
  })
})
