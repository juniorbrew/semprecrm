import { hasMinRole, type AccountRole } from '@/lib/auth/roles'

/**
 * A scheduled message goes out under its author's name, so only the author
 * or an admin+ may edit, cancel, send now or retry it (another agent could
 * otherwise put words in the author's mouth).
 */
export function canManageScheduled(role: AccountRole, userId: string, createdBy: string): boolean {
  return userId === createdBy || hasMinRole(role, 'admin')
}

/** Error code for rows parked by the sweep: the send may already have happened. */
export const MAYBE_SENT = 'maybe_sent'
