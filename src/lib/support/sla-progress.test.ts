import { describe, expect, it } from 'vitest'
import { slaRemainingFraction } from './sla-progress'

const MIN = 60_000

describe('slaRemainingFraction', () => {
  // 60 min target: warn stamped at 48 min elapsed (80%).
  const target = { kind: 'first_response' as const, dueAt: 60 * MIN, warnAt: 48 * MIN }

  it('is the share of the target still left', () => {
    expect(slaRemainingFraction(target, 0)).toBe(1)
    expect(slaRemainingFraction(target, 30 * MIN)).toBeCloseTo(0.5)
    expect(slaRemainingFraction(target, 48 * MIN)).toBeCloseTo(0.2)
  })

  it('clamps at 0 once due and has no bar without a warning stamp', () => {
    expect(slaRemainingFraction(target, 90 * MIN)).toBe(0)
    expect(slaRemainingFraction({ ...target, warnAt: null }, 0)).toBeNull()
    expect(slaRemainingFraction({ ...target, warnAt: 60 * MIN }, 0)).toBeNull()
  })
})
