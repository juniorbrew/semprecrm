import { NextResponse } from 'next/server'

import { requireRole, requireModule } from '@/lib/auth/account'
import { getSessionState } from '@/lib/whatsapp/qr-gateway'
import {
  patchFromGatewayState,
  qrErrorResponse,
  readQrSession,
  upsertQrSession,
} from '@/lib/whatsapp/qr-session'
import { POST as statusEvent } from '../status-event/route'

/**
 * GET /api/channels/qr/status
 *
 * Live session state for the settings panel (polled every 2 s while a
 * QR is showing). Proxies the gateway and mirrors the result into
 * `wa_qr_sessions` so the DB never lags a status the user has seen.
 *
 * 503 `{ code: 'gateway_unconfigured' | 'gateway_unreachable', session }`
 * when the gateway can't be reached — the panel shows the explanation
 * and the last known DB row.
 */
export async function GET() {
  try {
    const ctx = await requireRole('admin')
    await requireModule(ctx, 'channel_qr')

    const current = await readQrSession(ctx.supabase, ctx.accountId)
    try {
      const state = await getSessionState(ctx.accountId)
      const changed =
        current?.status !== state.status ||
        (current?.phone_number ?? null) !== (state.phone ?? null) ||
        (current?.display_name ?? null) !== (state.name ?? null)
      const mirrored = changed
        ? await upsertQrSession(ctx.supabase, ctx.accountId, patchFromGatewayState(state))
        : current
      return NextResponse.json({
        session: { ...(mirrored ?? { account_id: ctx.accountId }), ...state },
      })
    } catch (err) {
      return qrErrorResponse(err, current)
    }
  } catch (err) {
    return qrErrorResponse(err)
  }
}

/**
 * POST /api/channels/qr/status
 *
 * The spec's gateway → app status callback lives at this path too
 * (section 1 names `/status`, section 3 names `status-event`). Both
 * accept the same gateway-secret-authenticated payload.
 */
export const POST = statusEvent
