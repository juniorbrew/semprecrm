// ============================================================
// /api/ai/agents/:id — one AI agent (064). Admin+ and module `ai`.
//
// PATCH  → any subset of the fields POST accepts
// DELETE → removes it (suggestions fall back to the next rule)
//
// Caller's RLS client, filtered by the session account: another
// account's agent is a plain 404.
// ============================================================

import { NextResponse } from 'next/server';

import { AUDIT_ACTIONS } from '@/lib/audit';
import { audit } from '@/lib/audit-server';
import { requireModule, requireRole } from '@/lib/auth/account';
import { AGENT_COLUMNS, AGENT_ERRORS, parseAgentInput, type AiAgent } from '@/lib/ai/agents';
import { checkAgentModel, setDefaultAgent } from '@/lib/ai/agents-store';
import { aiErrorResponse } from '@/lib/ai/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: AGENT_ERRORS.notFound }, { status: 404 });

async function context(params: Params['params']) {
  const { id } = await params;
  const ctx = await requireRole('admin');
  await requireModule(ctx, 'ai');
  const limit = checkRateLimit(`admin:ai-agents:${ctx.userId}`, RATE_LIMITS.adminAction);
  return { ctx, id, limit };
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { ctx, id, limit } = await context(params);
    if (!limit.success) return rateLimitResponse(limit);
    if (!UUID_RE.test(id)) return notFound();

    const parsed = parseAgentInput(await request.json().catch(() => null), true);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const w = parsed.write;
    const modelError = await checkAgentModel(ctx, w.model);
    if (modelError) return NextResponse.json({ error: modelError }, { status: 400 });

    const { data: current, error: readErr } = await ctx.supabase
      .from('ai_agents')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (readErr) throw new Error(`ai agent read failed: ${readErr.message}`);
    if (!current) return notFound();

    // is_default: true goes through the atomic swap; false is a plain update.
    const { is_default: makeDefault, ...rest } = w;
    const fields = makeDefault === false ? { ...rest, is_default: false } : rest;
    if (Object.keys(fields).length > 0) {
      const { error } = await ctx.supabase.from('ai_agents').update(fields).eq('id', id).eq('account_id', ctx.accountId);
      if (error) throw new Error(`ai agent update failed: ${error.message}`);
    }
    if (makeDefault === true && (await setDefaultAgent(ctx, id)) === 'conflict') {
      return NextResponse.json({ error: AGENT_ERRORS.defaultConflict }, { status: 409 });
    }
    const { data, error } = await ctx.supabase
      .from('ai_agents')
      .select(AGENT_COLUMNS)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) throw new Error(`ai agent read failed: ${error.message}`);
    if (!data) return notFound();
    const agent = data as AiAgent;

    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.AI_AGENTS_CHANGED,
      entityType: 'ai_agent',
      entityId: id,
      metadata: { op: 'updated', name: agent.name, fields: Object.keys(w) },
    });
    return NextResponse.json({ agent });
  } catch (err) {
    return aiErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { ctx, id, limit } = await context(params);
    if (!limit.success) return rateLimitResponse(limit);
    if (!UUID_RE.test(id)) return notFound();
    const { data, error } = await ctx.supabase
      .from('ai_agents')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id, name');
    if (error) throw new Error(`ai agent delete failed: ${error.message}`);
    const row = (data ?? [])[0] as { id: string; name: string } | undefined;
    if (!row) return notFound();
    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.AI_AGENTS_CHANGED,
      entityType: 'ai_agent',
      entityId: id,
      metadata: { op: 'deleted', name: row.name },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
