/** When the official channel's 24 h free-text window closes; null when it never opened. */
export function windowEndsAt(lastCustomerAt: string | null | undefined): string | null {
  if (!lastCustomerAt) return null
  const t = new Date(lastCustomerAt).getTime()
  return Number.isNaN(t) ? null : new Date(t + 24 * 3_600_000).toISOString()
}
