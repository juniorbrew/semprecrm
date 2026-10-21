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
  })

  it('opens the dispatcher RPCs to service_role only (076 rule)', () => {
    for (const fn of ['webhook_claim_deliveries(INTEGER, INTEGER, UUID)', 'webhook_purge(INTEGER, INTEGER)']) {
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
    }
  })

  it('emits every event type the app advertises', () => {
    for (const type of WEBHOOK_EVENTS) expect(sql).toContain(`'${type}'`)
  })
})
