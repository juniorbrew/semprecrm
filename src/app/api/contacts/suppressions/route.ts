// ============================================================
// POST /api/contacts/suppressions — agent+ (whoever can import contacts).
//
// Body: `{ ids: string[] }` — contacts the caller just created (CSV
// import). Any of them whose number is on the account's suppression list
// (an opted-out number that was later anonymised, migration 077) is
// marked opted out again. The list is service-role only, so the browser
// cannot check it itself. Response: `{ opted_out: number }`.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { findSuppressedPhones } from '@/lib/lgpd/suppression'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_IDS = 500

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const limit = checkRateLimit(`contacts:suppressions:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { ids?: unknown } | null
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id))
      : []
    if (ids.length === 0 || ids.length > MAX_IDS) {
      return NextResponse.json({ error: `'ids' must list 1–${MAX_IDS} contact ids` }, { status: 400 })
    }

    const contacts: { id: string; phone: string | null }[] = []
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await ctx.supabase
        .from('contacts')
        .select('id, phone')
        .eq('account_id', ctx.accountId)
        .is('opted_out_at', null)
        .in('id', ids.slice(i, i + 200))
      if (error) throw new Error(error.message)
      contacts.push(...((data ?? []) as { id: string; phone: string | null }[]))
    }

    const admin = supabaseAdmin()
    const suppressed = await findSuppressedPhones(
      admin,
      ctx.accountId,
      contacts.map((c) => c.phone ?? '').filter(Boolean),
    )
    const matchIds = contacts.filter((c) => c.phone && suppressed.has(c.phone)).map((c) => c.id)
    if (matchIds.length > 0) {
      const now = new Date().toISOString()
      const { error } = await admin
        .from('contacts')
        .update({ opted_out_at: now, updated_at: now })
        .eq('account_id', ctx.accountId)
        .in('id', matchIds)
      if (error) throw new Error(error.message)
    }
    return NextResponse.json({ opted_out: matchIds.length })
  } catch (err) {
    if (err instanceof Error && !('status' in err)) {
      console.error('[POST /api/contacts/suppressions] failed:', err.message)
      return NextResponse.json({ error: 'Suppression check failed' }, { status: 500 })
    }
    return toErrorResponse(err)
  }
}
