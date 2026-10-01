import type { SlaTarget } from './sla'

/**
 * Share of the SLA target still left (1 = untouched, 0 = due or past), for
 * the contact panel's progress bar. The database stamps the warning at 80%
 * of the target elapsed (migration 072), so the full span is
 * (due − warn) / 0.2. Null without a warning stamp: no span to draw.
 */
export function slaRemainingFraction(target: SlaTarget, now: number): number | null {
  if (target.warnAt === null || target.warnAt >= target.dueAt) return null
  const span = (target.dueAt - target.warnAt) / 0.2
  return Math.min(1, Math.max(0, (target.dueAt - now) / span))
}
