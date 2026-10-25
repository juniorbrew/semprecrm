import { NextResponse } from 'next/server';

import { saveResource } from '@/lib/agenda/admin';
import { agendaContext, agendaErrorResponse, parseBody } from '@/lib/agenda/route';
import { resourceSchema } from '@/lib/agenda/schemas';

export const dynamic = 'force-dynamic';

/** New professional / room, optionally with its services, weekly hours and exceptions. */
export async function POST(request: Request) {
  try {
    const ctx = await agendaContext('admin', true);
    const body = await parseBody(request, resourceSchema);
    return NextResponse.json({ resource: await saveResource(ctx.supabase, ctx.accountId, null, body) }, { status: 201 });
  } catch (err) {
    return agendaErrorResponse(err);
  }
}
