import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { debounceWithMaxWait } from './throttle'

describe('debounceWithMaxWait', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('merges a burst into one trailing call', () => {
    const fn = vi.fn()
    const d = debounceWithMaxWait(fn, 300, 2000)
    d.call()
    d.call()
    vi.advanceTimersByTime(299)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('first fire in a steady stream lands by maxWait', () => {
    const fn = vi.fn()
    const d = debounceWithMaxWait(fn, 300, 2000)
    let firedAt = -1
    fn.mockImplementation(() => {
      if (firedAt < 0) firedAt = Date.now() - start
    })
    const start = Date.now()
    for (let t = 0; t < 3000 && firedAt < 0; t += 100) {
      d.call()
      vi.advanceTimersByTime(100)
    }
    expect(firedAt).toBeGreaterThan(0)
    expect(firedAt).toBeLessThanOrEqual(2100)
  })

  it('cancel drops the pending call', () => {
    const fn = vi.fn()
    const d = debounceWithMaxWait(fn, 300, 2000)
    d.call()
    d.cancel()
    vi.advanceTimersByTime(5000)
    expect(fn).not.toHaveBeenCalled()
  })
})
