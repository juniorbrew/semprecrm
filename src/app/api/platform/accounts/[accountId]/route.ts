// ============================================================
// PATCH /api/platform/accounts/[accountId] — platform (master) admin
// updates an account's plan / status / overrides / notes.
//
// Body: the same patch object `platform_update_account` accepts
// (migration 025/029). The RPC does the authorisation
// (`is_platform_admin()` inside, SECURITY DEFINER) and the
// validation; this route exists so the change lands in the account's
// audit log as `plan.changed` with the platform admin as actor
// (spec §3). The RPC is still called with the caller's session client
// so a non-admin gets the RPC's own 42501.
// ============================================================

import { NextResponse } from 'next/server'
import type { PostgrestError } from '@supabase/supabase-js'

import { AUDIT_ACTIONS, logAudit } from '@/lib/audit'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { createClient } from '@/lib/supabase/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Fields whose change is a "plan change" worth a trail entry. */
const AUDITED_FIELDS = [
  'plan',
  'plan_status',
  'plan_expires_at',
  'module_overrides',
  'limit_overrides',
] as const

function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === '42501') return NextResponse.json({ error: err.message }, { status: 403 })
  if (err.code === '22023') return NextResponse.json({ error: err.message }, { status: 400 })
  console.error('[platform account route] unexpected RPC error:', err)
  return NextResponse.json({ error: 'Failed to update account' }, { status: 500 })
}

function stable(v: unknown): string {
  return JSON.stringify(v ?? null)
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params
  if (!UUID_RE.test(accountId)) {
    return NextResponse.json({ error: 'Invalid account id' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => null)) as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 })
  }
  const patch = body as Record<string, unknown>

  // Snapshot before — the RPC returns the row after, so the diff is
  // cheap. Read with the service role: the platform admin is not a
  // member of the target account, so RLS would hide it.
  const admin = supabaseAdmin()
  const { data: before } = await admin
    .from('accounts')
    .select('plan, plan_status, plan_expires_at, module_overrides, limit_overrides')
    .eq('id', accountId)
    .maybeSingle()

  const { data: after, error } = await supabase.rpc('platform_update_account', {
    p_account_id: accountId,
    p_patch: patch,
  })
  if (error) return rpcErrorToResponse(error)

  const afterRow = (after ?? {}) as Record<string, unknown>
  const beforeRow = (before ?? {}) as Record<string, unknown>
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const k of AUDITED_FIELDS) {
    if (k in patch && stable(beforeRow[k]) !== stable(afterRow[k])) {
      changes[k] = { from: beforeRow[k] ?? null, to: afterRow[k] ?? null }
    }
  }

  if (Object.keys(changes).length > 0) {
    // Actor is the platform admin — not a member, so `actor_user_id`
    // stays null and the name is carried explicitly.
    const { data: prof } = await admin
      .from('profiles')
      .select('full_name, email')
      .eq('user_id', user.id)
      .maybeSingle()
    const who =
      (prof as { full_name?: string | null; email?: string | null } | null)?.full_name?.trim() ||
      (prof as { email?: string | null } | null)?.email?.trim() ||
      user.email ||
      'Platform admin'
    await logAudit(admin, {
      accountId,
      actorUserId: null,
      actorName: `${who} (platform)`,
      action: AUDIT_ACTIONS.PLAN_CHANGED,
      entityType: 'plan',
      entityId: accountId,
      metadata: { platform_admin_user_id: user.id, changes },
    })
  }

  return NextResponse.json({ account: after })
}
