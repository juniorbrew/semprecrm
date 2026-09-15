import { NextResponse } from 'next/server'

import { requireRole, requireModule } from '@/lib/auth/account'
import { logoutSession } from '@/lib/whatsapp/qr-gateway'
import { AUDIT_ACTIONS } from '@/lib/audit'
import { audit } from '@/lib/audit-server'
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
    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.WHATSAPP_QR_LOGGED_OUT,
      entityType: 'wa_qr_session',
      entityId: ctx.accountId,
      metadata: {
        phone_number: current?.phone_number ?? null,
        previous_status: current?.status ?? null,
      },
    })
    return NextResponse.json({
      session: session ?? { account_id: ctx.accountId, status: 'disconnected' },
    })
  } catch (err) {
    return qrErrorResponse(err)
  }
}
