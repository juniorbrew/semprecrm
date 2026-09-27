// ============================================================
// POST /api/whatsapp/broadcast/[id]/resume   (wacrm #472, upstream 3376991)
//
// Delivers the recipients of an existing broadcast that still need
// sending, server-side:
//
//   scope 'pending' — "Retomar": a campaign abandoned when its tab closed;
//   scope 'failed'  — "Reenviar falhas": rows with a CONFIRMED error only;
//   scope 'all'     — both;
//   scope 'settle'  — no sending: rows a dead pass left in 'sending' past
//                     the staleness window become 'uncertain' and the
//                     campaign's final status is settled.
//
// Rows in 'sending' or 'uncertain' are never sent from here. Responds
// 202 once the pass is planned; the fan-out runs in `after()` through
// broadcast-core's per-row claim, so it can't resend a row another pass
// claimed or already sent.
// ============================================================

import { NextResponse, after } from 'next/server';

import { requireModule, requireRole, toErrorResponse } from '@/lib/auth/account';
import { newLockToken, releaseDeliveryLock } from '@/lib/broadcast-delivery-lock';
import {
  BroadcastError,
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core';
import {
  claimBroadcastDelivery,
  markBroadcastSending,
  planBroadcastResume,
  RESUME_SCOPES,
  type ResumeScope,
} from '@/lib/whatsapp/broadcast-resume';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

// The fan-out below is sequential over up to 1 000 recipients.
export const maxDuration = 300;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let claimed: { id: string; token: string } | null = null;

  try {
    // Same gates as /api/whatsapp/broadcast: sending is an 'agent'
    // action and the plan must include the `broadcasts` module (025).
    const ctx = await requireRole('agent');
    await requireModule(ctx, 'broadcasts');
    const { supabase, accountId, userId } = ctx;

    const limit = checkRateLimit(`broadcast-resume:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const settle = body?.scope === 'settle';
    const scope: ResumeScope = RESUME_SCOPES.includes(body?.scope) ? body.scope : 'pending';

    // Coarse layer: one pass at a time. The per-row claim is what really
    // prevents duplicates; the lock keeps passes from fighting over rows.
    const token = newLockToken();
    if (!(await claimBroadcastDelivery(supabase, accountId, id, token))) {
      return NextResponse.json(
        {
          error:
            'A delivery pass is already running for this broadcast. Wait for it to finish before resuming again.',
          code: 'delivery_in_progress',
        },
        { status: 409 },
      );
    }
    claimed = { id, token };

    if (settle) {
      await finalizeBroadcastStatus(supabase, id);
      await releaseDeliveryLock(supabase, id, token);
      claimed = null;
      return NextResponse.json({ success: true, broadcast_id: id, settled: true });
    }

    const plan = await planBroadcastResume(supabase, accountId, id, scope);
    await markBroadcastSending(supabase, id);
    const owned = claimed;
    claimed = null; // ownership passes to the after() block

    // Service-role client for the fan-out: it outlives the request, and
    // the broadcast + every row id were resolved through account-scoped
    // (RLS) reads above; every row write is also scoped to broadcast_id.
    const admin = supabaseAdmin();
    after(async () => {
      let lastToken: string | null = owned.token;
      try {
        ({ lockToken: lastToken } = await deliverBroadcast(admin, plan.ctx, {
          ids: plan.ids,
          from: plan.from,
          lockToken: owned.token,
        }));
      } catch (err) {
        console.error(
          '[broadcast-resume] delivery threw:',
          err instanceof Error ? err.message : err,
        );
        await finalizeBroadcastStatus(admin, id).catch(() => {});
      } finally {
        // Conditional on MY token — never clears a lock someone else took.
        if (lastToken) await releaseDeliveryLock(admin, id, lastToken).catch(() => {});
      }
    });

    return NextResponse.json(
      {
        success: true,
        broadcast_id: id,
        scope,
        resuming: plan.ids.length,
        // > 0 when the backlog exceeded one pass's cap.
        remaining: plan.remaining,
      },
      { status: 202 },
    );
  } catch (error) {
    // Planning failed after the claim — release MY lock.
    if (claimed) {
      await releaseDeliveryLock(supabaseAdmin(), claimed.id, claimed.token).catch(() => {});
    }
    if (error instanceof BroadcastError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return toErrorResponse(error);
  }
}
