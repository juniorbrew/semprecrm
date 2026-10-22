import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { WEBHOOK_EVENTS } from './events'

// The database half cannot run in vitest; pin the properties the app relies on.
const sql = readFileSync(join(process.cwd(), 'supabase/migrations/093_webhooks_api_keys.sql'), 'utf8')

describe('migration 093 contract', () => {
  it('claims deliveries with a lease and SKIP LOCKED (no double delivery across ticks)', () => {
    const claim = sql.slice(sql.indexOf('FUNCTION public.webhook_claim_deliveries'))
    expect(claim).toContain('FOR UPDATE OF d SKIP LOCKED')
    expect(claim).toContain('claimed_until < now()')
    expect(claim).toContain("d.status = 'pending'")
    // fairness: capped per account
    expect(claim).toContain('PARTITION BY s.account_id')
    expect(claim).toContain('c.rn <= GREATEST(p_per_account, 1)')
  })

  it('opens the dispatcher RPCs to service_role only (076 rule)', () => {
    for (const fn of ['webhook_claim_deliveries(INTEGER, INTEGER, UUID, INTEGER)', 'webhook_purge(INTEGER, INTEGER)']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated`)
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role`)
    }
  })

  it('keeps secrets and the key hash out of user-role column grants', () => {
    const grants = sql.match(/GRANT SELECT \([^)]*\)/g) ?? []
    expect(grants).toHaveLength(2)
    for (const g of grants) {
      expect(g).not.toMatch(/secret_enc|previous_secret_enc|key_hash/)
    }
  })

  it('uses SECURITY DEFINER trigger functions that cannot fail the originating write', () => {
    const triggers = sql.match(/CREATE OR REPLACE FUNCTION public\.webhook_trg_\w+\(\)[\s\S]*?\$\$;/g) ?? []
    expect(triggers).toHaveLength(4)
    for (const t of triggers) {
      expect(t).toContain('SECURITY DEFINER')
      expect(t).toContain('EXCEPTION WHEN OTHERS THEN')
      // every lookup and the listener check sit INSIDE the protected block
      const inner = t.indexOf(['BEGIN', '  BEGIN'].join('\n'))
      expect(inner).toBeGreaterThan(-1)
      expect(t.indexOf('webhook_has_listener')).toBeGreaterThan(inner)
    }
  })

  it('stores the contact on each event (LGPD scrub) and keeps idempotency + log tables service-side', () => {
    expect(sql).toContain('contact_id UUID REFERENCES public.contacts(id) ON DELETE CASCADE')
    expect(sql).toContain('PRIMARY KEY (account_id, key)')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.api_purge() FROM PUBLIC, anon, authenticated')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.api_purge() TO service_role')
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.api_idempotency_keys, public\.api_request_log\s+FROM PUBLIC, anon, authenticated/)
  })

  it('emits every event type the app advertises', () => {
    for (const type of WEBHOOK_EVENTS) expect(sql).toContain(`'${type}'`)
  })
})
