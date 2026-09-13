// ============================================================
// POST /api/lead-sources/[id]/token — rotate a source's token (admin+).
//
// The old URL stops working immediately; the response carries the new
// token once so the panel can show the new URL. Minted server-side.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { LEAD_SOURCE_COLUMNS } from '@/lib/lead-capture'
import { generateLeadSourceToken } from '@/lib/lead-capture/token'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`admin:lead-source-token:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    // RLS (admin+ update, account-scoped) is what actually guards the
    // row; the explicit account filter just makes the intent obvious.
    const { data, error } = await ctx.supabase
      .from('lead_sources')
      .update({ token: generateLeadSourceToken() })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(LEAD_SOURCE_COLUMNS)
      .maybeSingle()

    if (error) {
      console.error('[POST /api/lead-sources/:id/token] update failed:', error)
      return NextResponse.json({ error: 'Failed to rotate token' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Lead source not found' }, { status: 404 })
    return NextResponse.json({ source: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
