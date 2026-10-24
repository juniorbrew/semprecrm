import { NextResponse } from 'next/server';

import { deleteService, updateService } from '@/lib/agenda/admin';
import { AgendaError } from '@/lib/agenda/errors';
import { agendaContext, agendaErrorResponse, parseBody } from '@/lib/agenda/route';
import { servicePatchSchema } from '@/lib/agenda/schemas';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

function idOf(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AgendaError('not_found');
  return id;
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const ctx = await agendaContext('admin', true);
    const id = idOf((await params).id);
    const body = await parseBody(request, servicePatchSchema);
    return NextResponse.json({ service: await updateService(ctx.supabase, ctx.accountId, id, body) });
  } catch (err) {
    return agendaErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Ctx) {
  try {
    const ctx = await agendaContext('admin', true);
    await deleteService(ctx.supabase, ctx.accountId, idOf((await params).id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return agendaErrorResponse(err);
  }
}
