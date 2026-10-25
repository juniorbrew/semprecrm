import { NextResponse } from 'next/server';

import { createService } from '@/lib/agenda/admin';
import { agendaContext, agendaErrorResponse, parseBody } from '@/lib/agenda/route';
import { serviceSchema } from '@/lib/agenda/schemas';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const ctx = await agendaContext('admin', true);
    const body = await parseBody(request, serviceSchema);
    return NextResponse.json({ service: await createService(ctx.supabase, ctx.accountId, body) }, { status: 201 });
  } catch (err) {
    return agendaErrorResponse(err);
  }
}
