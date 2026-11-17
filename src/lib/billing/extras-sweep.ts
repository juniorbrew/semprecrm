// ============================================================
// Scheduled removal of extras (migration 114), run by the hourly billing cron.
//
// An account with a scheduled removal (`extras_reduce_due` = due date D of the
// first charge that must not include the extras) goes through two steps, each
// one a change through runExtrasChange:
//
//   LOWER  once the charge due just before D is PAID (so every extra was billed
//          for its full period) and the usage fits the new limit: the Asaas value
//          drops, and with it the charges generated for D onwards.
//   APPLY  from day D on: the limit drops (the extras columns take the target).
//
// If, when it takes effect, usage no longer fits, the extras are KEPT: the
// removal is cancelled, Asaas is raised back if it had been lowered, and the
// audit row `billing.extras_removal_blocked` says so. Members are never touched.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { listSubscriptionPayments } from '@/lib/billing/asaas'
import { extrasCostCents, type ExtrasState } from '@/lib/billing/extras'
import { accountUsage, pickNew, runExtrasChange, type BillingExtrasRow, type Decision } from '@/lib/billing/extras-service'
import { isBillingCycle, PAID_STATUSES, todayInSaoPaulo } from '@/lib/billing/rules'
import { loadAccountEntitlements } from '@/lib/plans-server'

type Skip = 'skip'

export interface SweepResult {
  lowered: number
  applied: number
  blocked: number
  errors: number
}

export async function sweepExtrasRemovals(db: SupabaseClient, now: Date = new Date()): Promise<SweepResult> {
  const out: SweepResult = { lowered: 0, applied: 0, blocked: 0, errors: 0 }
  const { data, error } = await db
    .from('account_billing')
    .select('account_id')
    .eq('status', 'active')
    .not('pending_extra_users', 'is', null)
    .limit(200)
  if (error) throw new Error(`extras sweep read failed: ${error.message}`)
  const today = todayInSaoPaulo(now)

  for (const { account_id: accountId } of (data ?? []) as { account_id: string }[]) {
    try {
      // Two passes: lower, then (if the day has come) apply.
      for (let pass = 0; pass < 2; pass++) {
        let step: 'lowered' | 'applied' | 'blocked' | null = null
        const r = await runExtrasChange<Skip>(db, {
          accountId,
          actorId: null,
          maxPerDay: null,
          decide: async (row) => {
            const d = await decideStep(db, row, today)
            if ('refuse' in d) return d
            step = d.step
            return d.decision
          },
        })
        if (!r.ok) {
          if (r.code === 'conflict' || r.code === 'provider') out.errors++
          break
        }
        if (step === 'lowered') out.lowered++
        else if (step === 'applied') out.applied++
        else if (step === 'blocked') out.blocked++
        if (step !== 'lowered') break
      }
    } catch (err) {
      out.errors++
      console.error('[billing/extras-sweep] account failed:', accountId, err instanceof Error ? err.message : err)
    }
  }
  return out
}

async function decideStep(
  db: SupabaseClient,
  row: BillingExtrasRow,
  today: string,
): Promise<{ refuse: Skip } | { step: 'lowered' | 'applied' | 'blocked'; decision: Extract<Decision<Skip>, { next: unknown }> }> {
  const due = row.extras_reduce_due
  const cycle = row.cycle
  if (!due || row.pending_extra_users === null || row.pending_extra_channels === null || !row.asaas_subscription_id || !isBillingCycle(cycle) || row.status !== 'active') {
    return { refuse: 'skip' }
  }
  const ent = await loadAccountEntitlements(db, row.account_id)
  if (!ent || ent.blocked) return { refuse: 'skip' }

  const current: ExtrasState = {
    users: row.extra_users,
    channels: row.extra_channels,
    userPriceCents: row.extra_user_price_cents,
    channelPriceCents: row.extra_channel_price_cents,
  }
  const target = { users: row.pending_extra_users, channels: row.pending_extra_channels }
  const targetState: ExtrasState = { ...current, users: target.users, channels: target.channels }
  const fullValue = row.extras_asaas_lowered
    ? Number(row.value_cents) - extrasCostCents(cycle, targetState) + extrasCostCents(cycle, current)
    : Number(row.value_cents)
  const loweredValue = fullValue - extrasCostCents(cycle, current) + extrasCostCents(cycle, targetState)

  const usage = await accountUsage(db, row.account_id)
  const baseUsers = ent.limits.max_users === null ? null : ent.limits.max_users - ent.extras.users
  const baseChannels = ent.limits.max_channels === null ? null : ent.limits.max_channels - ent.extras.channels
  const fits = (baseUsers === null || usage.users <= baseUsers + target.users) && (baseChannels === null || usage.channels <= baseChannels + target.channels)
  const dayCame = today >= due

  if (!fits) {
    if (!dayCame) return { refuse: 'skip' }
    return {
      step: 'blocked',
      decision: {
        next: pickNew(row, { value_cents: fullValue, pending_extra_users: null, pending_extra_channels: null, extras_reduce_due: null, extras_asaas_lowered: false }),
        asaas: row.extras_asaas_lowered ? { valueCents: fullValue, updatePending: true } : null,
        action: 'billing.extras_removal_blocked',
        metadata: { target, usage, effective_date: due, kept: { extra_users: row.extra_users, extra_channels: row.extra_channels } },
      },
    }
  }

  if (!row.extras_asaas_lowered) {
    // The charge due just before D must be paid: every extra was billed for its full period.
    const payments = await listSubscriptionPayments(row.asaas_subscription_id)
    const before = payments.filter((p) => p.dueDate < due).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).at(-1)
    if (!before || !PAID_STATUSES.has(before.status)) return { refuse: 'skip' }
    return {
      step: 'lowered',
      decision: {
        next: pickNew(row, { value_cents: loweredValue, extras_asaas_lowered: true }),
        // Pending charges are all due on or after D, which no longer include the extras.
        asaas: { valueCents: loweredValue, updatePending: true },
        action: 'billing.extras_removal_applied',
        metadata: { step: 'lowered', effective_date: due, value_cents: loweredValue },
      },
    }
  }

  if (!dayCame) return { refuse: 'skip' }
  const none = target.users === 0 && target.channels === 0
  return {
    step: 'applied',
    decision: {
      next: pickNew(row, {
        extra_users: target.users,
        extra_channels: target.channels,
        extra_user_price_cents: target.users === 0 ? null : row.extra_user_price_cents,
        extra_channel_price_cents: target.channels === 0 ? null : row.extra_channel_price_cents,
        extras_first_due: none ? null : row.extras_first_due,
        pending_extra_users: null,
        pending_extra_channels: null,
        extras_reduce_due: null,
        extras_asaas_lowered: false,
      }),
      asaas: null,
      action: 'billing.extras_removal_applied',
      metadata: { step: 'applied', effective_date: due, from: { extra_users: row.extra_users, extra_channels: row.extra_channels }, to: { extra_users: target.users, extra_channels: target.channels } },
    },
  }
}
