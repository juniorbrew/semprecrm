import { describe, expect, it } from 'vitest'

import { WEBHOOK_TEST_EVENT } from './events'
import {
  AUTO_DISABLE_AFTER_MS,
  MAX_ATTEMPTS,
  MAX_DELIVERY_AGE_MS,
  RETRY_DELAYS_SECONDS,
  planAfterFailure,
  shouldAutoDisable,
} from './retry'

const T0 = new Date('2026-10-01T12:00:00Z')
const plan = (attemptsDone: number, now: Date, extra: Partial<Parameters<typeof planAfterFailure>[0]> = {}) =>
  planAfterFailure({ attemptsDone, deliveryCreatedAt: T0, now, rand: () => 0.5, ...extra })

describe('retry schedule', () => {
  it('backs off exponentially and stays within 3 days', () => {
    const total = RETRY_DELAYS_SECONDS.reduce((a, b) => a + b, 0) * 1000
    expect(total).toBeLessThan(MAX_DELIVERY_AGE_MS)
    expect(MAX_ATTEMPTS).toBe(12)
    for (let i = 1; i < RETRY_DELAYS_SECONDS.length; i++) {
      expect(RETRY_DELAYS_SECONDS[i]).toBeGreaterThanOrEqual(RETRY_DELAYS_SECONDS[i - 1])
    }
  })

  it('schedules the next attempt after the configured delay (rand 0.5 = no jitter)', () => {
    const p = plan(1, T0)
    expect(p).toEqual({ status: 'pending', nextAttemptAt: new Date(T0.getTime() + 60_000) })
    const p3 = plan(3, T0)
    expect(p3).toEqual({ status: 'pending', nextAttemptAt: new Date(T0.getTime() + 900_000) })
  })

  it('applies +-10% jitter', () => {
    const lo = plan(1, T0, { rand: () => 0 })
    const hi = plan(1, T0, { rand: () => 1 })
    expect(lo).toEqual({ status: 'pending', nextAttemptAt: new Date(T0.getTime() + 54_000) })
    expect(hi).toEqual({ status: 'pending', nextAttemptAt: new Date(T0.getTime() + 66_000) })
  })

  it('walks the whole schedule and then gives up', () => {
    let now = T0
    let attempts = 0
    for (;;) {
      attempts += 1
      const p = plan(attempts, now)
      if (p.status === 'failed') break
      now = p.nextAttemptAt
    }
    expect(attempts).toBe(MAX_ATTEMPTS)
    expect(now.getTime() - T0.getTime()).toBeLessThanOrEqual(MAX_DELIVERY_AGE_MS)
  })

  it('gives up when the next attempt would pass 72h after creation', () => {
    const late = new Date(T0.getTime() + MAX_DELIVERY_AGE_MS - 30_000)
    expect(plan(1, late)).toEqual({ status: 'failed' })
  })

  it('retries an endpoint that has been failing for an hour half as often', () => {
    expect(plan(1, T0, { endpointFailingMs: 3600_000 - 1 })).toEqual({ status: 'pending', nextAttemptAt: new Date(T0.getTime() + 60_000) })
    expect(plan(1, T0, { endpointFailingMs: 3600_000 })).toEqual({ status: 'pending', nextAttemptAt: new Date(T0.getTime() + 120_000) })
  })

  it('never retries test events', () => {
    expect(plan(1, T0, { eventType: WEBHOOK_TEST_EVENT })).toEqual({ status: 'failed' })
  })
})

describe('auto-disable', () => {
  it('disables an endpoint failing for 48h or more, not before', () => {
    expect(shouldAutoDisable(null, T0)).toBe(false)
    expect(shouldAutoDisable(new Date(T0.getTime() - AUTO_DISABLE_AFTER_MS + 1), T0)).toBe(false)
    expect(shouldAutoDisable(new Date(T0.getTime() - AUTO_DISABLE_AFTER_MS), T0)).toBe(true)
  })
})
