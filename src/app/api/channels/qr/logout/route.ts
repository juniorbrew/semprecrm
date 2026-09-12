import { NextResponse } from 'next/server'

import { requireRole, requireModule } from '@/lib/auth/account'
import { logoutSession } from '@/lib/whatsapp/qr-gateway'
import { qrErrorResponse, readQrSession, upsertQrSession } from '@/lib/whatsapp/qr-session'

/**
 * POST /api/channels/qr/logout
 *
 * Ends the session on the gateway (which wipes the Baileys auth
 * state) and marks the row `disconnected`, freeing the channel slot.
 */
export async function POST() {
  try {
    const ctx = await requireRole('admin')
    await requireModule(ctx, 'channel_qr')

    const current = await readQrSession(ctx.supabase, ctx.accountId)
    try {
      await logoutSession(ctx.accountId)
    } catch (err) {
      return qrErrorResponse(err, current)
    }

    const session = await upsertQrSession(ctx.supabase, ctx.accountId, {
      status: 'disconnected',
      phone_number: null,
      display_name: null,
      last_error: null,
    })
    return NextResponse.json({
      session: session ?? { account_id: ctx.accountId, status: 'disconnected' },
    })
  } catch (err) {
    return qrErrorResponse(err)
  }
}
