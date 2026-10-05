// ============================================================
// GET /api/ai/usage — this month's AI spend broken down by day,
// feature and model (calendar month in America/Sao_Paulo). Admin+ and
// plan module `ai`. Reads the ledger through the caller's RLS client.
// ============================================================

import { NextResponse } from 'next/server';

import { requireModule, requireRole } from '@/lib/auth/account';
import { budgetMonthKey, monthStartInTimeZone } from '@/lib/ai/budget';
import { aiErrorResponse } from '@/lib/ai/http';
import { summarizeUsage, type UsageRow } from '@/lib/ai/usage-breakdown';

export const dynamic = 'force-dynamic';

// ponytail: reads up to 20k ledger rows and sums in memory; move to a SQL
// aggregate (RPC) if an account ever goes past that in a month.
const MAX_ROWS = 20_000;

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    await requireModule(ctx, 'ai');
    const now = new Date();
    const since = monthStartInTimeZone(now);
    const { data, error } = await ctx.supabase
      .from('ai_usage')
      .select('created_at, feature, model, status, input_tokens, output_tokens, cost_cents')
      .eq('account_id', ctx.accountId)
      .in('status', ['ok', 'error'])
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true })
      .limit(MAX_ROWS);
    if (error) throw new Error(`ai usage read failed: ${error.message}`);
    const rows = (data ?? []) as UsageRow[];
    return NextResponse.json({
      month: budgetMonthKey(now),
      truncated: rows.length >= MAX_ROWS,
      ...summarizeUsage(rows),
    });
  } catch (err) {
    return aiErrorResponse(err);
  }
}
