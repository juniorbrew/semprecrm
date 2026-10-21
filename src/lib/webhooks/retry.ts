import { WEBHOOK_TEST_EVENT } from './events'

/**
 * Retry policy. Attempt 1 is immediate; after failure n the next attempt
 * waits RETRY_DELAYS_SECONDS[n-1] (+-10% jitter). 11 retries spread over
 * ~70 hours, and nothing is scheduled past 72 hours after the delivery was
 * created (same horizon as Stripe: "up to 3 days").
 */
export const RETRY_DELAYS_SECONDS = [60, 300, 900, 3600, 10_800, 21_600, 43_200, 43_200, 43_200, 43_200, 43_200]
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1
export const MAX_DELIVERY_AGE_MS = 72 * 3600 * 1000
/** An endpoint with no success for this long is disabled automatically. */
export const AUTO_DISABLE_AFTER_MS = 48 * 3600 * 1000

export type FailurePlan = { status: 'pending'; nextAttemptAt: Date } | { status: 'failed' }

/** `attemptsDone` counts the attempt that just failed. `rand` is injectable (0..1). */
export function planAfterFailure(opts: {
  attemptsDone: number
  deliveryCreatedAt: Date
  now: Date
  eventType?: string
  rand?: () => number
}): FailurePlan {
  // Test events are one-shot: the admin is watching and can click again.
  if (opts.eventType === WEBHOOK_TEST_EVENT) return { status: 'failed' }
  const base = RETRY_DELAYS_SECONDS[opts.attemptsDone - 1]
  if (base === undefined) return { status: 'failed' }
  const jitter = 0.9 + (opts.rand ?? Math.random)() * 0.2
  const next = new Date(opts.now.getTime() + Math.round(base * jitter) * 1000)
  if (next.getTime() - opts.deliveryCreatedAt.getTime() > MAX_DELIVERY_AGE_MS) return { status: 'failed' }
  return { status: 'pending', nextAttemptAt: next }
}

export function shouldAutoDisable(failingSince: Date | null, now: Date): boolean {
  return failingSince !== null && now.getTime() - failingSince.getTime() >= AUTO_DISABLE_AFTER_MS
}
