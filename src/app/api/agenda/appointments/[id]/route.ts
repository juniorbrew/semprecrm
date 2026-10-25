import { NextResponse } from 'next/server';

import { AgendaError } from '@/lib/agenda/errors';
import { agendaContext, agendaErrorResponse, agendaWriter, parseBody } from '@/lib/agenda/route';
import { appointmentPatchSchema } from '@/lib/agenda/schemas';
import { rescheduleAppointment, setAppointmentStatus } from '@/lib/agenda/service';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Reschedule (`starts_at`, optional `resource_id`) and/or change the status
 * (`cancelled`, `confirmed`, `completed`, `no_show`, `scheduled`). Both in one
 * call: the new time is applied first, then the status.
 */
export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const ctx = await agendaContext('agent', true);
    const id = (await params).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AgendaError('not_found');
    const body = await parseBody(request, appointmentPatchSchema);

    let appointment;
    if (body.starts_at !== undefined) {
      appointment = await rescheduleAppointment(ctx.supabase, {
        accountId: ctx.accountId,
        eventId: id,
        startsAt: body.starts_at,
        resourceId: body.resource_id ?? null,
      }, agendaWriter());
    }
    if (body.status !== undefined) {
      appointment = await setAppointmentStatus(ctx.supabase, {
        accountId: ctx.accountId,
        eventId: id,
        status: body.status,
      }, agendaWriter());
    }
    return NextResponse.json({ appointment });
  } catch (err) {
    return agendaErrorResponse(err);
  }
}
