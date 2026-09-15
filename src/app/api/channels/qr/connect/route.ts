import { NextResponse } from 'next/server'

import { requireRole, requireModule, PlanLimitError } from '@/lib/auth/account'
import { canAddChannel } from '@/lib/plans'
import { countConnectedChannels } from '@/lib/plans-server'
import { connectSession, getSessionState } from '@/lib/whatsapp/qr-gateway'
import { AUDIT_ACTIONS } from '@/lib/audit'
import { audit } from '@/lib/audit-server'
import {
  patchFromGatewayState,
  qrErrorResponse,
  readQrSession,
  upsertQrSession,
} from '@/lib/whatsapp/qr-session'

/**
 * POST /api/channels/qr/connect
 *
 * Starts (or resumes) the account's WhatsApp Web session on the
 * gateway. Admin+ only, needs the `channel_qr` module, and a *new*
 * session must fit under `max_channels` (an existing non-disconnected
 * session already holds its slot, so reconnecting is always allowed).
 *
 * Response: `{ session }` — the mirrored `wa_qr_sessions` row plus the
 * gateway's live state (`qr` data URL while scanning).
 */
export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const ent = await requireModule(ctx, 'channel_qr')

    const current = await readQrSession(ctx.supabase, ctx.accountId)
    const holdsSlot = current != null && current.status !== 'disconnected'

    if (!holdsSlot) {
      const inUse = await countConnectedChannels(ctx.supabase, ctx.accountId)
      const max = ent.limits.max_channels
      if (!canAddChannel(inUse, max)) {
        const plural = max === 1 ? '' : 's'
        throw new PlanLimitError(
          `Seu plano permite até ${max} canal${max === 1 ? '' : 'is'} conectado${plural}. Desconecte um canal ou faça upgrade do plano.`,
        )
      }
    }

    try {
      const started = await connectSession(ctx.accountId)
      // `connect` only returns the status; fetch the full state so the
      // panel gets the first QR without waiting for the next poll.
      let state
      try {
        state = await getSessionState(ctx.accountId)
      } catch {
        state = { status: started.status }
      }
      const session = await upsertQrSession(
        ctx.supabase,
        ctx.accountId,
        patchFromGatewayState(state),
      )
      await audit({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.WHATSAPP_QR_CONNECTED,
        entityType: 'wa_qr_session',
        entityId: ctx.accountId,
        metadata: {
          status: state.status,
          resumed: holdsSlot,
          phone_number: session?.phone_number ?? null,
        },
      })
      return NextResponse.json({
        session: { ...(session ?? { account_id: ctx.accountId }), ...state },
      })
    } catch (err) {
      return qrErrorResponse(err, current)
    }
  } catch (err) {
    return qrErrorResponse(err)
  }
}
