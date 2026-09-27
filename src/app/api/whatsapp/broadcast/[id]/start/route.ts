// ============================================================
// POST /api/whatsapp/broadcast/[id]/start
//
// The wizard calls this right after creating the broadcast row: the
// SERVER takes the delivery lock and mints the first token from its own
// clock (the browser's clock can be minutes off, which would make the
// lock look stale — or fresh — to everyone else). The wizard then sends
// its batches through /api/whatsapp/broadcast with that token.
//
// Same conditional claim as the resume route, so it fails (409) when
// another pass already holds a fresh lock.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole, toErrorResponse } from '@/lib/auth/account';
import { newLockToken } from '@/lib/broadcast-delivery-lock';
import { claimBroadcastDelivery } from '@/lib/whatsapp/broadcast-resume';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent');
    await requireModule(ctx, 'broadcasts');
    const { id } = await params;

    const token = newLockToken(new Date());
    if (!(await claimBroadcastDelivery(ctx.supabase, ctx.accountId, id, token))) {
      return NextResponse.json(
        {
          error:
            'A delivery pass is already running for this broadcast. Wait for it to finish before resuming again.',
          code: 'delivery_in_progress',
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, lock_token: token });
  } catch (error) {
    return toErrorResponse(error);
  }
}
