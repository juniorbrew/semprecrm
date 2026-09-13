// ============================================================
// POST /api/account/preferences — save `accounts.preferences`. Admin+.
//
// Body: a partial preferences patch (any subset of the keys the
// account preference parsers understand — SLA, cooling, opt-out
// words, business hours, …). Keys are merged over the live jsonb
// through the same RLS-scoped UPDATE the settings form used to run
// directly; the route exists so the change is audited
// (`preferences.updated`, spec §3) with the keys that changed.
//
// Unknown keys are written as-is (the jsonb is deliberately open —
// see src/lib/account-preferences.ts); known keys are normalised by
// `mergeAccountPreferences`.
// ============================================================

import { NextResponse } from 'next/server'

import { mergeAccountPreferences } from '@/lib/account-preferences'
import type { AccountPreferences } from '@/types'
import { AUDIT_ACTIONS } from '@/lib/audit'
import { audit } from '@/lib/audit-server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const MAX_BODY_KEYS = 40

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function stableJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'undefined'
  } catch {
    return String(v)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const limit = checkRateLimit(`admin:preferences:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as unknown
    if (!isPlainObject(body) || Object.keys(body).length === 0) {
      return NextResponse.json({ error: 'Body must be a non-empty JSON object' }, { status: 400 })
    }
    if (Object.keys(body).length > MAX_BODY_KEYS) {
      return NextResponse.json({ error: 'Too many keys' }, { status: 400 })
    }

    const { data: row, error: readErr } = await ctx.supabase
      .from('accounts')
      .select('preferences')
      .eq('id', ctx.accountId)
      .maybeSingle()
    if (readErr) {
      console.error('[POST /api/account/preferences] read failed:', readErr)
      return NextResponse.json({ error: 'Failed to load preferences' }, { status: 500 })
    }

    const existing = isPlainObject(row?.preferences) ? row!.preferences : {}
    // Known keys are validated/normalised; the rest is merged verbatim so
    // features owned by other panels (business hours, auto-assign…) can
    // save through this route too.
    const merged: Record<string, unknown> = {
      ...existing,
      ...body,
      ...mergeAccountPreferences(existing, body as Partial<AccountPreferences>),
    }

    const changedKeys = Object.keys(body).filter(
      (k) => stableJson(existing[k]) !== stableJson(merged[k]),
    )

    const { data: updated, error } = await ctx.supabase
      .from('accounts')
      .update({ preferences: merged })
      .eq('id', ctx.accountId)
      .select('preferences')
      .single()
    if (error) {
      console.error('[POST /api/account/preferences] update failed:', error)
      return NextResponse.json({ error: 'Failed to save preferences' }, { status: 500 })
    }

    if (changedKeys.length > 0) {
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      for (const k of changedKeys) changes[k] = { from: existing[k] ?? null, to: merged[k] ?? null }
      await audit({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.PREFERENCES_UPDATED,
        entityType: 'preferences',
        entityId: ctx.accountId,
        metadata: { keys: changedKeys, changes },
      })
    }

    return NextResponse.json({ preferences: updated?.preferences ?? merged })
  } catch (err) {
    return toErrorResponse(err)
  }
}
