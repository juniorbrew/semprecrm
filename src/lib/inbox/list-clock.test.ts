import { afterEach, describe, expect, it, vi } from 'vitest'

import { listClockNow, listClockRunning, subscribeListClock } from './list-clock'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('shared list clock', () => {
  it('one interval for every subscriber, stopped with the last one', () => {
    vi.useFakeTimers()
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeListClock(a)
    const offB = subscribeListClock(b)
    expect(setSpy).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3_000)
    expect(b.mock.calls.length).toBeGreaterThanOrEqual(3)
    offA()
    expect(listClockRunning()).toBe(true)
    offB()
    expect(listClockRunning()).toBe(false)
  })

  it('pauses while the tab is hidden and catches up when visible', () => {
    vi.useFakeTimers()
    const handlers: (() => void)[] = []
    const doc = {
      visibilityState: 'visible',
      addEventListener: (_: string, h: () => void) => handlers.push(h),
      removeEventListener: () => {},
    }
    vi.stubGlobal('document', doc)
    const fn = vi.fn()
    const off = subscribeListClock(fn)
    expect(listClockRunning()).toBe(true)
    doc.visibilityState = 'hidden'
    handlers.forEach((h) => h())
    expect(listClockRunning()).toBe(false)
    fn.mockClear()
    vi.advanceTimersByTime(5_000)
    expect(fn).not.toHaveBeenCalled()
    doc.visibilityState = 'visible'
    handlers.forEach((h) => h())
    expect(listClockRunning()).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(listClockNow()).toBe(Date.now())
    off()
  })
})
