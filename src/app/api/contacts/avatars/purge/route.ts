// ============================================================
// POST /api/contacts/avatars/purge — agent+ (whoever can delete contacts).
//
// Body: `{ ids: string[] }` — contacts the caller just deleted. Removes
// their stored WhatsApp profile photos (`contact-avatars`, migration
// 055), which a member session cannot do (service-role-only bucket).
// Only ids that no longer exist for the caller are purged, and only
// under the caller's own `account-<id>/` folder
// (lib/whatsapp/contact-avatar `purgeDeletedContactAvatars`).
// Best effort: the contacts page fires it after a successful delete.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { AVATAR_PURGE_MAX_IDS, purgeDeletedContactAvatars } from '@/lib/whatsapp/contact-avatar'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const limit = checkRateLimit(`contacts:avatar-purge:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { ids?: unknown } | null
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : []
    if (ids.length === 0 || ids.length > AVATAR_PURGE_MAX_IDS) {
      return NextResponse.json({ error: `'ids' must list 1–${AVATAR_PURGE_MAX_IDS} contact ids` }, { status: 400 })
    }

    const removed = await purgeDeletedContactAvatars(ctx.supabase, supabaseAdmin(), ctx.accountId, ids)
    return NextResponse.json({ ok: true, removed })
  } catch (err) {
    return toErrorResponse(err)
  }
}
