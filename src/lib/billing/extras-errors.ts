/** Extras changes per account in 24 h (each one edits a real subscription in Asaas). */
export const MAX_EXTRAS_CHANGES_PER_DAY = 10
/** An annual add not paid within this many days is cancelled by the sweep. */
export const ONE_OFF_EXPIRES_DAYS = 7
/** Days to pay the one-off charge (its due date). */
export const ONE_OFF_DUE_DAYS = 3

export const EXTRAS_ERRORS = {
  notConfigured: 'Online payment is not available yet. Talk to the SempreCRM team.',
  body: 'Choose what to change and how many.',
  unavailable: 'Extras are only available on an active paid subscription. Subscribe first, or wait until the payment is confirmed.',
  notOffered: 'Your plan does not offer this extra. Talk to the SempreCRM team.',
  unlimited: 'Your plan has no limit here, so there is nothing to add.',
  cap: 'You reached the maximum number of extras. Talk to the SempreCRM team.',
  belowUsage: 'You are using more than the new limit would allow. Free up a user or number first.',
  pendingRemoval: 'A removal is already scheduled. Cancel it first to change the extras.',
  noPendingRemoval: 'There is no scheduled removal to cancel.',
  removalLocked: 'The removal is already in your next charge, so it cannot be cancelled. Once it takes effect, buy the extra again.',
  pendingPurchase: 'A purchase is waiting for payment. Pay it, or wait until it expires, before changing the extras.',
  overdue: 'Regularize the pending payment first.',
  tooMany: 'Too many changes in the last 24 hours. Try again tomorrow or talk to the SempreCRM team.',
  conflict: 'Your subscription changed while you were doing this. Reload the page and try again.',
  provider: 'Could not change it right now, try again.',
} as const
