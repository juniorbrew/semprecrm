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

  it('keeps valid_plan_definition identical to 113 for modules (only the two optional price keys are new)', () => {
    expect(modulesIn(sql)).toEqual(modulesIn(v113))
    expect(sql).toContain("'extra_user_price_cents','extra_channel_price_cents'")
    expect(sql).not.toMatch(/\?& ARRAY\['modules','limits','extra/) // the prices stay optional
  })

  it('adds the four columns, capped, with a locked price required for any extra', () => {
    for (const col of ['extra_users', 'extra_channels', 'extra_user_price_cents', 'extra_channel_price_cents']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`)
    }
    expect(sql).toMatch(/extra_users INTEGER NOT NULL DEFAULT 0 CHECK \(extra_users BETWEEN 0 AND 100\)/)
    expect(sql).toMatch(/CHECK \(extra_users = 0 OR extra_user_price_cents IS NOT NULL\)/)
    expect(sql).toMatch(/CHECK \(extra_channels = 0 OR extra_channel_price_cents IS NOT NULL\)/)
  })

  it('gives clients no write path: no policy, no write grant, no new function', () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.account_billing FROM PUBLIC, anon, authenticated/)
    expect(sql).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)/i)
    expect(sql).not.toMatch(/CREATE POLICY/i)
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION (?!public\.valid_plan_definition)/)
  })

  it('has a rollback that drops what was added', () => {
    for (const col of ['extra_users', 'extra_channels', 'extra_user_price_cents', 'extra_channel_price_cents']) {
      expect(rollback).toContain(`DROP COLUMN IF EXISTS ${col}`)
    }
    expect(rollback).toContain('DROP CONSTRAINT IF EXISTS account_billing_extra_users_priced')
  })
})
