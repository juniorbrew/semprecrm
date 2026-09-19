// ============================================================
// /api/platform/gate — the platform (master) area's own login.
//
//   POST   { username, password }                  sign in  → cookie
//   PUT    { username, password }                  first-time setup
//   PATCH  { currentPassword, username?, newPassword? }  change
//   DELETE                                          sign out
//
// Every verb first requires a signed-in platform admin (the CRM
// session + `is_platform_admin()`); the gate is a second lock on top
// of that, never a replacement. Credentials live in
// `platform_gate_credentials` (migration 045, service role only).
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  hashGatePassword,
  isAcceptableGatePassword,
  normalizeGateUsername,
  verifyGatePassword,
} from '@/lib/platform/gate-crypto'
import { clearGateCookie, issueGateCookie, loadGateCredentials } from '@/lib/platform/gate'
import { getPlatformAdmin } from '@/lib/platform/server'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xri = request.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = (await request.json().catch(() => null)) as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  return body as Record<string, unknown>
}

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 })

/** POST — sign in with the gate username + password. */
export async function POST(request: Request) {
  const ctx = await getPlatformAdmin()
  if (!ctx) return notFound()

  const rl = checkRateLimit(`platform-gate:${getClientIp(request)}:${ctx.user.id}`, RATE_LIMITS.platformGate)
  if (!rl.success) return rateLimitResponse(rl)

  const body = await readBody(request)
  const username = normalizeGateUsername(body?.username)
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!ctx.gate) {
    return NextResponse.json({ error: 'Set up the panel access first', code: 'gate_not_set' }, { status: 409 })
  }
  // Same message for a wrong username and a wrong password.
  if (!username || username !== ctx.gate.username || !verifyGatePassword(password, ctx.gate.passwordHash)) {
    return NextResponse.json({ error: 'Incorrect username or password' }, { status: 401 })
  }

  const res = NextResponse.json({ ok: true })
  const cookie = issueGateCookie(ctx.gate)
  res.cookies.set(cookie.name, cookie.value, cookie.options)
  return res
}

/** PUT — first-time setup (only while no credentials exist). */
export async function PUT(request: Request) {
  const ctx = await getPlatformAdmin()
  if (!ctx) return notFound()
  if (ctx.gate) {
    return NextResponse.json({ error: 'Panel access is already set up', code: 'gate_exists' }, { status: 409 })
  }

  const body = await readBody(request)
  const username = normalizeGateUsername(body?.username)
  if (!username) {
    return NextResponse.json({ error: 'Username must have 3 to 40 characters (letters, numbers, . _ - @)' }, { status: 400 })
  }
  if (!isAcceptableGatePassword(body?.password)) {
    return NextResponse.json({ error: 'Password must have at least 8 characters' }, { status: 400 })
  }

  const { error } = await supabaseAdmin()
    .from('platform_gate_credentials')
    .insert({ user_id: ctx.user.id, username, password_hash: hashGatePassword(body.password) })
  if (error) {
    console.error('[platform gate] setup failed:', error.message)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }

  const creds = await loadGateCredentials(ctx.user.id)
  const res = NextResponse.json({ ok: true })
  if (creds) {
    const cookie = issueGateCookie(creds)
    res.cookies.set(cookie.name, cookie.value, cookie.options)
  }
  return res
}

/** PATCH — change username and/or password; current password required. */
export async function PATCH(request: Request) {
  const ctx = await getPlatformAdmin()
  if (!ctx) return notFound()
  if (!ctx.gate || !ctx.gateOpen) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rl = checkRateLimit(`platform-gate:${getClientIp(request)}:${ctx.user.id}`, RATE_LIMITS.platformGate)
  if (!rl.success) return rateLimitResponse(rl)

  const body = await readBody(request)
  const current = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
  if (!verifyGatePassword(current, ctx.gate.passwordHash)) {
    return NextResponse.json({ error: 'Current password is incorrect' }, { status: 401 })
  }

  const patch: { username?: string; password_hash?: string; updated_at: string } = {
    updated_at: new Date().toISOString(),
  }
  if (body?.username !== undefined) {
    const username = normalizeGateUsername(body.username)
    if (!username) {
      return NextResponse.json({ error: 'Username must have 3 to 40 characters (letters, numbers, . _ - @)' }, { status: 400 })
    }
    patch.username = username
  }
  if (body?.newPassword !== undefined) {
    if (!isAcceptableGatePassword(body.newPassword)) {
      return NextResponse.json({ error: 'Password must have at least 8 characters' }, { status: 400 })
    }
    patch.password_hash = hashGatePassword(body.newPassword)
  }
  if (!patch.username && !patch.password_hash) {
    return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })
  }

  const { error } = await supabaseAdmin()
    .from('platform_gate_credentials')
    .update(patch)
    .eq('user_id', ctx.user.id)
  if (error) {
    console.error('[platform gate] update failed:', error.message)
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
  }

  // `updated_at` moved, so every older cookie is now invalid — re-issue
  // this one so the admin is not logged out of the panel by their own change.
  const creds = await loadGateCredentials(ctx.user.id)
  const res = NextResponse.json({ ok: true, username: creds?.username ?? patch.username ?? ctx.gate.username })
  if (creds) {
    const cookie = issueGateCookie(creds)
    res.cookies.set(cookie.name, cookie.value, cookie.options)
  }
  return res
}

/** DELETE — sign out of the panel (the CRM session stays). */
export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  const cookie = clearGateCookie()
  res.cookies.set(cookie.name, cookie.value, cookie.options)
  return res
}
