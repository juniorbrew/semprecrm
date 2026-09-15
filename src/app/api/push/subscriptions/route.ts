// ============================================================
// /api/push/subscriptions — this browser's Web Push subscription.
//
//   GET    — the caller's subscriptions (device list in Settings).
//   POST   — save { subscription: PushSubscriptionJSON, user_agent }
//            for the session user. Upsert on endpoint: re-enabling in
//            the same browser refreshes the keys instead of duplicating.
//   DELETE — { endpoint } or { id } → remove that subscription (own
//            rows only).
//
// Always the session user: the endpoint is a capability to push to a
// device, so it is never accepted on behalf of somebody else. RLS
// (036) enforces the same rule; the route just shapes / validates.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { isPushConfigured } from '@/lib/push/send'

const MAX_ENDPOINT = 2048
const MAX_KEY = 512
const MAX_UA = 300

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_ENDPOINT) return false
  try {
    return new URL(v).protocol === 'https:'
  } catch {
    return false
  }
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('push_subscriptions')
      .select('id, endpoint, user_agent, created_at, last_used_at')
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: true })
    if (error) {
      console.error('[GET /api/push/subscriptions] failed:', error)
      return NextResponse.json({ error: 'Failed to load subscriptions' }, { status: 500 })
    }
    return NextResponse.json({ subscriptions: data ?? [], configured: isPushConfigured() })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const limit = checkRateLimit(`push:subscribe:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    if (!isPushConfigured()) {
      return NextResponse.json({ error: 'Push is not configured on this server' }, { status: 503 })
    }

    const body = (await request.json().catch(() => null)) as unknown
    if (!isPlainObject(body) || !isPlainObject(body.subscription)) {
      return NextResponse.json({ error: "'subscription' must be an object" }, { status: 400 })
    }
    const sub = body.subscription
    const keys = isPlainObject(sub.keys) ? sub.keys : null
    if (!isHttpsUrl(sub.endpoint)) {
      return NextResponse.json(
        { error: "'subscription.endpoint' must be an https URL" },
        { status: 400 },
      )
    }
    if (
      !keys ||
      typeof keys.p256dh !== 'string' ||
      typeof keys.auth !== 'string' ||
      keys.p256dh.length === 0 ||
      keys.auth.length === 0 ||
      keys.p256dh.length > MAX_KEY ||
      keys.auth.length > MAX_KEY
    ) {
      return NextResponse.json(
        { error: "'subscription.keys' must carry p256dh and auth" },
        { status: 400 },
      )
    }
    const userAgent =
      typeof body.user_agent === 'string' ? body.user_agent.slice(0, MAX_UA) : null

    const { data, error } = await ctx.supabase
      .from('push_subscriptions')
      .upsert(
        {
          account_id: ctx.accountId,
          user_id: ctx.userId,
          endpoint: sub.endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
          user_agent: userAgent,
        },
        { onConflict: 'endpoint' },
      )
      .select('id, endpoint, user_agent, created_at, last_used_at')
      .single()
    if (error) {
      console.error('[POST /api/push/subscriptions] upsert failed:', error)
      return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 })
    }
    return NextResponse.json({ subscription: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => null)) as unknown
    const endpoint = isPlainObject(body) ? body.endpoint : null
    const id = isPlainObject(body) ? body.id : null
    if (!isHttpsUrl(endpoint) && typeof id !== 'string') {
      return NextResponse.json({ error: "'endpoint' or 'id' is required" }, { status: 400 })
    }
    let q = ctx.supabase.from('push_subscriptions').delete().eq('user_id', ctx.userId)
    q = typeof id === 'string' ? q.eq('id', id) : q.eq('endpoint', endpoint as string)
    const { error } = await q
    if (error) {
      console.error('[DELETE /api/push/subscriptions] failed:', error)
      return NextResponse.json({ error: 'Failed to remove subscription' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
