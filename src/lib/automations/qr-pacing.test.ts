import { beforeEach, describe, expect, it } from 'vitest'

import { paceAutomatedQrSend, resetQrPacing } from './qr-pacing'

describe('paceAutomatedQrSend', () => {
  beforeEach(() => resetQrPacing())

  it('spaces a burst of sends for one account in call order', async () => {
    const waits: number[] = []
    const deps = { now: () => 10_000, sleep: async () => {}, random: () => 0 }
    for (let i = 0; i < 4; i++) waits.push(await paceAutomatedQrSend('acct-a', deps))
    expect(waits).toEqual([0, 1200, 2400, 3600])
  })

  it('adds jitter of up to 40% of the spacing', async () => {
    const deps = { now: () => 0, sleep: async () => {}, random: () => 0.999 }
    await paceAutomatedQrSend('acct-a', deps)
    const wait = await paceAutomatedQrSend('acct-a', deps)
    expect(wait).toBeGreaterThan(1200)
    expect(wait).toBeLessThanOrEqual(1680)
  })

  it('does not make one account wait for another', async () => {
    const deps = { now: () => 0, sleep: async () => {}, random: () => 0 }
    await paceAutomatedQrSend('acct-a', deps)
    expect(await paceAutomatedQrSend('acct-b', deps)).toBe(0)
  })

  it('does not wait once the previous slot is in the past', async () => {
    let t = 0
    const deps = { now: () => t, sleep: async () => {}, random: () => 0 }
    await paceAutomatedQrSend('acct-a', deps)
    t = 5_000
    expect(await paceAutomatedQrSend('acct-a', deps)).toBe(0)
  })
})
