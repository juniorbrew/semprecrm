// ============================================================
// "Buy 1 extra for R$ X/month" shown when inviting a user or connecting a
// number hits the plan limit (migration 116). Server only, and only on the
// limit-hit path: two small reads. The offer is just a price to show; buying
// goes through POST /api/billing/extras, which checks everything again.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { parsePlanVersion } from '@/lib/plan-catalog'
import { loadAccountEntitlements } from '@/lib/plans-server'

import type { ExtraKind } from './extras'

export interface ExtraOffer {
  kind: ExtraKind
  /** Monthly price of one more extra, in cents. */
  monthlyCents: number
  /** Only the account owner can buy; for anyone else the UI says to ask the owner. */
  canBuy: boolean
}

/**
 * The price of one more extra, or null when it cannot be bought now: the
 * account is not on an active paid subscription, the plan has no limit to
 * extend, or the plan sets no price (an owner who already has extras keeps
 * their locked price for more of the same kind). Never throws: the caller is
 * already answering a limit error and must still answer it.
 */
export async function extraOfferFor(db: SupabaseClient, accountId: string, kind: ExtraKind, isOwner: boolean): Promise<ExtraOffer | null> {
  try {
    const ent = await loadAccountEntitlements(db, accountId)
    const limit = kind === 'user' ? ent?.limits.max_users : ent?.limits.max_channels
    if (!ent || ent.blocked || ent.status !== 'active' || limit === null || limit === undefined) return null

    const { data: b } = await db
      .from('account_billing')
      .select('status, asaas_subscription_id, extra_users, extra_channels, extra_user_price_cents, extra_channel_price_cents')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!b || b.status !== 'active' || !b.asaas_subscription_id) return null

    const have = kind === 'user' ? b.extra_users : b.extra_channels
    const locked = kind === 'user' ? b.extra_user_price_cents : b.extra_channel_price_cents
    if (have > 0 && locked !== null) return { kind, monthlyCents: locked, canBuy: isOwner }

    // The current catalog (public RPC, readable by the admin's own client): no server-only import.
    const { data: catalog } = await db.rpc('public_plan_catalog')
    const definition = (Array.isArray(catalog) ? catalog : []).map(parsePlanVersion).find((v) => v?.plan === ent.plan)?.definition
    const price = kind === 'user' ? definition?.extra_user_price_cents : definition?.extra_channel_price_cents
    return typeof price === 'number' ? { kind, monthlyCents: price, canBuy: isOwner } : null
  } catch (err) {
    console.error('[extra-offer] could not compute the offer:', err instanceof Error ? err.message : err)
    return null
  }
}
