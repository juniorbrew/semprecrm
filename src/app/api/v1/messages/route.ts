import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { apiError, authenticateApiKey } from '@/lib/api-keys/auth'
import { ApiSendError, sendTextViaApi } from '@/lib/api-keys/send-message'

export const dynamic = 'force-dynamic'

/**
 * POST /api/v1/messages  { to, text, channel? }
 * Sends a WhatsApp text through the account's channel (official or QR).
 * Needs the `messages:send` permission.
 */
export async function POST(request: Request) {
  const auth = await authenticateApiKey(request, 'messages:send')
  if (!auth.ok) return auth.response

  let body: Record<string, unknown>
  try {
    const parsed = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return apiError(400, 'invalid_json', 'The body must be a JSON object.')
  }

  try {
    const sent = await sendTextViaApi(supabaseAdmin(), {
      accountId: auth.ctx.accountId,
      to: body.to,
      text: body.text,
      channel: body.channel,
    })
    return NextResponse.json({ object: 'message', ...sent }, { status: 201 })
  } catch (err) {
    if (err instanceof ApiSendError) return apiError(err.status, err.code, err.message)
    console.error('[api-v1] POST /messages failed:', err instanceof Error ? err.message : err)
    return apiError(500, 'internal_error', 'Unexpected error.')
  }
}
