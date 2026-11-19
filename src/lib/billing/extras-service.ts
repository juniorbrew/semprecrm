// ============================================================
// Engine of every change to an account's extras (migration 114), shared by the
// owner's route and the removal sweep so the safety rules live in ONE place:
//
//   1. CLAIM the account (advisory lock in the database; one change at a time,
//      and the daily cap counted from the audit rows under that lock);
//   2. decide from the row the claim returned;
//   3. Asaas first (the new value of the subscription);
//   4. COMMIT: the extras and their audit row in one transaction, compare-and-swap
//      against what was read and against our claim token;
//   5. whenever Asaas and the database could disagree, ask Asaas what it holds
//      (never a blind restore), put it back to the database value, check again,
//      and leave an audit row `billing.extras_mismatch` if it still differs.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { AUDIT_ACTIONS } from '@/lib/audit'
import { audit } from '@/lib/audit-server'
import { getSubscription, updateSubscriptionValue } from '@/lib/billing/asaas'
import { countConnectedChannels } from '@/lib/plans-server'

/** What the claim returns (columns of account_billing the engine needs). */
export interface BillingExtrasRow {
  account_id: string
  asaas_customer_id: string | null
  asaas_subscription_id: string | null
  cycle: string
  status: string
  value_cents: number
  extra_users: number
  extra_channels: number
  extra_user_price_cents: number | null
  extra_channel_price_cents: number | null
  extras_first_due: string | null
  pending_extra_users: number | null
  pending_extra_channels: number | null
  extras_reduce_due: string | null
  extras_asaas_lowered: boolean
  /** An annual add waiting for its one-off charge (deltas, locked prices, the Asaas charge). */
  pending_add_users: number | null
  pending_add_channels: number | null
  pending_add_user_price_cents: number | null
  pending_add_channel_price_cents: number | null
  extras_oneoff_payment_id: string | null
  extras_oneoff_url: string | null
  extras_oneoff_cents: number | null
  extras_oneoff_expires_at: string | null
}

/** The columns a change writes (everything else of the row is untouched). */
export type NewExtrasRow = Pick<
  BillingExtrasRow,
  | 'extra_users'
  | 'extra_channels'
  | 'extra_user_price_cents'
  | 'extra_channel_price_cents'
  | 'value_cents'
  | 'extras_first_due'
  | 'pending_extra_users'
  | 'pending_extra_channels'
  | 'extras_reduce_due'
  | 'extras_asaas_lowered'
  | 'pending_add_users'
  | 'pending_add_channels'
  | 'pending_add_user_price_cents'
  | 'pending_add_channel_price_cents'
  | 'extras_oneoff_payment_id'
  | 'extras_oneoff_url'
  | 'extras_oneoff_cents'
  | 'extras_oneoff_expires_at'
>

export type ExtrasAction =
  | 'billing.extras_changed'
  | 'billing.extras_removal_applied'
  | 'billing.extras_removal_blocked'
  | 'billing.extras_add_cancelled'

export type Decision<C extends string> =
  | { refuse: C }
  | {
      next: NewExtrasRow
      /** New value of the subscription in Asaas; null = Asaas is already right. */
      asaas: { valueCents: number; updatePending: boolean } | null
      action: ExtrasAction
      metadata: Record<string, unknown>
      /** Undo a side effect made while deciding (a one-off charge) when the change is not committed. */
      compensate?: () => Promise<void>
    }

export type ExtrasResult<C extends string> =
  | { ok: true; row: NewExtrasRow }
  | { ok: false; code: C | 'none' | 'busy' | 'daily_cap' | 'conflict' | 'provider' }

export function pickNew(row: BillingExtrasRow, patch: Partial<NewExtrasRow> = {}): NewExtrasRow {
  return {
    extra_users: row.extra_users,
    extra_channels: row.extra_channels,
    extra_user_price_cents: row.extra_user_price_cents,
    extra_channel_price_cents: row.extra_channel_price_cents,
    value_cents: Number(row.value_cents),
    extras_first_due: row.extras_first_due,
    pending_extra_users: row.pending_extra_users,
    pending_extra_channels: row.pending_extra_channels,
    extras_reduce_due: row.extras_reduce_due,
    extras_asaas_lowered: row.extras_asaas_lowered,
    pending_add_users: row.pending_add_users,
    pending_add_channels: row.pending_add_channels,
    pending_add_user_price_cents: row.pending_add_user_price_cents,
    pending_add_channel_price_cents: row.pending_add_channel_price_cents,
    extras_oneoff_payment_id: row.extras_oneoff_payment_id,
    extras_oneoff_url: row.extras_oneoff_url,
    extras_oneoff_cents: row.extras_oneoff_cents,
    extras_oneoff_expires_at: row.extras_oneoff_expires_at,
    ...patch,
  }
}

export async function runExtrasChange<C extends string>(
  db: SupabaseClient,
  o: {
    accountId: string
    actorId: string | null
    /** Daily cap of user-made changes; null for the system's own steps. */
    maxPerDay: number | null
    decide: (row: BillingExtrasRow) => Promise<Decision<C>>
  },
): Promise<ExtrasResult<C>> {
  const { data: claim, error: claimErr } = await db.rpc('billing_extras_claim', { p_account: o.accountId, p_max_per_day: o.maxPerDay })
  if (claimErr) throw new Error(`extras claim failed: ${claimErr.message}`)
  const c = claim as { status: string; token?: string; row?: BillingExtrasRow }
  if (c.status !== 'ok' || !c.token || !c.row) {
    return { ok: false, code: c.status === 'busy' ? 'busy' : c.status === 'cap' ? 'daily_cap' : 'none' }
  }
  const token = c.token
  const row = c.row
  const subscriptionId = row.asaas_subscription_id
  let committed = false
  let compensate: (() => Promise<void>) | undefined
  try {
    const decision = await o.decide(row)
    if ('refuse' in decision) return { ok: false, code: decision.refuse }
    compensate = decision.compensate

    if (decision.asaas && subscriptionId) {
      try {
        await updateSubscriptionValue(subscriptionId, decision.asaas.valueCents / 100, decision.asaas.updatePending)
      } catch (err) {
        console.error('[billing/extras] Asaas update failed:', err instanceof Error ? err.message : err)
        await reconcileAsaas(o.accountId, subscriptionId, Number(row.value_cents))
        return { ok: false, code: 'provider' }
      }
    }

    let ok: boolean
    try {
      const { data, error } = await db.rpc('billing_extras_commit', {
        p_account: o.accountId,
        p_token: token,
        p_expect: {
          asaas_subscription_id: subscriptionId,
          value_cents: Number(row.value_cents),
          extra_users: row.extra_users,
          extra_channels: row.extra_channels,
          extra_user_price_cents: row.extra_user_price_cents,
          extra_channel_price_cents: row.extra_channel_price_cents,
          pending_extra_users: row.pending_extra_users,
          extras_asaas_lowered: row.extras_asaas_lowered,
          extras_oneoff_payment_id: row.extras_oneoff_payment_id,
        },
        p_new: decision.next,
        p_actor: o.actorId,
        p_action: decision.action,
        p_metadata: decision.metadata,
      })
      if (error) throw new Error(error.message)
      ok = data === true
    } catch (err) {
      // The commit may even have landed with only its answer lost: Asaas must follow the database.
      await reconcileToDatabase(db, o.accountId, subscriptionId)
      throw err
    }
    if (!ok) {
      await reconcileToDatabase(db, o.accountId, subscriptionId)
      return { ok: false, code: 'conflict' }
    }
    committed = true
    return { ok: true, row: decision.next }
  } finally {
    if (!committed) {
      if (compensate) {
        try {
          await compensate()
        } catch (err) {
          console.error('[billing/extras] could not undo a side effect, check Asaas:', err instanceof Error ? err.message : err)
        }
      }
      const { error } = await db.rpc('billing_extras_release', { p_account: o.accountId, p_token: token })
      if (error) console.error('[billing/extras] could not release the claim (it expires by itself):', error.message)
    }
  }
}

/** Asaas must hold the database's value: re-read the database, then reconcile. */
async function reconcileToDatabase(db: SupabaseClient, accountId: string, subscriptionId: string | null): Promise<void> {
  if (!subscriptionId) return
  const { data } = await db.from('account_billing').select('asaas_subscription_id, value_cents').eq('account_id', accountId).maybeSingle()
  if (!data || data.asaas_subscription_id !== subscriptionId) {
    await recordMismatch(accountId, subscriptionId, { reason: 'subscription replaced during an extras change' })
    return
  }
  await reconcileAsaas(accountId, subscriptionId, Number(data.value_cents))
}

/**
 * Ask Asaas what it holds; when it differs from `dbValueCents` set it back (pending charges
 * follow) and check again. A failure at any step, or a value that still differs, is recorded.
 */
export async function reconcileAsaas(accountId: string, subscriptionId: string, dbValueCents: number): Promise<void> {
  let seen: number | null = null
  try {
    const sub = await getSubscription(subscriptionId)
    seen = typeof sub.value === 'number' ? Math.round(sub.value * 100) : null
    if (seen === dbValueCents) return
    await updateSubscriptionValue(subscriptionId, dbValueCents / 100, true)
    const again = await getSubscription(subscriptionId)
    seen = typeof again.value === 'number' ? Math.round(again.value * 100) : null
    if (seen === dbValueCents) return
  } catch (err) {
    console.error('[billing/extras] reconcile failed:', err instanceof Error ? err.message : err)
  }
  await recordMismatch(accountId, subscriptionId, { asaas_value_cents: seen, db_value_cents: dbValueCents })
}

async function recordMismatch(accountId: string, subscriptionId: string, detail: Record<string, unknown>): Promise<void> {
  console.error('[billing/extras] ASAAS VALUE MAY DIFFER from the database, check subscription', subscriptionId, detail)
  const written = await audit({
    accountId,
    actorUserId: null,
    action: AUDIT_ACTIONS.BILLING_EXTRAS_MISMATCH,
    entityType: 'account_billing',
    entityId: accountId,
    metadata: { subscription_id: subscriptionId, ...detail },
  })
  if (!written) console.error('[billing/extras] the mismatch audit row could not be written either')
}

/** What the account uses today: users = members + pending invites (as the invite route counts), channels as the connect routes do. */
export async function accountUsage(db: SupabaseClient, accountId: string): Promise<{ users: number; channels: number }> {
  const [members, invites, channels] = await Promise.all([
    db.from('profiles').select('user_id', { count: 'exact', head: true }).eq('account_id', accountId),
    db
      .from('account_invitations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString()),
    countConnectedChannels(db, accountId),
  ])
  if (members.error || invites.error) throw new Error('usage read failed')
  return { users: (members.count ?? 0) + (invites.count ?? 0), channels }
}
