import { describe, expect, it } from 'vitest'
import {
  advanceToLabel,
  closeDateInfo,
  movedToLabel,
  parseDateOnly,
  relativeTime,
} from './deal-dates'

const now = new Date(2026, 8, 12, 12, 0, 0).getTime() // 2026-09-12 noon local
const ago = (sec: number) => new Date(now - sec * 1000).toISOString()

describe('relativeTime', () => {
  it('renders pt-BR relative ages', () => {
    expect(relativeTime(ago(10), 'pt-BR', now)).toBe('agora')
    expect(relativeTime(ago(5 * 60), 'pt-BR', now)).toBe('há 5 min')
    expect(relativeTime(ago(3 * 3600), 'pt-BR', now)).toBe('há 3 h')
    expect(relativeTime(ago(2 * 86_400), 'pt-BR', now)).toBe('há 2 d')
  })

  it('renders en-US relative ages', () => {
    expect(relativeTime(ago(10), 'en-US', now)).toBe('just now')
    expect(relativeTime(ago(5 * 60), 'en-US', now)).toBe('5m ago')
    expect(relativeTime(ago(2 * 86_400), 'en-US', now)).toBe('2d ago')
  })

  it('returns empty for invalid input', () => {
    expect(relativeTime('nope', 'pt-BR', now)).toBe('')
  })
})

describe('parseDateOnly', () => {
  it('parses YYYY-MM-DD as a local calendar day', () => {
    const d = parseDateOnly('2026-09-18')
    expect(d?.getFullYear()).toBe(2026)
    expect(d?.getMonth()).toBe(8)
    expect(d?.getDate()).toBe(18)
  })

  it('returns null for garbage', () => {
    expect(parseDateOnly('not-a-date')).toBeNull()
  })
})

describe('closeDateInfo', () => {
  it('flags overdue dates', () => {
    const info = closeDateInfo('2026-09-10', 'pt-BR', now)
    expect(info?.tone).toBe('overdue')
    expect(info?.days).toBe(-2)
    expect(info?.short).toBe('Atrasado 2 d')
    expect(info?.long).toContain('atrasado 2 dias')
  })

  it('flags today', () => {
    const info = closeDateInfo('2026-09-12', 'pt-BR', now)
    expect(info?.tone).toBe('today')
    expect(info?.short).toBe('Hoje')
  })

  it('flags the next week as soon', () => {
    const info = closeDateInfo('2026-09-15', 'pt-BR', now)
    expect(info?.tone).toBe('soon')
    expect(info?.short).toBe('Em 3 d')
    expect(closeDateInfo('2026-09-13', 'en-US', now)?.long).toContain(
      'in 1 day',
    )
  })

  it('shows a short date for later dates', () => {
    const info = closeDateInfo('2026-10-30', 'pt-BR', now)
    expect(info?.tone).toBe('later')
    expect(info?.short).toMatch(/30/)
    expect(info?.long).toContain('em 48 dias')
  })

  it('returns null for invalid dates', () => {
    expect(closeDateInfo('x', 'pt-BR', now)).toBeNull()
  })
})

describe('stage labels', () => {
  it('localises the move / advance copy', () => {
    expect(movedToLabel('Negociação', 'pt-BR')).toBe('Movido para Negociação')
    expect(movedToLabel('Negotiation', 'en-US')).toBe('Moved to Negotiation')
    expect(advanceToLabel('Proposta', 'pt-BR')).toBe('Avançar para Proposta')
    expect(advanceToLabel('Proposal', 'en-US')).toBe('Advance to Proposal')
  })
})
