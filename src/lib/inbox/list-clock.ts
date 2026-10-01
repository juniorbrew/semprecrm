// ============================================================
// One shared clock for the inbox list's live SLA text and lines.
//
// A single interval for every subscriber (not one timer per row), started
// with the first subscriber and stopped with the last; paused while the
// tab is hidden and caught up the moment it is visible again. Readers use
// `useListClock(derive)`: React re-renders a reader only when its derived
// value changes, so a tick does not repaint the list.
// ============================================================

import { useCallback, useSyncExternalStore } from 'react'

export const LIST_CLOCK_MS = 1_000

let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function tick() {
  now = Date.now()
  for (const l of listeners) l()
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function sync() {
  const run = listeners.size > 0 && !hidden()
  if (run && !timer) {
    tick()
    timer = setInterval(tick, LIST_CLOCK_MS)
  } else if (!run && timer) {
    clearInterval(timer)
    timer = null
  }
}

export function subscribeListClock(listener: () => void): () => void {
  if (listeners.size === 0 && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', sync)
  }
  listeners.add(listener)
  sync()
  return () => {
    listeners.delete(listener)
    sync()
    if (listeners.size === 0 && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', sync)
    }
  }
}

export function listClockNow(): number {
  return now
}

/** Test hook: whether the shared interval is running. */
export function listClockRunning(): boolean {
  return timer !== null
}

/**
 * A value derived from the shared clock. `derive` must return a primitive
 * (string / number) so unchanged ticks bail out of rendering.
 */
export function useListClock<T extends string | number | boolean | null>(derive: (now: number) => T): T {
  const get = useCallback(() => derive(now), [derive])
  return useSyncExternalStore(subscribeListClock, get, get)
}
