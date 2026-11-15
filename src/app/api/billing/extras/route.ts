// ============================================================
// POST /api/billing/extras — buy or remove extra users / WhatsApp numbers
// (migration 114; spec 2026-11-15-indicadores-e-extras.md, Parte C).
//
// Owner and admins, active paid account only (trial, read-only and blocked
// accounts are refused). Body { kind: 'user' | 'channel', delta }. The account
// is the session's, never the body's.
//
// Order, so money and limits never disagree:
//   1. read the billing row and compute the new subscription value;
//   2. update the value in Asaas (next charges only, no proration);
//   3. only after Asaas confirms, write the extras with compare-and-swap on
//      every value that was read. 0 rows = someone else changed it first:
//      the Asaas value is put back to what the database now holds.
// An Asaas failure changes nothing here. The new limit applies at once.
// ============================================================

import { NextResponse } from 'next/server'

import { AUDIT_ACTIONS } from '@/lib/audit'
import { audit } from '@/lib/audit-server'
import { requireRole, requireWritable, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { asaasConfigured, updateSubscriptionValue } from '@/lib/billing/asaas'
import { changeExtras, type ExtrasRefusal, type ExtrasState } from '@/lib/billing/extras'
import { isBillingCycle } from '@/lib/billing/rules'
import { loadCurrentPlanCatalog } from '@/lib/plan-catalog-server'
import { loadAccountEntitlements, countConnectedChannels } from '@/lib/plans-server'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/** Extras changes per account in 24 h (each one edits a real subscription in Asaas). */
export const MAX_EXTRAS_CHANGES_PER_DAY = 10

export const EXTRAS_ERRORS = {
  notConfigured: 'Online payment is not available yet. Talk to the SempreCRM team.',
  body: 'Choose what to change and how many.',
  unavailable: 'Extras are only available on an active paid subscription. Subscribe first, or wait until the payment is confirmed.',
  notOffered: 'Your plan does not offer this extra. Talk to the SempreCRM team.',
  unlimited: 'Your plan has no limit here, so there is nothing to add.',
  cap: 'You reached the maximum number of extras. Talk to the SempreCRM team.',
  belowUsage: 'You are using more than the new limit would allow. Free up a user or number first.',
  tooMany: 'Too many changes in the last 24 hours. Try again tomorrow or talk to the SempreCRM team.',
  conflict: 'Your subscription changed while you were doing this. Reload the page and try again.',
  provider: 'Could not change it right now, try again.',
} as const

const REFUSALS: Record<ExtrasRefusal, [keyof typeof EXTRAS_ERRORS, number]> = {
  invalid: ['body', 400],
  not_offered: ['notOffered', 400],
  unlimited: ['unlimited', 400],
  cap: ['cap', 400],
  below_usage: ['belowUsage', 409],
}

type BillingRow = {
  asaas_subscription_id: string | null
  cycle: string
  value_cents: number
  status: string
  extra_users: number
  extra_channels: number
  extra_user_price_cents: number | null
  extra_channel_price_cents: number | null
}
const BILLING_COLUMNS =
  'asaas_subscription_id, cycle, value_cents, status, extra_users, extra_channels, extra_user_price_cents, extra_channel_price_cents'

export async function POST(request: Request) {
  try {
    const ctx = await requireWritable(await requireRole('admin'))
    const limit = checkRateLimit(`billing:extras:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    if (!asaasConfigured()) return NextResponse.json({ error: EXTRAS_ERRORS.notConfigured }, { status: 503 })

    const body = (await request.json().catch(() => null)) as { kind?: unknown; delta?: unknown } | null
    const kind = body?.kind
    const delta = body?.delta
    if ((kind !== 'user' && kind !== 'channel') || typeof delta !== 'number') {
      return NextResponse.json({ error: EXTRAS_ERRORS.body }, { status: 400 })
    }

    const db = supabaseAdmin()
    const ent = await loadAccountEntitlements(db, ctx.accountId)
    const { data: row, error: billErr } = await db.from('account_billing').select(BILLING_COLUMNS).eq('account_id', ctx.accountId).maybeSingle()
    if (billErr) throw new Error(`billing read failed: ${billErr.message}`)
    const b = row as BillingRow | null
    if (!ent || ent.blocked || ent.status !== 'active' || !b || b.status !== 'active' || !b.asaas_subscription_id || !isBillingCycle(b.cycle)) {
      return NextResponse.json({ error: EXTRAS_ERRORS.unavailable }, { status: 403 })
    }
    const cycle = b.cycle
    const subscriptionId = b.asaas_subscription_id
    // The entitlements and the billing row were read apart: they must agree.
    if (ent.extras.users !== b.extra_users && ent.limits.max_users !== null) return conflict()
    if (ent.extras.channels !== b.extra_channels && ent.limits.max_channels !== null) return conflict()

    const since = new Date(Date.now() - 24 * 3_600_000).toISOString()
    const { count: recent, error: capErr } = await db
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', ctx.accountId)
      .eq('action', AUDIT_ACTIONS.BILLING_EXTRAS_CHANGED)
      .gte('created_at', since)
    if (capErr) throw new Error(`extras cap read failed: ${capErr.message}`)
    if ((recent ?? 0) >= MAX_EXTRAS_CHANGES_PER_DAY) {
      return NextResponse.json({ error: EXTRAS_ERRORS.tooMany }, { status: 429 })
    }

    const definition = (await loadCurrentPlanCatalog(db)).find((v) => v.plan === ent.plan)?.definition
    const current: ExtrasState = {
      users: b.extra_users,
      channels: b.extra_channels,
      userPriceCents: b.extra_user_price_cents,
      channelPriceCents: b.extra_channel_price_cents,
    }
    const result = changeExtras({
      cycle,
      currentValueCents: Number(b.value_cents),
      current,
      kind,
      delta,
      offeredPriceCents: (kind === 'user' ? definition?.extra_user_price_cents : definition?.extra_channel_price_cents) ?? null,
      baseLimit: kind === 'user' ? baseOf(ent.limits.max_users, ent.extras.users) : baseOf(ent.limits.max_channels, ent.extras.channels),
      usage: delta < 0 ? await usageOf(db, ctx.accountId, kind) : 0,
    })
    if (!result.ok) {
      const [key, status] = REFUSALS[result.code]
      return NextResponse.json({ error: EXTRAS_ERRORS[key] }, { status })
    }

    // 2. Asaas first. Whatever the failure (even a timeout whose answer we never
    // saw), nothing is written here, and the old value is asked back so Asaas
    // cannot be left holding a value the account never got.
    try {
      await updateSubscriptionValue(subscriptionId, result.valueCents / 100)
    } catch (err) {
      console.error('[billing/extras] Asaas update failed:', err instanceof Error ? err.message : err)
      await restoreAsaas(subscriptionId, Number(b.value_cents))
      return NextResponse.json({ error: EXTRAS_ERRORS.provider }, { status: 502 })
    }

    // 3. Compare-and-swap on everything read; a concurrent change makes it 0 rows.
    let swapped: { account_id: string }[] | null = null
    try {
      let q = db
        .from('account_billing')
        .update({
          extra_users: result.next.users,
          extra_channels: result.next.channels,
          extra_user_price_cents: result.next.userPriceCents,
          extra_channel_price_cents: result.next.channelPriceCents,
          value_cents: result.valueCents,
        })
        .eq('account_id', ctx.accountId)
        .eq('status', 'active')
        .eq('asaas_subscription_id', subscriptionId)
        .eq('value_cents', b.value_cents)
        .eq('extra_users', b.extra_users)
        .eq('extra_channels', b.extra_channels)
      q = b.extra_user_price_cents === null ? q.is('extra_user_price_cents', null) : q.eq('extra_user_price_cents', b.extra_user_price_cents)
      q = b.extra_channel_price_cents === null ? q.is('extra_channel_price_cents', null) : q.eq('extra_channel_price_cents', b.extra_channel_price_cents)
      const { data, error } = await q.select('account_id')
      if (error) throw new Error(`extras save failed: ${error.message}`)
      swapped = data
    } catch (err) {
      await syncAsaasToDb(db, ctx.accountId, subscriptionId)
      throw err
    }
    if (!swapped?.length) {
      await syncAsaasToDb(db, ctx.accountId, subscriptionId)
      return conflict()
    }

    await audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: AUDIT_ACTIONS.BILLING_EXTRAS_CHANGED,
      entityType: 'account_billing',
      entityId: ctx.accountId,
      metadata: {
        kind,
        delta,
        from: { extra_users: b.extra_users, extra_channels: b.extra_channels, value_cents: Number(b.value_cents) },
        to: { extra_users: result.next.users, extra_channels: result.next.channels, value_cents: result.valueCents },
      },
    })
    return NextResponse.json({
      extras: { users: result.next.users, channels: result.next.channels },
      valueCents: result.valueCents,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

function conflict() {
  return NextResponse.json({ error: EXTRAS_ERRORS.conflict }, { status: 409 })
}

/** Plan limit without the extras (null = unlimited). */
function baseOf(effective: number | null, extras: number): number | null {
  return effective === null ? null : effective - extras
}

type Db = ReturnType<typeof supabaseAdmin>

/** What the account uses today: users = members + pending invites (as the invite route counts), channels as the connect routes do. */
async function usageOf(db: Db, accountId: string, kind: 'user' | 'channel'): Promise<number> {
  if (kind === 'channel') return countConnectedChannels(db, accountId)
  const [members, invites] = await Promise.all([
    db.from('profiles').select('user_id', { count: 'exact', head: true }).eq('account_id', accountId),
    db
      .from('account_invitations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString()),
  ])
  if (members.error || invites.error) throw new Error('usage read failed')
  return (members.count ?? 0) + (invites.count ?? 0)
}

/** Best effort: ask Asaas to hold `valueCents` again. A failure is logged for manual repair. */
async function restoreAsaas(subscriptionId: string, valueCents: number): Promise<void> {
  try {
    await updateSubscriptionValue(subscriptionId, valueCents / 100)
  } catch (err) {
    console.error(
      '[billing/extras] ASAAS VALUE MAY DIFFER from the database, fix subscription',
      subscriptionId,
      'to cents',
      valueCents,
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * After a lost compare-and-swap: the database is the truth. Re-read its value and
 * put Asaas back to it (if the account still points at the same subscription).
 */
async function syncAsaasToDb(db: Db, accountId: string, subscriptionId: string): Promise<void> {
  const { data } = await db.from('account_billing').select('asaas_subscription_id, value_cents').eq('account_id', accountId).maybeSingle()
  if (!data || data.asaas_subscription_id !== subscriptionId) {
    console.error('[billing/extras] subscription replaced during an extras change, check Asaas value of', subscriptionId)
    return
  }
  await restoreAsaas(subscriptionId, Number(data.value_cents))
}
