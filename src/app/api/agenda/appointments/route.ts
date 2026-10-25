import { NextResponse } from 'next/server';

import { agendaContext, agendaErrorResponse, agendaWriter, parseBody } from '@/lib/agenda/route';
import { bookSchema } from '@/lib/agenda/schemas';
import { bookAppointment } from '@/lib/agenda/service';

export const dynamic = 'force-dynamic';

/**
 * Book an appointment (agent+). `resource_id` omitted = any free professional.
 * Send `idempotency_key` so a retry returns the same appointment.
 */
export async function POST(request: Request) {
  try {
    const ctx = await agendaContext('agent', true);
    const body = await parseBody(request, bookSchema);
    const event = await bookAppointment(ctx.supabase, {
      accountId: ctx.accountId,
      actorId: ctx.userId,
      serviceId: body.service_id,
      resourceId: body.resource_id,
      contactId: body.contact_id,
      conversationId: body.conversation_id,
      startsAt: body.starts_at,
      notes: body.notes,
      status: body.status,
      source: 'agent',
      idempotencyKey: body.idempotency_key,
      encaixe: body.encaixe,
    }, agendaWriter());
    return NextResponse.json({ appointment: event }, { status: 201 });
  } catch (err) {
    return agendaErrorResponse(err);
  }
}
