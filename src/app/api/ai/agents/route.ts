// ============================================================
// /api/ai/agents — Settings → Inteligência Artificial → Agentes (064).
// Admin+ and plan module `ai`.
//
// GET  → the account's agents (oldest first)
// POST → create { name, instructions, tone?, model?, knowledge_enabled?,
//        is_default?, enabled?, channels?, tag_ids? }
//
// Caller's RLS client, account from the session. "Default" is unique
// per account: it is set by the `ai_agents_set_default` RPC (one
// statement, deferred exclusion constraint); a concurrent race → 409.
// ============================================================

import { NextResponse } from 'next/server';

import { AUDIT_ACTIONS } from '@/lib/audit';
import { audit } from '@/lib/audit-server';
import { requireModule, requireRole } from '@/lib/auth/account';
import { AGENT_COLUMNS, AGENT_ERRORS, AGENT_LIMITS, parseAgentInput, type AiAgent } from '@/lib/ai/agents';
import { aiErrorResponse } from '@/lib/ai/http';
import { checkAgentModel, setDefaultAgent } from '@/lib/ai/agents-store';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');
    const { data, error } = await ctx.supabase
      .from('ai_agents')
      .select(AGENT_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`ai agents read failed: ${error.message}`);
    return NextResponse.json({ agents: (data ?? []) as AiAgent[] });
  } catch (err) {
    return aiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');
    const limit = checkRateLimit(`admin:ai-agents:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const parsed = parseAgentInput(await request.json().catch(() => null), false);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const w = parsed.write;

    const modelError = await checkAgentModel(ctx, w.model);
    if (modelError) return NextResponse.json({ error: modelError }, { status: 400 });

    const { count, error: countErr } = await ctx.supabase
      .from('ai_agents')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId);
    if (countErr) throw new Error(`ai agents count failed: ${countErr.message}`);
    if ((count ?? 0) >= AGENT_LIMITS.maxAgentsPerAccount) {
      return NextResponse.json({ error: AGENT_ERRORS.tooMany }, { status: 409 });
    }

    // Created as non-default; becoming the default is the atomic swap below.
    const { is_default: makeDefault, ...fields } = w;
    const { data, error } = await ctx.supabase
      .from('ai_agents')
      .insert({ ...fields, is_default: false, account_id: ctx.accountId, created_by: ctx.userId })
      .select(AGENT_COLUMNS)
      .single();
    if (error || !data) throw new Error(`ai agent insert failed: ${error?.message ?? 'no row'}`);
    const agent = data as AiAgent;
    if (makeDefault) {
      if ((await setDefaultAgent(ctx, agent.id)) === 'conflict') {
        return NextResponse.json({ error: AGENT_ERRORS.defaultConflict }, { status: 409 });
      }
      agent.is_default = true;
    }

    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.AI_AGENTS_CHANGED,
      entityType: 'ai_agent',
      entityId: agent.id,
      metadata: { op: 'created', name: agent.name },
    });
    return NextResponse.json({ agent }, { status: 201 });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
