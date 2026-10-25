import { NextResponse } from 'next/server';

import { loadReminderSettings, saveReminderSettings } from '@/lib/agenda/admin';
import { agendaContext, agendaErrorResponse, parseBody } from '@/lib/agenda/route';
import { reminderSettingsSchema } from '@/lib/agenda/schemas';

export const dynamic = 'force-dynamic';

/** WhatsApp reminder settings of the caller's account (defaults when never saved). */
export async function GET() {
  try {
    const ctx = await agendaContext('viewer', false);
    return NextResponse.json({ settings: await loadReminderSettings(ctx.supabase, ctx.accountId) });
  } catch (err) {
    return agendaErrorResponse(err);
  }
}

/** On/off, the two offsets, the text and the official-channel template (admin+). */
export async function PUT(request: Request) {
  try {
    const ctx = await agendaContext('admin', true);
    const body = await parseBody(request, reminderSettingsSchema);
    return NextResponse.json({ settings: await saveReminderSettings(ctx.supabase, ctx.accountId, body) });
  } catch (err) {
    return agendaErrorResponse(err);
  }
}
