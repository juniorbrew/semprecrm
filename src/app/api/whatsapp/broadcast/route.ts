import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createClient } from '@/lib/supabase/server'
import { accountHasModule } from '@/lib/plans-server'
import { renewDeliveryLock } from '@/lib/broadcast-delivery-lock'
import {
  BroadcastError,
  deliverRecipientIds,
  finalizeBroadcastStatus,
  loadDeliveryContext,
} from '@/lib/whatsapp/broadcast-core'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

/** Upper bound per call — the wizard sends 10. */
const MAX_IDS_PER_CALL = 50

/**
 * POST /api/whatsapp/broadcast — send one batch of a wizard campaign.
 *
 *   { broadcast_id, recipient_ids: string[], lock_token }
 *
 * The server does the whole per-row protocol (lib/whatsapp/
 * broadcast-core.ts): renews the caller's delivery lock (conditional on
 * the caller's own token — a stale tab gets 409 and must stop), CLAIMS
 * the rows atomically (pending → sending; rows someone else claimed come
 * back 'skipped' and are never sent), sends, and stamps each row
 * sent / failed (confirmed) / uncertain itself. Params and header media
 * come from the rows / broadcast frozen at creation, never from the
 * request.
 *
 * The old `recipients` / `phone_numbers` shapes (phones + params from the
 * browser, rows stamped by the browser) are gone on purpose: they had no
 * row claim, so a reload or a second pass could message people twice.
 * A tab still running the old bundle gets a 400 and sends nothing.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Papel mínimo (wacrm GHSA-8fv4-vgcc-p8vm, #448): o account_id do profile só
    // prova que a pessoa é da conta, não o papel. Enviar/reagir/disparar chega
    // ao cliente pela Meta ANTES de qualquer gravação, então a RLS não segura:
    // exige 'agent' (canSendMessages) aqui.
    let accountId: string
    try {
      ;({ accountId } = await requireRole('agent'))
    } catch (err) {
      return toErrorResponse(err)
    }

    // Per-user budget, sized for a campaign's many batch calls (#472).
    // Checked BEFORE any claim/send, so a 429 is always safe to replay.
    const limit = checkRateLimit(`broadcast:${user.id}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Plan gate (migration 025): the `broadcasts` module must be on
    // and the account not blocked.
    if (!(await accountHasModule(supabase, accountId, 'broadcasts'))) {
      return NextResponse.json(
        {
          error: 'Module not included in your plan',
          code: 'module_not_included',
        },
        { status: 403 },
      )
    }

    const body = await request.json().catch(() => ({}))
    const broadcastId = typeof body?.broadcast_id === 'string' ? body.broadcast_id : ''
    const lockToken = typeof body?.lock_token === 'string' ? body.lock_token : ''
    const ids: string[] = Array.isArray(body?.recipient_ids)
      ? body.recipient_ids.filter((v: unknown): v is string => typeof v === 'string')
      : []

    if (!broadcastId || !lockToken || ids.length === 0 || ids.length > MAX_IDS_PER_CALL) {
      return NextResponse.json(
        {
          error:
            'Provide broadcast_id, lock_token and 1–50 recipient_ids. Reload the page if this tab is out of date.',
          code: 'bad_request',
        },
        { status: 400 },
      )
    }

    // My lock, or stop. A tab that slept past the staleness window finds
    // a resume pass holding the lock now — it must not keep sending.
    const nextToken = await renewDeliveryLock(supabase, broadcastId, lockToken)
    if (!nextToken) {
      return NextResponse.json(
        {
          error:
            'This broadcast is being delivered by another pass. This tab stopped sending — open the broadcast to follow it.',
          code: 'delivery_lock_lost',
        },
        { status: 409 },
      )
    }

    const ctx = await loadDeliveryContext(supabase, accountId, broadcastId)
    const results = await deliverRecipientIds(supabase, ctx, ids, ['pending'])
    await finalizeBroadcastStatus(supabase, broadcastId)

    const tally = { sent: 0, failed: 0, uncertain: 0, skipped: 0 }
    for (const r of results) tally[r.outcome]++

    return NextResponse.json({
      success: true,
      lock_token: nextToken,
      ...tally,
      results,
    })
  } catch (error) {
    if (error instanceof BroadcastError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      )
    }
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json(
      { error: 'Failed to process broadcast' },
      { status: 500 }
    )
  }
}
