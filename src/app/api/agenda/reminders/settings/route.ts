import { NextResponse } from 'next/server';

import { loadReminderSettings, saveReminderSettings } from '@/lib/agenda/admin';
import { agendaContext, agendaErrorResponse, parseBody } from '@/lib/agenda/route';
import { AgendaError } from '@/lib/agenda/errors';
import { templateTakesFiveParams } from '@/lib/agenda/reminders-core';
import { reminderSettingsSchema } from '@/lib/agenda/schemas';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';

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
    if (body.template_name) {
      const t = await resolveTemplateRow(ctx.supabase as never, ctx.accountId, body.template_name, body.template_language);
      if (!t.row) throw new AgendaError('validation', 'Modelo não encontrado ou ainda não sincronizado com o WhatsApp.');
      if (!templateTakesFiveParams(t.row.body_text)) {
        throw new AgendaError(
          'validation',
          'O corpo do modelo precisa ter exatamente as variáveis {{1}} a {{5}} (cliente, serviço, profissional, data, hora).',
        );
      }
    }
    return NextResponse.json({ settings: await saveReminderSettings(ctx.supabase, ctx.accountId, body) });
  } catch (err) {
    return agendaErrorResponse(err);
  }
}
