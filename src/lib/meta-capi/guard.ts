// Gate of the admin routes of "Avisar a Meta": account admin or owner only (the token is a credential),
// writable account for anything that changes data or sends, and the shared admin-action rate limit.
import type { NextResponse } from 'next/server'

import { requireRole, requireWritable, toErrorResponse, type AccountContext } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

async function gate(
  opts: { write: boolean },
): Promise<{ ctx: AccountContext } | { response: NextResponse }> {
  let ctx: AccountContext
  try {
    ctx = await requireRole('admin')
    if (opts.write) await requireWritable(ctx)
  } catch (err) {
    return { response: toErrorResponse(err) }
  }
  const limit = checkRateLimit(`metacapi:${ctx.userId}`, RATE_LIMITS.adminAction)
  if (!limit.success) return { response: rateLimitResponse(limit) }
  return { ctx }
}

/** Read-only screens: a read-only account may still look. */
export const requireCapiAdmin = () => gate({ write: false })
/** Anything that changes data or sends: refuses read-only and blocked accounts (094). */
export const requireWritableCapiAdmin = () => gate({ write: true })
