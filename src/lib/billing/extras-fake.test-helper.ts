// Test-only: the three extras RPCs of migration 114 (billing_extras_claim / _commit /
// _release) over the in-memory fake db, with the same rules as the SQL: one claim at a
// time per account, the daily cap counted from audit rows, compare-and-swap on commit,
// and the audit row written together with the change.

import { randomUUID } from 'node:crypto'

import type { FakeDbOptions } from '@/lib/lgpd/fake-db.test-helper'

type Row = Record<string, unknown>

const EXPECT_COLUMNS = [
  'asaas_subscription_id',
  'value_cents',
  'extra_users',
  'extra_channels',
  'extra_user_price_cents',
  'extra_channel_price_cents',
  'pending_extra_users',
  'extras_asaas_lowered',
  'extras_oneoff_payment_id',
  'extras_diff_payment_id',
] as const

const NEW_COLUMNS = [
  'extra_users',
  'extra_channels',
  'extra_user_price_cents',
  'extra_channel_price_cents',
  'value_cents',
  'extras_first_due',
  'pending_extra_users',
  'pending_extra_channels',
  'extras_reduce_due',
  'extras_asaas_lowered',
  'pending_add_users',
  'pending_add_channels',
  'pending_add_user_price_cents',
  'pending_add_channel_price_cents',
  'extras_oneoff_payment_id',
  'extras_oneoff_url',
  'extras_oneoff_cents',
  'extras_oneoff_expires_at',
  'extras_oneoff_renewal_due',
  'extras_oneoff_paid_id',
  'extras_diff_payment_id',
  'extras_diff_expires_at',
] as const

export const extrasRpc: NonNullable<FakeDbOptions['rpc']> = (fn, args, tables) => {
  const ok = (data: unknown) => ({ data, error: null })
  const billing = tables.account_billing ?? []
  const row = billing.find((r) => r.account_id === args.p_account) as Row | undefined
  const claimLive = (r: Row) => typeof r.extras_claim_until === 'number' && r.extras_claim_until > Date.now()

  if (fn === 'billing_extras_claim') {
    if (!row) return ok({ status: 'none' })
    if (claimLive(row)) return ok({ status: 'busy' })
    const max = args.p_max_per_day as number | null
    const since = Date.now() - 24 * 3_600_000
    const recent = (tables.audit_log ?? []).filter(
      (a) => a.account_id === args.p_account && a.action === 'billing.extras_changed' && Date.parse(String(a.created_at)) > since,
    ).length
    if (max !== null && recent >= max) return ok({ status: 'cap' })
    const token = randomUUID()
    row.extras_claim_token = token
    row.extras_claim_until = Date.now() + 90_000
    return ok({ status: 'ok', token, row: { ...row } })
  }

  if (fn === 'billing_extras_commit') {
    if (!row || row.extras_claim_token !== args.p_token || !claimLive(row)) return ok(false)
    const expect = args.p_expect as Row
    if (row.status !== 'active' || EXPECT_COLUMNS.some((c) => (row[c] ?? null) !== (expect[c] ?? null))) return ok(false)
    const next = args.p_new as Row
    for (const c of NEW_COLUMNS) row[c] = next[c] ?? null
    row.extras_asaas_lowered = next.extras_asaas_lowered === true
    row.extras_claim_token = null
    row.extras_claim_until = null
    ;(tables.audit_log ??= []).push({
      id: `audit-${tables.audit_log.length + 1}`,
      account_id: args.p_account,
      actor_user_id: args.p_actor,
      action: args.p_action,
      metadata: args.p_metadata,
      created_at: new Date().toISOString(),
    })
    return ok(true)
  }

  if (fn === 'billing_extras_release') {
    if (row && row.extras_claim_token === args.p_token) {
      row.extras_claim_token = null
      row.extras_claim_until = null
    }
    return ok(null)
  }
  if (fn === 'billing_mark_past_due') {
    const r = billing.find((x) => x.account_id === args.p_account_id && x.asaas_subscription_id === args.p_subscription_id) as Row | undefined
    if (!r || (r.status !== 'active' && r.status !== 'past_due')) return ok(false)
    r.status = 'past_due'
    return ok(true)
  }
  return { data: null, error: { message: `unexpected rpc ${fn}` } }
}
