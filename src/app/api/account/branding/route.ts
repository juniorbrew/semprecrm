// ============================================================
// PUT /api/account/branding — save `accounts.branding` (spec round 2
// §6, migration 037). Admin+, module `white_label`, audited.
//
// Body: { app_name?, logo_url?, primary_color? } — any subset; `null`
// or "" resets that key to the SempreCRM default. Validation and the
// stored shape live in src/lib/branding.ts (`validateBrandingPatch`).
//
// GET returns the current (parsed) branding for the caller's account —
// handy for the settings form's "restore defaults" diff; the shell
// itself reads it off useAuth().account.
// ============================================================

import { NextResponse } from 'next/server'

import { AUDIT_ACTIONS } from '@/lib/audit'
import { audit } from '@/lib/audit-server'
import { getCurrentAccount, requireModule, requireRole, toErrorResponse } from '@/lib/auth/account'
import { parseBranding, validateBrandingPatch } from '@/lib/branding'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('accounts')
      .select('branding')
      .eq('id', ctx.accountId)
      .maybeSingle()
    if (error) {
      console.error('[GET /api/account/branding] read failed:', error)
      return NextResponse.json({ error: 'Failed to load branding' }, { status: 500 })
    }
    return NextResponse.json({ branding: parseBranding(data?.branding), raw: data?.branding ?? {} })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    await requireModule(ctx, 'white_label')

    const limit = checkRateLimit(`admin:branding:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as unknown

    const { data: row, error: readErr } = await ctx.supabase
      .from('accounts')
      .select('branding')
      .eq('id', ctx.accountId)
      .maybeSingle()
    if (readErr) {
      console.error('[PUT /api/account/branding] read failed:', readErr)
      return NextResponse.json({ error: 'Failed to load branding' }, { status: 500 })
    }
    const existing = (row?.branding ?? {}) as Record<string, unknown>

    const validated = validateBrandingPatch(existing, body)
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 })
    }

    const { data: updated, error } = await ctx.supabase
      .from('accounts')
      .update({ branding: validated.branding })
      .eq('id', ctx.accountId)
      .select('branding')
      .single()
    if (error) {
      console.error('[PUT /api/account/branding] update failed:', error)
      return NextResponse.json({ error: 'Failed to save branding' }, { status: 500 })
    }

    const before = parseBranding(existing)
    const after = parseBranding(updated?.branding ?? validated.branding)
    const changed = (Object.keys(after) as (keyof typeof after)[]).filter(
      (k) => before[k] !== after[k],
    )
    if (changed.length > 0) {
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const k of changed) changes[k] = { from: before[k], to: after[k] }
      await audit({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.BRANDING_UPDATED,
        entityType: 'branding',
        entityId: ctx.accountId,
        metadata: { keys: changed, changes },
      })
    }

    return NextResponse.json({ branding: after, raw: updated?.branding ?? validated.branding })
  } catch (err) {
    return toErrorResponse(err)
  }
}
