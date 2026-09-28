// ============================================================
// /api/ai/credentials — the account's own provider API key. Admin+
// and plan module `ai`.
//
// POST { provider, api_key }  → validate with the provider (model list
//                               call), encrypt (AES-256-GCM) and save.
// POST { provider }           → re-test the saved key.
// DELETE ?provider=openai     → remove the key; AI is switched off if
//                               it was using that provider.
//
// The key goes in once and never comes back out: responses carry only
// the provider, `last4` and `validated_at`. Writes use the service
// role because the credentials table is closed to every signed-in
// user (migration 058); the account comes from the session.
// ============================================================

import { NextResponse } from 'next/server';

import { AUDIT_ACTIONS } from '@/lib/audit';
import { audit } from '@/lib/audit-server';
import { requireModule, requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { validateProviderKey } from '@/lib/ai/client';
import { AI_ERROR_MESSAGES } from '@/lib/ai/errors';
import { aiErrorResponse } from '@/lib/ai/http';
import { isAiProvider } from '@/lib/ai/providers';
import {
  deleteCredential,
  isPlausibleApiKey,
  loadDecryptedKey,
  markCredentialValidated,
  saveCredential,
} from '@/lib/ai/store';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');

    const limit = checkRateLimit(`admin:ai-key:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { provider?: unknown; api_key?: unknown } | null;
    if (!body || !isAiProvider(body.provider)) {
      return NextResponse.json({ error: 'Unknown AI provider' }, { status: 400 });
    }
    const provider = body.provider;
    const db = supabaseAdmin();
    const newKey = body.api_key !== undefined && body.api_key !== null && body.api_key !== '';

    let apiKey: string;
    if (newKey) {
      if (!isPlausibleApiKey(body.api_key)) {
        return NextResponse.json({ error: 'This does not look like an API key' }, { status: 400 });
      }
      apiKey = body.api_key.trim();
    } else {
      const saved = await loadDecryptedKey(db, ctx.accountId, provider);
      if (!saved) {
        return NextResponse.json({ error: AI_ERROR_MESSAGES.no_key, code: 'no_key' }, { status: 404 });
      }
      apiKey = saved;
    }

    const check = await validateProviderKey(provider, apiKey);
    if (!check.ok) {
      return NextResponse.json({ error: AI_ERROR_MESSAGES[check.code], code: check.code }, { status: 422 });
    }

    const validatedAt = new Date().toISOString();
    if (newKey) {
      const credential = await saveCredential(db, {
        accountId: ctx.accountId,
        provider,
        apiKey,
        userId: ctx.userId,
        validatedAt,
      });
      await audit({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.AI_KEY_SAVED,
        entityType: 'ai_credential',
        entityId: null,
        metadata: { provider, last4: credential.last4 },
      });
      return NextResponse.json({ credential, models: check.models });
    }

    await markCredentialValidated(db, ctx.accountId, provider, validatedAt);
    return NextResponse.json({ ok: true, validated_at: validatedAt, models: check.models });
  } catch (err) {
    return aiErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');

    const limit = checkRateLimit(`admin:ai-key:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const provider = new URL(request.url).searchParams.get('provider');
    if (!isAiProvider(provider)) {
      return NextResponse.json({ error: 'Unknown AI provider' }, { status: 400 });
    }

    const removed = await deleteCredential(supabaseAdmin(), ctx.accountId, provider);

    // Without a key the provider can't be used: switch AI off if it
    // was running on it (RLS client — admin policy).
    const { error: offErr } = await ctx.supabase
      .from('ai_settings')
      .update({ enabled: false, updated_by: ctx.userId })
      .eq('account_id', ctx.accountId)
      .eq('provider', provider)
      .eq('enabled', true);
    if (offErr) console.error('[DELETE /api/ai/credentials] disable failed:', offErr.message);

    if (removed) {
      await audit({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.AI_KEY_REMOVED,
        entityType: 'ai_credential',
        entityId: null,
        metadata: { provider },
      });
    }
    return NextResponse.json({ ok: true, removed });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
