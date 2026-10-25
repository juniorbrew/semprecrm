import { NextResponse } from 'next/server';

import { loadConfig } from '@/lib/agenda/data';
import { agendaContext, agendaErrorResponse } from '@/lib/agenda/route';

export const dynamic = 'force-dynamic';

/** Services, professionals, links, hours, exceptions and booking rules of the caller's account. */
export async function GET() {
  try {
    const ctx = await agendaContext('viewer', false);
    return NextResponse.json(await loadConfig(ctx.supabase, ctx.accountId));
  } catch (err) {
    return agendaErrorResponse(err);
  }
}
