// ============================================================
// POST /api/auth/mfa/audit — record `mfa.enrolled` / `mfa.disabled`.
//
// TOTP enroll / unenroll happen in the browser against Supabase Auth
// directly (`supabase.auth.mfa.*`), so no server route owns the
// mutation. The trail still has to land (round 2 spec, section 7:
// "Auditado"), and `POST /api/audit` deliberately refuses actions it
// cannot vouch for. This route vouches: it reads the caller's factor
// list with their own session and only writes the row when the
// claimed event matches what Auth reports — a client cannot log
// "disabled" while a verified factor still exists, or vice-versa.
//
// Body: { event: 'enrolled' | 'disabled' }. Any member role.
// Lives under /api/auth so the MFA middleware gate lets it through.
// ============================================================

import { NextResponse } from 'next/server'

import { AUDIT_ACTIONS } from '@/lib/audit'
import { audit } from '@/lib/audit-server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { hasVerifiedTotp } from '@/lib/auth/mfa'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const EVENTS = ['enrolled', 'disabled'] as const
type MfaEvent = (typeof EVENTS)[number]

function isMfaEvent(value: unknown): value is MfaEvent {
  return typeof value === 'string' && (EVENTS as readonly string[]).includes(value)
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()

    const limit = checkRateLimit(`mfa:audit:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const event = body?.event
    if (!isMfaEvent(event)) {
      return NextResponse.json({ error: "'event' must be 'enrolled' or 'disabled'" }, { status: 400 })
    }

    // Truth comes from Auth, not from the body.
    const { data: factors, error } = await ctx.supabase.auth.mfa.listFactors()
    if (error) {
      console.error('[POST /api/auth/mfa/audit] listFactors failed:', error.message)
      return NextResponse.json({ error: 'Could not verify MFA state' }, { status: 502 })
    }
    const enrolled = hasVerifiedTotp(factors?.totp ?? [])
    if ((event === 'enrolled') !== enrolled) {
      return NextResponse.json(
        { error: 'Claimed event does not match the current MFA state' },
        { status: 409 },
      )
    }

    const ok = await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: event === 'enrolled' ? AUDIT_ACTIONS.MFA_ENROLLED : AUDIT_ACTIONS.MFA_DISABLED,
      entityType: 'mfa',
      entityId: ctx.userId,
      metadata: { factor_type: 'totp', role: ctx.role },
    })
    if (!ok) {
      return NextResponse.json({ error: 'Failed to record audit entry' }, { status: 500 })
    }
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
