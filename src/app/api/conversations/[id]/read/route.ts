import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { ConversationNotFoundError, sendReadReceipts } from '@/lib/whatsapp/read-receipts'

/**
 * POST /api/conversations/:id/read — the agent has the conversation
 * open: confirm the customer's new messages as read on WhatsApp (blue
 * ✓✓). Called by the inbox, fire-and-forget; idempotent.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let accountId: string
  let userId: string
  try {
    ;({ accountId, userId } = await getCurrentAccount())
  } catch (err) {
    return toErrorResponse(err)
  }
  // Each call forwards a read receipt to Meta / the QR gateway.
  const limit = checkRateLimit(`conversation-read:${userId}`, RATE_LIMITS.markRead)
  if (!limit.success) return rateLimitResponse(limit)

  try {
    // Service client: the conversation lookup inside is scoped to the
    // caller's account, resolved from the session above.
    const result = await sendReadReceipts(supabaseAdmin(), { accountId, conversationId: id })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error('[read-receipts] failed:', id, message)
    return NextResponse.json({ error: 'Failed to send read receipts' }, { status: 502 })
  }
}
