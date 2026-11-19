import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// Contract of migration 114 (plan extras), read as text so a regression shows up
// without a database. The behaviour itself is checked on a real Postgres by
// supabase/tests/plan_extras.sql.

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/114_plan_extras.sql'), 'utf8')
const rollback = readFileSync(join(process.cwd(), 'supabase/rollback/114_rollback.sql'), 'utf8')
const v113 = readFileSync(join(process.cwd(), 'supabase/migrations/113_booking_pages.sql'), 'utf8')

const modulesIn = (text: string) => {
  const body = text.slice(text.indexOf("'dashboard'"), text.indexOf(']) THEN RETURN false'))
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

describe('migration 114 contract', () => {
  it('runs in one transaction with a lock timeout', () => {
    expect(sql).toMatch(/^BEGIN;$/m)
    expect(sql).toMatch(/^COMMIT;$/m)
    expect(sql).toMatch(/SET LOCAL lock_timeout/)
  })

  it('keeps valid_plan_definition identical to 113 for modules; the two price keys are optional and at least 1 cent', () => {
    expect(modulesIn(sql)).toEqual(modulesIn(v113))
    expect(sql).toContain("'extra_user_price_cents','extra_channel_price_cents'")
    expect(sql).not.toMatch(/\?& ARRAY\['modules','limits','extra/)
    expect(sql).toMatch(/\(price #>> '\{\}'\)::numeric < 1 OR/)
  })

  it('is idempotent: columns IF NOT EXISTS, every constraint dropped before it is added', () => {
    const adds = [...sql.matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1])
    expect(adds.length).toBeGreaterThanOrEqual(6)
    for (const name of adds) expect(sql).toContain(`DROP CONSTRAINT IF EXISTS ${name}`)
    for (const m of sql.matchAll(/ADD COLUMN (?!IF NOT EXISTS)/g)) throw new Error(`unguarded ADD COLUMN at ${m.index}`)
  })

  it('adds the columns, capped, with a locked price required for any extra', () => {
    for (const col of ['extra_users', 'extra_channels', 'extra_user_price_cents', 'extra_channel_price_cents', 'pending_extra_users', 'extras_reduce_due', 'extras_asaas_lowered', 'extras_claim_token', 'pending_add_users', 'extras_oneoff_payment_id', 'extras_oneoff_expires_at']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`)
    }
    expect(sql).toMatch(/CHECK \(extra_users BETWEEN 0 AND 100\)/)
    expect(sql).toMatch(/CHECK \(extra_users = 0 OR extra_user_price_cents IS NOT NULL\)/)
    expect(sql).toMatch(/BETWEEN 1 AND 10000000/)
  })

  it('gives clients no write path: no policy, no write grant, every new function closed to all but service_role', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.account_billing FROM PUBLIC, anon, authenticated/)
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)/i)
    expect(sql).not.toMatch(/CREATE POLICY/i)
    for (const fn of ['billing_extras_claim', 'billing_extras_commit', 'billing_extras_release']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`))
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role`))
    }
  })

  it('commit writes the change and its audit row in one function, behind the claim token and the advisory lock', () => {
    const commit = sql.slice(sql.indexOf('FUNCTION public.billing_extras_commit'), sql.indexOf('FUNCTION public.billing_extras_release'))
    expect(commit).toContain('pg_advisory_xact_lock')
    expect(commit).toContain('INSERT INTO public.audit_log')
    expect(commit).toContain('extras_claim_token IS DISTINCT FROM p_token')
    expect(sql.slice(sql.indexOf('FUNCTION public.billing_extras_claim'), sql.indexOf('FUNCTION public.billing_extras_commit'))).toContain("action = 'billing.extras_changed'")
  })

  it('an awaited purchase is all-or-nothing with a price that is really present (NULL would slip through a CHECK)', () => {
    expect(sql).toContain('account_billing_extras_purchase_shape')
    expect(sql).toMatch(/pending_add_user_price_cents IS NOT NULL AND pending_add_user_price_cents BETWEEN 1 AND 10000000/)
    expect(sql).toMatch(/pending_add_channel_price_cents IS NOT NULL AND pending_add_channel_price_cents BETWEEN 1 AND 10000000/)
    expect(sql).toContain("'billing.extras_add_cancelled'")
  })

  it('platform_list_accounts counts extras only for an active subscription, returns them, and keeps its grants', () => {
    // active only, and the TARGET while a removal is pending (what new invites are checked against)
    expect(sql).toContain("CASE WHEN b.status = 'active' THEN LEAST(b.extra_users, COALESCE(b.pending_extra_users, b.extra_users)) ELSE 0 END")
  })

  it('platform_list_accounts returns the extras and keeps its grants', () => {
    expect(sql).toContain('extra_users           INTEGER')
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.platform_list_accounts\(\) TO authenticated, service_role/)
  })

  it('has a rollback that drops what was added and says when it is unsafe', () => {
    for (const col of ['extra_users', 'extra_channels', 'extras_first_due', 'pending_extra_users', 'extras_claim_until']) {
      expect(rollback).toContain(`DROP COLUMN IF EXISTS ${col}`)
    }
    for (const fn of ['billing_extras_claim', 'billing_extras_commit', 'billing_extras_release']) expect(rollback).toContain(`DROP FUNCTION IF EXISTS public.${fn}`)
    expect(rollback).toContain('DROP COLUMN IF EXISTS extras_oneoff_payment_id')
    expect(rollback).toContain('account_billing_extras_purchase_shape')
    // the 113 function is inlined, not referred to
    expect(rollback).toMatch(/CREATE OR REPLACE FUNCTION public.valid_plan_definition/)
    expect(rollback).toContain("value - ARRAY['modules','limits'] <> '{}'") // the strict 113 key check
    expect(rollback).toMatch(/old app parser/)
    expect(rollback).toMatch(/parser stays strict/)
  })
})
