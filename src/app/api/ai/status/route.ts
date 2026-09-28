// ============================================================
// GET /api/ai/status — can the caller's account use AI right now?
// Any member (the inbox composer asks to enable/disable "Sugerir
// resposta"). Returns only booleans — no settings, no key data.
//
//   { available: true,  reason: null }
//   { available: false, reason: 'module' | 'disabled' | 'no_key' }
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, getEntitlements, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { hasCredential, type AiSettingsRow } from '@/lib/ai/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const ent = await getEntitlements(ctx);
    if (ent.blocked || !ent.modules.ai) {
      return NextResponse.json({ available: false, reason: 'module' });
    }

    const { data, error } = await ctx.supabase
      .from('ai_settings')
      .select('enabled, provider, model, consent_provider, consented_at')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) throw new Error(`ai settings read failed: ${error.message}`);
    const s = data as Pick<AiSettingsRow, 'enabled' | 'provider' | 'model' | 'consent_provider' | 'consented_at'> | null;
    if (!s?.enabled || !s.provider || !s.model || !s.consented_at || s.consent_provider !== s.provider) {
      return NextResponse.json({ available: false, reason: 'disabled' });
    }
    if (!(await hasCredential(supabaseAdmin(), ctx.accountId, s.provider))) {
      return NextResponse.json({ available: false, reason: 'no_key' });
    }
    return NextResponse.json({ available: true, reason: null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
