// ============================================================
// POST /api/whatsapp/broadcast/[id]/resume   (wacrm #472, upstream 3376991)
//
// Delivers the recipients of an existing broadcast that still need
// sending, server-side:
//
//   - "Retomar" on a campaign abandoned when its browser tab closed
//     mid-send (the wizard drives the initial fan-out from the tab);
//   - "Reenviar falhas";
//   - both at once (`scope: 'all'`).
//
// Responds 202 as soon as the pass is claimed and planned; the fan-out
// runs in `after()`. The detail page re-reads the broadcast row for
// progress.
// ============================================================

import { NextResponse, after } from 'next/server';

import { requireModule, requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  BroadcastError,
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core';
import {
  claimBroadcastDelivery,
  markBroadcastSending,
  planBroadcastResume,
  releaseBroadcastDelivery,
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
  let claimedId: string | null = null;

  try {
    // Same gates as /api/whatsapp/broadcast: sending is an 'agent'
    // action (viewers are read-only) and the plan must include the
    // `broadcasts` module (migration 025). Resuming puts real messages
    // on real phones, so it is no different.
    const ctx = await requireRole('agent');
    await requireModule(ctx, 'broadcasts');
    const { supabase, accountId, userId } = ctx;

    const limit = checkRateLimit(`broadcast-resume:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const scope: ResumeScope = RESUME_SCOPES.includes(body?.scope) ? body.scope : 'pending';

    // Claim BEFORE planning. Two clicks, or a click while the wizard or
    // an earlier pass is still sending, would otherwise both build a
    // plan from the same 'pending' rows and message everyone twice —
    // and a WhatsApp message cannot be recalled. One conditional
    // UPDATE, so exactly one caller wins.
    const claimed = await claimBroadcastDelivery(supabase, accountId, id);
    if (!claimed) {
      return NextResponse.json(
        {
          error:
            'A delivery pass is already running for this broadcast. Wait for it to finish before resuming again.',
          code: 'delivery_in_progress',
        },
        { status: 409 },
      );
    }
    claimedId = id;

    const { plan, remaining, unsendable } = await planBroadcastResume(
      supabase,
      accountId,
      id,
      scope,
    );

    await markBroadcastSending(supabase, id);
    claimedId = null; // ownership passes to the after() block

    // Service-role client for the fan-out: it outlives the request, and
    // every id in the plan was already resolved through an
    // account-scoped (RLS) read above.
    const admin = supabaseAdmin();
    after(async () => {
      try {
        await deliverBroadcast(admin, plan);
      } catch (err) {
        console.error(
          '[broadcast-resume] delivery threw:',
          err instanceof Error ? err.message : err,
        );
        // Don't leave it mid-flight — settle whatever did land.
        await finalizeBroadcastStatus(admin, id).catch(() => {});
      } finally {
        await releaseBroadcastDelivery(admin, id);
      }
    });

    return NextResponse.json(
      {
        success: true,
        broadcast_id: id,
        scope,
        resuming: plan.planned.length,
        // > 0 when the backlog exceeded one pass's cap; the UI offers
        // Resume again rather than silently dropping them.
        remaining,
        // Recipients stamped failed up front (no phone / opted out).
        unsendable,
      },
      { status: 202 },
    );
  } catch (error) {
    // Planning failed after the claim — release it, or the campaign is
    // locked out of resuming until the staleness window expires.
    if (claimedId) {
      await releaseBroadcastDelivery(supabaseAdmin(), claimedId).catch(() => {});
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
