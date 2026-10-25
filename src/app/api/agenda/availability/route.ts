import { NextResponse } from 'next/server';

import { agendaContext, agendaErrorResponse } from '@/lib/agenda/route';
import { availabilityQuerySchema } from '@/lib/agenda/schemas';
import { getAvailability } from '@/lib/agenda/service';

export const dynamic = 'force-dynamic';

/** GET ?service_id=&resource_id=(optional)&from=YYYY-MM-DD&to=YYYY-MM-DD&encaixe=1(optional, agent+) — free slots in the account timezone. */
export async function GET(request: Request) {
  try {
    const p = new URL(request.url).searchParams;
    const q = availabilityQuerySchema.parse({
      service_id: p.get('service_id'),
      resource_id: p.get('resource_id'),
      from: p.get('from'),
      to: p.get('to'),
      encaixe: p.get('encaixe') === '1',
    });
    // Encaixe slots (notice and horizon ignored) are for people who can book: agent+.
    const ctx = await agendaContext(q.encaixe ? 'agent' : 'viewer', false);
    const result = await getAvailability(ctx.supabase, {
      accountId: ctx.accountId,
      serviceId: q.service_id,
      resourceId: q.resource_id,
      from: q.from,
      to: q.to,
      encaixe: q.encaixe,
      source: 'agent',
    });
    return NextResponse.json(result);
  } catch (err) {
    return agendaErrorResponse(err);
  }
}
