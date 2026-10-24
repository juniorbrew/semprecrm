import { NextResponse } from 'next/server';

import { saveSettings } from '@/lib/agenda/admin';
import { agendaContext, agendaErrorResponse, parseBody } from '@/lib/agenda/route';
import { settingsSchema } from '@/lib/agenda/schemas';

export const dynamic = 'force-dynamic';

/** Booking rules: minimum notice, how far ahead, slot step (admin+). */
export async function PUT(request: Request) {
  try {
    const ctx = await agendaContext('admin', true);
    const body = await parseBody(request, settingsSchema);
    return NextResponse.json({ settings: await saveSettings(ctx.supabase, ctx.accountId, body) });
  } catch (err) {
    return agendaErrorResponse(err);
  }
}
