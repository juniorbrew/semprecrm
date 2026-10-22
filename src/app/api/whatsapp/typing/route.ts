import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils'
import { presenceViaGateway } from '@/lib/whatsapp/qr-gateway'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST /api/whatsapp/typing
 *
 * Body: `{ conversation_id, state: 'composing' | 'paused' }` — shows
 * (or clears) "digitando..." on the customer's phone. QR channel only:
 * the Cloud API has no standalone typing indicator, so official
 * conversations answer `{ ok: true, skipped: true }`. Best-effort — the
 * composer ignores failures.
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const limit = checkRateLimit(`typing:${ctx.userId}`, RATE_LIMITS.typing)
  if (!limit.success) return rateLimitResponse(limit)

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : ''
  const state = body.state
  if (!conversationId || (state !== 'composing' && state !== 'paused')) {
    return NextResponse.json(
      { error: 'conversation_id and state (composing|paused) are required' },
      { status: 400 },
    )
  }

  const { data: conversation } = await ctx.supabase
    .from('conversations')
    .select('channel, contact:contacts(phone)')
    .eq('id', conversationId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }
  if (conversation.channel !== 'qr') {
    return NextResponse.json({ ok: true, skipped: true })
  }
  const contact = Array.isArray(conversation.contact) ? conversation.contact[0] : conversation.contact
  if (!contact?.phone) {
    return NextResponse.json({ ok: true, skipped: true })
  }

  try {
    await presenceViaGateway({
      accountId: ctx.accountId,
      to: sanitizePhoneForMeta(contact.phone),
      state,
    })
  } catch {
    // Offline session / gateway down: nothing for the agent to fix here.
    return NextResponse.json({ ok: false })
  }
  return NextResponse.json({ ok: true })
}
