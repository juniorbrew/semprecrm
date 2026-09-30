/**
 * Debounce with a maximum wait: calls inside `wait` ms of each other are
 * merged into one, but a steady stream still fires at least every `maxWait`
 * ms. A plain trailing debounce starves under a busy inbox (every realtime
 * event resets the timer and the badges never refresh).
 */
export interface MaxWaitDebounce {
  call: () => void
  cancel: () => void
}

export function debounceWithMaxWait(fn: () => void, wait: number, maxWait: number): MaxWaitDebounce {
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstCallAt = 0

  const fire = () => {
    timer = null
    firstCallAt = 0
    fn()
  }

  return {
    call() {
      const now = Date.now()
      if (timer === null) firstCallAt = now
      else clearTimeout(timer)
      timer = setTimeout(fire, Math.max(0, Math.min(wait, firstCallAt + maxWait - now)))
    },
    cancel() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      firstCallAt = 0
    },
  }
}
