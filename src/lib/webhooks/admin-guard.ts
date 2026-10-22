import type { NextResponse } from 'next/server'

import { requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * Gate for the API-keys / webhooks admin routes: account admin or owner
 * only (keys and signing secrets are credentials), with the shared
 * admin-action rate limit per user.
 */
export async function requireAdmin(): Promise<{ ctx: AccountContext } | { response: NextResponse }> {
  let ctx: AccountContext
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return { response: toErrorResponse(err) }
  }
  const limit = checkRateLimit(`apiwebhooks:${ctx.userId}`, RATE_LIMITS.adminAction)
  if (!limit.success) return { response: rateLimitResponse(limit) }
  return { ctx }
}
